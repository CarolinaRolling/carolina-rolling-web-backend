/**
 * Fix work orders that have TWO active invoice numbers (the startup log line
 * "[invoices] could not add uq_invoice_numbers_active_work_order: N duplicate(s)").
 *
 * They came from the old invoice-number race (audit H4): a second number was handed out while the
 * first was still active. For each such work order, the number actually ON the work order (what its
 * invoice PDF and QuickBooks show) is kept; the other one is marked void in the invoice-number log
 * ("superseded"). Nothing on the work order itself changes.
 *
 * If the work order's own number matches none of its active numbers, it is only reported — decide
 * which one is real (check QuickBooks) and name it with --keep.
 *
 *   heroku run node scripts/fix-duplicate-invoice-numbers.js                       # report only
 *   heroku run node scripts/fix-duplicate-invoice-numbers.js --apply               # void the extra ones
 *   heroku run node scripts/fix-duplicate-invoice-numbers.js --apply --keep 209202 --keep 209510
 *        (for work orders whose own number matches none: keep these numbers, void the others)
 *
 * After --apply, restart once (heroku ps:restart) and the startup log should no longer show the
 * duplicate line — the database rule "one active invoice number per work order" is then added.
 */
require('dotenv').config();
const path = require('path');
const { sequelize } = require(path.join(__dirname, '../src/models'));

(async () => {
  const apply = process.argv.includes('--apply');
  const keepArgs = process.argv.flatMap((a, i, all) => (a === '--keep' && all[i + 1] ? [String(all[i + 1])] : []));
  const [dupes] = await sequelize.query(`
    SELECT i."workOrderId", w."invoiceNumber" AS wo_number, w."drNumber", w."orderNumber", w."clientName",
           w."iifExportedAt", w."isVoided",
           json_agg(json_build_object('id', i.id, 'number', i."invoiceNumber", 'createdAt', i."createdAt") ORDER BY i."createdAt") AS rows
    FROM invoice_numbers i LEFT JOIN work_orders w ON w.id = i."workOrderId"
    WHERE i.status = 'active' AND i."workOrderId" IS NOT NULL
    GROUP BY i."workOrderId", w.id HAVING COUNT(*) > 1`);
  let fixable = 0, manual = 0, voided = 0;
  for (const d of dupes) {
    const label = d.drNumber ? `DR-${d.drNumber}` : (d.orderNumber || d.workOrderId);
    const keep = d.rows.find(r => String(r.number) === String(d.wo_number || ''))
      || d.rows.find(r => keepArgs.includes(String(r.number)));   // chosen by hand with --keep
    const extra = keep ? d.rows.filter(r => r.id !== keep.id) : [];
    console.log(`${label} — ${d.clientName || '?'}: active numbers ${d.rows.map(r => '#' + r.number).join(', ')}; on the work order: ${d.wo_number ? '#' + d.wo_number : '(none)'}${d.iifExportedAt ? ' [in QuickBooks]' : ''}${d.isVoided ? ' [order voided]' : ''}`);
    if (!keep) { manual++; console.log(`    → none of them matches the work order — check QuickBooks, then re-run with --keep <the real number>`); continue; }
    fixable++;
    console.log(`    → keep #${keep.number}; void ${extra.map(r => '#' + r.number).join(', ')}`);
    if (apply) {
      await sequelize.transaction(async (t) => {
        for (const r of extra) {
          await sequelize.query(`UPDATE invoice_numbers SET status = 'void', "voidedAt" = now(), "voidReason" = :reason WHERE id = :id AND status = 'active'`,
            { replacements: { id: r.id, reason: `Duplicate active number for ${label} — superseded by #${keep.number}` }, transaction: t });
          voided++;
        }
      });
    }
  }
  console.log(`\n${dupes.length} work order(s) with more than one active invoice number: ${fixable} can be fixed automatically, ${manual} need a decision.`);
  console.log(apply ? `Voided ${voided} extra number(s). Restart the app once so the database rule is added.` : 'Report only — run again with --apply to void the extra numbers.');
  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
