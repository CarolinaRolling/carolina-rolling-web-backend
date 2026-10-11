/**
 * Recover work-order part prices blanked by the old part-update bug.
 *
 * Until the fix on 11 Oct 2026, PUT /api/workorders/:id/parts/:partId set every price column the
 * request didn't include to NULL. The shop tablets send partial updates (a status tap, a progress
 * count, an operator note), so every part a tablet touched lost partTotal, laborTotal,
 * materialTotal, setupCharge, otherCharges, laborRate, laborHours, materialUnitCost and
 * materialMarkupPercent. (Invoices mostly still priced correctly because copies of some values live
 * in the part's formData — but not always, and anything reading the columns saw blanks.)
 *
 * This script refills those columns from the estimate the work order was converted from, matching
 * each part by part number + part type + quantity. It ONLY fills columns that are currently NULL on
 * parts that show the wipe pattern (partTotal, laborTotal and materialTotal all NULL), never
 * overwrites a value, and skips parts it can't match unambiguously.
 *
 *   heroku run node scripts/recover-wiped-part-pricing.js            # dry run: report only
 *   heroku run node scripts/recover-wiped-part-pricing.js --apply    # write the recovered values
 *
 * The report shows each work order's invoice total before/after so you can review it first.
 * Orders already exported to QuickBooks keep their frozen total; the recovered columns only make the
 * part lines whole again.
 */
require('dotenv').config();
const path = require('path');
const models = require(path.join(__dirname, '../src/models'));
const { computeInvoiceTotals } = require(path.join(__dirname, '../src/services/invoiceTotals'));
const { loadLaborMinimums } = require(path.join(__dirname, '../src/services/pricing'));
const { WorkOrder, WorkOrderPart, EstimatePart, ShipmentCharge, Client, sequelize } = models;
const { Op } = require('sequelize');

const PRICE_COLS = ['partTotal', 'laborTotal', 'materialTotal', 'materialMarkupPercent', 'setupCharge', 'otherCharges', 'laborRate', 'laborHours', 'materialUnitCost'];

(async () => {
  const apply = process.argv.includes('--apply');
  const wiped = await WorkOrderPart.findAll({
    where: { partTotal: null, laborTotal: null, materialTotal: null },
    attributes: ['id', 'workOrderId', 'partNumber', 'partType', 'quantity', ...PRICE_COLS],
  });
  const woIds = [...new Set(wiped.map(p => p.workOrderId))];
  const wos = woIds.length ? await WorkOrder.findAll({ where: { id: woIds } }) : [];
  const mins = await loadLaborMinimums();
  let fixable = 0, unmatched = 0, noEstimate = 0, nothingToCopy = 0;
  const plan = [];

  for (const wo of wos) {
    const parts = wiped.filter(p => p.workOrderId === wo.id);
    if (!wo.estimateId) { noEstimate += parts.length; continue; }
    const estParts = await EstimatePart.findAll({ where: { estimateId: wo.estimateId } });
    const fixes = [];
    for (const p of parts) {
      const cands = estParts.filter(e => e.partNumber === p.partNumber && e.partType === p.partType && (parseInt(e.quantity) || 1) === (parseInt(p.quantity) || 1));
      if (cands.length !== 1) { unmatched++; continue; }
      const src = cands[0];
      const values = {};
      for (const c of PRICE_COLS) if (p[c] === null && src[c] !== null && src[c] !== undefined) values[c] = src[c];
      if (!Object.keys(values).length) { nothingToCopy++; continue; }
      fixes.push({ part: p, values });
      fixable++;
    }
    if (!fixes.length) continue;
    const allParts = await WorkOrderPart.findAll({ where: { workOrderId: wo.id } });
    const charges = await ShipmentCharge.findAll({ where: { workOrderId: wo.id } });
    const client = wo.clientId ? await Client.findByPk(wo.clientId, { attributes: ['taxStatus'] }) : null;
    const before = computeInvoiceTotals({ wo, parts: allParts, client, shipmentCharges: charges, laborMinimums: mins }).grandTotal;
    const patched = allParts.map(p => { const f = fixes.find(x => x.part.id === p.id); return f ? { ...p.toJSON(), ...f.values } : p; });
    const after = computeInvoiceTotals({ wo, parts: patched, client, shipmentCharges: charges, laborMinimums: mins }).grandTotal;
    plan.push({ wo, fixes, before, after });
  }

  console.log(`Parts with all price columns blank: ${wiped.length}`);
  console.log(`  recoverable from the estimate: ${fixable}`);
  console.log(`  no estimate to recover from:   ${noEstimate}`);
  console.log(`  no unambiguous estimate match:  ${unmatched}`);
  console.log(`  estimate had no prices either:  ${nothingToCopy}\n`);
  for (const { wo, fixes, before, after } of plan) {
    const label = wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber;
    const flag = Math.abs(before - after) > 0.005 ? '  <-- invoice total changes' : '';
    console.log(`${label}${wo.invoiceNumber ? ' (inv #' + wo.invoiceNumber + ')' : ''}${wo.iifExportedAt ? ' [in QuickBooks]' : ''}: ${fixes.length} part(s); invoice total $${before.toFixed(2)} → $${after.toFixed(2)}${flag}`);
    for (const f of fixes) console.log(`    part #${f.part.partNumber} ${f.part.partType}: ${Object.entries(f.values).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  if (!apply) { console.log('\nDry run — nothing written. Re-run with --apply to restore these values.'); await sequelize.close(); return; }
  let written = 0;
  await sequelize.transaction(async (t) => {
    for (const { fixes } of plan) {
      for (const f of fixes) {
        // Raw update: restoring data, not a pricing change, so it bypasses the QuickBooks lock hooks.
        // Only fills columns that are still NULL at the moment of writing.
        const sets = Object.keys(f.values).map((c, i) => `"${c}" = COALESCE("${c}", $${i + 2})`).join(', ');
        await sequelize.query(`UPDATE work_order_parts SET ${sets} WHERE id = $1`, { bind: [f.part.id, ...Object.values(f.values)], transaction: t });
        written++;
      }
    }
  });
  // Refresh stored totals on orders not yet in QuickBooks
  const { refreshStoredTotals } = require(path.join(__dirname, '../src/services/invoiceTotals'));
  for (const { wo } of plan) if (!wo.iifExportedAt) await refreshStoredTotals(wo.id).catch(() => {});
  console.log(`\nRestored prices on ${written} part(s).`);
  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
