/**
 * Round 12 checks: one admin-only list (N10), settings allowlist + Gmail OAuth state (R25), device keys
 * read only what the app uses (N16), DR / PO / invoice-number side doors (N14, N15, N12), COD on unpriced
 * orders (N13, see round10), Idempotency-Key (N19, N23), safe server-side rendering (N9), /health and
 * /uploads (N22, N24), password change signs out other sessions (R34), vendor merge rewrites JSONB ids (R20).
 * Runs against a RUNNING server and a LOCAL test database.
 */
const path = require('path');
const crypto = require('crypto');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const ROOT = BASE.replace(/\/api\/?$/, '');
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (u, p = PASS) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).data?.token;
let TOKEN;
async function call(method, url, body, headers) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN, extra = {}) => call(m, u, b, { Authorization: `Bearer ${t}`, ...extra });
const key = (m, u, k, b, extra = {}) => call(m, u, b, { 'X-API-Key': k, ...extra });

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R12' + Date.now().toString(36);
  const client = tag + ' Co';
  await api('POST', '/clients', { name: client });
  const mkKey = async (fields) => {
    const k = 'r12_' + crypto.randomBytes(8).toString('hex');
    const f = { name: tag + '-' + k.slice(-4), key: k, permissions: 'read', isActive: true, ...fields };
    const cols = Object.keys(f);
    await pg.query(`INSERT INTO api_keys (id, ${cols.map(c => `"${c}"`).join(',')}, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${cols.map((_, i) => '$' + (i + 1)).join(',')}, now(), now())`, Object.values(f));
    return k;
  };
  const mkWO = async (total = 1000) => {
    const id = (await api('POST', '/workorders', { clientName: client })).body.data.id;
    if (total) await api('POST', `/workorders/${id}/parts`, { partType: 'fab_service', quantity: 1, partTotal: total, laborTotal: total });
    return id;
  };

  console.log('\nAdmin-only actions, from one list (N10, R25)');
  const clerkCalls = [
    ['GET', '/business/employees'], ['GET', '/business/payroll'], ['GET', '/business/liabilities'], ['GET', '/business/general-ledger'],
    ['POST', '/business/credit-memos', { clientId: crypto.randomUUID(), amount: 5 }], ['POST', '/business/refunds', { amount: 5 }],
    ['DELETE', `/business/ledger/payments/${crypto.randomUUID()}`], ['POST', `/business/client-payments/${crypto.randomUUID()}/void`, {}],
    ['PUT', '/settings/notification-email', { email: 'x@example.com' }], ['PUT', '/settings/schedule-email', { email: 'x@example.com' }],
    ['GET', '/email-scanner/oauth/start'], ['PUT', '/email-scanner/general-notes', { notes: 'x' }],
    ['POST', `/vendors/${crypto.randomUUID()}/merge`, { sourceId: crypto.randomUUID() }],
  ];
  const res = await Promise.all(clerkCalls.map(([m, u, b]) => api(m, u, b, CLERK)));
  const open = clerkCalls.filter((c, i) => res[i].status !== 403).map((c, i) => `${c[0]} ${c[1]}`);
  const bill = await api('PATCH', `/com-center/bills/${crypto.randomUUID()}/status`, { status: 'approved' }, CLERK);
  check('approving a scanned bill into Accounts Payable is admin-only too', bill.status === 403, bill.status);
    check('a non-admin is refused on payroll, bills, money corrections, e-mail addresses, scanner mailboxes and merges', !open.length, open.join(', '));
  const adm = await Promise.all([api('GET', '/business/employees'), api('PUT', '/settings/notification-email', { email: 'shop@example.com' })]);
  check('…an admin still can', adm.every(r => r.status === 200), adm.map(r => r.status).join(' '));
  const cl = await Promise.all([api('GET', `/business/ledger`, null, CLERK), api('GET', '/business/client-payments', null, CLERK)]);
  check('…and ordinary AR work stays open to everyone', cl.every(r => r.status === 200), cl.map(r => r.status).join(' '));
  const DK = await mkKey({ deviceName: 'Tab ' + tag, operatorName: 'Op', permissions: 'read_write' });
  const EK = await mkKey({ deviceName: 'Est ' + tag, operatorName: 'Est', permissions: 'read_write', isEstimator: true });
  const dn = await key('PUT', '/settings/notification-email', DK, { email: 'evil@example.com' });
  const en = await key('PUT', '/settings/notification-email', EK, { email: 'shop@example.com' });
  check('a shop tablet can\'t redirect the new-shipment e-mails; the estimator\'s device can', dn.status === 403 && en.status === 200, `${dn.status} ${en.status}`);
  const oc = await call('GET', '/email-scanner/oauth/callback?code=abc');
  const oc2 = await call('GET', '/email-scanner/oauth/callback?code=abc&state=forged');
  check('the Gmail connect callback refuses a missing or forged state', oc.status === 302 && /error=/.test(oc.headers.get('location') || '') && oc2.status === 302 && /error=/.test(oc2.headers.get('location') || ''), `${oc.status} ${oc.headers.get('location')}`);

  console.log('\nDevice keys read only what the app uses (N16)');
  const reads = await Promise.all(['/estimates', '/settings/tax_settings', '/settings/labor_minimums', '/operations/production', '/estimates/unsent-drafts'].map(u => key('GET', u, DK)));
  check('a tablet can\'t read estimates, pricing/tax settings or production reports', reads.every(r => r.status === 403), reads.map(r => r.status).join(' '));
  const ok = await Promise.all(['/workorders?limit=5', '/shipments', '/operations/my-queue', '/settings/locations', '/settings/printer-config', '/devices/capabilities'].map(u => key('GET', u, DK)));
  check('…but still everything the app calls', ok.every(r => r.status === 200), ok.map(r => r.status).join(' '));
  const money = await Promise.all(['/workorders/invoicing/queue', `/workorders/${crypto.randomUUID()}/invoice-totals`].map(u => key('GET', u, DK)));
  check('…nor the invoicing screens and invoice totals inside work orders', money.every(r => r.status === 403), money.map(r => r.status).join(' '));
  const qd = await key('GET', '/estimates/unsent-drafts', EK);
  check('…and the estimator\'s device still sees its Quotes tab', qd.status === 200, qd.status);

  console.log('\nDR side doors (N14)');
  const V = await mkWO(500);
  const drn = 600000 + Math.floor(Math.random() * 9999);
  await pg.query(`UPDATE work_orders SET "drNumber" = $1 WHERE id = $2`, [drn, V]);
  await pg.query(`INSERT INTO dr_numbers (id, "drNumber", "workOrderId", status, "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'active', $3, now(), now())`, [drn, V, client]);
  await api('POST', `/quickbooks/assign-invoice-number/${V}`);
  const cv = await api('PUT', `/workorders/${V}`, { isVoided: true, voidReason: 'test' }, CLERK);
  check('voiding an invoiced order through the order edit is admin-only (as in the DR tools)', cv.status === 403, cv.status);
  const owed = (await api('GET', `/workorders/${V}/invoice-totals`)).body.data.amount;
  await api('POST', `/business/ledger/${V}/payments`, { amount: Math.min(10, owed), paymentMethod: 'check', paymentType: 'partial' });
  const av = await api('PUT', `/workorders/${V}`, { isVoided: true, voidReason: 'test' });
  check('…and refused with payments recorded, even for an admin', av.status === 409, av.status);
  const V2 = await mkWO(0);
  const drn2 = drn + 1;
  await pg.query(`UPDATE work_orders SET "drNumber" = $1 WHERE id = $2`, [drn2, V2]);
  await pg.query(`INSERT INTO dr_numbers (id, "drNumber", "workOrderId", status, "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'active', $3, now(), now())`, [drn2, V2, client]);
  const v2 = await api('PUT', `/workorders/${V2}`, { isVoided: true, voidReason: 'dup' }, CLERK);
  const log1 = (await q(`SELECT status FROM dr_numbers WHERE "drNumber" = $1`, [drn2]))[0];
  const r2c = await api('PUT', `/workorders/${V2}`, { isVoided: false }, CLERK);
  const r2a = await api('PUT', `/workorders/${V2}`, { isVoided: false });
  const log2 = (await q(`SELECT status FROM dr_numbers WHERE "drNumber" = $1`, [drn2]))[0];
  check('void / restore keep the DR log in step; restoring is admin-only', v2.status === 200 && log1.status === 'void' && r2c.status === 403 && r2a.status === 200 && log2.status === 'active', `${v2.status} ${log1.status} ${r2c.status} ${r2a.status} ${log2.status}`);
  await api('PUT', `/workorders/${V2}`, { isVoided: true, voidReason: 'again' });
  const uv = await api('POST', `/dr-numbers/${drn2}/unvoid`, {}, CLERK);
  check('/dr-numbers/:n/unvoid is admin-only', uv.status === 403, uv.status);
  const high = Number((await q(`SELECT GREATEST(COALESCE((SELECT MAX("drNumber") FROM dr_numbers),0), COALESCE((SELECT MAX("drNumber") FROM work_orders),0)) AS m`))[0].m);
  const far = await api('POST', '/workorders', { clientName: client, assignDRNumber: true, customDRNumber: high + 5000 });
  check('a custom DR far past the sequence is refused when creating an order', far.status === 400 && /past the highest/.test(far.body?.error?.message || ''), `${far.status} ${far.body?.error?.message}`);

  console.log('\nPO and invoice-number side doors (N15, N12)');
  const po = await api('POST', '/po-numbers/assign', { supplier: tag + ' Steel' });
  const poNum = po.body?.data?.poNumber;
  const rc = await api('PUT', `/po-numbers/${poNum}/reassign`, { newPoNumber: poNum + 3 }, CLERK);
  const rf = await api('PUT', `/po-numbers/${poNum}/reassign`, { newPoNumber: poNum + 50000 });
  check('changing a PO number is admin-only and can\'t jump the sequence', !!poNum && rc.status === 403 && rf.status === 400, `${poNum} ${rc.status} ${rf.status}`);
  const poSvc = require('../../src/services/poNumbers');
  const lockId = crypto.randomUUID();
  const both = await Promise.allSettled([poSvc.withOrderPOLock(lockId, () => sleep(800).then(() => 'first')), sleep(150).then(() => poSvc.withOrderPOLock(lockId, async () => 'second'))]);
  check('only one trucking / outside-processing PO is made at a time per order (a second click gets 409)', both[0].status === 'fulfilled' && both[1].status === 'rejected' && both[1].reason.status === 409, JSON.stringify(both.map(b => b.status)));
  const afterLock = await poSvc.withOrderPOLock(lockId, async () => 'free again');
  check('…and the claim is released afterwards', afterLock === 'free again', afterLock);
  const M = await mkWO(700);
  await api('POST', `/quickbooks/assign-invoice-number/${M}`);
  await api('POST', '/quickbooks/mark-entered', { workOrderIds: [M] });
  const frozen = (await q(`SELECT "grandTotal" FROM work_orders WHERE id = $1`, [M]))[0].grandTotal;
  await pg.query(`UPDATE clients SET "taxStatus" = 'resale' WHERE name = $1`, [client]);
  const again = await api('POST', '/quickbooks/mark-entered', { workOrderIds: [M] });
  const after = (await q(`SELECT "grandTotal" FROM work_orders WHERE id = $1`, [M]))[0].grandTotal;
  await pg.query(`UPDATE clients SET "taxStatus" = NULL WHERE name = $1`, [client]);
  const invLog = (await q(`SELECT i."iifExportedAt" FROM invoice_numbers i JOIN work_orders w ON w."invoiceNumber" = i."invoiceNumber"::text WHERE w.id = $1`, [M]))[0];
  check('marking an entered invoice again doesn\'t re-freeze its total; the number log is marked too', again.status === 200 && again.body.data.marked === 0 && String(frozen) === String(after) && !!invLog?.iifExportedAt, `${again.body?.data?.marked} ${frozen}→${after} ${invLog?.iifExportedAt}`);
  const hiInv = Number((await q(`SELECT COALESCE(MAX("invoiceNumber"),0) m FROM invoice_numbers`))[0].m);
  const J = await mkWO(100);
  const jump = await api('POST', `/workorders/${J}/invoice`, { invoiceNumber: String(hiInv + 50000) });
  check('a typed invoice number far past the sequence is refused (typo guard)', jump.status === 409 && /past the highest/.test(jump.body?.error?.message || ''), `${jump.status} ${jump.body?.error?.message}`);

  console.log('\nIdempotency-Key (N19, N23)');
  const P = await mkWO(400);
  const ik = 'test-' + crypto.randomUUID();
  const p1 = await api('POST', `/business/ledger/${P}/payments`, { amount: 100, paymentMethod: 'check', paymentType: 'partial' }, TOKEN, { 'Idempotency-Key': ik });
  const p2 = await api('POST', `/business/ledger/${P}/payments`, { amount: 100, paymentMethod: 'check', paymentType: 'partial' }, TOKEN, { 'Idempotency-Key': ik });
  const np = (await q(`SELECT COUNT(*)::int n FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [P]))[0].n;
  check('a payment sent twice with the same key is recorded once (the retry gets the first answer)', p1.status < 300 && p2.status === p1.status && p2.headers.get('idempotent-replay') === 'true' && np === 1, `${p1.status} ${p2.status} ${p2.headers.get('idempotent-replay')} ${np}`);
  const p3 = await api('POST', `/business/ledger/${P}/payments`, { amount: 50, paymentMethod: 'check', paymentType: 'partial' }, CLERK, { 'Idempotency-Key': ik });
  check('…keys are per person (another user\'s same key is a different request)', p3.status < 300, p3.status);
  const sk = 'ship-' + crypto.randomUUID();
  const s1 = await key('POST', '/shipments', DK, { clientName: client, description: 'idem test', quantity: 1 }, { 'Idempotency-Key': sk });
  const s2 = await key('POST', '/shipments', DK, { clientName: client, description: 'idem test', quantity: 1 }, { 'Idempotency-Key': sk });
  const ns = (await q(`SELECT COUNT(*)::int n FROM shipments WHERE "clientName" = $1 AND description = 'idem test'`, [client]))[0].n;
  check('a tablet retrying "new shipment" gets the same shipment, not a second one', s1.status === 201 && s2.status === 201 && ns === 1 && s1.body?.data?.shipment?.id === s2.body?.data?.shipment?.id, `${s1.status} ${s2.status} ${ns}`);

  console.log('\nServer hardening (N9, N22, N24, R34, R20)');
  const { allowedUrl } = require('../../src/utils/safeRender');
  check('server-side Chrome may load only inline data and our file storage', allowedUrl('data:image/png;base64,AAA') && !allowedUrl('http://169.254.169.254/latest/meta-data/') && !allowedUrl('http://localhost:5055/api/backup') && !allowedUrl('https://evil.example.com/x.png') && allowedUrl('https://res.cloudinary.com/demo/image/upload/x.png'));
  const h = await fetch(ROOT + '/health');
  const hb = await h.json();
  check('/health checks the database and start-up', h.status === 200 && hb.database === 'ok' && hb.jobs === 'registered', JSON.stringify(hb));
  const up = await fetch(ROOT + '/uploads/');
  check('/uploads (temporary files) is no longer served', up.status === 404, up.status);
  const uname = 'r12u' + Date.now().toString(36);
  await api('POST', '/auth/register', { username: uname, password: 'First-pass-123', role: 'user' });
  const t1 = await login(uname, 'First-pass-123');
  const t2 = await login(uname, 'First-pass-123');
  const cp = await api('PUT', '/auth/change-password', { currentPassword: 'First-pass-123', newPassword: 'Second-pass-456' }, t1);
  const old = await api('GET', '/workorders?limit=1', null, t2);
  const fresh = await api('GET', '/workorders?limit=1', null, cp.body?.data?.token);
  check('changing a password signs out other sessions; this one gets a fresh token', cp.status === 200 && old.status === 401 && fresh.status === 200, `${cp.status} ${old.status} ${fresh.status}`);
  const vA = (await api('POST', '/vendors', { name: tag + ' Galv A' })).body?.data?.id;
  const vB = (await api('POST', '/vendors', { name: tag + ' Galv B' })).body?.data?.id;
  const G = await mkWO(100);
  const gp = (await q(`SELECT id FROM work_order_parts WHERE "workOrderId" = $1`, [G]))[0].id;
  await pg.query(`UPDATE work_order_parts SET "outsideProcessing" = $1::jsonb WHERE id = $2`, [JSON.stringify([{ id: 'op1', vendorId: vB, vendorName: tag + ' Galv B', serviceType: 'galv' }]), gp]);
  await pg.query(`UPDATE work_orders SET "opTransports" = $1::jsonb WHERE id = $2`, [JSON.stringify([{ id: 't1', truckingVendorId: vB, cost: 10 }]), G]);
  const mg = await api('POST', `/vendors/${vA}/merge`, { sourceId: vB });
  const gpa = (await q(`SELECT "outsideProcessing" FROM work_order_parts WHERE id = $1`, [gp]))[0].outsideProcessing;
  const gwa = (await q(`SELECT "opTransports" FROM work_orders WHERE id = $1`, [G]))[0].opTransports;
  check('a vendor merge moves ids kept inside outside-processing lines and trucking trips', mg.status === 200 && gpa[0].vendorId === vA && gpa[0].vendorName === tag + ' Galv A' && gwa[0].truckingVendorId === vA, `${mg.status} ${JSON.stringify(gpa)} ${JSON.stringify(gwa)}`);

  await pg.query(`DELETE FROM api_keys WHERE name LIKE $1`, [tag + '%']);
  await pg.end();
  try { await require('../../src/models').sequelize.close(); } catch (_) {}
  console.log(`\nround12: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
