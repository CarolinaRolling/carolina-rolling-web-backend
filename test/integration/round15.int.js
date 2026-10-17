/**
 * Round 15 checks (fourth independent audit, U-series): tablet status side door (U2), rush lines don't
 * block completion (U28), COD release on the server (U10), overpayment credit tied to its payment (U3),
 * dual-pricing Option B from the shared engine (U4), reorder client (U5), tablets see no prices on
 * shipments/deliveries (U7), received-delivery guard (U8), 2FA setup (U9), estimate total includes
 * shipping charges (U11), combined card charge (U12), IIF re-download refused when the frozen total
 * changed (U14), DR change after shipping (U15), exported invoice numbers never reused (U16), backfill
 * and next-number guards (U17, U44), small access items (U37, U39, U40, U42).
 * Runs against a RUNNING server and a LOCAL test database.
 */
const path = require('path');
const crypto = require('crypto');
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
async function call(method, url, body, headers) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN, extra = {}) => call(m, u, b, { Authorization: `Bearer ${t}`, ...extra });
const key = (m, u, k, b) => call(m, u, b, { 'X-API-Key': k });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R15' + Date.now().toString(36);
  const client = tag + ' Co';
  const clientId = (await api('POST', '/clients', { name: client })).body?.data?.id;
  const mkKey = async (fields = {}) => {
    const k = 'r15_' + crypto.randomBytes(8).toString('hex');
    const f = { name: tag + '-' + k.slice(-4), key: k, permissions: 'read_write', isActive: true, ...fields };
    const cols = Object.keys(f);
    await pg.query(`INSERT INTO api_keys (id, ${cols.map(c => `"${c}"`).join(',')}, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${cols.map((_, i) => '$' + (i + 1)).join(',')}, now(), now())`, Object.values(f));
    return k;
  };
  const dev = await mkKey({ deviceName: tag + '-tab' });
  const mkWo = async (extra = {}, name = client) => (await api('POST', '/workorders', { clientName: name, ...extra })).body?.data?.id;
  const priced = async (id, amt = 300) => { await api('POST', `/workorders/${id}/parts`, { partType: 'fab_service', quantity: 1, partTotal: amt, laborTotal: amt }); await sleep(250); return (await api('GET', `/workorders/${id}/invoice-totals`)).body?.data?.grandTotal; };

  console.log('\nTablet status buttons on finished orders (U2)');
  const S = await mkWo({ assignDRNumber: true });
  await priced(S);
  await pg.query(`UPDATE work_orders SET status = 'shipped', "pickedUpAt" = now() WHERE id = $1`, [S]);
  const ts = await key('PUT', `/workorders/${S}/status`, dev, { status: 'stored' });
  const tr = await key('PUT', `/workorders/${S}/status`, dev, { status: 'received' });
  check('a tablet can\'t move a shipped order back to Stored or Received', ts.status === 409 && tr.status === 409 && (await q(`SELECT status FROM work_orders WHERE id = $1`, [S]))[0].status === 'shipped', `${ts.status} ${tr.status}`);
  await pg.query(`UPDATE work_orders SET "iifExportedAt" = now() WHERE id = $1`, [S]);
  const cs = await api('PUT', `/workorders/${S}/status`, { status: 'stored' }, CLERK);
  check('…and once it is in QuickBooks, only an admin can (a clerk gets 409)', cs.status === 409, cs.status);
  await pg.query(`UPDATE work_orders SET "iifExportedAt" = NULL WHERE id = $1`, [S]);

  await api('PUT', `/workorders/${S}`, { status: 'processing' });   // the office reopens it (pickedUpAt stays)
  const reo = await key('PUT', `/workorders/${S}/status`, dev, { status: 'stored' });
  check('…but an order the office reopened can be moved on the tablet again', reo.status === 200, `${reo.status} ${JSON.stringify(reo.body).slice(0, 100)}`);

  console.log('\nRush lines don\'t block completion (U28)');
  const RW = await mkWo();
  await pg.query(`UPDATE work_orders SET status = 'waiting_for_materials' WHERE id = $1`, [RW]);
  const rp = (await api('POST', `/workorders/${RW}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"' })).body?.data?.id;
  await api('POST', `/workorders/${RW}/parts`, { partType: 'rush_service', quantity: 1, formData: { _expediteEnabled: true, _expediteType: '25' } });
  const pc = await key('PUT', `/workorders/${RW}/parts/${rp}`, dev, { status: 'completed' });
  await sleep(400);
  const mc = await key('POST', `/workorders/${RW}/mark-complete`, dev);
  const rushSt = (await q(`SELECT status FROM work_order_parts WHERE "workOrderId" = $1 AND "partType" = 'rush_service'`, [RW]))[0]?.status;
  check('an order waiting for materials with a rush line can be completed from the tablet', pc.status === 200 && mc.status === 200 && rushSt === 'completed', `${pc.status} ${mc.status} ${JSON.stringify(mc.body).slice(0, 120)} rush=${rushSt}`);

  console.log('\nCOD release on the server (U10)');
  const codClient = tag + ' COD';
  await api('POST', '/clients', { name: codClient, paymentTerms: 'COD' });
  const C = await mkWo({}, codClient);
  await priced(C);
  await api('POST', `/quickbooks/assign-invoice-number/${C}`);
  const pk = await api('POST', `/workorders/${C}/pickup`, { type: 'full', pickedUpBy: 'driver' }, CLERK);
  const tsh = await key('PUT', `/workorders/${C}/status`, dev, { status: 'shipped' });
  check('an unpaid COD order can\'t be picked up or set to shipped without payment or the override', pk.status === 409 && pk.body?.error?.code === 'COD_UNPAID' && tsh.status === 409, `${pk.status} ${tsh.status}`);
  await api('PUT', '/settings/cod_override_password', { value: 'cod-' + tag });
  // a fresh staff user: wrong-password attempts are limited per user, and earlier suites try wrong ones as clerk
  const offUser = ('r15off' + Date.now().toString(36)).slice(0, 20);
  await pg.query(`INSERT INTO users (id, username, password, role, "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'user', true, now(), now())`,
    [offUser, require(path.join(__dirname, '../../node_modules/bcryptjs')).hashSync(PASS, 8)]);
  const OFF = await login(offUser);
  const ov = await api('POST', `/workorders/${C}/cod-override`, { password: 'cod-' + tag, action: 'pickup' }, OFF);
  const tok = ov.body?.data?.codOverrideToken;
  const pk2 = await api('POST', `/workorders/${C}/pickup`, { type: 'full', pickedUpBy: 'driver', codOverrideToken: tok }, CLERK);
  check('…the override hands out a token that lets the pickup through', ov.status === 200 && !!tok && pk2.status === 200, `${ov.status} ${pk2.status} ${JSON.stringify(pk2.body).slice(0, 120)}`);
  const C2 = await mkWo({}, codClient);
  const c2t = await priced(C2);
  await api('POST', `/workorders/${C2}/record-payment`, { paymentMethod: 'check', amount: c2t });
  const pk3 = await api('POST', `/workorders/${C2}/pickup`, { type: 'full', pickedUpBy: 'driver' }, CLERK);
  check('…and a paid COD order is released normally; a forged token is refused', pk3.status === 200
    && (await api('POST', `/workorders/${C}/pickup`, { type: 'full', pickedUpBy: 'x', codOverrideToken: '9999999999999.abc' })).status !== 200, pk3.status);

  const Z = await mkWo({}, codClient);
  await api('POST', `/workorders/${Z}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 0.01, laborTotal: 0.01, formData: { _noCharge: true } });
  await pg.query(`UPDATE work_order_parts SET "partTotal" = 0, "laborTotal" = 0 WHERE "workOrderId" = $1`, [Z]);
  await api('POST', `/workorders/${Z}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"', partTotal: '0.00', laborTotal: '0.00' });
  const pkz = await api('POST', `/workorders/${Z}/pickup`, { type: 'full', pickedUpBy: 'driver' }, CLERK);
  check('a COD order with nothing priced still needs the override (not priced yet)', pkz.status === 409, pkz.status);

  console.log('\nOverpayment credit is tied to the payment (U3)');
  const O = await mkWo();
  const oPart = (await api('POST', `/workorders/${O}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 1000, laborTotal: 1000 })).body?.data?.id;
  await api('POST', `/quickbooks/assign-invoice-number/${O}`);
  await sleep(250);
  const oTot = (await api('GET', `/workorders/${O}/invoice-totals`)).body?.data?.grandTotal;
  const op = await api('POST', `/business/ledger/${O}/payments`, { amount: oTot, paymentMethod: 'check', paymentType: 'full' });
  await api('PUT', `/workorders/${O}/parts/${oPart}`, { partTotal: 800, laborTotal: 800 });
  await sleep(500);
  const mv = await api('POST', `/business/ledger/${O}/overpayment-to-credit`);
  const memoId = mv.body?.data?.id;
  const memoAmt = parseFloat(mv.body?.data?.amount);
  await api('PUT', `/workorders/${O}/parts/${oPart}`, { partTotal: 1000, laborTotal: 1000 });
  await sleep(600);
  const m1 = (await q(`SELECT amount, "remainingAmount", "voidedAt" FROM credit_memos WHERE id = $1`, [memoId]))[0];
  check('when the total goes back up, the unused credit memo is voided (no credit from nothing)', mv.status === 200 && memoAmt > 0 && m1 && !!m1.voidedAt, `${mv.status} ${memoAmt} ${JSON.stringify(m1)}`);
  // spent credit, then the payment is voided → the invoice owes it
  await api('PUT', `/workorders/${O}/parts/${oPart}`, { partTotal: 800, laborTotal: 800 });
  await sleep(500);
  const mv2 = await api('POST', `/business/ledger/${O}/overpayment-to-credit`);
  const O2 = await mkWo();
  await priced(O2, 500);
  await api('POST', `/quickbooks/assign-invoice-number/${O2}`);
  await api('POST', `/business/credit-memos/${mv2.body?.data?.id}/apply`, { workOrderId: O2, amount: mv2.body?.data?.amount });
  const payId = op.body?.data?.id;
  const vd = await api('DELETE', `/business/ledger/payments/${payId}`);
  const hist = (await api('GET', `/clients/${clientId}/history`)).body?.data;
  const oRow = (hist?.workOrders || []).find(w => w.id === O);
  const oNow = (await api('GET', `/workorders/${O}/invoice-totals`)).body?.data?.grandTotal;
  check('…and if the credit was already spent and the payment is voided, the invoice owes that credit back too', vd.status === 200 && oRow && near(oRow.balance, r2(oNow + parseFloat(mv2.body?.data?.amount))),
    `${vd.status} balance=${oRow && oRow.balance} total=${oNow} memo=${mv2.body?.data?.amount}`);

  console.log('\nDual pricing Option B (U4) and shipping in the estimate total (U11)');
  await api('PUT', '/settings/labor_minimums', { value: [{ partType: 'plate_roll', label: 'plate', sizeField: 'thickness', maxSize: 0.375, minimum: 125 }] });
  const E = (await api('POST', '/estimates', { clientName: client, taxRate: 9.5, showDualPricing: true })).body.data.id;
  await api('POST', `/estimates/${E}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"', laborTotal: '50.00', materialTotal: '200', materialMarkupPercent: 0, partTotal: '250.00', materialSource: 'we_order' });
  await api('POST', `/estimates/${E}/parts`, { partType: 'rush_service', quantity: 1, partTotal: '0', formData: { _expediteEnabled: true, _expediteType: '25' } });
  await api('PUT', `/estimates/${E}`, { opTransports: [{ id: 't1', cost: 50, markup: 20 }], showDualPricing: true });
  const est = (await api('GET', `/estimates/${E}`)).body?.data;
  const B = est?.optionB;
  check('Option B (labor only) keeps the labor minimum, rush and trips, and is below Option A', !!B && parseFloat(B.minimumAdjustment) > 0 && parseFloat(B.rushAmount) > 0 && near(B.tripsTotal, 60)
      && parseFloat(B.grandTotal) < parseFloat(est.grandTotal) && parseFloat(B.grandTotal) > 150,
    JSON.stringify(B) + ' A=' + (est && est.grandTotal));
  const E2 = (await api('POST', '/estimates', { clientName: client, taxRate: 9.5 })).body.data.id;
  await api('POST', `/estimates/${E2}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '500', laborTotal: '500' });
  await pg.query(`INSERT INTO shipment_charges (id, "estimateId", "carrierType", "shippingCost", "shippingMarkup", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'our_truck', 200, 0, now(), now())`, [E2]);
  await api('PUT', `/estimates/${E2}`, { truckingCost: 40 });
  const e2 = (await api('GET', `/estimates/${E2}`)).body?.data;
  const listed = ((await api('GET', `/estimates?search=${encodeURIComponent(client)}&limit=50`)).body?.data || []).find(x => x.id === E2);
  const addC = await api('POST', `/estimates/${E2}/shipment-charges`, { carrierType: 'our_truck', shippingCost: 50 });
  const e2b = (await q(`SELECT "grandTotal" FROM estimates WHERE id = $1`, [E2]))[0].grandTotal;
  check('adding a shipping charge updates the stored estimate total right away', addC.status === 200 && near(e2b, 500 * 1.095 + 250), `${addC.status} ${e2b}`);
  check('the stored estimate total includes the shipping charge (not the old trucking amount too)', near(e2.grandTotal, 500 * 1.095 + 200) && (!listed || near(listed.grandTotal, e2.grandTotal)), `${e2.grandTotal} list=${listed && listed.grandTotal}`);
  await pg.query(`DELETE FROM app_settings WHERE key = 'labor_minimums'`);

  console.log('\nReorder keeps one client (U5)');
  const beta = tag + ' Beta';
  const betaId = (await api('POST', '/clients', { name: beta })).body?.data?.id;
  const E3 = (await api('POST', '/estimates', { clientName: client, taxRate: 9.5 })).body.data.id;
  await api('POST', `/estimates/${E3}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '100', laborTotal: '100' });
  const W3 = (await api('POST', `/estimates/${E3}/convert-to-workorder`, { materialReceived: true })).body?.data?.workOrder?.id;
  await api('PUT', `/workorders/${W3}`, { clientName: beta });
  const re = await api('POST', `/workorders/${W3}/duplicate-to-estimate`);
  const reE = re.body?.data;
  check('a reorder after the order moved to another client is for that client — name and id', re.status === 201 && reE.clientName === beta && reE.clientId === betaId, `${re.status} ${reE && reE.clientName} ${reE && reE.clientId} ${betaId}`);

  console.log('\nTablets see no prices on shipments and deliveries (U7)');
  const P = await mkWo();
  await priced(P, 1234.56);
  await pg.query(`UPDATE work_orders SET "estimateTotal" = 999.99 WHERE id = $1`, [P]);
  const sh = await key('POST', '/shipments', dev, { clientName: client, description: tag + ' box', linkToWorkOrderId: P });
  const det = await key('GET', `/workorders/${P}`, dev);
  const txt = JSON.stringify(sh.body) + JSON.stringify(det.body);
  check('shipment create and order detail carry no totals for a tablet (grandTotal, estimateTotal, part costs)', sh.status === 201 && det.status === 200 && !/"grandTotal"|"estimateTotal"|"partTotal"|"otherServicesCost"/.test(txt), `${sh.status} ${det.status} ${txt.match(/"(grandTotal|estimateTotal|partTotal|otherServicesCost)"/)}`);

  console.log('\nAccess (U9, U37, U39, U40)');
  const s2 = await api('POST', '/auth/2fa/setup', {}, CLERK);
  const s3 = await api('POST', '/auth/2fa/setup', { password: 'wrong' }, CLERK);   // 403 (not 401, which signs the web user out)
  check('2FA setup needs the password', s2.status === 400 && s3.status === 403, `${s2.status} ${s3.status}`);
  const head = await fetch(BASE + '/business/employees', { method: 'HEAD', headers: { Authorization: `Bearer ${CLERK}` } });
  check('HEAD on an admin-only list is refused like GET', head.status === 403, head.status);
  const arr = await fetch(BASE + `/workorders?apikey[]=nope&apikey[]=${dev}`);
  check('?apikey must be a single string', arr.status === 401, arr.status);
  const ovc = await api('POST', `/business/ledger/${O}/overpayment-to-credit`, null, CLERK);
  check('moving an overpayment to credit is admin-only', ovc.status === 403, ovc.status);

  console.log('\nNumbers (U14, U15, U16, U17, U42, U44)');
  const F = await mkWo();
  await priced(F, 1000);
  await api('POST', `/quickbooks/assign-invoice-number/${F}`);
  await api('POST', '/quickbooks/mark-entered', { workOrderIds: [F] });
  await pg.query(`UPDATE clients SET "taxStatus" = 'resale' WHERE id = $1`, [clientId]);
  const rx = await api('GET', `/quickbooks/export/${F}?reexport=1`);
  check('re-downloading an exported invoice whose total changed since is refused, not rebuilt at today\'s prices', rx.status === 409 && rx.body?.error?.code === 'FROZEN_TOTAL_CHANGED', `${rx.status} ${JSON.stringify(rx.body).slice(0, 120)}`);
  await pg.query(`UPDATE clients SET "taxStatus" = NULL WHERE id = $1`, [clientId]);
  const D = (await api('POST', '/workorders', { clientName: client, assignDRNumber: true })).body?.data;
  await pg.query(`UPDATE work_orders SET status = 'shipped', "shippedAt" = now() WHERE id = $1`, [D.id]);
  const dc = await api('PUT', `/workorders/${D.id}/dr-number`, { drNumber: Number(D.drNumber) + 7 }, CLERK);
  check('a shipped order\'s DR number can\'t be changed (its lots are on the paperwork)', dc.status === 409, `${dc.status} ${JSON.stringify(dc.body).slice(0, 100)}`);
  const X = await mkWo();
  await priced(X, 50);
  const xa = await api('POST', `/quickbooks/assign-invoice-number/${X}`);
  const xNum = String(xa.body?.data?.invoiceNumber || (await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [X]))[0].invoiceNumber);
  await api('POST', '/quickbooks/mark-entered', { workOrderIds: [X] });
  await api('POST', '/quickbooks/unmark-entered', { workOrderIds: [X] });
  const delInv = await api('DELETE', `/workorders/${X}/invoice`, { overrideCode: process.env.DELETE_OVERRIDE_CODE });
  const Y = await mkWo();
  await priced(Y, 50);
  await api('POST', `/quickbooks/assign-invoice-number/${Y}`);
  const yNum = (await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [Y]))[0].invoiceNumber;
  check('a number that was entered in QuickBooks is never handed out again after the invoice is cleared', delInv.status === 200 && yNum && yNum !== xNum, `deleted=${delInv.status} x=${xNum} y=${yNum}`);
  const bf = await api('POST', '/quickbooks/invoice-numbers/backfill', {}, CLERK);
  const nx = await api('PUT', '/quickbooks/next-invoice-number', { nextNumber: 5 }, CLERK);
  check('the invoice backfill and next-number routes are admin-only', bf.status === 403 && nx.status === 403, `${bf.status} ${nx.status}`);
  const before = (await q(`SELECT value FROM app_settings WHERE key = 'next_dr_number'`))[0]?.value;
  const hi = Math.max(...(await q(`SELECT COALESCE(MAX("drNumber"),0) m FROM dr_numbers UNION ALL SELECT COALESCE(MAX("drNumber"),0) FROM work_orders`)).map(r => Number(r.m)));
  const dn = await api('PUT', '/dr-numbers/next', { nextNumber: String(hi + 5) });
  const stored = (await q(`SELECT value FROM app_settings WHERE key = 'next_dr_number'`))[0]?.value;
  check('the next DR number is stored as a number, not text', dn.status === 200 && typeof stored.nextNumber === 'number', `${dn.status} ${JSON.stringify(stored)}`);
  if (before) await pg.query(`UPDATE app_settings SET value = $1 WHERE key = 'next_dr_number'`, [JSON.stringify(before)]);

  console.log('\nCard charge for several invoices (U12)');
  const K1 = await mkWo(), K2 = await mkWo();
  const k1 = await priced(K1, 400), k2 = await priced(K2, 250);
  await api('POST', `/quickbooks/assign-invoice-number/${K1}`); await api('POST', `/quickbooks/assign-invoice-number/${K2}`);
  const gross = r2((k1 + k2 + 0.15) / (1 - 0.026));
  const tp = await api('POST', '/business/client-payments', { clientId, clientName: client, amount: gross, method: 'credit_card', ccProcessingType: 'in_person', applications: [{ workOrderId: K1, amount: k1 }, { workOrderId: K2, amount: k2 }] });
  check('one card charge worked out on the combined amount is a surcharge, not client credit', tp.status === 200 && !tp.body?.data?.creditMemo && near(tp.body?.data?.payment?.cardSurcharge, gross - k1 - k2), `${tp.status} ${JSON.stringify(tp.body).slice(0, 160)}`);

  console.log(`\nround15: ${pass} passed, ${fail} failed`);
  await pg.query(`DELETE FROM api_keys WHERE name LIKE $1`, [tag + '%']);
  await pg.query(`DELETE FROM app_settings WHERE key = 'cod_override_password'`);
  await pg.query(`UPDATE users SET "isActive" = false WHERE username LIKE 'r15off%'`);
  await pg.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
