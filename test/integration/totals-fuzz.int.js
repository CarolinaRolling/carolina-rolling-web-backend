/**
 * Fuzz test: for many random work orders, the QuickBooks IIF export, the shared invoiceTotals
 * calculation and the rendered invoice PDF must all agree on the total (audit C4).
 *
 *   DATABASE_URL=<LOCAL test db> node test/integration/totals-fuzz.int.js [count]
 *
 * Writes test rows, so it refuses to run unless DATABASE_URL points at localhost.
 */
const path = require('path');
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }

const fs = require('fs'); const os = require('os'); const { execFileSync } = require('child_process');
const models = require(path.join(__dirname, '../../src/models'));
const { WorkOrder, WorkOrderPart, Client, ShipmentCharge, AppSettings, sequelize } = models;
const qb = require(path.join(__dirname, '../../src/routes/quickbooks'));
const { computeInvoiceTotals } = require(path.join(__dirname, '../../src/services/invoiceTotals'));
const { loadLaborMinimums } = require(path.join(__dirname, '../../src/services/pricing'));

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const money = (max) => Math.round(rnd() * max * 100) / 100;
const REG = ['plate_roll', 'angle_roll', 'pipe_roll', 'cone_roll', 'flat_stock', 'press_brake', 'other'];

(async () => {
  const N = parseInt(process.argv[2]) || 200;
  const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  await AppSettings.destroy({ where: { key: 'labor_minimums' } });
  await AppSettings.create({ key: 'labor_minimums', value: JSON.stringify([{ partTypes: ['plate_roll', 'angle_roll'], minimum: 150 }, { partTypes: ['cone_roll'], minimum: 300 }]) });
  const mins = await loadLaborMinimums();
  const clients = await Promise.all(['taxable', 'resale', 'exempt'].map((ts, i) =>
    Client.findOrCreate({ where: { name: `Fuzz Client ${ts}` }, defaults: { taxStatus: ts } }).then(([c]) => c)));

  let bad = 0, pdfChecked = 0;
  for (let n = 0; n < N; n++) {
    const client = pick(clients);
    const wo = await WorkOrder.create({
      orderNumber: `FUZZ-${Date.now()}-${n}`, clientId: client.id, clientName: client.name, status: 'stored',
      taxRate: pick([0, 7.25, 9.5, 10.25]), taxExempt: rnd() < 0.15,
      discountPercent: rnd() < 0.2 ? pick([5, 10, 12.5]) : null, discountAmount: rnd() < 0.15 ? money(80) : null,
      minimumOverride: rnd() < 0.2, truckingCost: rnd() < 0.3 ? money(200) : null, truckingDescription: 'Delivery',
    }, { hooks: false });
    const nParts = 1 + Math.floor(rnd() * 4);
    const regIds = [];
    let pn = 1;
    for (let i = 0; i < nParts; i++) {
      const stored = rnd() < 0.6;
      const p = await WorkOrderPart.create({
        workOrderId: wo.id, partNumber: pn++, partType: pick(REG), quantity: 1 + Math.floor(rnd() * 5),
        partTotal: stored ? money(1500) : null, laborTotal: money(200), materialTotal: stored ? null : money(300),
        materialMarkupPercent: stored ? null : pick([0, 20, 25]), setupCharge: rnd() < 0.2 ? money(50) : null,
        materialDescription: 'Fuzz part', formData: {},
      }, { hooks: false });
      regIds.push(p.id);
    }
    const nSvc = Math.floor(rnd() * 3);
    for (let i = 0; i < nSvc; i++) {
      await WorkOrderPart.create({
        workOrderId: wo.id, partNumber: rnd() < 0.2 ? 0 : pn++, partType: pick(['fab_service', 'shop_rate']), quantity: 1,
        partTotal: money(400), formData: rnd() < 0.5 ? { _linkedPartId: pick(regIds) } : {},
      }, { hooks: false });
    }
    if (rnd() < 0.35) {
      const fd = {};
      if (rnd() < 0.8) { fd._expediteEnabled = true; fd._expediteType = pick(['25', '50', 'custom_amt', 'custom_pct']); fd._expediteCustomAmt = money(300); fd._expediteCustomPct = pick([15, 33]); }
      if (rnd() < 0.4) { fd._emergencyEnabled = true; fd._emergencyDay = pick(['Saturday', 'Sunday Night']); }
      if (rnd() < 0.3) fd._linkedPartId = pick(regIds);
      await WorkOrderPart.create({ workOrderId: wo.id, partNumber: pn++, partType: 'rush_service', quantity: 1, partTotal: 0, formData: fd }, { hooks: false });
    }
    const nCh = rnd() < 0.4 ? 1 + Math.floor(rnd() * 2) : 0;
    for (let i = 0; i < nCh; i++) {
      await ShipmentCharge.create({ workOrderId: wo.id, carrierType: 'contracted', vendorName: 'Fuzz Freight', shippingCost: money(400), shippingMarkup: pick([0, 10, 15]), materialsCost: rnd() < 0.3 ? money(100) : 0, materialsMarkup: 0 }, { hooks: false });
    }

    const full = await WorkOrder.findByPk(wo.id, { include: [{ model: WorkOrderPart, as: 'parts' }, { model: Client, as: 'client' }] });
    const charges = await ShipmentCharge.findAll({ where: { workOrderId: wo.id } });
    const T = computeInvoiceTotals({ wo: full, parts: full.parts, client: full.client, shipmentCharges: charges, laborMinimums: mins });
    const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    const ol = console.log; console.log = () => {};
    const iif = await qb._buildInvoiceIIF(full, full.parts, full.client, 'FZ' + n);
    console.log = ol; console.warn = ow;
    const iifTotal = iif ? Math.round((iif.summary.total + iif.summary.tax) * 100) / 100 : 0;
    let ok = Math.abs(iifTotal - T.grandTotal) < 0.005 && !warns.some(w => w.includes('mismatch'));
    let pdfTotal = null;
    if (hasPdftotext && n % 4 === 0) {
      const buf = await qb._generateInvoicePDFBuffer(full, full.parts, full.client, [], charges);
      const f = path.join(os.tmpdir(), `fz-${n}.pdf`); fs.writeFileSync(f, buf);
      const m = execFileSync('pdftotext', ['-layout', f, '-']).toString().match(/TOTAL DUE\s+\$([\d,]+\.\d\d)/);
      pdfTotal = m ? parseFloat(m[1].replace(/,/g, '')) : NaN;
      pdfChecked++;
      if (!(Math.abs(pdfTotal - T.grandTotal) < 0.005)) ok = false;
      fs.unlinkSync(f);
    }
    if (!ok) { bad++; console.log(`MISMATCH #${n}: shared ${T.grandTotal} iif ${iifTotal} pdf ${pdfTotal}`, warns.join(' | ')); }
  }
  console.log(`${N} random work orders: ${N - bad} agree, ${bad} mismatched (PDF text checked on ${pdfChecked}).`);
  await sequelize.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
