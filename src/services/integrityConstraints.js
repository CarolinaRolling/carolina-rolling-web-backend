/**
 * integrityConstraints — database rules the data model relied on but never had (audits M2, M3, M14,
 * M17). Run at boot; every step is idempotent and logged.
 *
 *  M17  Duplicate constraints. Sequelize's sync re-adds a copy of every UNIQUE constraint each time
 *       it runs (clients_name_key, _key1, _key2 …). Every copy is a separate index that each insert
 *       and update has to maintain. Exact duplicates are dropped, always keeping one.
 *  M14  One line number per part on a work order / estimate (deferred, so reordering can swap
 *       numbers inside a transaction). Existing duplicate numbers are repaired first by renumbering
 *       just the affected orders 1..n in their current order.
 *  M3   Uniqueness that was only checked in code (or not at all): one active DR number per work order,
 *       one application of a client payment per invoice, client and vendor names unique ignoring
 *       case. Added only when existing data allows; otherwise the duplicates are logged to fix by hand.
 *  M2   Foreign keys for ~30 id columns that had none. Added NOT VALID: enforced for every new or
 *       changed row, existing rows untouched (orphans are counted and logged, not deleted). Optional
 *       links use ON DELETE SET NULL, which is what the app assumed would happen.
 *
 * dropRestorableConstraints() / ensureIntegrityConstraints() bracket a backup restore, which inserts
 * tables in an order these rules would reject.
 */
const FKS = [
  // [table, column, referenced table, on delete]
  ['client_payments', 'clientId', 'clients', 'SET NULL'],
  ['credit_memos', 'sourceClientPaymentId', 'client_payments', 'SET NULL'],
  ['credit_memo_applications', 'workOrderId', 'work_orders', 'RESTRICT'],
  ['credit_memo_applications', 'clientPaymentId', 'client_payments', 'SET NULL'],
  ['refunds', 'sourceWorkOrderId', 'work_orders', 'SET NULL'],
  ['refunds', 'sourceClientPaymentId', 'client_payments', 'SET NULL'],
  ['inbound_orders', 'estimateId', 'estimates', 'SET NULL'],
  ['work_order_parts', 'inboundOrderId', 'inbound_orders', 'SET NULL'],
  ['work_order_parts', 'awaitingInboundId', 'inbound_orders', 'SET NULL'],
  ['work_order_parts', 'outsideProcessingVendorId', 'vendors', 'SET NULL'],
  ['estimate_parts', 'inboundOrderId', 'inbound_orders', 'SET NULL'],
  ['estimate_parts', 'outsideProcessingVendorId', 'vendors', 'SET NULL'],
  ['estimates', 'scannedEmailId', 'scanned_emails', 'SET NULL'],
  ['estimates', 'rfqVendorId', 'vendors', 'SET NULL'],
  ['scanned_emails', 'estimateId', 'estimates', 'SET NULL'],
  ['pending_orders', 'matchedEstimateId', 'estimates', 'SET NULL'],
  ['pending_orders', 'workOrderId', 'work_orders', 'SET NULL'],
  ['convert_queue_items', 'clientId', 'clients', 'SET NULL'],
  ['convert_queue_items', 'estimateId', 'estimates', 'SET NULL'],
  ['inbound_paperwork', 'clientId', 'clients', 'SET NULL'],
  ['inbound_paperwork', 'matchedWorkOrderId', 'work_orders', 'SET NULL'],
  ['inbound_paperwork', 'matchedEstimateId', 'estimates', 'SET NULL'],
  ['inbound_paperwork', 'matchedInboundOrderId', 'inbound_orders', 'SET NULL'],
  // an inspection job belongs to its part (its units cascade from the job) — deleting the part removes it
  ['inspection_jobs', 'workOrderPartId', 'work_order_parts', 'CASCADE'],
  ['todo_items', 'estimateId', 'estimates', 'SET NULL'],
  ['liabilities', 'vendorId', 'vendors', 'SET NULL'],
  ['liabilities', 'linkedPOId', 'po_numbers', 'SET NULL'],
  ['liabilities', 'scannedEmailId', 'scanned_emails', 'SET NULL'],
  ['device_tokens', 'apiKeyId', 'api_keys', 'SET NULL'],
];
const fkName = (t, c) => `fk_m2_${t}_${c}`.toLowerCase().slice(0, 63);

const PART_NUMBER_RULES = [
  ['work_order_parts', 'workOrderId', 'uq_wop_part_number'],
  ['estimate_parts', 'estimateId', 'uq_ep_part_number'],
];

const UNIQUE_INDEXES = [
  { name: 'uq_dr_numbers_active_work_order', table: 'dr_numbers', expr: `("workOrderId") WHERE "workOrderId" IS NOT NULL AND status = 'active'`,
    dupes: `SELECT "workOrderId" AS key, COUNT(*)::int AS n FROM dr_numbers WHERE "workOrderId" IS NOT NULL AND status = 'active' GROUP BY 1 HAVING COUNT(*) > 1` },
  { name: 'uq_payment_applications_pair', table: 'payment_applications', expr: `("clientPaymentId", "workOrderId")`,
    dupes: `SELECT "clientPaymentId"::text || ' → ' || "workOrderId"::text AS key, COUNT(*)::int AS n FROM payment_applications GROUP BY "clientPaymentId", "workOrderId" HAVING COUNT(*) > 1` },
  { name: 'uq_clients_name_ci', table: 'clients', expr: `(lower(btrim(name)))`,
    dupes: `SELECT lower(btrim(name)) AS key, COUNT(*)::int AS n FROM clients GROUP BY 1 HAVING COUNT(*) > 1` },
  { name: 'uq_vendors_name_ci', table: 'vendors', expr: `(lower(btrim(name)))`,
    dupes: `SELECT lower(btrim(name)) AS key, COUNT(*)::int AS n FROM vendors GROUP BY 1 HAVING COUNT(*) > 1` },
];

/** Run one schema change with a 5s lock wait limit, so an ALTER stuck behind a long transaction gives up
 *  (and is retried next boot) instead of queueing every query on that table behind it. */
async function ddl(sequelize, sql, transaction) {
  const run = async (t) => {
    await sequelize.query(`SET LOCAL lock_timeout = '5s'`, { transaction: t });
    await sequelize.query(sql, { transaction: t });
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

async function columnsOf(sequelize) {
  const [rows] = await sequelize.query(`SELECT table_name, column_name, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema()`);
  const m = new Map(); for (const r of rows) m.set(`${r.table_name}.${r.column_name}`, r.udt_name);
  m.notNull = new Set(rows.filter(r => r.is_nullable === 'NO').map(r => `${r.table_name}.${r.column_name}`));
  return m;
}
async function constraintExists(sequelize, name) {
  const [[r]] = await sequelize.query(`SELECT 1 AS x FROM pg_constraint WHERE conname = :name`, { replacements: { name } });
  return !!r;
}
async function indexExists(sequelize, name) {
  const [[r]] = await sequelize.query(`SELECT 1 AS x FROM pg_indexes WHERE schemaname = current_schema() AND indexname = :name`, { replacements: { name } });
  return !!r;
}

/** M17 — drop exact-duplicate UNIQUE / FOREIGN KEY constraints, keeping one of each. */
async function dropDuplicateConstraints(sequelize) {
  const [rows] = await sequelize.query(`
    SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = current_schema() AND c.contype IN ('u', 'f')`);
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.tbl}|${r.contype}|${r.def}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let dropped = 0; const failed = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // keep the base name (no trailing copy number), else the shortest
    list.sort((a, b) => (/\d+$/.test(a.conname) - /\d+$/.test(b.conname)) || a.conname.length - b.conname.length || a.conname.localeCompare(b.conname));
    for (const extra of list.slice(1)) {
      try {
        await ddl(sequelize, `ALTER TABLE ${extra.tbl} DROP CONSTRAINT "${extra.conname}"`);
        dropped++;
      } catch (e) { failed.push(`${extra.conname}: ${e.message}`); }
    }
  }
  return { dropped, failed };
}

/** M14 — repair duplicate part numbers, then add the deferred unique rule. */
async function ensurePartNumberRules(sequelize, cols, renumbered = []) {
  const out = [];
  for (const [table, fk, name] of PART_NUMBER_RULES) {
    if (!cols.has(`${table}.${fk}`)) continue;
    // Checked IMMEDIATELY (a deferred unique check lets two simultaneous adds of the same number deadlock
    // each other at commit); the reorder / renumber transactions defer it themselves. An older copy
    // created INITIALLY DEFERRED is replaced.
    const [[cur]] = await sequelize.query(`SELECT condeferred FROM pg_constraint WHERE conname = :name`, { replacements: { name } });
    if (cur && !cur.condeferred) continue;
    if (cur) {
      await ddl(sequelize, `ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
      await ddl(sequelize, `ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE ("${fk}", "partNumber") DEFERRABLE INITIALLY IMMEDIATE`);
      out.push(`${name} now checked immediately`);
      continue;
    }
    const [dupParents] = await sequelize.query(`SELECT DISTINCT "${fk}" AS id FROM ${table} WHERE "${fk}" IS NOT NULL GROUP BY "${fk}", "partNumber" HAVING COUNT(*) > 1`);
    await sequelize.transaction(async (t) => {
      for (const { id } of dupParents) {
        // 1..n by current number, then by when each part was added — only the tied parts change order
        await sequelize.query(`UPDATE ${table} p SET "partNumber" = r.rn FROM (
            SELECT id, ROW_NUMBER() OVER (ORDER BY "partNumber" NULLS LAST, "createdAt", id) AS rn FROM ${table} WHERE "${fk}" = :id) r
          WHERE p.id = r.id AND p."partNumber" IS DISTINCT FROM r.rn`, { replacements: { id }, transaction: t });
      }
      await ddl(sequelize, `ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE ("${fk}", "partNumber") DEFERRABLE INITIALLY IMMEDIATE`, t);
    });
    for (const { id } of dupParents) renumbered.push({ table, parentColumn: fk, parentId: id });
    out.push(`${name} added${dupParents.length ? ` (renumbered ${dupParents.length} ${table === 'work_order_parts' ? 'work order(s)' : 'estimate(s)'} that had repeated part numbers: ${dupParents.map(d => d.id).join(', ')})` : ''}`);
  }
  return out;
}

/** M3 — partial / expression unique indexes, only when the data allows. */
async function ensureUniqueIndexes(sequelize, cols) {
  const added = [], blocked = [];
  for (const u of UNIQUE_INDEXES) {
    if (![...cols.keys()].some(k => k.startsWith(`${u.table}.`)) || await indexExists(sequelize, u.name)) continue;
    const [d] = await sequelize.query(u.dupes);
    if (d.length) { blocked.push({ name: u.name, duplicates: d.slice(0, 20) }); continue; }
    await ddl(sequelize, `CREATE UNIQUE INDEX IF NOT EXISTS ${u.name} ON ${u.table} ${u.expr}`);
    added.push(u.name);
  }
  return { added, blocked };
}

/** M2 — foreign keys, NOT VALID (new and changed rows only); orphans counted. */
async function ensureForeignKeys(sequelize, cols) {
  const added = [], skipped = [], orphans = [];
  for (const [table, col, ref, onDelete] of FKS) {
    const name = fkName(table, col);
    const type = cols.get(`${table}.${col}`);
    if (!type || !cols.has(`${ref}.id`)) { skipped.push(`${table}.${col} (missing)`); continue; }
    if (type !== cols.get(`${ref}.id`)) { skipped.push(`${table}.${col} (type ${type} ≠ ${cols.get(`${ref}.id`)})`); continue; }
    if (onDelete === 'SET NULL' && cols.notNull.has(`${table}.${col}`)) { skipped.push(`${table}.${col} (NOT NULL — SET NULL would make deletes fail)`); continue; }
    const want = { 'SET NULL': 'n', CASCADE: 'c', RESTRICT: 'r' }[onDelete];
    const [[have]] = await sequelize.query(`SELECT confdeltype AS d FROM pg_constraint WHERE conname = :name`, { replacements: { name } });
    if (have && have.d === want) continue;
    if (have) await ddl(sequelize, `ALTER TABLE ${table} DROP CONSTRAINT ${name}`);   // delete rule changed
    await ddl(sequelize, `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY ("${col}") REFERENCES ${ref}(id) ON UPDATE CASCADE ON DELETE ${onDelete} NOT VALID`);
    added.push(name);
    const [[{ n }]] = await sequelize.query(`SELECT COUNT(*)::int AS n FROM ${table} c WHERE c."${col}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ref} p WHERE p.id = c."${col}")`);
    if (n) orphans.push(`${table}.${col}: ${n} row(s) point at a ${ref} row that no longer exists`);
  }
  return { added, skipped, orphans };
}

/**
 * Returns a report (round 13, T30 — the restore route shows it to the admin; boot only logs it):
 *   errors, duplicates, partNumbers, unique, foreignKeys — as before
 *   renumbered:    [{ table, parentColumn, parentId }] — orders / estimates whose repeated part numbers
 *                  were renumbered 1..n to make the unique rule fit
 *   guardsMissing: [{ name, kind: 'part-number'|'unique'|'foreign-key', table, reason }] — rules that
 *                  should exist on this database but are not there after this run
 */
async function ensureIntegrityConstraints(sequelize) {
  const report = { errors: [], duplicates: { dropped: 0, failed: [] }, partNumbers: [], unique: { added: [], blocked: [] }, foreignKeys: { added: [], skipped: [], orphans: [] }, renumbered: [], guardsMissing: [] };
  // Each step on its own: one failing (e.g. a duplicate inserted between the check and the ALTER, or a
  // lock wait timing out) must not skip the rest; it is retried next boot.
  const step = async (key, fn) => {
    try { report[key] = await fn(); } catch (e) { report.errors.push(`${key}: ${e.message}`); }
  };
  await step('duplicates', () => dropDuplicateConstraints(sequelize));
  const cols = await columnsOf(sequelize);
  await step('partNumbers', () => ensurePartNumberRules(sequelize, cols, report.renumbered));
  await step('unique', () => ensureUniqueIndexes(sequelize, cols));
  await step('foreignKeys', () => ensureForeignKeys(sequelize, cols));
  try { report.guardsMissing = await missingGuards(sequelize, cols, report); }
  catch (e) { report.errors.push(`guardsMissing: ${e.message}`); }
  return report;
}

/** Which of the rules this module manages should be here (their table / column exists) but aren't. */
async function missingGuards(sequelize, cols, report) {
  const [rows] = await sequelize.query(`
    SELECT conname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema()
    UNION SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`);
  const have = new Set(rows.map(r => r.name));
  const blocked = new Map((report.unique.blocked || []).map(b => [b.name, b]));
  const errorFor = (key) => (report.errors.find(e => e.startsWith(`${key}:`)) || '').slice(key.length + 2) || null;
  const out = [];
  for (const [table, fk, name] of PART_NUMBER_RULES) {
    if (cols.has(`${table}.${fk}`) && !have.has(name)) out.push({ name, kind: 'part-number', table, reason: errorFor('partNumbers') || 'not re-added (see server log)' });
  }
  for (const u of UNIQUE_INDEXES) {
    if (![...cols.keys()].some(k => k.startsWith(`${u.table}.`)) || have.has(u.name)) continue;
    const b = blocked.get(u.name);
    out.push({ name: u.name, kind: 'unique', table: u.table,
      reason: b ? `${b.duplicates.length}${b.duplicates.length >= 20 ? '+' : ''} duplicate value(s) to fix first` : (errorFor('unique') || 'not re-added (see server log)'),
      ...(b ? { duplicates: b.duplicates } : {}) });
  }
  for (const [table, col, ref, onDelete] of FKS) {
    const type = cols.get(`${table}.${col}`);
    // permanently skipped ones (missing column, type mismatch, NOT NULL + SET NULL) are listed in foreignKeys.skipped, not here
    if (!type || type !== cols.get(`${ref}.id`) || (onDelete === 'SET NULL' && cols.notNull.has(`${table}.${col}`))) continue;
    const name = fkName(table, col);
    if (!have.has(name)) out.push({ name, kind: 'foreign-key', table, reason: errorFor('foreignKeys') || 'not re-added (see server log)' });
  }
  return out;
}

/** Human-readable lines for an admin (restore response). */
function reportWarnings(r) {
  const w = [];
  if (!r) return w;
  const byTable = new Map();
  for (const x of r.renumbered || []) { if (!byTable.has(x.table)) byTable.set(x.table, []); byTable.get(x.table).push(x.parentId); }
  for (const [table, ids] of byTable) {
    const what = table === 'work_order_parts' ? 'work order(s)' : table === 'estimate_parts' ? 'estimate(s)' : `${table} parent(s)`;
    w.push(`Part numbers were renumbered 1..n on ${ids.length} ${what} that had repeated part numbers: ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ' …' : ''}.`);
  }
  for (const g of r.guardsMissing || []) w.push(`Database rule ${g.name} (${g.kind} on ${g.table}) is NOT in place: ${g.reason}.`);
  for (const o of r.foreignKeys?.orphans || []) w.push(`${o} (kept; new rows are checked).`);
  for (const e of r.errors || []) w.push(`Integrity step failed (retried at next server start): ${e}`);
  return w;
}

/** Remove the rules a backup restore would trip over; ensureIntegrityConstraints() puts them back. */
// V27: with { transaction } all drops happen in the caller's transaction (all or none, under its lock_timeout)
async function dropRestorableConstraints(sequelize, { transaction } = {}) {
  const o = transaction ? { transaction } : {};
  for (const [table, col] of FKS) await sequelize.query(`ALTER TABLE IF EXISTS ${table} DROP CONSTRAINT IF EXISTS ${fkName(table, col)}`, o);
  for (const [table, , name] of PART_NUMBER_RULES) await sequelize.query(`ALTER TABLE IF EXISTS ${table} DROP CONSTRAINT IF EXISTS ${name}`, o);
  for (const u of UNIQUE_INDEXES) await sequelize.query(`DROP INDEX IF EXISTS ${u.name}`, o);
}

function logReport(r) {
  for (const e of r.errors || []) console.warn(`[integrity] step failed (retried next boot): ${e}`);
  const d = r.duplicates;
  if (d.dropped) console.log(`[integrity] removed ${d.dropped} duplicate constraint(s) left by schema sync`);
  for (const f of d.failed) console.warn(`[integrity] could not remove duplicate ${f}`);
  for (const p of r.partNumbers) console.log(`[integrity] ${p}`);
  if (r.unique.added.length) console.log(`[integrity] added unique rule(s): ${r.unique.added.join(', ')}`);
  for (const b of r.unique.blocked) console.warn(`[integrity] could not add ${b.name}: ${b.duplicates.length} duplicate(s) to fix first:`, JSON.stringify(b.duplicates));
  if (r.foreignKeys.added.length) console.log(`[integrity] added ${r.foreignKeys.added.length} foreign key(s)${r.foreignKeys.added.length <= 5 ? ': ' + r.foreignKeys.added.join(', ') : ''}`);
  for (const o of r.foreignKeys.orphans) console.warn(`[integrity] ${o} (kept; new rows are checked)`);
  for (const s of r.foreignKeys.skipped) console.log(`[integrity] skipped foreign key ${s}`);
  for (const g of r.guardsMissing || []) if (g.kind !== 'unique' || !g.duplicates) console.warn(`[integrity] ${g.name} is not in place: ${g.reason}`);
}

module.exports = { ensureIntegrityConstraints, dropRestorableConstraints, dropDuplicateConstraints, logReport, reportWarnings, FKS, UNIQUE_INDEXES, PART_NUMBER_RULES };

/**
 * Add every ENUM value the models declare that the database type is missing (round 13, T28). The old
 * boot steps used the type name unquoted, so Postgres lower-cased it, the query failed and the error
 * was swallowed — new part types / roll types never reached a production database.
 */
async function ensureEnumValues(sequelize) {
  const added = [];
  for (const model of Object.values(sequelize.models)) {
    const table = model.getTableName();
    for (const [attr, def] of Object.entries(model.rawAttributes)) {
      const values = def.type && def.type.values;
      if (!values || !def.type.key || def.type.key !== 'ENUM') continue;
      const col = def.field || attr;
      const typeName = `enum_${typeof table === 'string' ? table : table.tableName}_${col}`;
      try {
        const [rows] = await sequelize.query(`SELECT e.enumlabel AS v FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = :n`, { replacements: { n: typeName } });
        if (!rows.length) continue;   // the column isn't an enum in this database
        const have = new Set(rows.map(r => r.v));
        for (const v of values) {
          if (have.has(v)) continue;
          await sequelize.query(`ALTER TYPE "${typeName.replace(/"/g, '')}" ADD VALUE IF NOT EXISTS '${String(v).replace(/'/g, "''")}'`);
          added.push(`${typeName}.${v}`);
        }
      } catch (e) { console.warn(`[enums] ${typeName}:`, e.message); }
    }
  }
  if (added.length) console.log(`[enums] added ${added.length} value(s): ${added.join(', ')}`);
  return added;
}
module.exports.ensureEnumValues = ensureEnumValues;
