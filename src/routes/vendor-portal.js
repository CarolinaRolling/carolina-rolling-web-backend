/**
 * Vendor Portal Routes
 *
 * API endpoints for the vendor portal, scoped by vendorName on the API key.
 * Vendors can:
 *   - List their active purchase orders (OP POs, material POs, trucking POs)
 *   - View PO details with parts list (no prices, no customer name)
 *   - Download files that have been explicitly shared with the vendor portal
 *   - Report issues with parts (with photo upload)
 *   - View the status of their reported issues
 *
 * All endpoints require an API key with a non-null vendorName field.
 * Customer names are replaced with work order numbers (DR-####) in responses.
 */

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const multer = require('multer');
const {
  WorkOrder, WorkOrderPart, WorkOrderPartFile, WorkOrderDocument,
  Vendor, VendorIssue
} = require('../models');
const { authenticate } = require('./auth');
const fileStorage = require('../utils/storage');

// Multer for issue photo uploads — memory storage, 10 MB max
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

/**
 * Require vendor-scoped API key.
 * Must be placed AFTER `authenticate` middleware.
 */
const requireVendorScope = (req, res, next) => {
  if (!req.apiKey) {
    return res.status(401).json({ error: { message: 'Vendor portal requires API key authentication' } });
  }
  if (!req.apiKey.vendorName) {
    return res.status(403).json({ error: { message: 'This API key is not scoped to a vendor' } });
  }
  next();
};

/**
 * Sanitize a work order object for vendor consumption.
 * Removes customer name, prices, and other sensitive fields.
 */
function sanitizeWorkOrderForVendor(wo) {
  return {
    id: wo.id,
    workOrderNumber: wo.drNumber ? `DR-${wo.drNumber}` : (wo.orderNumber || null),
    drNumber: wo.drNumber || null,
    orderNumber: wo.orderNumber || null,
    // Customer name INTENTIONALLY omitted
    status: wo.status,
    promisedDate: wo.promisedDate,
    requestedDueDate: wo.requestedDueDate,
    createdAt: wo.createdAt
  };
}

/**
 * Sanitize a part object for vendor consumption — no prices, no costs.
 */
function sanitizePartForVendor(part) {
  const p = part.toJSON ? part.toJSON() : { ...part };
  // Merge formData JSONB
  if (p.formData && typeof p.formData === 'object') {
    Object.assign(p, p.formData);
  }
  return {
    id: p.id,
    partNumber: p.partNumber,
    clientPartNumber: p.clientPartNumber || null,
    partType: p.partType,
    quantity: p.quantity,
    material: p.material || null,
    thickness: p.thickness || null,
    width: p.width || null,
    length: p.length || null,
    outerDiameter: p.outerDiameter || null,
    innerDiameter: p.innerDiameter || null,
    wallThickness: p.wallThickness || null,
    sectionSize: p.sectionSize || null,
    rollType: p.rollType || null,
    radius: p.radius || null,
    diameter: p.diameter || null,
    arcLength: p.arcLength || null,
    arcDegrees: p.arcDegrees || null,
    materialDescription: p._materialDescription || p.materialDescription || null,
    rollingDescription: p._rollingDescription || null,
    specialInstructions: p.specialInstructions || null,
    status: p.status
    // Intentionally omitted: laborTotal, materialTotal, partTotal, markup, opCost, anything price-related
  };
}

// =============================================================================
// GET /api/vendor-portal/purchase-orders
// List all active POs for this vendor across OP operations, trucking trips, etc.
// "Active" = not completed/cancelled
// =============================================================================
router.get('/purchase-orders', authenticate, requireVendorScope, async (req, res, next) => {
  try {
    const vendorName = req.apiKey.vendorName;
    // Find the vendor record
    const vendor = await Vendor.findOne({ where: { name: vendorName } });
    if (!vendor) {
      return res.json({ data: [] }); // vendor name on api key but no matching record — return empty
    }

    // Find all work orders that have ANY OP operation or transport trip for this vendor
    // We need to scan through all active WOs since OP ops and transports are in JSONB.
    const workOrders = await WorkOrder.findAll({
      where: {
        status: { [Op.notIn]: ['completed', 'shipped', 'cancelled', 'voided'] },
        isVoided: { [Op.not]: true }
      },
      include: [{ model: WorkOrderPart, as: 'parts' }],
      order: [['createdAt', 'DESC']]
    });

    const result = [];
    for (const wo of workOrders) {
      const pos = [];

      // 1. Outside processing POs — nested in part.outsideProcessing JSONB
      for (const part of (wo.parts || [])) {
        const ops = part.outsideProcessing || [];
        for (const op of ops) {
          if (op.vendorId === vendor.id && op.poNumber) {
            pos.push({
              poNumber: op.poNumber,
              poType: 'outside_processing',
              serviceType: op.serviceType || null,
              partId: part.id,
              partNumber: part.partNumber,
              clientPartNumber: part.clientPartNumber || null,
              quantity: part.quantity,
              sentAt: op.poSentAt || null,
              // No cost included
            });
          }
        }
      }

      // 2. Trucking POs — nested in wo.opTransports JSONB
      const trips = wo.opTransports || [];
      for (const trip of trips) {
        if (trip.truckingVendorId === vendor.id && trip.poNumber) {
          pos.push({
            poNumber: trip.poNumber,
            poType: 'transport',
            leg: trip.leg || null,
            sentAt: trip.poSentAt || null,
            allocationMode: trip.allocationMode || null
            // No cost included
          });
        }
      }

      if (pos.length > 0) {
        result.push({
          ...sanitizeWorkOrderForVendor(wo),
          purchaseOrders: pos
        });
      }
    }

    res.json({ data: result });
  } catch (error) {
    console.error('[vendor-portal] list POs error:', error);
    next(error);
  }
});

// =============================================================================
// GET /api/vendor-portal/purchase-orders/:poNumber
// Get details for a specific PO including parts list and shared files
// =============================================================================
router.get('/purchase-orders/:poNumber', authenticate, requireVendorScope, async (req, res, next) => {
  try {
    const vendorName = req.apiKey.vendorName;
    const { poNumber } = req.params;
    const vendor = await Vendor.findOne({ where: { name: vendorName } });
    if (!vendor) {
      return res.status(404).json({ error: { message: 'Vendor not found' } });
    }

    // Scan work orders for this PO number (since POs are embedded in JSONB)
    const workOrders = await WorkOrder.findAll({
      where: {
        isVoided: { [Op.not]: true }
      },
      include: [{
        model: WorkOrderPart,
        as: 'parts',
        include: [{ model: WorkOrderPartFile, as: 'files' }]
      }]
    });

    let matchedWo = null;
    let poInfo = null;
    let poType = null;
    let matchedPartIds = []; // parts this PO covers

    for (const wo of workOrders) {
      // Check OP POs
      for (const part of (wo.parts || [])) {
        const ops = part.outsideProcessing || [];
        for (const op of ops) {
          if (op.vendorId === vendor.id && op.poNumber === poNumber) {
            matchedWo = wo;
            poType = 'outside_processing';
            poInfo = {
              poNumber: op.poNumber,
              poType: 'outside_processing',
              serviceType: op.serviceType || null,
              sentAt: op.poSentAt || null
            };
            matchedPartIds.push(part.id);
          }
        }
      }

      // Check Trucking POs
      if (!matchedWo) {
        const trips = wo.opTransports || [];
        for (const trip of trips) {
          if (trip.truckingVendorId === vendor.id && trip.poNumber === poNumber) {
            matchedWo = wo;
            poType = 'transport';
            poInfo = {
              poNumber: trip.poNumber,
              poType: 'transport',
              leg: trip.leg || null,
              sentAt: trip.poSentAt || null,
              allocationMode: trip.allocationMode || null
            };
            // For transport POs, target parts depend on allocation mode
            if (trip.allocationMode === 'manual') {
              matchedPartIds = (trip.partIds || []).slice();
            } else {
              // Auto modes: all parts with OP are affected
              matchedPartIds = (wo.parts || [])
                .filter(p => (p.outsideProcessing || []).length > 0)
                .map(p => p.id);
            }
          }
        }
      }

      if (matchedWo) break;
    }

    if (!matchedWo || !poInfo) {
      return res.status(404).json({ error: { message: 'PO not found or not assigned to this vendor' } });
    }

    // Build parts list — only parts that are on this PO
    const relevantParts = (matchedWo.parts || []).filter(p => matchedPartIds.includes(p.id));
    const parts = relevantParts.map(p => {
      const sanitized = sanitizePartForVendor(p);
      // Attach shared files for this part
      sanitized.files = (p.files || [])
        .filter(f => f.vendorPortalVisible === true)
        .map(f => ({
          id: f.id,
          originalName: f.originalName || f.filename,
          fileType: f.fileType,
          mimeType: f.mimeType,
          size: f.size
        }));
      return sanitized;
    });

    res.json({
      data: {
        workOrder: sanitizeWorkOrderForVendor(matchedWo),
        purchaseOrder: poInfo,
        parts
      }
    });
  } catch (error) {
    console.error('[vendor-portal] PO detail error:', error);
    next(error);
  }
});

// =============================================================================
// GET /api/vendor-portal/files/:fileId/download
// Get a signed download URL for a file — only if vendorPortalVisible is true
// AND the file's part is on a PO assigned to this vendor
// =============================================================================
router.get('/files/:fileId/download', authenticate, requireVendorScope, async (req, res, next) => {
  try {
    const vendorName = req.apiKey.vendorName;
    const vendor = await Vendor.findOne({ where: { name: vendorName } });
    if (!vendor) {
      return res.status(403).json({ error: { message: 'Vendor not found' } });
    }

    const file = await WorkOrderPartFile.findByPk(req.params.fileId, {
      include: [{
        model: WorkOrderPart,
        as: 'part',
        include: [{ model: WorkOrder, as: 'workOrder' }]
      }]
    });
    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }
    if (!file.vendorPortalVisible) {
      return res.status(403).json({ error: { message: 'File not shared with vendor portal' } });
    }

    // Verify this vendor has a PO on this part or its WO
    const part = file.part;
    const wo = part?.workOrder;
    if (!wo || wo.isVoided) {
      return res.status(403).json({ error: { message: 'Work order not accessible' } });
    }

    let hasAccess = false;
    const ops = part.outsideProcessing || [];
    for (const op of ops) {
      if (op.vendorId === vendor.id) { hasAccess = true; break; }
    }
    if (!hasAccess) {
      const trips = wo.opTransports || [];
      for (const trip of trips) {
        if (trip.truckingVendorId === vendor.id) {
          if (trip.allocationMode === 'manual') {
            if ((trip.partIds || []).includes(part.id)) { hasAccess = true; break; }
          } else {
            if ((part.outsideProcessing || []).length > 0) { hasAccess = true; break; }
          }
        }
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: { message: 'Vendor does not have a PO covering this part' } });
    }

    // Generate signed URL (or return direct URL for non-S3)
    let downloadUrl = file.url;
    if (file.cloudinaryId && file.cloudinaryId.startsWith('s3:')) {
      try {
        const key = file.cloudinaryId.replace(/^s3:/, '');
        const signed = await fileStorage.getPresignedUrl(key);
        if (signed) downloadUrl = signed;
      } catch (e) { /* fall back to file.url */ }
    }

    res.json({
      data: {
        url: downloadUrl,
        originalName: file.originalName || file.filename,
        mimeType: file.mimeType,
        size: file.size
      }
    });
  } catch (error) {
    console.error('[vendor-portal] download error:', error);
    next(error);
  }
});

// =============================================================================
// POST /api/vendor-portal/issues
// Report an issue with a part. Supports photo upload via multipart/form-data.
// Fields: workOrderId, workOrderPartId (optional), poNumber (optional),
//         reportedBy, description, photo (file, optional)
// =============================================================================
router.post('/issues', authenticate, requireVendorScope, upload.single('photo'), async (req, res, next) => {
  try {
    const vendorName = req.apiKey.vendorName;
    const vendor = await Vendor.findOne({ where: { name: vendorName } });

    const { workOrderId, workOrderPartId, poNumber, reportedBy, description } = req.body;
    if (!workOrderId || !description) {
      return res.status(400).json({ error: { message: 'workOrderId and description are required' } });
    }

    // Verify the work order exists and is not voided
    const wo = await WorkOrder.findByPk(workOrderId);
    if (!wo || wo.isVoided) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Verify this vendor has a PO on this WO (either via OP or transport)
    const parts = await WorkOrderPart.findAll({ where: { workOrderId: wo.id } });
    let hasAccess = false;
    for (const p of parts) {
      const ops = p.outsideProcessing || [];
      if (ops.some(op => op.vendorId === vendor?.id)) { hasAccess = true; break; }
    }
    if (!hasAccess) {
      const trips = wo.opTransports || [];
      if (trips.some(t => t.truckingVendorId === vendor?.id)) hasAccess = true;
    }
    if (!hasAccess) {
      return res.status(403).json({ error: { message: 'Vendor does not have a PO on this work order' } });
    }

    // Upload photo if present
    let photoUrl = null;
    let photoStorageId = null;
    if (req.file) {
      try {
        const uploaded = await fileStorage.uploadBuffer(req.file.buffer, {
          folder: 'vendor-issues',
          filename: `issue-${Date.now()}-${req.file.originalname}`,
          mimeType: req.file.mimetype,
          resourceType: 'image'
        });
        photoUrl = uploaded.url;
        photoStorageId = uploaded.storageId;
      } catch (e) {
        console.error('[vendor-portal] photo upload failed:', e);
      }
    }

    // Create the issue
    const issue = await VendorIssue.create({
      workOrderId: wo.id,
      workOrderPartId: workOrderPartId || null,
      vendorId: vendor?.id || null,
      vendorName: vendorName,
      poNumber: poNumber || null,
      reportedBy: reportedBy || null,
      description,
      photoUrl,
      photoStorageId,
      status: 'open',
      reportedAt: new Date()
    });

    // Fire email notification (async, non-blocking)
    (async () => {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
        });
        const toEmail = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER;
        if (!toEmail) {
          console.log('[vendor-portal] No NOTIFICATION_EMAIL configured, skipping email alert');
          return;
        }
        const woNum = wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber;
        const photoHtml = photoUrl ? `<p><strong>Photo:</strong><br><img src="${photoUrl}" style="max-width:500px;border:1px solid #ccc" /></p>` : '';
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: toEmail,
          subject: `⚠ Vendor Issue Reported - ${vendorName} on ${woNum}`,
          html: `
            <h2 style="color:#c62828">⚠ Vendor Issue Report</h2>
            <p><strong>Work Order:</strong> ${woNum}</p>
            <p><strong>Vendor:</strong> ${vendorName}</p>
            <p><strong>Reported by:</strong> ${reportedBy || 'Unknown'}</p>
            ${poNumber ? `<p><strong>PO Number:</strong> ${poNumber}</p>` : ''}
            <p><strong>Description:</strong></p>
            <div style="background:#fff3e0;padding:12px;border-left:4px solid #E65100;margin:8px 0">
              ${description.replace(/\n/g, '<br>')}
            </div>
            ${photoHtml}
            <p style="color:#666;font-size:12px;margin-top:20px">Open the work order to review and resolve this issue.</p>
          `
        });
        console.log(`[vendor-portal] Email alert sent for issue on ${woNum}`);
      } catch (e) {
        console.error('[vendor-portal] email notification failed:', e.message);
      }
    })();

    console.log(`[vendor-portal] Issue reported by ${vendorName} on ${wo.drNumber ? 'DR-' + wo.drNumber : wo.orderNumber}: ${description.slice(0, 80)}`);
    res.json({
      data: {
        id: issue.id,
        status: issue.status,
        reportedAt: issue.reportedAt
      },
      message: 'Issue reported successfully'
    });
  } catch (error) {
    console.error('[vendor-portal] issue create error:', error);
    next(error);
  }
});

// =============================================================================
// GET /api/vendor-portal/issues
// List all issues reported by this vendor (so they can track resolution status)
// =============================================================================
router.get('/issues', authenticate, requireVendorScope, async (req, res, next) => {
  try {
    const vendorName = req.apiKey.vendorName;
    const issues = await VendorIssue.findAll({
      where: { vendorName },
      include: [{ model: WorkOrder, as: 'workOrder', attributes: ['id', 'drNumber', 'orderNumber'] }],
      order: [['reportedAt', 'DESC']],
      limit: 100
    });

    const data = issues.map(i => ({
      id: i.id,
      workOrderNumber: i.workOrder ? (i.workOrder.drNumber ? `DR-${i.workOrder.drNumber}` : i.workOrder.orderNumber) : null,
      poNumber: i.poNumber,
      reportedBy: i.reportedBy,
      description: i.description,
      photoUrl: i.photoUrl,
      status: i.status,
      reportedAt: i.reportedAt,
      resolvedAt: i.resolvedAt,
      resolutionNotes: i.resolutionNotes
    }));

    res.json({ data });
  } catch (error) {
    console.error('[vendor-portal] list issues error:', error);
    next(error);
  }
});

module.exports = router;
