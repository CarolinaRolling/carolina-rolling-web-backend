/**
 * Find (and optionally fix) every work order whose part pricing went missing because of the old
 * tablet bug — the same check and fix as the "Fix Pricing" button, run across all orders at once.
 *
 *   heroku run node scripts/find-missing-pricing.js            # report only
 *   heroku run node scripts/find-missing-pricing.js --apply    # restore from the estimates
 *
 * Two kinds of damage are found (see services/pricingRecovery.js):
 *   - prices all blank on a part
 *   - material blank with a labor-only total (the part was re-saved after being blanked) — these
 *     orders are UNDERCHARGING the material and don't show a warning anywhere else
 *
 * Orders already entered in QuickBooks are listed but never changed: their invoice is frozen. Un-mark
 * one in the Invoice Center if it should be corrected and re-entered.
 */
require('dotenv').config();
const path = require('path');
const models = require(path.join(__dirname, '../src/models'));
const { recoverWorkOrderPricing, describe } = require(path.join(__dirname, '../src/services/pricingRecovery'));
const { Op } = require('sequelize');

(async () => {
  const apply = process.argv.includes('--apply');
  const { WorkOrder, sequelize } = models;
  const wos = await WorkOrder.findAll({ where: { estimateId: { [Op.ne]: null } }, attributes: ['id'], order: [['createdAt', 'ASC']] });
  let orders = 0, partsFound = 0, fixed = 0, frozen = 0, undercharged = 0;
  for (const { id } of wos) {
    const { wo, items } = await recoverWorkOrderPricing(id, { apply: false });
    if (!items.length) continue;
    orders++; partsFound += items.length;
    const label = wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber;
    const inQB = !!wo.iifExportedAt;
    if (inQB) frozen++;
    const short = items.filter(i => i.kind === 'material').reduce((s, i) => s + (i.after - i.before), 0);
    undercharged += short;
    console.log(`${label} — ${wo.clientName}${wo.invoiceNumber ? ` (invoice #${wo.invoiceNumber})` : ''}${inQB ? ' [in QuickBooks — not changed]' : ''}${short ? `  undercharged by $${short.toFixed(2)}` : ''}`);
    for (const it of items) console.log('    ' + describe(it));
    if (apply && !inQB) {
      const r = await recoverWorkOrderPricing(id, { apply: true });
      fixed += r.items.filter(i => i.applied).length;
      for (const it of r.items.filter(i => i.error)) console.log(`    ! part ${it.part.partNumber} not changed: ${it.error}`);
    }
  }
  console.log(`\n${orders} order(s), ${partsFound} part(s) with missing pricing; material missing on parts worth $${undercharged.toFixed(2)} in total.`);
  if (frozen) console.log(`${frozen} of those orders are already in QuickBooks and were left as they are.`);
  console.log(apply ? `Restored ${fixed} part(s).` : 'Report only — run again with --apply to restore (orders in QuickBooks are never changed).');
  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
