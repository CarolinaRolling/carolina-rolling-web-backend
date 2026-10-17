/**
 * Round 14 checks (third independent audit, remaining mediums): overpayment shows as credit (T4), card
 * surcharge (T6), legacy exported invoices print their stored total (R16), DR allocation under load (T13),
 * DR release and lot numbers + Undo (T17, R26), duplicates copy everything priced (T20), unlink guards and
 * restore (T21, T22), case-insensitive merge (T23), received deliveries (R21), scanned-estimate references
 * (R22), one inspection job per part (T37), tablet shipment updates (T38), malformed part fields (T39),
 * recurring bills (T45), FK delete rules (R24).
 * Runs against a RUNNING server and a LOCAL test database.
 */
const path = require('path');
const crypto = require('crypto');
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
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN, extra = {}) => call(m, u, b, { Authorization: `Bearer ${t}`, ...extra });
const key = (m, u, k, b) => call(m, u, b, { 'X-API-Key': k });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const CLERK = await login(process.env.TEST_USER || 'clerk');
  const tag = 'R14' + Date.now().toString(36);
  const client = tag + ' Co';
  const clientId = (await api('POST', '/clients', { name: client })).body?.data?.id;
  const mkKey = async (fields = {}) => {
    const k = 'r14_' + crypto.randomBytes(8).toString('hex');
    const f = { name: tag + '-' + k.slice(-4), key: k, permissions: 'read_write', isActive: true, ...fields };
    const cols = Object.keys(f);
    await pg.query(`INSERT INTO api_keys (id, ${cols.map(c => `"${c}"`).join(',')}, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${cols.map((_, i) => '$' + (i + 1)).join(',')}, now(), now())`, Object.values(f));
    return k;
  };
  const mkWo = async (extra = {}) => (await api('POST', '/workorders', { clientName: client, ...extra })).body?.data?.id;
  const ledger = async (id) => ((await api('GET', `/business/ledger?search=`)).body?.data?.invoices || []).find(i => i.id === id);
  const balanceOf = async (id) => (await pg.query(`SELECT 1`), (await api('GET', `/business/client-open-invoices/${clientId}`)).body?.data || []).find(x => x.wo?.id === id);

  console.log('\nOverpayment shows as a credit (T4)');
  const O = await mkWo();
  const oPart = (await api('POST', `/workorders/${O}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 300, laborTotal: 300 })).body?.data?.id;
  await api('POST', `/quickbooks/assign-invoice-number/${O}`);
  await sleep(300);
  const oTot = (await api('GET', `/workorders/${O}/invoice-totals`)).body?.data?.grandTotal;
  const pay = await api('POST', `/business/ledger/${O}/payments`, { amount: oTot, paymentMethod: 'check', paymentType: 'full' });
  await api('PUT', `/workorders/${O}/parts/${oPart}`, { partTotal: 200, laborTotal: 200 });
  await sleep(600);
  const oTot2 = (await api('GET', `/workorders/${O}/invoice-totals`)).body?.data?.grandTotal;
  const hist = (await api('GET', `/clients/${clientId}/history`)).body?.data;
  const hWo = (hist?.workOrders || []).find(w => w.id === O);
  check('an invoice that drops after payment shows the excess as overpaid, not lost', pay.status === 200 && oTot2 < oTot && hWo && near(hWo.overpaid, r2(oTot - oTot2)) && near(hist.overpaidTotal, r2(oTot - oTot2)),
    `${pay.status} ${oTot}→${oTot2} ${JSON.stringify(hWo && { o: hWo.overpaid, b: hWo.balance })} ${hist?.overpaidTotal}`);
  const ledg = (await api('GET', `/business/ledger?status=overpaid`)).body?.data;
  check('…and the invoice ledger lists it under "overpaid"', (ledg?.invoices || []).some(i => i.id === O && near(i.overpaid, r2(oTot - oTot2))) && ledg.overpaidCount >= 1, JSON.stringify(ledg && { c: ledg.overpaidCount, n: ledg.invoices?.length }));

  const mv = await api('POST', `/business/ledger/${O}/overpayment-to-credit`);
  const hist2 = (await api('GET', `/clients/${clientId}/history`)).body?.data;
  const memo = (hist2?.creditMemos || []).find(m => m.sourceWorkOrderId === O);
  check('…and "move to client credit" turns it into a credit memo, after which the invoice is no longer overpaid', mv.status === 200 && memo && near(memo.amount, r2(oTot - oTot2))
      && near((hist2.workOrders || []).find(w => w.id === O)?.overpaid, 0) && (await api('POST', `/business/ledger/${O}/overpayment-to-credit`)).status === 409,
    `${mv.status} ${JSON.stringify(memo && memo.amount)} ${hist2 && hist2.overpaidTotal}`);

  console.log('\nCard surcharge (T6)');
  const C = await mkWo();
  await api('POST', `/workorders/${C}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 300, laborTotal: 300 });
  await api('POST', `/quickbooks/assign-invoice-number/${C}`);
  await sleep(300);
  const cTot = (await api('GET', `/workorders/${C}/invoice-totals`)).body?.data?.grandTotal;
  const gross = r2((cTot + 0.15) / (1 - 0.026));
  const cp = await api('POST', `/business/ledger/${C}/payments`, { amount: gross, paymentMethod: 'credit_card', ccProcessingType: 'in_person' });
  const cRow = (await q(`SELECT amount, "cardSurcharge" FROM work_order_payments WHERE "workOrderId" = $1 AND "voidedAt" IS NULL`, [C]))[0];
  const cPaid = (await q(`SELECT "paymentDate" FROM work_orders WHERE id = $1`, [C]))[0].paymentDate;
  check('paying "Total with Credit Card Fees" by card pays the invoice; the extra is recorded as the surcharge', cp.status === 200 && cRow && near(cRow.amount, cTot) && near(cRow.cardSurcharge, gross - cTot) && !!cPaid,
    `${cp.status} ${JSON.stringify(cp.body).slice(0, 120)} ${JSON.stringify(cRow)} paid=${cPaid}`);
  const C2 = await mkWo();
  await api('POST', `/workorders/${C2}/parts`, { partType: 'fab_service', quantity: 1, partTotal: 120, laborTotal: 120 });
  await api('POST', `/quickbooks/assign-invoice-number/${C2}`);
  await sleep(300);
  const c2Tot = (await api('GET', `/workorders/${C2}/invoice-totals`)).body?.data?.grandTotal;
  const gross2 = r2((c2Tot + 0.15) / (1 - 0.035));
  const tp = await api('POST', '/business/client-payments', { clientId, clientName: client, amount: gross2, method: 'credit_card', ccProcessingType: 'manual', applications: [{ workOrderId: C2, amount: c2Tot }] });
  check('…and through Take Payment it is a surcharge, not client credit', tp.status === 200 && !tp.body?.data?.creditMemo && near(tp.body?.data?.payment?.cardSurcharge, gross2 - c2Tot),
    `${tp.status} ${JSON.stringify(tp.body).slice(0, 200)}`);
  const M1 = await mkWo(), M2 = await mkWo();
  for (const [m, amt] of [[M1, 150], [M2, 275]]) { await api('POST', `/workorders/${m}/parts`, { partType: 'fab_service', quantity: 1, partTotal: amt, laborTotal: amt }); await api('POST', `/quickbooks/assign-invoice-number/${m}`); }
  await sleep(300);
  const m1 = (await api('GET', `/workorders/${M1}/invoice-totals`)).body?.data?.grandTotal, m2 = (await api('GET', `/workorders/${M2}/invoice-totals`)).body?.data?.grandTotal;
  const grossM = r2(r2((m1 + 0.15) / (1 - 0.026)) + r2((m2 + 0.15) / (1 - 0.026)));
  const tpM = await api('POST', '/business/client-payments', { clientId, clientName: client, amount: grossM, method: 'credit_card', applications: [{ workOrderId: M1, amount: m1 }, { workOrderId: M2, amount: m2 }] });
  check('paying two invoices by card at their printed card totals is a surcharge too (not credit)', tpM.status === 200 && !tpM.body?.data?.creditMemo && near(tpM.body?.data?.payment?.cardSurcharge, grossM - m1 - m2),
    `${tpM.status} ${JSON.stringify(tpM.body).slice(0, 160)}`);
  const sur = (await api('GET', '/business/payments/card-surcharges')).body?.data;
  check('…and both appear in the card-surcharge report for booking', (sur?.items || []).filter(i => i.workOrderId === C || i.clientName === client).length >= 2, JSON.stringify(sur).slice(0, 160));
  const over = await api('POST', `/business/ledger/${C2}/payments`, { amount: 999, paymentMethod: 'credit_card' });
  check('a card amount that is not the surcharge total is still refused as more than owed', over.status === 400, over.status);

  console.log('\nLegacy exported invoices print their stored total (R16)');
  const IT = require(path.join(__dirname, '../../src/services/invoiceTotals'));
  const fake = { grandTotal: 1000, taxAmount: 0, shippingTotal: 0, isTaxExempt: true, partsAfterDiscount: 1000 };
  const pr = IT.printableTotals(fake, { iifExportedAt: new Date(), totalsComputedAt: null, grandTotal: '1095.00', taxAmount: '95.00' });
  check('an invoice exported before totals were frozen prints the stored $1,095, as the ledger counts it', near(pr.grandTotal, 1095) && near(pr.taxAmount, 95) && pr.frozenDiffers, JSON.stringify(pr));

  console.log('\nDR numbers under load (T13)');
  const t0 = Date.now();
  const burst = await Promise.all([
    ...Array.from({ length: 15 }, () => api('POST', '/workorders', { clientName: client, assignDRNumber: true })),
    ...Array.from({ length: 5 }, () => api('POST', '/dr-numbers/assign', { clientName: client })),
  ]);
  const codes = burst.map(r => r.status);
  const drs = burst.map(r => r.body?.data?.drNumber).filter(Boolean);
  check('15 order creates + 5 DR assigns at once all succeed, quickly, with no duplicate DRs', codes.every(c => c === 201) && new Set(drs).size === drs.length && Date.now() - t0 < 25000,
    `${codes.join(',')} ${Date.now() - t0}ms dup=${drs.length - new Set(drs).size}`);

  console.log('\nReleasing a DR clears its lot numbers; Undo puts them back (T17, R26)');
  const L = (await api('POST', '/workorders', { clientName: client, assignDRNumber: true })).body?.data;
  await api('POST', `/workorders/${L.id}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"' });
  const lot0 = (await q(`SELECT "lotNumber" FROM work_order_parts WHERE "workOrderId" = $1`, [L.id]))[0]?.lotNumber;
  const rel = await api('DELETE', `/dr-numbers/${L.drNumber}/release`);
  const lot1 = (await q(`SELECT "lotNumber" FROM work_order_parts WHERE "workOrderId" = $1`, [L.id]))[0]?.lotNumber;
  check('release clears the order\'s DR-based lot numbers', rel.status === 200 && lot0 === `${L.drNumber}-1` && !lot1, `${rel.status} ${lot0} → ${lot1} ${JSON.stringify(rel.body).slice(0, 100)}`);
  const arch = (await q(`SELECT id FROM deletion_archive WHERE "tableName" = 'dr_numbers' AND "recordId" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1`))[0];
  const und = arch ? await api('POST', `/deletion-archive/${arch.id}/undo`) : { status: 0 };
  const back = (await q(`SELECT w."drNumber", p."lotNumber" FROM work_orders w JOIN work_order_parts p ON p."workOrderId" = w.id WHERE w.id = $1`, [L.id]))[0];
  check('Undo of the release gives the order its DR and lot numbers back (not just the DR log row)', und.status === 200 && back && Number(back.drNumber) === Number(L.drNumber) && back.lotNumber === lot0,
    `${und.status} ${JSON.stringify(back)} ${JSON.stringify(und.body).slice(0, 120)}`);
  const Sh = (await api('POST', '/workorders', { clientName: client, assignDRNumber: true })).body?.data;
  await pg.query(`UPDATE work_orders SET status = 'shipped', "shippedAt" = now() WHERE id = $1`, [Sh.id]);
  const relS = await api('DELETE', `/dr-numbers/${Sh.drNumber}/release`);
  check('a shipped order\'s DR can\'t be released for reuse (its lots are on the customer\'s paperwork)', relS.status === 409, relS.status);

  console.log('\nDuplicates copy everything priced (T20)');
  const E = (await api('POST', '/estimates', { clientName: client, taxRate: 9.5 })).body.data.id;
  const ep1 = (await api('POST', `/estimates/${E}/parts`, { partType: 'plate_roll', quantity: 2, thickness: '1/4"', laborTotal: '150.00', partTotal: '300.00', materialSource: 'customer_supplied' })).body?.data?.id;
  await api('POST', `/estimates/${E}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '80.00', laborTotal: '80.00', formData: { _linkedPartId: ep1 } });
  await api('PUT', `/estimates/${E}`, { discountPercent: 5, opTransports: [{ id: 'tr1', cost: 60, markup: 25, poNumber: 'TR9999' }] });
  await pg.query(`INSERT INTO shipment_charges (id, "estimateId", "carrierType", "shippingCost", "shippingMarkup", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'our_truck', 90, 0, now(), now())`, [E]);
  await api('PUT', `/estimates/${E}`, { notes: 'touch' });
  const src = (await api('GET', `/estimates/${E}`)).body?.data;
  const dup = await api('POST', `/estimates/${E}/duplicate`, {});
  const D = dup.body?.data?.id;
  const dd = D ? (await api('GET', `/estimates/${D}`)).body?.data : null;
  const dParts = dd?.parts || [];
  const dFab = dParts.find(p => p.partType === 'fab_service');
  const dPlate = dParts.find(p => p.partType === 'plate_roll');
  const fabLink = dFab && (dFab.formData || {})._linkedPartId;
  const dCharges = D ? (await q(`SELECT COUNT(*)::int n FROM shipment_charges WHERE "estimateId" = $1`, [D]))[0].n : 0;
  check('a duplicated estimate keeps trips, discount, client id and shipping charges, and its total matches', dup.status === 201 && dd && near(dd.grandTotal, src.grandTotal) && Number(dd.discountPercent) === 5
      && (dd.opTransports || []).length === 1 && !dd.opTransports[0].poNumber && dd.clientId === clientId && dCharges === 1,
    `${dup.status} ${dd && dd.grandTotal} vs ${src.grandTotal} disc=${dd && dd.discountPercent} trips=${JSON.stringify(dd && dd.opTransports)} client=${dd && dd.clientId} charges=${dCharges}`);
  check('…and its service line points at the COPIED part, not the original', !!fabLink && dPlate && fabLink === dPlate.id, `${fabLink} ${dPlate && dPlate.id} ${ep1}`);
  const conv = await api('POST', `/estimates/${E}/convert-to-workorder`, { materialReceived: true });
  const W = conv.body?.data?.workOrder?.id;
  await sleep(400);
  const reo = W ? await api('POST', `/workorders/${W}/duplicate-to-estimate`) : { status: 0 };
  const R = reo.body?.data?.id;
  const rr = R ? (await api('GET', `/estimates/${R}`)).body?.data : null;
  const rFab = (rr?.parts || []).find(p => p.partType === 'fab_service');
  const rPlate = (rr?.parts || []).find(p => p.partType === 'plate_roll');
  const rCharges = R ? (await q(`SELECT COUNT(*)::int n FROM shipment_charges WHERE "estimateId" = $1`, [R]))[0].n : 0;
  const wTot = W ? (await api('GET', `/workorders/${W}/invoice-totals`)).body?.data : null;
  check('a work-order reorder keeps client id, trips, discount and charges, with links to its own parts, and quotes what the original estimate quoted',
    reo.status === 201 && rr && rr.clientId === clientId && (rr.opTransports || []).length === 1 && Number(rr.discountPercent) === 5 && rCharges === 1
      && rFab && rPlate && (rFab.formData || {})._linkedPartId === rPlate.id && wTot && near(rr.grandTotal, src.grandTotal),
    `${reo.status} client=${rr && rr.clientId} trips=${rr && (rr.opTransports || []).length} disc=${rr && rr.discountPercent} charges=${rCharges} link=${rFab && (rFab.formData || {})._linkedPartId}/${rPlate && rPlate.id} est=${rr && rr.grandTotal} src=${src.grandTotal} wo=${wTot && wTot.grandTotal}`);

  console.log('\nUnlink (T21, T22)');
  const beta = tag + ' Beta';
  const betaId = (await api('POST', '/clients', { name: beta, taxStatus: 'taxable' })).body?.data?.id;
  const B = (await api('POST', '/workorders', { clientName: beta, taxRate: 7.25, notes: 'shop note' })).body?.data?.id;
  const EA = (await api('POST', '/estimates', { clientName: client, taxRate: 9.5, internalNotes: 'secret margin', notes: 'est note' })).body.data.id;
  await api('POST', `/estimates/${EA}/parts`, { partType: 'fab_service', quantity: 1, partTotal: '50', laborTotal: '50' });
  const taxBefore = (await q(`SELECT "taxRate" FROM work_orders WHERE id = $1`, [B]))[0].taxRate;
  await pg.query(`UPDATE estimates SET "taxRate" = 8.25 WHERE id = $1`, [EA]);
  const lk = await api('POST', `/workorders/${B}/link-estimate`, { estimateId: EA });
  const afterLink = (await q(`SELECT "clientName", "taxRate", notes, "internalNotes", "estimateLinkSnapshot" IS NOT NULL AS snap FROM work_orders WHERE id = $1`, [B]))[0];
  check('linking puts the estimate\'s internal notes in internal notes only, and keeps a snapshot on the order', lk.status === 200 && !/secret margin/.test(afterLink.notes || '') && /secret margin/.test(afterLink.internalNotes || '') && afterLink.snap,
    `${lk.status} ${JSON.stringify(afterLink)}`);
  const ul = await api('POST', `/workorders/${B}/unlink-estimate`);
  const afterUn = (await q(`SELECT "clientName", "clientId", "taxRate", notes, "internalNotes", "estimateLinkSnapshot" FROM work_orders WHERE id = $1`, [B]))[0];
  check('unlinking puts back the order\'s client and tax rate and takes the estimate\'s notes out', ul.status === 200 && afterUn.clientName === beta && afterUn.clientId === betaId && near(afterUn.taxRate, taxBefore) && !near(taxBefore, 8.25)
      && !/secret margin|est note/.test((afterUn.notes || '') + (afterUn.internalNotes || '')) && !afterUn.estimateLinkSnapshot,
    `${ul.status} ${JSON.stringify(afterUn)}`);
  const lk2 = await api('POST', `/workorders/${B}/link-estimate`, { estimateId: EA });
  await pg.query(`UPDATE work_order_parts SET "materialOrdered" = true, "materialPurchaseOrderNumber" = 'PO8302' WHERE "workOrderId" = $1 AND "formData"->>'_fromEstimateId' = $2`, [B, EA]);
  const ul2 = await api('POST', `/workorders/${B}/unlink-estimate`);
  const still = (await q(`SELECT COUNT(*)::int n FROM work_order_parts WHERE "workOrderId" = $1 AND "materialPurchaseOrderNumber" = 'PO8302'`, [B]))[0].n;
  check('unlink is refused while a line it would remove has material on order', lk2.status === 200 && ul2.status === 409 && still === 1, `${lk2.status} ${ul2.status} ${still} ${JSON.stringify(ul2.body).slice(0, 120)}`);

  console.log('\nClient merge ignores case (T23)');
  const g1 = (await api('POST', '/clients', { name: tag + ' Gamma' })).body?.data?.id;
  const g2 = (await api('POST', '/clients', { name: tag + ' Gamma Two' })).body?.data?.id;
  const portalKey = await mkKey({ clientName: (tag + ' gamma two').toUpperCase(), permissions: 'read' });
  await pg.query(`INSERT INTO shipments (id, "clientName", description, status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'x', 'received', now(), now())`, [` ${(tag + ' gamma two').toLowerCase()} `]).catch(() => {});
  const mg = await api('POST', `/clients/${g1}/merge`, { sourceId: g2 });
  const leftKey = (await q(`SELECT "clientName" FROM api_keys WHERE key = $1`, [portalKey]))[0]?.clientName;
  const leftShip = (await q(`SELECT COUNT(*)::int n FROM shipments WHERE lower(trim("clientName")) = lower($1)`, [tag + ' gamma two']))[0].n;
  check('merging moves rows and the portal key whose name differs only in case / spaces', mg.status === 200 && leftKey === tag + ' Gamma' && leftShip === 0, `${mg.status} key=${leftKey} ships=${leftShip} ${JSON.stringify(mg.body).slice(0, 100)}`);

  console.log('\nReceived deliveries (R21)');
  const vend = (await api('POST', '/vendors', { name: tag + ' Supply' })).body?.data?.id;
  const ib = (await api('POST', '/inbound', { supplierName: tag + ' Supply', vendorId: vend, purchaseOrderNumber: 'PO' + (900000 + Math.floor(Math.random() * 9999)), description: 'plate', clientName: client })).body?.data;
  await api('PUT', `/inbound/${ib.id}/receive`, { receivedBy: 'test' });
  const delC = await api('DELETE', `/inbound/${ib.id}`, null, CLERK);
  const renum = await api('PUT', `/inbound/${ib.id}`, { purchaseOrderNumber: 'PO1' });
  check('a received delivery can\'t be deleted by staff, and its PO number can\'t be edited', delC.status === 409 && renum.status === 409, `${delC.status} ${renum.status}`);
  const W2 = await mkWo();
  const ib2 = (await api('POST', '/inbound', { supplierName: tag + ' Supply', vendorId: vend, purchaseOrderNumber: 'PO' + (910000 + Math.floor(Math.random() * 9999)), description: 'angle', clientName: client, workOrderId: W2 })).body?.data;
  const cv = await api('POST', `/inbound/${ib2.id}/convert-to-shipment`);
  const ibAfter = (await q(`SELECT status FROM inbound_orders WHERE id = $1`, [ib2.id]))[0];
  check('convert to shipment is one step: the shipment is on the order and the delivery is received (kept as the PO\'s record)', cv.status === 201 && cv.body?.data?.workOrderId === W2 && ibAfter && ibAfter.status === 'received', `${cv.status} ${cv.body?.data?.workOrderId} ${W2} ${JSON.stringify(ibAfter)}`);

  console.log('\nScanned-estimate references (R22)');
  let refOk = false, refDetail = '';
  try {
    const ES = require(path.join(__dirname, '../../src/services/emailScanner'));
    const ref = 'RFQ-' + tag;
    await api('POST', '/estimates', { clientName: client, customerReference: ref });
    await pg.query(`UPDATE estimates SET "customerReference" = $1 WHERE "clientName" = $2 AND "customerReference" IS NULL AND "createdAt" > now() - interval '5 seconds'`, [ref, client]);
    const mine = await ES.findEstimateByCustomerRef({ clientId, clientName: client }, ref.toLowerCase());
    const theirs = await ES.findEstimateByCustomerRef({ clientId: betaId, clientName: beta }, ref);
    refOk = !!mine && !theirs; refDetail = `${!!mine} ${!!theirs}`;
  } catch (e) { refDetail = e.message; }
  check('the same RFQ reference is a duplicate only for the same client', refOk, refDetail);

  console.log('\nTablets (T37, T38, T39)');
  const dev = await mkKey({ deviceName: tag + '-tab' });
  const I = await mkWo();
  const ip = (await api('POST', `/workorders/${I}/parts`, { partType: 'plate_roll', quantity: 1, thickness: '1/4"' })).body?.data?.id;
  const j1 = await api('POST', '/inspections/job', { workOrderId: I, workOrderPartId: ip });
  const j2 = await api('POST', '/inspections/job', { workOrderId: I, workOrderPartId: ip });
  const jobs = (await q(`SELECT COUNT(*)::int n FROM inspection_jobs WHERE "workOrderPartId" = $1`, [ip]))[0].n;
  const j3 = await api('POST', '/inspections/job', { workOrderId: I, workOrderPartId: ip, inspectionPartId: ip });
  const jobs2 = (await q(`SELECT COUNT(*)::int n FROM inspection_jobs WHERE "workOrderPartId" = $1`, [ip]))[0].n;
  check('a second "create inspection job" for the same part returns the first one (tablet without a line id, web with one)', j1.body?.data?.id && j1.body.data.id === j2.body?.data?.id && j3.body?.data?.id === j1.body.data.id && jobs === 1 && jobs2 === 1, `${j1.status} ${j2.status} ${j3.status} ${jobs} ${jobs2}`);
  const shpB = (await api('POST', '/shipments', { clientName: client, description: 'r14 box' })).body?.data;
  const shp = shpB?.shipment?.id || shpB?.id;
  const relink = await key('PUT', `/shipments/${shp}`, dev, { workOrderId: I });
  const okUpd = await key('PUT', `/shipments/${shp}`, dev, { location: 'Rack 4' });
  check('a tablet can\'t re-link a shipment through a plain update, but can still update it', relink.status === 403 && okUpd.status === 200 && !(await q(`SELECT "workOrderId" FROM shipments WHERE id = $1`, [shp]))[0].workOrderId,
    `${relink.status} ${okUpd.status}`);
  const bad1 = await api('PUT', `/workorders/${I}/parts/${ip}`, { heatBreakdown: 'notalist' });
  const bad2 = await api('PUT', `/workorders/${I}/parts/${ip}`, { progressCount: -5 });
  const bad3 = await api('PUT', `/workorders/${I}/parts/${ip}`, { heatBreakdown: [{ heat: 'H1', qty: 2.5 }] });
  const good = await api('PUT', `/workorders/${I}/parts/${ip}`, { heatBreakdown: [{ heat: 'H1', qty: '2' }], progressCount: 1 });
  check('malformed heat breakdown / progress are refused; a good one is stored as numbers', bad1.status === 400 && bad2.status === 400 && bad3.status === 400 && good.status === 200
      && (await q(`SELECT "heatBreakdown" FROM work_order_parts WHERE id = $1`, [ip]))[0].heatBreakdown[0].qty === 2,
    `${bad1.status} ${bad2.status} ${bad3.status} ${good.status}`);
  await pg.query(`UPDATE work_order_parts SET "heatBreakdown" = '"notalist"'::jsonb, "progressCount" = -5 WHERE id = $1`, [ip]).catch(async () => {
    await pg.query(`UPDATE work_order_parts SET "progressCount" = -5 WHERE id = $1`, [ip]);
  });
  const tabList = await key('GET', `/workorders/${I}`, dev);
  const tp0 = (tabList.body?.data?.parts || []).find(p => p.id === ip);
  check('an old bad value in the database reaches tablets cleaned, so their list still parses', tabList.status === 200 && tp0 && (tp0.heatBreakdown === null || Array.isArray(tp0.heatBreakdown)) && tp0.progressCount === null,
    `${tabList.status} ${JSON.stringify(tp0 && { h: tp0.heatBreakdown, p: tp0.progressCount })}`);

  console.log('\nRecurring bills (T45)');
  const lb = (await api('POST', '/business/liabilities', { name: tag + ' rent', amount: 1000, dueDate: '2027-01-31', recurring: true, recurringInterval: 'monthly', category: 'rent' })).body?.data?.id;
  const [p1, p2] = await Promise.all([api('POST', `/business/liabilities/${lb}/pay`, {}), api('POST', `/business/liabilities/${lb}/pay`, {})]);
  const nexts = await q(`SELECT "dueDate"::text d FROM liabilities WHERE name = $1 AND status <> 'paid'`, [tag + ' rent']);
  check('paying a bill twice at once marks it once and makes one next bill, due Feb 28 (not Mar 3)', [p1.status, p2.status].sort().join() === '200,409' && nexts.length === 1 && nexts[0].d === '2027-02-28',
    `${p1.status} ${p2.status} ${JSON.stringify(nexts)}`);
  const BR = require(path.join(__dirname, '../../src/routes/business'));
  check('…and a bill due on a month\'s last day stays on the last day', BR.nextRecurringDue('2027-02-28', 'monthly') === '2027-03-31' && BR.nextRecurringDue('2027-01-30', 'monthly') === '2027-02-28' && BR.nextRecurringDue('2027-12-15', 'quarterly') === '2028-03-15',
    `${BR.nextRecurringDue('2027-02-28', 'monthly')} ${BR.nextRecurringDue('2027-01-30', 'monthly')} ${BR.nextRecurringDue('2027-12-15', 'quarterly')}`);

  console.log('\nForeign-key delete rules match the models (R24)');
  const conName = (await q(`SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND t.relname = 'payment_applications' AND a.attname = 'workOrderId'`))[0]?.conname;
  if (conName) {
    await pg.query(`ALTER TABLE payment_applications DROP CONSTRAINT "${conName}"`);
    await pg.query(`ALTER TABLE payment_applications ADD CONSTRAINT "${conName}" FOREIGN KEY ("workOrderId") REFERENCES work_orders(id) ON DELETE CASCADE ON UPDATE CASCADE`);
  }
  let fkOk = false, fkDetail = '';
  try {
    const { sequelize } = require(path.join(__dirname, '../../src/models'));
    const mig = require(path.join(__dirname, '../../src/db/migrations/0007-fk-delete-rules-match-models.js'));
    const out = await mig.up({ sequelize });
    const del = (await q(`SELECT c.confdeltype d, c.convalidated v FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND t.relname = 'payment_applications' AND a.attname = 'workOrderId'`))[0];
    fkOk = !!conName && del && del.d === 'a' && del.v; fkDetail = `${JSON.stringify(del)} ${JSON.stringify(out).slice(0, 120)}`;
    await sequelize.close();
  } catch (e) { fkDetail = e.message; }
  check('a boot-built CASCADE on payment_applications is moved to the model\'s rule (and validated)', fkOk, fkDetail);

  console.log(`\nround14: ${pass} passed, ${fail} failed`);
  await pg.query(`DELETE FROM api_keys WHERE name LIKE $1`, [tag + '%']);
  await pg.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
