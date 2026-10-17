/**
 * Round 13 — which open invoices change total on deploy (run BEFORE and/or right after deploying):
 *
 *   heroku run node scripts/round13-total-changes.js            (or locally with DATABASE_URL set)
 *
 * Round 13 makes the invoice use the estimate's labor-minimum and expedite rules (the invoice used to
 * apply no minimum when the Admin-screen rules were saved, or none at all with no rules saved), and
 * caps discounts. Orders already in QuickBooks are frozen and never change. This lists every other
 * order whose stored total (worked out by the old rules) differs from the new calculation, with the
 * ones that already have an invoice number or payments first — those may need a corrected invoice
 * sent, or a minimum override if the old amount should stand.
 */
const { sequelize, WorkOrder } = require('../src/models');
const { Op } = require('sequelize');
const { loadInvoiceTotals } = require('../src/services/invoiceTotals');

(async () => {
  const wos = await WorkOrder.findAll({
    where: { iifExportedAt: null, totalsComputedAt: { [Op.ne]: null }, [Op.or]: [{ isVoided: null }, { isVoided: false }] },
    attributes: ['id', 'drNumber', 'orderNumber', 'clientName', 'invoiceNumber', 'grandTotal'],
  });
  const totals = await loadInvoiceTotals(wos.map(w => w.id));
  const rows = [];
  for (const w of wos) {
    const t = totals.get(w.id);
    if (!t) continue;
    const before = Math.round((parseFloat(w.grandTotal) || 0) * 100) / 100;
    const after = t.amount;
    if (Math.abs(after - before) < 0.01) continue;
    const [[p]] = await sequelize.query(`SELECT COUNT(*)::int n FROM work_order_payments WHERE "workOrderId" = :id AND "voidedAt" IS NULL`, { replacements: { id: w.id } });
    rows.push({ order: w.drNumber ? `DR-${w.drNumber}` : w.orderNumber, client: w.clientName, invoice: w.invoiceNumber || '', payments: p.n,
      before, after, change: Math.round((after - before) * 100) / 100, minimum: t.totals.minimumAdjustment, rush: t.totals.rushAmount });
  }
  rows.sort((a, b) => (Number(!!(b.invoice || b.payments)) - Number(!!(a.invoice || a.payments))) || Math.abs(b.change) - Math.abs(a.change));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(`${rows.length} open order(s) change total under the round-13 rules (orders in QuickBooks never change):\n`);
    for (const r of rows) console.log(`${(r.invoice || r.payments) ? '!' : ' '} ${r.order.padEnd(12)} ${String(r.client || '').slice(0, 28).padEnd(28)} inv ${String(r.invoice).padEnd(8)} pay ${r.payments}  $${r.before.toFixed(2)} → $${r.after.toFixed(2)} (${r.change >= 0 ? '+' : ''}${r.change.toFixed(2)})  min $${r.minimum} rush $${r.rush}`);
    console.log('\n! = already has an invoice number or payments — check before re-sending the invoice.');
  }
  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
