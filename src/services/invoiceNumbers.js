/**
 * invoiceNumbers — the ONE place invoice numbers are handed out, typed in, or released (audit H4).
 *
 * Before: six routes each did their own "find the highest number, add one" with no lock, and the
 * "does this work order already have a number?" check ran outside the transaction. Two clicks (or
 * two people) at the same moment could give one work order two numbers, leave a ghost "active"
 * number behind, or fail with a duplicate error. Imports and edits could put the same number on
 * two work orders, and just previewing the next number silently dropped a freed number.
 *
 * Now every path:
 *   • takes the same Postgres advisory lock (serializes across requests and dynos),
 *   • re-reads the work order with a row lock inside the transaction,
 *   • is idempotent — asking again for an order that already has a number returns that number.
 * The database also enforces it: one live work order per invoice number, one active invoice
 * number per work order (unique indexes created at boot).
 */
const { Op } = require('sequelize');
const { acquire, LOCK_KEYS } = require('./numberAllocator');

const models = () => require('../models');

class InvoiceNumberConflict extends Error {
  constructor(message) { super(message); this.status = 409; this.code = 'INVOICE_NUMBER_IN_USE'; }
}

const isVoidRow = (r) => !!r && (r.status === 'void' || r.status === 'voided' || !!r.voidedAt);
// Must match the unique index predicate exactly (COALESCE("isVoided", false) = false)
const isVoidWO = (w) => !!w && w.isVoided === true;

/** Run fn inside the caller's transaction, or a new one. Always holds the invoice lock. */
async function locked(transaction, fn) {
  const { sequelize } = models();
  const run = async (t) => { await acquire(sequelize, LOCK_KEYS.invoice, t); return fn(t); };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

async function readFreedPool(t) {
  const { AppSettings } = models();
  const row = await AppSettings.findOne({ where: { key: 'freed_invoice_numbers' }, transaction: t });
  return (row && Array.isArray(row.value)) ? row.value.map(Number).filter(n => n > 0) : [];
}

/** Is `num` free to put on a work order (other than `exceptWoId`)? */
async function isNumberFree(num, t, exceptWoId = null) {
  const { WorkOrder, InvoiceNumber } = models();
  const wo = await WorkOrder.findOne({ where: { invoiceNumber: String(num), ...(exceptWoId ? { id: { [Op.ne]: exceptWoId } } : {}) }, transaction: t });
  if (wo && !isVoidWO(wo)) return false;
  const row = await InvoiceNumber.findOne({ where: { invoiceNumber: num }, transaction: t });
  return !row || isVoidRow(row) || !row.workOrderId || row.workOrderId === exceptWoId;
}

/**
 * Pick the next number. With `consume` (inside the lock) a reused number is removed from the
 * freed pool; without it (preview) nothing is written.
 */
async function pickNextNumber(t, { consume }) {
  const { AppSettings, InvoiceNumber } = models();
  const freed = (await readFreedPool(t)).sort((a, b) => a - b);
  let reuse = null;
  const remaining = [];
  for (const n of freed) {
    if (reuse === null && await isNumberFree(n, t)) reuse = n; else if (n !== reuse) remaining.push(n);
  }
  if (consume && freed.length) {
    // Drop the number we're reusing plus any stale entries that are no longer free
    const stillFree = [];
    for (const n of remaining) if (await isNumberFree(n, t)) stillFree.push(n);
    await AppSettings.upsert({ key: 'freed_invoice_numbers', value: stillFree }, { transaction: t });
  }
  if (reuse !== null) return { number: reuse, isReused: true };
  const highest = (await InvoiceNumber.max('invoiceNumber', { transaction: t })) || 0;
  const setting = await AppSettings.findOne({ where: { key: 'next_invoice_number' }, transaction: t });
  const configured = parseInt(setting?.value, 10) || 0;
  // Same rule as before: highest number ever issued + 1; the configured "next number" only
  // seeds a brand-new system. Numbers already sitting on a work order (typed in by hand) are skipped.
  let next = highest ? highest + 1 : (configured || 1001);
  while (!(await isNumberFree(next, t))) next++;
  return { number: next, isReused: false };
}

async function bumpCounter(num, t) {
  const { AppSettings } = models();
  const setting = await AppSettings.findOne({ where: { key: 'next_invoice_number' }, transaction: t });
  const cur = parseInt(setting?.value, 10) || 0;
  if (num + 1 > cur) await AppSettings.upsert({ key: 'next_invoice_number', value: num + 1 }, { transaction: t });
}

/** Read-only preview of the next number (the old preview consumed a freed number). */
async function previewNextInvoiceNumber() {
  const { sequelize } = models();
  return sequelize.transaction((t) => pickNextNumber(t, { consume: false }));
}

/**
 * Give a work order its invoice number — or return the one it already has.
 * @param {object} opts.setDate  'ifMissing' (default) | 'now' | false — what to do with invoiceDate
 * @returns {{ number: string, isReused: boolean, alreadyAssigned: boolean }}
 */
async function assignNextInvoiceNumber(workOrderId, { transaction, setDate = 'ifMissing' } = {}) {
  return locked(transaction, async (t) => {
    const { WorkOrder, InvoiceNumber } = models();
    const wo = await WorkOrder.findByPk(workOrderId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!wo) { const e = new Error('Work order not found'); e.status = 404; throw e; }
    if (wo.invoiceNumber) return { number: wo.invoiceNumber, isReused: !!wo.reusedInvoiceNumber, alreadyAssigned: true };

    const { number, isReused } = await pickNextNumber(t, { consume: true });
    // A stale active tracking row left on this order (e.g. by an old partial clear) would block the
    // one-active-number-per-order guard — retire it first.
    await InvoiceNumber.update({ status: 'void', voidedAt: new Date(), voidReason: 'Superseded by a new invoice number' },
      { where: { workOrderId: wo.id, status: 'active', invoiceNumber: { [Op.ne]: number } }, transaction: t });
    const row = await InvoiceNumber.findOne({ where: { invoiceNumber: number }, transaction: t });
    if (row) {
      await row.update({ workOrderId: wo.id, clientId: wo.clientId, clientName: wo.clientName, status: 'active', voidedAt: null, voidedBy: null, voidReason: null }, { transaction: t });
    } else {
      await InvoiceNumber.create({ invoiceNumber: number, workOrderId: wo.id, clientId: wo.clientId, clientName: wo.clientName }, { transaction: t });
    }
    const updates = { invoiceNumber: String(number), reusedInvoiceNumber: isReused };
    if (setDate === 'now' || (setDate === 'ifMissing' && !wo.invoiceDate)) updates.invoiceDate = new Date();
    await wo.update(updates, { transaction: t });
    if (!isReused) await bumpCounter(number, t);
    return { number: String(number), isReused, alreadyAssigned: false };
  });
}

/**
 * Put a specific (typed / imported / edited) number on a work order.
 * Throws InvoiceNumberConflict (409) if a live work order already holds it.
 * A voided or unlinked tracking row for that number is reclaimed.
 */
async function claimInvoiceNumber(workOrderId, rawNumber, { transaction, extraUpdates = {}, moveCounter = true } = {}) {
  // Only plain digits are tracked as a sequence number. Anything else ("209500-1", "INV1045") is
  // stored exactly as typed and never moves the counter (stripping the dash would turn 209500-1
  // into 2095001 and push every later number into the millions).
  const typed = String(rawNumber).trim();
  const num = /^\d+$/.test(typed) ? parseInt(typed, 10) : NaN;
  return locked(transaction, async (t) => {
    const { WorkOrder, InvoiceNumber } = models();
    const wo = await WorkOrder.findByPk(workOrderId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!wo) { const e = new Error('Work order not found'); e.status = 404; throw e; }

    if (!num || num < 1) {
      // Non-numeric numbers: store on the work order only (no tracking row), as before
      if (!typed) { const e = new Error('Invoice number is required'); e.status = 400; throw e; }
      const clash = await WorkOrder.findOne({ where: { invoiceNumber: typed, id: { [Op.ne]: wo.id } }, transaction: t });
      if (clash && !isVoidWO(clash)) throw new InvoiceNumberConflict(`Invoice #${typed} is already assigned to ${clash.drNumber ? 'DR-' + clash.drNumber : clash.orderNumber} (${clash.clientName})`);
      await InvoiceNumber.update({ status: 'void', voidedAt: new Date(), voidReason: `Replaced by #${typed}` },
        { where: { workOrderId: wo.id, status: 'active' }, transaction: t });
      await wo.update({ invoiceNumber: typed, ...extraUpdates }, { transaction: t });
      return { number: typed, wo };
    }

    const other = await WorkOrder.findOne({ where: { invoiceNumber: String(num), id: { [Op.ne]: wo.id } }, transaction: t });
    if (other && !isVoidWO(other)) {
      throw new InvoiceNumberConflict(`Invoice #${num} is already assigned to ${other.drNumber ? 'DR-' + other.drNumber : other.orderNumber} (${other.clientName})`);
    }
    const row = await InvoiceNumber.findOne({ where: { invoiceNumber: num }, transaction: t });
    if (row && row.workOrderId && row.workOrderId !== wo.id && !isVoidRow(row)) {
      const holder = await WorkOrder.findByPk(row.workOrderId, { transaction: t });
      if (holder && !isVoidWO(holder) && holder.invoiceNumber === String(num)) {
        throw new InvoiceNumberConflict(`Invoice #${num} is already in use${holder.drNumber ? ' on DR-' + holder.drNumber : ''}`);
      }
    }

    // This order's previous tracking row (if its number is changing) is released, not renumbered
    const previous = await InvoiceNumber.findAll({ where: { workOrderId: wo.id, invoiceNumber: { [Op.ne]: num }, status: 'active' }, transaction: t });
    for (const p of previous) {
      await p.update({ status: 'void', voidedAt: new Date(), voidReason: `Replaced by #${num}` }, { transaction: t });
    }

    if (row) {
      await row.update({ workOrderId: wo.id, clientId: wo.clientId || row.clientId || null, clientName: wo.clientName || row.clientName || null,
        status: 'active', voidedAt: null, voidedBy: null, voidReason: null }, { transaction: t });
    } else {
      await InvoiceNumber.create({ invoiceNumber: num, workOrderId: wo.id, clientId: wo.clientId || null, clientName: wo.clientName || null }, { transaction: t });
    }
    // Typed number leaves the freed pool if it was there
    const freed = await readFreedPool(t);
    const fromPool = freed.includes(num);
    if (fromPool) {
      const { AppSettings } = models();
      await AppSettings.upsert({ key: 'freed_invoice_numbers', value: freed.filter(n => n !== num) }, { transaction: t });
    }
    // A number taken from the freed pool was used before; flag it so it stays out of IIF exports
    await wo.update({ invoiceNumber: String(num), ...(fromPool ? { reusedInvoiceNumber: true } : {}), ...extraUpdates }, { transaction: t });
    if (moveCounter) await bumpCounter(num, t);
    return { number: String(num), wo };
  });
}

/** Take a work order's invoice number off it and put the number in the freed pool for reuse. */
async function releaseInvoiceNumber(workOrderId, { transaction, extraUpdates = {} } = {}) {
  return locked(transaction, async (t) => {
    const { WorkOrder, InvoiceNumber, AppSettings } = models();
    const wo = await WorkOrder.findByPk(workOrderId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!wo) { const e = new Error('Work order not found'); e.status = 404; throw e; }
    const num = wo.invoiceNumber ? parseInt(wo.invoiceNumber, 10) : null;
    if (num && !isNaN(num)) {
      // Only this order's tracking row — never another order that has since taken the number
      await InvoiceNumber.destroy({ where: { invoiceNumber: num, workOrderId: wo.id }, transaction: t });
      const stillHeld = await InvoiceNumber.findOne({ where: { invoiceNumber: num, status: 'active' }, transaction: t });
      if (!stillHeld) {
        const freed = await readFreedPool(t);
        if (!freed.includes(num)) freed.push(num);
        await AppSettings.upsert({ key: 'freed_invoice_numbers', value: freed }, { transaction: t });
      }
    } else {
      await InvoiceNumber.update({ status: 'void', voidedAt: new Date(), voidReason: 'Invoice cleared' },
        { where: { workOrderId: wo.id, status: 'active' }, transaction: t });
    }
    await wo.update({ invoiceNumber: null, invoiceDate: null, invoicedBy: null, reusedInvoiceNumber: false, ...extraUpdates }, { transaction: t });
    return { freed: num && !isNaN(num) ? num : null, wo };
  });
}

/**
 * Boot-time database guards. Each index is only created if existing data allows it; otherwise the
 * duplicates are logged so they can be fixed by hand (nothing is changed automatically).
 */
async function ensureInvoiceConstraints(sequelize) {
  const report = [];
  const tryIndex = async (name, ddl, dupSql) => {
    const [exists] = await sequelize.query(`SELECT 1 FROM pg_indexes WHERE indexname = :name`, { replacements: { name } });
    if (exists.length) return;
    const [dups] = await sequelize.query(dupSql);
    if (dups.length) { report.push({ name, duplicates: dups.slice(0, 20) }); return; }
    await sequelize.query(ddl);
  };
  await tryIndex('uq_work_orders_invoice_number_live',
    `CREATE UNIQUE INDEX uq_work_orders_invoice_number_live ON work_orders ("invoiceNumber")
       WHERE "invoiceNumber" IS NOT NULL AND "invoiceNumber" <> '' AND COALESCE("isVoided", false) = false`,
    `SELECT "invoiceNumber", count(*)::int AS n, string_agg(COALESCE('DR-' || "drNumber", "orderNumber"), ', ') AS orders
       FROM work_orders WHERE "invoiceNumber" IS NOT NULL AND "invoiceNumber" <> '' AND COALESCE("isVoided", false) = false
      GROUP BY "invoiceNumber" HAVING count(*) > 1`);
  await tryIndex('uq_invoice_numbers_active_work_order',
    `CREATE UNIQUE INDEX uq_invoice_numbers_active_work_order ON invoice_numbers ("workOrderId")
       WHERE status = 'active' AND "workOrderId" IS NOT NULL`,
    `SELECT "workOrderId", count(*)::int AS n, string_agg("invoiceNumber"::text, ', ') AS numbers
       FROM invoice_numbers WHERE status = 'active' AND "workOrderId" IS NOT NULL
      GROUP BY "workOrderId" HAVING count(*) > 1`);
  return report;
}

/** Drop the two guards (used around a backup restore, which may contain older duplicates). */
async function dropInvoiceConstraints(sequelize) {
  await sequelize.query('DROP INDEX IF EXISTS uq_work_orders_invoice_number_live');
  await sequelize.query('DROP INDEX IF EXISTS uq_invoice_numbers_active_work_order');
}

module.exports = {
  dropInvoiceConstraints,
  InvoiceNumberConflict,
  previewNextInvoiceNumber,
  assignNextInvoiceNumber,
  claimInvoiceNumber,
  releaseInvoiceNumber,
  ensureInvoiceConstraints,
};
