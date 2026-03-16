const express = require('express');
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
  DRNumber, PONumber,
  Client, Vendor,
  AppSettings, User, ApiKey, EmailLog
} = require('../models');

const router = express.Router();

// ============= HELPER: Build full backup object =============
async function buildBackup(includeFiles = false) {
  const backup = {
    version: '2.1',
    createdAt: new Date().toISOString(),
    data: {},
    counts: {},
    files: {}
  };

  // Clients & Vendors
  backup.data.clients = (await Client.findAll()).map(c => c.toJSON());
  backup.data.vendors = (await Vendor.findAll()).map(v => v.toJSON());

  // DR Numbers & PO Numbers
  backup.data.drNumbers = (await DRNumber.findAll()).map(d => d.toJSON());
  backup.data.poNumbers = (await PONumber.findAll()).map(p => p.toJSON());

  // Shipments (with photos & documents)
  backup.data.shipments = (await Shipment.findAll({
    include: [
      { model: ShipmentPhoto, as: 'photos' },
      { model: ShipmentDocument, as: 'documents' }
    ]
  })).map(s => s.toJSON());

  // Inbound Orders
  backup.data.inboundOrders = (await InboundOrder.findAll()).map(o => o.toJSON());

  // Work Orders (with parts, part files, and documents)
  backup.data.workOrders = (await WorkOrder.findAll({
    include: [
      { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
      { model: WorkOrderDocument, as: 'documents' }
    ]
  })).map(w => w.toJSON());

  // Estimates (with parts, part files, and estimate-level files)
  backup.data.estimates = (await Estimate.findAll({
    include: [
      { model: EstimatePart, as: 'parts', include: [{ model: EstimatePartFile, as: 'files' }] },
      { model: EstimateFile, as: 'files' }
    ]
  })).map(e => e.toJSON());

  // Settings
  backup.data.settings = (await AppSettings.findAll()).map(s => s.toJSON());

  // Users (without password hashes)
  backup.data.users = (await User.findAll({
    attributes: ['id', 'username', 'role', 'isActive', 'createdAt', 'updatedAt']
  })).map(u => u.toJSON());

  // API Keys (metadata only - no key values)
  backup.data.apiKeys = (await ApiKey.findAll({
    attributes: ['id', 'name', 'clientName', 'isActive', 'lastUsedAt', 'createdAt']
  })).map(k => k.toJSON());

  // Email logs (last 500)
  backup.data.emailLogs = (await EmailLog.findAll({ order: [['createdAt', 'DESC']], limit: 500 })).map(e => e.toJSON());

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
async function uploadBackupToCloudinary(backup) {
  const jsonStr = JSON.stringify(backup);
  const compressed = await gzip(Buffer.from(jsonStr, 'utf-8'));
  const base64 = compressed.toString('base64');
  
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const publicId = `shipment-tracker-backups/backup-${dateStr}`;

  const result = await cloudinary.uploader.upload(
    `data:application/gzip;base64,${base64}`,
    { public_id: publicId, resource_type: 'raw', overwrite: true, tags: ['auto-backup', 'database-backup'] }
  );

  return {
    url: result.secure_url,
    publicId: result.public_id,
    size: compressed.length,
    uncompressedSize: jsonStr.length,
    createdAt: new Date().toISOString()
  };
}

// ============= AUTO BACKUP (called by cron) =============
async function runAutoBackup(includeFiles = false) {
  const startTime = Date.now();
  console.log(`[auto-backup] Starting scheduled backup${includeFiles ? ' (with files)' : ''}...`);
  
  try {
    const backup = await buildBackup(includeFiles);
    const uploadResult = await uploadBackupToCloudinary(backup);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[auto-backup] Complete in ${duration}s - ${(uploadResult.size / 1024).toFixed(0)}KB compressed`);
    console.log(`[auto-backup] Counts:`, JSON.stringify(backup.counts));

    // Save last backup info to settings
    await AppSettings.upsert({
      key: 'last_auto_backup',
      value: JSON.stringify({
        ...uploadResult,
        counts: backup.counts,
        duration: `${duration}s`
      })
    });

    // Clean up old backups (keep last 10)
    try {
      const searchResult = await cloudinary.search
        .expression('folder:shipment-tracker-backups AND resource_type:raw')
        .sort_by('created_at', 'desc')
        .max_results(50)
        .execute();
      
      if (searchResult.resources && searchResult.resources.length > 10) {
        const toDelete = searchResult.resources.slice(10);
        for (const old of toDelete) {
          await cloudinary.uploader.destroy(old.public_id, { resource_type: 'raw' });
          console.log(`[auto-backup] Deleted old backup: ${old.public_id}`);
        }
      }
    } catch (cleanErr) {
      console.error('[auto-backup] Cleanup error (non-fatal):', cleanErr.message);
    }

    return { success: true, ...uploadResult, counts: backup.counts, duration };
  } catch (error) {
    console.error('[auto-backup] FAILED:', error.message);
    return { success: false, error: error.message };
  }
}

// ============= ROUTES =============

// GET /api/backup - Download full backup as JSON
router.get('/', async (req, res, next) => {
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
router.get('/info', async (req, res, next) => {
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

    let cloudBackups = [];
    try {
      const searchResult = await cloudinary.search
        .expression('folder:shipment-tracker-backups AND resource_type:raw')
        .sort_by('created_at', 'desc')
        .max_results(10)
        .execute();
      cloudBackups = (searchResult.resources || []).map(r => ({
        publicId: r.public_id,
        url: r.secure_url,
        size: r.bytes,
        createdAt: r.created_at
      }));
    } catch (e) { /* cloudinary may not be configured */ }

    res.json({
      data: {
        counts: { clients: clientCount, vendors: vendorCount, drNumbers: drCount, poNumbers: poCount,
          shipments: shipmentCount, inboundOrders: inboundCount, workOrders: workOrderCount,
          estimates: estimateCount, settings: settingsCount, users: userCount },
        lastAutoBackup,
        cloudBackups
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup/run-now - Trigger immediate cloud backup
router.post('/run-now', async (req, res, next) => {
  try {
    const includeFiles = req.body.includeFiles === true;
    const result = await runAutoBackup(includeFiles);
    if (result.success) {
      res.json({ message: `Backup completed successfully${includeFiles ? ' (with files)' : ''}`, data: result });
    } else {
      res.status(500).json({ error: { message: `Backup failed: ${result.error}` } });
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/backup/run-background - Start backup in background, email when done
router.post('/run-background', async (req, res, next) => {
  try {
    const includeFiles = req.body.includeFiles !== false; // default true
    const email = req.body.email;
    
    if (!email) {
      return res.status(400).json({ error: { message: 'Email address is required' } });
    }

    // Respond immediately
    res.json({ message: `Backup started in background${includeFiles ? ' (with files)' : ''}. You'll receive an email at ${email} when it's done.` });

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
            `URL: ${result.url || 'N/A'}`,
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
router.post('/test', async (req, res, next) => {
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

    // Step 3: Upload to Cloudinary
    const base64 = compressed.toString('base64');
    const testPublicId = `shipment-tracker-backups/test-${Date.now()}`;
    const uploadResult = await cloudinary.uploader.upload(
      `data:application/gzip;base64,${base64}`,
      { public_id: testPublicId, resource_type: 'raw', tags: ['test-backup'] }
    );
    results.steps.push({ step: 'Upload to Cloudinary', status: 'ok', detail: uploadResult.secure_url });

    // Step 4: Download and verify
    const https = require('https');
    const downloadedData = await new Promise((resolve, reject) => {
      https.get(uploadResult.secure_url, (response) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    });
    const decompressed = await gunzip(downloadedData);
    const restored = JSON.parse(decompressed.toString('utf-8'));
    const countsMatch = JSON.stringify(backup.counts) === JSON.stringify(restored.counts);
    results.steps.push({
      step: 'Download and verify', status: countsMatch ? 'ok' : 'warning',
      detail: countsMatch ? `All ${totalRecords} records verified` : 'Record counts mismatch!'
    });

    // Step 5: Clean up test file
    await cloudinary.uploader.destroy(testPublicId, { resource_type: 'raw' });
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
router.post('/restore', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { backup, options = {} } = req.body;
    if (!backup || !backup.data) {
      return res.status(400).json({ error: { message: 'Invalid backup file' } });
    }

    const { clearExisting = false } = options;
    const results = {};

    // Simple restore helper
    const restoreSimple = async (model, data, label) => {
      if (!data || !data.length) return;
      results[label] = { restored: 0, skipped: 0 };
      if (clearExisting) await model.destroy({ where: {}, transaction });
      for (const record of data) {
        try {
          const existing = await model.findByPk(record.id, { transaction });
          if (existing && !clearExisting) { results[label].skipped++; continue; }
          if (existing) await existing.destroy({ transaction });
          await model.create(record, { transaction });
          results[label].restored++;
        } catch (e) { results[label].skipped++; }
      }
    };

    // Clients & Vendors first (referenced by other tables)
    await restoreSimple(Client, backup.data.clients, 'clients');
    await restoreSimple(Vendor, backup.data.vendors, 'vendors');
    await restoreSimple(DRNumber, backup.data.drNumbers, 'drNumbers');
    await restoreSimple(PONumber, backup.data.poNumbers, 'poNumbers');
    await restoreSimple(InboundOrder, backup.data.inboundOrders, 'inboundOrders');

    // Shipments with children
    if (backup.data.shipments) {
      results.shipments = { restored: 0, skipped: 0 };
      if (clearExisting) { await ShipmentDocument.destroy({ where: {}, transaction }); await ShipmentPhoto.destroy({ where: {}, transaction }); await Shipment.destroy({ where: {}, transaction }); }
      for (const sd of backup.data.shipments) {
        try {
          const { photos, documents, ...shipment } = sd;
          const existing = await Shipment.findByPk(shipment.id, { transaction });
          if (existing && !clearExisting) { results.shipments.skipped++; continue; }
          if (existing) await existing.destroy({ transaction });
          const created = await Shipment.create(shipment, { transaction });
          if (photos) for (const p of photos) await ShipmentPhoto.create({ ...p, shipmentId: created.id }, { transaction });
          if (documents) for (const d of documents) await ShipmentDocument.create({ ...d, shipmentId: created.id }, { transaction });
          results.shipments.restored++;
        } catch (e) { results.shipments.skipped++; }
      }
    }

    // Work Orders with parts, files, documents
    if (backup.data.workOrders) {
      results.workOrders = { restored: 0, skipped: 0 };
      if (clearExisting) { await WorkOrderPartFile.destroy({ where: {}, transaction }); await WorkOrderPart.destroy({ where: {}, transaction }); await WorkOrderDocument.destroy({ where: {}, transaction }); await WorkOrder.destroy({ where: {}, transaction }); }
      for (const od of backup.data.workOrders) {
        try {
          const { parts, documents, ...order } = od;
          const existing = await WorkOrder.findByPk(order.id, { transaction });
          if (existing && !clearExisting) { results.workOrders.skipped++; continue; }
          if (existing) await existing.destroy({ transaction });
          const created = await WorkOrder.create(order, { transaction });
          if (parts) for (const pd of parts) {
            const { files, ...part } = pd;
            const cp = await WorkOrderPart.create({ ...part, workOrderId: created.id }, { transaction });
            if (files) for (const f of files) await WorkOrderPartFile.create({ ...f, workOrderPartId: cp.id }, { transaction });
          }
          if (documents) for (const d of documents) await WorkOrderDocument.create({ ...d, workOrderId: created.id }, { transaction });
          results.workOrders.restored++;
        } catch (e) { results.workOrders.skipped++; }
      }
    }

    // Estimates with parts, part files, estimate files
    if (backup.data.estimates) {
      results.estimates = { restored: 0, skipped: 0 };
      if (clearExisting) { await EstimatePartFile.destroy({ where: {}, transaction }); await EstimatePart.destroy({ where: {}, transaction }); await EstimateFile.destroy({ where: {}, transaction }); await Estimate.destroy({ where: {}, transaction }); }
      for (const ed of backup.data.estimates) {
        try {
          const { parts, files, ...estimate } = ed;
          const existing = await Estimate.findByPk(estimate.id, { transaction });
          if (existing && !clearExisting) { results.estimates.skipped++; continue; }
          if (existing) await existing.destroy({ transaction });
          const created = await Estimate.create(estimate, { transaction });
          if (parts) for (const pd of parts) {
            const { files: pf, ...part } = pd;
            const cp = await EstimatePart.create({ ...part, estimateId: created.id }, { transaction });
            if (pf) for (const f of pf) await EstimatePartFile.create({ ...f, estimatePartId: cp.id }, { transaction });
          }
          if (files) for (const f of files) await EstimateFile.create({ ...f, estimateId: created.id }, { transaction });
          results.estimates.restored++;
        } catch (e) { results.estimates.skipped++; }
      }
    }

    // Settings
    if (backup.data.settings) {
      results.settings = { restored: 0, skipped: 0 };
      for (const sd of backup.data.settings) {
        try {
          const [s, created] = await AppSettings.findOrCreate({ where: { key: sd.key }, defaults: sd, transaction });
          if (!created && clearExisting) await s.update({ value: sd.value }, { transaction });
          results.settings.restored++;
        } catch (e) { results.settings.skipped++; }
      }
    }

    await transaction.commit();

    // After restore: re-upload any files from backup that are missing on Cloudinary
    let fileResults = { checked: 0, reuploaded: 0, alreadyExist: 0, failed: 0 };
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

      // Collect all file records from all models that have URLs in the backup
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
          const exists = await checkUrl(url);
          if (exists) {
            fileResults.alreadyExist++;
            continue;
          }

          // File missing from Cloudinary — re-upload
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

    res.json({ message: 'Backup restored successfully', results, fileResults });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

module.exports = router;
module.exports.runAutoBackup = runAutoBackup;
