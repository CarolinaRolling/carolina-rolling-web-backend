/**
 * Round 4 checks: H3 (model drift), H8 (deleting invoiced/paid orders), H9 (estimate part input),
 * H12 (receiving material per PO), H13 (shared stored files), H14 (settings), H15 (concurrent part /
 * pickup updates and OP PO links). Runs against a RUNNING server and a LOCAL test database.
 *
 *   DATABASE_URL=<local test db> TEST_BASE_URL=http://localhost:5055/api SERVER_LOG=<server log> node test/integration/round4.int.js
 */
const path = require('path');
const fs = require('fs');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';
const PORTAL_KEY = process.env.TEST_PORTAL_KEY || 'clientportalkey123';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const near = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.005;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json()).data?.token;
let TOKEN;
async function api(method, url, body, token = TOKEN, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
}

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R4' + Date.now().toString(36);
  await pg.query(`INSERT INTO clients (id, name, "taxStatus", "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'resale', true, now(), now())`, [tag + ' Alpha']);
  const [alpha] = await q(`SELECT id, name FROM clients WHERE name = $1`, [tag + ' Alpha']);
  const newWO = async (total, extra = {}) => {
    const w = (await api('POST', '/workorders', { clientId: alpha.id, clientName: alpha.name })).body.data.id;
    let partId = null;
    if (total !== null) partId = (await api('POST', `/workorders/${w}/parts`, { partType: 'fab_service', quantity: 1, partTotal: total, laborTotal: total, ...extra })).body.data.id;
    return { id: w, partId };
  };

  console.log('\nH3 — columns the code writes now exist on the models');
  const models = require(path.join(__dirname, '../../src/models'));
  const wopAttrs = models.WorkOrderPart.rawAttributes;
  check('WorkOrderPart has the outside-processing status / return columns',
    ['outsideProcessingStatus', 'outsideProcessingReturnedAt', 'outsideProcessingExpectedReturn', 'outsideProcessingServiceType', 'outsideProcessingExpediteCost'].every(k => wopAttrs[k]));
  check('WorkOrderPartFile has layer', !!models.WorkOrderPartFile.rawAttributes.layer);

  console.log('\nH8 — invoiced or paid orders can\'t be deleted');
  const fk = (await q(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'work_order_payments'::regclass AND confrelid = 'work_orders'::regclass`))[0];
  check('work_order_payments FK is ON DELETE RESTRICT', /ON DELETE RESTRICT/.test(fk?.d || ''), fk?.d);
  const inv = await newWO(300);
  await api('POST', `/quickbooks/assign-invoice-number/${inv.id}`);
  const d1 = await api('DELETE', `/workorders/${inv.id}`);
  check('deleting an order with an invoice number → 409', d1.status === 409 && /invoice/.test(d1.body?.error?.message || ''), `${d1.status} ${d1.body?.error?.message}`);
  const paid = await newWO(200);
  const pay = await api('POST', `/business/ledger/${paid.id}/payments`, { amount: 50, paymentMethod: 'check' });
  const d2 = await api('DELETE', `/workorders/${paid.id}`);
  const stillPay = await q(`SELECT COUNT(*)::int n FROM work_order_payments WHERE "workOrderId" = $1`, [paid.id]);
  check('deleting an order with a payment → 409, payment kept', pay.status < 300 && d2.status === 409 && stillPay[0].n === 1, `${pay.status} ${d2.status} ${stillPay[0].n}`);
  let rawBlocked = false;
  try { await pg.query(`DELETE FROM work_orders WHERE id = $1`, [paid.id]); } catch (e) { rawBlocked = /foreign key/i.test(e.message); }
  check('even a raw SQL delete is refused by the database', rawBlocked);
  const plain = await newWO(100);
  const d3 = await api('DELETE', `/workorders/${plain.id}`);
  check('an order with no invoice or payments still deletes', d3.status === 200, `${d3.status} ${d3.body?.error?.message}`);

  console.log('\nH14 — settings');
  const s1 = await api('PUT', '/settings/next_invoice_number', { value: { nextNumber: 1 } }, CLERK);
  const s2 = await api('PUT', '/settings/next_po_number', { value: { nextNumber: 1 } });
  check('counters can\'t be set through the generic settings route (even by an admin)', s1.status === 403 && s2.status === 403, `${s1.status} ${s2.status}`);
  const s3 = await api('PUT', '/settings/tax_settings', { value: { defaultTaxRate: 0 } }, CLERK);
  const tax = (await q(`SELECT value FROM app_settings WHERE key = 'tax_settings'`))[0];
  check('a non-admin can\'t change the tax rate', s3.status === 403 && near(tax.value.defaultTaxRate, 9.5), `${s3.status} ${JSON.stringify(tax?.value)}`);
  const s4 = await api('PUT', '/settings/tax_settings', { value: { defaultTaxRate: 9.5 } });
  check('an admin still can', s4.status === 200, s4.status);
  const s5 = await api('PUT', '/settings/payroll_email', { value: 'payroll@example.com' }, CLERK);
  check('ordinary settings still save for everyone', s5.status === 200, s5.status);
  const s6 = await api('GET', '/settings/cod_override_password', null, null, { 'X-API-Key': PORTAL_KEY });
  const s7 = await api('PUT', '/settings/payroll_email', { value: 'x' }, null, { 'X-API-Key': PORTAL_KEY });
  check('client-portal keys can\'t read or write settings', s6.status === 403 && s7.status === 403, `${s6.status} ${s7.status}`);
  const s6b = await api('GET', '/settings/pricing-config', null, null, { 'X-API-Key': PORTAL_KEY });
  check('…including the pricing/AI settings routes', s6b.status === 403, s6b.status);
  const s8 = await api('GET', '/settings/ai-usage');
  check('/settings/ai-usage is reachable (was shadowed by /:key)', s8.status === 200 && s8.body?.data && !('key' in s8.body.data), JSON.stringify(s8.body).slice(0, 120));
  const s9 = await api('PUT', '/settings/pricing-config', { newClientUpliftPct: 50 }, CLERK);
  check('a non-admin can\'t change the pricing config', s9.status === 403, s9.status);

  console.log('\nH12 — receiving material per PO');
  const M = (await api('POST', '/workorders', { clientId: alpha.id, clientName: alpha.name })).body.data.id;
  const pa = (await api('POST', `/workorders/${M}/parts`, { partType: 'plate_roll', quantity: 1, supplierName: tag + ' Mill A' })).body.data.id;
  const pb = (await api('POST', `/workorders/${M}/parts`, { partType: 'plate_roll', quantity: 1, supplierName: tag + ' Mill B' })).body.data.id;
  const om = await api('POST', `/workorders/${M}/order-material`, { partIds: [pa, pb] });
  await pg.query(`UPDATE work_orders SET status = 'waiting_for_materials', "allMaterialReceived" = false WHERE id = $1`, [M]);
  const parts = await q(`SELECT id, "inboundOrderId" FROM work_order_parts WHERE id = ANY($1)`, [[pa, pb]]);
  const ibA = parts.find(p => p.id === pa).inboundOrderId, ibB = parts.find(p => p.id === pb).inboundOrderId;
  check('ordering from two suppliers made two deliveries', om.status < 300 && ibA && ibB && ibA !== ibB, `${om.status} ${ibA} ${ibB}`);
  const ship = await api('POST', '/shipments', { clientName: alpha.name, linkToWorkOrderId: M, inboundOrderId: ibA, receivedBy: 'dock' });
  const afterA = await q(`SELECT id, "materialReceived" FROM work_order_parts WHERE id = ANY($1)`, [[pa, pb]]);
  const woA = (await q(`SELECT status, "allMaterialReceived" FROM work_orders WHERE id = $1`, [M]))[0];
  check('dock receives supplier A: only A\'s part is marked received', ship.status < 300 && afterA.find(p => p.id === pa).materialReceived === true && !afterA.find(p => p.id === pb).materialReceived, `${ship.status} ${JSON.stringify(afterA)}`);
  check('…and the order stays "waiting for materials"', woA.status === 'waiting_for_materials' && woA.allMaterialReceived === false, JSON.stringify(woA));
  const rb = await api('PUT', `/inbound/${ibB}/receive`, { receivedBy: 'office' });
  const woB = (await q(`SELECT status, "allMaterialReceived" FROM work_orders WHERE id = $1`, [M]))[0];
  const pbRow = (await q(`SELECT "materialReceived" FROM work_order_parts WHERE id = $1`, [pb]))[0];
  check('receiving B on the Inbound screen marks B and moves the order to "received"', rb.status === 200 && pbRow.materialReceived === true && woB.status === 'received' && woB.allMaterialReceived === true, `${rb.status} ${JSON.stringify(woB)}`);
  const rb2 = await api('PUT', `/inbound/${ibB}/receive`, { receivedBy: 'office' });
  check('receiving the same delivery twice is harmless', rb2.status === 200, rb2.status);

  // Older orders: parts flagged ordered without the delivery link, PO typed differently
  const L = (await api('POST', '/workorders', { clientId: alpha.id, clientName: alpha.name })).body.data.id;
  const lp = (await api('POST', `/workorders/${L}/parts`, { partType: 'plate_roll', quantity: 1 })).body.data.id;
  await pg.query(`UPDATE work_order_parts SET "materialOrdered" = true, "materialPurchaseOrderNumber" = '7712' WHERE id = $1`, [lp]);
  await pg.query(`UPDATE work_orders SET status = 'waiting_for_materials', "allMaterialReceived" = false WHERE id = $1`, [L]);
  const [opIb] = await q(`INSERT INTO inbound_orders (id, "workOrderId", "clientName", "purchaseOrderNumber", supplier, "supplierName", description, status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'OP7713', 'Galv', 'Galv', 'OP return', 'pending', now(), now()) RETURNING id`, [L, alpha.name]);
  await api('PUT', `/inbound/${opIb.id}/receive`, { receivedBy: 'dock' });
  const lp1 = (await q(`SELECT "materialReceived" FROM work_order_parts WHERE id = $1`, [lp]))[0];
  check('an outside-processing return does not mark material received', !lp1.materialReceived, JSON.stringify(lp1));
  const [legIb] = await q(`INSERT INTO inbound_orders (id, "workOrderId", "clientName", "purchaseOrderNumber", supplier, "supplierName", description, status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'PO 7712', 'Mill', 'Mill', 'plate', 'pending', now(), now()) RETURNING id`, [L, alpha.name]);
  await api('PUT', `/inbound/${legIb.id}/receive`, { receivedBy: 'dock' });
  const lp2 = (await q(`SELECT "materialReceived" FROM work_order_parts WHERE id = $1`, [lp]))[0];
  const lwo = (await q(`SELECT status FROM work_orders WHERE id = $1`, [L]))[0];
  check('an older part matched by PO number ("7712" vs "PO 7712") is received and the order moves on', lp2.materialReceived === true && lwo.status === 'received', `${JSON.stringify(lp2)} ${lwo.status}`);

  console.log('\nH13 — a stored file shared by an estimate and its work order');
  const sharedId = 's3:test/' + tag + '/print.pdf';
  const est = (await api('POST', '/estimates', { clientName: alpha.name, clientId: alpha.id })).body.data.id;
  const ep = (await api('POST', `/estimates/${est}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 10 })).body.data.id;
  const fw = await newWO(10);
  const [ef] = await q(`INSERT INTO estimate_part_files (id, "partId", "fileType", filename, "originalName", "mimeType", url, "cloudinaryId", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'print', 'p.pdf', 'p.pdf', 'application/pdf', 'https://x/p.pdf', $2, now(), now()) RETURNING id`, [ep, sharedId]);
  const [wf] = await q(`INSERT INTO work_order_part_files (id, "workOrderPartId", "fileType", filename, "originalName", "mimeType", url, "cloudinaryId", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'print', 'p.pdf', 'p.pdf', 'application/pdf', 'https://x/p.pdf', $2, now(), now()) RETURNING id`, [fw.partId, sharedId]);
  const { countReferences } = require(path.join(__dirname, '../../src/services/fileRefs'));
  check('reference count sees both records', (await countReferences(sharedId)) === 2);
  check('…and excludes the row being deleted', (await countReferences(sharedId, { exclude: [{ table: 'estimate_part_files', id: ef.id }] })) === 1);
  const logPath = process.env.SERVER_LOG;
  const logLen = logPath && fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const delEf = await api('DELETE', `/estimates/${est}/parts/${ep}/files/${ef.id}`);
  let logTail = '';
  for (let i = 0; i < 30 && logPath && !logTail.includes(`kept ${sharedId}`); i++) {   // the log is written a moment later
    await sleep(200);
    logTail = fs.existsSync(logPath) ? fs.readFileSync(logPath).subarray(logLen).toString('utf8') : '';   // byte offset
  }
  check('deleting the estimate\'s copy keeps the stored file (the work order still uses it)', delEf.status === 200 && (!logPath || logTail.includes(`kept ${sharedId}`)), `${delEf.status} log:${logPath ? logTail.includes(`kept ${sharedId}`) : 'n/a'}`);
  check('the work order\'s file record is untouched', (await q(`SELECT 1 FROM work_order_part_files WHERE id = $1`, [wf.id])).length === 1);

  console.log('\nH15 — concurrent tablet updates and OP PO links');
  const C = await newWO(100, { quantity: 20 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => api('PUT', `/workorders/${C.id}/parts/${C.partId}`, { progressCount: i + 1 })));
  const log = (await q(`SELECT "progressLog" FROM work_order_parts WHERE id = $1`, [C.partId]))[0].progressLog || [];
  check('8 simultaneous progress taps → 8 progress-log entries', log.length === 8, `got ${log.length}`);
  await pg.query(`UPDATE work_order_parts SET quantity = 20 WHERE id = $1`, [C.partId]);
  const picks = await Promise.all(Array.from({ length: 5 }, () => api('POST', `/workorders/${C.id}/pickup`, { type: 'partial', pickedUpBy: 'driver', items: [{ partId: C.partId, quantity: 1 }] })));
  const hist = (await q(`SELECT "pickupHistory" FROM work_orders WHERE id = $1`, [C.id]))[0].pickupHistory || [];
  check('5 simultaneous partial pickups → 5 pickup entries', picks.every(p => p.status === 200) && hist.length === 5, `${picks.map(p => p.status)} got ${hist.length}`);

  const O = await newWO(100);
  await api('PUT', `/workorders/${O.id}/parts/${O.partId}`, { outsideProcessing: [{ id: 'op1', serviceType: 'Galvanize', vendorName: 'Galv Co', costPerPart: 5 }] });
  await pg.query(`UPDATE work_order_parts SET "outsideProcessing" = jsonb_set("outsideProcessing", '{0}', ("outsideProcessing"->0) || '{"poNumber":"OP9001","poSentAt":"2026-10-01T00:00:00Z","inboundOrderId":null}') WHERE id = $1`, [O.partId]);
  const stale = await api('PUT', `/workorders/${O.id}/parts/${O.partId}`, { outsideProcessing: [{ id: 'op1', serviceType: 'Galvanize', vendorName: 'Galv Co', costPerPart: 6 }] });
  const opRow = (await q(`SELECT "outsideProcessing" FROM work_order_parts WHERE id = $1`, [O.partId]))[0].outsideProcessing[0];
  check('saving a form opened before the PO was sent keeps the PO number, and saves the edit', stale.status === 200 && opRow.poNumber === 'OP9001' && opRow.costPerPart === 6, `${stale.status} ${JSON.stringify(opRow)}`);
  const sneaky = await api('PUT', `/workorders/${O.id}/parts/${O.partId}`, { outsideProcessing: [opRow, { id: 'op2', serviceType: 'Paint', poNumber: 'OP1', inboundOrderId: 'x' }] });
  const op2 = (await q(`SELECT "outsideProcessing" FROM work_order_parts WHERE id = $1`, [O.partId]))[0].outsideProcessing.find(o => o.id === 'op2');
  check('a new OP line can\'t arrive with a PO number already on it', sneaky.status === 200 && op2 && !op2.poNumber && !op2.inboundOrderId, `${sneaky.status} ${JSON.stringify(op2)}`);
  const drop = await api('PUT', `/workorders/${O.id}/parts/${O.partId}`, { outsideProcessing: [] });
  check('removing an OP line that has a live PO → 409 (cancel the PO first)', drop.status === 409 && /OP9001/.test(drop.body?.error?.message || ''), `${drop.status} ${drop.body?.error?.message}`);

  console.log('\nH9 — estimate part input');
  const E = (await api('POST', '/estimates', { clientName: alpha.name, clientId: alpha.id })).body.data.id;
  const E2 = (await api('POST', '/estimates', { clientName: alpha.name, clientId: alpha.id })).body.data.id;
  const epart = (await api('POST', `/estimates/${E}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 50 })).body.data.id;
  const mv = await api('PUT', `/estimates/${E}/parts/${epart}`, { estimateId: E2, id: '00000000-0000-0000-0000-000000000000', specialInstructions: 'x' });
  const eRow = (await q(`SELECT "estimateId" FROM estimate_parts WHERE id = $1`, [epart]))[0];
  check('a part can\'t be moved to another estimate or have its id changed', mv.status === 200 && eRow && eRow.estimateId === E, `${mv.status} ${JSON.stringify(eRow)}`);
  const nan = await api('PUT', `/estimates/${E}/parts/${epart}`, { laborRate: 'abc' });
  const neg = await api('PUT', `/estimates/${E}/parts/${epart}`, { laborHours: -3 });
  check('non-numeric or negative rates/hours → 400', nan.status === 400 && neg.status === 400, `${nan.status} ${neg.status}`);
  const commas = await api('PUT', `/estimates/${E}/parts/${epart}`, { partTotal: '1,234.50' });
  const cRow = (await q(`SELECT "partTotal" FROM estimate_parts WHERE id = $1`, [epart]))[0];
  check('"1,234.50" is saved as 1234.50 (was 1.00)', commas.status === 200 && near(cRow.partTotal, 1234.5), `${commas.status} ${cRow.partTotal}`);
  const addHijack = await api('POST', `/estimates/${E}/parts`, { partType: 'fab_service', quantity: 1, estimateId: E2 });
  check('adding a part always adds it to the estimate in the URL', addHijack.status === 201 && addHijack.body?.data?.estimateId === E, `${addHijack.status} ${addHijack.body?.data?.estimateId}`);

  await pg.end();
  await models.sequelize.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
