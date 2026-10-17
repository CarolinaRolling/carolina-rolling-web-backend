/**
 * Round 11 checks (second independent audit, highs N1–N8): login input types (N1), the customer
 * portal never sees drafts, internal notes or unpublished files (N2), voiding a billed invoice number
 * is guarded (N3), order-level OP trips are billed and shipping isn't discounted (N4), Unlink can't
 * undo a Convert or strip an invoiced/paid order (N5), tablet keys can't change prices or bulk-delete
 * shipments (N6, N16), typed invoice dates keep their calendar day (N8).
 * Runs against a RUNNING server and a LOCAL test database.
 */
const path = require('path');
const crypto = require('crypto');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';
const shopTime = require('../../src/utils/shopTime');

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

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R11' + Date.now().toString(36);
  const client = tag + ' Co';
  await api('POST', '/clients', { name: client });
  const mkKey = async (fields) => {
    const k = 'r11_' + crypto.randomBytes(8).toString('hex');
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

  console.log('\nLogin input types (N1)');
  const arr = await call('POST', '/auth/login', { username: ['boss'], password: PASS });
  const obj = await call('POST', '/auth/login', { username: { $ne: 1 }, password: PASS });
  const tot = await call('POST', '/auth/login', { username: 'boss', password: PASS, totpCode: ['1'] });
  check('a non-string username / password / code is refused (400), not looked up', arr.status === 400 && obj.status === 400 && tot.status === 400, `${arr.status} ${obj.status} ${tot.status}`);
  const ok = await call('POST', '/auth/login', { username: 'boss', password: PASS });
  check('…a normal login still works', ok.status === 200 && !!ok.body?.data?.token, ok.status);

  console.log('\nCustomer portal sees only what was sent (N2)');
  const PK = await mkKey({ clientName: client });
  const mkEst = async (status) => {
    const e = (await api('POST', '/estimates', { clientName: client, internalNotes: 'margin is 40% — do not share' })).body.data.id;
    await pg.query(`UPDATE estimates SET status = $1, "internalNotes" = 'margin is 40% — do not share' WHERE id = $2`, [status, e]);
    return e;
  };
  const Edraft = await mkEst('draft'), Esent = await mkEst('sent');
  await pg.query(`INSERT INTO estimate_files (id, "estimateId", filename, "originalName", url, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'w.pdf', 'pricing-worksheet.pdf', 'http://x/w.pdf', now(), now())`, [Esent]);
  const plist = await key('GET', '/estimates?limit=500', PK);
  const prow = plist.body?.data?.rows || plist.body?.data || [];
  const ids = (Array.isArray(prow) ? prow : []).map(e => e.id);
  check('the portal list shows the sent estimate but not the draft', plist.status === 200 && ids.includes(Esent) && !ids.includes(Edraft), `${plist.status} sent:${ids.includes(Esent)} draft:${ids.includes(Edraft)}`);
  const pd = await key('GET', `/estimates/${Edraft}`, PK);
  check('a draft estimate can\'t be opened by id', pd.status === 403 || pd.status === 404, pd.status);
  const ps = await key('GET', `/estimates/${Esent}`, PK);
  const text = JSON.stringify(ps.body || '');
  check('the sent estimate opens without its internal notes', ps.status === 200 && !text.includes('margin is 40%'), `${ps.status} leaked:${text.includes('margin is 40%')}`);
  const fileNames = ((ps.body?.data?.files) || []).map(f => f.originalName);
  check('…and only its published files', !fileNames.includes('pricing-worksheet.pdf'), JSON.stringify(fileNames));
  const ef = (await q(`SELECT id FROM estimate_files WHERE "estimateId" = $1`, [Esent]))[0].id;
  const tog = await api('PATCH', `/estimates/${Esent}/files/${ef}/portal`, { portalVisible: true });
  const ps2 = await key('GET', `/estimates/${Esent}`, PK);
  check('…until the office publishes it', tog.status === 200 && ((ps2.body?.data?.files) || []).some(f => f.originalName === 'pricing-worksheet.pdf'), `${tog.status}`);
  const dnum = (await q(`SELECT "estimateNumber" FROM estimates WHERE id = $1`, [Edraft]))[0].estimateNumber;
  const pf = await key('GET', `/portal/estimate/${encodeURIComponent(dnum)}/files`, PK);
  check('the portal file list refuses a draft estimate too', pf.status === 404, pf.status);

  console.log('\nVoiding a billed invoice number (N3)');
  const V = await mkWO(500);
  await api('POST', `/quickbooks/assign-invoice-number/${V}`);
  const invRow = (await q(`SELECT i.id FROM invoice_numbers i JOIN work_orders w ON w."invoiceNumber" = i."invoiceNumber"::text WHERE w.id = $1`, [V]))[0];
  const vClerk = await api('POST', `/quickbooks/invoice-numbers/${invRow?.id}/void`, {}, CLERK);
  await pg.query(`UPDATE work_orders SET "iifExportedAt" = now() WHERE id = $1`, [V]);
  const vAdmin = await api('POST', `/quickbooks/invoice-numbers/${invRow?.id}/void`, {});
  const vw = (await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [V]))[0];
  check('a clerk can\'t void the number an order is billed under; nobody can once it\'s in QuickBooks', !!invRow && vClerk.status === 403 && vAdmin.status === 409 && !!vw.invoiceNumber, `${!!invRow} ${vClerk.status} ${vAdmin.status} ${vw.invoiceNumber}`);
  const V2 = await mkWO(300);
  await api('POST', `/quickbooks/assign-invoice-number/${V2}`);
  const before2 = (await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [V2]))[0].invoiceNumber;
  const re1 = await api('POST', `/workorders/${V2}/invoice`, { invoiceNumber: String(Number(before2) + 50000) }, CLERK);
  const re2 = await api('POST', `/quickbooks/invoice-numbers/manual`, { invoiceNumber: String(Number(before2) + 50001), workOrderId: V2 }, CLERK);
  const after2 = (await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [V2]))[0].invoiceNumber;
  check('…nor replace it by typing a new number on the order (side doors closed)', re1.status === 403 && re2.status === 403 && after2 === before2, `${re1.status} ${re2.status} ${before2}→${after2}`);

  console.log('\nOutside-processing trips are billed; shipping is not discounted (N4)');
  const T = await mkWO(1000);
  await api('PUT', `/workorders/${T}`, { opTransports: [{ id: 't1', leg: 'out', cost: 100, markup: 20 }], truckingCost: 50, taxRate: 7 });
  await pg.query(`UPDATE work_orders SET "discountPercent" = 10 WHERE id = $1`, [T]);   // comes from the estimate on convert / link
  await sleep(600);
  const tt = (await api('GET', `/workorders/${T}/invoice-totals`)).body.data;
  // parts 1000 + trip 120 + trucking 50; discount 10% of 1120 = 112; pre-tax 1058; tax 7% of 1008 = 70.56
  check('the invoice total includes the trip and discounts parts only', tt && tt.opTransportTotal === 120 && tt.discountTotal === 112 && tt.preTaxTotal === 1058 && tt.taxAmount === 70.56 && tt.amount === 1128.56,
    JSON.stringify(tt && { op: tt.opTransportTotal, d: tt.discountTotal, pre: tt.preTaxTotal, tax: tt.taxAmount, amt: tt.amount }));
  const pv = await api('GET', `/quickbooks/preview/${T}`);
  const trns = String(pv.body?.data?.rawIIF || '').split('\n').find(l => l.startsWith('TRNS\t'));
  const trnsAmt = trns ? Number(trns.split('\t')[6]) : NaN;
  const raw = String(pv.body?.data?.rawIIF || '');
  check('…and QuickBooks gets the same pre-tax total, with an "Outside processing transport" line', trnsAmt === 1058 && raw.includes('Outside processing transport'), `${trnsAmt} ${raw.includes('Outside processing transport')}`);
  const est = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${est}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '1000.00', laborTotal: '1000.00' });
  await api('PUT', `/estimates/${est}`, { opTransports: [{ id: 't1', cost: 100, markup: 20 }], discountPercent: 10, truckingCost: 50, taxRate: 7 });
  const eg = (await api('GET', `/estimates/${est}`)).body?.data;
  check('…which is what the estimate quoted', eg && Math.abs(Number(eg.grandTotal) - 1128.56) < 0.01, eg && eg.grandTotal);

  console.log('\nUnlink (N5)');
  const Ec = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${Ec}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '300.00', laborTotal: '300.00' });
  const conv = await api('POST', `/estimates/${Ec}/convert-to-workorder`, { materialReceived: true });
  const Wc = conv.body?.data?.workOrder?.id;
  const unc = await api('POST', `/workorders/${Wc}/unlink-estimate`);
  const ecs = (await q(`SELECT "workOrderId" FROM estimates WHERE id = $1`, [Ec]))[0];
  const wcs = (await q(`SELECT "estimateId" FROM work_orders WHERE id = $1`, [Wc]))[0];
  check('an order created by Convert can\'t be unlinked (estimate and order stay tied, so it can\'t be converted twice)', !!Wc && unc.status === 409 && ecs.workOrderId === Wc && wcs.estimateId === Ec, `${conv.status} ${unc.status} ${JSON.stringify([ecs, wcs])}`);
  const El = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${El}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '400.00', laborTotal: '400.00' });
  const Wl = await mkWO(0);
  const lk = await api('POST', `/workorders/${Wl}/link-estimate`, { estimateId: El });
  await api('POST', `/quickbooks/assign-invoice-number/${Wl}`);
  const unl = await api('POST', `/workorders/${Wl}/unlink-estimate`);
  const nl = (await q(`SELECT COUNT(*)::int n FROM work_order_parts WHERE "workOrderId" = $1`, [Wl]))[0].n;
  check('an invoiced linked order keeps its lines (unlink refused)', lk.status === 200 && unl.status === 409 && nl === 1, `${lk.status} ${unl.status} ${nl}`);
  const El2 = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${El2}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '400.00', laborTotal: '400.00' });
  const Wl2 = await mkWO(0);
  await api('POST', `/workorders/${Wl2}/link-estimate`, { estimateId: El2 });
  const unl2 = await api('POST', `/workorders/${Wl2}/unlink-estimate`);
  check('a plain linked order still unlinks', unl2.status === 200 && (await q(`SELECT COUNT(*)::int n FROM work_order_parts WHERE "workOrderId" = $1`, [Wl2]))[0].n === 0, unl2.status);

  const El3 = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${El3}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '1000.00', laborTotal: '1000.00' });
  await api('PUT', `/estimates/${El3}`, { opTransports: [{ id: 'tx', cost: 100, markup: 20 }], discountPercent: 10 });
  const Wl3 = await mkWO(0);
  await api('PUT', `/workorders/${Wl3}`, { opTransports: [{ id: 'own', cost: 10, markup: 0 }] });
  await api('POST', `/workorders/${Wl3}/link-estimate`, { estimateId: El3 });
  await sleep(500);
  const l3 = (await api('GET', `/workorders/${Wl3}/invoice-totals`)).body.data;
  check('Link brings the estimate\'s trips and discount to the order (as Convert does)', l3 && l3.opTransportTotal === 130 && l3.discountTotal === 113, JSON.stringify(l3 && { op: l3.opTransportTotal, d: l3.discountTotal }));
  await api('POST', `/workorders/${Wl3}/unlink-estimate`);
  const w3 = (await q(`SELECT "opTransports", "discountPercent" FROM work_orders WHERE id = $1`, [Wl3]))[0];
  check('…and Unlink takes them back off (the order\'s own trip stays)', (w3.opTransports || []).length === 1 && w3.opTransports[0].id === 'own' && !(Number(w3.discountPercent) > 0), JSON.stringify(w3));

  console.log('\nTablet keys (N6, N16)');
  const DK = await mkKey({ deviceName: 'Tab ' + tag, operatorName: 'Op ' + tag, permissions: 'read_write' });
  const D = await mkWO(54.75);
  const part = (await q(`SELECT id FROM work_order_parts WHERE "workOrderId" = $1`, [D]))[0].id;
  const pr = await key('PUT', `/workorders/${D}/parts/${part}`, DK, { partTotal: 1.10, laborTotal: 1.10 });
  const pAfter = (await q(`SELECT "partTotal" FROM work_order_parts WHERE id = $1`, [part]))[0];
  check('a tablet key can\'t change a part\'s price', pr.status === 403 && Number(pAfter.partTotal) === 54.75, `${pr.status} ${pAfter.partTotal}`);
  const st = await key('PUT', `/workorders/${D}/parts/${part}`, DK, { status: 'completed', completedBy: 'Someone Else', operatorNotes: 'done', heatNumber: 'H1' });
  const sAfter = (await q(`SELECT status, "completedBy", "operatorNotes", "heatNumber" FROM work_order_parts WHERE id = $1`, [part]))[0];
  check('…but still saves status, notes and heats, credited to its own operator', st.status === 200 && sAfter.status === 'completed' && /^Op /.test(sAfter.completedBy || '') && sAfter.operatorNotes === 'done' && sAfter.heatNumber === 'H1', `${st.status} ${JSON.stringify(sAfter)}`);
  const bd = await key('POST', '/shipments/bulk-delete', DK, { ids: [] });
  const ba = await key('POST', '/shipments/bulk-archive', DK, { ids: [] });
  check('a tablet key can\'t bulk-delete or bulk-archive shipments', bd.status === 403 && ba.status === 403, `${bd.status} ${ba.status}`);

  console.log('\nTyped invoice dates (N8)');
  const bad = await api('POST', `/workorders/${await mkWO(10)}/invoice`, { invoiceNumber: String(Number((await q(`SELECT COALESCE(MAX("invoiceNumber"),0) m FROM invoice_numbers`))[0].m) + 300 + Math.floor(Math.random() * 200)), invoiceDate: '2026-02-30' });
  check('an impossible date is refused, not saved as another day', bad.status === 400, bad.status);
  const I = await mkWO(200);
  const ir = await api('POST', `/workorders/${I}/invoice`, { invoiceNumber: String(Number((await q(`SELECT COALESCE(MAX("invoiceNumber"),0) m FROM invoice_numbers`))[0].m) + 1 + Math.floor(Math.random() * 200)), invoiceDate: '2026-03-05' });
  const iw = (await q(`SELECT "invoiceDate" FROM work_orders WHERE id = $1`, [I]))[0];
  check('a typed invoice date is stored as that day on the shop calendar', ir.status < 300 && shopTime.shopDate(new Date(iw.invoiceDate)) === '2026-03-05', `${ir.status} ${iw.invoiceDate && new Date(iw.invoiceDate).toISOString()}`);
  const ip = await api('GET', `/quickbooks/preview/${I}`);
  const itr = String(ip.body?.data?.rawIIF || '').split('\n').find(l => l.startsWith('TRNS\t'));
  check('…and QuickBooks gets 03/05/2026', itr && itr.split('\t')[3] === '03/05/2026', itr && itr.split('\t')[3]);
  await pg.query(`UPDATE work_orders SET "invoiceDate" = '2026-03-05T00:00:00Z' WHERE id = $1`, [I]);   // saved before round 11
  const ip2 = await api('GET', `/quickbooks/preview/${I}`);
  const itr2 = String(ip2.body?.data?.rawIIF || '').split('\n').find(l => l.startsWith('TRNS\t'));
  check('an invoice date saved the old way (midnight UTC) also exports as 03/05/2026', itr2 && itr2.split('\t')[3] === '03/05/2026', itr2 && itr2.split('\t')[3]);
  check('the calendar helpers agree', shopTime.calendarDay(new Date('2026-03-05T00:00:00Z')) === '2026-03-05' && shopTime.calendarDay(shopTime.calendarInstant('2026-11-01')) === '2026-11-01' && shopTime.calendarDay(new Date('2026-03-06T03:00:00Z')) === '2026-03-05');

  await pg.query(`DELETE FROM api_keys WHERE name LIKE $1`, [tag + '%']);
  await pg.end();
  console.log(`\nround11: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
