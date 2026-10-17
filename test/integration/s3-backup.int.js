// S3 database backups (17 Oct): runs the real backup code with S3's network calls replaced by an in-memory
// bucket — no AWS access needed. Needs DATABASE_URL (local test DB).
process.env.AWS_ACCESS_KEY_ID = 'AKIATEST'; process.env.AWS_SECRET_ACCESS_KEY = 'secret';
process.env.AWS_S3_BUCKET = 'carolina-rolling-files'; process.env.AWS_S3_REGION = 'us-east-2';
const B = require('path').join(__dirname, '../../') + '/';
const { S3Client } = require(B + 'node_modules/@aws-sdk/client-s3');
const store = new Map(); let listAllowed = true; let t0 = Date.now();
S3Client.prototype.send = async function (cmd) {
  const n = cmd.constructor.name, i = cmd.input;
  if (n === 'PutObjectCommand') { store.set(i.Key, { body: i.Body, enc: i.ServerSideEncryption, at: new Date(t0 += 60000) }); return {}; }
  if (n === 'GetObjectCommand') { const o = store.get(i.Key); if (!o) throw new Error('NoSuchKey'); return { Body: (async function* () { yield o.body; })() }; }
  if (n === 'DeleteObjectCommand') { store.delete(i.Key); return {}; }
  if (n === 'ListObjectsV2Command') { if (!listAllowed) { const e = new Error('AccessDenied'); throw e; }
    return { Contents: [...store].filter(([k]) => k.startsWith(i.Prefix)).map(([k, o]) => ({ Key: k, Size: o.body.length, LastModified: o.at })) }; }
  throw new Error('unexpected ' + n);
};
const cloudinary = require(B + 'node_modules/cloudinary').v2;
cloudinary.search = { expression() { return this; }, sort_by() { return this; }, max_results() { return this; }, async execute() { return { resources: [{ public_id: 'shipment-tracker-backups/backup-old', type: 'authenticated', bytes: 1234, created_at: '2026-10-10T06:00:00Z' }] }; } };
cloudinary.uploader.upload = async () => { throw new Error('Cloudinary must not be used'); };
let pass = 0, fail = 0; const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(c ? '  PASS ' : '  FAIL ', n, c ? '' : d); };
(async () => {
  const backup = require(B + 'src/routes/backup.js');
  const { AppSettings } = require(B + 'src/models');
  await AppSettings.destroy({ where: { key: 'backup_history' } });
  const r = await backup.runAutoBackup(false);
  check('backup succeeds and goes to S3', r.success && r.provider === 's3', JSON.stringify(r).slice(0, 200));
  const key = r.publicId;
  check('stored under db-backups/, encrypted', /^db-backups\/backup-.*\.json\.gz$/.test(key) && store.get(key)?.enc === 'AES256', key);
  check('download link is a signed, expiring S3 link', /X-Amz-Signature/.test(r.url) && /X-Amz-Expires=3600/.test(r.url), r.url);
  const zlib = require('zlib'); const data = JSON.parse(zlib.gunzipSync(store.get(key).body));
  check('the stored file is the whole database backup', data.counts && data.counts.workOrders >= 0 && Array.isArray(data.data?.workOrders || data.workOrders || []), Object.keys(data).join(','));
  for (let k = 0; k < 9; k++) await backup.runAutoBackup(false);
  const left = [...store.keys()].filter(k => k.startsWith('db-backups/backup-'));
  check('only the newest 8 are kept', left.length === 8, left.length);
  listAllowed = false;
  for (let k = 0; k < 3; k++) await backup.runAutoBackup(false);
  const left2 = [...store.keys()].filter(k => k.startsWith('db-backups/backup-'));
  check('still 8 kept when the AWS key may not list the bucket (from history)', left2.length === 8, left2.length);
  listAllowed = true;
  // the /info route
  const router = backup; const layer = router.stack.find(l => l.route && l.route.path === '/info');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = await new Promise((res, rej) => handler({ user: { role: 'admin' } }, { json: res, status() { return this; } }, rej));
  const cb = out.data.cloudBackups;
  check('Backup page lists S3 backups with download links', cb.filter(b => b.provider === 's3' && /X-Amz-Signature/.test(b.url)).length === 8, cb.length);
  check('…and still lists the older Cloudinary one', cb.some(b => b.provider === 'cloudinary'));
  check('storage shown as S3', out.data.storageProvider === 's3');
  check('history entries have fresh signed links', out.data.backupHistory.slice(0, 3).every(h => /X-Amz-Signature/.test(h.url || '')));
  // the /test route
  const tl = router.stack.find(l => l.route && l.route.path === '/test');
  const th = tl.route.stack[tl.route.stack.length - 1].handle;
  const tr = await new Promise((res, rej) => th({ user: { role: 'admin' }, body: {} }, { json: res, status() { return this; } }, rej));
  check('"Test backup" round-trips through S3 and cleans up', tr.data.success && tr.data.steps.some(s => /Amazon S3/.test(s.step)) && ![...store.keys()].some(k => k.includes('/test-')), JSON.stringify(tr.data.steps));
  console.log(`\ns3-backup: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
