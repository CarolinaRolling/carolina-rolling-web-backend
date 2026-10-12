/**
 * undo — every delete of a business record is snapshotted first, and can be undone (round 8).
 *
 * Before: 4 of ~120 delete paths saved a copy, the copies had no restore, and anything the database
 * deleted along with a record (its parts, files, messages…) was not saved at all.
 *
 * How it works
 *  - Model hooks (beforeDestroy / beforeBulkDestroy) on the business models below copy the exact
 *    database row — plus every row the database will cascade-delete with it, found from the real
 *    ON DELETE CASCADE foreign keys — into deletion_archive, inside the same transaction as the delete.
 *    One code path, so new delete routes are covered automatically.
 *  - Everything deleted while handling ONE web request shares a groupId (AsyncLocalStorage), and the
 *    request's user is recorded. Undo restores the whole group: deleting a work order and Undo brings
 *    back the order, its parts, files, documents and messages together.
 *  - Undo runs in one transaction: every row comes back, or none do and the reason is given (e.g. the
 *    DR number has been reused, or the work order a part belonged to is itself deleted — undo that
 *    first). Restored line numbers are slotted back into place.
 *  - Stored files a snapshot points at are kept in storage while the snapshot exists (fileRefs counts
 *    them); snapshots expire after ARCHIVE_RETENTION_DAYS (default 90) and their files are then
 *    cleaned up if nothing else uses them.
 */
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const context = new AsyncLocalStorage();
let suspended = 0;

const ARCHIVED_MODELS = [
  'WorkOrder', 'WorkOrderPart', 'WorkOrderPartFile', 'WorkOrderDocument', 'ShipmentCharge', 'VendorIssue',
  'Estimate', 'EstimatePart', 'EstimatePartFile', 'EstimateFile',
  'Client', 'Vendor', 'Shipment', 'ShipmentPhoto', 'ShipmentDocument', 'InboundOrder', 'PONumber', 'DRNumber', 'InvoiceNumber',
  'WorkOrderPayment', 'ClientPayment', 'PaymentApplication', 'CreditMemo', 'CreditMemoApplication', 'Refund',
  'Liability', 'Employee', 'InspectionJob', 'InspectionUnit', 'ShopSupply', 'TodoItem', 'PendingOrder',
  'InboundPaperwork', 'WeldProcedure',
];
const MAX_BULK = 2000;          // a bulk delete larger than this is not snapshotted (logged)
const PER_ROW_LIMIT = 50;       // bulk deletes up to this size get one entry per record; larger ones one combined entry
const MAX_CASCADE_ROWS = 5000;
const MAX_DEPTH = 3;

/** Express middleware: one group per request, remembering who made it */
function requestContext(req, res, next) {
  context.run({ groupId: crypto.randomUUID(), req }, next);
}

/** Run background work (cron jobs, scripts) as one undo group, so its deletes are undone together. */
function withUndoGroup(fn, { by = 'system' } = {}) {
  return context.run({ groupId: crypto.randomUUID(), req: null, by }, fn);
}

/**
 * multer finishes reading an upload from a stream event, which loses the request's async context —
 * deletes in upload routes would then have no user and no group. Re-enter it around multer's next().
 * Must run before the routes create their multer middleware (top of index.js).
 */
function keepContextThroughMulter() {
  try {
    const multer = require('multer');
    const proto = Object.getPrototypeOf(multer());
    if (proto.__undoPatched) return;
    const orig = proto._makeMiddleware;
    proto._makeMiddleware = function (...args) {
      const mw = orig.apply(this, args);
      return (req, res, next) => {
        const store = context.getStore();
        mw(req, res, store ? (...a) => context.run(store, () => next(...a)) : next);
      };
    };
    proto.__undoPatched = true;
  } catch (e) { console.warn('[undo] could not wrap multer:', e.message); }
}

const who = () => {
  const st = context.getStore();
  return st?.req?.user?.username || st?.req?.apiKey?.name || st?.by || null;
};
const isSuspended = () => suspended > 0 || !!context.getStore()?.undoSuspended;

// ── foreign keys (from the database, cached for 10 minutes) ──
let fkCache = null, fkCachedAt = 0;
async function foreignKeys(sequelize) {
  if (fkCache && Date.now() - fkCachedAt < 10 * 60 * 1000) return fkCache;
  const [rows] = await sequelize.query(`
    SELECT c.confrelid::regclass::text AS parent, c.conrelid::regclass::text AS child, a.attname AS col, c.confdeltype AS rule
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n') AND array_length(c.conkey, 1) = 1
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.conrelid AND x.attname = 'id' AND NOT x.attisdropped)`);
  const cascade = {}, setNull = {};
  for (const r of rows) {
    const k = r.parent.replace(/"/g, ''), v = { table: r.child.replace(/"/g, ''), col: r.col };
    ((r.rule === 'c' ? cascade : setNull)[k] ||= []).push(v);
  }
  fkCache = { cascade, setNull }; fkCachedAt = Date.now();
  return fkCache;
}

const q = (s) => `"${s}"`;
// Rows the database will delete along with `ids` (ON DELETE CASCADE), recursively
async function collectCascade(sequelize, table, ids, transaction, out, depth, budget) {
  if (!ids.length) return;
  const { cascade } = await foreignKeys(sequelize);
  const children = cascade[table] || [];
  if (depth >= MAX_DEPTH) {
    // only "truncated" if there really are deeper rows that won't be saved
    for (const { table: child, col } of children) {
      const [[hit]] = await sequelize.query(`SELECT 1 AS x FROM ${q(child)} WHERE ${q(col)} IN (:ids) LIMIT 1`, { replacements: { ids }, transaction });
      if (hit) { budget.truncated = true; break; }
    }
    return;
  }
  for (const { table: child, col } of children) {
    if (budget.n > MAX_CASCADE_ROWS) { budget.truncated = true; return; }
    const [rows] = await sequelize.query(`SELECT * FROM ${q(child)} WHERE ${q(col)} IN (:ids)`, { replacements: { ids }, transaction });
    if (!rows.length) continue;
    budget.n += rows.length;
    (out[child] ||= []).push(...rows.map(r => ({ ...r, __depth: depth + 1 })));
    if (rows[0].id !== undefined) await collectCascade(sequelize, child, rows.map(r => r.id), transaction, out, depth + 1, budget);
  }
}

// Links the database will clear (ON DELETE SET NULL) when these rows go: [{ table, col, value, ids }]
async function collectNulled(sequelize, byTable, transaction) {
  const { setNull } = await foreignKeys(sequelize);
  const out = [];
  for (const [table, ids] of Object.entries(byTable)) {
    if (!ids.length) continue;
    for (const { table: child, col } of setNull[table] || []) {
      const [rows] = await sequelize.query(`SELECT id, ${q(col)} AS v FROM ${q(child)} WHERE ${q(col)} IN (:ids)`, { replacements: { ids }, transaction });
      const byValue = {};
      for (const r of rows) (byValue[r.v] ||= []).push(r.id);
      for (const [value, rids] of Object.entries(byValue)) out.push({ table: child, col, value, ids: rids });
    }
  }
  return out;
}

function storageIdsOf(table, rows) {
  const { REFS } = require('./fileRefs');
  const cols = REFS.filter(([t]) => t === table).map(([, c]) => c);
  return rows.flatMap(r => cols.map(c => r[c]).filter(Boolean));
}

function labelOf(modelName, row) {
  const { labelFor } = require('./deletionArchive');
  const base = labelFor(row);
  if (base) return base;
  if (row.partNumber != null) return `Part ${row.partNumber}`;
  if (row.invoiceNumber) return `Invoice #${row.invoiceNumber}`;
  if (row.amount != null) return `$${parseFloat(row.amount).toFixed(2)}`;
  if (row.originalName || row.filename) return row.originalName || row.filename;
  return null;
}

/**
 * Copy the rows about to be deleted (by `ids`, or a bulk delete's `where`) — with the rows the
 * database cascades and the links it clears — into the archive. Runs entirely inside a savepoint when
 * the delete has a transaction: a failed snapshot is logged and never affects the delete (audit L5).
 */
async function snapshot(model, { ids, where }, options = {}) {
  if (isSuspended()) return;
  const sequelize = model.sequelize;
  const { DeletionArchive } = sequelize.models;
  const table = model.getTableName();
  const transaction = options.transaction;
  const store = context.getStore();
  const groupId = store?.groupId || options.__undoGroup || (options.__undoGroup = crypto.randomUUID());
  const work = async (t) => {
    if (!ids) {
      const found = await model.findAll({ where, attributes: ['id'], transaction: t, limit: MAX_BULK + 1, hooks: false });
      if (found.length > MAX_BULK) { console.warn(`[undo] bulk delete of ${found.length}+ ${model.name} rows not snapshotted`); return; }
      ids = found.map(r => r.id);
    }
    if (!ids.length) return;
    const [rows] = await sequelize.query(`SELECT * FROM ${q(table)} WHERE id IN (:ids)`, { replacements: { ids }, transaction: t });
    if (!rows.length) return;
    const base = { modelName: model.name, tableName: table, groupId, deletedBy: who() || options.archiveBy || null, reason: options.archiveReason || null };
    const build = async (rowsHere) => {
      const cascade = {}, budget = { n: 0, truncated: false };
      await collectCascade(sequelize, table, rowsHere.map(r => r.id), t, cascade, 0, budget);
      const byTable = { [table]: rowsHere.map(r => r.id) };
      for (const [tb, rs] of Object.entries(cascade)) if (rs[0]?.id !== undefined) (byTable[tb] ||= []).push(...rs.map(r => r.id));
      const nulled = await collectNulled(sequelize, byTable, t);
      const storageIds = [...new Set([...storageIdsOf(table, rowsHere), ...Object.entries(cascade).flatMap(([tb, rs]) => storageIdsOf(tb, rs))])];
      return { cascade, nulled, truncated: budget.truncated || undefined, storageIds: storageIds.length ? storageIds : null };
    };
    if (rows.length <= PER_ROW_LIMIT) {
      for (const row of rows) {
        const { storageIds, ...rest } = await build([row]);
        await DeletionArchive.create({ ...base, recordId: String(row.id), label: labelOf(model.name, row), snapshot: { row, ...rest }, storageIds },
          { transaction: t, hooks: false });
      }
    } else {
      // A large bulk delete: one entry holding all the rows
      const { storageIds, ...rest } = await build(rows);
      await DeletionArchive.create({ ...base, recordId: null, label: `${rows.length} records`, snapshot: { rows, ...rest }, storageIds },
        { transaction: t, hooks: false });
    }
  };
  try {
    if (transaction) await sequelize.transaction({ transaction }, work);
    else await work(undefined);
  } catch (e) {
    console.error(`[undo] could not snapshot ${model.name} before delete:`, e.message);
  }
}

function registerUndoHooks(models) {
  if (registerUndoHooks.done) return;
  registerUndoHooks.done = true;
  for (const name of ARCHIVED_MODELS) {
    const model = models[name];
    if (!model) continue;
    // undoSkip: an internal replace (a regenerated PDF) — not something anyone would want back
    model.addHook('beforeDestroy', 'undoSnapshot', (inst, options) => options.undoSkip ? undefined : snapshot(model, { ids: [inst.id] }, options));
    model.addHook('beforeBulkDestroy', 'undoSnapshot', (options) => {
      // individualHooks: Sequelize also runs beforeDestroy per row (same options) — snapshot there instead
      if (isSuspended() || !options.where || options.individualHooks || options.undoSkip) return;
      return snapshot(model, { where: options.where }, options);
    });
  }
}

// ── Undo ──
class UndoError extends Error { constructor(msg, status = 409) { super(msg); this.status = status; } }

function explain(e, entry) {
  const code = e.parent?.code || e.original?.code;
  const detail = e.parent?.detail || e.original?.detail || '';
  const what = entry.label || entry.modelName;
  if (code === '23505') return `${what} can't come back: something now uses the same value (${detail.replace(/^Key /, '')}).`;
  if (code === '23503') return `${what} can't come back on its own: the record it belonged to is deleted too. Undo that deletion first.`;
  return `${what} can't come back: ${e.message}`;
}

const PART_TABLES = { work_order_parts: 'workOrderId', estimate_parts: 'estimateId' };

async function tableColumns(sequelize, table, transaction, cache) {
  if (!cache[table]) {
    const [cols] = await sequelize.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = :t`,
      { replacements: { t: table }, transaction });
    cache[table] = new Set(cols.map(c => c.column_name));
  }
  return cache[table];
}

async function insertRow(sequelize, table, row, transaction, colCache) {
  const clean = { ...row }; delete clean.__depth;
  // A line number that has been taken since (the list was renumbered after the delete): make room.
  // Only when the number is actually taken, so restoring a whole list in any order shifts nothing.
  if (PART_TABLES[table] && clean.partNumber != null) {
    const fk = PART_TABLES[table];
    const [[taken]] = await sequelize.query(`SELECT 1 AS x FROM ${q(table)} WHERE ${q(fk)} = :p AND "partNumber" = :n`,
      { replacements: { p: clean[fk], n: clean.partNumber }, transaction });
    if (taken) {
      await sequelize.query('SET CONSTRAINTS ALL DEFERRED', { transaction });
      await sequelize.query(`UPDATE ${q(table)} SET "partNumber" = "partNumber" + 1 WHERE ${q(fk)} = :p AND "partNumber" >= :n`,
        { replacements: { p: clean[fk], n: clean.partNumber }, transaction });
    }
  }
  // Only the columns the snapshot has and the table still has — a column added since gets its default
  const have = await tableColumns(sequelize, table, transaction, colCache);
  const cols = Object.keys(clean).filter(c => have.has(c)).map(q).join(', ');
  await sequelize.query(`INSERT INTO ${q(table)} (${cols}) SELECT ${cols} FROM jsonb_populate_record(NULL::${q(table)}, :row::jsonb)`,
    { replacements: { row: JSON.stringify(clean) }, transaction });
}

/** Undo the deletion that `entryId` belongs to (its whole group). */
async function undoDeletion(entryId, { by } = {}) {
  const { sequelize } = require('../models');
  const { DeletionArchive } = sequelize.models;
  const first = await DeletionArchive.findByPk(entryId);
  if (!first) throw new UndoError('That deleted item was not found.', 404);
  if (!first.tableName) throw new UndoError('This is an older snapshot (from before Undo existed). It can be viewed, but not restored automatically.', 400);
  const entries = first.groupId
    ? await DeletionArchive.findAll({ where: { groupId: first.groupId }, order: [['createdAt', 'DESC'], ['id', 'ASC']] })
    : [first];
  const todo = entries.filter(e => !e.restoredAt && e.tableName);
  if (!todo.length) throw new UndoError('This deletion has already been undone.', 409);

  const restoredWorkOrders = new Set();
  let inserted = 0;
  const colCache = {};
  await sequelize.transaction(async (t) => {
    await sequelize.query('SET CONSTRAINTS ALL DEFERRED', { transaction: t });
    // Every row to put back: each snapshot's own row, then its cascade children (shallow → deep).
    const items = [];
    const seen = new Set();
    for (const e of todo) {
      const { row, rows, cascade = {} } = e.snapshot || {};
      const own = rows || (row ? [row] : []);
      const add = (table, r, depth) => { const k = `${table}:${r.id}`; if (!seen.has(k)) { seen.add(k); items.push({ table, row: r, depth, entry: e }); } };
      for (const r of own) add(e.tableName, r, 0);
      for (const [table, rows] of Object.entries(cascade)) for (const r of rows) add(table, r, r.__depth || 1);
    }
    items.sort((a, b) => a.depth - b.depth || ((a.row.partNumber ?? 0) - (b.row.partNumber ?? 0)));
    // Put rows back; a row whose parent isn't back yet (foreign key) waits for the next pass. Stops
    // when everything is in, or a pass makes no progress (then nothing at all is restored).
    let pending = items, lastFk = null;
    while (pending.length) {
      const next = [];
      for (const it of pending) {
        const [[exists]] = await sequelize.query(`SELECT 1 AS x FROM ${q(it.table)} WHERE id = :id`, { replacements: { id: it.row.id }, transaction: t });
        if (exists) continue;   // already back (or never actually gone)
        try {
          await sequelize.transaction({ transaction: t }, (sp) => insertRow(sequelize, it.table, it.row, sp, colCache));
          inserted++;
          if (it.table === 'work_orders') restoredWorkOrders.add(it.row.id);
          if (it.table === 'work_order_parts') restoredWorkOrders.add(it.row.workOrderId);
        } catch (err) {
          if ((err.parent?.code || err.original?.code) === '23503') { next.push(it); lastFk = { err, it }; continue; }
          throw new UndoError(explain(err, it.entry));
        }
      }
      if (next.length === pending.length) throw new UndoError(explain(lastFk.err, lastFk.it.entry));
      pending = next;
    }
    // Put back the links the database cleared when these were deleted (ON DELETE SET NULL) — only
    // where nothing has been linked there since
    for (const e of todo) {
      for (const n of e.snapshot?.nulled || []) {
        await sequelize.transaction({ transaction: t }, (sp) => sequelize.query(
          `UPDATE ${q(n.table)} SET ${q(n.col)} = :v WHERE id IN (:ids) AND ${q(n.col)} IS NULL`,
          { replacements: { v: n.value, ids: n.ids }, transaction: sp })).catch((err) => console.warn(`[undo] could not re-link ${n.table}.${n.col}:`, err.message));
      }
    }
    await sequelize.query('SET CONSTRAINTS ALL IMMEDIATE', { transaction: t });   // check the line-number rule now, inside the undo
    await DeletionArchive.update({ restoredAt: new Date(), restoredBy: by || null }, { where: { id: todo.map(e => e.id) }, transaction: t });
  }).catch((err) => {
    if (err instanceof UndoError) throw err;
    throw new UndoError(explain(err, first));
  });

  // A work order that came back: re-link the records its delete un-linked (DR number log, the
  // estimate it came from, PO tracker rows for its parts' POs and their deliveries).
  for (const id of restoredWorkOrders) {
    try {
      await sequelize.transaction(async (t) => {
        const [[wo]] = await sequelize.query(`SELECT id, "drNumber", "estimateId" FROM work_orders WHERE id = :id`, { replacements: { id }, transaction: t });
        if (!wo) return;
        if (wo.drNumber) await sequelize.query(`UPDATE dr_numbers SET "workOrderId" = :id WHERE "drNumber" = :dr AND "workOrderId" IS NULL AND status = 'active'`, { replacements: { id, dr: wo.drNumber }, transaction: t });
        if (wo.estimateId) await sequelize.query(`UPDATE estimates SET "workOrderId" = :id, status = 'converted' WHERE id = :e AND "workOrderId" IS NULL`, { replacements: { id, e: wo.estimateId }, transaction: t });
        await sequelize.query(`UPDATE po_numbers p SET "workOrderId" = :id FROM work_order_parts wp
          WHERE wp."workOrderId" = :id AND wp."materialPurchaseOrderNumber" = 'PO' || p."poNumber" AND p."workOrderId" IS NULL`, { replacements: { id }, transaction: t });
        await sequelize.query(`UPDATE po_numbers p SET "inboundOrderId" = i.id FROM inbound_orders i
          WHERE i."workOrderId" = :id AND i."purchaseOrderNumber" IN ('PO' || p."poNumber", 'OP' || p."poNumber", 'TR' || p."poNumber") AND p."inboundOrderId" IS NULL`, { replacements: { id }, transaction: t });
      });
    } catch (e) { console.warn('[undo] re-link after restoring a work order failed:', e.message); }
  }

  // Stored totals for orders whose parts came back (not for orders in QuickBooks — frozen)
  const { refreshStoredTotals } = require('./invoiceTotals');
  for (const id of restoredWorkOrders) { try { await refreshStoredTotals(id); } catch (_) { /* best effort */ } }
  return { restored: todo.length, rows: inserted, alreadyThere: inserted === 0,
    truncated: todo.some(e => e.snapshot?.truncated), labels: todo.map(e => e.label || e.modelName) };
}

/** Delete snapshots older than the retention period, then their stored files if nothing uses them. */
async function purgeExpired({ days = parseInt(process.env.ARCHIVE_RETENTION_DAYS) || 90 } = {}) {
  const { sequelize } = require('../models');
  const [rows] = await sequelize.query(
    `DELETE FROM deletion_archive WHERE "createdAt" < now() - (:days || ' days')::interval RETURNING "storageIds"`, { replacements: { days: String(days) } });
  const ids = [...new Set(rows.flatMap(r => r.storageIds || []))];
  const { deleteStoredFilesIfUnused } = require('./fileRefs');
  await deleteStoredFilesIfUnused(ids, { resourceType: 'any' });   // photos are stored as images on Cloudinary
  return { purged: rows.length, files: ids.length };
}

/**
 * Stop snapshotting for the current request only (a backup restore) — other users' deletes during it
 * are still snapshotted. Outside a request it pauses globally. Returns the function that resumes.
 */
function suspendUndo() {
  const st = context.getStore();
  if (st) { st.undoSuspended = true; return () => { st.undoSuspended = false; }; }
  suspended++;
  return () => { suspended = Math.max(0, suspended - 1); };
}

module.exports = {
  requestContext, withUndoGroup, keepContextThroughMulter, registerUndoHooks, undoDeletion, purgeExpired, UndoError,
  ARCHIVED_MODELS, suspendUndo, isSuspended,
  currentGroup: () => context.getStore()?.groupId || null,
};
