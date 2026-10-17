/**
 * Round 13 checks (third independent audit, highs T1–T44 and quick mediums): the estimate and the
 * invoice price the same way (labor minimum, expedite, discount cap — T1, T2, T7), orders made from
 * estimates carry the client id (T3), numbering side doors (T10, T11, T12, T14, T15, T16), undo after a
 * re-convert (T19), tablet Order Complete on finished orders (T35), tablets see no prices (T36), COD on
 * voided orders (T5), deleting an invoice in QuickBooks (T8), abandoned idempotency keys (T29).
 * Runs against a RUNNING server and a LOCAL test database.
 */
const path = require('path');
const crypto = require('crypto');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';
const OVERRIDE = process.env.DELETE_OVERRIDE_CODE || 'CRC-FORCE-DELETE';

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
const api = (m, u, b, t = TOKEN, extra = {}) => call(m, u, b, { Authorization: `Bearer ${t}`, ...extra });
const key = (m, u, k, b) => call(m, u, b, { 'X-API-Key': k });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R13' + Date.now().toString(36);
  const client = tag + ' Co';
  const cl = await api('POST', '/clients', { name: client });
  const clientId = cl.body?.data?.id;
  const mkKey = async (fields) => {
    const k = 'r13_' + crypto.randomBytes(8).toString('hex');
    const f = { name: tag + '-' + k.slice(-4), key: k, permissions: 'read_write', isActive: true, ...fields };
    const cols = Object.keys(f);
    await pg.query(`INSERT INTO api_keys (id, ${cols.map(c => `"${c}"`).join(',')}, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${cols.map((_, i) => '$' + (i + 1)).join(',')}, now(), now())`, Object.values(f));
    return k;
  };
  // Labor minimums saved the way the Admin screen saves them (a JSON array) — the invoice used to ignore these
  await api('PUT', '/settings/labor_minimums', { value: [
    { partType: 'plate_roll', label: 'Plate ≤ 3/8"', sizeField: 'thickness', maxSize: 0.375, minimum: 125 },
    { partType: 'plate_roll', label: 'Plate > 3/8"', sizeField: 'thickness', minSize: 0.376, minimum: 200 },
  ] });

  console.log('\nThe estimate and the invoice price the same way (T1, T2, T7)');
  const mkEst = async (parts, extra = {}) => {
    const e = (await api('POST', '/estimates', { clientName: client, taxRate: 9.5, ...extra })).body.data.id;
    for (const p of parts) await api('POST', `/estimates/${e}/parts`, p);
    if (Object.keys(extra).length) await api('PUT', `/estimates/${e}`, extra);
    return e;
  };
  const scenarios = [
    ['labor above the minimum (10 pcs × $20)', [{ partType: 'plate_roll', quantity: 10, thickness: '1/4"', laborTotal: '20.00', partTotal: '200.00', rollType: 'easy_way', materialSource: 'customer_supplied' }]],
    ['labor below the minimum (1 pc × $50, 1/4")', [{ partType: 'plate_roll', quantity: 1, thickness: '1/4"', laborTotal: '50.00', partTotal: '50.00', rollType: 'easy_way', materialSource: 'customer_supplied' }]],
    ['thick plate minimum (1/2")', [{ partType: 'plate_roll', quantity: 2, thickness: '1/2"', laborTotal: '40.00', partTotal: '80.00', rollType: 'easy_way', materialSource: 'customer_supplied' }]],
    ['outside-processed part + 25% rush', [
      { partType: 'plate_roll', quantity: 4, thickness: '1/4"', laborTotal: '6.00', partTotal: '144.00', _baseLaborTotal: '80.00', rollType: 'easy_way', materialSource: 'customer_supplied',
        outsideProcessing: [{ id: 'op1', serviceType: 'galvanize', costPerPart: 30, markup: 20 }] },
      { partType: 'rush_service', quantity: 1, partTotal: '0', _expediteEnabled: true, _expediteType: '25' }]],
    ['discount + trips + trucking', [{ partType: 'fab_service', quantity: 1, partTotal: '300.00', laborTotal: '300.00' }],
      { discountPercent: 10, truckingCost: 40, opTransports: [{ id: 't1', cost: 50, markup: 20 }] }],
    ['discount larger than the order', [{ partType: 'fab_service', quantity: 1, partTotal: '200.00', laborTotal: '200.00' }], { discountAmount: 500 }],
  ];
  const results = [];
  for (const [label, parts, extra] of scenarios) {
    const e = await mkEst(parts, extra || {});
    const est = (await api('GET', `/estimates/${e}`)).body?.data;
    const conv = await api('POST', `/estimates/${e}/convert-to-workorder`, { materialReceived: true });
    const W = conv.body?.data?.workOrder?.id;
    await sleep(300);
    const inv = W ? (await api('GET', `/workorders/${W}/invoice-totals`)).body?.data : null;
    const pv = W ? await api('GET', `/quickbooks/preview/${W}`) : null;
    const trns = String(pv?.body?.data?.rawIIF || '').split('\n').find(l => l.startsWith('TRNS\t'));
    results.push({ label, est: est && Number(est.grandTotal), inv: inv && inv.amount, pre: inv && inv.preTaxTotal, iif: trns ? Number(trns.split('\t')[6]) : null, W });
  }
  for (const r of results) {
    check(`${r.label}: estimate ${r.est} = invoice ${r.inv}; QuickBooks pre-tax ${r.iif} = ${r.pre}`, r.W && near(r.est, r.inv) && near(r.iif, r.pre), JSON.stringify(r));
  }
  const neg = results[results.length - 1];
  check('…and a discount larger than the order makes a $0 invoice, not a negative one', neg.inv === 0 && neg.est === 0, JSON.stringify(neg));

  console.log('\nOrders made from estimates carry the client id (T3)');
  const W3 = results[0].W;
  const w3 = (await q(`SELECT "clientId" FROM work_orders WHERE id = $1`, [W3]))[0];
  await api('POST', `/quickbooks/assign-invoice-number/${W3}`);
  const open = await api('GET', `/business/client-open-invoices/${clientId}`);
  const ids = (open.body?.data || []).map(i => i.wo?.id || i.id || i.workOrderId);
  check('a converted order has the client\'s id and appears in Take Payment\'s open invoices', !!clientId && w3.clientId === clientId && ids.includes(W3), `${w3.clientId} ${clientId} ${JSON.stringify(ids)}`);
  const W3b = (await api('POST', '/workorders', { clientName: '  ' + client.toUpperCase() + ' ' })).body?.data?.id;
  check('…and so does an order typed with different case / spaces', (await q(`SELECT "clientId" FROM work_orders WHERE id = $1`, [W3b]))[0].clientId === clientId);

  console.log('\nNumbering side doors (T10, T11, T12, T14, T15, T16)');
  const V = results[1].W;
  await api('POST', `/quickbooks/assign-invoice-number/${V}`);
  const v1 = await api('PUT', `/workorders/${V}`, { isVoided: 1 }, CLERK);
  const v0 = await api('PUT', `/workorders/${V}`, { isVoided: 'yes' });
  check('isVoided must be true or false (1 / "yes" no longer slip past the void guard)', v1.status === 400 && v0.status === 400 && (await q(`SELECT "isVoided" FROM work_orders WHERE id = $1`, [V]))[0].isVoided !== true, `${v1.status} ${v0.status}`);
  const hiInv = Number((await q(`SELECT COALESCE(MAX("invoiceNumber"),0) m FROM invoice_numbers`))[0].m);
  const fresh = (await api('POST', '/workorders', { clientName: client })).body.data.id;
  const ren = await api('PUT', `/quickbooks/invoice-number/${fresh}`, { invoiceNumber: String(hiInv + 50000) }, CLERK);
  const man = await api('POST', '/quickbooks/invoice-numbers/manual', { invoiceNumber: String(hiInv + 60000) }, CLERK);
  const manA = await api('POST', '/quickbooks/invoice-numbers/manual', { invoiceNumber: String(hiInv + 60000) });
  const imp = await api('POST', '/quickbooks/import-invoice-numbers', { pairs: [{ drNumber: '1', invoiceNumber: '209500-1' }] });
  check('the invoice typo guard covers renumber, manual entry (admin-only) and the import', ren.status === 409 && man.status === 403 && manA.status === 409 && (imp.body?.data?.errors || imp.body?.errors || []).length >= 1,
    `${ren.status} ${man.status} ${manA.status} ${JSON.stringify(imp.body).slice(0, 160)}`);
  const pn = await api('PUT', '/po-numbers/next', { nextNumber: 8888888 }, CLERK);
  const pa = await api('PUT', '/po-numbers/next', { nextNumber: 8888888 });
  check('only an admin can set the next PO number, and never far past the highest', pn.status === 403 && pa.status === 400, `${pn.status} ${pa.status}`);
  const po = (await api('POST', '/po-numbers/assign', { supplier: tag + ' Steel' })).body?.data;
  const pdel = await api('DELETE', `/po-numbers/${po?.id}`, null, CLERK);
  const pdelA = await api('DELETE', `/po-numbers/${po?.id}`);
  check('deleting a PO is admin-only (and goes through the release checks)', pdel.status === 403 && pdelA.status === 200, `${pdel.status} ${pdelA.status} ${JSON.stringify(pdelA.body).slice(0, 100)}`);
  const vend = (await api('POST', '/vendors', { name: tag + ' Galv' })).body?.data?.id;
  const Eop = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  const opPart = (await api('POST', `/estimates/${Eop}/parts`, { partType: 'plate_roll', quantity: 1, partTotal: '10', laborTotal: '10' })).body.data.id;
  await pg.query(`UPDATE estimate_parts SET "outsideProcessingVendorId" = $1 WHERE id = $2`, [vend, opPart]);
  const ops = await Promise.all([1, 2, 3, 4].map(() => api('POST', `/estimates/${Eop}/parts/${opPart}/outside-processing-po`, {})));
  const opNums = new Set(ops.filter(o => o.status === 200).map(o => o.body.data.poNumber));
  const opRows = (await q(`SELECT COUNT(*)::int n FROM po_numbers WHERE "estimateId" = $1`, [Eop]))[0].n;
  check('four clicks on an estimate outside-processing PO make one PO', opNums.size === 1 && opRows === 1, `${[...opNums]} rows=${opRows} ${ops.map(o => o.status)}`);
  // a number already in QuickBooks, freed by voiding its order, can't be typed onto another order without confirming
  const Q1 = (await api('POST', '/workorders', { clientName: client })).body.data.id;
  await api('POST', `/workorders/${Q1}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 50, laborTotal: 50 });
  await api('POST', `/quickbooks/assign-invoice-number/${Q1}`);
  await api('POST', '/quickbooks/mark-entered', { workOrderIds: [Q1] });
  const qNum = (await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [Q1]))[0].invoiceNumber;
  await pg.query(`UPDATE work_orders SET "isVoided" = true, "invoiceNumber" = NULL WHERE id = $1`, [Q1]);
  await pg.query(`UPDATE invoice_numbers SET status = 'void' WHERE "invoiceNumber" = $1`, [Number(qNum)]);
  const Q2 = (await api('POST', '/workorders', { clientName: client })).body.data.id;
  const reuse = await api('POST', `/workorders/${Q2}/invoice`, { invoiceNumber: String(qNum) });
  check('a number already in QuickBooks can\'t be reused on another order without confirming', reuse.status === 409 && /QuickBooks/.test(reuse.body?.error?.message || ''), `${reuse.status} ${reuse.body?.error?.message}`);

  console.log('\nUndo after a re-convert (T19)');
  const Eu = (await api('POST', '/estimates', { clientName: client })).body.data.id;
  await api('POST', `/estimates/${Eu}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '75', laborTotal: '75' });
  const c1 = (await api('POST', `/estimates/${Eu}/convert-to-workorder`, { materialReceived: true })).body?.data?.workOrder?.id;
  const d1 = await api('DELETE', `/workorders/${c1}`, { reason: 'test', overrideCode: OVERRIDE });
  const c2 = (await api('POST', `/estimates/${Eu}/convert-to-workorder`, { materialReceived: true })).body?.data?.workOrder?.id;
  const entry = (await q(`SELECT id FROM deletion_archive WHERE "tableName" = 'work_orders' AND "recordId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [String(c1)]))[0];
  const un = entry ? await api('POST', `/deletion-archive/${entry.id}/undo`) : { status: 0 };
  const both = (await q(`SELECT COUNT(*)::int n FROM work_orders WHERE "estimateId" = $1`, [Eu]))[0].n;
  check('undoing the delete of the first order is refused — the estimate now belongs to the second', d1.status === 200 && !!c2 && un.status === 409 && both === 1, `${d1.status} ${!!c2} ${un.status} ${both} ${JSON.stringify(un.body).slice(0, 120)}`);

  console.log('\nTablets (T35, T36)');
  const DK = await mkKey({ deviceName: 'Tab ' + tag, operatorName: 'Op' });
  const S = results[0].W;
  await pg.query(`UPDATE work_order_parts SET status = 'completed' WHERE "workOrderId" = $1`, [S]);
  await pg.query(`UPDATE work_orders SET status = 'shipped' WHERE id = $1`, [S]);
  const mc = await key('POST', `/workorders/${S}/mark-complete`, DK);
  check('Order Complete on a shipped order is refused and it stays shipped', mc.status === 409 && (await q(`SELECT status FROM work_orders WHERE id = $1`, [S]))[0].status === 'shipped', `${mc.status} ${JSON.stringify(mc.body).slice(0, 100)}`);
  const det = await key('GET', `/workorders/${S}`, DK);
  const txt = JSON.stringify(det.body || '');
  check('a tablet sees the order without prices, payments or invoice numbers', det.status === 200 && !/"grandTotal"|"partTotal"|"laborTotal"|"invoiceNumber"|"taxRate"/.test(txt) && /"parts"/.test(txt), `${det.status} ${txt.slice(0, 160)}`);
  const rushWo = await key('GET', `/workorders/${results[3].W}`, DK);
  const rushPart = (rushWo.body?.data?.parts || []).find(p => p.partType === 'rush_service');
  check('…but still sees that a job is rushed (the rush card\'s flags are kept)', rushPart && rushPart.formData && rushPart.formData._expediteEnabled === true && !('_expediteType' in rushPart.formData), JSON.stringify(rushPart && rushPart.formData));
  const lst = await key('GET', '/workorders?limit=5', DK);
  check('…in the list too', lst.status === 200 && !/"grandTotal"|"partTotal"/.test(JSON.stringify(lst.body)), lst.status);

  console.log('\nMoney edges (T5, T8)');
  const Vd = (await api('POST', '/workorders', { clientName: client })).body.data.id;
  await api('PUT', `/workorders/${Vd}`, { isVoided: true, voidReason: 'dup' });
  const codV = await api('POST', `/workorders/${Vd}/record-payment`, { paymentMethod: 'cash', amount: 500 }, CLERK);
  check('no payment can be recorded on a voided order through COD', codV.status === 400 && (await q(`SELECT COUNT(*)::int n FROM work_order_payments WHERE "workOrderId" = $1`, [Vd]))[0].n === 0, codV.status);
  const X = (await api('POST', '/workorders', { clientName: client })).body.data.id;
  await api('POST', `/workorders/${X}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 60, laborTotal: 60 });
  await api('POST', `/quickbooks/assign-invoice-number/${X}`);
  await api('POST', '/quickbooks/mark-entered', { workOrderIds: [X] });
  const delInv = await api('DELETE', `/workorders/${X}/invoice`, { overrideCode: OVERRIDE });
  check('an invoice already in QuickBooks can\'t be deleted', delInv.status === 409 && !!(await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [X]))[0].invoiceNumber, delInv.status);

  console.log('\nIdempotency (T29)');
  const me = (await q(`SELECT id FROM users WHERE username = 'boss'`))[0].id;
  const ik = 'stale-' + crypto.randomUUID();
  await pg.query(`INSERT INTO idempotency_keys ("key", "method", "path", "createdAt") VALUES ($1, 'POST', $2, now() - interval '10 minutes')`, ['u:' + me + ':' + ik, `/api/business/ledger/${results[2].W}/payments`]);
  const p1 = await api('POST', `/business/ledger/${results[2].W}/payments`, { amount: 1, paymentMethod: 'cash' }, TOKEN, { 'Idempotency-Key': ik });
  check('a key left "in progress" by a dead request is taken over after a couple of minutes', p1.status !== 409 || !/already being processed/.test(JSON.stringify(p1.body)), `${p1.status} ${JSON.stringify(p1.body).slice(0, 120)}`);

  await pg.query(`DELETE FROM api_keys WHERE name LIKE $1`, [tag + '%']);
  await pg.query(`DELETE FROM app_settings WHERE key = 'labor_minimums'`);
  await pg.end();
  console.log(`\nround13: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
