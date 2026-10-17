/**
 * Round 17 relationship checks (sixth audit, W-series): linking onto a shipped order (W8), the order's
 * DR / PO / delivery / shipment follow a linked estimate's client and back on unlink (W9), deleting a
 * converted estimate with a PO on its order (W19), unlink after delete → merge → Undo (W20), Undo
 * re-resolves vendor ids in JSON lists and shipments' client names (W21), restored part with a clashing
 * lot gets a fresh one (W6).
 * Runs against a RUNNING server and a LOCAL test database.
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
async function call(method, url, body, headers) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN) => call(m, u, b, { Authorization: `Bearer ${t}` });

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const tag = 'R17r' + Date.now().toString(36);
  const tax = (await api('GET', '/settings/tax_settings')).body?.data?.value;
  if (!tax || tax.defaultTaxRate === undefined || tax.defaultTaxRate === null) await api('PUT', '/settings/tax_settings', { value: { ...(tax || {}), defaultTaxRate: 9.5 } });
  const mkClient = async (name) => (await api('POST', '/clients', { name })).body?.data?.id;
  const mkWo = async (name) => (await api('POST', '/workorders', { clientName: name })).body?.data?.id;
  const mkEst = async (name) => {
    const id = (await api('POST', '/estimates', { clientName: name })).body?.data?.id;
    await api('POST', `/estimates/${id}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '5', laborTotal: '5' });
    return id;
  };
  const freeDr = async () => {
    const [{ n }] = await q(`SELECT GREATEST(COALESCE((SELECT MAX("drNumber") FROM dr_numbers), 0), COALESCE((SELECT MAX("drNumber") FROM work_orders), 0)) + 1000 + floor(random() * 1000)::int AS n`);
    return Number(n);
  };
  const archOf = async (table, id) => (await q(`SELECT id FROM deletion_archive WHERE "tableName" = $1 AND "recordId" = $2 AND "restoredAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`, [table, String(id)]))[0]?.id;
  const A = tag + ' Alpha', B = tag + ' Beta';
  const Aid = await mkClient(A), Bid = await mkClient(B);

  console.log('\nLinking onto a shipped order (W8)');
  const S = await mkWo(A);
  await q(`UPDATE work_orders SET status = 'shipped' WHERE id = $1`, [S]);
  const lS = await api('POST', `/workorders/${S}/link-estimate`, { estimateId: await mkEst(A) });
  check('an estimate can be linked to a shipped, not yet invoiced order', lS.status === 200, `${lS.status} ${JSON.stringify(lS.body).slice(0, 160)}`);
  const Ar = await mkWo(A);
  await q(`UPDATE work_orders SET status = 'archived' WHERE id = $1`, [Ar]);
  const lA = await api('POST', `/workorders/${Ar}/link-estimate`, { estimateId: await mkEst(A) });
  check('…but not to an archived one (409)', lA.status === 409, `${lA.status} ${JSON.stringify(lA.body).slice(0, 160)}`);

  console.log('\nThe order\'s DR, PO, delivery and shipment follow the linked estimate\'s client (W9)');
  const W = await mkWo(A);
  const dr = await freeDr(), po = dr + 500000;
  await q(`UPDATE work_orders SET "drNumber" = $2 WHERE id = $1`, [W, dr]);
  await q(`INSERT INTO dr_numbers (id, "drNumber", status, "workOrderId", "clientId", "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $2, 'active', $1, $3, $4, now(), now())`, [W, dr, Aid, A]);
  await q(`INSERT INTO po_numbers (id, "poNumber", status, "workOrderId", "clientId", "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $2, 'active', $1, $3, $4, now(), now())`, [W, po, Aid, A]);
  const [{ id: inb }] = await q(`INSERT INTO inbound_orders (id, "purchaseOrderNumber", description, status, "workOrderId", "clientId", "clientName", "supplierName", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), $2, 'steel', 'pending', $1, $3, $4, 'Supp', now(), now()) RETURNING id`, [W, 'PO' + po, Aid, A]);
  await q(`INSERT INTO shipments (id, "qrCode", "clientName", "workOrderId", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $2, $3, $1, now(), now())`, [W, tag + '-qr1', A]);
  const rows = async () => {
    const r = await q(`SELECT 'dr' AS t, "clientId", "clientName" FROM dr_numbers WHERE "workOrderId" = $1 UNION ALL
      SELECT 'po', "clientId", "clientName" FROM po_numbers WHERE "workOrderId" = $1 UNION ALL
      SELECT 'in', "clientId", "clientName" FROM inbound_orders WHERE "workOrderId" = $1 UNION ALL
      SELECT 'sh', NULL, "clientName" FROM shipments WHERE "workOrderId" = $1`, [W]);
    return r;
  };
  const lk = await api('POST', `/workorders/${W}/link-estimate`, { estimateId: await mkEst(B) });
  const after = await rows();
  check('linking an estimate for another client moves the order\'s DR, PO, delivery and shipment to that client',
    lk.status === 200 && after.length === 4 && after.every(r => r.clientName === B && (r.t === 'sh' || r.clientId === Bid)), `${lk.status} ${JSON.stringify(after)}`);
  const ul = await api('POST', `/workorders/${W}/unlink-estimate`);
  const back = await rows();
  check('…and unlinking moves them back', ul.status === 200 && back.length === 4 && back.every(r => r.clientName === A && (r.t === 'sh' || r.clientId === Aid)), `${ul.status} ${JSON.stringify(back)}`);
  await q(`UPDATE inbound_orders SET "clientName" = 'stale name' WHERE id = $1`, [inb]);
  const cv = await api('POST', `/inbound/${inb}/convert-to-shipment`, {});
  const shName = cv.body?.data?.clientName || (await q(`SELECT "clientName" FROM shipments WHERE id = $1`, [cv.body?.data?.id]))[0]?.clientName;
  check('a shipment made from a delivery takes the order\'s client', [200, 201].includes(cv.status) && shName === A, `${cv.status} ${shName} ${JSON.stringify(cv.body).slice(0, 160)}`);

  console.log('\nDeleting a converted estimate (W19)');
  const E1 = await mkEst(A);
  const cw = await api('POST', `/estimates/${E1}/convert-to-workorder`, {});
  const W1 = cw.body?.data?.workOrder?.id;
  await q(`INSERT INTO po_numbers (id, "poNumber", status, "estimateId", "workOrderId", "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $3, 'active', $1, $2, $4, now(), now())`, [E1, W1, po + 1, A]);
  const d1 = await api('DELETE', `/estimates/${E1}/permanent`);
  check('a converted estimate with an open PO on its work order can be deleted', [200, 201].includes(cw.status) && !!W1 && d1.status === 200, `${cw.status} ${d1.status} ${JSON.stringify(d1.body).slice(0, 160)}`);
  const E2 = await mkEst(A);
  await q(`INSERT INTO po_numbers (id, "poNumber", status, "estimateId", "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $2, 'active', $1, $3, now(), now())`, [E2, po + 2, A]);
  const d2 = await api('DELETE', `/estimates/${E2}/permanent`);
  check('…one with an open PO of its own is still refused (409)', d2.status === 409 && d2.body?.error?.code === 'ESTIMATE_HAS_OPEN_POS', `${d2.status}`);

  console.log('\nUnlink after delete → merge → Undo (W20)');
  const Cn = tag + ' Gamma', Dn = tag + ' Delta';
  const Cid = await mkClient(Cn), Did = await mkClient(Dn);
  const W2 = await mkWo(Dn);
  const lk2 = await api('POST', `/workorders/${W2}/link-estimate`, { estimateId: await mkEst(B) });
  const del2 = await api('DELETE', `/workorders/${W2}`);
  const mg = await api('POST', `/clients/${Cid}/merge`, { sourceId: Did });
  const un2 = await api('POST', `/deletion-archive/${await archOf('work_orders', W2)}/undo`);
  const ul2 = await api('POST', `/workorders/${W2}/unlink-estimate`);
  const w2 = (await q(`SELECT "clientId", "clientName" FROM work_orders WHERE id = $1`, [W2]))[0];
  check('unlinking puts the order on the client its old client was merged into',
    lk2.status === 200 && del2.status === 200 && mg.status === 200 && un2.status === 200 && ul2.status === 200 && w2.clientId === Cid && w2.clientName === Cn,
    `${lk2.status} ${del2.status} ${mg.status} ${un2.status} ${ul2.status} ${JSON.stringify(w2)} ${JSON.stringify(un2.body).slice(0, 160)} ${JSON.stringify(ul2.body).slice(0, 160)}`);

  console.log('\nUndo re-resolves vendors in JSON lists and shipments\' client names (W21)');
  const V1n = tag + ' V-old', V2n = tag + ' V-new';
  const V1 = (await api('POST', '/vendors', { name: V1n })).body?.data?.id;
  const V2 = (await api('POST', '/vendors', { name: V2n })).body?.data?.id;
  const W3 = await mkWo(A);
  const p3 = (await api('POST', `/workorders/${W3}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 10, laborTotal: 10 })).body?.data?.id;
  await q(`UPDATE work_order_parts SET "outsideProcessing" = $2::jsonb WHERE id = $1`, [p3, JSON.stringify([{ vendorId: V1, vendorName: V1n, service: 'galv' }])]);
  await q(`UPDATE work_orders SET "opTransports" = $2::jsonb WHERE id = $1`, [W3, JSON.stringify([{ truckingVendorId: V1, cost: 50 }])]);
  const dp = await api('DELETE', `/workorders/${W3}/parts/${p3}`);
  const dw3 = await api('DELETE', `/workorders/${W3}`);
  const mv = await api('POST', `/vendors/${V2}/merge`, { sourceId: V1 });
  const u3 = await api('POST', `/deletion-archive/${await archOf('work_orders', W3)}/undo`);
  const u3p = await api('POST', `/deletion-archive/${await archOf('work_order_parts', p3)}/undo`);
  const op = (await q(`SELECT "outsideProcessing" AS o FROM work_order_parts WHERE id = $1`, [p3]))[0]?.o;
  const tr = (await q(`SELECT "opTransports" AS o FROM work_orders WHERE id = $1`, [W3]))[0]?.o;
  check('a restored line\'s outside-processing vendor and the order\'s trucking vendor follow the vendor merge',
    dp.status === 200 && dw3.status === 200 && mv.status === 200 && u3.status === 200 && u3p.status === 200
      && op?.[0]?.vendorId === V2 && op?.[0]?.vendorName === V2n && op?.[0]?.service === 'galv' && tr?.[0]?.truckingVendorId === V2 && tr?.[0]?.cost === 50,
    `${dp.status} ${dw3.status} ${mv.status} ${u3.status} ${u3p.status} ${JSON.stringify(op)} ${JSON.stringify(tr)} ${JSON.stringify(u3p.body).slice(0, 160)}`);
  const En = tag + ' Eps', Fn = tag + ' Phi';
  const Eid = await mkClient(En), Fid = await mkClient(Fn);
  const [{ id: sh }] = await q(`INSERT INTO shipments (id, "qrCode", "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id`, [tag + '-qr2', ' ' + En.toLowerCase()]);
  const ds = await api('DELETE', `/shipments/${sh}`);
  const mc = await api('POST', `/clients/${Fid}/merge`, { sourceId: Eid });
  const us = await api('POST', `/deletion-archive/${await archOf('shipments', sh)}/undo`);
  const shRow = (await q(`SELECT "clientName" FROM shipments WHERE id = $1`, [sh]))[0];
  check('a restored shipment\'s client name follows the client merge', ds.status === 200 && mc.status === 200 && us.status === 200 && shRow?.clientName === Fn,
    `${ds.status} ${mc.status} ${us.status} ${JSON.stringify(shRow)} ${JSON.stringify(us.body).slice(0, 160)}`);
  const [{ id: sh2 }] = await q(`INSERT INTO shipments (id, "qrCode", "clientName", "workOrderId", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'old name', $2, now(), now()) RETURNING id`, [tag + '-qr3', W]);
  await api('DELETE', `/shipments/${sh2}`);
  const us2 = await api('POST', `/deletion-archive/${await archOf('shipments', sh2)}/undo`);
  const sh2Row = (await q(`SELECT "clientName" FROM shipments WHERE id = $1`, [sh2]))[0];
  check('…and a restored shipment on an order takes the order\'s client', us2.status === 200 && sh2Row?.clientName === A, `${us2.status} ${JSON.stringify(sh2Row)}`);

  console.log('\nRestored part with a lot now used by another part (W6)');
  const W4 = await mkWo(A);
  const dr4 = await freeDr();
  await q(`UPDATE work_orders SET "drNumber" = $2 WHERE id = $1`, [W4, dr4]);
  const pa = (await api('POST', `/workorders/${W4}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 10, laborTotal: 10 })).body?.data?.id;
  const pb = (await api('POST', `/workorders/${W4}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 10, laborTotal: 10 })).body?.data?.id;
  await q(`UPDATE work_order_parts SET "lotNumber" = $2 WHERE id = $1`, [pa, `${dr4}-1`]);
  await q(`UPDATE work_order_parts SET "lotNumber" = $2 WHERE id = $1`, [pb, `${dr4}-2`]);
  await api('DELETE', `/workorders/${W4}/parts/${pa}`);
  await q(`UPDATE work_order_parts SET "lotNumber" = $2 WHERE id = $1`, [pb, `${dr4}-1`]);   // the lot was handed out again
  const u4 = await api('POST', `/deletion-archive/${await archOf('work_order_parts', pa)}/undo`);
  const lots = (await q(`SELECT id, "lotNumber" FROM work_order_parts WHERE "workOrderId" = $1`, [W4]));
  const la = lots.find(l => l.id === pa)?.lotNumber;
  check('the restored part gets a fresh lot instead of a live duplicate (and Undo says so)',
    u4.status === 200 && lots.length === 2 && la && la !== `${dr4}-1` && la.startsWith(`${dr4}-`) && (u4.body?.data?.notes || u4.body?.notes || []).some(n => String(n).includes(la)),
    `${u4.status} ${JSON.stringify(lots)} ${JSON.stringify(u4.body).slice(0, 200)}`);

  console.log(`\nr17-relations: ${pass} passed, ${fail} failed`);
  await pg.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
