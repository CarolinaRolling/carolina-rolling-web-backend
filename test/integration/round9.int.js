/**
 * Round 9 checks (fresh-audit criticals and highs): API keys reach only what they're for (R1), portal
 * routes check the key's client (R2, R25), backup links admin-only (R3), first-admin logic (R4), real
 * caller IP (R5), no portalVisible boot backfill (R6), file routes check the part's order and sign S3
 * links (R7), every IIF export marks and locks (R8), Link estimate = Convert pricing (R9), part saves
 * don't fake progress (R11), un-complete clears completion (R30), invoicing lists carry the server's
 * invoice amount (R13). Runs against a RUNNING server and a LOCAL test database.
 */
const path = require('path');
const fs = require('fs');
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
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN) => call(m, u, b, { Authorization: `Bearer ${t}` });
const key = (m, u, k, b, extra = {}) => call(m, u, b, { 'X-API-Key': k, ...extra });

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R9' + Date.now().toString(36);
  const mkKey = async (fields) => {
    const k = 'r9_' + crypto.randomBytes(8).toString('hex');
    const f = { name: tag + '-' + k.slice(-4), key: k, permissions: 'read', isActive: true, ...fields };
    const cols = Object.keys(f);
    await pg.query(`INSERT INTO api_keys (id, ${cols.map(c => `"${c}"`).join(',')}, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${cols.map((_, i) => '$' + (i + 1)).join(',')}, now(), now())`, Object.values(f));
    return k;
  };

  console.log('\nCustomer-portal keys (R1, R2, R25)');
  const mine = tag + ' Portal Co', other = tag + ' Other Co';
  await api('POST', '/clients', { name: mine }); await api('POST', '/clients', { name: other });
  const mkWO = async (client) => (await api('POST', '/workorders', { clientName: client })).body.data.id;
  const W1 = await mkWO(mine), W2 = await mkWO(other);
  const dr1 = 970000 + Math.floor(Math.random() * 9999), dr2 = dr1 + 1;
  await pg.query(`UPDATE work_orders SET "drNumber" = $1 WHERE id = $2`, [dr1, W1]);
  await pg.query(`UPDATE work_orders SET "drNumber" = $1 WHERE id = $2`, [dr2, W2]);
  await pg.query(`INSERT INTO work_order_documents (id, "workOrderId", "originalName", url, "documentType", "portalVisible", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'inv.pdf', 'http://x/inv.pdf', 'invoice', true, now(), now())`, [W2]);
  const PK = await mkKey({ clientName: mine });
  const internal = ['/business/ledger', '/business/client-payments', '/business/general-ledger', '/clients', '/shipments', '/inbound',
    '/quickbooks/invoice-numbers', '/workorders/invoicing/history', '/workorders/archived', '/operations/production', '/todos', '/dr-numbers', '/settings/locations'];
  const res = await Promise.all(internal.map(u => key('GET', u, PK)));
  const leaked = internal.filter((u, i) => res[i].status !== 403);
  check('a portal key is refused on every internal route', !leaked.length, leaked.join(', '));
  const list = await key('GET', '/workorders?limit=500', PK);
  const rows = list.body?.data?.rows || list.body?.data || [];
  check('…and lists only its own client\'s work orders', list.status === 200 && rows.some(r => r.id === W1) && !rows.some(r => r.id === W2), `${list.status} ${rows.length}`);
  const otherDetail = await key('GET', `/workorders/${W2}`, PK);
  check('another client\'s order can\'t be opened', [403, 404].includes(otherDetail.status), otherDetail.status);
  const docsOther = await key('GET', `/portal/${dr2}/documents`, PK);
  const docsMine = await key('GET', `/portal/${dr1}/documents`, PK);
  check('portal documents by DR number: another client\'s → 404, own → 200', docsOther.status === 404 && docsMine.status === 200, `${docsOther.status} ${docsMine.status}`);
  const write = await key('POST', '/todos', PK, { title: 'x' });
  check('portal keys are read-only', write.status === 403, write.status);
  const PK2 = await mkKey({ clientName: tag + ' Portal' });   // a prefix of the real name
  const l2 = await key('GET', '/workorders?limit=500', PK2);
  const rows2 = l2.body?.data?.rows || l2.body?.data || [];
  check('a key whose name is only part of the client\'s name sees nothing (no partial matching)', !rows2.some(r => r.id === W1), rows2.length);

  const caseTricks = ['/workorders/Recently-Completed', '/workorders/ARCHIVED', '/estimates/TRASH', '/estimates/Check-Orphaned', '/Business/Ledger'];
  const ct = await Promise.all(caseTricks.map(u => key('GET', u, PK)));
  const ctLeak = caseTricks.filter((u, i) => ct[i].status === 200);
  check('changing the case of a path doesn\'t get a portal key into internal lists', !ctLeak.length, ctLeak.join(', ') + ' ' + ct.map(r => r.status).join(','));

  console.log('\nVendor and device keys (R1)');
  const VK = await mkKey({ vendorName: tag + ' Vendor', permissions: 'read_write' });
  const v1 = await key('GET', '/vendor-portal/purchase-orders', VK);
  const v2 = await key('POST', '/todos', VK, { title: 'x' });
  const v3 = await key('GET', '/clients', VK);
  check('a vendor key reaches the vendor portal only', v1.status === 200 && v2.status === 403 && v3.status === 403, `${v1.status} ${v2.status} ${v3.status}`);
  const DK = await mkKey({ deviceName: 'Tab ' + tag, operatorName: 'Op', permissions: 'read_write' });
  const part = (await api('POST', `/workorders/${W1}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 100, laborTotal: 100 })).body.data.id;
  const d = {
    list: await key('GET', '/workorders?limit=5', DK), detail: await key('GET', `/workorders/${W1}`, DK),
    ship: await key('GET', '/shipments', DK), part: await key('PUT', `/workorders/${W1}/parts/${part}`, DK, { notes: 'tablet note' }),
    ledger: await key('GET', '/business/ledger', DK), qb: await key('GET', '/quickbooks/invoice-numbers', DK),
    todo: await key('POST', '/todos', DK, { title: 'x' }), assign: await key('POST', '/operations/assign', DK, {}),
  };
  check('a shop device reaches the tablet\'s endpoints', [d.list, d.detail, d.ship, d.part].every(r => r.status === 200), [d.list, d.detail, d.ship, d.part].map(r => r.status).join(','));
  check('…but not the books, QuickBooks or other writes', [d.ledger, d.qb, d.todo].every(r => r.status === 403), [d.ledger, d.qb, d.todo].map(r => r.status).join(','));
  const pres = await key('POST', `/workorders/${W1}/presence`, DK, {});
  const presDel = await key('DELETE', `/workorders/${W1}/presence`, DK);
  check('the tablet can set and clear "viewing this order"', pres.status < 300 && presDel.status < 300, `${pres.status} ${presDel.status}`);
  check('only the estimator\'s device can reassign operators\' work', d.assign.status === 403 && /estimator/.test(d.assign.body?.error?.message || ''), `${d.assign.status} ${d.assign.body?.error?.message}`);

  console.log('\nBackup links, IP allowlist, boot steps (R3–R6)');
  const bh = await api('GET', '/settings/backup_history', null, CLERK);
  const bh2 = await api('GET', '/settings/last_auto_backup', null, CLERK);
  const bhA = await api('GET', '/settings/backup_history');
  check('backup download links are admin-only', bh.status === 403 && bh2.status === 403 && bhA.status === 200, `${bh.status} ${bh2.status} ${bhA.status}`);
  const IK = await mkKey({ deviceName: 'IP ' + tag, operatorName: 'Op', permissions: 'read', allowedIPs: '10.9.9.9' });
  // On Heroku the router appends the caller's real address to whatever X-Forwarded-For the caller sent.
  // Simulated here: forged first entry, real address last.
  const spoof = await key('GET', '/workorders?limit=1', IK, null, { 'X-Forwarded-For': '10.9.9.9, 203.0.113.5' });
  check('a forged X-Forwarded-For entry no longer passes the IP allowlist', spoof.status === 403, spoof.status);
  const IK2 = await mkKey({ deviceName: 'IP2 ' + tag, operatorName: 'Op', permissions: 'read', allowedIPs: '203.0.113.5' });
  const real = await key('GET', '/workorders?limit=1', IK2, null, { 'X-Forwarded-For': '10.9.9.9, 203.0.113.5' });
  check('…while the real address still does', real.status === 200, real.status);
  const src = fs.readFileSync(path.join(__dirname, '../../src/index.js'), 'utf8');
  check('the boot step that re-showed hidden documents on the portal is gone', !/SET "portalVisible" = true WHERE "documentType" IN/.test(src));
  const authSrc = fs.readFileSync(path.join(__dirname, '../../src/routes/auth.js'), 'utf8');
  check('no built-in admin password is created any more', !/password:\s*'admin123'/.test(authSrc) && /User\.count\(\)/.test(authSrc));

  console.log('\nFile routes (R7)');
  const pf = crypto.randomUUID();
  await pg.query(`INSERT INTO work_order_part_files (id, "workOrderPartId", "fileType", filename, url, "createdAt", "updatedAt") VALUES ($1,$2,'print','p.pdf','http://x/p.pdf',now(),now())`, [pf, part]);
  const wrongWo = await api('GET', `/workorders/${W2}/parts/${part}/files/${pf}/signed-url`);
  const rightWo = await api('GET', `/workorders/${W1}/parts/${part}/files/${pf}/signed-url`);
  check('a part file can only be reached through its own work order', wrongWo.status === 404 && rightWo.status === 200, `${wrongWo.status} ${rightWo.status}`);
  const dbg = await api('GET', `/workorders/${W1}/parts/${part}/files/${pf}/debug`);
  check('the file debug route is removed', dbg.status === 404, dbg.status);
  const storage = require('../../src/utils/storage');
  check('S3 ids are recognised for signing (stored URL or s3: id)', storage.s3IdFor(null, 'https://b.s3.us-west-1.amazonaws.com/a/b%20c.pdf') === 's3:a/b c.pdf' && storage.s3IdFor('s3:k', null) === 's3:k' && storage.s3IdFor('cloud/x', 'https://res.cloudinary.com/x') === null);

  console.log('\nQuickBooks export marks and locks (R8)');
  const WX = await mkWO(mine);
  await api('POST', `/workorders/${WX}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 500, laborTotal: 500 });
  await api('POST', `/quickbooks/assign-invoice-number/${WX}`);
  const e1 = await api('GET', `/quickbooks/export/${WX}`);
  const after1 = (await q(`SELECT "iifExportedAt", "iifBatchId" FROM work_orders WHERE id = $1`, [WX]))[0];
  check('the per-invoice IIF export marks the invoice as entered', e1.status === 200 && /TRNS/.test(e1.body) && !!after1.iifExportedAt, `${e1.status} ${after1.iifExportedAt}`);
  const e2 = await api('GET', `/quickbooks/export/${WX}`);
  check('exporting it again is refused (would duplicate in QuickBooks)', e2.status === 409 && e2.body?.error?.code === 'ALREADY_EXPORTED', `${e2.status}`);
  const e3 = await api('GET', `/quickbooks/export/${WX}?reexport=1`);
  const after3 = (await q(`SELECT "iifBatchId" FROM work_orders WHERE id = $1`, [WX]))[0];
  check('an explicit re-download works and changes nothing', e3.status === 200 && after3.iifBatchId === after1.iifBatchId, `${e3.status}`);
  const lockedAdd = await api('POST', `/workorders/${WX}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 777, laborTotal: 777 });
  check('…and its prices are locked like any exported invoice', lockedAdd.status === 409, lockedAdd.status);
  const WY = await mkWO(mine);
  await api('POST', `/workorders/${WY}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 300, laborTotal: 300 });
  await api('POST', `/quickbooks/assign-invoice-number/${WY}`);
  const [b1, b2] = await Promise.all([api('POST', '/quickbooks/export-batch', { workOrderIds: [WY] }), api('POST', '/quickbooks/export-batch', { workOrderIds: [WY] })]);
  check('two people exporting the same invoice at once: one gets it, the other is told it\'s done', [b1.status, b2.status].sort().join() === '200,409', `${b1.status} ${b2.status}`);
  const rec = await api('POST', '/quickbooks/export-batch-with-reconciliation', { workOrderIds: [WX, WY] });
  check('the reconciliation export skips invoices already in QuickBooks', rec.status === 409, rec.status);

  console.log('\nLink estimate = Convert (R9)');
  const mkEst = async (client) => {
    const e = (await api('POST', '/estimates', { clientName: client })).body.data.id;
    await api('POST', `/estimates/${e}/parts`, { partType: 'plate_roll', quantity: 2, materialTotal: '50.00', materialMarkupPercent: '20', laborTotal: '100.00', _baseLaborTotal: '100.00', partTotal: '320.00', rollType: 'easy_way', thickness: '0.25' });
    return e;
  };
  const Econv = await mkEst(other), Elink = await mkEst(other);
  const conv = await api('POST', `/estimates/${Econv}/convert-to-workorder`, { materialReceived: true });
  const Wc = conv.body?.data?.workOrder?.id;
  const Wl = await mkWO(mine);
  const link = await api('POST', `/workorders/${Wl}/link-estimate`, { estimateId: Elink });
  const sum = async (w) => (await q(`SELECT COALESCE(SUM("partTotal"),0)::numeric n, COALESCE(SUM("laborTotal"),0)::numeric l FROM work_order_parts WHERE "workOrderId" = $1`, [w]))[0];
  const sc = await sum(Wc), sl = await sum(Wl);
  check('a linked estimate brings the same labor and line totals as a converted one', conv.status === 201 && link.status === 200 && String(sc.n) === String(sl.n) && String(sc.l) === String(sl.l) && Number(sl.l) > 0, `${conv.status}/${link.status} convert ${sc.n}/${sc.l} link ${sl.n}/${sl.l}`);
  const wlRow = (await q(`SELECT "clientName", "clientId" FROM work_orders WHERE id = $1`, [Wl]))[0];
  const otherId = (await q(`SELECT id FROM clients WHERE name = $1`, [other]))[0]?.id;
  check('…and the order\'s client id follows the estimate\'s client (not just the name)', wlRow.clientName === other && wlRow.clientId === otherId, JSON.stringify(wlRow));
  const un = await api('POST', `/workorders/${Wl}/unlink-estimate`);
  check('unlinking takes back off the lines the link added', un.status === 200 && Number((await sum(Wl)).n) === 0, `${un.status} ${JSON.stringify(un.body?.data || un.body)}`);

  // service lines keep pointing at the right part after a link
  const Esvc = (await api('POST', '/estimates', { clientName: other })).body.data.id;
  const base = (await api('POST', `/estimates/${Esvc}/parts`, { partType: 'plate_roll', quantity: 1, laborTotal: '100.00', _baseLaborTotal: '100.00', partTotal: '100.00', rollType: 'easy_way', thickness: '0.25' })).body.data.id;
  await api('POST', `/estimates/${Esvc}/parts`, { partType: 'inspection', quantity: 1, partTotal: '25.00', laborTotal: '25.00', _linkedPartId: base });
  const Ws = await mkWO(other);
  const ls = await api('POST', `/workorders/${Ws}/link-estimate`, { estimateId: Esvc });
  const wps = await q(`SELECT id, "partType", "formData" FROM work_order_parts WHERE "workOrderId" = $1`, [Ws]);
  const wBase = wps.find(p => p.partType === 'plate_roll'), wSvc = wps.find(p => p.partType === 'inspection');
  check('after a link, a service line points at the order\'s own part (not the estimate\'s)', ls.status === 200 && wSvc && wBase && wSvc.formData?._linkedPartId === wBase.id && wSvc.formData?._fromEstimateId === Esvc, JSON.stringify(wSvc?.formData));
  await pg.query(`UPDATE work_orders SET "iifExportedAt" = now() WHERE id = $1`, [Ws]);
  const unl = await api('POST', `/workorders/${Ws}/unlink-estimate`);
  check('an invoice already in QuickBooks can\'t be unlinked (its lines would be removed)', unl.status === 409 && (await q(`SELECT COUNT(*)::int n FROM work_order_parts WHERE "workOrderId" = $1`, [Ws]))[0].n === 2, `${unl.status} ${unl.body?.error?.message}`);
  const boot = await api('PUT', '/settings/bootstrap_admin_id', { value: crypto.randomUUID() }, CLERK);
  check('no one can point the restore\'s first-admin clean-up at another user', boot.status === 403, boot.status);

  console.log('\nPart saves and progress (R11, R30)');
  await api('PUT', `/workorders/${W1}/parts/${part}`, { progressCount: 1 });
  const logBefore = (await q(`SELECT "progressLog" FROM work_order_parts WHERE id = $1`, [part]))[0].progressLog || [];
  await api('PUT', `/workorders/${W1}/parts/${part}`, { progressCount: 1, partTotal: 120, laborTotal: 120 });
  const logAfter = (await q(`SELECT "progressLog" FROM work_order_parts WHERE id = $1`, [part]))[0].progressLog || [];
  check('a save that repeats the same progress count adds no progress entry', logAfter.length === logBefore.length, `${logBefore.length} → ${logAfter.length}`);
  await key('PUT', `/workorders/${W1}/parts/${part}`, DK, { status: 'completed' });
  const c1 = (await q(`SELECT "completedAt", "completedBy" FROM work_order_parts WHERE id = $1`, [part]))[0];
  await key('PUT', `/workorders/${W1}/parts/${part}`, DK, { status: 'pending' });
  const c2 = (await q(`SELECT "completedAt", "completedBy" FROM work_order_parts WHERE id = $1`, [part]))[0];
  check('un-completing a part clears who completed it and when', !!c1.completedAt && c2.completedAt === null && c2.completedBy === null, JSON.stringify([c1, c2]));

  console.log('\nInvoice Center amounts (R13)');
  const WQ = await mkWO(mine);
  await api('POST', `/workorders/${WQ}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 1000, laborTotal: 1000 });
  await pg.query(`UPDATE work_orders SET status = 'shipped' WHERE id = $1`, [WQ]);
  const queue = await api('GET', '/workorders/invoicing/queue');
  const qrow = (queue.body?.data || []).find(r => r.id === WQ);
  const tot = await api('GET', `/workorders/${WQ}/invoice-totals`);
  check('the invoicing queue carries the server\'s invoice amount (tax included)', qrow && Number(qrow.invoiceAmount) === Number(tot.body?.data?.amount) && Number(qrow.invoiceAmount) > 1000, `${qrow?.invoiceAmount} vs ${tot.body?.data?.amount}`);

  await pg.query(`DELETE FROM api_keys WHERE name LIKE $1`, [tag + '%']);
  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
