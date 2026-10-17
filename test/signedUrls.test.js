// Round 10 (R7): bucket links leaving the API are signed; signed links coming back are stored plain.
// Signing is offline (no network), so fake credentials are enough.
process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTEST'; process.env.AWS_SECRET_ACCESS_KEY = 'secret';
process.env.AWS_S3_BUCKET = 'carolina-rolling-files'; process.env.AWS_S3_REGION = 'us-west-1';
const assert = require('assert');
const storage = require('../src/utils/storage');
const { signAll, signStoredUrls } = require('../src/services/signedUrls');
let n = 0; const ok = (name) => { n++; console.log('  PASS ', name); };
(async () => {
  const raw = 'https://carolina-rolling-files.s3.us-west-1.amazonaws.com/work-orders/abc/print%20one.pdf';
  const other = 'https://res.cloudinary.com/demo/raw/upload/x.pdf';
  const body = { data: { url: raw, files: [{ url: raw }, { url: other }], note: 'see ' + raw, toJSON: undefined },
    inst: { toJSON() { return { imageUrl: raw }; } } };
  const out = await signAll(body);
  assert(/X-Amz-Signature=/.test(out.data.url) && out.data.url.startsWith('https://carolina-rolling-files.s3.us-west-1.amazonaws.com/work-orders/abc/print%20one.pdf?'));
  ok('a stored bucket URL is replaced by a signed link');
  assert(/X-Amz-Signature=/.test(out.inst.imageUrl)); ok('…including inside model instances (toJSON)');
  assert.strictEqual(out.data.files[1].url, other); ok('other hosts are left alone');
  assert.strictEqual(out.data.note, 'see ' + raw); ok('only whole-URL strings are signed (text mentioning a URL is untouched)');
  assert(/X-Amz-Expires=10800/.test(out.data.url)); ok('links last three hours from the start of the hour');
  const again = await signAll({ url: raw });
  assert.strictEqual(again.url, out.data.url); ok('the same file gets the same link within the hour (images cache)');
  assert.strictEqual(storage.unsignedStoredUrl(out.data.url), raw); ok('a signed link sent back is stored as the plain URL');
  const req = { body: { value: { url: out.data.url } } }; const res = { json: () => res };
  signStoredUrls(req, res, () => {});
  assert.strictEqual(req.body.value.url, raw); ok('the middleware strips signatures from incoming JSON');
  assert.strictEqual(storage.s3IdFor(null, raw), 's3:work-orders/abc/print one.pdf'); ok('stored URLs map back to their storage id');
  const none = { a: 1 }; assert.strictEqual(await signAll(none), none); ok('responses without bucket URLs pass through unchanged');
  const typed = await signAll({ description: raw, notes: [raw], fileUrl: raw });
  assert.strictEqual(typed.description, raw); assert.strictEqual(typed.notes[0], raw); assert(/X-Amz-Signature=/.test(typed.fileUrl));
  ok('a bucket URL typed into a free-text field is NOT signed (only stored-file fields are)');
  // a route that answers twice must not crash the process
  const sent = []; const res2 = { headersSent: false, json(b) { if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT'); this.headersSent = true; sent.push(b); return this; } };
  signStoredUrls({ body: {}, method: 'GET', originalUrl: '/api/x' }, res2, () => {});
  res2.json({ url: raw }); res2.json({ url: raw });
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(sent.length, 1); ok('a second answer to the same request is dropped and logged, not thrown');
  const bk = { body: {}, method: 'GET', originalUrl: '/api/backup?includeFiles=false' }; const res3 = { json(b) { return b; } };
  const before = res3.json; signStoredUrls(bk, res3, () => {}); assert.strictEqual(res3.json, before); ok('backup downloads keep plain stored URLs');
  console.log(`\n${n} passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
