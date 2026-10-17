/**
 * Centralized file storage — S3 for new files, Cloudinary for legacy.
 * 
 * Environment variables needed:
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_S3_BUCKET
 *   AWS_S3_REGION (default: us-west-1)
 * 
 * Falls back to Cloudinary if S3 is not configured.
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// S3 client (lazy init)
let s3Client = null;
function getS3() {
  if (!s3Client && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_S3_BUCKET) {
    s3Client = new S3Client({
      region: process.env.AWS_S3_REGION || 'us-west-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
  }
  return s3Client;
}

const BUCKET = () => process.env.AWS_S3_BUCKET;
const REGION = () => process.env.AWS_S3_REGION || 'us-west-1';
const useS3 = () => !!getS3();

/**
 * Upload a file from disk (multer temp file).
 * @param {string} filePath - Local file path
 * @param {object} options
 * @param {string} options.folder - e.g. 'work-orders/abc/parts/def'
 * @param {string} options.originalName - Original filename
 * @param {string} options.mimeType - MIME type
 * @param {string} options.resourceType - 'raw' | 'image' (for Cloudinary fallback)
 * @returns {{ url: string, storageId: string, provider: 's3' | 'cloudinary' }}
 */
async function uploadFile(filePath, options = {}) {
  const { folder = 'uploads', originalName = 'file', mimeType = 'application/octet-stream', resourceType = 'raw' } = options;
  
  if (useS3()) {
    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(originalName) || '';
    const hash = crypto.randomBytes(8).toString('hex');
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${folder}/${Date.now()}-${hash}-${safeName}`;

    await getS3().send(new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType
    }));

    const url = `https://${BUCKET()}.s3.${REGION()}.amazonaws.com/${key}`;
    return { url, storageId: `s3:${key}`, provider: 's3' };
  }

  // Fallback to Cloudinary — use 'upload' type for publicly accessible URLs
  const result = await cloudinary.uploader.upload(filePath, {
    folder,
    resource_type: resourceType,
    use_filename: true,
    unique_filename: true
  });
  return { url: result.secure_url, storageId: result.public_id, provider: 'cloudinary' };
}

/**
 * Upload a buffer (in-memory file, generated PDF, etc.)
 * @param {Buffer} buffer - File content
 * @param {object} options
 * @param {string} options.folder
 * @param {string} options.filename - Desired filename
 * @param {string} options.mimeType
 * @param {string} options.resourceType - For Cloudinary fallback
 * @returns {{ url: string, storageId: string, provider: 's3' | 'cloudinary' }}
 */
async function uploadBuffer(buffer, options = {}) {
  const { folder = 'uploads', filename = 'file', mimeType = 'application/octet-stream', resourceType = 'raw' } = options;

  if (useS3()) {
    const hash = crypto.randomBytes(8).toString('hex');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${folder}/${Date.now()}-${hash}-${safeName}`;

    await getS3().send(new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: buffer,
      ContentType: mimeType
    }));

    const url = `https://${BUCKET()}.s3.${REGION()}.amazonaws.com/${key}`;
    return { url, storageId: `s3:${key}`, provider: 's3' };
  }

  // Fallback to Cloudinary via upload_stream
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, use_filename: true, unique_filename: true },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, storageId: result.public_id, provider: 'cloudinary' });
      }
    ).end(buffer);
  });
}

/**
 * Delete a file by its storageId.
 * Handles both S3 (s3:key) and Cloudinary (public_id) formats.
 */
async function deleteFile(storageId, resourceType = 'raw') {
  if (!storageId) return;

  if (storageId.startsWith('s3:')) {
    if (!useS3()) return;
    const key = storageId.slice(3);
    try {
      await getS3().send(new DeleteObjectCommand({
        Bucket: BUCKET(),
        Key: key
      }));
    } catch (e) {
      console.warn(`[storage] S3 delete failed for ${key}: ${e.message}`);
    }
    return;
  }

  // Cloudinary
  try {
    await cloudinary.uploader.destroy(storageId, { resource_type: resourceType });
  } catch (e) {
    console.warn(`[storage] Cloudinary delete failed for ${storageId}: ${e.message}`);
  }
}

/**
 * Check which provider is active.
 */
function getProvider() {
  return useS3() ? 's3' : 'cloudinary';
}

/**
 * Get a presigned URL for an S3 object (temporary access, expires in 1 hour).
 * @param {string} storageId - The storageId (s3:key format)
 * @param {number} expiresIn - Seconds until expiry (default 3600 = 1 hour)
 * @returns {string|null} Presigned URL or null if not S3
 */
/**
 * The link to give a browser or tablet for a stored file (audit R7). S3 files get a signed link
 * that expires in an hour — it works whether or not the bucket is public, so the bucket can be made
 * private without breaking downloads. Legacy Cloudinary files keep their stored URL.
 */
function s3IdFor(storageId, storedUrl) {
  if (storageId && String(storageId).startsWith('s3:')) return storageId;
  // only OUR bucket's URLs map to a key in our bucket (any "bucket.s3[.-]region" host form)
  const ours = bucketUrlPattern();
  const looksS3 = ours ? (storedUrl && ours.test(storedUrl)) : (storedUrl && /\.s3[.-][^/]*amazonaws\.com\//.test(storedUrl));
  if (looksS3) {
    try { return 's3:' + decodeURIComponent(new URL(storedUrl).pathname.slice(1)); } catch (_) { return null; }
  }
  return null;
}
/**
 * Signed links for every stored-URL string the API hands out (round 10, R7). The signing time is
 * rounded down to the hour, so the same file gets the same link for an hour (browsers and the tablet
 * can cache images) and each link stays valid for at least two more hours.
 */
const SIGN_WINDOW_MS = 60 * 60 * 1000;
const SIGN_EXPIRES_S = 3 * 60 * 60;
const signCache = new Map();   // "<hour>|<key>" -> url
let signCacheHour = 0;
function bucketUrlPattern() {
  const b = BUCKET();
  if (!b) return null;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^https://' + esc(b) + '\\.s3(?:[.-][a-z0-9-]+)?\\.amazonaws\\.com/', 'i');
}
async function signedViewUrl(storedUrl) {
  if (!useS3() || typeof storedUrl !== 'string') return storedUrl;
  const pat = bucketUrlPattern();
  if (!pat || !pat.test(storedUrl) || /[?&]X-Amz-Signature=/i.test(storedUrl)) return storedUrl;
  let key;
  try { key = decodeURIComponent(new URL(storedUrl).pathname.slice(1)); } catch (_) { return storedUrl; }
  const hour = Math.floor(Date.now() / SIGN_WINDOW_MS) * SIGN_WINDOW_MS;
  if (hour !== signCacheHour) { signCache.clear(); signCacheHour = hour; }
  const ck = hour + '|' + key;
  if (signCache.has(ck)) return signCache.get(ck);
  const url = await getSignedUrl(getS3(), new GetObjectCommand({ Bucket: BUCKET(), Key: key }),
    { expiresIn: SIGN_EXPIRES_S, signingDate: new Date(hour) });
  signCache.set(ck, url);
  return url;
}
/** A signed link sent back to the API (e.g. a settings value saved from a form) → the plain stored URL */
function unsignedStoredUrl(s) {
  if (typeof s !== 'string' || !/[?&]X-Amz-Signature=/i.test(s)) return s;
  const pat = bucketUrlPattern();
  if (!pat || !pat.test(s)) return s;
  return s.split('?')[0];
}

async function accessUrl(storageId, storedUrl, { expiresIn = 3600, downloadName = null } = {}) {
  const sid = s3IdFor(storageId, storedUrl);
  if (sid && useS3()) {
    try { return await getPresignedUrl(sid, expiresIn, downloadName); } catch (e) { console.warn('[storage] could not sign', sid, e.message); }
  }
  return storedUrl || null;
}

async function getPresignedUrl(storageId, expiresIn = 3600, originalName = null) {
  if (!storageId || !storageId.startsWith('s3:') || !useS3()) return null;
  const key = storageId.slice(3);
  const params = {
    Bucket: BUCKET(),
    Key: key
  };
  // Set Content-Disposition so browser downloads with original filename
  if (originalName) {
    params.ResponseContentDisposition = `attachment; filename="${encodeURIComponent(originalName)}"`;
  }
  const command = new GetObjectCommand(params);
  return await getSignedUrl(getS3(), command, { expiresIn });
}

/**
 * Stream an S3 file directly to a response object.
 * @param {string} storageId - The storageId (s3:key format)
 * @param {object} res - Express response object
 * @param {object} options - { filename, contentType }
 * @returns {boolean} true if streamed, false if not S3
 */
async function streamToResponse(storageId, res, options = {}) {
  if (!storageId || !storageId.startsWith('s3:') || !useS3()) return false;
  const key = storageId.slice(3);
  const command = new GetObjectCommand({
    Bucket: BUCKET(),
    Key: key
  });
  const response = await getS3().send(command);
  
  const contentType = options.contentType || response.ContentType || 'application/octet-stream';
  const filename = options.filename || key.split('/').pop();
  
  res.setHeader('Content-Type', contentType);
  if (response.ContentLength) res.setHeader('Content-Length', response.ContentLength);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
  
  // response.Body is a readable stream
  response.Body.pipe(res);
  return true;
}

// Read a stored file back into a Buffer. Supports S3 (via GetObject) and Cloudinary/https URLs.
async function downloadToBuffer(storageId, fileUrl) {
  // S3 — by id, or recognised from a stored bucket URL (works with a private bucket; round 10, R7)
  const s3Id = s3IdFor(storageId, fileUrl);
  if (s3Id && useS3()) {
    const key = s3Id.slice(3);
    const command = new GetObjectCommand({ Bucket: BUCKET(), Key: key });
    const response = await getS3().send(command);
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  // Fallback: fetch the URL (Cloudinary secure_url or any https link we stored).
  const url = fileUrl;
  if (!url) throw new Error('No storageId or fileUrl to download');
  return await new Promise((resolve, reject) => {
    const https = require('https');
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow one redirect
        https.get(res.headers.location, (r2) => {
          const c = []; r2.on('data', d => c.push(d)); r2.on('end', () => resolve(Buffer.concat(c)));
        }).on('error', reject);
        return;
      }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
    }).on('error', reject);
  });
}

module.exports = {
  uploadFile,
  uploadBuffer,
  deleteFile,
  getProvider,
  useS3,
  getPresignedUrl,
  accessUrl,
  signedViewUrl,
  unsignedStoredUrl,
  bucketUrlPattern,
  s3IdFor,
  streamToResponse,
  downloadToBuffer
};
