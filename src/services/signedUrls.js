/**
 * signedUrls — every link to our S3 bucket that leaves the API is a signed, expiring link
 * (round 10, audit R7).
 *
 * Before: database rows keep the plain bucket URL of each file (part prints, documents, shipment and
 * message photos, invoice PDFs, bills, shop-supply images, the warehouse map…) and about thirty places
 * in the web app, tablet app and portals used that URL directly. That only works while the bucket is
 * public — and a public bucket means anyone with a link (forwarded email, browser history) can read
 * customer drawings and invoices forever.
 *
 * Now, in one place for every route:
 *   - outgoing JSON: any string that is exactly a URL in our bucket is replaced by a signed link
 *     (valid 2–3 hours, stable for an hour so images cache). Clients need no changes.
 *   - incoming JSON: a signed link sent back (a form that saves a URL it was given) is stored as the
 *     plain URL again, so nothing ever saves an expiring link.
 * With every link signed, the bucket can be made private (see CRITICAL-FIXES.md, round 10).
 */
const storage = require('../utils/storage');

function hostOf() {
  const pat = storage.bucketUrlPattern();
  return pat ? String(process.env.AWS_S3_BUCKET || '').toLowerCase() + '.s3' : null;
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = mapStrings(value[i], fn); return value; }
  if (value && typeof value === 'object') { for (const k of Object.keys(value)) value[k] = mapStrings(value[k], fn); return value; }
  return value;
}

// Only fields that hold a STORED file's link are signed — never free text. Otherwise anyone could
// type a bucket URL into a note or description and get it back as a working signed link.
const SIGN_KEYS = new Set(['url', 'fileUrl', 'photoUrl', 'imageUrl', 'invoicePdfUrl', 'invoiceFileUrl', 'thumbnailUrl',
  'downloadUrl', 'pdfUrl', 'mapUrl', 'warehouseMapUrl', 'signatureUrl', 'logoUrl']);
const signableKey = (k) => SIGN_KEYS.has(k);

/** Visit every string under a signable key (or a signable array) */
function mapSignable(value, fn, keyIsSignable = false) {
  if (typeof value === 'string') return keyIsSignable ? fn(value) : value;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = mapSignable(value[i], fn, keyIsSignable); return value; }
  if (value && typeof value === 'object') { for (const k of Object.keys(value)) value[k] = mapSignable(value[k], fn, signableKey(k)); return value; }
  return value;
}

/** Sign every stored bucket URL in a JSON-able value. Returns a new plain value (or the input if none). */
async function signAll(body) {
  const host = hostOf();
  if (!host || !storage.useS3()) return body;
  let text;
  try { text = JSON.stringify(body); } catch (_) { return body; }
  if (!text || !text.toLowerCase().includes(host)) return body;
  const plain = JSON.parse(text);
  const pat = storage.bucketUrlPattern();
  const found = new Set();
  mapSignable(plain, (s) => { if (pat.test(s)) found.add(s); return s; });
  if (!found.size) return plain;
  const signed = new Map();
  for (const u of found) {   // sequential: a long list must not hog the event loop in one burst
    try { signed.set(u, await storage.signedViewUrl(u)); } catch (e) { signed.set(u, u); }
  }
  return mapSignable(plain, (s) => (signed.has(s) ? signed.get(s) : s));
}

function signStoredUrls(req, res, next) {
  if (!hostOf() || !storage.useS3()) return next();
  // A backup download keeps the plain stored URLs (a restore needs them, not expiring links)
  if (/^\/api\/backup(\/|$|\?)/.test(req.originalUrl)) return next();
  // incoming: never store a signed (expiring) link
  if (req.body && typeof req.body === 'object') mapStrings(req.body, storage.unsignedStoredUrl);
  const original = res.json.bind(res);
  // Send safely: a route that answers twice (a latent bug) must cost one log line, never an
  // unhandled rejection that would stop the server
  const send = (b) => {
    if (res.headersSent) { console.warn(`[signedUrls] ${req.method} ${req.originalUrl} answered twice — second answer dropped`); return; }
    try { original(b); } catch (e) { console.warn('[signedUrls] send failed:', e.message); }
  };
  res.json = (body) => {
    signAll(body).then(send, (e) => { console.warn('[signedUrls] signing failed, sending as is:', e.message); send(body); });
    return res;
  };
  next();
}

module.exports = { signStoredUrls, signAll, mapStrings, SIGN_KEYS };
