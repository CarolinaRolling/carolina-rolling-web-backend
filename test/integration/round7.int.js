/**
 * Round 7 checks (ops & cleanup): COD override checked on the server, delete override code (L4),
 * unreachable routes (M11), shop-calendar dates (M12), backups (M8), inspection / bill writes (L7),
 * all-or-nothing scanner estimates (L6), invoice total on the work-order page (M16), removed boot
 * backfills. Runs against a RUNNING server and a LOCAL test database.
 *
 *   DATABASE_URL=<local test db> TEST_BASE_URL=http://localhost:5055/api DELETE_OVERRIDE_CODE=… SERVER_LOG=<log> node test/integration/round7.int.js
 */
const path = require('path');
const fs = require('fs');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';
const OVERRIDE = process.env.DELETE_OVERRIDE_CODE;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json()).data?.token;
let TOKEN;
async function api(method, url, body, token = TOKEN, raw = false) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  if (raw) return { status: r.status, ct, size: (await r.arrayBuffer()).byteLength };
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
}

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R7' + Date.now().toString(36);
  const newWO = async () => (await api('POST', '/workorders', { clientName: tag + ' Co' })).body.data.id;

  console.log('\nCOD override is checked on the server');
  await api('PUT', '/settings/cod_override_password', { value: 'Let-Me-In-7' });
  const readClerk = await api('GET', '/settings/cod_override_password', null, CLERK);
  const readAdmin = await api('GET', '/settings/cod_override_password');
  check('a non-admin can no longer read the COD password (was sent to every browser)', readClerk.status === 403 && readAdmin.status === 200, `${readClerk.status} ${readAdmin.status}`);
  const st = await api('GET', '/settings/cod-override-status', null, CLERK);
  check('screens can still ask whether one is configured', st.status === 200 && st.body?.data?.configured === true, JSON.stringify(st.body));
  const W = await newWO();
  const bad = await api('POST', `/workorders/${W}/cod-override`, { password: 'nope' }, CLERK);
  const good = await api('POST', `/workorders/${W}/cod-override`, { password: ' Let-Me-In-7 ', action: 'pickup' }, CLERK);
  check('wrong password → 403, right password → 200', bad.status === 403 && good.status === 200, `${bad.status} ${good.status}`);
  const logs = await q(`SELECT action FROM activity_logs WHERE "resourceId" = $1 AND action LIKE 'cod_override%'`, [W]);
  check('both attempts are in the activity log', logs.length === 2, JSON.stringify(logs));
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await api('POST', `/workorders/${W}/cod-override`, { password: 'guess' + i }, CLERK)).status);
  check('repeated wrong guesses are cut off (429)', tries[tries.length - 1] === 429, tries.join(','));

  console.log('\nDelete override code (L4)');
  check('the test server has DELETE_OVERRIDE_CODE set', !!OVERRIDE);
  const D = await newWO();
  await pg.query(`UPDATE work_orders SET "drNumber" = $1 WHERE id = $2`, [900000 + Math.floor(Math.random() * 99999), D]);
  const noCode = await api('DELETE', `/workorders/${D}`);
  const viaQuery = await api('DELETE', `/workorders/${D}?overrideCode=${encodeURIComponent(OVERRIDE || '')}`);
  const wrong = await api('DELETE', `/workorders/${D}`, { overrideCode: 'CRC-FORCE-DELETEX' });
  const builtIn = OVERRIDE === 'CRC-FORCE-DELETE' ? { status: 'n/a' } : await api('DELETE', `/workorders/${D}`, { overrideCode: 'CRC-FORCE-DELETE' });
  check('no code → "void it instead"; a code in the query string is ignored', noCode.status === 400 && viaQuery.status === 400, `${noCode.status} ${viaQuery.status}`);
  check('a wrong code → 403', wrong.status === 403 && (builtIn.status === 'n/a' || builtIn.status === 403), `${wrong.status} ${builtIn.status}`);
  const right = await api('DELETE', `/workorders/${D}`, { overrideCode: OVERRIDE });
  check('the configured code in the body works', right.status === 200, `${right.status} ${right.body?.error?.message}`);

  console.log('\nRoutes that could not be reached (M11)');
  const arch = await api('GET', '/workorders/archived');
  check('GET /workorders/archived works (was "Work order not found")', arch.status === 200 && Array.isArray(arch.body?.data || arch.body?.data?.rows || []), `${arch.status} ${JSON.stringify(arch.body).slice(0, 80)}`);
  const blank = await api('GET', '/workorders/blank-shipper', null, TOKEN, true);
  check('GET /workorders/blank-shipper returns the PDF', blank.status === 200 && /pdf/.test(blank.ct) && blank.size > 500, `${blank.status} ${blank.ct} ${blank.size}`);
  const loc = await api('POST', '/settings/locations', { name: tag + ' Rack 9' });
  check('adding a location with just a name works (web form always failed)', loc.status === 201 && loc.body?.data?.some(l => l.name === tag + ' Rack 9'), `${loc.status} ${loc.body?.error?.message}`);
  const dl = await api('GET', `/shipments/00000000-0000-0000-0000-000000000000/documents/00000000-0000-0000-0000-000000000000/download`);
  check('the shipment document download route exists', dl.status === 404 && /Document not found/.test(dl.body?.error?.message || ''), `${dl.status} ${dl.body?.error?.message}`);

  console.log('\nShop-calendar dates (M12)');
  const wk = await api('GET', '/operations/production?start=2026-10-05');
  check('the production week starts at midnight Monday Pacific (07:00 UTC in October)', wk.body?.data?.weekStart === '2026-10-05T07:00:00.000Z', wk.body?.data?.weekStart);
  const wk2 = await api('GET', '/operations/production?start=2026-11-02');
  check('…and at 08:00 UTC after the clocks change', wk2.body?.data?.weekStart === '2026-11-02T08:00:00.000Z' && wk2.body?.data?.weekEnd === '2026-11-09T08:00:00.000Z', JSON.stringify(wk2.body?.data && [wk2.body.data.weekStart, wk2.body.data.weekEnd]));
  const shopTime = require(path.join(__dirname, '../../src/utils/shopTime'));
  const todayPT = shopTime.shopDate();
  const S1 = await newWO(), S2 = await newWO();
  await pg.query(`UPDATE work_orders SET "promisedDate" = $1, status = 'processing' WHERE id = $2`, [todayPT, S1]);
  await pg.query(`UPDATE work_orders SET "promisedDate" = $1, status = 'processing' WHERE id = $2`, [shopTime.addDays(todayPT, -1), S2]);
  const sch = await api('GET', '/operations/schedule?all=1');
  const r1 = (sch.body?.data || []).find(r => r.id === S1), r2 = (sch.body?.data || []).find(r => r.id === S2);
  check('due today shows "today" and not overdue; due yesterday is overdue', r1 && r1.promisedStatus === 'today' && !r1.isOverdue && r2 && r2.promisedStatus === 'overdue' && r2.isOverdue, JSON.stringify([r1 && [r1.promisedStatus, r1.isOverdue], r2 && [r2.promisedStatus, r2.isOverdue]]));

  console.log('\nBackups (M8)');
  await pg.query(`INSERT INTO deletion_archive (id, "modelName", "recordId", snapshot, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'Test', $1, '{}', now(), now())`, [tag]).catch(async () => {
    await pg.query(`INSERT INTO deletion_archive (id, "modelName", "recordId", snapshot, "deletedAt") VALUES (gen_random_uuid(), 'Test', $1, '{}', now())`, [tag]);
  });
  const bk = await api('GET', '/backup');
  const d = bk.body?.data || {};
  check('the backup now includes the deletion archive, scanned paperwork, convert queue and device tokens', ['deletionArchive', 'inboundPaperwork', 'convertQueueItems', 'deviceTokens'].every(k => Array.isArray(d[k])) && d.deletionArchive.some(r => r.recordId === tag), Object.keys(d).length);
  check('…and says which tables it holds only in part', Array.isArray(bk.body?.partialTables) && bk.body.partialTables.includes('activityLogs'));

  console.log('\nInspection and bill writes (L7)');
  const IW = await newWO();
  const ip = (await api('POST', `/workorders/${IW}/parts`, { partType: 'plate_roll', quantity: 1 })).body.data.id;
  const [job] = await q(`INSERT INTO inspection_jobs (id, "workOrderId", "workOrderPartId", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id`, [IW, ip]);
  const [unit] = await q(`INSERT INTO inspection_units (id, "inspectionJobId", sequence, "unitId", "preRoll", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 1, 'U1', '{"thickness":0.5,"diagA":100,"diagB":100.1}', now(), now()) RETURNING id`, [job.id]);
  // the tablet clears a measurement by leaving it out of the full object it sends
  const pu = await api('PATCH', `/inspections/unit/${unit.id}`, { preRoll: { thickness: 0.5, widthEnd1: 48 } });
  const [u2] = await q(`SELECT "preRoll" FROM inspection_units WHERE id = $1`, [unit.id]);
  check('a tablet save replaces the measurement set, so an erased value stays erased', pu.status === 200 && u2.preRoll.thickness === 0.5 && u2.preRoll.widthEnd1 === 48 && u2.preRoll.diagA === undefined, `${pu.status} ${JSON.stringify(u2.preRoll)}`);
  const junk = await api('PATCH', `/inspections/unit/${unit.id}`, { preRoll: 'oops' });
  check('a non-object measurement payload is refused instead of saved', junk.status === 400, junk.status);
  const bill = await api('POST', '/business/liabilities', { name: tag + ' bill', amount: 99, category: 'other', status: 'paid', paidAt: new Date().toISOString(), paidAmount: 99 });
  const [bRow] = await q(`SELECT status, "paidAt", "paidAmount" FROM liabilities WHERE name = $1`, [tag + ' bill']);
  check('a bill can\'t be created already marked paid (that goes through Pay)', bill.status === 200 && bRow.status !== 'paid' && !bRow.paidAt, JSON.stringify(bRow));

  console.log('\nScanner estimates are all-or-nothing (L6)');
  const scanner = require(path.join(__dirname, '../../src/services/emailScanner'));
  const estNo = 'EST-' + tag;
  const res = await scanner.createEstimateFromParsed(
    { referenceNumber: estNo, parts: [{ partType: 'plate_roll', quantity: 1, material: 'A36' }, { partType: 'not_a_real_type', quantity: 1 }] },
    { clientName: tag + ' Co', clientId: null }, { id: null, gmailLink: null, from: 'x@example.com' }, []);
  const left = await q(`SELECT id FROM estimates WHERE "estimateNumber" = $1`, [estNo]);
  check('a failure on the 2nd part leaves no half-built estimate', !!res.error && left.length === 0, `${JSON.stringify(res)} left=${left.length}`);

  console.log('\nInvoice total on the work-order page (M16)');
  const T = await newWO();
  await api('POST', `/workorders/${T}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 250, laborTotal: 250 });
  const tot = await api('GET', `/workorders/${T}/invoice-totals`);
  check('GET /workorders/:id/invoice-totals returns the shared invoice figure', tot.status === 200 && typeof tot.body?.data?.amount === 'number' && tot.body.data.amount >= 250, JSON.stringify(tot.body?.data && { amount: tot.body.data.amount, grand: tot.body.data.grandTotal }));

  console.log('\nBoot');
  const logPath = process.env.SERVER_LOG;
  const log = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  check('no more failing "backfill" lines at boot', logPath ? !/(vendorEstimateNumber|clientPartNumber|heatNumber) backfill:/.test(log) : true, logPath || 'no SERVER_LOG');

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
