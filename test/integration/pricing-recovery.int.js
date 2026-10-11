/**
 * Fix Pricing (work-order page): restores prices lost to the old tablet bug from the linked estimate.
 * Covers both kinds of damage — everything blank, and material blank with a labor-only total — plus
 * preview-before-apply and orders already in QuickBooks. Runs against a RUNNING server + LOCAL test db.
 */
const path = require('path');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, d); } };
const near = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.005;
let TOKEN;
const api = async (m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

(async () => {
  TOKEN = (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: process.env.TEST_ADMIN_PASS || 'pw123456' }) })).json()).data.token;
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (s, p) => (await pg.query(s, p)).rows;
  const tag = 'PR' + Date.now().toString(36);
  const build = async () => {
    const est = (await api('POST', '/estimates', { clientName: tag })).body.data.id;
    // material 120 ea +25%, labor 300, qty 2 → (150 + 300) × 2 = 900
    await api('POST', `/estimates/${est}/parts`, { partType: 'plate_roll', quantity: 2, materialTotal: '120.00', materialMarkupPercent: '25', laborTotal: '300.00', _baseLaborTotal: '300.00', partTotal: '900.00' });
    // material 80 ea +20%, labor 200, qty 1 → 296
    await api('POST', `/estimates/${est}/parts`, { partType: 'plate_roll', quantity: 1, materialTotal: '80.00', materialMarkupPercent: '20', laborTotal: '200.00', _baseLaborTotal: '200.00', partTotal: '296.00' });
    // a part with no material at all on the estimate (customer-supplied) — must never get material
    await api('POST', `/estimates/${est}/parts`, { partType: 'plate_roll', quantity: 1, laborTotal: '150.00', _baseLaborTotal: '150.00', partTotal: '150.00' });
    const wo = (await api('POST', `/estimates/${est}/convert-to-workorder`, { materialReceived: true })).body.data.workOrder.id;
    return wo;
  };
  const parts = async (wo) => q(`SELECT "partNumber" n, "materialTotal" mt, "materialMarkupPercent" mk, "laborTotal" lt, "partTotal" pt FROM work_order_parts WHERE "workOrderId" = $1 ORDER BY 1`, [wo]);

  const W = await build();
  // A: all blank (tablet tap on old code)   B: material blank, labor-only total (re-saved after A)
  await pg.query(`UPDATE work_order_parts SET "partTotal"=NULL,"laborTotal"=NULL,"materialTotal"=NULL,"materialMarkupPercent"=NULL,"materialUnitCost"=NULL WHERE "workOrderId"=$1 AND "partNumber"=1`, [W]);
  await pg.query(`UPDATE work_order_parts SET "materialTotal"=NULL,"materialMarkupPercent"=20,"partTotal"=200 WHERE "workOrderId"=$1 AND "partNumber"=2`, [W]);

  const g = await api('GET', `/workorders/${W}`);
  check('the Fix Pricing banner shows (also for material-only damage)', g.body.data.canBackfillPricing === true);
  const pre = await api('POST', `/workorders/${W}/backfill-pricing`, { preview: true });
  const lines = pre.body?.data?.lines || [];
  check('preview lists exactly the two damaged parts and changes nothing', lines.length === 2 && /Part 1: prices were blank/.test(lines[0]) && /Part 2: material was missing.*\$200\.00 → \$296\.00/.test(lines[1]), JSON.stringify(lines));
  const still = await parts(W);
  check('…nothing was saved by the preview', still[0].pt === null && near(still[1].pt, 200));
  const ap = await api('POST', `/workorders/${W}/backfill-pricing`);
  const after = await parts(W);
  check('apply: part 1 restored to $900 with its material', ap.status === 200 && near(after[0].pt, 900) && near(after[0].mt, 120) && near(after[0].mk, 25), JSON.stringify(after[0]));
  check('apply: part 2 gets its $80 material back, total $200 → $296', near(after[1].pt, 296) && near(after[1].mt, 80) && near(after[1].lt, 200), JSON.stringify(after[1]));
  check('the customer-supplied part is left alone', near(after[2].pt, 150) && !(parseFloat(after[2].mt) > 0), JSON.stringify(after[2]));
  const g2 = await api('GET', `/workorders/${W}`);
  check('banner gone after the fix; running it again changes nothing', g2.body.data.canBackfillPricing === false && (await api('POST', `/workorders/${W}/backfill-pricing`, { preview: true })).body.data.count === 0);
  await api('PUT', `/workorders/${W}/parts/${(await q(`SELECT id FROM work_order_parts WHERE "workOrderId"=$1 AND "partNumber"=1`, [W]))[0].id}`, { status: 'in_progress', progressCount: 1 });
  check('a tablet tap afterwards no longer wipes it (round 3 fix)', near((await parts(W))[0].pt, 900));

  // reordered work order: line numbers no longer match, part type + client part number + qty still do
  const R = await build();
  await pg.query(`UPDATE work_order_parts SET "partNumber" = "partNumber" + 10 WHERE "workOrderId"=$1`, [R]);
  await pg.query(`UPDATE work_order_parts SET "materialTotal"=NULL,"partTotal"=300 WHERE "workOrderId"=$1 AND "partNumber"=11`, [R]);
  const rp = await api('POST', `/workorders/${R}/backfill-pricing`, { preview: true });
  const rl = rp.body?.data?.lines || [];
  check('a renumbered part is still matched by type + client part # + quantity when only one estimate part fits', rl.length === 1 && /Part 11: material was missing.*\$300\.00 → \$900\.00/.test(rl[0]), JSON.stringify(rl));

  // an order already in QuickBooks: preview works, apply explains instead of silently doing nothing
  const Q = await build();
  await pg.query(`UPDATE work_order_parts SET "materialTotal"=NULL,"partTotal"=200,"materialMarkupPercent"=20 WHERE "workOrderId"=$1 AND "partNumber"=2`, [Q]);
  await api('POST', `/quickbooks/assign-invoice-number/${Q}`);
  await api('POST', '/quickbooks/mark-entered', { workOrderIds: [Q] });
  const qa = await api('POST', `/workorders/${Q}/backfill-pricing`);
  check('in QuickBooks: nothing changes and the message says why', qa.body?.data?.fixed === 0 && /QuickBooks/.test(qa.body?.message || ''), JSON.stringify(qa.body));

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
