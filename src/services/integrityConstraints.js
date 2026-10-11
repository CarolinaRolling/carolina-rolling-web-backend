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
async function ensurePartNumberRules(sequelize, cols) {
  const out = [];
  for (const [table, fk, name] of PART_NUMBER_RULES) {
    if (!cols.has(`${table}.${fk}`) || await constraintExists(sequelize, name)) continue;
    const [dupParents] = await sequelize.query(`SELECT DISTINCT "${fk}" AS id FROM ${table} WHERE "${fk}" IS NOT NULL GROUP BY "${fk}", "partNumber" HAVING COUNT(*) > 1`);
    await sequelize.transaction(async (t) => {
      for (const { id } of dupParents) {
        // 1..n by current number, then by when each part was added — only the tied parts change order
        await sequelize.query(`UPDATE ${table} p SET "partNumber" = r.rn FROM (
            SELECT id, ROW_NUMBER() OVER (ORDER BY "partNumber" NULLS LAST, "createdAt", id) AS rn FROM ${table} WHERE "${fk}" = :id) r
          WHERE p.id = r.id AND p."partNumber" IS DISTINCT FROM r.rn`, { replacements: { id }, transaction: t });
      }
      await ddl(sequelize, `ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE ("${fk}", "partNumber") DEFERRABLE INITIALLY DEFERRED`, t);
    });
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

async function ensureIntegrityConstraints(sequelize) {
  const report = { errors: [], duplicates: { dropped: 0, failed: [] }, partNumbers: [], unique: { added: [], blocked: [] }, foreignKeys: { added: [], skipped: [], orphans: [] } };
  // Each step on its own: one failing (e.g. a duplicate inserted between the check and the ALTER, or a
  // lock wait timing out) must not skip the rest; it is retried next boot.
  const step = async (key, fn) => {
    try { report[key] = await fn(); } catch (e) { report.errors.push(`${key}: ${e.message}`); }
  };
  await step('duplicates', () => dropDuplicateConstraints(sequelize));
  const cols = await columnsOf(sequelize);
  await step('partNumbers', () => ensurePartNumberRules(sequelize, cols));
  await step('unique', () => ensureUniqueIndexes(sequelize, cols));
  await step('foreignKeys', () => ensureForeignKeys(sequelize, cols));
  return report;
}

/** Remove the rules a backup restore would trip over; ensureIntegrityConstraints() puts them back. */
async function dropRestorableConstraints(sequelize) {
  for (const [table, col] of FKS) await sequelize.query(`ALTER TABLE IF EXISTS ${table} DROP CONSTRAINT IF EXISTS ${fkName(table, col)}`);
  for (const [table, , name] of PART_NUMBER_RULES) await sequelize.query(`ALTER TABLE IF EXISTS ${table} DROP CONSTRAINT IF EXISTS ${name}`);
  for (const u of UNIQUE_INDEXES) await sequelize.query(`DROP INDEX IF EXISTS ${u.name}`);
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
}

module.exports = { ensureIntegrityConstraints, dropRestorableConstraints, dropDuplicateConstraints, logReport, FKS, UNIQUE_INDEXES, PART_NUMBER_RULES };
