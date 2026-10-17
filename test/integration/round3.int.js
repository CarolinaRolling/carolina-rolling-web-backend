/**
 * Round 3 checks: H10 (QuickBooks lock), H6 (voids & credit memos), H11 (PO numbers), M15 (partial
 * part updates). Runs against a RUNNING server and a LOCAL test database; refuses anything else.
 *
 *   DATABASE_URL=<local test db> TEST_BASE_URL=http://localhost:5055/api node test/integration/round3.int.js
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const near = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.005;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json()).data?.token;
let TOKEN;
async function api(method, url, body, token = TOKEN) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
}

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R3' + Date.now().toString(36);
  await pg.query(`INSERT INTO clients (id, name, "taxStatus", "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'resale', true, now(), now()), (gen_random_uuid(), $2, 'resale', true, now(), now())`, [tag + ' Alpha', tag + ' Beta']);
  const [alpha] = await q(`SELECT id, name FROM clients WHERE name = $1`, [tag + ' Alpha']);
  const [beta] = await q(`SELECT id, name FROM clients WHERE name = $1`, [tag + ' Beta']);
  await pg.query(`INSERT INTO clients (id, name, "taxStatus", "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'taxable', true, now(), now())`, [tag + ' Gamma']);
  const [gamma] = await q(`SELECT id, name FROM clients WHERE name = $1`, [tag + ' Gamma']);
  const newWO = async (client, total, extra = {}) => {
    const w = (await api('POST', '/workorders', { clientId: client.id, clientName: client.name })).body.data.id;
    let partId = null;
    if (total) partId = (await api('POST', `/workorders/${w}/parts`, { partType: 'fab_service', quantity: 1, partTotal: total, laborTotal: total, ...extra })).body.data.id;
    return { id: w, partId };
  };
  const balanceOf = async (woId) => { const l = await api('GET', '/business/ledger'); return l.body.data.invoices.find(i => i.id === woId); };

  console.log('\nM15 — partial part updates (tablet taps) keep prices');
  const t = await newWO(alpha, 400);
  await api('PUT', `/workorders/${t.id}/parts/${t.partId}`, { status: 'in_progress' });
  await api('PUT', `/workorders/${t.id}/parts/${t.partId}`, { progressCount: 1 });
  await api('PUT', `/workorders/${t.id}/parts/${t.partId}`, { operatorNotes: 'rolled' });
  const tp = (await q(`SELECT "partTotal", "laborTotal" FROM work_order_parts WHERE id = $1`, [t.partId]))[0];
  check('status, progress and note updates leave partTotal/laborTotal alone', near(tp.partTotal, 400) && near(tp.laborTotal, 400), JSON.stringify(tp));

  console.log('\nH10 — pricing locked once in QuickBooks');
  const L = await newWO(gamma, 500);
  await api('POST', `/quickbooks/assign-invoice-number/${L.id}`);
  await api('POST', '/quickbooks/mark-entered', { workOrderIds: [L.id] });
  const e1 = await api('PUT', `/workorders/${L.id}/parts/${L.partId}`, { partTotal: 650, laborTotal: 650 });
  check('changing a part price → 409 with an explanation', e1.status === 409 && /QuickBooks/.test(e1.body?.error?.message || ''), `${e1.status} ${e1.body?.error?.message}`);
  const e2 = await api('PUT', `/workorders/${L.id}/parts/${L.partId}`, { partTotal: '500.00', laborTotal: 500, quantity: 1 });
  check('re-saving the same prices → allowed', e2.status === 200, e2.status);
  const e3 = await api('PUT', `/workorders/${L.id}/parts/${L.partId}`, { status: 'completed', operatorNotes: 'done' });
  check('tablet status / notes on a locked order → allowed', e3.status === 200, e3.status);
  const e4 = await api('POST', `/workorders/${L.id}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 99 });
  check('adding a part → 409', e4.status === 409, e4.status);
  const e5 = await api('DELETE', `/workorders/${L.id}/parts/${L.partId}`);
  check('deleting a part → 409', e5.status === 409, e5.status);
  const e6 = await api('POST', `/workorders/${L.id}/shipment-charges`, { carrierType: 'contracted', shippingCost: 75 });
  check('adding a shipping charge → 409', e6.status === 409, e6.status);
  const e7 = await api('PUT', `/workorders/${L.id}`, { taxRate: 12 });
  check('changing the tax rate → 409', e7.status === 409, e7.status);
  const e8 = await api('PUT', `/workorders/${L.id}`, { notes: 'call before delivery' });
  check('changing notes → allowed', e8.status === 200, e8.status);
  // What the web form really sends on Save: defaults filled in (20% markup on a part with none,
  // recomputed _baseLaborTotal) — the invoice doesn't change, so it must be allowed
  const formSave = await api('PUT', `/workorders/${L.id}/parts/${L.partId}`, { partTotal: 500, laborTotal: 500, quantity: '1', materialMarkupPercent: 20, _baseLaborTotal: '500.00', heatNumber: 'H123' });
  check('full part-form save with filled-in defaults, same invoice → allowed', formSave.status === 200, `${formSave.status} ${formSave.body?.error?.message}`);
  const zeroAdd = await api('POST', `/workorders/${L.id}/parts`, { partType: 'inspection', quantity: 1, partTotal: 0 });
  check('adding a $0 line (inspection) → allowed', zeroAdd.status === 201, `${zeroAdd.status} ${zeroAdd.body?.error?.message}`);
  const zeroDel = zeroAdd.body?.data?.id ? await api('DELETE', `/workorders/${L.id}/parts/${zeroAdd.body.data.id}`) : { status: 0 };
  check('removing a $0 line → allowed', zeroDel.status === 200, zeroDel.status);
  const R = await newWO(alpha, 400);   // resale client
  await api('POST', `/quickbooks/assign-invoice-number/${R.id}`);
  await api('POST', '/quickbooks/mark-entered', { workOrderIds: [R.id] });
  const orderForm = await api('PUT', `/workorders/${R.id}`, { taxRate: 9.75, taxExempt: true, storageLocation: 'Bay 3', notes: 'edited' });
  check('order-form save for a resale client (form fills default tax + exempt) → allowed', orderForm.status === 200, `${orderForm.status} ${orderForm.body?.error?.message}`);
  const rp = await api('POST', '/workorders/repair-pricing');
  check('price-repair tool skips and lists orders in QuickBooks instead of failing', rp.status === 200 && Array.isArray(rp.body.data?.skippedInQuickBooks), `${rp.status} ${rp.body?.error?.message || ''}`);
  const lockedPart = (await q(`SELECT "partTotal" FROM work_order_parts WHERE id = $1`, [L.partId]))[0];
  check('price is unchanged after the refused edits', near(lockedPart.partTotal, 500), lockedPart.partTotal);
  const u1 = await api('POST', '/quickbooks/unmark-entered', { workOrderIds: [L.id] }, CLERK);
  check('non-admin can\'t reopen (un-mark) → 403', u1.status === 403, u1.status);
  const u2 = await api('POST', '/quickbooks/unmark-entered', { workOrderIds: [L.id] });
  const e9 = await api('PUT', `/workorders/${L.id}/parts/${L.partId}`, { partTotal: 650, laborTotal: 650 });
  check('after an admin reopens it, the price can change', u2.status === 200 && e9.status === 200, `${u2.status} ${e9.status}`);
  const logged = await q(`SELECT count(*)::int n FROM activity_logs WHERE action = 'INVOICE_REOPENED' AND "resourceId" = $1`, [L.id]);
  check('the reopen is in the activity log', logged[0].n === 1, logged[0].n);

  console.log('\nH6 — voids and credit memos');
  const A = await newWO(alpha, 300), B = await newWO(alpha, 500), X = await newWO(beta, 100);
  for (const w of [A, B, X]) await api('POST', `/quickbooks/assign-invoice-number/${w.id}`);
  const cp = await api('POST', '/business/client-payments', { clientId: alpha.id, clientName: alpha.name, amount: 500, reference: 'CHK-9', applications: [{ workOrderId: A.id, amount: 300 }, { workOrderId: B.id, amount: 200 }] });
  const cpId = cp.body.data.payment.id;
  const shareA = (await q(`SELECT id FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [A.id]))[0].id;
  const v1 = await api('DELETE', `/business/ledger/payments/${shareA}`);
  const memo = (await q(`SELECT id, amount, "remainingAmount" FROM credit_memos WHERE "sourceClientPaymentId" = $1 AND "voidedAt" IS NULL`, [cpId]))[0];
  check('voiding one invoice\'s share of a check → that amount becomes client credit', v1.status === 200 && v1.body.outcome === 'moved_to_credit' && memo && near(memo.amount, 300), `${v1.status} ${v1.body?.outcome} ${JSON.stringify(memo)}`);
  check('… and invoice A owes the full $300 again', near((await balanceOf(A.id)).balance, 300));
  const glRev = async () => { const g = await api('GET', '/business/general-ledger'); return (g.body.data?.entries || []).filter(e => e.type === 'payment' && e.clientName === alpha.name).reduce((s, e) => s + (e.credit || 0), 0); };
  check('general ledger still shows the $500 check once', near(await glRev(), 500), await glRev());

  const over = await api('POST', `/business/credit-memos/${memo.id}/apply`, { workOrderId: B.id, amount: 300.01 });
  check('applying more than the credit → 400', over.status === 400, `${over.status} ${over.body?.error?.message}`);
  const wrong = await api('POST', `/business/credit-memos/${memo.id}/apply`, { workOrderId: X.id, amount: 50 });
  check('applying credit to another client\'s invoice → 400', wrong.status === 400 && /belongs to/.test(wrong.body?.error?.message || ''), wrong.body?.error?.message);
  const ap = await api('POST', `/business/credit-memos/${memo.id}/apply`, { workOrderId: B.id, amount: 300 });
  const memoAfter = (await q(`SELECT "remainingAmount" FROM credit_memos WHERE id = $1`, [memo.id]))[0];
  const bB = await balanceOf(B.id);
  check('applying $300 credit to invoice B → B paid in full, credit used up', ap.status === 200 && bB.isPaid && near(memoAfter.remainingAmount, 0), `${ap.status} ${JSON.stringify(bB && { bal: bB.balance, paid: bB.isPaid })} rem=${memoAfter.remainingAmount}`);
  check('general ledger doesn\'t count applied credit as new money', near(await glRev(), 500), await glRev());
  const creditRow = (await q(`SELECT id FROM work_order_payments WHERE "creditMemoApplicationId" IS NOT NULL AND "workOrderId" = $1 AND "voidedAt" IS NULL`, [B.id]))[0];
  const un = await api('DELETE', `/business/ledger/payments/${creditRow.id}`);
  const memoBack = (await q(`SELECT "remainingAmount" FROM credit_memos WHERE id = $1`, [memo.id]))[0];
  check('removing the credit from B → credit available again, B owes $300', un.body?.outcome === 'credit_unapplied' && near(memoBack.remainingAmount, 300) && near((await balanceOf(B.id)).balance, 300), `${un.body?.outcome} rem=${memoBack.remainingAmount}`);

  // two people applying the same credit at once
  const C1 = await newWO(alpha, 300), C2 = await newWO(alpha, 300);
  for (const w of [C1, C2]) await api('POST', `/quickbooks/assign-invoice-number/${w.id}`);
  const race = await Promise.all([api('POST', `/business/credit-memos/${memo.id}/apply`, { workOrderId: C1.id, amount: 300 }), api('POST', `/business/credit-memos/${memo.id}/apply`, { workOrderId: C2.id, amount: 300 })]);
  check('two people applying the same $300 credit at once → only one succeeds', race.map(r => r.status).sort().join() === '200,400', race.map(r => r.status).join());

  // Race: one person voids an invoice's share while another voids the whole check
  const D1 = await newWO(alpha, 100), D2 = await newWO(alpha, 100);
  for (const w of [D1, D2]) await api('POST', `/quickbooks/assign-invoice-number/${w.id}`);
  const cp2 = await api('POST', '/business/client-payments', { clientId: alpha.id, clientName: alpha.name, amount: 200, applications: [{ workOrderId: D1.id, amount: 100 }, { workOrderId: D2.id, amount: 100 }] });
  const cp2Id = cp2.body.data.payment.id;
  const share = (await q(`SELECT id FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [D1.id]))[0].id;
  const both = await Promise.all([api('DELETE', `/business/ledger/payments/${share}`), api('POST', `/business/client-payments/${cp2Id}/void`, { reason: 'bounced' })]);
  const strayCredit = await q(`SELECT count(*)::int n FROM credit_memos WHERE "sourceClientPaymentId" = $1 AND "voidedAt" IS NULL`, [cp2Id]);
  check('voiding a share and the whole check at the same moment → no 500s, no credit left from the voided check', both.every(b => b.status < 500) && strayCredit[0].n === 0, `${both.map(b => b.status)} active credit=${strayCredit[0].n}`);

  const vc = await api('POST', `/business/client-payments/${cpId}/void`, { reason: 'bounced' });
  const cpRow = (await q(`SELECT "voidedAt" FROM client_payments WHERE id = $1`, [cpId]))[0];
  const memoV = (await q(`SELECT "voidedAt" FROM credit_memos WHERE id = $1`, [memo.id]))[0];
  check('voiding the whole check → payment voided, its credit memo voided', vc.status === 200 && cpRow.voidedAt && memoV.voidedAt, `${vc.status} ${vc.body?.message}`);
  const bAfter = await balanceOf(B.id), c1After = await balanceOf(C1.id), c2After = await balanceOf(C2.id);
  check('… and every invoice it paid owes again (B $500, the credited one $300)', near(bAfter.balance, 500) && near(parseFloat(c1After.balance) + parseFloat(c2After.balance), 600), `${bAfter.balance} ${c1After.balance} ${c2After.balance}`);
  check('general ledger drops the voided check', near(await glRev(), 0), await glRev());
  const vc2 = await api('POST', `/business/client-payments/${cpId}/void`, {});
  check('voiding it again → 400', vc2.status === 400, vc2.status);

  console.log('\nH11 — PO numbers');
  await pg.query(`DELETE FROM app_settings WHERE key = 'next_po_number'`);
  const nxt = await api('GET', '/po-numbers/next');
  const start = nxt.body.data.nextNumber;
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => api('POST', '/po-numbers/assign', { customNumber: start, supplier: 'Steel ' + i })));
  const got = burst.map(b => b.body?.data?.poNumber);
  check('10 people creating a PO from the same suggested number → 10 different POs, no errors', burst.every(b => b.status === 201) && new Set(got).size === 10, `${burst.map(b => b.status)} ${got}`);
  check('… one got the suggested number, the rest were told it was taken', got.includes(start) && burst.filter(b => /had just been taken/.test(b.body?.message || '')).length === 9);
  const back = await api('PUT', '/po-numbers/next', { nextNumber: start });
  check('setting the next PO number backwards → 400', back.status === 400, `${back.status} ${back.body?.error?.message}`);

  const M1 = await newWO(alpha, 0), M2 = await newWO(alpha, 0);
  const pm1 = (await api('POST', `/workorders/${M1.id}/parts`, { partType: 'plate_roll', quantity: 1, supplierName: 'Mill A' })).body.data.id;
  const pm2 = (await api('POST', `/workorders/${M2.id}/parts`, { partType: 'plate_roll', quantity: 1, supplierName: 'Mill B' })).body.data.id;
  const suggested = (await api('GET', '/po-numbers/next')).body.data.nextNumber;
  const om = await Promise.all([api('POST', `/workorders/${M1.id}/order-material`, { purchaseOrderNumber: String(suggested), partIds: [pm1] }), api('POST', `/workorders/${M2.id}/order-material`, { purchaseOrderNumber: String(suggested), partIds: [pm2] })]);
  const pos = await q(`SELECT "materialPurchaseOrderNumber" AS po FROM work_order_parts WHERE id = ANY($1)`, [[pm1, pm2]]);
  check('two people ordering material with the same suggested PO → two different POs', om.every(o => o.status === 201) && new Set(pos.map(p => p.po)).size === 2 && pos.every(p => p.po), `${om.map(o => o.status)} ${pos.map(p => p.po)}`);
  const inb = (await q(`SELECT id, "purchaseOrderNumber" FROM inbound_orders WHERE "workOrderId" = $1`, [M1.id]))[0];
  const oldNum = parseInt(inb.purchaseOrderNumber.replace(/\D/g, ''), 10);
  const newNum = oldNum + 500;   // round 12: a reassign more than 1000 past the highest PO is refused (typo guard)
  const ra = await api('PUT', `/po-numbers/${oldNum}/reassign`, { newPoNumber: newNum });
  const inbAfter = (await q(`SELECT "purchaseOrderNumber" FROM inbound_orders WHERE id = $1`, [inb.id]))[0];
  const partAfter = (await q(`SELECT "materialPurchaseOrderNumber" AS po FROM work_order_parts WHERE id = $1`, [pm1]))[0];
  check('reassigning a PO with a delivery attached works and updates the delivery and part', ra.status === 200 && inbAfter.purchaseOrderNumber === `PO${newNum}` && partAfter.po === `PO${newNum}`, `${ra.status} ${ra.body?.error?.message || ''} ${inbAfter.purchaseOrderNumber} ${partAfter.po}`);
  const vo = await api('POST', `/po-numbers/${newNum}/void`, { reason: 'vendor cancelled' });
  const inbV = (await q(`SELECT status FROM inbound_orders WHERE id = $1`, [inb.id]))[0];
  check('voiding a PO with a delivery attached works and cancels the delivery', vo.status === 200 && inbV.status === 'cancelled', `${vo.status} ${inbV.status}`);
  const inb2 = (await q(`SELECT id, "purchaseOrderNumber" FROM inbound_orders WHERE "workOrderId" = $1`, [M2.id]))[0];
  const n2 = parseInt(inb2.purchaseOrderNumber.replace(/\D/g, ''), 10);
  const rel = await api('DELETE', `/po-numbers/${n2}/release`);
  const gone = await q(`SELECT 1 FROM inbound_orders WHERE id = $1`, [inb2.id]);
  const reuse = await api('POST', '/po-numbers/assign', { customNumber: n2, supplier: 'Reuse' });
  check('releasing a PO works, removes its pending delivery, and the number can be reused', rel.status === 200 && gone.length === 0 && reuse.body?.data?.poNumber === n2, `${rel.status} ${gone.length} ${reuse.body?.data?.poNumber}`);
  const M3 = await newWO(alpha, 0);
  const pm3 = (await api('POST', `/workorders/${M3.id}/parts`, { partType: 'plate_roll', quantity: 1, supplierName: 'Mill C' })).body.data.id;
  await api('POST', `/workorders/${M3.id}/order-material`, { partIds: [pm3] });
  const po3 = (await q(`SELECT p.id, p."inboundOrderId" FROM po_numbers p JOIN inbound_orders i ON i.id = p."inboundOrderId" WHERE i."workOrderId" = $1`, [M3.id]))[0];
  const del = await api('DELETE', `/po-numbers/${po3.id}`);
  const inbGone = await q(`SELECT 1 FROM inbound_orders WHERE id = $1`, [po3.inboundOrderId]);
  check('deleting a PO with a delivery attached works (used to fail the database check)', del.status === 200 && inbGone.length === 0, `${del.status} ${JSON.stringify(del.body).slice(0, 120)}`);
  const far = await api('POST', '/po-numbers/assign', { customNumber: (await api('GET', '/po-numbers/next')).body.data.nextNumber * 10, supplier: 'Typo' });
  check('a typed PO number far past the sequence (extra digit) → 400', far.status === 400, `${far.status} ${far.body?.error?.message}`);
  const nextBefore = (await api('GET', '/po-numbers/next')).body.data.nextNumber;
  await pg.query(`INSERT INTO inbound_orders (id, "purchaseOrderNumber", "supplierName", description, status, "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'Old vendor', 'old PO', 'pending', 'x', now(), now())`, [`PO${nextBefore}`]);
  const skip = await api('POST', '/po-numbers/assign', { customNumber: nextBefore, supplier: 'S' });
  check('a number already on a delivery (old PO with no tracker row) is not handed out again', skip.status === 201 && skip.body.data.poNumber !== nextBefore, `${skip.status} ${skip.body?.data?.poNumber} vs ${nextBefore}`);
  const M4 = await newWO(alpha, 0);
  const pm4 = (await api('POST', `/workorders/${M4.id}/parts`, { partType: 'plate_roll', quantity: 1, supplierName: 'Mill D' })).body.data.id;
  await api('POST', `/workorders/${M4.id}/order-material`, { partIds: [pm4] });
  const po4 = (await q(`SELECT p.id, p."inboundOrderId" FROM po_numbers p JOIN inbound_orders i ON i.id = p."inboundOrderId" WHERE i."workOrderId" = $1`, [M4.id]))[0];
  await pg.query(`UPDATE inbound_orders SET status = 'received' WHERE id = $1`, [po4.inboundOrderId]);
  const delRecv = await api('DELETE', `/po-numbers/${po4.id}`);
  check('deleting a PO whose material already arrived → refused (409)', delRecv.status === 409, `${delRecv.status} ${delRecv.body?.error?.message}`);
  const { reserveStandalone } = require(path.join(__dirname, '../../src/services/poNumbers'));
  const op = await reserveStandalone('OP', { supplier: 'Galvanizer' });
  const opN = parseInt(op.slice(2), 10);
  const opRow = await q(`SELECT 1 FROM po_numbers WHERE "poNumber" = $1`, [opN]);
  check('outside-processing POs come from the same sequence (no clash with PO numbers)', /^OP\d+$/.test(op) && opRow.length === 1 && opN > Math.max(...got), op);

  console.log('\nRecovery script for prices wiped by the old bug');
  const est = await api('POST', '/estimates', { clientName: alpha.name, clientId: alpha.id });
  await api('POST', `/estimates/${est.body.data.id}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 777, laborTotal: 777 });
  const conv = await api('POST', `/estimates/${est.body.data.id}/convert-to-workorder`, { materialReceived: true });
  const cwo = conv.body.data.workOrder.id;
  await pg.query(`UPDATE work_order_parts SET "partTotal" = NULL, "laborTotal" = NULL, "materialTotal" = NULL WHERE "workOrderId" = $1`, [cwo]);  // simulate the old wipe
  const env = { ...process.env };
  const dry = execFileSync('node', [path.join(__dirname, '../../scripts/recover-wiped-part-pricing.js')], { env }).toString();
  const stillNull = (await q(`SELECT "partTotal" FROM work_order_parts WHERE "workOrderId" = $1`, [cwo]))[0];
  check('dry run reports the part and writes nothing', /recoverable from the estimate: [1-9]/.test(dry) && stillNull.partTotal === null, dry.split('\n')[1]);
  execFileSync('node', [path.join(__dirname, '../../scripts/recover-wiped-part-pricing.js'), '--apply'], { env });
  const restored = (await q(`SELECT "partTotal", "laborTotal" FROM work_order_parts WHERE "workOrderId" = $1`, [cwo]))[0];
  check('--apply restores the prices from the estimate', near(restored.partTotal, 777) && near(restored.laborTotal, 777), JSON.stringify(restored));

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
