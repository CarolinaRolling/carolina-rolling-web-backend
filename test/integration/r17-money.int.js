/**
 * Round 17 money checks (sixth independent audit, W-series): a voided deposit no longer releases an
 * unpriced COD order (W1), a client tax-status change re-prices open orders and Outstanding follows the
 * ledger (W2), voiding a refund doesn't revive credit from a voided check (W3), the invoice PDF and the
 * statement show money returned after the payments were voided (W4), the COD refusal on a tablet shows
 * no amount (W14), and date-only payment dates print as entered (W27).
 * Runs against a RUNNING server and a LOCAL test database.
 */
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name, detail); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json()).data?.token;
let TOKEN;
async function call(method, url, body, headers) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('pdf')) return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN) => call(m, u, b, { Authorization: `Bearer ${t}` });
const key = (m, u, k, b) => call(m, u, b, { 'X-API-Key': k });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const r2 = (n) => Math.round(n * 100) / 100;
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Text of a pdfkit PDF: inflate each content stream and decode the hex strings of its TJ arrays
function pdfText(buf) {
  if (!Buffer.isBuffer(buf)) return '';
  const out = [];
  const s = buf.toString('latin1');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    let txt;
    try { txt = zlib.inflateSync(buf.subarray(start, end)).toString('latin1'); } catch (_) { continue; }
    for (const arr of txt.match(/\[([^\]]*)\]\s*TJ/g) || []) {
      out.push((arr.match(/<([0-9a-fA-F]*)>/g) || []).map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''));
    }
  }
  return out.join('\n');
}

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const tag = 'R17M' + Date.now().toString(36);
  const mkKey = async (fields = {}) => {
    const k = 'r17m_' + crypto.randomBytes(8).toString('hex');
    const f = { name: tag + '-' + k.slice(-4), key: k, permissions: 'read_write', isActive: true, ...fields };
    const cols = Object.keys(f);
    await pg.query(`INSERT INTO api_keys (id, ${cols.map(c => `"${c}"`).join(',')}, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${cols.map((_, i) => '$' + (i + 1)).join(',')}, now(), now())`, Object.values(f));
    return k;
  };
  const tax = (await api('GET', '/settings/tax_settings')).body?.data?.value;
  if (!tax || tax.defaultTaxRate === undefined || tax.defaultTaxRate === null) await api('PUT', '/settings/tax_settings', { value: { ...(tax || {}), defaultTaxRate: 9.5 } });
  const dev = await mkKey({ deviceName: tag + '-tab' });
  const mkWo = async (name, extra = {}) => (await api('POST', '/workorders', { clientName: name, ...extra })).body?.data?.id;
  const addPart = async (id, amt) => (await api('POST', `/workorders/${id}/parts`, { partType: 'fab_service', quantity: 1, partTotal: amt, laborTotal: amt })).body?.data?.id;
  const totalOf = async (id) => { await sleep(300); return (await api('GET', `/workorders/${id}/invoice-totals`)).body?.data?.grandTotal; };
  const row = async (id) => (await q(`SELECT "grandTotal", "taxAmount", "paymentDate", "codPaid" FROM work_orders WHERE id = $1`, [id]))[0];
  const hist = async (cid, id) => ((await api('GET', `/clients/${cid}/history`)).body?.data?.workOrders || []).find(w => w.id === id);

  console.log('\nUnpriced COD order: a voided deposit no longer releases it (W1), no amount on the tablet (W14)');
  const cod = tag + ' COD';
  await api('POST', '/clients', { name: cod, paymentTerms: 'COD' });
  const U = await mkWo(cod);
  const dep = await api('POST', `/workorders/${U}/record-payment`, { paymentMethod: 'cash', amount: 50 });
  const u1 = await row(U);
  const wp = (await q(`SELECT id FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [U]))[0]?.id;
  const vd = await api('DELETE', `/business/ledger/payments/${wp}`);
  const u2 = await row(U);
  const shU = await key('PUT', `/workorders/${U}/status`, dev, { status: 'shipped' });
  check('deposit on an unpriced COD order marks it COD-paid; voiding it clears the mark and the order is held again',
    dep.status === 200 && u1.codPaid === true && vd.status === 200 && u2.codPaid === false && shU.status === 409 && shU.body?.error?.code === 'COD_UNPAID',
    `${dep.status} ${u1.codPaid} ${vd.status} ${u2.codPaid} ${shU.status} ${JSON.stringify(shU.body?.error)}`);
  const U2 = await mkWo(cod);
  await api('POST', `/workorders/${U2}/record-payment`, { paymentMethod: 'cash', amount: 20 });
  const rfU = await api('POST', '/business/refunds', { sourceWorkOrderId: U2, amount: 20, method: 'cash' });
  const shU2 = await key('PUT', `/workorders/${U2}/status`, dev, { status: 'shipped' });
  check('…a deposit fully refunded no longer releases it either', rfU.status === 200 && shU2.status === 409 && (await row(U2)).codPaid === false, `${rfU.status} ${shU2.status}`);
  const P = await mkWo(cod);
  await addPart(P, 400);
  await totalOf(P);
  const shP = await key('PUT', `/workorders/${P}/status`, dev, { status: 'shipped' });
  const shPo = await api('PUT', `/workorders/${P}/status`, { status: 'shipped' });
  check('the COD refusal shows no amount to a tablet key, the office still sees it',
    shP.status === 409 && !/\$/.test(shP.body?.error?.message || '') && shPo.status === 409 && /\$\d/.test(shPo.body?.error?.message || ''),
    `${shP.status} "${shP.body?.error?.message}" / ${shPo.status} "${shPo.body?.error?.message}"`);

  console.log('\nTax status change re-prices open orders; Outstanding follows the ledger (W2)');
  const resale = tag + ' Resale';
  const rc = (await api('POST', '/clients', { name: resale, taxStatus: 'resale' })).body?.data;
  const T = await mkWo(resale);
  await addPart(T, 300);
  await api('POST', `/quickbooks/assign-invoice-number/${T}`);
  const tt0 = await totalOf(T);
  const tp = await api('POST', `/business/ledger/${T}/payments`, { amount: tt0, paymentMethod: 'check', paymentType: 'full' });
  const t0 = await row(T);
  const up = await api('PUT', `/clients/${rc.id}`, { taxStatus: 'taxable' });
  let t1; for (let i = 0; i < 20; i++) { await sleep(250); t1 = await row(T); if (!t1.paymentDate) break; }
  const tt1 = await totalOf(T);
  const outRes = (await api('GET', '/business/payments/outstanding')).body?.data;
  const inOut = (outRes?.invoices || []).find(w => w.id === T);
  check('resale → taxable: the stored total rises, the paid mark goes, and Outstanding lists the tax owed',
    tp.status === 200 && !!t0.paymentDate && up.status === 200 && tt1 > tt0 && near(t1.grandTotal, tt1) && !t1.paymentDate && inOut && near(inOut.balance, r2(tt1 - tt0)),
    `${tp.status} ${up.status} ${tt0}->${tt1} stored=${t1.grandTotal} pd=${t1.paymentDate} out=${JSON.stringify(inOut && inOut.balance)}`);
  await q(`UPDATE work_orders SET "paymentDate" = now() WHERE id = $1`, [T]);
  const inOut2 = ((await api('GET', '/business/payments/outstanding')).body?.data?.invoices || []).find(w => w.id === T);
  check('…an invoice still owing is in Outstanding even with a stale paid mark', inOut2 && near(inOut2.balance, r2(tt1 - tt0)), JSON.stringify(inOut2 && inOut2.balance));
  const back = await api('PUT', `/clients/${rc.id}`, { taxStatus: 'resale' });
  let t2; for (let i = 0; i < 20; i++) { await sleep(250); t2 = await row(T); if (near(t2.grandTotal, tt0)) break; }
  const inOut3 = ((await api('GET', '/business/payments/outstanding')).body?.data?.invoices || []).find(w => w.id === T);
  check('…back to resale: the total drops again and it leaves Outstanding', back.status === 200 && near(t2.grandTotal, tt0) && !inOut3, `${t2.grandTotal} ${JSON.stringify(inOut3)}`);

  console.log('\nVoiding a refund after the check bounced restores no credit (W3)');
  const cc = tag + ' Credit';
  const ccId = (await api('POST', '/clients', { name: cc })).body?.data?.id;
  const chk = await api('POST', '/business/client-payments', { clientId: ccId, clientName: cc, amount: 100, method: 'check', reference: tag + '-1', applications: [] });
  const cpId = chk.body?.data?.id || chk.body?.data?.payment?.id;
  const memo = (await q(`SELECT id FROM credit_memos WHERE "sourceClientPaymentId" = $1`, [cpId]))[0];
  const ref1 = await api('POST', '/business/refunds', { creditMemoId: memo?.id, amount: 40, method: 'check' });
  const vcp = await api('POST', `/business/client-payments/${cpId}/void`, { reason: 'bounced' });
  const vref = await api('DELETE', `/business/refunds/${ref1.body?.data?.id}`);
  const m1 = (await q(`SELECT amount, "remainingAmount", "voidedAt" FROM credit_memos WHERE id = $1`, [memo?.id]))[0];
  check('refund from a check\'s credit → check voided → refund voided: the memo stays voided with nothing restored',
    chk.status === 200 && !!memo && ref1.status === 200 && vcp.status === 200 && vref.status === 200 && vref.body?.data?.creditRestored === false
      && !!m1.voidedAt && near(m1.amount, 60) && near(m1.remainingAmount, 0),
    `${chk.status} ${ref1.status} ${vcp.status} ${vref.status} ${JSON.stringify(vref.body?.data?.creditRestored)} ${JSON.stringify(m1)}`);
  const chk2 = await api('POST', '/business/client-payments', { clientId: ccId, clientName: cc, amount: 70, method: 'check', reference: tag + '-2', applications: [] });
  const cp2 = chk2.body?.data?.id || chk2.body?.data?.payment?.id;
  const memo2 = (await q(`SELECT id FROM credit_memos WHERE "sourceClientPaymentId" = $1`, [cp2]))[0];
  const ref2 = await api('POST', '/business/refunds', { creditMemoId: memo2?.id, amount: 70, method: 'check' });
  await api('POST', `/business/client-payments/${cp2}/void`, { reason: 'bounced' });
  const vref2 = await api('DELETE', `/business/refunds/${ref2.body?.data?.id}`);
  const m2 = (await q(`SELECT amount, "voidedAt" FROM credit_memos WHERE id = $1`, [memo2?.id]))[0];
  check('…same when the refund had used the whole memo (not un-voided)', ref2.status === 200 && vref2.status === 200 && !!m2.voidedAt && near(m2.amount, 0) && vref2.body?.data?.creditRestored === false, `${JSON.stringify(m2)}`);
  const chk3 = await api('POST', '/business/client-payments', { clientId: ccId, clientName: cc, amount: 30, method: 'check', reference: tag + '-3', applications: [] });
  const cp3 = chk3.body?.data?.id || chk3.body?.data?.payment?.id;
  const memo3 = (await q(`SELECT id FROM credit_memos WHERE "sourceClientPaymentId" = $1`, [cp3]))[0];
  const ref3 = await api('POST', '/business/refunds', { creditMemoId: memo3?.id, amount: 30, method: 'check' });
  const vref3 = await api('DELETE', `/business/refunds/${ref3.body?.data?.id}`);
  const m3 = (await q(`SELECT amount, "remainingAmount", "voidedAt" FROM credit_memos WHERE id = $1`, [memo3?.id]))[0];
  check('…while the check stands, voiding the refund still puts the credit back', vref3.status === 200 && vref3.body?.data?.creditRestored === true && !m3.voidedAt && near(m3.remainingAmount, 30), JSON.stringify(m3));

  console.log('\nInvoice PDF / statement after the payments were voided (W4), payment dates (W27)');
  const pc = tag + ' Pdf';
  const pcId = (await api('POST', '/clients', { name: pc })).body?.data?.id;
  const V = await mkWo(pc);
  const vp = await addPart(V, 300);
  await api('POST', `/quickbooks/assign-invoice-number/${V}`);
  const v0 = await totalOf(V);
  await api('POST', `/business/ledger/${V}/payments`, { amount: v0, paymentMethod: 'check', paymentType: 'full', paymentDate: '2026-03-05' });
  const pdf0 = pdfText((await api('GET', `/quickbooks/invoice-pdf/${V}`)).body);
  check('a date-only payment date prints as entered (03/05/2026)', /03\/05\/2026/.test(pdf0) && !/03\/04\/2026/.test(pdf0), pdf0.split('\n').filter(l => /2026/.test(l)).join(' | '));
  await api('PUT', `/workorders/${V}/parts/${vp}`, { partTotal: 250, laborTotal: 250 });
  const v1 = await totalOf(V);
  // the overpayment is refunded (a refund stays given back when the payment is voided later)
  const mv = await api('POST', '/business/refunds', { sourceWorkOrderId: V, amount: r2(v0 - v1), method: 'check' });
  const pid = (await q(`SELECT id FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [V]))[0]?.id;
  const vv = await api('DELETE', `/business/ledger/payments/${pid}`);
  const hv = await hist(pcId, V);
  const owed = r2(v1 + (v0 - v1));
  const pdf1 = pdfText((await api('GET', `/quickbooks/invoice-pdf/${V}`)).body);
  check('invoice PDF: the money returned is listed and BALANCE DUE is the ledger balance',
    mv.status === 200 && vv.status === 200 && hv && near(hv.balance, owed) && /Overpayment returned/.test(pdf1) && /BALANCE DUE/.test(pdf1) && pdf1.includes(money(owed)) && !/TOTAL DUE/.test(pdf1),
    `${mv.status} ${vv.status} ledger=${hv && hv.balance} want=${money(owed)} pdf=${pdf1.split('\n').filter(l => /\$|DUE|PAID|Overpay/.test(l)).join(' | ')}`);
  const st = await api('GET', `/clients/${pcId}/statement-pdf`);
  const stx = pdfText(st.body);
  check('statement: PAID is never negative, the money returned has its own line, the balance matches the ledger',
    st.status === 200 && !/\$-/.test(stx) && /Returned to client/.test(stx) && stx.includes('$' + owed.toFixed(2)),
    stx.split('\n').filter(l => /\$/.test(l)).join(' | '));

  console.log(`\nr17-money: ${pass} passed, ${fail} failed`);
  await pg.query(`DELETE FROM api_keys WHERE name LIKE $1`, [tag + '%']);
  await pg.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
