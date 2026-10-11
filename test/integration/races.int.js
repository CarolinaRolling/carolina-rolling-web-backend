/**
 * Concurrency tests for audit items H4 (invoice numbers), H5 (payment validation) and H7 (estimate
 * conversion). Fires real simultaneous HTTP requests at a RUNNING server on a LOCAL test database.
 *
 *   DATABASE_URL=<local test db> TEST_BASE_URL=http://localhost:5055/api node test/integration/races.int.js
 *
 * Writes test rows, so it refuses to run unless DATABASE_URL points at localhost.
 */
const path = require('path');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const USER = process.env.TEST_ADMIN_USER || 'boss';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';
const OVERRIDE = process.env.DELETE_OVERRIDE_CODE || 'CRC-FORCE-DELETE';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const near = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.005;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let TOKEN;
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
}
const all = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  TOKEN = (await r.json()).data?.token;
  const tag = 'R' + Date.now().toString(36);
  await pg.query(`INSERT INTO clients (id, name, "taxStatus", "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'taxable', true, now(), now()), (gen_random_uuid(), $2, 'taxable', true, now(), now())`, [tag + ' Alpha', tag + ' Beta']);
  const [alpha] = await q(`SELECT id, name FROM clients WHERE name = $1`, [tag + ' Alpha']);
  const [beta] = await q(`SELECT id, name FROM clients WHERE name = $1`, [tag + ' Beta']);
  const newWO = async (client, total = 0) => {
    const w = await api('POST', '/workorders', { clientId: client.id, clientName: client.name });
    if (total) await api('POST', `/workorders/${w.body.data.id}/parts`, { partType: 'fab_service', quantity: 1, partTotal: total, laborTotal: total });
    return w.body.data.id;
  };

  console.log('\nH4 — invoice numbers');
  const wo1 = await newWO(alpha, 100);
  const burst = await Promise.all([
    ...Array.from({ length: 8 }, () => api('POST', `/quickbooks/assign-invoice-number/${wo1}`)),
    ...Array.from({ length: 4 }, () => fetch(`${BASE}/quickbooks/invoice-pdf/${wo1}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then(x => ({ status: x.status }))),
  ]);
  const nums = new Set(burst.filter(b => b.body).map(b => b.body.data?.invoiceNumber));
  const rows1 = await q(`SELECT "invoiceNumber" FROM invoice_numbers WHERE "workOrderId" = $1`, [wo1]);
  check('12 simultaneous assign/generate clicks → one number', nums.size === 1 && rows1.length === 1, `numbers=${[...nums]} rows=${rows1.length} statuses=${burst.map(b => b.status)}`);

  const many = await all(10, () => newWO(alpha, 50));
  const res10 = await all(10, (i) => api('POST', `/quickbooks/assign-invoice-number/${many[i]}`));
  const got = res10.map(x => parseInt(x.body.data.invoiceNumber, 10));
  check('10 orders assigned at once → 10 different numbers', new Set(got).size === 10 && res10.every(x => x.status === 200), got.join(','));
  const sorted = [...got].sort((a, b) => a - b);
  check('… and they are consecutive (no gaps)', sorted[9] - sorted[0] === 9, sorted.join(','));

  // release → freed pool → preview must NOT consume it → next assignment reuses it
  const rel = await api('DELETE', `/workorders/${many[0]}/invoice`, { overrideCode: OVERRIDE });
  check('clear invoice frees its number', rel.status === 200, JSON.stringify(rel.body).slice(0, 120));
  const freedNum = got[0];
  await api('GET', '/quickbooks/next-invoice-number'); await api('GET', '/quickbooks/next-invoice-number');
  const pool = (await q(`SELECT value FROM app_settings WHERE key = 'freed_invoice_numbers'`))[0]?.value || [];
  check('previewing the next number does not use up the freed number', pool.map(Number).includes(freedNum), JSON.stringify(pool));
  const woR = await newWO(alpha, 10);
  const reuse = await api('POST', `/quickbooks/assign-invoice-number/${woR}`);
  check('next assignment reuses the freed number', parseInt(reuse.body.data.invoiceNumber, 10) === freedNum, reuse.body.data.invoiceNumber);

  // typed numbers can't collide
  const taken = String(got[1]);
  const woB = await newWO(beta, 20);
  const t1 = await api('POST', `/workorders/${woB}/invoice`, { invoiceNumber: taken });
  check('recording an invoice with a number another order holds → 409', t1.status === 409, `${t1.status} ${JSON.stringify(t1.body).slice(0, 100)}`);
  const t2 = await api('PUT', `/quickbooks/invoice-number/${woB}`, { invoiceNumber: taken });
  check('editing to a number another order holds → 409', t2.status === 409, t2.status);
  await pg.query(`UPDATE work_orders SET "drNumber" = 990000 + floor(random()*9999)::int WHERE id = $1`, [woB]);
  const drB = (await q(`SELECT "drNumber" FROM work_orders WHERE id = $1`, [woB]))[0].drNumber;
  const imp = await api('POST', '/quickbooks/import-invoice-numbers', { pairs: [{ drNumber: String(drB), invoiceNumber: taken }] });
  const woBrow = (await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [woB]))[0];
  check('import refuses a number another order holds', woBrow.invoiceNumber !== taken && (imp.body.data?.errors || []).length === 1, JSON.stringify(imp.body.data || imp.body).slice(0, 160));
  const free = String(Math.max(...got) + 500);
  const woC = await newWO(beta, 20), woD = await newWO(beta, 20);
  const dual = await Promise.all([api('POST', `/workorders/${woC}/invoice`, { invoiceNumber: free }), api('POST', `/workorders/${woD}/invoice`, { invoiceNumber: free })]);
  const holders = await q(`SELECT id FROM work_orders WHERE "invoiceNumber" = $1`, [free]);
  check('two people typing the same new number at once → only one gets it', holders.length === 1 && dual.map(d => d.status).sort().join() === '200,409', dual.map(d => d.status).join());
  // A typed number with a dash is stored exactly as typed and doesn't move the sequence
  const woDash = await newWO(beta, 20);
  const dash = await api('POST', `/workorders/${woDash}/invoice`, { invoiceNumber: '209500-1' });
  const dashRow = (await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [woDash]))[0];
  const woNext = await newWO(beta, 20);
  const nextAfterDash = await api('POST', `/quickbooks/assign-invoice-number/${woNext}`);
  check('typed "209500-1" is kept as typed', dash.status === 200 && dashRow.invoiceNumber === '209500-1', `${dash.status} ${dashRow.invoiceNumber}`);
  check('… and the next automatic number is unaffected', parseInt(nextAfterDash.body.data.invoiceNumber, 10) < 100000, nextAfterDash.body.data.invoiceNumber);

  // Un-voiding an order whose invoice number was given away meanwhile → clear 409, not a 500
  const woV = await newWO(beta, 20);
  await pg.query(`UPDATE work_orders SET "drNumber" = 980000 + floor(random()*9999)::int WHERE id = $1`, [woV]);
  const drV = (await q(`SELECT "drNumber" FROM work_orders WHERE id = $1`, [woV]))[0].drNumber;
  await pg.query(`INSERT INTO dr_numbers (id, "drNumber", status, "workOrderId", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'void', $2, now(), now())`, [drV, woV]);
  await pg.query(`UPDATE work_orders SET "isVoided" = true, "invoiceNumber" = $2 WHERE id = $1`, [woV, free]);
  const unv = await api('POST', `/dr-numbers/${drV}/unvoid`);
  check('un-voiding an order whose invoice number is now taken → 409 with a reason', unv.status === 409 && /now used by/.test(unv.body?.error?.message || ''), `${unv.status} ${unv.body?.error?.message}`);

  const idx = await q(`SELECT indexname FROM pg_indexes WHERE indexname IN ('uq_work_orders_invoice_number_live','uq_invoice_numbers_active_work_order')`);
  check('database unique guards are in place', idx.length === 2, idx.map(i => i.indexname).join());

  console.log('\nH5 — payment validation');
  const pw = await newWO(alpha, 1000);
  await api('POST', `/quickbooks/assign-invoice-number/${pw}`);
  const led = await api('GET', '/business/ledger');
  const bal = parseFloat(led.body.data.invoices.find(i => i.id === pw).balance);   // includes default tax
  const over = await api('POST', `/business/ledger/${pw}/payments`, { amount: (bal + 0.01).toFixed(2), paymentMethod: 'check' });
  check('payment above the balance → 400 with a clear message', over.status === 400 && /more than the invoice balance/.test(over.body.error.message), `${over.status} ${over.body?.error?.message}`);
  const race = await Promise.all([api('POST', `/business/ledger/${pw}/payments`, { amount: bal, paymentMethod: 'check' }), api('POST', `/business/ledger/${pw}/payments`, { amount: bal, paymentMethod: 'ach' })]);
  const paidRows = await q(`SELECT sum(amount)::numeric AS s FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [pw]);
  check('two full payments entered at once → one accepted, one refused', race.map(x => x.status).sort().join() === '200,400' && near(paidRows[0].s, bal), `${race.map(x => x.status)} paid=${paidRows[0].s}`);

  const ca = await newWO(alpha, 300), cb = await newWO(alpha, 200), other = await newWO(beta, 500);
  for (const id of [ca, cb, other]) await api('POST', `/quickbooks/assign-invoice-number/${id}`);
  const tooMuch = await api('POST', '/business/client-payments', { clientId: alpha.id, clientName: alpha.name, amount: 400, applications: [{ workOrderId: ca, amount: 300 }, { workOrderId: cb, amount: 200 }] });
  check('applications adding up to more than the check → 400', tooMuch.status === 400, `${tooMuch.status} ${tooMuch.body?.error?.message}`);
  const wrongClient = await api('POST', '/business/client-payments', { clientId: alpha.id, clientName: alpha.name, amount: 500, applications: [{ workOrderId: other, amount: 500 }] });
  check("applying to another client's invoice → 400", wrongClient.status === 400 && /belongs to/.test(wrongClient.body?.error?.message), wrongClient.body?.error?.message);
  const pastBal = await api('POST', '/business/client-payments', { clientId: alpha.id, clientName: alpha.name, amount: 400, applications: [{ workOrderId: ca, amount: 400 }] });
  check('applying more than an invoice owes → 400', pastBal.status === 400, pastBal.body?.error?.message);
  const cpCount = await q(`SELECT count(*)::int n FROM client_payments WHERE "clientName" = $1`, [alpha.name]);
  check('refused payments leave nothing behind', cpCount[0].n === 0, cpCount[0].n);
  const ok = await api('POST', '/business/client-payments', { clientId: alpha.id, clientName: alpha.name, amount: 550, applications: [{ workOrderId: ca, amount: 300 }, { workOrderId: cb, amount: 200 }], creditMemoRemainder: true });
  check('a valid payment with $50 left over → accepted, credit memo created', ok.status === 200 && ok.body.data.creditMemo && near(ok.body.data.creditMemo.amount, 50), JSON.stringify(ok.body).slice(0, 160));
  // Legitimate flows that must still be accepted
  const legacy = await newWO(alpha, 400);
  await pg.query(`UPDATE work_orders SET "paymentDate" = now() WHERE id = $1`, [legacy]);   // old one-click "paid"
  const realCheck = await api('POST', `/business/ledger/${legacy}/payments`, { amount: 438, paymentMethod: 'check' });
  check('recording the real check on an order marked paid with the old button → accepted', realCheck.status === 200, `${realCheck.status} ${realCheck.body?.error?.message}`);
  const unpriced = await newWO(alpha);
  await api('PUT', `/workorders/${unpriced}`, { truckingCost: 150 });
  const deposit = await api('POST', `/business/ledger/${unpriced}/payments`, { amount: 2000, paymentType: 'downpayment', paymentMethod: 'check' });
  check('a $2000 deposit on a not-yet-priced order with trucking → accepted', deposit.status === 200, `${deposit.status} ${deposit.body?.error?.message}`);

  await pg.query(`UPDATE work_orders SET "isVoided" = true WHERE id = $1`, [other]);
  const voidPay = await api('POST', `/business/ledger/${other}/payments`, { amount: 10 });
  check('payment on a voided order → 400', voidPay.status === 400, voidPay.status);

  console.log('\nH7 — estimate conversion');
  const est = await api('POST', '/estimates', { clientName: alpha.name, clientId: alpha.id });
  const estId = est.body.data.id;
  await api('POST', `/estimates/${estId}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 250, laborTotal: 250 });
  const drBefore = (await q(`SELECT count(*)::int n FROM dr_numbers`))[0].n;
  const conv = await all(5, () => api('POST', `/estimates/${estId}/convert-to-workorder`, { materialReceived: true }));
  const created = conv.filter(c => c.status === 201).length;
  const wos = await q(`SELECT id FROM work_orders WHERE "estimateId" = $1`, [estId]);
  const drAfter = (await q(`SELECT count(*)::int n FROM dr_numbers`))[0].n;
  check('5 simultaneous Convert clicks → exactly one work order', created === 1 && wos.length === 1, `statuses=${conv.map(c => c.status)} workOrders=${wos.length}`);
  check('… and exactly one DR number used', drAfter - drBefore === 1, drAfter - drBefore);
  const losers = conv.filter(c => c.status !== 201);
  check('the other clicks are told it is already converted (with the work order id)', losers.every(c => c.status === 400 && c.body.data?.workOrderId === wos[0].id), JSON.stringify(losers[0]?.body).slice(0, 160));
  const old = await api('POST', `/estimates/${estId}/convert`, {});
  check('retired /convert endpoint → 410', old.status === 410, old.status);

  const est2 = await api('POST', '/estimates', { clientName: alpha.name, clientId: alpha.id });
  const plainWO = await newWO(alpha);
  const est3 = await api('POST', '/estimates', { clientName: alpha.name, clientId: alpha.id });
  const links = await Promise.all([api('POST', `/workorders/${plainWO}/link-estimate`, { estimateId: est2.body.data.id }), api('POST', `/workorders/${plainWO}/link-estimate`, { estimateId: est3.body.data.id })]);
  const linkedCount = await q(`SELECT count(*)::int n FROM estimates WHERE "workOrderId" = $1`, [plainWO]);
  check('linking two estimates to one work order at once → only one links', linkedCount[0].n === 1 && links.map(l => l.status).sort().join() === '200,400', `${links.map(l => l.status)} linked=${linkedCount[0].n}`);

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
