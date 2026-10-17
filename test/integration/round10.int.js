/**
 * Round 10 checks: COD / one-click payments are real records and overpayment is checked (R14), the
 * paid mark follows the total (R15), frozen invoices print their QuickBooks total (R16), DR tools are
 * guarded (R17), unapplied cash becomes credit (R18), ordering material twice at once makes one PO
 * (R19), Undo respects the price lock (R26), a tablet save keeps a single heat's country (R29),
 * estimate status/dual pricing (R32). Runs against a RUNNING server and a LOCAL test database.
 */
const path = require('path');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json()).data?.token;
let TOKEN;
async function api(method, url, body, token = TOKEN, extra = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R10' + Date.now().toString(36);
  const client = tag + ' Co';
  await api('POST', '/clients', { name: client });
  const mkWO = async (total = 1000) => {
    const id = (await api('POST', '/workorders', { clientName: client })).body.data.id;
    if (total) await api('POST', `/workorders/${id}/parts`, { partType: 'fab_service', quantity: 1, partTotal: total, laborTotal: total });
    return id;
  };
  const balance = async (id) => (await api('GET', `/business/ledger?search=${encodeURIComponent(tag)}`)).body.data.invoices.find(i => i.id === id);
  const assignInv = (id) => api('POST', `/quickbooks/assign-invoice-number/${id}`);

  console.log('\nCOD and one-click payments are real records (R14)');
  const W = await mkWO(1000); await assignInv(W);
  const cod = await api('POST', `/workorders/${W}/record-payment`, { paymentMethod: 'check', paymentReference: '1234' }, CLERK);
  const pays = await q(`SELECT amount, notes FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [W]);
  const inv = await api('GET', `/workorders/${W}/invoice-totals`);
  check('the COD dialog records a payment for what was owed', cod.status === 200 && pays.length === 1 && Number(pays[0].amount) === Number(inv.body.data.amount), `${cod.status} ${JSON.stringify(pays)} vs ${inv.body?.data?.amount}`);
  const b1 = await balance(W);
  check('…so the ledger shows it paid, backed by a record', b1 && Number(b1.balance) === 0 && b1.payments.length === 1 && !b1.legacyPayment, JSON.stringify(b1 && { bal: b1.balance, n: b1.payments.length }));
  const again = await api('POST', `/workorders/${W}/record-payment`, { paymentMethod: 'cash' }, CLERK);
  const n2 = (await q(`SELECT COUNT(*)::int n FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [W]))[0].n;
  check('recording it again creates no second payment (already paid)', again.status === 200 && /Already paid/.test(again.body?.message || '') && n2 === 1, `${again.status} ${again.body?.message} ${n2}`);
  const clrClerk = await api('POST', `/workorders/${W}/clear-payment`, null, CLERK);
  const clr = await api('POST', `/workorders/${W}/clear-payment`);
  const after = await q(`SELECT COUNT(*)::int n FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [W]);
  check('clearing it is admin-only and voids the COD record', clrClerk.status === 403 && clr.status === 200 && after[0].n === 0, `${clrClerk.status} ${clr.status} ${after[0].n}`);
  const W2 = await mkWO(800); await assignInv(W2);
  const owed2 = (await api('GET', `/workorders/${W2}/invoice-totals`)).body.data.amount;
  await api('POST', `/business/ledger/${W2}/payments`, { amount: owed2, paymentMethod: 'check', paymentType: 'full' });
  const codPaidAlready = await api('POST', `/workorders/${W2}/record-payment`, { paymentMethod: 'check' }, CLERK);
  const w2 = (await q(`SELECT "codPaid" FROM work_orders WHERE id = $1`, [W2]))[0];
  const w2n = (await q(`SELECT COUNT(*)::int n FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [W2]))[0].n;
  check('COD on an order already paid in the ledger releases the pickup without a second record', codPaidAlready.status === 200 && w2.codPaid === true && w2n === 1, `${codPaidAlready.status} ${codPaidAlready.body?.error?.message} ${w2.codPaid} ${w2n}`);
  const W3 = await mkWO(0);
  const codNoAmt = await api('POST', `/workorders/${W3}/record-payment`, { paymentMethod: 'cash' }, CLERK);
  const codUnpriced = await api('POST', `/workorders/${W3}/record-payment`, { paymentMethod: 'cash', amount: 250 }, CLERK);
  const w3 = (await q(`SELECT "codPaid" FROM work_orders WHERE id = $1`, [W3]))[0];
  const w3p = (await q(`SELECT amount FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [W3]));
  check('COD on an unpriced order asks for the amount and records it (round 12, N13)', codNoAmt.status === 400 && codUnpriced.status === 200 && w3.codPaid === true && w3p.length === 1 && Number(w3p[0].amount) === 250, `${codNoAmt.status} ${codUnpriced.status} ${codUnpriced.body?.error?.message} ${JSON.stringify(w3p)}`);
  const W4 = await mkWO(500); await assignInv(W4);
  const part4 = await api('POST', `/workorders/${W4}/record-payment`, { paymentMethod: 'cash', amount: 10 }, CLERK);
  const w4 = (await q(`SELECT "codPaid" FROM work_orders WHERE id = $1`, [W4]))[0];
  check('a partial COD amount is recorded but does not release the pickup', part4.status === 200 && w4.codPaid === false, `${part4.status} ${w4.codPaid}`);
  const L = await mkWO(2190); await assignInv(L);
  await pg.query(`UPDATE work_orders SET "paymentDate" = now() WHERE id = $1`, [L]);   // an old one-click "paid"
  const over = await api('POST', `/business/ledger/${L}/payments`, { amount: 5000, paymentMethod: 'check' });
  check('a legacy "marked paid" invoice no longer switches the overpayment check off', over.status === 400 && /invoice total/.test(over.body?.error?.message || ''), `${over.status} ${over.body?.error?.message}`);
  const legacyClear = await api('POST', `/business/payments/${L}/clear`);
  check('…and its mark can be cleared (no records behind it)', legacyClear.status === 200, legacyClear.status);

  console.log('\nThe paid mark follows the total (R15)');
  const P = await mkWO(1000); await assignInv(P);
  const owed = (await api('GET', `/workorders/${P}/invoice-totals`)).body.data.amount;
  await api('POST', `/business/ledger/${P}/payments`, { amount: owed, paymentMethod: 'check', paymentType: 'full' });
  const paidRow = (await q(`SELECT "paymentDate" FROM work_orders WHERE id = $1`, [P]))[0];
  await api('POST', `/workorders/${P}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 500, laborTotal: 500 });
  let flag = null;
  for (let i = 0; i < 20; i++) { await sleep(300); flag = (await q(`SELECT "paymentDate" FROM work_orders WHERE id = $1`, [P]))[0].paymentDate; if (!flag) break; }
  const aging = await api('GET', '/business/payments/outstanding');
  const inAging = JSON.stringify(aging.body).includes(P);
  check('raising a paid invoice clears its "paid" mark and it shows in aging again', !!paidRow.paymentDate && flag === null && inAging, `${paidRow.paymentDate} → ${flag} aging:${inAging}`);

  console.log('\nFrozen invoices print the QuickBooks total (R16)');
  const F = await mkWO(1000); await assignInv(F);
  const exp = await api('GET', `/quickbooks/export/${F}`);
  const frozen = (await q(`SELECT "grandTotal", "taxAmount" FROM work_orders WHERE id = $1`, [F]))[0];
  await pg.query(`UPDATE clients SET "taxStatus" = 'resale' WHERE name = $1`, [client]);
  const { printableTotals, computeInvoiceTotals } = require('../../src/services/invoiceTotals');
  const models = require('../../src/models');
  const wo = await models.WorkOrder.findByPk(F); const parts = await models.WorkOrderPart.findAll({ where: { workOrderId: F } });
  const c = await models.Client.findOne({ where: { name: client } });
  const live = computeInvoiceTotals({ wo, parts, client: c, shipmentCharges: [], laborMinimums: [] });
  const printed = printableTotals(live, wo);
  check('after the client turns tax-exempt, the PDF still shows the exported total and tax', exp.status === 200 && live.grandTotal !== Number(frozen.grandTotal) && printed.grandTotal === Number(frozen.grandTotal) && printed.taxAmount === Number(frozen.taxAmount) && !printed.isTaxExempt, `live ${live.grandTotal} printed ${printed.grandTotal} frozen ${frozen.grandTotal}`);
  check('…and its printed rows still add up', Math.abs(printed.partsAfterDiscount + printed.taxAmount + printed.shippingTotal - printed.grandTotal) < 0.01);
  const legacyT = printableTotals({ ...live, usesLegacyTrucking: true, shippingTotal: 100, grandTotal: 1300, taxAmount: 90 }, { iifExportedAt: new Date(), totalsComputedAt: new Date(), grandTotal: '1200.00', taxAmount: '90.00' });
  check('…including on old invoices with a trucking charge (parts + tax + shipping = total)', Math.abs(legacyT.partsAfterDiscount + legacyT.taxAmount + legacyT.shippingTotal - 1200) < 0.01, JSON.stringify({ p: legacyT.partsAfterDiscount, t: legacyT.taxAmount, s: legacyT.shippingTotal }));
  await pg.query(`UPDATE clients SET "taxStatus" = NULL WHERE name = $1`, [client]);

  console.log('\nUnapplied cash becomes client credit (R18)');
  const A = await mkWO(500); await assignInv(A);
  const cp = await api('POST', '/business/client-payments', { clientName: client, amount: 1000, method: 'check', reference: tag, applications: [{ workOrderId: A, amount: 300 }] });
  const cm = cp.body?.data?.creditMemo;
  check('the $700 not applied to an invoice is held as a credit memo', cp.status === 200 && cm && Number(cm.amount) === 700, `${cp.status} ${JSON.stringify(cm)}`);

  console.log('\nDR-number tools (R17)');
  const D = await mkWO(400);
  const base = 980000 + Math.floor(Math.random() * 9000);
  const setDr = await api('PUT', `/workorders/${D}/dr-number`, { drNumber: base });
  await api('POST', `/workorders/${D}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 1, laborTotal: 1 });
  const lotBefore = await q(`SELECT "lotNumber" FROM work_order_parts WHERE "workOrderId" = $1 AND "lotNumber" IS NOT NULL`, [D]);
  const jump = await api('PUT', `/workorders/${D}/dr-number`, { drNumber: base + 50000 });
  check('a DR far past the highest in use is refused as a likely typo', setDr.status === 200 && jump.status === 400 && /typo/.test(jump.body?.error?.message || ''), `${setDr.status} ${jump.status} ${jump.body?.error?.message}`);
  const moved = await api('PUT', `/workorders/${D}/dr-number`, { drNumber: base + 1 });
  const lotAfter = await q(`SELECT "lotNumber" FROM work_order_parts WHERE "workOrderId" = $1 AND "lotNumber" IS NOT NULL`, [D]);
  check('changing a DR also renames the lot numbers', moved.status === 200 && lotBefore.length > 0 && lotAfter.every(r => r.lotNumber.startsWith(String(base + 1) + '-')), `${moved.status} ${JSON.stringify(lotBefore)} → ${JSON.stringify(lotAfter)}`);
  const relClerk = await api('DELETE', `/dr-numbers/${base + 1}/release`, null, CLERK);
  await assignInv(D);
  const relInv = await api('DELETE', `/dr-numbers/${base + 1}/release`);
  check('releasing a DR: admins only, and never once the order has an invoice', relClerk.status === 403 && relInv.status === 409, `${relClerk.status} ${relInv.status}`);
  const voidClerk = await api('POST', `/dr-numbers/${base + 1}/void`, { reason: 'test' }, CLERK);
  check('a non-admin can\'t void an invoiced order', voidClerk.status === 403, voidClerk.status);
  await api('POST', `/business/ledger/${D}/payments`, { amount: 10, paymentMethod: 'cash' });
  const voidPaid = await api('POST', `/dr-numbers/${base + 1}/void`, { reason: 'test' });
  check('an order with payments can\'t be voided until they are', voidPaid.status === 409, voidPaid.status);
  const chPaid = await api('PUT', `/workorders/${D}/dr-number`, { drNumber: base + 2 });
  check('…nor have its DR changed', chPaid.status === 409, chPaid.status);
  const V = await mkWO(300); await assignInv(V);
  const vdr = base + 3; await api('PUT', `/workorders/${V}/dr-number`, { drNumber: vdr });
  const vd = await api('POST', `/dr-numbers/${vdr}/void`, { reason: 'entered twice' });
  const ledgerV = await balance(V);
  check('a voided order leaves the ledger', vd.status === 200 && !ledgerV, `${vd.status} ${!!ledgerV}`);
  const nextClerk = await api('PUT', '/dr-numbers/next', { nextNumber: base + 4 }, CLERK);
  check('only an admin can move the next DR number', nextClerk.status === 403, nextClerk.status);

  console.log('\nOrdering material twice at once (R19)');
  const M = (await api('POST', '/workorders', { clientName: client })).body.data.id;
  const mp = (await api('POST', `/workorders/${M}/parts`, { partType: 'plate_roll', quantity: 1, materialSource: 'we_order', supplierName: tag + ' Steel', materialDescription: 'plate 1/4' })).body.data.id;
  const orders = await Promise.all([1, 2, 3].map(() => api('POST', `/workorders/${M}/order-material`, { partIds: [mp] })));
  const codes = orders.map(o => o.status).sort();
  const pos = await q(`SELECT COUNT(*)::int n FROM po_numbers WHERE "workOrderId" = $1 AND status = 'active'`, [M]);
  check('three simultaneous orders for one part make ONE PO; the others are told it\'s ordered', codes.filter(c => c < 300).length === 1 && codes.filter(c => c === 409).length === 2 && pos[0].n === 1, `${codes.join(',')} POs:${pos[0].n}`);

  console.log('\nUndo and the QuickBooks price lock (R26)');
  const U = await mkWO(200); await api('POST', `/workorders/${U}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 50, laborTotal: 50 });
  const up = (await q(`SELECT id FROM work_order_parts WHERE "workOrderId" = $1 ORDER BY "partNumber" DESC LIMIT 1`, [U]))[0].id;
  await api('DELETE', `/workorders/${U}/parts/${up}`);
  await pg.query(`UPDATE work_orders SET "iifExportedAt" = now() WHERE id = $1`, [U]);
  const [ue] = await q(`SELECT id FROM deletion_archive WHERE "recordId" = $1`, [up]);
  const un = await api('POST', `/deletion-archive/${ue.id}/undo`);
  check('a deleted line can\'t be undone onto an invoice already in QuickBooks', un.status === 409 && /QuickBooks/.test(un.body?.error?.message || ''), `${un.status} ${un.body?.error?.message}`);

  console.log('\nTablet saves keep a single heat\'s country (R29)');
  const H = await mkWO(0);
  const hp = (await api('POST', `/workorders/${H}/parts`, { partType: 'plate_roll', quantity: 1, heatNumber: 'H123', heatCountry: 'US' })).body.data.id;
  await api('PUT', `/workorders/${H}/parts/${hp}`, { heatBreakdown: [{ heat: 'H123', qty: 1 }], notes: 'tablet note' });
  const hb = (await q(`SELECT "heatBreakdown" FROM work_order_parts WHERE id = $1`, [hp]))[0].heatBreakdown;
  check('a notes save that sends the heat without a country keeps "US"', Array.isArray(hb) && hb[0]?.country === 'US', JSON.stringify(hb));

  console.log('\nEstimates (R32)');
  const E = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${E}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '100.00', laborTotal: '100.00' });
  const dual = await api('PUT', `/estimates/${E}`, { showDualPricing: true });
  const dualRow = (await q(`SELECT "showDualPricing" FROM estimates WHERE id = $1`, [E]))[0];
  check('"Show dual pricing" is saved', dual.status === 200 && dualRow.showDualPricing === true, JSON.stringify(dualRow));
  const conv = await api('POST', `/estimates/${E}/convert-to-workorder`, { materialReceived: true });
  const back = await api('PUT', `/estimates/${E}`, { status: 'sent', notes: 'stale screen' });
  check('an estimate on a work order can\'t be set back to "sent" by a stale screen', conv.status === 201 && back.status === 409, `${conv.status} ${back.status}`);
  const declined = await api('POST', `/estimates/${E}/mark-declined`);
  check('…nor marked declined', declined.status === 409, declined.status);

  await pg.end();
  await models.sequelize.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
