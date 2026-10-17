/**
 * Round 17 restore checks (sixth independent audit): merge restore leaves out orders whose invoice / DR
 * number is live on another order and reports them (W10); restore report wording — allowCoreLoss and
 * the missing-sections counts (W23); "Clear existing" also clears a section that is an empty list (W22).
 * Runs against a RUNNING server and a LOCAL test database.
 *
 * Safe in the chained suite: every restore here is a MERGE restore of this script's own rows, or a
 * clear-existing request that is refused (400) or rolled back (damaged section) before anything is
 * kept. The W22 check really empties a table with "Clear existing" (it re-restores everything else
 * from a fresh backup) and runs only with R17_RESTORE_OK=1 — use a database of its own for that.
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
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json()).data?.token;
let TOKEN;
async function call(method, url, body, headers) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
const api = (m, u, b, t = TOKEN) => call(m, u, b, { Authorization: `Bearer ${t}` });
const uuid = () => crypto.randomUUID();
const restore = (data, options = {}) => api('POST', '/backup/restore?wait=1', { backup: { version: 'r17-test', data }, options });

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  // a fresh test database has no tax setting yet (orders can't be created without one)
  const tax = (await api('GET', '/settings/tax_settings')).body?.data?.value;
  if (!tax || tax.defaultTaxRate === undefined || tax.defaultTaxRate === null) await api('PUT', '/settings/tax_settings', { value: { ...(tax || {}), defaultTaxRate: 9.5 } });
  const tag = 'R17R' + Date.now().toString(36);
  const client = tag + ' Co';
  const clientId = (await api('POST', '/clients', { name: client })).body?.data?.id;
  // DR numbers far above any real sequence, unique per run
  const drBase = 700000000 + Math.floor(Math.random() * 90000000);
  const dr = (i) => drBase + i;
  const mkWo = async () => (await api('POST', '/workorders', { clientName: client, clientId })).body?.data?.id;

  console.log('\nMerge restore with re-used invoice / DR numbers (W10)');
  const B = await mkWo(), B2 = await mkWo();
  const inv = tag + '-INV';
  await q(`UPDATE work_orders SET "invoiceNumber" = $2, "drNumber" = $3, "clientId" = $4 WHERE id = $1`, [B, inv, dr(1), clientId]);
  await q(`UPDATE work_orders SET "drNumber" = $2 WHERE id = $1`, [B2, dr(2)]);
  const tmpl = (await q(`SELECT row_to_json(w) AS j FROM work_orders w WHERE id = $1`, [B]))[0].j;
  for (const k of ['portalToken', 'invoiceDate', 'invoicedBy']) delete tmpl[k];
  const wo = (over) => ({ ...tmpl, invoiceNumber: null, isVoided: false, ...over });
  const A1 = uuid(), A2 = uuid(), C = uuid(), V = uuid(), P1 = uuid(), PAY = uuid(), REG = uuid();
  const backupWos = [
    wo({ id: A1, orderNumber: tag + '-A1', drNumber: dr(3), invoiceNumber: inv,   // invoice now live on B
      parts: [{ id: P1, partNumber: 1, partType: 'fab_service', quantity: 1, status: 'pending', createdAt: tmpl.createdAt, updatedAt: tmpl.updatedAt }] }),
    wo({ id: A2, orderNumber: tag + '-A2', drNumber: dr(2) }),                       // DR now live on B2
    wo({ id: C, orderNumber: tag + '-C', drNumber: dr(4), invoiceNumber: tag + '-INV-C' }),
    wo({ id: V, orderNumber: tag + '-V', drNumber: dr(5), invoiceNumber: inv, isVoided: true }),   // voided: no clash
  ];
  const r1 = await restore({
    workOrders: backupWos,
    workOrderPayments: [{ id: PAY, workOrderId: A1, amount: 5 }],
    drNumbers: [{ id: REG, drNumber: dr(6), workOrderId: A2, status: 'active', clientName: client, createdAt: tmpl.createdAt, updatedAt: tmpl.updatedAt }],
  });
  const res1 = r1.body?.results || {};
  const there = async (t, id) => (await q(`SELECT 1 FROM ${t} WHERE id = $1`, [id])).length === 1;
  check('merge restore succeeds and reports the 2 orders as already present (with samples naming the live order)',
    r1.status === 200 && res1.workOrders?.alreadyPresent === 2 && (res1.workOrders?.alreadyPresentSamples || []).some(s => s.includes(`invoice ${inv}`)) && (res1.workOrders?.alreadyPresentSamples || []).some(s => s.includes(`DR-${dr(2)}`)),
    `${r1.status} ${JSON.stringify(res1.workOrders || r1.body).slice(0, 400)}`);
  check('…the clashing orders, their part, payment and DR register row are NOT created; the clean and the voided orders are',
    !(await there('work_orders', A1)) && !(await there('work_orders', A2)) && !(await there('work_order_parts', P1)) && !(await there('work_order_payments', PAY)) && !(await there('dr_numbers', REG))
      && (await there('work_orders', C)) && (await there('work_orders', V)));
  check('…payments / DR register rows of left-out orders counted as already present', res1.workOrderPayments?.alreadyPresent === 1 && res1.drNumbers?.alreadyPresent === 1, JSON.stringify([res1.workOrderPayments, res1.drNumbers]));
  const live = await q(`SELECT COUNT(*)::int AS n FROM work_orders WHERE "invoiceNumber" = $1 AND COALESCE("isVoided", false) = false`, [inv]);
  const guard = await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_work_orders_invoice_number_live'`);
  check('…no live duplicate invoice number; the unique invoice guard is back; no work-order core loss',
    live[0].n === 1 && guard.length === 1 && !(r1.body?.invoiceNumberDuplicates || []).length && !(res1.coreLosses || []).some(c => c.label === 'workOrders'),
    JSON.stringify({ live, guard: guard.length, dup: r1.body?.invoiceNumberDuplicates, cl: res1.coreLosses }));
  check('…and a warning says why they were left out', (r1.body?.warnings || []).some(w => /workOrders: 2 row\(s\) left out — their invoice or DR number is already in use/.test(w)), JSON.stringify(r1.body?.warnings));

  console.log('\nRestore report wording (W23)');
  // six DR register rows whose numbers are taken by live rows under other ids: a merge-only, non-blocking loss
  const regT = { status: 'active', clientName: client, createdAt: tmpl.createdAt, updatedAt: tmpl.updatedAt };
  for (let i = 10; i < 16; i++) await q(`INSERT INTO dr_numbers (id, "drNumber", status, "clientName", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'active', $2, now(), now())`, [dr(i), client]);
  const r2 = await restore({ drNumbers: Array.from({ length: 6 }, (_, i) => ({ id: uuid(), drNumber: dr(10 + i), ...regT })) });
  const w2 = (r2.body?.warnings || []).find(w => /6 of 6 DR numbers/.test(w)) || '';
  check('merge-mode register loss over the limit is committed and NOT described as "accepted with allowCoreLoss"',
    r2.status === 200 && /not blocking in a merge restore/.test(w2) && !/allowCoreLoss/.test(w2), `${r2.status} ${w2 || JSON.stringify(r2.body).slice(0, 300)}`);
  // seven work orders that cannot be inserted (no order number): refused without allowCoreLoss, committed with it
  const broken = () => Array.from({ length: 7 }, () => wo({ id: uuid(), orderNumber: null, drNumber: null }));
  const r3 = await restore({ workOrders: broken() });
  const r4 = await restore({ workOrders: broken() }, { allowCoreLoss: true });
  const w4 = (r4.body?.warnings || []).find(w => /7 of 7 work orders/.test(w)) || '';
  check('a work-order loss is refused without allowCoreLoss and, with it, reported as "committed because allowCoreLoss was set"',
    r3.status === 500 && /refusing to commit/.test(r3.body?.error?.message || '') && r4.status === 200 && /committed because allowCoreLoss was set/.test(w4),
    `${r3.status} ${r4.status} ${w4}`);
  // "Clear existing" with missing sections: refused before anything changes (the damaged estimates
  // section would roll it back anyway). Clients are cleared (empty list) — our order's client link would be cut.
  const r5 = await restore({ clients: [], estimates: 'damaged' }, { clearExisting: true });
  const ms = (r5.body?.error?.missingSections || []).find(m => m.section === 'workOrders');
  const msg5 = r5.body?.error?.message || '';
  check('MISSING_SECTIONS reports erased vs. unlinked counts per section, and the message says which',
    r5.status === 400 && r5.body?.error?.code === 'MISSING_SECTIONS' && ms && ms.erased === 0 && ms.unlinked >= 1 && ms.rows === ms.erased + ms.unlinked
      && new RegExp(`leave ${ms.unlinked} work orders row\\(s\\) without the record they point at`).test(msg5) && !/is from an older version and has no/.test(msg5),
    `${r5.status} ${JSON.stringify(r5.body).slice(0, 500)}`);
  check('…and nothing was changed', await there('clients', clientId) && await there('work_orders', B));

  console.log('\n"Clear existing" clears an empty section too (W22)');
  if (process.env.R17_RESTORE_OK !== '1') {
    console.log('  SKIP  W22 clear-existing restore — it empties tables; set R17_RESTORE_OK=1 on a database of its own');
  } else {
    const todo = (await api('POST', '/todos', { title: tag + ' todo' })).body?.data?.id;
    const full = (await api('GET', '/backup')).body;
    const before = await q(`SELECT (SELECT COUNT(*) FROM work_orders)::int AS w, (SELECT COUNT(*) FROM clients)::int AS c, (SELECT COUNT(*) FROM todo_items)::int AS t`);
    full.data.todos = [];
    const r6 = await api('POST', '/backup/restore?wait=1', { backup: full, options: { clearExisting: true, allowMissingSections: true } });
    const after = await q(`SELECT (SELECT COUNT(*) FROM work_orders)::int AS w, (SELECT COUNT(*) FROM clients)::int AS c, (SELECT COUNT(*) FROM todo_items)::int AS t`);
    check('a backup whose todos section is [] empties the todo table; everything else comes back',
      !!todo && before[0].t >= 1 && r6.status === 200 && after[0].t === 0 && after[0].w === before[0].w && after[0].c === before[0].c,
      `${r6.status} ${JSON.stringify({ before, after })} ${JSON.stringify(r6.body).slice(0, 300)}`);
    const relog = await login(process.env.TEST_ADMIN_USER || 'boss');
    check('…users are kept (signing in still works)', !!relog);
  }

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
