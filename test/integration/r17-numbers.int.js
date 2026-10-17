/**
 * Round 17 numbering checks (sixth independent audit, W-series): lot numbers never repeat after a part
 * delete and Undo leaves no live duplicate (W6), parallel part adds get distinct lots (W17), a DR set
 * later fills blank lots (W18), a corrected typo'd invoice number gives back the sequence (W7), bad
 * document/file ids are 404 not 500 (W16), COD Record Payment keeps the card type (W26).
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
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R17N' + Date.now().toString(36);
  const client = tag + ' Co';
  await api('POST', '/clients', { name: client });
  const mkWo = async (extra = {}) => (await api('POST', '/workorders', { clientName: client, ...extra })).body?.data;
  const addPart = (id, extra = {}) => api('POST', `/workorders/${id}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"', ...extra });
  const lotsOf = async (id) => (await q(`SELECT id, "lotNumber" FROM work_order_parts WHERE "workOrderId" = $1 ORDER BY "partNumber"`, [id]));

  console.log('\nLot numbers after a part delete, and Undo (W6)');
  const L = await mkWo({ assignDRNumber: true });
  const dr = L.drNumber;
  const p1 = (await addPart(L.id)).body?.data?.id;
  const p2 = (await addPart(L.id)).body?.data?.id;
  const p3 = (await addPart(L.id)).body?.data?.id;
  await api('DELETE', `/workorders/${L.id}/parts/${p3}`);
  const p4 = (await addPart(L.id)).body?.data?.id;
  let lots = await lotsOf(L.id);
  const lot4 = lots.find(r => r.id === p4)?.lotNumber;
  check('the deleted last part\'s lot is not issued again (next is above the high-water mark)', !!dr && lot4 === `${dr}-4`, JSON.stringify(lots));
  const [arch] = await q(`SELECT id FROM deletion_archive WHERE "tableName" = 'work_order_parts' AND "recordId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [p3]);
  const un = arch ? await api('POST', `/deletion-archive/${arch.id}/undo`) : { status: 0 };
  lots = await lotsOf(L.id);
  const live = lots.map(r => r.lotNumber).filter(Boolean);
  check('Undo of that delete leaves no two live parts with the same lot', un.status === 200 && lots.length === 4 && new Set(live).size === live.length, `${un.status} ${JSON.stringify(lots)}`);
  const hw = (await q(`SELECT "lotSuffixHighWater" hw FROM work_orders WHERE id = $1`, [L.id]))[0]?.hw;
  check('the order remembers its highest lot suffix', Number(hw) >= 4, hw);
  await api('PUT', `/workorders/${L.id}/parts/${p1}`, { lotNumber: `${dr}-20` });
  await api('DELETE', `/workorders/${L.id}/parts/${p1}`);
  const p5 = (await addPart(L.id)).body?.data?.id;
  const lot5 = (await lotsOf(L.id)).find(r => r.id === p5)?.lotNumber;
  check('a lot typed by hand also raises the mark (not reissued after that part is deleted)', lot5 === `${dr}-21`, lot5);
  void p2;

  console.log('\nParallel part adds (W17)');
  const P = await mkWo({ assignDRNumber: true });
  const adds = await Promise.all(Array.from({ length: 6 }, () => addPart(P.id)));
  const plots = (await lotsOf(P.id)).map(r => r.lotNumber);
  check('six parts added at once get six different lots', adds.every(a => a.status === 201) && plots.length === 6 && new Set(plots).size === 6 && plots.every(Boolean), `${adds.map(a => a.status)} ${JSON.stringify(plots)}`);

  console.log('\nDR set after parts were added (W18)');
  const D = await mkWo();
  await addPart(D.id); await addPart(D.id);
  const before = (await lotsOf(D.id)).map(r => r.lotNumber);
  const [[{ m }]] = [await q(`SELECT COALESCE(MAX("drNumber"), 0) + 7 m FROM work_orders`)];
  const setDr = await api('PUT', `/workorders/${D.id}/dr-number`, { drNumber: Number(m) });
  const after = (await lotsOf(D.id)).map(r => r.lotNumber);
  check('setting the DR fills the parts\' blank lots <DR>-1, <DR>-2', setDr.status === 200 && before.every(l => !l) && after.join() === `${m}-1,${m}-2`, `${setDr.status} ${JSON.stringify(setDr.body).slice(0, 160)} ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  const setDr2 = await api('PUT', `/workorders/${D.id}/dr-number`, { drNumber: Number(m) + 1 });
  const after2 = (await lotsOf(D.id)).map(r => r.lotNumber);
  check('…a later DR change only renames them (no duplicates)', setDr2.status === 200 && after2.join() === `${Number(m) + 1}-1,${Number(m) + 1}-2`, `${setDr2.status} ${JSON.stringify(after2)}`);

  console.log('\nLong and customer-format lots (W6 review)');
  const G = await mkWo({ assignDRNumber: true });
  const g1 = await addPart(G.id, { lotNumber: '55-12345678901' });
  await pg.query(`UPDATE work_order_parts SET "lotNumber" = '77-20241015001' WHERE id = $1`, [g1.body?.data?.id]);
  const g2 = await addPart(G.id);
  const g3 = await addPart(G.id, { lotNumber: '4471-22' });
  const g4 = await addPart(G.id);
  const gLots = await lotsOf(G.id);
  const gHw = (await q(`SELECT "lotSuffixHighWater" hw FROM work_orders WHERE id = $1`, [G.id]))[0]?.hw;
  check('a typed lot with a long suffix is accepted, and a part with one doesn\'t block later adds', g1.status === 201 && g2.status === 201 && g4.status === 201, `${g1.status} ${g2.status} ${g4.status} ${JSON.stringify(g1.body).slice(0, 120)}`);
  check('customer lots ("4471-22", long suffixes) don\'t move the high-water mark', g3.status === 201 && gLots.find(r => r.id === g4.body?.data?.id)?.lotNumber === `${G.drNumber}-4` && Number(gHw) === 4,
    `hw=${gHw} ${JSON.stringify(gLots)}`);
  const H = await mkWo();
  await addPart(H.id, { lotNumber: '88-99999999999' }); await addPart(H.id);
  const hm = Number((await q(`SELECT COALESCE(MAX("drNumber"), 0) + 3 m FROM work_orders`))[0].m);
  const hset = await api('PUT', `/workorders/${H.id}/dr-number`, { drNumber: hm });
  const hLots = (await lotsOf(H.id)).map(r => r.lotNumber);
  check('setting the first DR still fills blank lots when another part has a long-suffix lot', hset.status === 200 && hLots[1] === `${hm}-2`, `${hset.status} ${JSON.stringify(hLots)}`);
  const E = (await api('POST', '/estimates', { clientName: client })).body?.data?.id;
  await api('POST', `/estimates/${E}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '5', laborTotal: '5' });
  const lk = await api('POST', `/workorders/${G.id}/link-estimate`, { estimateId: E });
  const eLots = (await lotsOf(G.id)).map(r => r.lotNumber);
  check('estimate copy onto an order holding a long-suffix lot works', lk.status === 200 && eLots.length === 5 && new Set(eLots).size === 5, `${lk.status} ${JSON.stringify(lk.body).slice(0, 160)} ${JSON.stringify(eLots)}`);

  console.log('\nA corrected invoice-number typo (W7)');
  const prevNext = (await q(`SELECT value FROM app_settings WHERE key = 'next_invoice_number'`))[0];
  const A = await mkWo();
  await addPart(A.id, { partType: 'fab_service', partTotal: 10, laborTotal: 10 });
  await api('POST', `/quickbooks/assign-invoice-number/${A.id}`);
  const base = Number((await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [A.id]))[0].invoiceNumber);
  const B = await mkWo();
  await addPart(B.id, { partType: 'fab_service', partTotal: 10, laborTotal: 10 });
  const typo = base + 500;
  const t1 = await api('POST', `/workorders/${B.id}/invoice`, { invoiceNumber: String(typo) });
  const t2 = await api('POST', `/workorders/${B.id}/invoice`, { invoiceNumber: String(base + 1) });
  const C = await mkWo();
  await addPart(C.id, { partType: 'fab_service', partTotal: 10, laborTotal: 10 });
  await api('POST', `/quickbooks/assign-invoice-number/${C.id}`);
  const cNum = Number((await q(`SELECT "invoiceNumber" FROM work_orders WHERE id = $1`, [C.id]))[0].invoiceNumber);
  check('after #typo is corrected before export, the next invoice number is not typo + 1', t1.status === 200 && t2.status === 200 && cNum > base + 1 && cNum < typo, `${t1.status} ${t2.status} base=${base} typo=${typo} next=${cNum}`);
  // An exported number still counts, even once voided
  await pg.query(`INSERT INTO invoice_numbers (id, "invoiceNumber", status, "voidedAt", "iifExportedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'void', now(), now(), now(), now())`, [typo + 3]);
  const pv = await api('GET', '/quickbooks/next-invoice-number');
  check('…but a voided number that reached QuickBooks still moves the sequence', pv.body?.data?.isReused || Number(pv.body?.data?.nextNumber) >= typo + 4, JSON.stringify(pv.body?.data));
  await pg.query(`DELETE FROM invoice_numbers WHERE "invoiceNumber" = $1 AND "workOrderId" IS NULL`, [typo + 3]);
  if (prevNext) await pg.query(`UPDATE app_settings SET value = $1 WHERE key = 'next_invoice_number'`, [JSON.stringify(prevNext.value)]);

  console.log('\nBad ids are 404, not 500 (W16)');
  const codes = [];
  for (const u of [`/workorders/${L.id}/documents/not-a-uuid/signed-url`, `/workorders/${L.id}/documents/123/download`, `/workorders/nope/documents/${L.id}/signed-url`,
    `/workorders/${L.id}/parts/xyz/files/${L.id}/download`, `/workorders/${L.id}/parts/${p2}/files/bad/signed-url`, `/workorders/nope/parts/${p2}/files/${L.id}/download`]) {
    codes.push((await api('GET', u)).status);
  }
  codes.push((await api('DELETE', `/workorders/${L.id}/documents/bad`)).status);
  codes.push((await api('PUT', `/workorders/${L.id}/shipment-charges/bad`, { amount: 1 })).status);
  codes.push((await api('PUT', `/workorders/${L.id}/vendor-issues/bad/resolve`, {})).status);
  codes.push((await api('PUT', `/workorders/${L.id}/parts/bad`, { quantity: 2 })).status);
  check('non-UUID document / part / file / charge / issue ids → 404', codes.every(c => c === 404), JSON.stringify(codes));
  const ro = await api('PUT', `/workorders/${L.id}/parts/reorder`, { partIds: (await lotsOf(L.id)).map(r => r.id) });
  check('…the fixed /parts/reorder route still works', ro.status === 200, `${ro.status} ${JSON.stringify(ro.body).slice(0, 120)}`);

  console.log('\nCOD Record Payment keeps the card type (W26)');
  const K = await mkWo();
  await addPart(K.id, { partType: 'fab_service', partTotal: 100, laborTotal: 100 });
  const bal = (await api('GET', `/workorders/${K.id}/invoice-totals`)).body?.data?.grandTotal;
  const rp = await api('POST', `/workorders/${K.id}/record-payment`, { paymentMethod: 'credit_card', ccProcessingType: 'manual', amount: bal }, CLERK);
  const pay = (await q(`SELECT amount, "ccProcessingType", "ccFeeAmount" FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [K.id]))[0];
  check('a card payment of exactly the balance stores the type sent and Square\'s fee', rp.status === 200 && pay && pay.ccProcessingType === 'manual' && Math.abs(Number(pay.ccFeeAmount) - (Number(bal) * 0.035 + 0.15)) < 0.011,
    `${rp.status} ${JSON.stringify(rp.body).slice(0, 160)} ${JSON.stringify(pay)} bal=${bal}`);

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
