/**
 * Round 8 (Recovery): every delete is snapshotted and can be undone as a group; files stay in
 * storage while a snapshot can still bring them back; snapshots expire; a backup restore is
 * all-or-nothing. Runs against a RUNNING server and a LOCAL test database.
 *
 *   DATABASE_URL=<local test db> TEST_BASE_URL=http://localhost:5055/api node test/integration/undo.int.js
 */
const path = require('path');
const crypto = require('crypto');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';
process.env.FILE_RECHECK_MS = process.env.FILE_RECHECK_MS || '500';   // in-process file re-check runs quickly here

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
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
  const tag = 'R8' + Date.now().toString(36);
  const newWO = async () => (await api('POST', '/workorders', { clientName: tag + ' Co' })).body.data.id;
  const addPart = async (W) => (await api('POST', `/workorders/${W}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 100, laborTotal: 100 })).body.data.id;
  const parts = async (W) => q(`SELECT id, "partNumber" FROM work_order_parts WHERE "workOrderId" = $1 ORDER BY "partNumber"`, [W]);
  const entriesFor = async (recordId) => q(`SELECT * FROM deletion_archive WHERE "recordId" = $1 ORDER BY "createdAt" DESC`, [String(recordId)]);

  console.log('\nDelete a work order, then Undo');
  const W = await newWO();
  const P = []; for (let i = 0; i < 4; i++) P.push(await addPart(W));
  const fileSid = `undo-test/${tag}/print.pdf`, docSid = `undo-test/${tag}/po.pdf`;
  const F = crypto.randomUUID(), D = crypto.randomUUID();
  await pg.query(`INSERT INTO work_order_part_files (id, "workOrderPartId", "fileType", filename, url, "cloudinaryId", "createdAt", "updatedAt") VALUES ($1,$2,'print','print.pdf','http://x/print.pdf',$3,now(),now())`, [F, P[0], fileSid]);
  await pg.query(`INSERT INTO work_order_documents (id, "workOrderId", "originalName", url, "cloudinaryId", "createdAt", "updatedAt") VALUES ($1,$2,'po.pdf','http://x/po.pdf',$3,now(),now())`, [D, W, docSid]);
  const msg = await api('POST', `/workorders/${W}/messages`, { body: 'call before delivery' });
  const E = (await api('POST', '/estimates', { clientName: tag + ' Co' })).body.data.id;
  await pg.query(`UPDATE work_orders SET "estimateId" = $1 WHERE id = $2`, [E, W]);
  await pg.query(`UPDATE estimates SET "workOrderId" = $1, status = 'converted' WHERE id = $2`, [W, E]);
  await require('../../src/services/invoiceTotals').refreshStoredTotals(W);
  const before = (await q(`SELECT "grandTotal", "clientName", "orderNumber" FROM work_orders WHERE id = $1`, [W]))[0];

  const del = await api('DELETE', `/workorders/${W}`, { reason: 'test delete' });
  check('work order deleted', del.status === 200 && !(await q(`SELECT 1 FROM work_orders WHERE id = $1`, [W])).length, del.status);
  const [woEntry] = await entriesFor(W);
  check('a snapshot of the order was taken, with who and why', woEntry && woEntry.tableName === 'work_orders' && woEntry.deletedBy === 'boss' && woEntry.reason === 'test delete', JSON.stringify(woEntry && { t: woEntry.tableName, by: woEntry.deletedBy, r: woEntry.reason }));
  const group = await q(`SELECT "modelName", "storageIds", snapshot FROM deletion_archive WHERE "groupId" = $1`, [woEntry.groupId]);
  const kinds = group.map(g => g.modelName);
  check('its parts, part files and documents are in the same group', kinds.filter(k => k === 'WorkOrderPart').length === 4 && kinds.includes('WorkOrderPartFile') && kinds.includes('WorkOrderDocument'), kinds.join(','));
  check('rows the database removed with it (messages) are captured too', msg.status < 300 && (woEntry.snapshot.cascade?.work_order_messages || []).length === 1, JSON.stringify(Object.keys(woEntry.snapshot.cascade || {})));
  const sids = group.flatMap(g => g.storageIds || []);
  check('the snapshot remembers its stored files', sids.includes(fileSid) && sids.includes(docSid), sids.join(','));
  const fileRefs = require('../../src/services/fileRefs');
  check('…so those files count as still in use (not deleted from storage)', (await fileRefs.countReferences(fileSid)) >= 1 && (await fileRefs.countReferences(docSid)) >= 1);
  check('the estimate was unlinked by the delete', (await q(`SELECT "workOrderId" FROM estimates WHERE id = $1`, [E]))[0].workOrderId === null);

  const clerkList = await api('GET', '/deletion-archive', null, CLERK);
  const list = await api('GET', `/deletion-archive?search=${encodeURIComponent(before.orderNumber || tag)}`);
  check('Deleted Items is admin-only', clerkList.status === 403, clerkList.status);
  const row = (list.body?.data || []).find(r => r.recordId === String(W));
  check('the list shows it as undoable, with its group', row && row.undoable === true && row.groupId === woEntry.groupId, JSON.stringify(row || list.body).slice(0, 200));
  const clerkUndo = await api('POST', `/deletion-archive/${woEntry.id}/undo`, null, CLERK);
  check('a non-admin cannot undo', clerkUndo.status === 403, clerkUndo.status);

  const un = await api('POST', `/deletion-archive/${woEntry.id}/undo`);
  check('Undo succeeds', un.status === 200 && un.body?.data?.restored >= 7, `${un.status} ${JSON.stringify(un.body)}`);
  const back = (await q(`SELECT "grandTotal", "clientName", "orderNumber", "estimateId" FROM work_orders WHERE id = $1`, [W]))[0];
  check('the order is back exactly as it was', back && back.clientName === before.clientName && back.orderNumber === before.orderNumber && String(back.grandTotal) === String(before.grandTotal), JSON.stringify({ before, back }));
  const ps = await parts(W);
  check('all 4 parts are back, numbered 1–4 in their original order', ps.map(p => p.partNumber).join() === '1,2,3,4' && ps.map(p => p.id).join() === P.join(), JSON.stringify(ps));
  check('the part file, document and message are back', (await q(`SELECT 1 FROM work_order_part_files WHERE id = $1`, [F])).length === 1
    && (await q(`SELECT 1 FROM work_order_documents WHERE id = $1`, [D])).length === 1
    && (await q(`SELECT 1 FROM work_order_messages WHERE "workOrderId" = $1`, [W])).length === 1);
  const est = (await q(`SELECT "workOrderId", status FROM estimates WHERE id = $1`, [E]))[0];
  check('the estimate is linked back to the order', est.workOrderId === W && est.status === 'converted', JSON.stringify(est));
  const marked = await q(`SELECT COUNT(*)::int n FROM deletion_archive WHERE "groupId" = $1 AND "restoredAt" IS NOT NULL AND "restoredBy" = 'boss'`, [woEntry.groupId]);
  check('the whole group is marked restored (by whom)', marked[0].n === group.length, `${marked[0].n}/${group.length}`);
  const again = await api('POST', `/deletion-archive/${woEntry.id}/undo`);
  check('undoing twice → 409 "already undone"', again.status === 409 && /already/.test(again.body?.error?.message || ''), `${again.status} ${again.body?.error?.message}`);

  console.log('\nDelete one part, then Undo (line numbers)');
  const delP = await api('DELETE', `/workorders/${W}/parts/${P[1]}`);
  const afterDel = await parts(W);
  check('part #2 deleted and the rest renumbered 1–3', delP.status === 200 && afterDel.map(p => p.partNumber).join() === '1,2,3', JSON.stringify(afterDel));
  const [pEntry] = await entriesFor(P[1]);
  const unP = await api('POST', `/deletion-archive/${pEntry.id}/undo`);
  const afterUndo = await parts(W);
  check('Undo slots it back in as #2, the others move down again', unP.status === 200 && afterUndo.map(p => p.id).join() === P.join() && afterUndo.map(p => p.partNumber).join() === '1,2,3,4', `${unP.status} ${unP.body?.error?.message} ${JSON.stringify(afterUndo)}`);
  const tot = (await q(`SELECT "grandTotal" FROM work_orders WHERE id = $1`, [W]))[0];
  check('the stored order total is recomputed after the part comes back', String(tot.grandTotal) === String(before.grandTotal), `${tot.grandTotal} vs ${before.grandTotal}`);

  console.log('\nA part whose order is also deleted');
  await api('DELETE', `/workorders/${W}/parts/${P[2]}`);
  const [p3Entry] = await entriesFor(P[2]);
  await api('DELETE', `/workorders/${W}`, {});
  const orphan = await api('POST', `/deletion-archive/${p3Entry.id}/undo`);
  check('undoing the part alone → 409 "undo that deletion first", nothing changed', orphan.status === 409 && /Undo that deletion first/.test(orphan.body?.error?.message || '') && !(await q(`SELECT 1 FROM work_order_parts WHERE id = $1`, [P[2]])).length, `${orphan.status} ${orphan.body?.error?.message}`);
  const [wo2] = await entriesFor(W);
  const unW = await api('POST', `/deletion-archive/${wo2.id}/undo`);
  const unP3 = await api('POST', `/deletion-archive/${p3Entry.id}/undo`);
  const final = await parts(W);
  check('undo the order, then the part → both back, numbering intact', unW.status === 200 && unP3.status === 200 && final.length === 4 && final.map(p => p.partNumber).join() === '1,2,3,4' && final[2].id === P[2], `${unW.status} ${unP3.status} ${JSON.stringify(final)}`);

  console.log('\nA conflicting undo changes nothing');
  const W3 = await newWO();
  const dr = 990000 + Math.floor(Math.random() * 9999);
  await pg.query(`UPDATE work_orders SET "orderNumber" = $1 WHERE id = $2`, [tag + '-ON', W3]);
  await api('DELETE', `/workorders/${W3}`, {});
  const [w3Entry] = await entriesFor(W3);
  const W4 = await newWO();
  await pg.query(`UPDATE work_orders SET "orderNumber" = $1 WHERE id = $2`, [tag + '-ON', W4]);   // same order number reused
  const hasUnique = (await q(`SELECT 1 FROM pg_indexes WHERE tablename='work_orders' AND indexdef ILIKE '%UNIQUE%"orderNumber"%'`)).length > 0;
  const conflict = await api('POST', `/deletion-archive/${w3Entry.id}/undo`);
  if (hasUnique) check('order number reused since → 409 explaining why; nothing restored', conflict.status === 409 && /same value/.test(conflict.body?.error?.message || '') && !(await q(`SELECT 1 FROM work_orders WHERE id = $1`, [W3])).length, `${conflict.status} ${conflict.body?.error?.message}`);
  else check('(no unique order number rule — undo goes through)', conflict.status === 200, conflict.status);
  void dr;

  console.log('\nBulk delete is one group');
  const s1 = (await api('POST', '/shipments', { clientName: tag + ' Co', description: 'plate A' })).body.data.shipment.id;
  const s2 = (await api('POST', '/shipments', { clientName: tag + ' Co', description: 'plate B' })).body.data.shipment.id;
  const bulk = await api('POST', '/shipments/bulk-delete', { ids: [s1, s2] });
  const [e1] = await entriesFor(s1); const [e2] = await entriesFor(s2);
  check('both shipments snapshotted in one group', bulk.status === 200 && e1 && e2 && e1.groupId === e2.groupId, `${bulk.status} ${e1?.groupId} ${e2?.groupId}`);
  const unS = await api('POST', `/deletion-archive/${e1.id}/undo`);
  check('one Undo brings both back', unS.status === 200 && (await q(`SELECT COUNT(*)::int n FROM shipments WHERE id IN ($1,$2)`, [s1, s2]))[0].n === 2, `${unS.status} ${unS.body?.error?.message}`);

  console.log('\nOlder snapshots (before Undo existed)');
  const legacy = (await q(`INSERT INTO deletion_archive (id, "modelName", "recordId", label, snapshot, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'WorkOrder', 'legacy-${tag}', 'old', '{"id":"x"}', now(), now()) RETURNING id`))[0].id;
  const lu = await api('POST', `/deletion-archive/${legacy}/undo`);
  check('are view-only: undo explains it can\'t restore them', lu.status === 400 && /older snapshot/.test(lu.body?.error?.message || ''), `${lu.status} ${lu.body?.error?.message}`);

  console.log('\nSnapshots expire');
  const T = await newWO();
  await api('DELETE', `/workorders/${T}`, {});
  const [tEntry] = await entriesFor(T);
  await pg.query(`UPDATE deletion_archive SET "createdAt" = now() - interval '100 days', "storageIds" = ARRAY[$2]::text[] WHERE id = $1`, [tEntry.id, `undo-test/${tag}/expired.pdf`]);
  const undo = require('../../src/services/undo');
  const purged = await undo.purgeExpired({ days: 90 });
  check('purgeExpired removes snapshots past the retention period', purged.purged >= 1 && !(await q(`SELECT 1 FROM deletion_archive WHERE id = $1`, [tEntry.id])).length, JSON.stringify(purged));
  check('…and recent ones stay', (await q(`SELECT 1 FROM deletion_archive WHERE id = $1`, [woEntry.id])).length === 1);
  check('a file whose snapshot expired no longer counts as in use', (await fileRefs.countReferences(`undo-test/${tag}/expired.pdf`)) === 0);

  console.log('\nLinks the database cleared are put back');
  const WL = await newWO();
  const shipL = (await api('POST', '/shipments', { clientName: tag + ' Co', description: 'linked' })).body.data.shipment.id;
  await pg.query(`UPDATE shipments SET "workOrderId" = $1 WHERE id = $2`, [WL, shipL]);
  await api('DELETE', `/workorders/${WL}`, {});
  check('deleting the order cleared the shipment\'s link (ON DELETE SET NULL)', (await q(`SELECT "workOrderId" FROM shipments WHERE id = $1`, [shipL]))[0].workOrderId === null);
  const [wlEntry] = await entriesFor(WL);
  const unL = await api('POST', `/deletion-archive/${wlEntry.id}/undo`);
  check('Undo links the shipment to the order again', unL.status === 200 && (await q(`SELECT "workOrderId" FROM shipments WHERE id = $1`, [shipL]))[0].workOrderId === WL, `${unL.status} ${unL.body?.error?.message}`);

  console.log('\nBackground jobs, uploads and large deletes');
  const models = require('../../src/models');
  const undoSvc = require('../../src/services/undo');
  undoSvc.registerUndoHooks(models);
  const mkTodos = async (n, title) => (await q(`INSERT INTO todo_items (id, title, "createdAt", "updatedAt") SELECT gen_random_uuid(), $1 || g, now(), now() FROM generate_series(1, $2) g RETURNING id`, [title, n])).map(r => r.id);
  const [ta, tb] = await mkTodos(2, tag + '-cron-');
  await undoSvc.withUndoGroup(async () => {
    await models.TodoItem.destroy({ where: { id: ta } });
    await models.TodoItem.destroy({ where: { id: tb } });
  }, { by: 'system' });
  const [ea] = await entriesFor(ta); const [eb] = await entriesFor(tb);
  check('a background job\'s deletes form one group, recorded as "system"', ea && eb && ea.groupId === eb.groupId && ea.deletedBy === 'system', JSON.stringify([ea?.groupId, eb?.groupId, ea?.deletedBy]));

  // multer finishes in a stream callback: the request's group must survive it
  const express = require(path.join(__dirname, '../../node_modules/express'));
  undoSvc.keepContextThroughMulter();
  const multer = require(path.join(__dirname, '../../node_modules/multer'));
  const app = express(); app.use(undoSvc.requestContext);
  let seen = null;
  app.post('/v', multer().none(), (req, res) => { seen = undoSvc.currentGroup(); res.json({}); });
  const srv = app.listen(0); const port = srv.address().port;
  const fd = new FormData(); fd.append('a', '1');
  await fetch(`http://localhost:${port}/v`, { method: 'POST', body: fd });
  srv.close();
  check('an upload route (multer) keeps the request\'s undo group', !!seen, String(seen));

  const many = await mkTodos(60, tag + '-bulk-');
  await models.TodoItem.destroy({ where: { id: many } });
  const combined = await q(`SELECT id, label, jsonb_array_length(snapshot->'rows') AS n FROM deletion_archive WHERE snapshot->'rows' @> $1::jsonb`, [JSON.stringify([{ id: many[0] }])]);
  check('a 60-row bulk delete is kept as one entry holding every row', combined.length === 1 && combined[0].n === 60, JSON.stringify(combined));
  const unMany = await api('POST', `/deletion-archive/${combined[0].id}/undo`);
  check('…and Undo brings all 60 back', unMany.status === 200 && (await q(`SELECT COUNT(*)::int n FROM todo_items WHERE id = ANY($1)`, [many]))[0].n === 60, `${unMany.status} ${unMany.body?.error?.message}`);

  console.log('\nOlder snapshots and odd cases');
  const WD = await newWO();
  await api('DELETE', `/workorders/${WD}`, {});
  const [wdEntry] = await entriesFor(WD);
  await pg.query(`UPDATE deletion_archive SET snapshot = snapshot #- '{row,priority}' WHERE id = $1`, [wdEntry.id]);   // as if "priority" were added after the delete
  const unD = await api('POST', `/deletion-archive/${wdEntry.id}/undo`);
  const pr = (await q(`SELECT priority FROM work_orders WHERE id = $1`, [WD]))[0];
  check('a column added since the snapshot gets its default (not NULL)', unD.status === 200 && pr?.priority === 'normal', `${unD.status} ${unD.body?.error?.message} ${JSON.stringify(pr)}`);
  const [tc] = await mkTodos(1, tag + '-phantom-');
  await models.TodoItem.destroy({ where: { id: tc } });
  const [tcEntry] = await entriesFor(tc);
  await pg.query(`INSERT INTO todo_items SELECT * FROM jsonb_populate_record(NULL::todo_items, $1::jsonb)`, [JSON.stringify(tcEntry.snapshot.row)]);   // as if the delete had failed
  const unC = await api('POST', `/deletion-archive/${tcEntry.id}/undo`);
  check('undoing a delete that never went through says so (nothing changed)', unC.status === 200 && unC.body?.data?.alreadyThere === true && /Nothing needed restoring/.test(unC.body?.message || ''), JSON.stringify(unC.body));
  const pct = await api('GET', `/deletion-archive?search=${encodeURIComponent('100%')}`);
  check('search treats % literally', pct.status === 200 && (pct.body.data || []).every(r => /100%/.test(`${r.label} ${r.recordId} ${r.deletedBy} ${r.reason}`)), pct.body?.data?.length);

  console.log('\nFiles of a deleted record are checked again after the delete');
  const storage = require('../../src/utils/storage');
  const removed = []; storage.deleteFile = async (id) => { removed.push(id); };
  const delSid = `undo-test/${tag}/orphan.pdf`;
  const r1 = await fileRefs.deleteStoredFileIfUnused(delSid, { exclude: [{ table: 'work_order_documents', id: crypto.randomUUID() }] });
  await new Promise(r => setTimeout(r, 1500));
  check('a file kept "for undo" whose snapshot never appeared is removed on the re-check (no leak)', r1 === false && removed.includes(delSid), JSON.stringify(removed));
  const keptSid = fileSid;   // referenced by the restored part file row
  await fileRefs.deleteStoredFileIfUnused(keptSid, { exclude: [{ table: 'work_order_part_files', id: crypto.randomUUID() }] });
  await new Promise(r => setTimeout(r, 1500));
  check('…while a file still in use survives the re-check', !removed.includes(keptSid), JSON.stringify(removed));
  const types = []; storage.deleteFile = async (id, type) => { removed.push(id); types.push(`${id}|${type}`); };
  const [tx] = await mkTodos(1, tag + '-imgexp-');
  await models.TodoItem.destroy({ where: { id: tx } });
  const [txEntry] = await entriesFor(tx);
  const imgSid = `undo-test/${tag}/photo.jpg`;
  await pg.query(`UPDATE deletion_archive SET "createdAt" = now() - interval '100 days', "storageIds" = ARRAY[$2]::text[] WHERE id = $1`, [txEntry.id, imgSid]);
  await undoSvc.purgeExpired({ days: 90 });
  check('an expired snapshot\'s files are removed whether stored as images or documents', types.includes(`${imgSid}|raw`) && types.includes(`${imgSid}|image`), JSON.stringify(types));
  const badG = await api('GET', '/deletion-archive?groupId=nope');
  check('a malformed groupId → 400 (not a server error)', badG.status === 400, badG.status);

  console.log('\nBackup restore is all-or-nothing');
  const lockHolder = new PG({ connectionString: DB }); await lockHolder.connect();
  await lockHolder.query('BEGIN'); await lockHolder.query('SELECT pg_advisory_xact_lock(8410100)');
  const blocked = await api('POST', '/backup/restore', { options: {}, backup: { data: { clients: [] } } });
  await lockHolder.query('ROLLBACK'); await lockHolder.end();
  check('a second restore (e.g. on another dyno) is refused while one runs', blocked.status === 409, `${blocked.status} ${blocked.body?.error?.message}`);
  const drBefore = (await q(`SELECT COUNT(*)::int n FROM dr_numbers`))[0].n;
  const woBefore = (await q(`SELECT COUNT(*)::int n FROM work_orders`))[0].n;
  const cid = crypto.randomUUID();
  const broken = await api('POST', '/backup/restore', { options: { clearExisting: true }, backup: { data: {
    clients: [{ id: cid, name: tag + ' Restored Client', createdAt: new Date(), updatedAt: new Date() }],
    drNumbers: [{ id: crypto.randomUUID(), drNumber: 997000 + Math.floor(Math.random() * 999), status: 'active', createdAt: new Date(), updatedAt: new Date() }],
    shipments: 5,   // malformed section part-way through → the restore fails
  } } });
  check('a restore that fails part-way → error saying it was rolled back', broken.status === 500 && /rolled back/.test(broken.body?.error?.message || ''), `${broken.status} ${broken.body?.error?.message}`);
  check('…and the tables it had already cleared and refilled are exactly as before',
    (await q(`SELECT COUNT(*)::int n FROM dr_numbers`))[0].n === drBefore && !(await q(`SELECT 1 FROM clients WHERE id = $1`, [cid])).length && (await q(`SELECT COUNT(*)::int n FROM work_orders`))[0].n === woBefore,
    `dr ${drBefore}→${(await q(`SELECT COUNT(*)::int n FROM dr_numbers`))[0].n}`);
  const integ = await q(`SELECT conname FROM pg_constraint WHERE conname IN ('uq_wop_part_number','uq_ep_part_number')`);
  check('the integrity rules lifted for the restore are back afterwards', integ.length === 2, JSON.stringify(integ));
  const ok = await api('POST', '/backup/restore', { options: { clearExisting: false }, backup: { data: {
    clients: [{ id: cid, name: tag + ' Restored Client', createdAt: new Date(), updatedAt: new Date() }] } } });
  check('a good restore still commits', ok.status === 200 && (await q(`SELECT 1 FROM clients WHERE id = $1`, [cid])).length === 1, `${ok.status} ${ok.body?.error?.message}`);
  check('a restore does not fill Deleted Items', !(await q(`SELECT 1 FROM deletion_archive WHERE "createdAt" > now() - interval '1 minute' AND "modelName" = 'DRNumber'`)).length);

  await pg.end();
  await require('../../src/models').sequelize.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
