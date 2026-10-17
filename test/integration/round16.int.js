/**
 * Round 16 checks (fifth independent audit, V-series): refunds tied to the overpaid invoice / credit memo
 * (V1), estimate discount cleared or switched (V2), COD decided by the ledger once priced (V3), general
 * ledger shipping (V4), approved-IP list for every tablet key (V5), lot numbers never repeat in an order
 * (V6), DR change after a partial pickup (V7), next invoice number honoured (V8), Undo after a client
 * merge (V11), tablet "Mark as Shipped" and archive check COD (V14, V22), Stored completes rush lines
 * (V32), linking onto an invoiced order refused (V24), password attempts limited (V21).
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
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN) => call(m, u, b, { Authorization: `Bearer ${t}` });
const key = (m, u, k, b) => call(m, u, b, { 'X-API-Key': k });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R16' + Date.now().toString(36);
  const client = tag + ' Co';
  const clientId = (await api('POST', '/clients', { name: client })).body?.data?.id;
  const mkKey = async (fields = {}) => {
    const k = 'r16_' + crypto.randomBytes(8).toString('hex');
    const f = { name: tag + '-' + k.slice(-4), key: k, permissions: 'read_write', isActive: true, ...fields };
    const cols = Object.keys(f);
    await pg.query(`INSERT INTO api_keys (id, ${cols.map(c => `"${c}"`).join(',')}, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${cols.map((_, i) => '$' + (i + 1)).join(',')}, now(), now())`, Object.values(f));
    return k;
  };
  const dev = await mkKey({ deviceName: tag + '-tab' });
  const mkWo = async (extra = {}, name = client) => (await api('POST', '/workorders', { clientName: name, ...extra })).body?.data?.id;
  const totalOf = async (id) => { await sleep(250); return (await api('GET', `/workorders/${id}/invoice-totals`)).body?.data?.grandTotal; };
  const history = async () => (await api('GET', `/clients/${clientId}/history`)).body?.data;

  console.log('\nRefunds settle the overpayment (V1)');
  const O = await mkWo();
  const op = (await api('POST', `/workorders/${O}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 300, laborTotal: 300 })).body?.data?.id;
  await api('POST', `/quickbooks/assign-invoice-number/${O}`);
  const t0 = await totalOf(O);
  const pay = await api('POST', `/business/ledger/${O}/payments`, { amount: t0, paymentMethod: 'check', paymentType: 'full' });
  await api('PUT', `/workorders/${O}/parts/${op}`, { partTotal: 200, laborTotal: 200 });
  const t1 = await totalOf(O);
  const over = Math.round((t0 - t1) * 100) / 100;
  const tooMuch = await api('POST', '/business/refunds', { sourceWorkOrderId: O, amount: over + 10, method: 'check' });
  const rf = await api('POST', '/business/refunds', { sourceWorkOrderId: O, amount: over, method: 'check' });
  const h1 = await history();
  const again = await api('POST', `/business/ledger/${O}/overpayment-to-credit`);
  check('refunding an invoice\'s overpayment settles it: no longer overpaid, can\'t be moved to credit again, a bigger refund is refused',
    pay.status === 200 && tooMuch.status === 400 && rf.status === 200 && near((h1.workOrders || []).find(w => w.id === O)?.overpaid, 0) && again.status === 409,
    `${tooMuch.status} ${rf.status} ${again.status} over=${over}`);
  const vr = await api('DELETE', `/business/refunds/${rf.body?.data?.id}`);
  const h2 = await history();
  check('…voiding that refund shows the overpayment again', vr.status === 200 && near((h2.workOrders || []).find(w => w.id === O)?.overpaid, over), JSON.stringify((h2.workOrders || []).find(w => w.id === O)?.overpaid));
  const mv = await api('POST', `/business/ledger/${O}/overpayment-to-credit`);
  const memoId = mv.body?.data?.id;
  const rm = await api('POST', '/business/refunds', { creditMemoId: memoId, amount: over, method: 'check' });
  const memo = (await q(`SELECT amount, "remainingAmount", "voidedAt" FROM credit_memos WHERE id = $1`, [memoId]))[0];
  const h3 = await history();
  check('…refunding the credit memo uses it up and the invoice stays settled', mv.status === 200 && rm.status === 200 && !!memo.voidedAt && near((h3.workOrders || []).find(w => w.id === O)?.overpaid, 0)
      && (await api('POST', `/business/ledger/${O}/overpayment-to-credit`)).status === 409, `${mv.status} ${rm.status} ${JSON.stringify(memo)}`);

  const M = (await api('POST', '/business/credit-memos', { clientId, clientName: client, amount: 100, reason: 'manual' })).body?.data;
  const rM = await api('POST', '/business/refunds', { creditMemoId: M?.id, amount: 100, method: 'check' });
  const vM = await api('DELETE', `/business/refunds/${rM.body?.data?.id}`);
  const mAfter = (await q(`SELECT amount, "remainingAmount", "voidedAt" FROM credit_memos WHERE id = $1`, [M?.id]))[0];
  check('…voiding a refund taken from a credit memo puts the credit back on the memo', rM.status === 200 && vM.status === 200 && mAfter && !mAfter.voidedAt && near(mAfter.remainingAmount, 100), `${rM.status} ${vM.status} ${JSON.stringify(mAfter)}`);
  const plain = await api('POST', '/business/refunds', { clientId, clientName: client, amount: 5, method: 'check' });
  const plain2 = await api('POST', '/business/refunds', { clientId, clientName: client, amount: 5, method: 'check', unlinked: true });
  check('…a refund tied to nothing, for a client with open credit, asks first (and goes through when confirmed)', plain.status === 400 && plain.body?.error?.code === 'CLIENT_HAS_CREDIT' && plain2.status === 200, `${plain.status} ${plain2.status}`);

  console.log('\nEstimate discount can be cleared or switched (V2)');
  const E = (await api('POST', '/estimates', { clientName: client, taxRate: 10 })).body.data.id;
  await api('POST', `/estimates/${E}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '600', laborTotal: '600' });
  await api('PUT', `/estimates/${E}`, { discountPercent: 7.5 });
  const sw = await api('PUT', `/estimates/${E}`, { discountPercent: '', discountAmount: '50' });
  const e1 = (await q(`SELECT "discountPercent", "discountAmount", "grandTotal", "taxRate" FROM estimates WHERE id = $1`, [E]))[0];
  const tr = 1 + (parseFloat(e1.taxRate) || 0) / 100;
  await api('PUT', `/estimates/${E}`, { discountPercent: null, discountAmount: null });
  const e2 = (await q(`SELECT "discountPercent", "discountAmount", "grandTotal" FROM estimates WHERE id = $1`, [E]))[0];
  check('switching % to $ keeps only the $ discount, and clearing it removes it', sw.status === 200 && !(parseFloat(e1.discountPercent) > 0) && near(e1.discountAmount, 50) && near(e1.grandTotal, Math.round(550 * tr * 100) / 100)
      && !(parseFloat(e2.discountAmount) > 0) && near(e2.grandTotal, Math.round(600 * tr * 100) / 100), `${JSON.stringify(e1)} ${JSON.stringify(e2)}`);

  console.log('\nCOD decided by the ledger (V3, V14, V22)');
  const codClient = tag + ' COD';
  await api('POST', '/clients', { name: codClient, paymentTerms: 'COD' });
  const C = await mkWo({}, codClient);
  const dep = await api('POST', `/workorders/${C}/record-payment`, { paymentMethod: 'cash', amount: 1 });
  await api('POST', `/workorders/${C}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 500, laborTotal: 500 });
  await sleep(300);
  const sh = await key('PUT', `/workorders/${C}/status`, dev, { status: 'shipped' });
  const ar = await key('PUT', `/workorders/${C}/status`, dev, { status: 'archived' });
  const ar2 = await api('POST', `/workorders/${C}/archive`, {});
  check('a $1 deposit before pricing doesn\'t release the COD order once it is priced (ship or archive)', dep.status === 200 && sh.status === 409 && ar.status === 409 && ar2.status === 409, `${dep.status} ${sh.status} ${ar.status} ${ar2.status}`);
  const C2 = await mkWo({}, codClient);
  await api('POST', `/workorders/${C2}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 100, laborTotal: 100 });
  const c2t = await totalOf(C2);
  const rp = await api('POST', `/workorders/${C2}/record-payment`, { paymentMethod: 'check', amount: c2t });
  const wpId = (await q(`SELECT id FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [C2]))[0]?.id;
  await api('DELETE', `/business/ledger/payments/${wpId}`);
  const sh2 = await key('PUT', `/workorders/${C2}/status`, dev, { status: 'shipped' });
  const flag = (await q(`SELECT "codPaid" FROM work_orders WHERE id = $1`, [C2]))[0].codPaid;
  check('a COD payment voided later: the "paid" mark goes and the order is held again', rp.status === 200 && sh2.status === 409 && !flag, `${rp.status} ${sh2.status} codPaid=${flag}`);
  const shp = (await key('POST', '/shipments', dev, { clientName: codClient, description: tag + ' box', linkToWorkOrderId: C })).body?.data;
  const shpId = shp?.shipment?.id || shp?.id;
  const ms = await key('PUT', `/shipments/${shpId}`, dev, { status: 'shipped' });
  check('the tablet\'s "Mark as Shipped" on a shipment of an unpaid COD order is refused', !!shpId && ms.status === 409, `${shpId} ${ms.status}`);

  console.log('\nGeneral ledger shipping (V4)');
  const Eq = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${Eq}/shipment-charges`, { carrierType: 'contracted', shippingCost: 77.77 });
  const gl = (await api('GET', '/business/general-ledger?startDate=2020-01-01&endDate=2020-01-31')).body?.data;
  const glNow = (await api('GET', '/business/general-ledger')).body?.data;
  const rows = (x) => (x?.entries || x || []).filter ? (x?.entries || x || []).filter(e => e.source === 'shipment_charge') : [];
  check('quote shipping charges aren\'t expenses, and a past period shows none from today', rows(gl).length === 0 && !rows(glNow).some(e => near(e.debit, 77.77)), `${rows(gl).length} ${rows(glNow).length}`);

  console.log('\nApproved-IP list covers every tablet key (V5)');
  const opOnly = await mkKey({ operatorName: tag + ' op' });
  const prevIps = (await q(`SELECT value FROM app_settings WHERE key = 'approved_ips'`))[0];
  await pg.query(`INSERT INTO app_settings (id, key, value, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'approved_ips', '{"ips":["10.9.9.9"]}', now(), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`).catch(async () => {
    await pg.query(`DELETE FROM app_settings WHERE key = 'approved_ips'`);
    await pg.query(`INSERT INTO app_settings (id, key, value, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'approved_ips', '{"ips":["10.9.9.9"]}', now(), now())`);
  });
  const ipr = await key('GET', '/workorders?limit=1', opOnly);
  await pg.query(`DELETE FROM app_settings WHERE key = 'approved_ips'`);
  if (prevIps) await pg.query(`INSERT INTO app_settings (id, key, value, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'approved_ips', $1, now(), now())`, [JSON.stringify(prevIps.value)]);
  check('a tablet key with only an operator name is held to the approved-IP list', ipr.status === 403, ipr.status);

  console.log('\nLot numbers and DR changes (V6, V7)');
  const L = (await api('POST', '/workorders', { clientName: client, assignDRNumber: true })).body?.data;
  const pA = (await api('POST', `/workorders/${L.id}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"' })).body?.data?.id;
  await api('POST', `/workorders/${L.id}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"' });
  await api('DELETE', `/workorders/${L.id}/parts/${pA}`);
  await api('POST', `/workorders/${L.id}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"' });
  const lots = (await q(`SELECT "lotNumber" FROM work_order_parts WHERE "workOrderId" = $1`, [L.id])).map(r => r.lotNumber);
  check('after deleting a line, a new part never repeats a lot already on the order', lots.length === 2 && new Set(lots).size === 2, JSON.stringify(lots));
  const pk = await api('POST', `/workorders/${L.id}/pickup`, { type: 'partial', pickedUpBy: 'driver', items: [{ partId: (await q(`SELECT id FROM work_order_parts WHERE "workOrderId" = $1 LIMIT 1`, [L.id]))[0].id, quantity: 1 }] });
  const dc = await api('PUT', `/workorders/${L.id}/dr-number`, { drNumber: Number(L.drNumber) + 9 });
  check('after a partial pickup the DR number can\'t be changed', pk.status === 200 && dc.status === 409, `${pk.status} ${dc.status}`);

  console.log('\nNext invoice number (V8)');
  const hi = Number((await q(`SELECT COALESCE(MAX("invoiceNumber"),0) m FROM invoice_numbers`))[0].m);
  const prevNext = (await q(`SELECT value FROM app_settings WHERE key = 'next_invoice_number'`))[0];
  const setN = await api('PUT', '/quickbooks/next-invoice-number', { nextNumber: hi + 40 });
  const N = await mkWo();
  await api('POST', `/workorders/${N}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 10, laborTotal: 10 });
  await api('POST', `/quickbooks/assign-invoice-number/${N}`);
  const nNum = Number((await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [N]))[0].invoiceNumber);
  check('a "next invoice number" set ahead of the highest is used', setN.status === 200 && nNum === hi + 40, `${setN.status} hi=${hi} got=${nNum}`);
  if (prevNext) await pg.query(`UPDATE app_settings SET value = $1 WHERE key = 'next_invoice_number'`, [JSON.stringify(prevNext.value)]);

  console.log('\nUndo after a client merge (V11)');
  const dup = tag + ' Dup';
  const dupId = (await api('POST', '/clients', { name: dup })).body?.data?.id;
  const U = await mkWo({}, dup);
  await api('DELETE', `/workorders/${U}`);
  await api('POST', `/clients/${clientId}/merge`, { sourceId: dupId });
  const arch = (await q(`SELECT id FROM deletion_archive WHERE "tableName" = 'work_orders' AND "recordId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [U]))[0];
  const un = arch ? await api('POST', `/deletion-archive/${arch.id}/undo`) : { status: 0 };
  const back = (await q(`SELECT "clientId", "clientName" FROM work_orders WHERE id = $1`, [U]))[0];
  check('a deleted order comes back under the client it was merged into', un.status === 200 && back && back.clientId === clientId && back.clientName === client, `${un.status} ${JSON.stringify(back)} ${JSON.stringify(un.body).slice(0, 120)}`);

  console.log('\nTablet Stored completes rush lines (V32); link onto an invoiced order (V24)');
  const R = await mkWo();
  await api('POST', `/workorders/${R}/parts`, { partType: 'rush_service', quantity: 1, formData: { _expediteEnabled: true, _expediteType: '25' } });
  const st = await key('PUT', `/workorders/${R}/status`, dev, { status: 'stored' });
  const rs = (await q(`SELECT status FROM work_order_parts WHERE "workOrderId" = $1 AND "partType" = 'rush_service'`, [R]))[0]?.status;
  check('setting Stored on the tablet completes the rush line', st.status === 200 && rs === 'completed', `${st.status} ${rs}`);
  const I = await mkWo();
  await api('POST', `/workorders/${I}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 10, laborTotal: 10 });
  await api('POST', `/quickbooks/assign-invoice-number/${I}`);
  const El = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${El}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '5', laborTotal: '5' });
  const lk = await api('POST', `/workorders/${I}/link-estimate`, { estimateId: El });
  check('linking an estimate onto an invoiced order is refused (409, not 500)', lk.status === 409, lk.status);

  console.log('\nPassword attempts (V21)');
  const u = ('r16pw' + Date.now().toString(36)).slice(0, 20);
  await pg.query(`INSERT INTO users (id, username, password, role, "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'user', true, now(), now())`,
    [u, require(path.join(__dirname, '../../node_modules/bcryptjs')).hashSync(PASS, 8)]);
  const UT = await login(u);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await api('POST', '/auth/2fa/setup', { password: 'wrong' + i }, UT)).status);
  check('wrong passwords on 2FA setup are limited (403 then 429)', codes[0] === 403 && codes[codes.length - 1] === 429, codes.join(','));
  await pg.query(`UPDATE users SET "isActive" = false WHERE username = $1`, [u]);

  console.log(`\nround16: ${pass} passed, ${fail} failed`);
  await pg.query(`DELETE FROM api_keys WHERE name LIKE $1`, [tag + '%']);
  await pg.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
