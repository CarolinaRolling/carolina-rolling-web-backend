/**
 * Round 6 checks (data integrity): M1 (renames / merges reach every record), M2 (foreign keys),
 * M3 (unique rules), M4 (status rules), M5 (estimate / order numbers), M14 (part numbers),
 * M17 (duplicate constraints). Runs against a RUNNING server and a LOCAL test database.
 *
 *   DATABASE_URL=<local test db> TEST_BASE_URL=http://localhost:5055/api node test/integration/round6.int.js
 */
const path = require('path');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json()).data?.token;
let TOKEN;
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
}
const sqlFails = async (pg, sql, params) => { try { await pg.query(sql, params); return null; } catch (e) { return e; } };

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const tag = 'R6' + Date.now().toString(36);

  console.log('\nM17 — duplicate constraints from schema sync');
  const dupes = await q(`SELECT COUNT(*)::int n FROM (SELECT conrelid, contype, pg_get_constraintdef(oid) d FROM pg_constraint WHERE contype IN ('u','f') GROUP BY 1,2,3 HAVING COUNT(*) > 1) x`);
  check('no table has two identical unique / foreign-key constraints after boot', dupes[0].n === 0, `${dupes[0].n} groups`);

  console.log('\nM5 — estimate and work-order numbers');
  const ests = await Promise.all(Array.from({ length: 25 }, () => api('POST', '/estimates', { clientName: tag + ' Co' })));
  const estNums = ests.map(r => r.body?.data?.estimateNumber);
  check('25 estimates created at once all succeed with different numbers', ests.every(r => r.status === 201) && new Set(estNums).size === 25, ests.map(r => r.status).join(','));
  check('numbers keep the EST-YYMMDD-NNN look', estNums.every(n => /^EST-\d{6}-\d{3,}$/.test(n || '')), estNums.slice(0, 3).join(' '));
  const wos = await Promise.all(Array.from({ length: 15 }, () => api('POST', '/workorders', { clientName: tag + ' Co' })));
  const woNums = wos.map(r => r.body?.data?.orderNumber);
  check('15 work orders created at once get 15 different WO numbers', wos.every(r => r.status === 201) && new Set(woNums).size === 15 && woNums.every(n => /^WO-\d{6}-\d{3,}$/.test(n || '')), woNums.slice(0, 2).join(' '));

  console.log('\nM14 — part numbers');
  const W = wos[0].body.data.id;
  const adds = await Promise.all(Array.from({ length: 10 }, () => api('POST', `/workorders/${W}/parts`, { partType: 'fab_service', quantity: 1 })));
  const nums = (await q(`SELECT "partNumber" n FROM work_order_parts WHERE "workOrderId" = $1 ORDER BY 1`, [W])).map(r => r.n);
  check('10 parts added at once → numbers 1–10, no repeats', adds.every(r => r.status === 201) && nums.join(',') === '1,2,3,4,5,6,7,8,9,10', `${adds.map(r => r.status)} → ${nums}`);
  const third = (await q(`SELECT id FROM work_order_parts WHERE "workOrderId" = $1 AND "partNumber" = 3`, [W]))[0].id;
  await api('DELETE', `/workorders/${W}/parts/${third}`);
  await api('POST', `/workorders/${W}/parts`, { partType: 'fab_service', quantity: 1 });
  const nums2 = (await q(`SELECT "partNumber" n FROM work_order_parts WHERE "workOrderId" = $1 ORDER BY 1`, [W])).map(r => r.n);
  check('delete #3 then add → 1–10 again (count+1 used to repeat a number)', nums2.join(',') === '1,2,3,4,5,6,7,8,9,10', nums2.join(','));
  const ids = (await q(`SELECT id FROM work_order_parts WHERE "workOrderId" = $1 ORDER BY "partNumber"`, [W])).map(r => r.id);
  const re = await api('PUT', `/workorders/${W}/parts/reorder`, { partIds: [ids[1], ids[0]] });   // swap 1 and 2, list only those two
  const after = await q(`SELECT id, "partNumber" n FROM work_order_parts WHERE "workOrderId" = $1`, [W]);
  const numOf = Object.fromEntries(after.map(r => [r.id, r.n]));
  check('reorder swaps 1↔2 and leaves the rest unique', re.status === 200 && numOf[ids[1]] === 1 && numOf[ids[0]] === 2 && new Set(after.map(r => r.n)).size === after.length, JSON.stringify(after.map(r => r.n)));
  const clash = await sqlFails(pg, `UPDATE work_order_parts SET "partNumber" = 1 WHERE id = $1`, [ids[5]]);
  check('the database refuses two parts with the same number', clash && clash.code === '23505', clash?.message);
  const insPart = (await api('POST', `/workorders/${W}/parts`, { partType: 'plate_roll', quantity: 1 })).body.data.id;
  await pg.query(`INSERT INTO inspection_jobs (id, "workOrderId", "workOrderPartId", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, now(), now())`, [W, insPart]);
  const insDel = await api('DELETE', `/workorders/${W}/parts/${insPart}`);
  const insLeft = await q(`SELECT 1 FROM inspection_jobs WHERE "workOrderPartId" = $1`, [insPart]);
  check('deleting a part that has an inspection job works and removes the job', insDel.status === 200 && insLeft.length === 0, `${insDel.status} left=${insLeft.length}`);
  const E = ests[0].body.data.id;
  const eAdds = await Promise.all(Array.from({ length: 6 }, () => api('POST', `/estimates/${E}/parts`, { partType: 'fab_service', quantity: 1 })));
  const eNums = (await q(`SELECT "partNumber" n FROM estimate_parts WHERE "estimateId" = $1 ORDER BY 1`, [E])).map(r => r.n);
  check('estimate parts added at once → 1–6', eAdds.every(r => r.status === 201) && eNums.join(',') === '1,2,3,4,5,6', eNums.join(','));

  console.log('\nM3 — unique rules');
  await api('POST', '/clients', { name: tag + ' Steel' });
  const caseDup = await sqlFails(pg, `INSERT INTO clients (id, name, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, now(), now())`, [(tag + ' STEEL ')]);
  check('two clients whose names differ only by case/spaces → refused by the database', caseDup && caseDup.code === '23505', caseDup?.message);
  const [cl] = await q(`SELECT id, name FROM clients WHERE name = $1`, [tag + ' Steel']);
  const [cp] = await q(`INSERT INTO client_payments (id, "clientId", "clientName", "paymentDate", amount, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, current_date, 100, now(), now()) RETURNING id`, [cl.id, cl.name]);
  const W2 = wos[1].body.data.id;
  await pg.query(`INSERT INTO payment_applications (id, "clientPaymentId", "workOrderId", amount, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 50, now(), now())`, [cp.id, W2]);
  const appDup = await sqlFails(pg, `INSERT INTO payment_applications (id, "clientPaymentId", "workOrderId", amount, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 50, now(), now())`, [cp.id, W2]);
  check('the same client payment applied twice to one invoice → refused', appDup && appDup.code === '23505', appDup?.message);

  const W6 = wos[5].body.data.id;
  await api('POST', `/workorders/${W6}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 200, laborTotal: 200 });
  await pg.query(`UPDATE work_orders SET "clientId" = $1, "clientName" = $2 WHERE id = $3`, [cl.id, cl.name, W6]);
  const twice = await api('POST', '/business/client-payments', { clientId: cl.id, clientName: cl.name, amount: 100, applications: [{ workOrderId: W6, amount: 60 }, { workOrderId: W6, amount: 40 }] });
  const apps = await q(`SELECT amount FROM payment_applications WHERE "workOrderId" = $1`, [W6]);
  check('a payment listing the same invoice twice is combined into one application', twice.status < 300 && apps.length === 1 && Math.abs(parseFloat(apps[0].amount) - 100) < 0.01, `${twice.status} ${twice.body?.error?.message} ${JSON.stringify(apps)}`);

  console.log('\nM2 — foreign keys');
  const badFk = await sqlFails(pg, `INSERT INTO client_payments (id, "clientId", "clientName", "paymentDate", amount, "createdAt", "updatedAt") VALUES (gen_random_uuid(), gen_random_uuid(), 'ghost', current_date, 1, now(), now())`);
  check('a payment pointing at a client that doesn\'t exist → refused', badFk && badFk.code === '23503', badFk?.message);
  const [io] = await q(`INSERT INTO inbound_orders (id, "purchaseOrderNumber", description, "clientName", "estimateId", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'x', 'x', $2, 'pending', now(), now()) RETURNING id`, ['PO-' + tag, ests[2].body.data.id]);
  await pg.query(`DELETE FROM estimates WHERE id = $1`, [ests[2].body.data.id]);
  const ioRow = (await q(`SELECT "estimateId" FROM inbound_orders WHERE id = $1`, [io.id]))[0];
  check('deleting an estimate clears the link on its delivery (no dangling id)', ioRow.estimateId === null, JSON.stringify(ioRow));

  console.log('\nM1 — renames and merges reach every record');
  await pg.query(`INSERT INTO shipments (id, "qrCode", "clientName", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'received', now(), now())`, [tag + '-S', cl.name]);
  await pg.query(`INSERT INTO api_keys (id, name, key, "clientName", permissions, "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'portal', $1, $2, 'read', true, now(), now())`, [tag + 'key', cl.name]);
  const newName = tag + ' Steel & Supply';
  const ren = await api('PUT', `/clients/${cl.id}`, { name: newName });
  const [pRow] = await q(`SELECT "clientName" FROM client_payments WHERE id = $1`, [cp.id]);
  const [sRow] = await q(`SELECT "clientName" FROM shipments WHERE "qrCode" = $1`, [tag + '-S']);
  const [kRow] = await q(`SELECT "clientName" FROM api_keys WHERE key = $1`, [tag + 'key']);
  check('a client rename reaches payments, shipments and the portal key', ren.status === 200 && pRow.clientName === newName && sRow.clientName === newName && kRow.clientName === newName, JSON.stringify([ren.status, pRow, sRow, kRow]));
  await api('POST', '/clients', { name: tag + ' Old Dup' });
  const [src] = await q(`SELECT id, name FROM clients WHERE name = $1`, [tag + ' Old Dup']);
  const [cp2] = await q(`INSERT INTO client_payments (id, "clientId", "clientName", "paymentDate", amount, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, current_date, 75, now(), now()) RETURNING id`, [src.id, src.name]);
  const [cm] = await q(`INSERT INTO credit_memos (id, "clientId", "clientName", date, amount, "remainingAmount", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, current_date, 20, 20, now(), now()) RETURNING id`, [src.id, src.name]);
  const mg = await api('POST', `/clients/${cl.id}/merge`, { sourceId: src.id });
  const [p2] = await q(`SELECT "clientId", "clientName" FROM client_payments WHERE id = $1`, [cp2.id]);
  const [c2] = await q(`SELECT "clientId", "clientName" FROM credit_memos WHERE id = $1`, [cm.id]);
  check('a client merge moves payments and credit memos to the kept client', mg.status === 200 && p2.clientId === cl.id && p2.clientName === newName && c2.clientId === cl.id, JSON.stringify([mg.status, mg.body?.error?.message, p2, c2]));
  const v = await api('POST', '/vendors', { name: tag + ' Mill' });
  const vid = v.body?.data?.id;
  const wp = (await api('POST', `/workorders/${W2}/parts`, { partType: 'plate_roll', quantity: 1, vendorId: vid, supplierName: tag + ' Mill' })).body?.data?.id;
  await pg.query(`UPDATE work_order_parts SET "vendorId" = $1, "supplierName" = $2 WHERE id = $3`, [vid, tag + ' Mill', wp]);
  await pg.query(`INSERT INTO inbound_orders (id, "purchaseOrderNumber", description, "clientName", "vendorId", "supplierName", supplier, status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'plate', 'x', $2, $3, $3, 'pending', now(), now())`, ['PO-' + tag + 'V', vid, tag + ' Mill']);
  const vr = await api('PUT', `/vendors/${vid}`, { name: tag + ' Steel Mill' });
  const [pv] = await q(`SELECT "supplierName" FROM work_order_parts WHERE id = $1`, [wp]);
  const [iv] = await q(`SELECT "supplierName", supplier FROM inbound_orders WHERE "purchaseOrderNumber" = $1`, ['PO-' + tag + 'V']);
  check('a vendor rename reaches parts and deliveries (it used to reach nothing)', vr.status === 200 && pv.supplierName === tag + ' Steel Mill' && iv.supplierName === tag + ' Steel Mill' && iv.supplier === tag + ' Steel Mill', JSON.stringify([vr.status, pv, iv]));

  console.log('\nM4 — status rules');
  const W3 = wos[2].body.data.id;
  const bogus = await api('PUT', `/workorders/${W3}/status`, { status: 'finished!!' });
  check('an unknown status → 400 (was stored as-is)', bogus.status === 400, bogus.status);
  await pg.query(`INSERT INTO work_order_presence (id, "workOrderId", "lastHeartbeatAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, now(), now(), now())`, [W3]);
  const st = await api('PUT', `/workorders/${W3}/status`, { status: 'stored' });
  const [w3] = await q(`SELECT status, "completedAt" FROM work_orders WHERE id = $1`, [W3]);
  const pres = await q(`SELECT 1 FROM work_order_presence WHERE "workOrderId" = $1`, [W3]);
  check('tablet "Stored" sets completedAt and clears "In Machine" (as mark-complete does)', st.status === 200 && w3.status === 'stored' && w3.completedAt && pres.length === 0, JSON.stringify([st.status, w3, pres.length]));
  const W4 = wos[3].body.data.id;
  await pg.query(`UPDATE work_orders SET "isVoided" = true WHERE id = $1`, [W4]);
  const onVoid = await api('PUT', `/workorders/${W4}/status`, { status: 'processing' });
  check('changing the status of a voided order → 409', onVoid.status === 409, onVoid.status);
  const unvoid = await api('PUT', `/workorders/${W4}`, { isVoided: false, status: 'processing' });
  check('un-voiding and setting a status in one save is allowed', unvoid.status === 200, `${unvoid.status} ${unvoid.body?.error?.message}`);
  const W5 = wos[4].body.data.id;
  await pg.query(`UPDATE work_orders SET status = 'shipped', "iifExportedAt" = now() WHERE id = $1`, [W5]);
  const back = await api('PUT', `/workorders/${W5}`, { status: 'processing' });
  check('an order in QuickBooks can\'t go back to "processing" → 409', back.status === 409, back.status);
  const fine = await api('PUT', `/workorders/${W5}`, { status: 'archived' });
  check('…but can be archived', fine.status === 200, `${fine.status} ${fine.body?.error?.message}`);
  const eBad = await api('PUT', `/estimates/${E}`, { status: 'sentt' });
  const eConv = await api('PUT', `/estimates/${E}`, { status: 'converted' });
  check('estimate: unknown status → 400, "converted" without converting → 400', eBad.status === 400 && eConv.status === 400, `${eBad.status} ${eConv.status}`);

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
