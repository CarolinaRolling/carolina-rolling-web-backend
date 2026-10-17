/**
 * Round 17 tablet / access checks (sixth independent audit, W-series): the approved-IP list holds every
 * non-admin tablet key, also one with only a Name (W5); creating a shipment linked to an order runs the
 * link route's closed-order and client checks (W11); tablets can't list or open vendor PO PDFs (W15).
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
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json()).data?.token;
let TOKEN;
async function call(method, url, body, headers) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN) => call(m, u, b, { Authorization: `Bearer ${t}` });
const key = (m, u, k, b) => call(m, u, b, { 'X-API-Key': k });

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R17T' + Date.now().toString(36);
  const client = tag + ' Co', other = tag + ' Other Co';
  await api('POST', '/clients', { name: client });
  await api('POST', '/clients', { name: other });
  const mkKey = async (fields = {}) => {
    const k = 'r17t_' + crypto.randomBytes(8).toString('hex');
    const f = { name: tag + '-' + k.slice(-4), key: k, permissions: 'read_write', isActive: true, ...fields };
    const cols = Object.keys(f);
    await pg.query(`INSERT INTO api_keys (id, ${cols.map(c => `"${c}"`).join(',')}, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${cols.map((_, i) => '$' + (i + 1)).join(',')}, now(), now())`, Object.values(f));
    return k;
  };
  const dev = await mkKey({ deviceName: tag + '-tab' });
  const mkWo = async (name = client) => (await api('POST', '/workorders', { clientName: name })).body?.data?.id;

  console.log('\nApproved-IP list holds every non-admin tablet key (W5)');
  const nameOnly = await mkKey();                                        // read_write, only a Name
  const nameOnlyRead = await mkKey({ permissions: 'read' });
  const opOnly = await mkKey({ operatorName: tag + ' op' });
  const devIp = await mkKey({ deviceName: tag + '-tab2' });
  const adminKey = await mkKey({ permissions: 'admin' });               // office/integration admin key
  const portal = await mkKey({ clientName: client, permissions: 'read' });
  const prevIps = (await q(`SELECT value FROM app_settings WHERE key = 'approved_ips'`))[0];
  const setIps = async (v) => {
    await pg.query(`DELETE FROM app_settings WHERE key = 'approved_ips'`);
    if (v) await pg.query(`INSERT INTO app_settings (id, key, value, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'approved_ips', $1, now(), now())`, [JSON.stringify(v)]);
  };
  let r = {};
  try {
    await setIps({ ips: ['10.9.9.9'] });
    for (const [n, k, u] of [['nameOnly', nameOnly], ['nameOnlyRead', nameOnlyRead], ['opOnly', opOnly], ['dev', devIp], ['admin', adminKey], ['portal', portal, '/portal/workorders']]) {
      r[n] = await key('GET', u || '/workorders?limit=1', k);
    }
    r.jwt = await api('GET', '/workorders?limit=1');
    r.clerk = await api('GET', '/workorders?limit=1', null, CLERK);
  } finally {
    await setIps(prevIps ? prevIps.value : null);
  }
  const revoked = (x) => x.status === 403 && x.body?.error?.code === 'IP_REVOKED';
  check('a read/write key with only a Name is held to the list (refused, revoked)', revoked(r.nameOnly), `${r.nameOnly.status} ${JSON.stringify(r.nameOnly.body).slice(0, 100)}`);
  check('…a read-only name-only key too', revoked(r.nameOnlyRead), r.nameOnlyRead.status);
  check('…operator-only and device-named keys still are (V5)', revoked(r.opOnly) && revoked(r.dev), `${r.opOnly.status} ${r.dev.status}`);
  check('an admin key without a device name is not IP-checked', r.admin.status === 200, r.admin.status);
  check('a portal key is not IP-checked', !revoked(r.portal), `${r.portal.status}`);
  check('signed-in users (JWT) are not IP-checked', r.jwt.status === 200 && r.clerk.status === 200, `${r.jwt.status} ${r.clerk.status}`);
  const act = (await q(`SELECT key, "isActive" FROM api_keys WHERE key = ANY($1)`, [[nameOnly, adminKey]]));
  check('the name-only key is revoked, the admin key stays active', act.find(a => a.key === nameOnly)?.isActive === false && act.find(a => a.key === adminKey)?.isActive === true, JSON.stringify(act));

  console.log('\nShipment created onto an order: closed-order and client checks (W11)');
  const count = async () => Number((await q(`SELECT count(*) FROM shipments WHERE description LIKE $1`, [tag + '%']))[0].count);
  const S = await mkWo();
  await pg.query(`UPDATE work_orders SET status = 'shipped' WHERE id = $1`, [S]);
  const c0 = await count();
  const shipped = await key('POST', '/shipments', dev, { clientName: client, description: tag + ' a', linkToWorkOrderId: S });
  check('onto a shipped order: 409 WORK_ORDER_CLOSED', shipped.status === 409 && shipped.body?.error?.code === 'WORK_ORDER_CLOSED', `${shipped.status} ${JSON.stringify(shipped.body).slice(0, 120)}`);
  const V = await mkWo();
  await pg.query(`UPDATE work_orders SET "isVoided" = true WHERE id = $1`, [V]).catch(() => pg.query(`UPDATE work_orders SET status = 'voided' WHERE id = $1`, [V]));
  const voided = await key('POST', '/shipments', dev, { clientName: client, description: tag + ' b', linkToWorkOrderId: V });
  check('onto a voided order: 409 WORK_ORDER_CLOSED', voided.status === 409 && voided.body?.error?.code === 'WORK_ORDER_CLOSED', voided.status);
  const Oth = await mkWo(other);
  const mism = await key('POST', '/shipments', dev, { clientName: client, description: tag + ' c', linkToWorkOrderId: Oth });
  check('onto another client\'s order: 409 CLIENT_MISMATCH', mism.status === 409 && mism.body?.error?.code === 'CLIENT_MISMATCH', `${mism.status} ${JSON.stringify(mism.body).slice(0, 120)}`);
  const missing = await key('POST', '/shipments', dev, { clientName: client, description: tag + ' d', linkToWorkOrderId: crypto.randomUUID() });
  check('onto an order that doesn\'t exist: 404', missing.status === 404, missing.status);
  const recv = (await q(`SELECT "receivedBy" FROM work_orders WHERE id = $1`, [Oth]))[0];
  check('no shipment was created by the refused calls and the other client\'s order is untouched', (await count()) === c0 && !recv.receivedBy, `${await count()} vs ${c0}`);
  const O = await mkWo();
  const ok = await key('POST', '/shipments', dev, { clientName: client.toUpperCase() + ' ', description: tag + ' e', linkToWorkOrderId: O });
  const okId = ok.body?.data?.shipment?.id;
  const linked = okId && (await q(`SELECT "workOrderId" FROM shipments WHERE id = $1`, [okId]))[0]?.workOrderId;
  check('onto an open order of the same client (name case/space ignored): 201 and linked', ok.status === 201 && linked === O, `${ok.status} ${linked}`);
  const adm = await api('POST', '/shipments', { clientName: client, description: tag + ' f', linkToWorkOrderId: S });
  check('the office gets the same 409 on a closed order', adm.status === 409, adm.status);
  const plain = await key('POST', '/shipments', dev, { clientName: client, description: tag + ' g' });
  check('a shipment without a link is still created', plain.status === 201, plain.status);

  console.log('\nTablets can\'t list or open vendor PO PDFs (W15)');
  const P = await mkWo();
  const mkDoc = async (type) => (await q(`INSERT INTO work_order_documents (id, "workOrderId", "originalName", "mimeType", size, url, "documentType", "portalVisible", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), $1, $2, 'application/pdf', 10, $3, $4, false, now(), now()) RETURNING id`, [P, `${tag}-${type}.pdf`, `/uploads/${tag}-${type}.pdf`, type]))[0].id;
  const docs = {};
  for (const t of ['purchase_order', 'outside_processing_po', 'transport_po', 'invoice', 'mtr']) docs[t] = await mkDoc(t);
  const detD = await key('GET', `/workorders/${P}`, dev);
  const detA = await api('GET', `/workorders/${P}`);
  const names = (b) => JSON.stringify(b);
  check('the tablet\'s order detail lists the MTR but no PO or invoice documents', detD.status === 200 && names(detD.body).includes(`${tag}-mtr.pdf`) && !/purchase_order|_po\.pdf|invoice\.pdf/.test(names(detD.body)),
    `${detD.status} ${(names(detD.body).match(/R17T[^"]*\.pdf/g) || []).join(',')}`);
  check('…the office still sees them all', ['purchase_order', 'outside_processing_po', 'transport_po'].every(t => names(detA.body).includes(`${tag}-${t}.pdf`)), detA.status);
  for (const t of ['purchase_order', 'outside_processing_po', 'transport_po']) {
    const su = await key('GET', `/workorders/${P}/documents/${docs[t]}/signed-url`, dev);
    const dl = await key('GET', `/workorders/${P}/documents/${docs[t]}/download`, dev);
    check(`tablet can't open a ${t} (signed-url and download: 403)`, su.status === 403 && dl.status === 403, `${su.status} ${dl.status}`);
  }
  // review of round 17: routing ignores case, so a re-cased URL must be refused too
  const UP = BASE.replace(/\/api$/, '/API');
  const up = await fetch(`${UP}/WorkOrders/${P}/documents/${docs.purchase_order}/signed-url`, { headers: { 'X-API-Key': dev } });
  check('…not even through a re-cased URL (/API/WorkOrders/…)', up.status === 403, up.status);
  const inv = await key('GET', `/workorders/${P}/documents/${docs.invoice}/signed-url`, dev);
  check('…nor an invoice (as before)', inv.status === 403, inv.status);
  const mtr = await key('GET', `/workorders/${P}/documents/${docs.mtr}/signed-url`, dev);
  check('…but can open the MTR', mtr.status === 200, mtr.status);
  const offc = await api('GET', `/workorders/${P}/documents/${docs.purchase_order}/signed-url`);
  check('the office opens the PO', offc.status === 200, offc.status);
  const bad = await key('GET', `/workorders/${P}/documents/not-a-uuid/signed-url`, dev);
  check('a malformed document id is a 4xx, not a 500', bad.status >= 400 && bad.status < 500, bad.status);

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
