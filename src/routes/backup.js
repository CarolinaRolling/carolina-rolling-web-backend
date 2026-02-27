const express = require('express');
const cloudinary = require('cloudinary').v2;
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

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
async function buildBackup() {
  const backup = {
    version: '2.0',
    createdAt: new Date().toISOString(),
    data: {},
    counts: {}
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
async function runAutoBackup() {
  const startTime = Date.now();
  console.log('[auto-backup] Starting scheduled backup...');
  
  try {
    const backup = await buildBackup();
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
    const backup = await buildBackup();
    const filename = `backup-${new Date().toISOString().split('T')[0]}.json`;
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
    const result = await runAutoBackup();
    if (result.success) {
      res.json({ message: 'Backup completed successfully', data: result });
    } else {
      res.status(500).json({ error: { message: `Backup failed: ${result.error}` } });
    }
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
    res.json({ message: 'Backup restored successfully', results });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

module.exports = router;
module.exports.runAutoBackup = runAutoBackup;
