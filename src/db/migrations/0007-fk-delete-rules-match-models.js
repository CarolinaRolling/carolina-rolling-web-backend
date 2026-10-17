/**
 * 0007 — foreign-key delete rules match the models (round 14, R24).
 *
 * Tables first created by the boot SQL in src/index.js got the delete rules written there; databases
 * built from the models (test databases, a fresh install via 0001) got the models' rules. They differ:
 *
 *   payment_applications.workOrderId → work_orders   boot: CASCADE   model: NO ACTION
 *   shipment_charges.workOrderId     → work_orders   boot: CASCADE   model: SET NULL
 *   shipment_charges.estimateId      → estimates     boot: CASCADE   model: SET NULL
 *
 * so deleting a work order on production silently erased its client-payment applications and its
 * shipping charges, where every test database refused (applications) or kept the rows (charges).
 * The other FKs the boot SQL declares are listed too: they already agree, so they are only checked
 * (work_order_payments.workOrderId was already moved to RESTRICT at boot, audit H8).
 *
 * The rule each model actually produces (Model.rawAttributes[col].onDelete, i.e. what
 * createMissingTables / Model.sync write) was read from src/models when this was written.
 *
 * For each listed column: every FK on it pointing at the listed table whose delete rule differs is
 * dropped and re-added under the same name with the model's rule (ON UPDATE CASCADE, as the models
 * say), NOT VALID inside a short transaction with a 5 s lock wait, then VALIDATEd separately (that
 * step doesn't block writes). A constraint that was NOT VALID before stays NOT VALID; one whose
 * existing rows no longer validate is left NOT VALID and reported. Already-correct FKs, missing
 * tables/columns and missing FKs are left alone (no-op), so this is safe to re-run. A lock timeout
 * fails the migration, so it is retried at the next start.
 */
const RULES = [
  // [table, column, referenced table, model's ON DELETE]
  ['payment_applications', 'workOrderId', 'work_orders', 'NO ACTION'],
  ['shipment_charges', 'workOrderId', 'work_orders', 'SET NULL'],
  ['shipment_charges', 'estimateId', 'estimates', 'SET NULL'],
  // already agree with the boot SQL — checked only
  ['work_order_payments', 'workOrderId', 'work_orders', 'RESTRICT'],
  ['payment_applications', 'clientPaymentId', 'client_payments', 'CASCADE'],
  ['credit_memo_applications', 'creditMemoId', 'credit_memos', 'CASCADE'],
  ['inspection_jobs', 'workOrderId', 'work_orders', 'CASCADE'],
  ['inspection_units', 'inspectionJobId', 'inspection_jobs', 'CASCADE'],
  ['work_order_invoice_sends', 'workOrderId', 'work_orders', 'CASCADE'],
  ['vendor_issues', 'workOrderId', 'work_orders', 'CASCADE'],
  ['vendor_issues', 'workOrderPartId', 'work_order_parts', 'SET NULL'],
  ['vendor_issues', 'vendorId', 'vendors', 'SET NULL'],
];
const CODE = { 'NO ACTION': 'a', RESTRICT: 'r', CASCADE: 'c', 'SET NULL': 'n', 'SET DEFAULT': 'd' };
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

module.exports = {
  RULES,
  async up({ sequelize }) {
    const changed = [], notValid = [], errors = [];
    for (const [table, col, ref, onDelete] of RULES) {
      const [cons] = await sequelize.query(`
        SELECT c.conname, c.confdeltype AS del, c.convalidated AS valid, a.attnotnull AS notnull
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_class r ON r.oid = c.confrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND n.nspname = current_schema() AND t.relname = :table AND r.relname = :ref
          AND array_length(c.conkey, 1) = 1 AND a.attname = :col`,
        { replacements: { table, ref, col } });
      for (const c of cons) {
        if (c.del === CODE[onDelete]) continue;   // already right
        if (onDelete === 'SET NULL' && c.notnull) { errors.push(`${table}.${col}: column is NOT NULL, SET NULL not applied`); continue; }
        // A busy moment (a long read holding the table) times the lock out: try a few times before
        // giving up for this start (review of round 14)
        let lastErr = null;
        // (4 tries with a growing pause, like the other migrations' DDL — U26)
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await sequelize.transaction(async (t) => {
              await sequelize.query(`SET LOCAL lock_timeout = '5s'`, { transaction: t });
              await sequelize.query(`ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(c.conname)}`, { transaction: t });
              await sequelize.query(`ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(c.conname)} FOREIGN KEY (${q(col)}) REFERENCES ${q(ref)} (id)` +
                ` ON UPDATE CASCADE ON DELETE ${onDelete} NOT VALID`, { transaction: t });
            });
            lastErr = null; break;
          } catch (e) {
            lastErr = e;
            if (!/lock timeout|canceling statement due to lock/i.test(e.message)) break;
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
          }
        }
        if (lastErr) { errors.push(`${table}.${col} (${c.conname}): ${lastErr.message}`); continue; }
        changed.push(`${table}.${col} ${({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' })[c.del] || c.del} → ${onDelete}`);
        if (!c.valid) { notValid.push(`${c.conname} (was NOT VALID before)`); continue; }
        try { await sequelize.query(`ALTER TABLE ${q(table)} VALIDATE CONSTRAINT ${q(c.conname)}`); }
        catch (e) { notValid.push(`${c.conname}: ${e.message}`); }
      }
    }
    const summary = [
      changed.length ? `changed ${changed.length}: ${changed.join('; ')}` : 'all listed delete rules already match the models',
      notValid.length ? `left NOT VALID: ${notValid.join('; ')}` : '',
    ].filter(Boolean).join(' | ');
    // Lock timeouts and other failures: fail so the migration is retried at the next start
    // (everything already changed is skipped then, as it now matches).
    if (errors.some(e => !/NOT NULL, SET NULL not applied/.test(e))) throw new Error(`${errors.join('; ')}${changed.length ? ` (done so far: ${summary})` : ''}`);
    return [summary, ...errors].join(' | ');
  },
};
