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

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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

  // Fallback to Cloudinary
  const result = await cloudinary.uploader.upload(filePath, {
    folder,
    resource_type: resourceType,
    type: 'private',
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

module.exports = {
  uploadFile,
  uploadBuffer,
  deleteFile,
  getProvider,
  useS3
};
