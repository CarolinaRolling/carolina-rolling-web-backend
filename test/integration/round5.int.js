/**
 * Round 5 checks (tablet contract): H1 (heat country kept), H2 (shipment status validation), M10
 * (tablet lists include every open record), L10 (quote amounts). Runs against a RUNNING server and a
 * LOCAL test database.
 *
 *   DATABASE_URL=<local test db> TEST_BASE_URL=http://localhost:5055/api node test/integration/round5.int.js
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
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
}

(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  TOKEN = await login(process.env.TEST_ADMIN_USER || 'boss');
  const tag = 'R5' + Date.now().toString(36);

  console.log('\nH1 — heat numbers keep their country of origin');
  const wo = (await api('POST', '/workorders', { clientName: tag + ' Co' })).body.data.id;
  const part = (await api('POST', `/workorders/${wo}/parts`, { partType: 'plate_roll', quantity: 10 })).body.data.id;
  await api('PUT', `/workorders/${wo}/parts/${part}`, { heatBreakdown: [{ heat: 'A100', qty: 6, country: 'US' }, { heat: 'B200', qty: 4, country: 'MX' }] });
  // what an older tablet / the old web save sends: heat + qty only
  const t1 = await api('PUT', `/workorders/${wo}/parts/${part}`, { operatorNotes: 'rolled', heatBreakdown: [{ heat: 'A100', qty: 5 }, { heat: ' b200 ', qty: 4 }, { heat: 'C300', qty: 1 }] });
  const hb = (await q(`SELECT "heatBreakdown" FROM work_order_parts WHERE id = $1`, [part]))[0].heatBreakdown;
  const by = Object.fromEntries(hb.map(r => [r.heat.trim().toUpperCase(), r]));
  check('a save without countries keeps each heat\'s stored country (case/space-insensitive)', t1.status === 200 && by.A100?.country === 'US' && by.B200?.country === 'MX', JSON.stringify(hb));
  check('…and keeps the new quantities; a new heat has no country', by.A100?.qty === 5 && by.C300 && !by.C300.country, JSON.stringify(hb));
  await api('PUT', `/workorders/${wo}/parts/${part}`, { heatBreakdown: [{ heat: 'A100', qty: 5, country: '' }] });
  const hb2 = (await q(`SELECT "heatBreakdown" FROM work_order_parts WHERE id = $1`, [part]))[0].heatBreakdown;
  check('sending country "" still clears it on purpose', hb2.length === 1 && hb2[0].country === '', JSON.stringify(hb2));

  console.log('\nH2 — shipment status');
  const ship = (await api('POST', '/shipments', { clientName: tag + ' Co', description: 'plate' })).body.data.shipment;
  const bad = await api('PUT', `/shipments/${ship.id}`, { status: 'waiting_for_materials' });
  check('a work-order status on a shipment → 400 with the allowed list (was a 500)', bad.status === 400 && /stored/.test(bad.body?.error?.message || ''), `${bad.status} ${bad.body?.error?.message}`);
  const blank = await api('PUT', `/shipments/${ship.id}`, { status: null, notes: 'x' });
  check('a blank status is ignored, the rest saves', blank.status === 200 && blank.body?.data?.status === 'received', `${blank.status} ${blank.body?.data?.status}`);
  const ok = await api('PUT', `/shipments/${ship.id}`, { status: 'stored' });
  check('"stored" still saves', ok.status === 200 && ok.body?.data?.status === 'stored', ok.status);

  console.log('\nM10 — tablets see every open shipment and delivery');
  // one old shipment still on the floor, then 150 newer closed ones
  await pg.query(`INSERT INTO shipments (id, "qrCode", "clientName", status, "receivedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'stored', now() - interval '400 days', now(), now())`, [tag + '-OLD', tag + ' Co']);
  await pg.query(`INSERT INTO shipments (id, "qrCode", "clientName", status, "receivedAt", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), $1 || '-' || g, $2, 'archived', now() - (g || ' minutes')::interval, now(), now() FROM generate_series(1, 150) g`, [tag, tag + ' Co']);
  const all = await api('GET', '/shipments');
  const codes = (all.body?.data || []).map(s => s.qrCode);
  check('the default list (tablets) includes a 400-day-old shipment still in storage', codes.includes(tag + '-OLD'), `${all.status} n=${codes.length}`);
  check('…and caps closed ones at the 100 most recent', (all.body?.data || []).filter(s => ['shipped', 'archived'].includes(s.status)).length === 100);
  await pg.query(`INSERT INTO shipments (id, "qrCode", "clientName", status, "receivedAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, NULL, now() - interval '500 days', now(), now())`, [tag + '-NULL', tag + ' Co']);
  const active = await api('GET', '/shipments?status=active');
  check('a shipment with no status (left by the old PUT) still counts as open', (await api('GET', '/shipments')).body.data.some(s => s.qrCode === tag + '-NULL') && active.body.data.some(s => s.qrCode === tag + '-NULL'));
  check('status=active returns only open shipments, including the old one', (active.body?.data || []).every(s => !['shipped', 'archived'].includes(s.status)) && active.body.data.some(s => s.qrCode === tag + '-OLD'));
  const paged = await api('GET', '/shipments?limit=20&offset=0');
  check('an explicit limit still pages', paged.body?.data?.length === 20 && paged.body.total > 20, `${paged.body?.data?.length} / ${paged.body?.total}`);

  await pg.query(`INSERT INTO inbound_orders (id, "purchaseOrderNumber", description, "clientName", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'old plate', $2, 'pending', now() - interval '300 days', now())`, ['PO-' + tag + '-OLD', tag + ' Co']);
  await pg.query(`INSERT INTO inbound_orders (id, "purchaseOrderNumber", description, "clientName", status, "createdAt", "updatedAt")
    SELECT gen_random_uuid(), 'PO-' || $1 || '-' || g, 'plate', $2, 'received', now() - (g || ' minutes')::interval, now() FROM generate_series(1, 150) g`, [tag, tag + ' Co']);
  const ib = await api('GET', '/inbound');
  const pos = (ib.body?.data || []).map(o => o.purchaseOrderNumber);
  check('the inbound list includes a 300-day-old delivery still expected', pos.includes('PO-' + tag + '-OLD'), `n=${pos.length}`);
  const ibOpen = await api('GET', '/inbound?status=open');
  check('status=open returns only expected deliveries', (ibOpen.body?.data || []).length > 0 && ibOpen.body.data.every(o => !['received', 'cancelled'].includes(o.status)));

  console.log('\nL10 — quote reminders show an amount');
  const est = (await api('POST', '/estimates', { clientName: tag + ' Co' })).body.data.id;
  await pg.query(`UPDATE estimates SET "grandTotal" = 1234.5 WHERE id = $1`, [est]);
  const drafts = await api('GET', '/estimates/unsent-drafts');
  const list = Array.isArray(drafts.body?.data) ? drafts.body.data : (drafts.body?.data?.drafts || drafts.body?.data?.items || []);
  const mine = list.find(d => d.id === est);
  check('unsent drafts carry the estimate\'s grand total as a number', mine && mine.total === 1234.5, `${drafts.status} ${JSON.stringify(mine || drafts.body).slice(0, 160)}`);

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
