/**
 * Several label printers with a shop default per type (17 Oct). Old single-printer configs are
 * converted on read, older tablet apps still get the old fields, only admins can change printers.
 * Runs against a RUNNING server and a LOCAL test database; restores the printer config it found.
 */
const path = require('path');
const crypto = require('crypto');
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5055/api';
const PASS = process.env.TEST_ADMIN_PASS || 'pw123456';
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, d); } };
async function call(method, url, body, headers) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
const login = async (u) => (await call('POST', '/auth/login', { username: u, password: PASS })).body?.data?.token;
(async () => {
  const pg = new PG({ connectionString: DB }); await pg.connect();
  const before = (await pg.query(`SELECT value FROM app_settings WHERE key='printer_config'`)).rows[0];
  const boss = await login(process.env.TEST_ADMIN_USER || 'boss');
  const clerk = await login(process.env.TEST_USER || 'clerk');
  const A = (m, u, b) => call(m, u, b, { Authorization: `Bearer ${boss}` });
  const k = 'prn_' + crypto.randomBytes(8).toString('hex');
  await pg.query(`INSERT INTO api_keys (id,name,key,permissions,"isActive","deviceName","createdAt","updatedAt") VALUES (gen_random_uuid(),$1,$2,'read_write',true,$3,now(),now())`, ['prn-tab', k, 'prn-tab']);
  try {
    console.log('\nAn old single-printer config is converted on read');
    await pg.query(`DELETE FROM app_settings WHERE key='printer_config'`);
    await pg.query(`INSERT INTO app_settings (id,key,value,"createdAt","updatedAt") VALUES (gen_random_uuid(),'printer_config',$1,now(),now())`,
      [JSON.stringify({ qrPrinterIp: '192.168.1.40', qrLabelType: 'CONTINUOUS_29', qrLabelLengthMm: 25, partPrinterIp: '192.168.1.41', partLabelType: 'DK_11202_62x100' })]);
    let g = await A('GET', '/settings/printer-config');
    const d = g.body?.data || {};
    check('two printers, one per type, as the defaults', d.printers?.length === 2 && d.defaultQrPrinterId === 'legacy_qr' && d.defaultPartPrinterId === 'legacy_part', JSON.stringify(d));
    check('…and the old fields are still answered', d.qrPrinterIp === '192.168.1.40' && d.partPrinterIp === '192.168.1.41' && d.qrLabelLengthMm === 25);
    check('converted QR printer keeps the tablet\'s own cut length (null)', d.printers?.find(p => p.id === 'legacy_qr')?.labelLengthMm === null);

    console.log('\nAn old config with one printer doing both keeps its part label size');
    await pg.query(`UPDATE app_settings SET value=$1 WHERE key='printer_config'`, [JSON.stringify({ qrPrinterIp: '192.168.1.40', qrLabelType: 'CONTINUOUS_29', qrLabelLengthMm: 25, partPrinterIp: '', partLabelType: 'CONTINUOUS_29' })]);
    g = await A('GET', '/settings/printer-config');
    const lp = g.body?.data?.printers?.find(x => x.id === 'legacy_part');
    check('part labels keep going to that printer, with their own label size', lp?.type === 'part' && lp.ip === '192.168.1.40' && lp.labelType === 'CONTINUOUS_29' && g.body.data.partPrinterIp === '192.168.1.40' && g.body.data.partLabelType === 'CONTINUOUS_29', JSON.stringify(g.body?.data));

    console.log('\nSaving several printers');
    const body = { printers: [
      { id: 'legacy_qr', name: 'Shop QR', type: 'qr', ip: '192.168.1.40', labelType: 'CONTINUOUS_29', labelLengthMm: 25 },
      { id: 'legacy_part', name: 'Shop floor parts', type: 'part', ip: '192.168.1.41', labelType: 'DK_11202_62x100' },
      { id: 'new_1', name: 'Office parts', type: 'part', ip: '192.168.1.55', labelType: 'DK_11209_29x62' },
      { name: 'Spare QR', type: 'qr', ip: 'ql810-spare.local', labelType: 'QR_29x25', active: false },
    ], defaultQrPrinterId: 'legacy_qr', defaultPartPrinterId: 'new_1' };
    let p = await A('PUT', '/settings/printer-config', body);
    const s = p.body?.data || {};
    const office = s.printers?.find(x => x.name === 'Office parts');
    check('saved 4 printers', p.status === 200 && s.printers?.length === 4, JSON.stringify(p.body).slice(0, 300));
    check('a temporary id gets a real one and the default follows it', /^p_[0-9a-f]{8}$/.test(office?.id || '') && s.defaultPartPrinterId === office.id, JSON.stringify(s));
    check('old fields follow the new defaults', s.partPrinterIp === '192.168.1.55' && s.partLabelType === 'DK_11209_29x62' && s.qrPrinterIp === '192.168.1.40');
    check('a hostname is accepted; inactive is kept', s.printers.find(x => x.name === 'Spare QR')?.active === false);
    g = await A('GET', '/settings/printer-config');
    const canon = (o) => JSON.stringify(o, Object.keys(o).sort()) + JSON.stringify((o.printers || []).map(x => [x.id, x.name, x.type, x.ip, x.labelType, x.labelLengthMm, x.active]));
    check('…and reads back the same', canon(g.body.data) === canon(s), JSON.stringify(g.body.data));

    console.log('\nDefaults that don\'t fit are corrected');
    p = await A('PUT', '/settings/printer-config', { printers: s.printers, defaultQrPrinterId: office.id, defaultPartPrinterId: s.printers.find(x => x.name === 'Spare QR').id });
    check('a part printer can\'t be the QR default; an inactive one can\'t be a default', p.body?.data?.defaultQrPrinterId === 'legacy_qr' && p.body?.data?.defaultPartPrinterId === 'legacy_part', JSON.stringify(p.body?.data));

    console.log('\nValidation');
    const bad = async (pr, re) => { const r = await A('PUT', '/settings/printer-config', { printers: [pr] }); return r.status === 400 && re.test(r.body?.error?.message || ''); };
    check('no name → 400', await bad({ type: 'qr', ip: '10.0.0.1' }, /name/i));
    check('bad type → 400', await bad({ name: 'X', type: 'laser', ip: '10.0.0.1' }, /type/i));
    check('bad IP → 400', await bad({ name: 'X', type: 'qr', ip: '10.0.0.300' }, /IP/));
    check('bad cut length → 400', await bad({ name: 'X', type: 'qr', ip: '10.0.0.1', labelLengthMm: 2 }, /cut length/i));
    const many = await A('PUT', '/settings/printer-config', { printers: Array.from({ length: 31 }, (_, i) => ({ name: 'P' + i, type: 'qr', ip: '10.0.0.' + (i + 1) })) });
    check('more than 30 → 400', many.status === 400);
    g = await A('GET', '/settings/printer-config');
    check('a refused save changes nothing', g.body?.data?.printers?.length === 4);

    console.log('\nWho can read and change it');
    const tabletRead = await call('GET', '/settings/printer-config', null, { 'X-API-Key': k });
    check('a tablet reads the printer list', tabletRead.status === 200 && tabletRead.body?.data?.printers?.length === 4, tabletRead.status);
    const tabletPut = await call('PUT', '/settings/printer-config', { printers: [] }, { 'X-API-Key': k });
    check('a tablet can\'t change it', tabletPut.status === 403, tabletPut.status);
    const clerkPut = await call('PUT', '/settings/printer-config', { printers: [] }, { Authorization: `Bearer ${clerk}` });
    check('a non-admin user can\'t change it', clerkPut.status === 403, clerkPut.status);

    console.log('\nAn older office page (single-printer fields) still saves');
    p = await A('PUT', '/settings/printer-config', { qrPrinterIp: '192.168.1.60', qrLabelType: 'CONTINUOUS_29', qrLabelLengthMm: 25, partPrinterIp: '', partLabelType: 'DK_11202_62x100' });
    check('stored as a QR printer that also does part labels (as before)', p.status === 200 && p.body?.data?.printers?.length === 2 && p.body.data.qrPrinterIp === '192.168.1.60' && p.body.data.partPrinterIp === '192.168.1.60', JSON.stringify(p.body?.data));
    const empty = await A('PUT', '/settings/printer-config', { printers: [] });
    check('an empty list is allowed (no printers)', empty.status === 200 && empty.body.data.printers.length === 0 && empty.body.data.defaultQrPrinterId === null);
  } finally {
    await pg.query(`DELETE FROM app_settings WHERE key='printer_config'`);
    if (before) await pg.query(`INSERT INTO app_settings (id,key,value,"createdAt","updatedAt") VALUES (gen_random_uuid(),'printer_config',$1,now(),now())`, [JSON.stringify(before.value)]);
    await pg.query(`DELETE FROM api_keys WHERE key=$1`, [k]);
    await pg.end();
  }
  console.log(`\nprinters: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
