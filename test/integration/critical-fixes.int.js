/**
 * End-to-end check of the critical audit fixes (C1–C4) against a RUNNING server + LOCAL database.
 *
 *   DATABASE_URL=postgres://...localhost.../crtest  TEST_BASE_URL=http://localhost:5055/api \
 *   TEST_ADMIN_USER=boss TEST_ADMIN_PASS=... node test/integration/critical-fixes.int.js [phase]
 *
 * It writes test rows, so it refuses to run unless DATABASE_URL points at localhost.
 * Phases (the server must be restarted between "seed" and "verify" so the boot migration runs):
 *   seed   — create a client, work order, parts, charges, and a legacy "twin" client payment
 *   verify — check totals everywhere, then record / void payments through the API
 */
const path = require('path');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));

const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) {
  console.error('Refusing to run: DATABASE_URL must point at a local test database.');
  process.exit(2);
}
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const USER = process.env.TEST_ADMIN_USER || 'boss';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';
const CLIENT_ID = 'c0ffee00-0000-4000-8000-000000000001';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const near = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.005;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(token, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
async function login() {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const j = await r.json();
  return j.data?.token || j.token;
}

async function seed(pg, token) {
  await pg.query(`DELETE FROM app_settings WHERE key = 'labor_minimums'`);
  await pg.query(`INSERT INTO app_settings (id, key, value, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'labor_minimums', $1, now(), now())`,
    [JSON.stringify(JSON.stringify([{ partTypes: ['plate_roll'], minimum: 300 }]))]);   // round 13: labor = 50 × 2 + $100 fab line = 200 → +100
  await pg.query(`INSERT INTO clients (id, name, "taxStatus", "isActive", "createdAt", "updatedAt") VALUES ($1, 'Totals Test Co', 'taxable', true, now(), now()) ON CONFLICT (id) DO NOTHING`, [CLIENT_ID]);

  const wo = await api(token, 'POST', '/workorders', { clientId: CLIENT_ID, clientName: 'Totals Test Co' });
  const woId = wo.body.data?.id;
  if (!woId) throw new Error('create WO failed: ' + JSON.stringify(wo.body).slice(0, 300));
  // Part 1: plate roll, $400 stored total, $50 labor each × 2 (+ the $100 fab line = $200 labor; minimum $300 → +$100)
  await api(token, 'POST', `/workorders/${woId}/parts`, { partType: 'plate_roll', quantity: 2, laborTotal: 50, partTotal: 400, materialDescription: 'Test plate' });
  // Part 2: fab service $100
  await api(token, 'POST', `/workorders/${woId}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 100 });
  // Shipping charge $100 + 10% = $110 (not taxed), linked to a vendor (C1: must survive restarts)
  await pg.query(`INSERT INTO vendors (id, name, "createdAt", "updatedAt") VALUES ('c0ffee00-0000-4000-8000-0000000000aa', 'Acme Trucking Test', now(), now()) ON CONFLICT (id) DO NOTHING`);
  await api(token, 'POST', `/workorders/${woId}/shipment-charges`, { carrierType: 'contracted', vendorId: 'c0ffee00-0000-4000-8000-0000000000aa', vendorName: 'Acme Trucking Test', shippingCost: 100, shippingMarkup: 10 });
  // Tax 10%, and give it an invoice number so it shows in AR
  await api(token, 'PUT', `/workorders/${woId}`, { taxRate: 10 });
  await pg.query(`UPDATE work_orders SET "invoiceNumber" = 'T-1001', "invoiceDate" = now() WHERE id = $1`, [woId]);

  // A client payment recorded by the OLD code: application + twin WorkOrderPayment, unlinked.
  const cp = await pg.query(`INSERT INTO client_payments (id, "clientId", "clientName", "paymentDate", amount, method, "createdAt", "updatedAt")
                             VALUES (gen_random_uuid(), $1, 'Totals Test Co', now(), 300, 'check', now(), now()) RETURNING id`, [CLIENT_ID]);
  await pg.query(`INSERT INTO payment_applications (id, "clientPaymentId", "workOrderId", amount, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 300, now(), now())`, [cp.rows[0].id, woId]);
  await pg.query(`INSERT INTO work_order_payments (id, "workOrderId", "paymentType", amount, "paymentDate", "paymentMethod", "createdAt", "updatedAt")
                  VALUES (gen_random_uuid(), $1, 'partial', 300, now(), 'check', now() + interval '20 milliseconds', now())`, [woId]);
  console.log('seeded work order', woId);
  return woId;
}

async function verify(pg, token) {
  const { rows } = await pg.query(`SELECT id, "grandTotal", "taxAmount" FROM work_orders WHERE "invoiceNumber" = 'T-1001' ORDER BY "createdAt" DESC LIMIT 1`);
  const woId = rows[0].id;
  console.log('\nC1 — vendor links survive a restart');
  const ch = await pg.query(`SELECT "vendorId" FROM shipment_charges WHERE "workOrderId" = $1`, [woId]);
  check('shipping charge still linked to its vendor after restart', ch.rows[0] && ch.rows[0].vendorId === 'c0ffee00-0000-4000-8000-0000000000aa', ch.rows[0] && ch.rows[0].vendorId);

  console.log('\nC3 — backup download is admin-only');
  const code = async (url, headers = {}) => (await fetch(BASE + url, { headers })).status;
  check('admin with header → 200', (await code('/backup', { Authorization: `Bearer ${token}` })) === 200);
  check('admin token in URL → refused', (await code(`/backup?token=${token}`)) === 400);
  const clerkTok = await (async () => { const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.TEST_USER || 'clerk', password: PASS }) }); const j = await r.json(); return j.data?.token || j.token; })();
  if (clerkTok) check('non-admin user → 403', (await code('/backup', { Authorization: `Bearer ${clerkTok}` })) === 403);
  if (clerkTok) check('non-admin user → 403 on /backup/info (lists cloud backup links)', (await code('/backup/info', { Authorization: `Bearer ${clerkTok}` })) === 403);
  if (process.env.TEST_PORTAL_KEY || true) check('client portal key → refused', [400, 403].includes(await code('/backup', { 'X-API-Key': process.env.TEST_PORTAL_KEY || 'clientportalkey123' })));

  // Expected (round 13 shared engine): parts 500 + minimum 100 + shipping 110 = 710 pre-tax; tax 10% of 600 = 60; total 770
  console.log('\nC4 — one invoice total everywhere');
  check('stored grandTotal refreshed by hooks = 770', near(rows[0].grandTotal, 770), rows[0].grandTotal);
  check('stored taxAmount = 60', near(rows[0].taxAmount, 60), rows[0].taxAmount);

  const qb = require(path.join(__dirname, '../../src/routes/quickbooks'));
  const { WorkOrder, WorkOrderPart, Client, ShipmentCharge } = require(path.join(__dirname, '../../src/models'));
  const wo = await WorkOrder.findByPk(woId, { include: [{ model: WorkOrderPart, as: 'parts' }, { model: Client, as: 'client' }] });
  const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  const iif = await qb._buildInvoiceIIF(wo, wo.parts, wo.client, 'T-1001');
  console.warn = ow;
  check('QuickBooks IIF pre-tax total = 710', near(iif.summary.total, 710), iif.summary.total);
  check('QuickBooks IIF tax = 60', near(iif.summary.tax, 60), iif.summary.tax);
  check('IIF self-check reports no mismatch', !warns.some(w => w.includes('mismatch')), warns.join(' | '));

  const charges = await ShipmentCharge.findAll({ where: { workOrderId: woId } });
  const pdf = await qb._generateInvoicePDFBuffer(wo, wo.parts, wo.client, [], charges);
  const fs = require('fs'); const os = require('os'); const { execFileSync } = require('child_process');
  const f = path.join(os.tmpdir(), `inv-${Date.now()}.pdf`); fs.writeFileSync(f, pdf);
  let text = ''; try { text = execFileSync('pdftotext', ['-layout', f, '-']).toString(); } catch (e) { text = ''; }
  if (text) {
    check('invoice PDF total due = $770.00', /TOTAL DUE\s+\$770\.00/.test(text), text.split('\n').filter(l => /TOTAL/.test(l)).join(' | '));
    check('invoice PDF shows the minimum labor line', /Minimum labor charge adjustment/.test(text));
    check('invoice PDF tax = $60.00', /Tax \(10%\)\s+\$60\.00/.test(text));
  } else console.log('  (pdftotext not available — PDF text checks skipped)');

  console.log('\nC2 — payments counted once');
  let led = await api(token, 'GET', '/business/ledger');
  let row = led.body.data.invoices.find(i => i.id === woId);
  check('ledger total = 770', near(row.grandTotal, 770), row.grandTotal);
  check('legacy twin payment counted once (paid 300)', near(row.totalPaid, 300), row.totalPaid);
  let open = await api(token, 'GET', `/business/client-open-invoices/${CLIENT_ID}`);
  let o = open.body.data.find(x => x.wo.id === woId);
  check('open-invoices balance = 470 (old code dropped it from the list as paid)', o && near(o.balance, 470), o && o.balance);
  const linked = await pg.query(`SELECT count(*)::int n FROM work_order_payments WHERE "workOrderId" = $1 AND "paymentApplicationId" IS NOT NULL`, [woId]);
  check('boot migration linked the legacy twin', linked.rows[0].n === 1, linked.rows[0].n);

  const cpRes = await api(token, 'POST', '/business/client-payments', { clientId: CLIENT_ID, clientName: 'Totals Test Co', amount: 200, method: 'check', reference: 'CHK-2', applications: [{ workOrderId: woId, amount: 200 }] });
  check('record client payment $200 → 200 OK', cpRes.status === 200, JSON.stringify(cpRes.body).slice(0, 200));
  open = await api(token, 'GET', `/business/client-open-invoices/${CLIENT_ID}`);
  o = open.body.data.find(x => x.wo.id === woId);
  check('balance after $200 = 270', o && near(o.balance, 270), o && o.balance);

  const lp = await api(token, 'POST', `/business/ledger/${woId}/payments`, { amount: 270, paymentMethod: 'ach' });
  led = await api(token, 'GET', '/business/ledger'); row = led.body.data.invoices.find(i => i.id === woId);
  check('paid in full after $270 ledger payment', row.isPaid && near(row.balance, 0), `${row.isPaid} ${row.balance}`);
  let flag = await pg.query(`SELECT "paymentDate" FROM work_orders WHERE id = $1`, [woId]);
  check('paymentDate flag set when fully paid', !!flag.rows[0].paymentDate);

  await api(token, 'DELETE', `/business/ledger/payments/${lp.body.data.id}`);
  led = await api(token, 'GET', '/business/ledger'); row = led.body.data.invoices.find(i => i.id === woId);
  check('void restores balance to 270', near(row.balance, 270), row.balance);
  flag = await pg.query(`SELECT "paymentDate" FROM work_orders WHERE id = $1`, [woId]);
  check('paymentDate flag cleared after void', !flag.rows[0].paymentDate);

  const hist = await api(token, 'GET', `/clients/${CLIENT_ID}/history`);
  check('client history open balance = 270', near(hist.body.data.openBalance, 270), hist.body.data.openBalance);
  const t0 = Date.now();
  const st = await api(token, 'GET', `/clients/${CLIENT_ID}/statement-pdf`);
  check('statement PDF returns (used to hang)', st.status === 200 && Date.now() - t0 < 15000, `${st.status} ${Date.now() - t0}ms`);
  if (st.status === 200) {
    fs.writeFileSync(f, st.body);
    try { const stText = execFileSync('pdftotext', ['-layout', f, '-']).toString(); check('statement shows partial payment (paid $500, balance $270)', /\$500\.00\s+\$270\.00/.test(stText), stText.split('\n').filter(l => /T-1001|DR-|WO-/.test(l)).join(' | ')); } catch (e) { /* skip */ }
  }
  console.log('\nReview follow-ups');
  // Legacy invoice: stored total, parts never priced → must keep the stored total and never be overwritten
  const leg = await pg.query(`INSERT INTO work_orders (id, "orderNumber", "clientName", status, priority, "grandTotal", "taxRate", "invoiceNumber", "invoiceDate", "createdAt", "updatedAt")
                              VALUES (gen_random_uuid(), 'LEG-' || floor(random()*1e9)::text, 'Legacy Co', 'shipped', 'normal', 4000, 10, 'T-LEG', now(), now(), now()) RETURNING id`);
  const legId = leg.rows[0].id;
  const legPart = await pg.query(`INSERT INTO work_order_parts (id, "workOrderId", "partNumber", "partType", quantity, status, "createdAt", "updatedAt")
                                  VALUES (gen_random_uuid(), $1, 1, 'plate_roll', 1, 'completed', now(), now()) RETURNING id`, [legId]);
  await api(token, 'PUT', `/workorders/${legId}/parts/${legPart.rows[0].id}`, { quantity: 2 });
  await sleep(1200);
  led = await api(token, 'GET', '/business/ledger'); row = led.body.data.invoices.find(i => i.id === legId);
  const legStored = (await pg.query(`SELECT "grandTotal" FROM work_orders WHERE id = $1`, [legId])).rows[0].grandTotal;
  check('legacy unpriced invoice keeps its $4000 total (not a minimum-only total)', near(row.grandTotal, 4000), row.grandTotal);
  check('legacy stored total not overwritten by the hooks', near(legStored, 4000), legStored);

  // Client matched by name (no clientId), resale → no tax, same as QuickBooks
  await pg.query(`INSERT INTO clients (id, name, "taxStatus", "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'Resale Name Co', 'resale', true, now(), now()) ON CONFLICT DO NOTHING`);
  const rn = await pg.query(`INSERT INTO work_orders (id, "orderNumber", "clientName", status, priority, "taxRate", "invoiceNumber", "invoiceDate", "createdAt", "updatedAt")
                             VALUES (gen_random_uuid(), 'RN-' || floor(random()*1e9)::text, 'resale name co', 'shipped', 'normal', 10, 'T-RN', now(), now(), now()) RETURNING id`);
  await pg.query(`INSERT INTO work_order_parts (id, "workOrderId", "partNumber", "partType", quantity, "partTotal", "laborTotal", status, "createdAt", "updatedAt")
                  VALUES (gen_random_uuid(), $1, 1, 'fab_service', 1, 100, 100, 'completed', now(), now())`, [rn.rows[0].id]);
  led = await api(token, 'GET', '/business/ledger'); row = led.body.data.invoices.find(i => i.id === rn.rows[0].id);
  check('client matched by name: resale → no tax ($100, as QuickBooks)', near(row.grandTotal, 100), row.grandTotal);

  // Freeze at QuickBooks export: later edits must not move the ledger
  const mk = await api(token, 'POST', '/quickbooks/mark-entered', { workOrderIds: [woId] });
  check('mark-entered OK', mk.status === 200, JSON.stringify(mk.body).slice(0, 150));
  const p1 = (await pg.query(`SELECT id FROM work_order_parts WHERE "workOrderId" = $1 AND "partType" = 'plate_roll'`, [woId])).rows[0].id;
  const lockedEdit = await api(token, 'PUT', `/workorders/${woId}/parts/${p1}`, { partTotal: 500, laborTotal: 50, quantity: 2 });
  await sleep(1200);
  led = await api(token, 'GET', '/business/ledger'); row = led.body.data.invoices.find(i => i.id === woId);
  const fr = (await pg.query(`SELECT "grandTotal", "totalsComputedAt" FROM work_orders WHERE id = $1`, [woId])).rows[0];
  check('exported invoice: the price edit is refused (H10) and the total stays $770', lockedEdit.status === 409 && near(row.grandTotal, 770) && near(fr.grandTotal, 770), `${lockedEdit.status} ${row.grandTotal} / ${fr.grandTotal}`);
  check('frozen total is marked as computed', !!fr.totalsComputedAt);
  await api(token, 'POST', '/quickbooks/unmark-entered', { workOrderIds: [woId] });
  await api(token, 'PUT', `/workorders/${woId}/parts/${p1}`, { partTotal: 500, laborTotal: 50, quantity: 2 });
  await sleep(1200);
  led = await api(token, 'GET', '/business/ledger'); row = led.body.data.invoices.find(i => i.id === woId);
  check('after un-marking, the total is live again ($880)', near(row.grandTotal, 880), row.grandTotal);
  await api(token, 'PUT', `/workorders/${woId}/parts/${p1}`, { partTotal: 400, laborTotal: 50, quantity: 2 });
  await sleep(1200);

  const gl = await api(token, 'GET', '/business/general-ledger');
  const glEntries = (gl.body.data?.entries || gl.body.data || []).filter(e => e.type === 'payment' && (e.clientName === 'Totals Test Co' || e.source === 'legacy_payment'));
  const revenue = glEntries.reduce((s, e) => s + (e.credit || 0), 0);
  check('general ledger revenue = 500 (no duplicates, voided excluded)', near(revenue, 500), `${revenue} from ${glEntries.length} entries`);
}

(async () => {
  const phase = process.argv[2] || 'verify';
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const token = await login();
  if (!token) throw new Error('login failed');
  if (phase === 'seed') { await seed(pg, token); await sleep(1500); }
  else await verify(pg, token);
  await pg.end();
  if (phase !== 'seed') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
