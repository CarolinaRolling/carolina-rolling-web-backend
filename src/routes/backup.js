const express = require('express');
const { Transaction } = require('sequelize');
const { requireAdmin } = require('./auth');
const cloudinary = require('cloudinary').v2;
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Ensure cloudinary is configured
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const { 
  sequelize, 
  Shipment, ShipmentPhoto, ShipmentDocument,
  InboundOrder,
  WorkOrder, WorkOrderPart, WorkOrderPartFile, WorkOrderDocument,
  Estimate, EstimatePart, EstimatePartFile, EstimateFile,
  DRNumber, PONumber, InvoiceNumber,
  Client, Vendor,
  AppSettings, User, ApiKey, EmailLog,
  TodoItem, GmailAccount, ScannedEmail, PendingOrder,
  ShopSupply, ShopSupplyLog, VendorIssue, WeldProcedure,
  ActivityLog, DailyActivity,
  Liability, Employee, PayrollWeek, PayrollEntry, BusinessEvent
} = require('../models');

const router = express.Router();

// ============= HELPER: Build full backup object =============
async function buildBackup(includeFiles = false) {
  const backup = {
    version: '3.0',
    createdAt: new Date().toISOString(),
    data: {},
    counts: {},
    files: {}
  };

  // T31: every read below runs in ONE read-only REPEATABLE READ transaction, so the file is a
  // consistent snapshot of a single moment (before, ~45 separate autocommit reads could capture a
  // payment without the work order it was applied to, or parts added between two reads).
  await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true }, async (t) => {
    await sequelize.query('SET TRANSACTION READ ONLY', { transaction: t });

    // Clients & Vendors
    backup.data.clients = (await Client.findAll({ transaction: t })).map(c => c.toJSON());
    backup.data.vendors = (await Vendor.findAll({ transaction: t })).map(v => v.toJSON());

    // DR Numbers & PO Numbers
    backup.data.drNumbers = (await DRNumber.findAll({ transaction: t })).map(d => d.toJSON());
    backup.data.poNumbers = (await PONumber.findAll({ transaction: t })).map(p => p.toJSON());

    // Shipments (with photos & documents)
    backup.data.shipments = (await Shipment.findAll({ transaction: t,
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ]
    })).map(s => s.toJSON());

    // Inbound Orders
    backup.data.inboundOrders = (await InboundOrder.findAll({ transaction: t })).map(o => o.toJSON());

    // Work Orders (with parts, part files, and documents)
    backup.data.workOrders = (await WorkOrder.findAll({ transaction: t,
      include: [
        { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
        { model: WorkOrderDocument, as: 'documents' }
      ]
    })).map(w => w.toJSON());

    // Estimates (with parts, part files, and estimate-level files)
    backup.data.estimates = (await Estimate.findAll({ transaction: t,
      include: [
        { model: EstimatePart, as: 'parts', include: [{ model: EstimatePartFile, as: 'files' }] },
        { model: EstimateFile, as: 'files' }
      ]
    })).map(e => e.toJSON());

    // Settings
    backup.data.settings = (await AppSettings.findAll({ transaction: t })).map(s => s.toJSON());

    // Users (including password hashes for restore)
    backup.data.users = (await User.findAll({ transaction: t })).map(u => u.toJSON());

    // API Keys (full data for restore)
    backup.data.apiKeys = (await ApiKey.findAll({ transaction: t })).map(k => k.toJSON());

    // Email logs (last 500)
    backup.data.emailLogs = (await EmailLog.findAll({ transaction: t, order: [['createdAt', 'DESC']], limit: 500 })).map(e => e.toJSON());

    // Business data
    backup.data.liabilities = (await Liability.findAll({ transaction: t })).map(l => l.toJSON());
    backup.data.employees = (await Employee.findAll({ transaction: t, order: [['sortOrder', 'ASC'], ['name', 'ASC']] })).map(e => e.toJSON());
    backup.data.payrollWeeks = (await PayrollWeek.findAll({ transaction: t, include: [{ model: PayrollEntry, as: 'entries' }] })).map(p => p.toJSON());
    backup.data.businessEvents = (await BusinessEvent.findAll({ transaction: t })).map(e => e.toJSON());

    // Invoice Numbers
    backup.data.invoiceNumbers = (await InvoiceNumber.findAll({ transaction: t, order: [['createdAt', 'DESC']] })).map(i => i.toJSON());

    // Todos
    backup.data.todos = (await TodoItem.findAll({ transaction: t, order: [['createdAt', 'DESC']] })).map(t => t.toJSON());

    // Email Scanner
    backup.data.gmailAccounts = (await GmailAccount.findAll({ transaction: t })).map(g => g.toJSON());
    backup.data.scannedEmails = (await ScannedEmail.findAll({ transaction: t, order: [['createdAt', 'DESC']], limit: 1000 })).map(s => s.toJSON());
    backup.data.pendingOrders = (await PendingOrder.findAll({ transaction: t, order: [['createdAt', 'DESC']] })).map(p => p.toJSON());

    // Shop Supplies
    backup.data.shopSupplies = (await ShopSupply.findAll({ transaction: t })).map(s => s.toJSON());
    backup.data.shopSupplyLogs = (await ShopSupplyLog.findAll({ transaction: t, order: [['createdAt', 'DESC']], limit: 500 })).map(s => s.toJSON());

    // Vendor Issues
    backup.data.vendorIssues = (await VendorIssue.findAll({ transaction: t, order: [['createdAt', 'DESC']] })).map(v => v.toJSON());

    // Weld Procedures
    backup.data.weldProcedures = (await WeldProcedure.findAll({ transaction: t })).map(w => w.toJSON());

    // ---- Financial records (v299) ----------------------------------------------------------
    // These were absent from every backup taken before v299. A restore brought back every work
    // order and part but no record of who had paid — AR would have had to be rebuilt by hand.
    const {
      WorkOrderPayment, ClientPayment, PaymentApplication, CreditMemo, CreditMemoApplication,
      Refund, ShipmentCharge, WorkOrderInvoiceSend,
      InspectionJob, InspectionUnit, InspectionTool, OperatorSignature, OperatorTask,
      WorkOrderMessage
    } = require('../models');

    backup.data.workOrderPayments = (await WorkOrderPayment.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.clientPayments = (await ClientPayment.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.paymentApplications = (await PaymentApplication.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.creditMemos = (await CreditMemo.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.creditMemoApplications = (await CreditMemoApplication.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.refunds = (await Refund.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.shipmentCharges = (await ShipmentCharge.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.workOrderInvoiceSends = (await WorkOrderInvoiceSend.findAll({ transaction: t })).map(r => r.toJSON());

    // ---- Quality records --------------------------------------------------------------------
    // Inspection results and signed operator sign-offs are evidence you may have to produce.
    backup.data.inspectionTools = (await InspectionTool.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.inspectionJobs = (await InspectionJob.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.inspectionUnits = (await InspectionUnit.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.operatorSignatures = (await OperatorSignature.findAll({ transaction: t })).map(r => r.toJSON());
    backup.data.operatorTasks = (await OperatorTask.findAll({ transaction: t })).map(r => r.toJSON());

    // Order conversation history
    backup.data.workOrderMessages = (await WorkOrderMessage.findAll({ transaction: t })).map(r => r.toJSON());

    // Activity & Daily Logs (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    backup.data.activityLogs = (await ActivityLog.findAll({ transaction: t, where: { createdAt: { [require('sequelize').Op.gte]: thirtyDaysAgo } }, order: [['createdAt', 'DESC']] })).map(a => a.toJSON());
    backup.data.dailyActivity = (await DailyActivity.findAll({ transaction: t, order: [['createdAt', 'DESC']], limit: 365 })).map(d => d.toJSON());

    // Tables the backup used to leave out (audit M8). WorkOrderPresence ("in machine" heartbeats) is
    // live state, not data, and is still skipped.
    {
      const M = require('../models');
      backup.data.deletionArchive = (await M.DeletionArchive.findAll({ transaction: t })).map(r => r.toJSON());
      backup.data.inboundPaperwork = (await M.InboundPaperwork.findAll({ transaction: t })).map(r => r.toJSON());
      backup.data.convertQueueItems = (await M.ConvertQueueItem.findAll({ transaction: t })).map(r => r.toJSON());
      backup.data.deviceTokens = (await M.DeviceToken.findAll({ transaction: t })).map(r => r.toJSON());
    }
  });
  // Tables exported only in part (most recent rows). A restore must not clear these, or the older
  // rows that were never in the file are lost (M8).
  backup.partialTables = ['emailLogs', 'scannedEmails', 'shopSupplyLogs', 'activityLogs', 'dailyActivity'];

  // Counts
  backup.counts = {};
  for (const [key, val] of Object.entries(backup.data)) {
    backup.counts[key] = val.length;
  }

  // Download PDF/STEP files from Cloudinary if requested
  if (includeFiles) {
    const https = require('https');
    const http = require('http');
    
    const downloadFile = (url, maxRedirects = 5) => new Promise((resolve, reject) => {
      if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 60000 }, (response) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          let redirectUrl = response.headers.location;
          if (redirectUrl.startsWith('/')) {
            const parsed = new URL(url);
            redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
          }
          return downloadFile(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          response.resume(); // drain
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length === 0) return reject(new Error('Empty response'));
          resolve(buf);
        });
        response.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout (60s)')); });
    });

    // Try to download — files are uploaded as 'private' so need signed URLs
    const downloadFileEntry = async (entry) => {
      // S3: read with the storage credentials (works with a private bucket — R7)
      const s3Id = require('../utils/storage').s3IdFor(entry.cloudinaryId, entry.url);
      if (s3Id) return await require('../utils/storage').downloadToBuffer(s3Id);
      if (entry.cloudinaryId) {
        // For private files: use Cloudinary API download endpoint with authentication
        const timestamp = Math.floor(Date.now() / 1000);
        const publicId = entry.cloudinaryId;
        
        // Method 1: Construct authenticated API download URL
        try {
          const apiKey = process.env.CLOUDINARY_API_KEY;
          const apiSecret = process.env.CLOUDINARY_API_SECRET;
          const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
          
          // Generate signature: "public_id={id}&timestamp={ts}{api_secret}"
          const crypto = require('crypto');
          const toSign = `public_id=${publicId}&timestamp=${timestamp}`;
          const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
          
          const apiUrl = `https://api.cloudinary.com/v1_1/${cloudName}/raw/download?public_id=${encodeURIComponent(publicId)}&timestamp=${timestamp}&api_key=${apiKey}&signature=${signature}`;
          return await downloadFile(apiUrl);
        } catch (e) {
          // Method 2: Try signed delivery URL
          try {
            const signedUrl = cloudinary.url(publicId, {
              resource_type: 'raw', type: 'private', secure: true, sign_url: true
            });
            return await downloadFile(signedUrl);
          } catch (e2) {
            // Fall through
          }
        }
      }
      // Last resort: stored URL
      return await downloadFile(entry.url);
    };

    // Collect all file URLs from document/file tables (these are all PDFs, drawings, specs — not images)
    const fileEntries = [];

    // WO part files (all are prints/drawings)
    for (const wo of backup.data.workOrders) {
      for (const part of (wo.parts || [])) {
        for (const f of (part.files || [])) {
          if (f.url) {
            fileEntries.push({ id: f.id, url: f.url, cloudinaryId: f.cloudinaryId, name: f.originalName || f.filename, source: 'wo_part_file' });
          }
        }
      }
      for (const d of (wo.documents || [])) {
        if (d.url) {
          fileEntries.push({ id: d.id, url: d.url, cloudinaryId: d.cloudinaryId, name: d.originalName, source: 'wo_document' });
        }
      }
    }

    // Estimate part files + estimate-level files
    for (const est of backup.data.estimates) {
      for (const part of (est.parts || [])) {
        for (const f of (part.files || [])) {
          if (f.url) {
            fileEntries.push({ id: f.id, url: f.url, cloudinaryId: f.cloudinaryId, name: f.originalName || f.filename, source: 'est_part_file' });
          }
        }
      }
      for (const f of (est.files || [])) {
        if (f.url) {
          fileEntries.push({ id: f.id, url: f.url, cloudinaryId: f.cloudinaryId, name: f.originalName || f.filename, source: 'est_file' });
        }
      }
    }

    // Shipment documents (MTRs, POs, etc. — skip photos)
    for (const ship of backup.data.shipments) {
      for (const d of (ship.documents || [])) {
        if (d.url) {
          fileEntries.push({ id: d.id, url: d.url, cloudinaryId: d.cloudinaryId, name: d.originalName, source: 'shipment_document' });
        }
      }
    }

    // Deduplicate by URL
    const seen = new Set();
    const uniqueFiles = fileEntries.filter(f => {
      if (seen.has(f.url)) return false;
      seen.add(f.url);
      return true;
    });

    // Only attempt to download files from Cloudinary (skip NAS, localhost, etc.)
    const downloadableFiles = uniqueFiles.filter(f => f.cloudinaryId || (f.url && f.url.includes('cloudinary.com')));
    const skippedCount = uniqueFiles.length - downloadableFiles.length;
    if (skippedCount > 0) {
      console.log(`[backup] Skipping ${skippedCount} non-Cloudinary files (NAS/localhost/other)`);
    }

    const withCloudId = downloadableFiles.filter(f => !!f.cloudinaryId).length;
    console.log(`[backup] Downloading ${downloadableFiles.length} files (${withCloudId} have cloudinaryId, ${downloadableFiles.length - withCloudId} missing)...`);
    if (downloadableFiles.length > 0) {
      const s = downloadableFiles[0];
      console.log(`[backup] Sample: name=${s.name}, cloudinaryId=${s.cloudinaryId || 'NULL'}, url=${(s.url || '').substring(0, 100)}`);
    }
    let downloaded = 0;
    let failed = 0;
    const failedFiles = [];

    // Download in batches of 3 with delay (Cloudinary Admin API rate limited to 500/hr)
    for (let i = 0; i < downloadableFiles.length; i += 3) {
      const batch = downloadableFiles.slice(i, i + 3);
      const results = await Promise.allSettled(batch.map(async (entry) => {
        const buffer = await downloadFileEntry(entry);
        return { entry, buffer };
      }));
      
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          const { entry, buffer } = result.value;
          backup.files[entry.url] = {
            name: entry.name,
            source: entry.source,
            size: buffer.length,
            data: buffer.toString('base64')
          };
          downloaded++;
        } else {
          const entry = batch[j];
          const errMsg = result.reason?.message || 'Unknown error';
          if (failed < 3) {
            console.warn(`[backup] DETAILED FAIL #${failed + 1}: ${entry.name}`);
            console.warn(`[backup]   cloudinaryId: ${entry.cloudinaryId || 'NONE'}`);
            console.warn(`[backup]   url: ${entry.url}`);
            console.warn(`[backup]   error: ${errMsg}`);
          }
          failedFiles.push({ name: entry.name, error: errMsg, cloudinaryId: entry.cloudinaryId });
          failed++;
        }
      }
      
      if (i + 3 < downloadableFiles.length) {
        console.log(`[backup] Progress: ${downloaded + failed}/${downloadableFiles.length} (${downloaded} ok, ${failed} failed)`);
        // Longer delay — Admin API calls per file, respect rate limits
        await new Promise(r => setTimeout(r, 500));
      }
    }

    backup.counts._files = { total: uniqueFiles.length, cloudinary: downloadableFiles.length, skipped: skippedCount, downloaded, failed, failedFiles: failedFiles.slice(0, 20) };
    console.log(`[backup] Files: ${downloaded} downloaded, ${failed} failed`);
  }

  return backup;
}

// ============= HELPER: Upload backup to Cloudinary =============
// Backups hold the whole database (password hashes, API keys, Gmail tokens), so they are stored as
// Cloudinary "authenticated" assets: they can only be downloaded through a URL signed with the API
// secret. Previously they were public files with a guessable, timestamp-based name (audit C3).
const BACKUP_DELIVERY_TYPE = 'authenticated';
// Download links are made on request and EXPIRE after an hour (round 12, audit R3). Before, the link
// was signed once, never expired, and was stored in settings and e-mailed — anyone who ever saw it
// could download the whole database later.
const BACKUP_LINK_TTL_S = 3600;
// Database backups go to the shop's PRIVATE S3 bucket when S3 is configured (17 Oct), under
// db-backups/, encrypted at rest; the newest 8 are kept. Older backups still in Cloudinary stay
// listed and downloadable. type 's3' = an S3 key; anything else = a Cloudinary delivery type.
const S3_BACKUP_PREFIX = 'db-backups/';
const BACKUPS_KEPT = 8;
const backupsOnS3 = () => !!require('../utils/storage').getS3();
const s3Cmd = () => require('@aws-sdk/client-s3');
async function backupDownloadUrl(publicId, type) {
  if (!publicId) return null;
  if (type === 's3') {
    try {
      return await require('../utils/storage').getPresignedUrl('s3:' + publicId, BACKUP_LINK_TTL_S, publicId.split('/').pop());
    } catch (e) { console.warn('[backup] could not make an expiring S3 download link:', e.message); return null; }
  }
  try {
    if (cloudinary.utils && typeof cloudinary.utils.private_download_url === 'function') {
      return cloudinary.utils.private_download_url(publicId, '', {
        resource_type: 'raw', type: type || 'upload', expires_at: Math.floor(Date.now() / 1000) + BACKUP_LINK_TTL_S,
      });
    }
  } catch (e) { console.warn('[backup] could not make an expiring download link:', e.message); }
  return null;   // never fall back to a permanent link (R3)
}
// What is stored about a backup: never its link (links are made on request)
const withoutLink = (o) => { if (!o || typeof o !== 'object') return o; const { url, ...rest } = o; return rest; };

async function uploadBackupToCloud(backup, { test = false } = {}) {
  const jsonStr = JSON.stringify(backup);
  const compressed = await gzip(Buffer.from(jsonStr, 'utf-8'));
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (backupsOnS3()) {
    const storage = require('../utils/storage');
    // unique name: two backups in the same second must never share (and later delete) one file
    const key = `${S3_BACKUP_PREFIX}${test ? 'test' : 'backup'}-${dateStr}-${require('crypto').randomBytes(3).toString('hex')}.json.gz`;
    await storage.getS3().send(new (s3Cmd().PutObjectCommand)({
      Bucket: storage.bucketName(), Key: key, Body: compressed,
      ContentType: 'application/gzip', ServerSideEncryption: 'AES256',
    }));
    return {
      url: await backupDownloadUrl(key, 's3'),
      publicId: key, type: 's3', provider: 's3',
      size: compressed.length, uncompressedSize: jsonStr.length, createdAt: new Date().toISOString(),
    };
  }

  const base64 = compressed.toString('base64');
  const publicId = `shipment-tracker-backups/${test ? 'test' : 'backup'}-${dateStr}${test ? '-' + Date.now() : ''}`;

  const result = await cloudinary.uploader.upload(
    `data:application/gzip;base64,${base64}`,
    { public_id: publicId, resource_type: 'raw', type: BACKUP_DELIVERY_TYPE, overwrite: true, tags: test ? ['test-backup'] : ['auto-backup', 'database-backup'] }
  );

  return {
    url: await backupDownloadUrl(result.public_id, BACKUP_DELIVERY_TYPE),
    publicId: result.public_id,
    type: BACKUP_DELIVERY_TYPE, provider: 'cloudinary',
    size: compressed.length,
    uncompressedSize: jsonStr.length,
    createdAt: new Date().toISOString()
  };
}

/** S3 backups, newest first (needs s3:ListBucket; returns null when listing isn't allowed) */
async function listS3Backups(max = 50) {
  if (!backupsOnS3()) return [];
  const storage = require('../utils/storage');
  try {
    const out = await storage.getS3().send(new (s3Cmd().ListObjectsV2Command)({ Bucket: storage.bucketName(), Prefix: S3_BACKUP_PREFIX + 'backup-', MaxKeys: 1000 }));
    return (out.Contents || []).sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified)).slice(0, max)
      .map(o => ({ publicId: o.Key, type: 's3', provider: 's3', size: o.Size, createdAt: new Date(o.LastModified).toISOString() }));
  } catch (e) { console.warn('[backup] could not list S3 backups:', e.message); return null; }
}
async function deleteS3Backup(key) {
  if (!key || !String(key).startsWith(S3_BACKUP_PREFIX)) return;   // never anything outside db-backups/
  const storage = require('../utils/storage');
  await storage.getS3().send(new (s3Cmd().DeleteObjectCommand)({ Bucket: storage.bucketName(), Key: key }));
}

// ============= AUTO BACKUP (called by cron or run-now) =============
async function runAutoBackup(includeFiles = false) {
  const startTime = Date.now();
  console.log(`[auto-backup] Starting database backup to ${backupsOnS3() ? 'Amazon S3' : 'Cloudinary'}...`);
  
  try {
    // The cloud backup is always database-only (files are covered by S3 versioning)
    const dbBackup = await buildBackup(false);
    const uploadResult = await uploadBackupToCloud(dbBackup);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[auto-backup] Database backup uploaded: ${(uploadResult.size / 1024).toFixed(0)}KB compressed in ${duration}s`);
    console.log(`[auto-backup] Counts:`, JSON.stringify(dbBackup.counts));

    // Save to backup history (keep last 10 entries)
    let history = [];
    try {
      const histSetting = await AppSettings.findOne({ where: { key: 'backup_history' } });
      if (histSetting && histSetting.value) {
        history = typeof histSetting.value === 'string' ? JSON.parse(histSetting.value) : histSetting.value;
        if (!Array.isArray(history)) history = [];
      }
    } catch {}
    history = history.map(withoutLink);
    history.unshift({
      ...withoutLink(uploadResult),
      counts: dbBackup.counts,
      duration: `${duration}s`,
      createdAt: new Date().toISOString()
    });
    const fullHistory = history;   // before trimming: the S3 cleanup below deletes what falls off
    history = history.slice(0, 10); // keep last 10
    await AppSettings.upsert({ key: 'backup_history', value: JSON.stringify(history) });

    // Also save last backup info (legacy)
    await AppSettings.upsert({
      key: 'last_auto_backup',
      value: JSON.stringify({
        ...withoutLink(uploadResult),
        counts: dbBackup.counts,
        duration: `${duration}s`
      })
    });

    // Clean up old backups: keep the newest 8 in each place
    try {
      if (uploadResult.provider === 's3') {
        // From the history (works even if the AWS key may not list the bucket)…
        const s3Hist = fullHistory.filter(h => h && h.type === 's3' && h.publicId);
        const keep = new Set(s3Hist.slice(0, BACKUPS_KEPT).map(h => h.publicId));
        for (const old of s3Hist.slice(BACKUPS_KEPT)) {
          if (keep.has(old.publicId)) continue;
          await deleteS3Backup(old.publicId); console.log(`[auto-backup] Deleted old backup: ${old.publicId}`);
        }
        // …and anything else in db-backups/ beyond the newest 8, when listing is allowed
        const listed = await listS3Backups(1000);
        if (listed) for (const old of listed.slice(BACKUPS_KEPT)) {
          if (keep.has(old.publicId) || old.publicId === uploadResult.publicId) continue;
          await deleteS3Backup(old.publicId); console.log(`[auto-backup] Deleted old backup: ${old.publicId}`);
        }
      } else {
        const searchResult = await cloudinary.search
          .expression('folder:shipment-tracker-backups AND resource_type:raw')
          .sort_by('created_at', 'desc')
          .max_results(50)
          .execute();
        if (searchResult.resources && searchResult.resources.length > BACKUPS_KEPT) {
          for (const old of searchResult.resources.slice(BACKUPS_KEPT)) {
            await cloudinary.uploader.destroy(old.public_id, { resource_type: 'raw', type: old.type || 'upload' });
            console.log(`[auto-backup] Deleted old backup: ${old.public_id}`);
          }
        }
      }
    } catch (cleanErr) {
      console.error('[auto-backup] Cleanup error (non-fatal):', cleanErr.message);
    }

    // Record success so the Backup page banner reflects the most recent backup — whether it was
    // the scheduled cron OR a manual "Run Backup Now". Previously only the cron wrote this, so a
    // successful manual backup left a stale "Last Auto-Backup Failed" warning on screen.
    try {
      await AppSettings.upsert({ key: 'last_backup_status', value: { status: 'success', timestamp: new Date().toISOString(), size: uploadResult.size } });
    } catch (statusErr) { console.warn('[auto-backup] could not write success status:', statusErr.message); }

    return { success: true, ...uploadResult, counts: dbBackup.counts, duration };
  } catch (error) {
    console.error('[auto-backup] FAILED:', error.message);
    try {
      await AppSettings.upsert({ key: 'last_backup_status', value: { status: 'failed', timestamp: new Date().toISOString(), error: error.message } });
    } catch (statusErr) { console.warn('[auto-backup] could not write failed status:', statusErr.message); }
    return { success: false, error: error.message };
  }
}

// ============= ROUTES =============

// GET /api/backup - Download full backup as JSON
// Admin only: the dump contains password hashes, API keys and Gmail tokens (audit C3).
// Credentials must come in a header, never ?token= / ?apikey= (those land in logs/history).
router.get('/', (req, res, next) => {
  if (req.query.token || req.query.apikey) {
    return res.status(400).json({ error: { message: 'Send credentials in the Authorization or X-API-Key header to download a backup.' } });
  }
  next();
}, requireAdmin, async (req, res, next) => {
  try {
    const includeFiles = req.query.includeFiles === 'true';
    const backup = await buildBackup(includeFiles);
    const filename = `backup-${new Date().toISOString().split('T')[0]}${includeFiles ? '-with-files' : ''}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(backup);
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/info - Get backup stats and last auto-backup info
// Admin only: the response includes the cloud URLs of past backups, which download the full
// database (password hashes, API keys, Gmail tokens) — audit C3.
router.get('/info', requireAdmin, async (req, res, next) => {
  try {
    const [clientCount, vendorCount, drCount, poCount, shipmentCount, inboundCount, workOrderCount, estimateCount, settingsCount, userCount] = await Promise.all([
      Client.count(), Vendor.count(), DRNumber.count(), PONumber.count(),
      Shipment.count(), InboundOrder.count(), WorkOrder.count(), Estimate.count(),
      AppSettings.count(), User.count()
    ]);

    let lastAutoBackup = null;
    try {
      const setting = await AppSettings.findOne({ where: { key: 'last_auto_backup' } });
      if (setting && setting.value) {
        lastAutoBackup = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
      }
    } catch (e) { /* ignore */ }

    let lastBackupStatus = null;
    try {
      const statusSetting = await AppSettings.findOne({ where: { key: 'last_backup_status' } });
      if (statusSetting?.value) {
        lastBackupStatus = statusSetting.value;
      }
    } catch {}

    let backupHistory = [];
    try {
      const histSetting = await AppSettings.findOne({ where: { key: 'backup_history' } });
      if (histSetting && histSetting.value) {
        backupHistory = typeof histSetting.value === 'string' ? JSON.parse(histSetting.value) : histSetting.value;
        if (!Array.isArray(backupHistory)) backupHistory = [];
      }
    } catch {}

    let cloudBackups = [];
    // S3 (where backups go now) and, until they age out, older ones still in Cloudinary
    const onS3 = (await listS3Backups(10)) || [];
    let onCloudinary = [];
    try {
      const searchResult = await cloudinary.search
        .expression('folder:shipment-tracker-backups AND resource_type:raw')
        .sort_by('created_at', 'desc')
        .max_results(10)
        .execute();
      onCloudinary = (searchResult.resources || []).map(r => ({
        publicId: r.public_id, type: r.type, provider: 'cloudinary', size: r.bytes, createdAt: r.created_at,
      }));
    } catch (e) { /* cloudinary may not be configured */ }
    cloudBackups = await Promise.all([...onS3, ...onCloudinary].map(async b => ({ ...b, url: await backupDownloadUrl(b.publicId, b.type) })));

    // Older entries were stored with a permanent link — drop it from the stored copy (R3)
    try {
      if (backupHistory.some(h => h && h.url)) await AppSettings.upsert({ key: 'backup_history', value: JSON.stringify(backupHistory.map(withoutLink)) });
      if (lastAutoBackup && lastAutoBackup.url) await AppSettings.upsert({ key: 'last_auto_backup', value: JSON.stringify(withoutLink(lastAutoBackup)) });
    } catch (e) { console.warn('[backup] could not clean stored links:', e.message); }
    if (lastAutoBackup && lastAutoBackup.publicId) lastAutoBackup = { ...lastAutoBackup, url: await backupDownloadUrl(lastAutoBackup.publicId, lastAutoBackup.type || 'upload') };

    // Re-sign history links with each backup's real delivery type (old public backups may have
    // been converted to private by scripts/secure-cloud-backups.js since they were recorded)
    const typeById = new Map(cloudBackups.map(b => [b.publicId, b.type]));
    backupHistory = await Promise.all(backupHistory.map(async h => (h && h.publicId)
      ? { ...h, url: await backupDownloadUrl(h.publicId, typeById.get(h.publicId) || h.type || 'upload') } : h));

    const { getProvider } = require('../utils/storage');
    
    res.json({
      data: {
        counts: { clients: clientCount, vendors: vendorCount, drNumbers: drCount, poNumbers: poCount,
          shipments: shipmentCount, inboundOrders: inboundCount, workOrders: workOrderCount,
          estimates: estimateCount, settings: settingsCount, users: userCount },
        storageProvider: getProvider(),
        lastAutoBackup,
        lastBackupStatus,
        backupHistory,
        cloudBackups
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup/run-now - Trigger immediate cloud backup
router.post('/run-now', requireAdmin, async (req, res, next) => {
  try {
    const includeFiles = req.body.includeFiles === true;
    const result = await runAutoBackup(includeFiles);
    if (result.success) {
      // The cloud backup is the database only; files are protected by S3 versioning (N21 — the old
      // "(with files)" message was not true)
      res.json({ message: `Backup completed successfully (database only${includeFiles ? ' — files are protected by S3 versioning, not this backup' : ''}). The download link in Backup History works for an hour; reopen the page for a fresh one.`, data: result });
    } else {
      res.status(500).json({ error: { message: `Backup failed: ${result.error}` } });
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/backup/run-background - Start backup in background, email when done
router.post('/run-background', requireAdmin, async (req, res, next) => {
  try {
    const includeFiles = false;   // the cloud backup is database-only (N21)
    // The notice goes only to the admin who started it (or the configured ADMIN_EMAIL) — never to a
    // typed-in address — and it carries no download link (R3 / N21)
    const allowed = [req.user?.email, process.env.ADMIN_EMAIL].filter(Boolean).map(e => String(e).trim().toLowerCase());
    const asked = String(req.body.email || '').trim().toLowerCase();
    const email = asked && allowed.includes(asked) ? asked : allowed[0];
    if (!email) {
      return res.status(400).json({ error: { message: 'Your user account has no e-mail address (and ADMIN_EMAIL is not set), so there is nowhere to send the notice.' } });
    }

    // Respond immediately
    res.json({ message: `Backup started in background (database only). You'll receive an email at ${email} when it's done${asked && asked !== email ? ` (notices go only to your own or the admin address, not ${asked})` : ''}.` });

    // Run backup in background (after response is sent)
    setImmediate(async () => {
      const startTime = Date.now();
      let result;
      try {
        result = await runAutoBackup(includeFiles);
      } catch (err) {
        result = { success: false, error: err.message };
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      // Send email notification
      const nodemailer = require('nodemailer');
      try {
        let subject, body;
        if (result.success) {
          const sizeKB = ((result.size || 0) / 1024).toFixed(0);
          const fileCounts = result.counts || {};
          subject = `✅ Carolina Rolling Backup Complete — ${sizeKB}KB`;
          body = [
            `Backup completed successfully in ${duration}s.`,
            ``,
            `Size: ${sizeKB}KB compressed`,
            `Download: open CR Admin → Admin → Backup (links there work for an hour).`,
            ``,
            `Records:`,
            `  Clients: ${fileCounts.clients || 0}`,
            `  Work Orders: ${fileCounts.workOrders || 0}`,
            `  Estimates: ${fileCounts.estimates || 0}`,
            `  Shipments: ${fileCounts.shipments || 0}`,
            `  Inbound: ${fileCounts.inboundOrders || 0}`,
            fileCounts._files ? `\nFiles: ${fileCounts._files.downloaded || 0} downloaded, ${fileCounts._files.skipped || 0} skipped (non-Cloudinary), ${fileCounts._files.failed || 0} failed` : '',
            ``,
            `— Carolina Rolling Admin`
          ].join('\n');
        } else {
          subject = `❌ Carolina Rolling Backup Failed`;
          body = [
            `Backup failed after ${duration}s.`,
            ``,
            `Error: ${result.error || 'Unknown error'}`,
            ``,
            `Please check the Heroku logs for more details.`,
            ``,
            `— Carolina Rolling Admin`
          ].join('\n');
        }

        if (process.env.SMTP_HOST) {
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT || 587,
            secure: process.env.SMTP_SECURE === 'true',
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          });
          await transporter.sendMail({
            from: process.env.SMTP_FROM || 'noreply@carolinarolling.com',
            to: email,
            subject,
            text: body
          });
          console.log(`[backup] Email notification sent to ${email}`);
        } else {
          console.log(`[backup] SMTP not configured — would have emailed ${email}:`);
          console.log(`[backup] Subject: ${subject}`);
        }
      } catch (emailErr) {
        console.error(`[backup] Failed to send email notification: ${emailErr.message}`);
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup/test - Full round-trip test: build → compress → upload → download → verify → cleanup
router.post('/test', requireAdmin, async (req, res, next) => {
  const results = { steps: [], success: false };
  const startTime = Date.now();
  
  try {
    // Step 1: Build backup
    results.steps.push({ step: 'Build backup', status: 'running' });
    const backup = await buildBackup();
    const totalRecords = Object.values(backup.counts).reduce((a, b) => a + b, 0);
    results.steps[0] = { step: 'Build backup', status: 'ok', detail: `${totalRecords} records across ${Object.keys(backup.counts).length} tables` };

    // Step 2: Compress
    const jsonStr = JSON.stringify(backup);
    const compressed = await gzip(Buffer.from(jsonStr, 'utf-8'));
    const ratio = ((1 - compressed.length / jsonStr.length) * 100).toFixed(0);
    results.steps.push({ step: 'Compress', status: 'ok', detail: `${(jsonStr.length / 1024).toFixed(0)}KB -> ${(compressed.length / 1024).toFixed(0)}KB (${ratio}% smaller)` });

    // Step 3: Upload (S3 when configured, otherwise Cloudinary)
    const uploadResult = await uploadBackupToCloud(backup, { test: true });
    const where = uploadResult.provider === 's3' ? 'Amazon S3' : 'Cloudinary';
    results.steps.push({ step: `Upload to ${where}`, status: 'ok', detail: `${uploadResult.publicId} (private)` });

    // Step 4: Download and verify
    const https = require('https');
    const testUrl = uploadResult.url;
    if (!testUrl) throw new Error(`Could not create an expiring download link (${where})`);
    const downloadedData = uploadResult.provider === 's3'
      ? await require('../utils/storage').downloadToBuffer('s3:' + uploadResult.publicId)
      : await new Promise((resolve, reject) => {
      const get = (u, hops) => https.get(u, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && hops > 0) { response.resume(); return get(response.headers.location, hops - 1); }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
      get(testUrl, 3);
    });
    const decompressed = await gunzip(downloadedData);
    const restored = JSON.parse(decompressed.toString('utf-8'));
    const countsMatch = JSON.stringify(backup.counts) === JSON.stringify(restored.counts);
    results.steps.push({
      step: 'Download and verify', status: countsMatch ? 'ok' : 'warning',
      detail: countsMatch ? `All ${totalRecords} records verified` : 'Record counts mismatch!'
    });

    // Step 5: Clean up test file
    if (uploadResult.provider === 's3') await deleteS3Backup(uploadResult.publicId);
    else await cloudinary.uploader.destroy(uploadResult.publicId, { resource_type: 'raw', type: BACKUP_DELIVERY_TYPE });
    results.steps.push({ step: 'Clean up test file', status: 'ok' });

    results.success = countsMatch;
    results.duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    results.counts = backup.counts;

    res.json({ message: results.success ? 'Backup system verified - all tests passed' : 'Warning: verification issue', data: results });
  } catch (error) {
    results.steps.push({ step: 'ERROR', status: 'failed', detail: error.message });
    results.success = false;
    res.status(500).json({ message: 'Backup test failed', data: results, error: error.message });
  }
});

// POST /api/backup/restore - Restore from backup JSON
//
// RUN RESTORES IN A MAINTENANCE WINDOW (audit N20). A restore lifts the invoice-number unique guards
// and the integrity foreign keys / unique rules for the WHOLE database (DDL in autocommit, outside the
// restore transaction — taking those ALTERs inside it would hold ACCESS EXCLUSIVE locks on the busiest
// tables for the whole restore). The invoice-lock / totals hook pauses are per-request (round 12), but
// the guards are not. So while a restore runs on this dyno:
//   - a second restore is refused (in-process flag + pg advisory lock 8410100, which also covers
//     other dynos), and
//   - every other non-GET API request on this dyno is answered 503 "Restore in progress"
//     (middleware in src/index.js reading isRestoreRunning()). Other dynos are NOT blocked — scale to
//     one web dyno or put the app in maintenance mode before restoring.
//
// U6: with options.async = true (the Backup page) the restore runs as a background job: the POST
// answers 202 { jobId } and GET /api/backup/restore/:jobId reports progress and, at the end, the same
// report the synchronous call returns. Without it (or with ?wait=1 / options.wait) the call is
// synchronous as before: 200 report, 409 another restore runs, 400 bad file, 500 rolled back.
let restoreRunning = false;   // one restore at a time (each lifts and re-adds the same guards)
const isRestoreRunning = () => restoreRunning;

// A full backup is far bigger than the global 5 MB JSON limit (R27): this route parses its own body,
// AFTER authentication and the admin check (so nobody unauthenticated can make the server buffer
// 200 MB). index.js skips the global parser for this path. body-parser finishes on a stream event,
// which loses the request's async context (per-request undo / invoice-lock / totals pauses live
// there), so next() is re-bound to it.
const { AsyncResource } = require('async_hooks');
const restoreBodyLimit = process.env.RESTORE_BODY_LIMIT || '200mb';
const restoreJson = express.json({ limit: restoreBodyLimit });
const parseRestoreBody = (req, res, next) => restoreJson(req, res, AsyncResource.bind(next));

// ---- U1: batched restore helpers ------------------------------------------------------------
// Rows are inserted per table in chunks with ONE statement each (jsonb_populate_recordset). Before,
// every row ran in its own savepoint; each kept a lock until commit, so a production-size backup ran
// Postgres out of lock memory ("out of shared memory") part-way and still committed what it had.
const RESTORE_CHUNK = 500;
const SAVEPOINT_BUDGET = 3000;   // savepoints kept until commit (each holds a lock) — far below max_locks
const CORE_LOSS_LIMIT = 5;       // more lost rows than this (or 0.1% of the table) in a core table → roll back (U1)
const coreLossLimit = (of) => Math.max(CORE_LOSS_LIMIT, Math.ceil(of * 0.001));
const CORE_TABLES = [            // [label, table, what]
  ['clients', 'clients', 'clients'], ['workOrders', 'work_orders', 'work orders'],
  ['workOrderParts', 'work_order_parts', 'work-order parts'], ['estimates', 'estimates', 'estimates'],
  ['workOrderPayments', 'work_order_payments', 'work-order payments'], ['clientPayments', 'client_payments', 'client payments'],
  // V13: payment links and the number registers — losing these leaves AR / numbering wrong
  ['paymentApplications', 'payment_applications', 'payment applications'], ['creditMemos', 'credit_memos', 'credit memos'],
  ['creditMemoApplications', 'credit_memo_applications', 'credit-memo applications'], ['refunds', 'refunds', 'refunds'],
  ['invoiceNumbers', 'invoice_numbers', 'invoice numbers'], ['drNumbers', 'dr_numbers', 'DR numbers'],
  ['poNumbers', 'po_numbers', 'PO numbers'], ['shipmentCharges', 'shipment_charges', 'shipment charges'],
];

// sections whose table is NOT emptied by "Clear existing" when the backup's list is empty (W22 review)
const NEVER_EMPTY_CLEAR = new Set(['users', 'apiKeys']);
// V12: every top-level section buildBackup() writes, and its model (keep in step with buildBackup)
const SECTION_MODELS = {
  clients: 'Client', vendors: 'Vendor', drNumbers: 'DRNumber', poNumbers: 'PONumber', shipments: 'Shipment',
  inboundOrders: 'InboundOrder', workOrders: 'WorkOrder', estimates: 'Estimate', settings: 'AppSettings', users: 'User',
  apiKeys: 'ApiKey', emailLogs: 'EmailLog', liabilities: 'Liability', employees: 'Employee', payrollWeeks: 'PayrollWeek',
  businessEvents: 'BusinessEvent', invoiceNumbers: 'InvoiceNumber', todos: 'TodoItem', gmailAccounts: 'GmailAccount',
  scannedEmails: 'ScannedEmail', pendingOrders: 'PendingOrder', shopSupplies: 'ShopSupply', shopSupplyLogs: 'ShopSupplyLog',
  vendorIssues: 'VendorIssue', weldProcedures: 'WeldProcedure', workOrderPayments: 'WorkOrderPayment',
  clientPayments: 'ClientPayment', paymentApplications: 'PaymentApplication', creditMemos: 'CreditMemo',
  creditMemoApplications: 'CreditMemoApplication', refunds: 'Refund', shipmentCharges: 'ShipmentCharge',
  workOrderInvoiceSends: 'WorkOrderInvoiceSend', inspectionTools: 'InspectionTool', inspectionJobs: 'InspectionJob',
  inspectionUnits: 'InspectionUnit', operatorSignatures: 'OperatorSignature', operatorTasks: 'OperatorTask',
  workOrderMessages: 'WorkOrderMessage', activityLogs: 'ActivityLog', dailyActivity: 'DailyActivity',
  deletionArchive: 'DeletionArchive', inboundPaperwork: 'InboundPaperwork', convertQueueItems: 'ConvertQueueItem',
  deviceTokens: 'DeviceToken',
};
// what a clear-existing restore of a section also empties (performRestore's clearTables calls)
const CLEARED_WITH = {
  shipments: ['ShipmentPhoto', 'ShipmentDocument'],
  workOrders: ['WorkOrderPart', 'WorkOrderPartFile', 'WorkOrderDocument', 'PaymentApplication', 'WorkOrderPayment'],
  estimates: ['EstimatePart', 'EstimatePartFile', 'EstimateFile'],
  payrollWeeks: ['PayrollEntry'],
};
const NEVER_CLEARED = ['settings', 'emailLogs', 'scannedEmails', 'shopSupplyLogs', 'activityLogs', 'dailyActivity', 'deletionArchive', 'deviceTokens'];
const sectionLabel = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/**
 * V12: sections the current backup writes that this file lacks, whose rows a clear-existing restore
 * would still remove — cleared directly (payments go with work orders) or by an ON DELETE CASCADE /
 * SET NULL from a table that is cleared. Returns [{ section, table, rows, erased, unlinked }] for those
 * that have rows now (W23: erased = deleted outright or by cascade; unlinked = link set to NULL, or left
 * pointing at a row the backup does not bring back).
 */
async function missingSectionLosses(backup) {
  const M = require('../models');
  const data = backup.data;
  const has = (k) => data[k] !== undefined && data[k] !== null;
  const missing = Object.keys(SECTION_MODELS).filter(k => !has(k) && M[SECTION_MODELS[k]]);
  if (!missing.length) return [];
  const partial = new Set([...(Array.isArray(backup.partialTables) ? backup.partialTables : []), ...NEVER_CLEARED]);
  const tableOf = (name) => { const m = M[name]; if (!m) return null; const t = m.getTableName(); return typeof t === 'string' ? t : t.tableName; };
  // tables performRestore empties for the sections the file does have — W22: empty lists too (not users)
  const cleared = new Set();
  for (const [k, name] of Object.entries(SECTION_MODELS)) {
    if (!has(k) || partial.has(k) || !Array.isArray(data[k])) continue;
    if (NEVER_EMPTY_CLEAR.has(k) && !data[k].length) continue;
    for (const n of [name, ...(CLEARED_WITH[k] || [])]) { const t = tableOf(n); if (t) cleared.add(t); }
  }
  // ids the backup brings back, per table (a lifted link to one of them is re-joined, not cut loose)
  const restoredIds = new Map();
  const addIds = (name, rows) => {
    const t = tableOf(name); if (!t || !Array.isArray(rows)) return;
    if (!restoredIds.has(t)) restoredIds.set(t, new Set());
    for (const r of rows) if (r && typeof r === 'object' && r.id !== undefined && r.id !== null) restoredIds.get(t).add(String(r.id));
  };
  const NESTED = { shipments: [['photos', 'ShipmentPhoto'], ['documents', 'ShipmentDocument']], workOrders: [['parts', 'WorkOrderPart', 'WorkOrderPartFile'], ['documents', 'WorkOrderDocument']],
    estimates: [['parts', 'EstimatePart', 'EstimatePartFile'], ['files', 'EstimateFile']], payrollWeeks: [['entries', 'PayrollEntry']] };
  for (const [k, name] of Object.entries(SECTION_MODELS)) {
    if (!Array.isArray(data[k])) continue;
    addIds(name, data[k]);
    for (const [key, child, grand] of NESTED[k] || []) {
      const kids = data[k].flatMap(r => (r && Array.isArray(r[key]) ? r[key] : []));
      addIds(child, kids);
      if (grand) addIds(grand, kids.flatMap(c => (c && Array.isArray(c.files) ? c.files : [])));
    }
  }
  const [edges] = await sequelize.query(`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent, c.confdeltype AS d, a.attname AS col,
           c.conname LIKE 'fk\\_m2\\_%' AS lifted
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND (c.confdeltype IN ('c', 'n') OR c.conname LIKE 'fk\\_m2\\_%') AND c.connamespace = current_schema()::regnamespace`);
  // the fk_m2_ rules are lifted for the restore: their rows are not deleted but left pointing at nothing
  const strip = (s) => String(s).replace(/^.*\./, '').replace(/"/g, '');
  const deleted = new Set(cleared);
  for (let grew = true; grew;) {   // cascades follow cascades
    grew = false;
    for (const e of edges) if (e.d === 'c' && !e.lifted && deleted.has(strip(e.parent)) && !deleted.has(strip(e.child))) { deleted.add(strip(e.child)); grew = true; }
  }
  const out = [];
  for (const k of missing) {
    if (partial.has(k)) continue;
    const t = tableOf(SECTION_MODELS[k]);
    if (!t) continue;
    const mine = edges.filter(e => strip(e.child) === t && deleted.has(strip(e.parent)));
    const binds = [];
    const cond = (e) => {
      if (!e.lifted) return `"${e.col}" IS NOT NULL`;
      // lifted: only a link to a parent row the backup does not bring back is left dangling
      binds.push([...(restoredIds.get(strip(e.parent)) || [])]);
      return `("${e.col}" IS NOT NULL AND NOT ("${e.col}"::text = ANY($${binds.length}::text[])))`;
    };
    const erase = cleared.has(t) ? 'TRUE' : (mine.filter(e => e.d === 'c' && !e.lifted).map(cond).join(' OR ') || 'FALSE');
    const unlink = mine.filter(e => e.lifted || e.d === 'n').map(cond).join(' OR ') || 'FALSE';
    if (erase === 'FALSE' && unlink === 'FALSE') continue;
    try {
      const [[{ erased, unlinked }]] = await sequelize.query(`SELECT COUNT(*) FILTER (WHERE ${erase})::int AS erased,
        COUNT(*) FILTER (WHERE NOT (${erase}) AND (${unlink}))::int AS unlinked FROM "${t}"`, { bind: binds });
      if (erased + unlinked > 0) out.push({ section: k, table: t, rows: erased + unlinked, erased, unlinked });
    } catch (e) { if (sqlStateOf(e) !== '42P01') throw e; }   // table not in this database
  }
  return out;
}

// V27: the guards are lifted in ONE short transaction with a lock wait limit, retried a few times
const LIFT_ATTEMPTS = 4;
const LIFT_RETRY_MS = 2000;
const sqlStateOf = (e) => (e && (e.parent?.code || e.original?.code || e.code)) || null;
// Errors caused by one row's data (bad value, constraint, duplicate in the same statement). Anything
// else — out of shared memory (53xxx), serialization / deadlock (40xxx), cancel (57014), a lost
// connection (08xxx, ECONN…) — is about the restore itself and must roll everything back (U1).
const isRowError = (e) => { const c = sqlStateOf(e); return !!c && /^(2[23]...|21000|42804)$/.test(String(c)); };
const fatalError = (e) => {
  const c = sqlStateOf(e);
  const err = new Error(`${e.message || e}${c ? ` (SQLSTATE ${c})` : ''}`);
  err.fatal = true;
  return err;
};
const CHILD_KEYS = ['parts', 'files', 'documents', 'photos', 'entries'];
const countRows = (arr) => (Array.isArray(arr) ? arr.reduce((n, r) => n + 1 + (r && typeof r === 'object'
  ? CHILD_KEYS.reduce((m, k) => m + countRows(r[k]), 0) : 0), 0) : 0);

// ---- U6: restore jobs (in memory — one web dyno; kept 6 hours) ----
const restoreJobs = new Map();
const JOB_TTL_MS = 6 * 3600 * 1000;
const pruneJobs = () => {
  const now = Date.now();
  for (const [id, j] of restoreJobs) if (j.finishedAt && now - Date.parse(j.finishedAt) > JOB_TTL_MS) restoreJobs.delete(id);
};
const jobView = (j) => ({ jobId: j.id, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, startedBy: j.startedBy,
  options: j.options, progress: j.progress, result: j.result, error: j.error, usersReplaced: !!j.usersReplaced });
// V28: what the sign-in-free status route shows — status, progress, counts and warnings; no row data
const publicJobView = (j) => {
  const r = j.result;
  return {
    jobId: j.id, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, usersReplaced: !!j.usersReplaced,
    progress: j.progress,
    error: j.error ? String(j.error).replace(/ First failures:[\s\S]*$/, ')') : null,
    result: r ? {
      message: r.message,
      results: Object.fromEntries(Object.entries(r.results || {}).map(([k, v]) => [k,
        Array.isArray(v) ? { count: v.length } : (v && typeof v === 'object')
          ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'number')) : v])),
      failed: r.failed, fileResults: r.fileResults && { checked: r.fileResults.checked, reuploaded: r.fileResults.reuploaded, alreadyExist: r.fileResults.alreadyExist, failed: r.fileResults.failed },
      warnings: r.warnings || [],
      partial: true,   // the full report needs an admin sign-in
    } : null,
  };
};
const tokenMatches = (given, want) => {
  if (typeof given !== 'string' || !want) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
};

router.post('/restore', requireAdmin, parseRestoreBody, async (req, res, next) => {
  if (restoreRunning) return res.status(409).json({ error: { message: 'A restore is already running. Wait for it to finish.' } });
  // checked before any guard is lifted
  if (!req.body || !req.body.backup || !req.body.backup.data || typeof req.body.backup.data !== 'object' || Array.isArray(req.body.backup.data)) {
    return res.status(400).json({ error: { message: 'Invalid backup file' } });
  }
  const opts = (req.body.options && typeof req.body.options === 'object') ? req.body.options : {};
  const wait = req.query.wait === '1' || req.query.wait === 'true' || opts.wait === true;
  const background = !wait && (opts.async === true || req.query.async === '1');
  // V12: an older backup restored with "Clear existing" must not silently wipe tables it has no section for
  if (opts.clearExisting && opts.allowMissingSections !== true) {
    let losses;
    try { losses = await missingSectionLosses(req.body.backup); } catch (e) { return next(e); }
    if (losses.length) {
      return res.status(400).json({ error: {
        code: 'MISSING_SECTIONS',
        // W23: say what happens to each section's rows (erased vs. links cut), not one merged guess
        message: `This backup has no ${losses.map(l => sectionLabel(l.section)).join(', ')} section${losses.length > 1 ? 's' : ''} (probably made by an older version). Restoring with "Clear existing" would ${
          losses.map(l => [l.erased && `erase ${l.erased} ${sectionLabel(l.section)} row(s)`, l.unlinked && `leave ${l.unlinked} ${sectionLabel(l.section)} row(s) without the record they point at`].filter(Boolean).join(' and ')).join('; ')} — restore without "Clear existing", or confirm you want that.`,
        missingSections: losses,
      } });
    }
  }
  // A database lock refuses a restore started on another dyno too. It is held in its own small
  // transaction for the WHOLE run — including the steps after the data is committed — and released
  // on every exit path (U6).
  let lockTx;
  try {
    lockTx = await sequelize.transaction();
    const [[{ got }]] = await sequelize.query('SELECT pg_try_advisory_xact_lock(8410100) AS got', { transaction: lockTx });
    if (!got) { await lockTx.rollback(); return res.status(409).json({ error: { message: 'A restore is already running. Wait for it to finish.' } }); }
  } catch (e) {
    if (lockTx) { try { await lockTx.rollback(); } catch (_) { /* ended */ } }
    return next(e);
  }
  if (restoreRunning) { try { await lockTx.rollback(); } catch (_) { /* ended */ } return res.status(409).json({ error: { message: 'A restore is already running. Wait for it to finish.' } }); }
  restoreRunning = true;
  pruneJobs();
  const job = {
    id: require('crypto').randomUUID(), status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    startedBy: req.user?.username || null, options: { clearExisting: !!opts.clearExisting, background },
    progress: { phase: 'starting', table: null, tableDone: 0, tableTotal: 0, rowsDone: 0, rowsTotal: countRows(Object.values(req.body.backup.data).flat()) },
    result: null, error: null, httpStatus: null,
    statusToken: require('crypto').randomBytes(24).toString('hex'),   // V28: lets the page follow the job after the users are replaced
    usersReplaced: false,
  };
  restoreJobs.set(job.id, job);
  // Runs in this request's async context, so the per-request undo / totals / invoice-lock pauses
  // apply to it even after a background answer has been sent. Never rejects.
  const run = performRestore(req.body, lockTx, job);
  if (background) {
    return res.status(202).json({ jobId: job.id, status: 'running', statusToken: job.statusToken,
      message: 'Restore started. Follow it at GET /api/backup/restore/' + job.id + ' (or, without a sign-in, GET /api/backup-status/' + job.id + '?statusToken=…)' });
  }
  await run;
  if (job.status === 'done') return res.json(job.result);
  return res.status(job.httpStatus || 500).json({ error: { message: job.error } });
});

// GET /api/backup/restore/:jobId — status of a background restore (U6)
router.get('/restore/:jobId', requireAdmin, (req, res) => {
  pruneJobs();
  const job = restoreJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: { message: 'No such restore job (jobs are kept for 6 hours on the server that ran them).' } });
  res.json({ data: jobView(job) });
});

// V28: GET /api/backup-status/:jobId?statusToken=… — mounted in index.js WITHOUT authenticate, because a
// fresh-install restore replaces the signed-in first-boot admin. The token from the 202 is the only key;
// a wrong token answers the same 404 as an unknown job.
const publicStatus = (req, res) => {
  res.set('Cache-Control', 'no-store');
  pruneJobs();
  const job = restoreJobs.get(String(req.params.jobId || ''));
  if (!job || !tokenMatches(req.query.statusToken, job.statusToken)) {
    return res.status(404).json({ error: { message: 'No such restore job (jobs are kept for 6 hours on the server that ran them).' } });
  }
  res.json({ data: publicJobView(job) });
};

async function performRestore(body, lockTx, job) {
  const setProgress = (p) => { Object.assign(job.progress, p); };
  let restoreTx = null;
  // Pause the invoice-total hooks while tables are wiped and re-inserted (they would otherwise
  // recompute totals from half-restored data and overwrite the restored values).
  const invoiceTotals = require('../services/invoiceTotals');
  const invoiceNumbersSvc = require('../services/invoiceNumbers');
  const invoiceLock = require('../services/invoiceLock');
  invoiceTotals.suspendTotalsHooks();
  invoiceLock.suspendInvoiceLock();   // a restore rewrites exported orders wholesale
  const undo = require('../services/undo');
  const resumeUndo = undo.suspendUndo();   // this request's deletes aren't copied into Deleted Items (others' still are)
  let invoiceGuardReport = null;
  const integrity = require('../services/integrityConstraints');
  let integrityRestored = false;
  try {
    setProgress({ phase: 'lifting guards' });
    // An older backup may contain duplicate invoice numbers (from before the H4 fix). Lift the two
    // unique guards during the restore so those rows aren't silently skipped, and put them back after
    // — any duplicates are then reported instead of losing work orders.
    // Same for the round-6 integrity rules (foreign keys, part numbers, unique names): tables are
    // re-inserted in an order they would reject. They're put back (and reported) at the end.
    // V27: all in one transaction with a 5 s lock wait (a long-running read on one of these tables used
    // to make the DROP wait forever and queue every query behind it). Still locked after a few tries →
    // the restore stops with nothing changed.
    for (let attempt = 1; ; attempt++) {
      try {
        await sequelize.transaction(async (t) => {
          await sequelize.query(`SET LOCAL lock_timeout = '5s'`, { transaction: t });
          // the two indexes invoiceNumbers.dropInvoiceConstraints() drops, here inside this transaction
          await sequelize.query('DROP INDEX IF EXISTS uq_work_orders_invoice_number_live', { transaction: t });
          await sequelize.query('DROP INDEX IF EXISTS uq_invoice_numbers_active_work_order', { transaction: t });
          await integrity.dropRestorableConstraints(sequelize, { transaction: t });
        });
        break;
      } catch (e) {
        const code = sqlStateOf(e);
        if (code === '55P03' || code === '40P01') {   // lock_not_available / deadlock
          if (attempt < LIFT_ATTEMPTS) { console.warn(`[restore] guards locked (try ${attempt}/${LIFT_ATTEMPTS}) — retrying`); await new Promise(r => setTimeout(r, LIFT_RETRY_MS)); continue; }
          invoiceGuardReport = []; integrityRestored = true;   // nothing was lifted: nothing to put back
          const err = new Error('The database is busy (another task is holding the tables) — try again in a quiet moment.');
          err.status = 503;
          throw err;
        }
        // anything else: lift what can be lifted, one by one, as before
        console.warn('[restore] could not lift guards in one step:', e.message);
        try { await invoiceNumbersSvc.dropInvoiceConstraints(sequelize); } catch (e2) { console.warn('[restore] could not lift invoice guards:', e2.message); }
        try { await integrity.dropRestorableConstraints(sequelize); } catch (e2) { console.warn('[restore] could not lift integrity rules:', e2.message); }
        break;
      }
    }

    const { backup, options = {} } = body;   // shape checked before the lock was taken
    const { clearExisting = false } = options || {};
    const allowCoreLoss = options && options.allowCoreLoss === true;
    const results = {};

    // ALL-OR-NOTHING (round 8): every write below happens in ONE transaction. A row that can't be
    // inserted is skipped and reported, but if anything else fails — or the server stops
    // mid-restore — the transaction rolls back and the database is exactly as it was before the
    // restore started. Deletes here bypass the deletion-archive hooks (hooks: false): a restore must
    // not copy the whole database into the archive.
    restoreTx = await sequelize.transaction();
    const tx = restoreTx;
    const sp = (fn) => sequelize.transaction({ transaction: tx }, fn);   // savepoint inside the restore (few: clears, settings)
    const q = (sql, bind, select) => sequelize.query(sql, { bind, transaction: tx, ...(select ? { type: sequelize.QueryTypes.SELECT } : {}) });

    // A section that isn't a list means a damaged file: stop and roll back.
    const list = (key) => {
      const v = backup.data[key];
      if (v === undefined || v === null) return null;
      if (!Array.isArray(v)) throw new Error(`Backup section "${key}" is not a list — the file is damaged`);
      return v;
    };
    // Clear tables before re-inserting (clearExisting). A table other records still point at with a
    // "no action" rule (users ← activity log, clients ← scanned emails, employees ← payroll) can't be
    // emptied: as before, its rows are kept and the backup's rows are written over them — reported in
    // results.notCleared. Any other failure stops the restore and rolls everything back.
    const notCleared = [];
    // Child rows (parts, files, documents, photos, payroll entries): failures counted per table (R27).
    const failed = {};
    const failedSamples = [];
    const clearTables = async (label, ...models) => {
      try {
        await sp(async (t) => { for (const m of models) await m.destroy({ where: {}, force: true, transaction: t, hooks: false }); });
      } catch (e) {
        if (sqlStateOf(e) !== '23503') throw e;
        notCleared.push(`${label}: ${(e.parent?.detail || e.message).slice(0, 160)}`);
        console.warn(`[restore] ${label} not cleared (still referenced) — backup rows written over existing ones`);
      }
    };

    // FK columns that reference other tables — null these on first pass, set in second pass.
    // U25: PO / DR numbers point at estimates too, which are restored after them.
    const FK_COLS = {
      dr_numbers: ['workOrderId', 'estimateId'],
      po_numbers: ['workOrderId', 'inboundOrderId', 'estimateId'],
      inbound_orders: ['workOrderId'],
      shipments: ['workOrderId'],
      work_orders: ['estimateId', 'clientId'],
      estimates: ['workOrderId']
    };
    const FK_TARGET = { workOrderId: 'work_orders', inboundOrderId: 'inbound_orders', estimateId: 'estimates', clientId: 'clients' };
    // Deferred FK updates: table -> col -> Map(id -> value) (last value for an id wins)
    const deferredUpdates = {};

    // Columns the database really has (a model attribute missing from the table would fail every row)
    const colCache = new Map();
    const dbColumns = async (tableName) => {
      if (!colCache.has(tableName)) {
        const rows = await q(`SELECT attname AS c, format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [`"${tableName}"`], true);
        colCache.set(tableName, new Map(rows.map(r => [r.c, r.t])));
      }
      return colCache.get(tableName);
    };

    // Strip columns that don't exist and fix JSONB / ARRAY values
    const cleanRecord = (model, record, cols) => {
      const cleaned = {};
      for (const [k, v] of Object.entries(record)) {
        const colDef = model.rawAttributes[k];
        if (!colDef || !cols.has(k)) continue;
        const key = colDef.type && colDef.type.key;
        if (key === 'JSONB' || key === 'JSON') {
          if (v === null || v === undefined || v === '') cleaned[k] = null;
          else if (typeof v === 'string') { try { cleaned[k] = JSON.parse(v); } catch { cleaned[k] = null; } }
          else cleaned[k] = v;
        } else if (key === 'ARRAY') {
          if (v === null || v === undefined) cleaned[k] = null;
          else if (Array.isArray(v)) cleaned[k] = v;
          else if (typeof v === 'string') { try { const a = JSON.parse(v); cleaned[k] = Array.isArray(a) ? a : null; } catch { cleaned[k] = null; } }
          else cleaned[k] = null;
        } else {
          cleaned[k] = v === undefined ? null : v;
        }
      }
      return cleaned;
    };

    // One statement in its own savepoint. keep=false is a probe: always rolled back, so it keeps no
    // lock. A row error is returned; any other error is fatal (U1).
    let keptSavepoints = 0;
    // Each kept savepoint holds one lock until commit. The budget follows the server's lock table
    // (max_locks_per_transaction × max_connections), using at most 40% of it, so a clean backup of any
    // realistic size fits (review of round 15: a fixed 3,000 refused ~1.5M clean rows)
    let savepointBudget = SAVEPOINT_BUDGET;
    try {
      const [[l]] = await sequelize.query(`SELECT current_setting('max_locks_per_transaction')::int AS l, current_setting('max_connections')::int AS c`, { transaction: tx });
      savepointBudget = Math.max(SAVEPOINT_BUDGET, Math.floor(l.l * l.c * 0.4));
    } catch (_) { /* keep the default */ }
    const attempt = async ([sql, bind], keep) => {
      await q('SAVEPOINT restore_chunk');
      let res;
      try { res = await q(sql, bind, true); } catch (e) {
        await q('ROLLBACK TO SAVEPOINT restore_chunk');
        await q('RELEASE SAVEPOINT restore_chunk');
        if (!isRowError(e)) throw fatalError(e);
        return { err: e };
      }
      if (keep) {
        await q('RELEASE SAVEPOINT restore_chunk');
        if (++keptSavepoints > savepointBudget) throw fatalError(new Error(`The restore needs more database locks than this server allows (${savepointBudget} statements) — too many bad rows, or a very large backup. Nothing was changed.`));
      } else {
        await q('ROLLBACK TO SAVEPOINT restore_chunk');
        await q('RELEASE SAVEPOINT restore_chunk');
      }
      return { res };
    };
    // Run a chunk; if it fails because of some rows, find them by halving (probes are rolled back),
    // run the rest in one go, and only if THAT still fails (rows that clash only with each other) go
    // one row at a time.
    const runChunk = async (items, build) => {
      const bad = [];
      let n = 0;
      const count = (r) => { const x = r && r[0] && r[0].n; if (x) n += Number(x); };
      const first = await attempt(build(items), true);
      if (!first.err) { count(first.res); return { ok: items, bad, n }; }
      const findBad = async (part, err) => {
        if (part.length === 1) { bad.push({ item: part[0], err }); return; }
        const mid = Math.ceil(part.length / 2);
        for (const half of [part.slice(0, mid), part.slice(mid)]) {
          const r = await attempt(build(half), false);
          if (r.err) await findBad(half, r.err);
        }
      };
      await findBad(items, first.err);
      const badSet = new Set(bad.map(b => b.item));
      let ok = items.filter(i => !badSet.has(i));
      if (ok.length) {
        const r = await attempt(build(ok), true);
        if (r.err) {
          const one = [];
          for (const i of ok) {
            const r1 = await attempt(build([i]), true);
            if (r1.err) bad.push({ item: i, err: r1.err }); else { one.push(i); count(r1.res); }
          }
          ok = one;
        } else count(r.res);
      }
      return { ok, bad, n };
    };

    const coreExpected = {};   // label -> ids the backup holds (core tables)
    // Insert (or upsert) many rows of one table. FK columns in FK_COLS are nulled and set in the
    // second pass. Returns the set of ids that did NOT make it in. Failures are reported in
    // results[label] (top-level tables) or failed[label] + failedSamples (child tables, parentCol).
    const restoreRows = async (model, rows, { label, keepExisting = false, parentCol = null }) => {
      const tableName = model.getTableName();
      const cols = await dbColumns(tableName);
      const fkCols = (FK_COLS[tableName] || []).filter(c => cols.has(c));
      const failedIds = new Set();
      const report = (rec, err) => {
        const id = rec && rec.id;
        if (id !== undefined && id !== null) failedIds.add(id);
        const pe = err && (err.parent || err.original);   // Sequelize says only "Validation error" for a unique clash
        const msg = String((pe && (pe.detail ? `${pe.message} — ${pe.detail}` : pe.message)) || (err && err.message) || err).slice(0, 200);
        if (parentCol) {
          failed[label] = (failed[label] || 0) + 1;
          if (failedSamples.length < 25) failedSamples.push({ table: label, parent: rec && rec[parentCol] ? String(rec[parentCol]).slice(0, 8) : null, id: id ? String(id).slice(0, 8) : null, error: msg });
        } else {
          results[label].skipped++;
          if (results[label].errors.length < 10) results[label].errors.push(`${(id && String(id).substring(0, 8)) || '?'}: ${msg.substring(0, 150)}`);
        }
      };
      if (!parentCol) results[label] = results[label] || { restored: 0, skipped: 0, errors: [] };
      const core = CORE_TABLES.find(c => c[0] === label);
      if (core) { coreExpected[label] = coreExpected[label] || new Set(); }

      // Prepare: clean, defer FKs, one entry per id (later duplicates replace earlier ones; with
      // keepExisting the first one stays), grouped by column set so missing columns keep their default.
      const byKey = new Map();
      let anon = 0, attempted = 0, failedCount = 0;
      for (const rec of rows) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { report(null, new Error('not a record')); continue; }
        attempted++;
        const clean = cleanRecord(model, rec, cols);
        if (!Object.keys(clean).length) { report(rec, new Error('no known columns')); failedCount++; continue; }
        const deferred = {};
        for (const fk of fkCols) {
          if (clean[fk] !== null && clean[fk] !== undefined) { deferred[fk] = clean[fk]; clean[fk] = null; }
        }
        if (core && clean.id) coreExpected[label].add(String(clean.id));
        const key = (clean.id !== undefined && clean.id !== null) ? `id:${clean.id}` : `anon:${anon++}`;
        if (keepExisting && byKey.has(key)) continue;
        byKey.set(key, { rec, clean, deferred });
      }
      const groups = new Map();
      for (const p of byKey.values()) {
        const sig = Object.keys(p.clean).join('\u0001');
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(p);
      }
      setProgress({ table: label, tableDone: 0, tableTotal: rows.length });
      for (const [sig, items] of groups) {
        const colsList = sig.split('\u0001');
        const colNames = colsList.map(c => `"${c}"`).join(', ');
        const updates = colsList.filter(c => c !== 'id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
        const conflict = colsList.includes('id') ? ` ON CONFLICT ("id") ${keepExisting || !updates ? 'DO NOTHING' : `DO UPDATE SET ${updates}`}` : '';
        const build = (chunk) => [
          `INSERT INTO "${tableName}" (${colNames}) SELECT ${colNames} FROM jsonb_populate_recordset(NULL::"${tableName}", $1::jsonb) AS r${conflict}`,
          [JSON.stringify(chunk.map(p => p.clean))],
        ];
        for (let i = 0; i < items.length; i += RESTORE_CHUNK) {
          const chunk = items.slice(i, i + RESTORE_CHUNK);
          const { ok, bad } = await runChunk(chunk, build);
          for (const b of bad) { report(b.item.rec, b.err); failedCount++; }
          for (const p of ok) {
            if (p.clean.id === undefined || p.clean.id === null) continue;
            for (const [fk, value] of Object.entries(p.deferred)) {
              if (!deferredUpdates[tableName]) deferredUpdates[tableName] = {};
              if (!deferredUpdates[tableName][fk]) deferredUpdates[tableName][fk] = new Map();
              deferredUpdates[tableName][fk].set(p.clean.id, value);
            }
          }
          job.progress.tableDone += chunk.length;
          job.progress.rowsDone += chunk.length;
        }
      }
      if (!parentCol) results[label].restored += attempted - failedCount;
      return failedIds;
    };

    // Child rows of the given parents (e.g. parts of work orders). Children of a parent that could
    // not be restored are counted as failed without trying (their parent is missing).
    const restoreChildren = async (model, label, parents, key, parentCol, failedParents) => {
      const rows = [];
      let orphaned = 0;
      if (CORE_TABLES.some(t => t[0] === label)) coreExpected[label] = coreExpected[label] || new Set();
      for (const p of parents) {
        if (!p || typeof p !== 'object') continue;
        const kids = p[key];
        if (kids === undefined || kids === null) continue;
        if (!Array.isArray(kids)) throw new Error(`Backup ${label} of ${String(p.id).slice(0, 8)} is not a list — the file is damaged`);
        for (const c of kids) {
          if (failedParents.has(p.id)) {
            orphaned++;
            if (coreExpected[label] && c && c.id) coreExpected[label].add(String(c.id));
            failed[label] = (failed[label] || 0) + 1;
            if (failedSamples.length < 25) failedSamples.push({ table: label, parent: String(p.id).slice(0, 8), id: c && c.id ? String(c.id).slice(0, 8) : null, error: 'its parent row could not be restored' });
            job.progress.rowsDone += 1 + CHILD_KEYS.reduce((m, k) => m + countRows(c && c[k]), 0);
            continue;
          }
          rows.push(c && typeof c === 'object' ? { ...c, [parentCol]: p.id } : c);
        }
      }
      const bad = await restoreRows(model, rows, { label, parentCol });
      if (orphaned) console.log(`[restore] ${label}: ${orphaned} row(s) not tried — parent missing`);
      return { rows, bad };
    };

    // Tables the file holds only partly (newest rows) are never cleared — older rows weren't exported (M8).
    // Older backup files don't say which, so the known partial ones are listed here too.
    // The deletion archive and device registrations are also never cleared: the archive may hold
    // snapshots of records deleted after this backup was taken, and clearing device tokens would cut
    // push notifications to devices registered since.
    const partial = new Set([...(Array.isArray(backup.partialTables) ? backup.partialTables : []), 'emailLogs', 'scannedEmails', 'shopSupplyLogs', 'activityLogs', 'dailyActivity', 'deletionArchive', 'deviceTokens']);
    const logTable = (label) => {
      const r = results[label];
      if (!r) return;
      console.log(`[restore] ${label}: ${r.restored} restored, ${r.skipped} skipped`);
      if (r.errors && r.errors.length > 0) console.log(`[restore] ${label} errors:`, r.errors);
    };
    // W10: work orders left out of a merge restore (number re-used live) — rows pointing at them are left out too
    const skippedWoIds = new Set();
    const restoreSimple = async (model, key, label = key) => {
      let data = list(key);
      if (!data) return;
      // W22: an empty section still clears its table (never users or API keys: that would lock everyone
      // out / cut off every tablet — review of round 17)
      if (clearExisting && !partial.has(label) && (data.length || !NEVER_EMPTY_CLEAR.has(label))) await clearTables(label, model);
      if (!data.length) return;
      if (skippedWoIds.size) {
        const n0 = data.length;
        data = data.filter(r => !(r && typeof r === 'object' && r.workOrderId && skippedWoIds.has(String(r.workOrderId))));
        if (data.length < n0) {
          results[label] = results[label] || { restored: 0, skipped: 0, errors: [] };
          results[label].alreadyPresent = (results[label].alreadyPresent || 0) + (n0 - data.length);
          job.progress.rowsDone += n0 - data.length;
        }
        if (!data.length) { logTable(label); return; }
      }
      // Deleted Items entries already here keep their state (e.g. "restored" since the backup was taken)
      await restoreRows(model, data, { label, keepExisting: label === 'deletionArchive' });
      logTable(label);
    };

    let woList = list('workOrders');
    if (woList && !clearExisting && woList.length) {
      // W10: merge restore — an order whose invoice / DR number is now live on a DIFFERENT order (the
      // number was re-used after it was deleted or renumbered) is left out, with its parts, documents and
      // the payments / links pointing at it, and reported as already present — instead of a live
      // duplicate invoice number or a refused restore (DR numbers are unique).
      const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
      const voided = (o) => o.isVoided === true || o.isVoided === 'true';
      const backupIds = new Set(woList.filter(isObj).map(o => String(o.id)));
      const invs = [...new Set(woList.filter(o => isObj(o) && !voided(o) && o.invoiceNumber !== null && o.invoiceNumber !== undefined && String(o.invoiceNumber).trim() !== '').map(o => String(o.invoiceNumber)))];
      const drs = [...new Set(woList.filter(o => isObj(o) && /^\d{1,9}$/.test(String(o.drNumber ?? ''))).map(o => Number(o.drNumber)))];
      if (invs.length || drs.length) {
        const live = await q(`SELECT id::text AS id, "orderNumber", "drNumber", "invoiceNumber", COALESCE("isVoided", false) AS voided
          FROM work_orders WHERE ("invoiceNumber"::text = ANY($1::text[]) AND COALESCE("isVoided", false) = false) OR "drNumber" = ANY($2::int[])`, [invs, drs], true);
        // a live holder the backup itself overwrites ends up with the backup's numbers — no clash with it
        const holders = live.filter(w => !backupIds.has(w.id));
        const byInv = new Map(), byDr = new Map();
        for (const w of holders) {
          if (!w.voided && w.invoiceNumber) byInv.set(String(w.invoiceNumber), w);
          if (w.drNumber !== null) byDr.set(Number(w.drNumber), w);
        }
        const skipped = [];
        woList = woList.filter(o => {
          if (!isObj(o)) return true;
          const hi = !voided(o) && o.invoiceNumber ? byInv.get(String(o.invoiceNumber)) : null;
          const hd = /^\d{1,9}$/.test(String(o.drNumber ?? '')) ? byDr.get(Number(o.drNumber)) : null;
          const h = hd || hi;
          if (!h || h.id === String(o.id)) return true;
          skipped.push(`${o.drNumber ? 'DR-' + o.drNumber : (o.orderNumber || String(o.id).slice(0, 8))}: ${[hd && `DR-${o.drNumber}`, hi && `invoice ${o.invoiceNumber}`].filter(Boolean).join(' and ')} now on ${h.drNumber ? 'DR-' + h.drNumber : h.orderNumber}`);
          skippedWoIds.add(String(o.id));
          job.progress.rowsDone += countRows([o]);
          return false;
        });
        if (skipped.length) {
          results.workOrders = { restored: 0, skipped: 0, errors: [], alreadyPresent: skipped.length, alreadyPresentSamples: skipped.slice(0, 20) };
          console.log(`[restore] workOrders: ${skipped.length} left out — number already live on another order`);
        }
      }
    }
    setProgress({ phase: 'restoring' });
    // Users & API keys first
    const { User, ApiKey } = require('../models');
    // Restoring into a new database: the first-boot admin (random password) gives way to the backup's
    // own users, so the real admin and password come back (audit R4)
    const backupUsers = list('users');
    if (backupUsers && backupUsers.length) {
      try {
        await sp(async (t) => {
          const [[row]] = await sequelize.query(`SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id'`, { transaction: t });
          const bootId = row && (typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : null);
          // only on a fresh install: the first-boot admin is the ONLY user (never on a database in use)
          const [[{ n: userCount }]] = await sequelize.query(`SELECT COUNT(*)::int AS n FROM users`, { transaction: t });
          if (bootId && userCount === 1 && !backupUsers.some(u => u && u.id === bootId)) {
            await sequelize.query(`DELETE FROM activity_logs WHERE "userId" = :id`, { replacements: { id: bootId }, transaction: t });
            await sequelize.query(`DELETE FROM users WHERE id = :id`, { replacements: { id: bootId }, transaction: t });
            await sequelize.query(`DELETE FROM app_settings WHERE key = 'bootstrap_admin_id'`, { transaction: t });
            job.usersReplaced = true;   // V28: the signed-in admin is gone after the commit
            console.log('[restore] replaced the first-boot admin with the backup\'s users');
          }
        });
      } catch (e) {
        if (!isRowError(e)) throw fatalError(e);
        console.warn('[restore] could not remove the first-boot admin:', e.message);
      }
    }
    await restoreSimple(User, 'users');
    await restoreSimple(ApiKey, 'apiKeys');

    // Clients & Vendors first (referenced by other tables)
    await restoreSimple(Client, 'clients');
    await restoreSimple(Vendor, 'vendors');
    await restoreSimple(DRNumber, 'drNumbers');
    await restoreSimple(PONumber, 'poNumbers');
    await restoreSimple(InboundOrder, 'inboundOrders');

    // Shipments with children
    const ships = list('shipments');
    if (ships) {
      if (clearExisting) await clearTables('shipments', ShipmentDocument, ShipmentPhoto, Shipment);
      const bad = await restoreRows(Shipment, ships.map(s => { if (!s || typeof s !== 'object') return s; const { photos, documents, ...x } = s; return x; }), { label: 'shipments' });
      await restoreChildren(ShipmentPhoto, 'shipmentPhotos', ships, 'photos', 'shipmentId', bad);
      await restoreChildren(ShipmentDocument, 'shipmentDocuments', ships, 'documents', 'shipmentId', bad);
      logTable('shipments');
    }

    // Work Orders with parts, files, documents
    const wos = woList;
    if (wos) {
      if (clearExisting) {
        // Payments point at work orders and no longer cascade-delete with them (audit H8), so they
        // are cleared first (the backup's own payments are restored further down).
        const { WorkOrderPayment: WOP, PaymentApplication: PA } = require('../models');
        await clearTables('workOrders', PA, WOP, WorkOrderPartFile, WorkOrderPart, WorkOrderDocument, WorkOrder);
      }
      const bad = await restoreRows(WorkOrder, wos.map(o => { if (!o || typeof o !== 'object') return o; const { parts, documents, ...x } = o; return x; }), { label: 'workOrders' });
      const parts = await restoreChildren(WorkOrderPart, 'workOrderParts', wos, 'parts', 'workOrderId', bad);
      await restoreChildren(WorkOrderPartFile, 'workOrderPartFiles', parts.rows, 'files', 'workOrderPartId', parts.bad);
      await restoreChildren(WorkOrderDocument, 'workOrderDocuments', wos, 'documents', 'workOrderId', bad);
      logTable('workOrders');
    }

    // Estimates with parts, part files, estimate files
    const ests = list('estimates');
    if (ests) {
      if (clearExisting) await clearTables('estimates', EstimatePartFile, EstimatePart, EstimateFile, Estimate);
      const bad = await restoreRows(Estimate, ests.map(o => { if (!o || typeof o !== 'object') return o; const { parts, files, ...x } = o; return x; }), { label: 'estimates' });
      const parts = await restoreChildren(EstimatePart, 'estimateParts', ests, 'parts', 'estimateId', bad);
      await restoreChildren(EstimatePartFile, 'estimatePartFiles', parts.rows, 'files', 'partId', parts.bad);
      await restoreChildren(EstimateFile, 'estimateFiles', ests, 'files', 'estimateId', bad);
      logTable('estimates');
    }

    // Settings (a handful of rows)
    const settings = list('settings');
    if (settings) {
      results.settings = { restored: 0, skipped: 0 };
      setProgress({ table: 'settings', tableDone: 0, tableTotal: settings.length });
      for (const sd of settings) {
        try {
          if (!sd || typeof sd !== 'object' || !sd.key) throw Object.assign(new Error('not a setting'), { code: '22000' });
          await sp(async (t) => {
            const [s, created] = await AppSettings.findOrCreate({ where: { key: sd.key }, defaults: sd, transaction: t });
            if (!created && clearExisting) await s.update({ value: sd.value }, { transaction: t });
          });
          results.settings.restored++;
        } catch (e) {
          if (!isRowError(e)) throw fatalError(e);
          results.settings.skipped++;
        }
        job.progress.tableDone++; job.progress.rowsDone++;
      }
    }

    // Business data
    await restoreSimple(Liability, 'liabilities');
    // V29: payroll rows point at employees ("no action"), so they are cleared first or employees never are
    if (clearExisting && list('payrollWeeks')) await clearTables('payrollWeeks', PayrollEntry, PayrollWeek);
    await restoreSimple(Employee, 'employees');
    await restoreSimple(require('../models').BusinessEvent, 'businessEvents');
    const weeks = list('payrollWeeks');
    if (weeks) {
      const bad = await restoreRows(PayrollWeek, weeks.map(w => { if (!w || typeof w !== 'object') return w; const { entries, ...x } = w; return x; }), { label: 'payrollWeeks' });
      await restoreChildren(PayrollEntry, 'payrollEntries', weeks, 'entries', 'payrollWeekId', bad);
      logTable('payrollWeeks');
    }

    // ---- Financial, quality and message records (v299) ----------------------------------
    // Restored last: every one of these references a work order, client, or estimate that the
    // passes above have already created. Payments come before the applications that point at them.
    {
      const M = require('../models');
      await restoreSimple(M.InspectionTool, 'inspectionTools');
      await restoreSimple(M.InspectionJob, 'inspectionJobs');
      await restoreSimple(M.InspectionUnit, 'inspectionUnits');

      await restoreSimple(M.WorkOrderPayment, 'workOrderPayments');
      await restoreSimple(M.ClientPayment, 'clientPayments');
      await restoreSimple(M.CreditMemo, 'creditMemos');
      await restoreSimple(M.PaymentApplication, 'paymentApplications');
      await restoreSimple(M.CreditMemoApplication, 'creditMemoApplications');
      await restoreSimple(M.Refund, 'refunds');
      await restoreSimple(M.ShipmentCharge, 'shipmentCharges');
      await restoreSimple(M.WorkOrderInvoiceSend, 'workOrderInvoiceSends');

      await restoreSimple(M.OperatorSignature, 'operatorSignatures');
      await restoreSimple(M.OperatorTask, 'operatorTasks');
      await restoreSimple(M.WorkOrderMessage, 'workOrderMessages');

      await restoreSimple(M.InvoiceNumber, 'invoiceNumbers');
      await restoreSimple(M.WeldProcedure, 'weldProcedures');
      await restoreSimple(M.ShopSupply, 'shopSupplies');
      await restoreSimple(M.ShopSupplyLog, 'shopSupplyLogs');
      await restoreSimple(M.VendorIssue, 'vendorIssues');
      await restoreSimple(M.GmailAccount, 'gmailAccounts');
      await restoreSimple(M.ScannedEmail, 'scannedEmails');
      await restoreSimple(M.PendingOrder, 'pendingOrders');
      await restoreSimple(M.TodoItem, 'todos');
      await restoreSimple(M.EmailLog, 'emailLogs');
      await restoreSimple(M.ActivityLog, 'activityLogs');
      await restoreSimple(M.DailyActivity, 'dailyActivity');
      // added in round 7 (absent from older backup files — then simply skipped)
      await restoreSimple(M.DeletionArchive, 'deletionArchive');
      await restoreSimple(M.InboundPaperwork, 'inboundPaperwork');
      await restoreSimple(M.ConvertQueueItem, 'convertQueueItems');
      await restoreSimple(M.DeviceToken, 'deviceTokens');
    }

    // ===== SECOND PASS: Apply deferred FK updates (one statement per 1000 links — U1) =====
    // A link whose target is not in the database is left empty and counted.
    setProgress({ phase: 'linking records', table: null });
    let fkUpdated = 0, fkFailed = 0;
    // Planner statistics still describe the tables as they were before the restore (often empty),
    // which makes the link joins nested loops over whole tables — refresh them first (in the transaction)
    for (const t of new Set([...Object.keys(deferredUpdates), ...Object.values(FK_TARGET)])) await q(`ANALYZE "${t}"`);
    for (const [tableName, byCol] of Object.entries(deferredUpdates)) {
      const cols = await dbColumns(tableName);
      for (const [col, map] of Object.entries(byCol)) {
        const target = FK_TARGET[col];
        const type = cols.get(col);
        const idType = cols.get('id');
        const targetIdType = target ? (await dbColumns(target)).get('id') : null;
        // a value that can't be an id is left empty and counted (no cast error); the rest are matched
        // through the primary keys, so this stays fast on large tables
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const items = [];
        for (const [id, value] of map.entries()) {
          if (type === 'uuid' && !UUID_RE.test(String(value))) { fkFailed++; continue; }
          items.push({ id: String(id), value: String(value) });
        }
        const sameType = targetIdType && targetIdType === type;
        const build = (chunk) => [
          `WITH u AS (UPDATE "${tableName}" t SET "${col}" = v.value
                      FROM (SELECT x.id::${idType} AS id, x.value::${type} AS value FROM jsonb_to_recordset($1::jsonb) AS x(id text, value text)) v
                      WHERE t.id = v.id ${target ? `AND EXISTS (SELECT 1 FROM "${target}" p WHERE ${sameType ? 'p.id = v.value' : 'p.id::text = v.value::text'})` : ''} RETURNING 1)
           SELECT COUNT(*)::int AS n FROM u`,
          [JSON.stringify(chunk)],
        ];
        const t0 = Date.now(); let linked = 0;
        for (let i = 0; i < items.length; i += 1000) {
          const chunk = items.slice(i, i + 1000);
          const r = await runChunk(chunk, build);
          linked += r.n;
          fkFailed += chunk.length - r.n;
        }
        fkUpdated += linked;
        console.log(`[restore] linked ${tableName}.${col}: ${linked}/${map.size} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
    console.log(`[restore] FK second pass: ${fkUpdated} updated, ${fkFailed} failed (target missing)`);
    results.fkUpdates = { updated: fkUpdated, failed: fkFailed };
    if (notCleared.length) results.notCleared = notCleared;

    // U1: never commit a database that lost a real number of core rows
    setProgress({ phase: 'checking' });
    const coreLosses = [];
    for (const [label, table, what] of CORE_TABLES) {
      const ids = coreExpected[label];
      if (!ids || !ids.size) continue;
      const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE id::text = ANY($1::text[])`, [[...ids]], true);
      const lost = ids.size - n;
      if (lost > 0) coreLosses.push({ label, what, lost, of: ids.size });
    }
    results.coreLosses = coreLosses;
    // The original six always count. The registers and payment-link tables (V13) count when clearing:
    // in a merge restore a row whose number is already taken under another id is expected to be skipped
    // (a DR released and reused), so it is only a warning there (review of round 16)
    const ORIGINAL_CORE = ['clients', 'workOrders', 'workOrderParts', 'estimates', 'workOrderPayments', 'clientPayments'];
    const tooMany = coreLosses.filter(c => c.lost > coreLossLimit(c.of) && (clearExisting || ORIGINAL_CORE.includes(c.label)));
    if (tooMany.length && !allowCoreLoss) {
      const err = new Error(`${tooMany.map(c => `${c.lost} of ${c.of} ${c.what}`).join(', ')} could not be restored — refusing to commit a partial database. First failures: ${
        [...Object.entries(results).flatMap(([l, r]) => (r && r.errors ? r.errors.map(e => `${l} ${e}`) : [])), ...failedSamples.map(s => `${s.table}: ${s.error}`)].slice(0, 3).join(' | ')}`);
      err.fatal = true;
      throw err;
    }

    // Everything is in — make it permanent in one step. (Re-uploading missing files and the checks
    // below happen after this, on the committed data.)
    setProgress({ phase: 'committing' });
    await tx.commit();
    restoreTx = null;
    console.log('[restore] committed');
    setProgress({ phase: 'after commit' });

    // After restore: re-upload any files from backup that are missing on Cloudinary
    let fileResults = { checked: 0, reuploaded: 0, alreadyExist: 0, failed: 0 };
    // The data is committed: nothing below may turn this into a "failed" answer
    try {
      if (backup.files && Object.keys(backup.files).length > 0) {
        const https = require('https');
        const http = require('http');

        const checkUrl = (url) => new Promise((resolve) => {
          const client = url.startsWith('https') ? https : http;
          const req = client.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
            resolve(res.statusCode >= 200 && res.statusCode < 400);
          });
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
          req.end();
        });

        const allFileRecords = [];
        const woPartFiles = await WorkOrderPartFile.findAll();
        woPartFiles.forEach(f => allFileRecords.push({ model: WorkOrderPartFile, record: f }));
        const woDocs = await WorkOrderDocument.findAll();
        woDocs.forEach(f => allFileRecords.push({ model: WorkOrderDocument, record: f }));
        const estPartFiles = await EstimatePartFile.findAll();
        estPartFiles.forEach(f => allFileRecords.push({ model: EstimatePartFile, record: f }));
        const estFiles = await EstimateFile.findAll();
        estFiles.forEach(f => allFileRecords.push({ model: EstimateFile, record: f }));
        const shipDocs = await ShipmentDocument.findAll();
        shipDocs.forEach(f => allFileRecords.push({ model: ShipmentDocument, record: f }));

        for (const { model, record } of allFileRecords) {
          const url = record.url;
          const backupFile = backup.files[url];
          if (!backupFile || !backupFile.data) continue;

          fileResults.checked++;
          try {
            // S3 files aren't removed by a database restore, and a private bucket refuses a plain HEAD
            const exists = require('../utils/storage').s3IdFor(record.cloudinaryId, url) ? true : await checkUrl(url);
            if (exists) {
              fileResults.alreadyExist++;
              continue;
            }

            const buffer = Buffer.from(backupFile.data, 'base64');
            const base64Data = buffer.toString('base64');
            const mimeType = record.mimeType || 'application/octet-stream';
            const folder = record.cloudinaryId ? record.cloudinaryId.split('/').slice(0, -1).join('/') : 'restored-files';

            const uploadResult = await cloudinary.uploader.upload(
              `data:${mimeType};base64,${base64Data}`,
              { resource_type: 'raw', folder, use_filename: true, unique_filename: true }
            );

            await record.update({ url: uploadResult.secure_url, cloudinaryId: uploadResult.public_id });
            fileResults.reuploaded++;
            console.log(`[restore] Re-uploaded: ${backupFile.name}`);
          } catch (e) {
            console.warn(`[restore] Failed to re-upload ${backupFile.name}: ${e.message}`);
            fileResults.failed++;
          }
        }
      }
    } catch (e) { console.warn('[restore] file re-upload step failed (data is restored):', e.message); fileResults.error = e.message; }

    // An older backup may hold client payments recorded before payment linking existed —
    // link them now so they are not double counted (same as the boot step).
    try {
      const { linkLegacyTwinPayments } = require('../services/paymentLedger');
      const linkRes = await linkLegacyTwinPayments(sequelize);
      if (linkRes.linked) console.log(`[restore] linked ${linkRes.linked} client-payment application(s)`);
    } catch (e) { console.warn('[restore] payment link step failed:', e.message); }

    setProgress({ phase: 're-adding guards' });
    try {
      invoiceGuardReport = await invoiceNumbersSvc.ensureInvoiceConstraints(sequelize);
      for (const p of invoiceGuardReport) console.warn(`[restore] invoice guard ${p.name} not re-added — duplicates to fix:`, JSON.stringify(p.duplicates));
    } catch (e) { console.warn('[restore] could not re-add invoice guards:', e.message); }

    // T30: what came back and what didn't is part of the answer, not only the server log
    const warnings = [];
    let integrityReport = null;
    try { integrityReport = await integrity.ensureIntegrityConstraints(sequelize); integrity.logReport(integrityReport); integrityRestored = true; }
    catch (e) { console.warn('[restore] could not re-add integrity rules:', e.message); warnings.push(`Integrity rules could not be re-added (${e.message}); they are retried at the next server start.`); }
    // after the commit: a problem describing the result must not turn it into "rolled back" (review of round 15)
    if (integrityReport) { try { warnings.push(...integrity.reportWarnings(integrityReport)); } catch (e) { warnings.push(`Integrity report could not be summarised (${e.message}).`); } }
    for (const p of invoiceGuardReport || []) {
      warnings.push(`Invoice-number guard ${p.name} was NOT re-added: ${p.duplicates.length} duplicate invoice number(s) must be fixed first.`);
    }
    if (invoiceGuardReport === null) warnings.push('Invoice-number guards could not be checked after the restore (see server log); they are retried at the next server start.');
    for (const [table, n] of Object.entries(failed)) warnings.push(`${n} ${table} row(s) from the backup could not be restored (see failedSamples).`);
    for (const [label, r] of Object.entries(results)) {
      if (r && r.skipped) warnings.push(`${label}: ${r.skipped} row(s) skipped (see results.${label}.errors).`);
    }
    for (const [label, r] of Object.entries(results)) {
      if (r && r.alreadyPresent) warnings.push(`${label}: ${r.alreadyPresent} row(s) left out — ${label === 'workOrders' ? 'their invoice or DR number is already in use on another order' : 'they belong to a work order left out because its number is in use'} (see results.${label}${label === 'workOrders' ? '.alreadyPresentSamples' : ''}).`);
    }
    // W23: say why a loss over the limit was committed — only "allowCoreLoss" when that option did it
    for (const c of coreLosses) {
      const why = !tooMany.includes(c) ? (c.lost > coreLossLimit(c.of) ? ' (not blocking in a merge restore: usually a number already taken under another id)' : '')
        : ' (committed because allowCoreLoss was set)';
      warnings.push(`${c.lost} of ${c.of} ${c.what} from the backup are not in the database${why}.`);
    }
    if (results.fkUpdates && results.fkUpdates.failed) warnings.push(`${results.fkUpdates.failed} link(s) between restored records pointed at a record that is not in the backup and were left empty.`);
    if (notCleared.length) warnings.push(`${notCleared.length} table(s) could not be cleared first; the backup's rows were written over the existing ones (see results.notCleared).`);
    if (fileResults.failed) warnings.push(`${fileResults.failed} file(s) could not be re-uploaded.`);
    if (fileResults.error) warnings.push(`File re-upload step failed: ${fileResults.error}`);
    for (const w of warnings) console.warn(`[restore] ${w}`);

    job.result = { message: warnings.length ? `Backup restored with ${warnings.length} warning(s)` : 'Backup restored successfully', results, fileResults,
      invoiceNumberDuplicates: (invoiceGuardReport || []).flatMap(p => p.duplicates),
      failed, failedSamples,
      integrity: integrityReport ? {
        renumbered: integrityReport.renumbered || [],
        guardsMissing: integrityReport.guardsMissing || [],
        orphans: integrityReport.foreignKeys?.orphans || [],
        errors: integrityReport.errors || [],
      } : null,
      warnings };
    job.status = 'done';
  } catch (error) {
    let message = error.message;
    if (restoreTx) {
      try { await restoreTx.rollback(); console.warn('[restore] rolled back — the database is unchanged'); } catch (_) {}
      restoreTx = null;
    }
    job.usersReplaced = false;   // rolled back with everything else
    // Before the restore transaction opened nothing was written either
    message = `Restore failed and was rolled back — nothing was changed. (${message})`;
    console.error('[restore] Error:', message);
    // Put the guards back BEFORE answering, so the database is fully as it was when the error shows
    setProgress({ phase: 're-adding guards' });
    if (!invoiceGuardReport) { try { await invoiceNumbersSvc.ensureInvoiceConstraints(sequelize); invoiceGuardReport = []; } catch (e) { /* logged at next boot */ } }
    if (!integrityRestored) { try { await integrity.ensureIntegrityConstraints(sequelize); integrityRestored = true; } catch (e) { /* re-added at next boot */ } }
    job.status = 'failed';
    job.error = message;
    job.httpStatus = (error.status === 400 || error.status === 503) ? error.status : 500;
  } finally {
    invoiceTotals.resumeTotalsHooks();
    invoiceLock.resumeInvoiceLock();
    resumeUndo();
    if (restoreTx && !restoreTx.finished) { try { await restoreTx.rollback(); } catch (_) { /* already ended */ } }
    if (!invoiceGuardReport) { try { await invoiceNumbersSvc.ensureInvoiceConstraints(sequelize); } catch (e) { /* logged at next boot */ } }
    if (!integrityRestored) { try { await integrity.ensureIntegrityConstraints(sequelize); } catch (e) { /* re-added at next boot */ } }
    // the advisory lock is released last, with the in-process flag (U6)
    if (lockTx && !lockTx.finished) { try { await lockTx.rollback(); } catch (_) { /* connection gone — lock went with it */ } }
    restoreRunning = false;
    job.finishedAt = new Date().toISOString();
    job.progress.phase = job.status;
    console.log(`[restore] job ${job.id} ${job.status} in ${((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(1)}s`);
  }
}

module.exports = router;
module.exports.runAutoBackup = runAutoBackup;
module.exports.publicStatus = publicStatus;   // V28: app.get('/api/backup-status/:jobId', backupRoutes.publicStatus) — no authenticate
module.exports.missingSectionLosses = missingSectionLosses;
module.exports.isRestoreRunning = isRestoreRunning;
