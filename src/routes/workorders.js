const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const { Op } = require('sequelize');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const { WorkOrder, WorkOrderPart, WorkOrderPartFile, WorkOrderDocument, DailyActivity, DRNumber, InboundOrder, PONumber, AppSettings, Estimate, Vendor, Client, Shipment, ShipmentPhoto, sequelize } = require('../models');

const router = express.Router();

// Fetch a URL following redirects (up to 5 hops), returns response stream or null
function fetchWithRedirects(url, maxRedirects = 5, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && maxRedirects > 0) {
        resp.resume();
        fetchWithRedirects(resp.headers.location, maxRedirects - 1, timeoutMs).then(resolve);
      } else if (resp.statusCode === 200) {
        resolve(resp);
      } else {
        resp.resume();
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

// Helper to clean numeric fields - convert empty strings to null
function cleanNumericFields(data, fields) {
  const cleaned = { ...data };
  fields.forEach(field => {
    if (cleaned[field] === '' || cleaned[field] === undefined) {
      cleaned[field] = null;
    } else if (cleaned[field] !== null) {
      const num = parseFloat(cleaned[field]);
      cleaned[field] = isNaN(num) ? null : num;
    }
  });
  return cleaned;
}

// Extract underscore-prefixed fields from part data into formData JSONB
function extractFormData(data) {
  const formData = {};
  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) {
      formData[key] = value;
    } else {
      cleaned[key] = value;
    }
  }
  if (Object.keys(formData).length > 0) {
    cleaned.formData = formData;
  }
  return cleaned;
}

// Merge formData back into part object for API response
function mergeFormData(part) {
  const obj = part.toJSON ? part.toJSON() : { ...part };
  if (obj.formData && typeof obj.formData === 'object') {
    Object.assign(obj, obj.formData);
  }
  return obj;
}

// Helper function to generate Purchase Order PDF
async function generatePurchaseOrderPDF(poNumber, supplier, parts, workOrder) {
  const PDFDocument = require('pdfkit');
  
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      const W = 512; // usable width (612 - 100 margins)
      const L = 50;  // left margin
      const R = L + W; // right edge
      
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      
      // ─── TOP BORDER ───
      doc.rect(L, 40, W, 4).fill('#1565c0');
      
      // ─── HEADER: Company + PO Title ───
      const headerY = 52;
      
      // Company name & info (left)
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1565c0').text('CAROLINA ROLLING COMPANY INC.', L, headerY);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text('9152 Sonrisa St, Bellflower, CA 90706', L, headerY + 18);
      doc.text('Phone: (562) 633-1044  •  Email: keepitrolling@carolinarolling.com', L, headerY + 28);
      
      // PO label + number (right)
      doc.fontSize(24).font('Helvetica-Bold').fillColor('#1565c0').text('PURCHASE ORDER', L, headerY, { width: W, align: 'right' });
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#333').text(poNumber, L, headerY + 28, { width: W, align: 'right' });
      
      // ─── DIVIDER ───
      doc.moveTo(L, headerY + 46).lineTo(R, headerY + 46).strokeColor('#ccc').lineWidth(1).stroke();
      
      // ─── INFO BOXES ───
      const boxY = headerY + 56;
      const boxH = 70;
      const halfW = (W - 16) / 2;
      
      // TO box (left)
      doc.rect(L, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(L, boxY, halfW, 16).fill('#f0f0f0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#666').text('VENDOR', L + 8, boxY + 4);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(supplier, L + 8, boxY + 22, { width: halfW - 16 });
      
      // SHIP TO box (right)
      const boxX2 = L + halfW + 16;
      doc.rect(boxX2, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(boxX2, boxY, halfW, 16).fill('#f0f0f0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#666').text('SHIP TO', boxX2 + 8, boxY + 4);
      doc.fontSize(9).font('Helvetica').fillColor('#000');
      doc.text('Carolina Rolling Company Inc.', boxX2 + 8, boxY + 22, { width: halfW - 16 });
      doc.text('9152 Sonrisa St', boxX2 + 8, boxY + 34);
      doc.text('Bellflower, CA 90706', boxX2 + 8, boxY + 46);
      
      // ─── PO DETAILS ROW ───
      const detY = boxY + boxH + 12;
      const detFields = [
        ['PO DATE', new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })],
        ['WORK ORDER', workOrder.drNumber ? `DR-${workOrder.drNumber}` : (workOrder.orderNumber || '-')]
      ];
      const colW = W / detFields.length;
      
      detFields.forEach(([label, value], i) => {
        const x = L + (i * colW);
        doc.rect(x, detY, colW, 32).lineWidth(0.5).strokeColor('#ddd').stroke();
        doc.rect(x, detY, colW, 14).fill('#f5f5f5');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#888').text(label, x + 6, detY + 3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(value, x + 6, detY + 17, { width: colW - 12 });
      });
      
      // ─── ITEMS TABLE ───
      const tableY = detY + 46;
      const cols = { item: L, qty: L + 40, desc: L + 80, cutFile: L + 360 };
      const colWidths = { item: 40, qty: 40, desc: 280, cutFile: W - 360 };
      
      // Table header
      doc.rect(L, tableY, W, 18).fill('#1565c0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
      doc.text('ITEM', cols.item + 6, tableY + 5);
      doc.text('QTY', cols.qty + 6, tableY + 5);
      doc.text('DESCRIPTION', cols.desc + 6, tableY + 5);
      doc.text('CUT FILE', cols.cutFile + 6, tableY + 5);
      
      // Table rows
      let rowY = tableY + 18;
      doc.font('Helvetica').fillColor('#000');
      
      const sortedAll = [...parts].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
      // Group services under parent parts
      const mergedAll = sortedAll.map(p => {
        const o = p.toJSON ? p.toJSON() : { ...p };
        if (o.formData && typeof o.formData === 'object') Object.assign(o, o.formData);
        return o;
      });
      const regParts = mergedAll.filter(p => !['fab_service', 'shop_rate'].includes(p.partType) || !p._linkedPartId);
      const svcParts = mergedAll.filter(p => ['fab_service', 'shop_rate'].includes(p.partType) && p._linkedPartId);
      const sortedParts = [];
      const usedSvc = new Set();
      regParts.forEach(rp => {
        sortedParts.push(rp);
        svcParts.forEach(sp => {
          if (String(sp._linkedPartId) === String(rp.id) && !usedSvc.has(sp.id)) { sortedParts.push(sp); usedSvc.add(sp.id); }
        });
      });
      svcParts.forEach(sp => { if (!usedSvc.has(sp.id)) sortedParts.push(sp); });
      
      sortedParts.forEach((partObj, index) => {
        
        let desc = partObj._materialDescription || partObj.materialDescription || '';
        // For cones, rebuild from fields to avoid stale/garbled data
        if (partObj.partType === 'cone_roll') {
          const thk = partObj.thickness || '';
          const ldType = (partObj._coneLargeDiaType || 'inside') === 'inside' ? 'ID' : (partObj._coneLargeDiaType === 'outside' ? 'OD' : 'CLD');
          const sdType = (partObj._coneSmallDiaType || 'inside') === 'inside' ? 'ID' : (partObj._coneSmallDiaType === 'outside' ? 'OD' : 'CLD');
          const ld = parseFloat(partObj._coneLargeDia) || 0;
          const sd = parseFloat(partObj._coneSmallDia) || 0;
          const vh = parseFloat(partObj._coneHeight) || 0;
          const grade = partObj.material || '';
          const origin = partObj._materialOrigin || '';
          desc = (thk ? thk + ' ' : '') + 'Cone - ';
          if (ld && sd && vh) desc += ld.toFixed(1) + '" ' + ldType + ' x ' + sd.toFixed(1) + '" ' + sdType + ' x ' + vh.toFixed(1) + '" VH';
          if (grade) desc += ' ' + grade;
          if (origin) desc += ' ' + origin;
        }
        if (!desc) {
          const pieces = [];
          if (partObj.sectionSize) {
            const sizeDisplay = partObj.partType === 'pipe_roll' && partObj._schedule ? partObj.sectionSize.replace(' Pipe', ` Sch ${partObj._schedule} Pipe`) : partObj.sectionSize;
            pieces.push(sizeDisplay);
          }
          if (partObj.thickness) pieces.push(partObj.thickness);
          if (partObj.width) pieces.push(`x ${partObj.width}"`);
          if (partObj.length) pieces.push(`x ${partObj.length}`);
          if (partObj.outerDiameter) pieces.push(`${partObj.outerDiameter}" OD`);
          if (partObj.wallThickness && partObj.wallThickness !== 'SOLID') pieces.push(`x ${partObj.wallThickness} wall`);
          if (partObj.wallThickness === 'SOLID') pieces.push('Solid');
          if (partObj.material) pieces.push(partObj.material);
          if (partObj.partType) pieces.push(partObj.partType.replace(/_/g, ' '));
          desc = pieces.join(' ') || 'N/A';
        }
        
        const cutFile = partObj.cutFileReference || '';
        
        // Calculate row height based on description length
        const descHeight = doc.heightOfString(desc, { width: colWidths.desc - 12 });
        const rowHeight = Math.max(28, descHeight + 12);
        
        // Page break check
        if (rowY + rowHeight > 700) {
          doc.addPage();
          rowY = 50;
          // Repeat header on new page
          doc.rect(L, rowY, W, 18).fill('#1565c0');
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
          doc.text('ITEM', cols.item + 6, rowY + 5);
          doc.text('QTY', cols.qty + 6, rowY + 5);
          doc.text('DESCRIPTION', cols.desc + 6, rowY + 5);
          doc.text('CUT FILE', cols.cutFile + 6, rowY + 5);
          rowY += 18;
          doc.font('Helvetica').fillColor('#000');
        }
        
        // Alternating row background
        if (index % 2 === 0) {
          doc.rect(L, rowY, W, rowHeight).fill('#f8f9fa');
        }
        
        // Row border
        doc.moveTo(L, rowY + rowHeight).lineTo(R, rowY + rowHeight).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
        
        doc.fillColor('#000');
        doc.fontSize(9).font('Helvetica-Bold').text(`${partObj.partNumber || index + 1}`, cols.item + 6, rowY + 6, { width: colWidths.item - 12 });
        doc.font('Helvetica').text(`${partObj.quantity || 1}`, cols.qty + 6, rowY + 6, { width: colWidths.qty - 12 });
        doc.fontSize(8.5).text(desc, cols.desc + 6, rowY + 6, { width: colWidths.desc - 12 });
        
        if (cutFile) {
          doc.fontSize(8).fillColor('#1565c0').font('Helvetica-Bold').text(cutFile, cols.cutFile + 6, rowY + 6, { width: colWidths.cutFile - 12 });
          doc.fillColor('#000').font('Helvetica');
        }
        
        rowY += rowHeight;
      });
      
      // Table bottom border
      doc.moveTo(L, rowY).lineTo(R, rowY).strokeColor('#1565c0').lineWidth(1.5).stroke();
      
      // ─── NOTES / TERMS ───
      // Check if notes section fits on current page (~140px needed)
      const notesNeeded = 130;
      if (rowY + 20 + notesNeeded > 720) {
        doc.addPage();
        rowY = 50;
      }
      
      const notesY = rowY + 20;
      
      // MTR requirement box
      doc.rect(L, notesY, W, 36).lineWidth(1.5).strokeColor('#c62828').stroke();
      doc.rect(L, notesY, W, 14).fill('#ffebee');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#c62828').text('⚠ IMPORTANT', L + 8, notesY + 3);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#c62828');
      doc.text('Material Test Reports (MTRs) are required with all shipments.', L + 8, notesY + 18);
      
      // General notes
      const notesY2 = notesY + 46;
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#333').text('TERMS & INSTRUCTIONS:', L, notesY2);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text(`• Please reference ${poNumber} on all correspondence, packing lists, and invoices.`, L + 8, notesY2 + 14);
      doc.text(`• Material is for: ${workOrder.drNumber ? 'DR-' + workOrder.drNumber : workOrder.orderNumber}`, L + 8, notesY2 + 26);
      doc.text('• Notify us immediately of any delays or backorders.', L + 8, notesY2 + 38);
      
      // Any parts with cut files — add a prominent note
      let lastNoteY = notesY2 + 38;
      const partsWithCutFiles = sortedParts.filter(p => {
        const obj = p.toJSON ? p.toJSON() : { ...p };
        if (obj.formData) Object.assign(obj, obj.formData);
        return obj.cutFileReference;
      });
      if (partsWithCutFiles.length > 0) {
        lastNoteY = notesY2 + 50;
        doc.text('• Cut files referenced above will be sent separately via email.', L + 8, lastNoteY);
      }
      
      // ─── FOOTER — positioned right after notes ───
      const footY = lastNoteY + 24;
      doc.moveTo(L, footY).lineTo(R, footY).strokeColor('#ccc').lineWidth(0.5).stroke();
      doc.fontSize(7).font('Helvetica').fillColor('#999');
      doc.text(`Carolina Rolling Company Inc.  •  ${poNumber}  •  Generated ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}`, L, footY + 6, { width: W, align: 'center' });
      
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Helper to log activity for daily email
async function logActivity(type, resourceType, resourceId, resourceNumber, clientName, description, details = {}) {
  try {
    await DailyActivity.create({
      activityType: type,
      resourceType,
      resourceId,
      resourceNumber,
      clientName,
      description,
      details
    });
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}

// Temp uploads directory for multer
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB for STEP files
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/stp',
      'application/step',
      'model/step',
      'application/octet-stream' // STEP files often come as this
    ];
    const allowedExtensions = ['.pdf', '.stp', '.step'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and STEP files are allowed.'));
    }
  }
});

// Clean up temp file
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error cleaning up temp file:', error);
  }
}

// Generate unique work order number
function generateOrderNumber() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `WO-${year}${month}${day}-${random}`;
}

// GET /api/workorders - Get all work orders
router.get('/', async (req, res, next) => {
  try {
    const { status, clientName, archived, drNumber, limit = 50, offset = 0 } = req.query;
    
    const where = {};
    
    // By default, exclude archived/shipped/picked_up unless specifically requested
    if (archived === 'true') {
      where.status = { [Op.in]: ['archived', 'shipped', 'picked_up'] };
    } else if (archived === 'only') {
      where.status = 'archived';
    } else if (status) {
      where.status = status;
    } else {
      where.status = { [Op.notIn]: ['archived', 'shipped', 'picked_up'] };
    }
    
    if (clientName) where.clientName = { [Op.iLike]: `%${clientName}%` };
    if (drNumber) where.drNumber = parseInt(drNumber);

    const workOrders = await WorkOrder.findAndCountAll({
      where,
      include: [{
        model: WorkOrderPart,
        as: 'parts',
        include: [{
          model: WorkOrderPartFile,
          as: 'files'
        }]
      }],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Batch fetch shipment photos for all work orders in this page
    const workOrderIds = workOrders.rows.map(wo => wo.id);
    let shipmentPhotoMap = {};
    try {
      const shipments = await Shipment.findAll({
        where: { workOrderId: { [Op.in]: workOrderIds } },
        include: [{ model: ShipmentPhoto, as: 'photos' }]
      });
      shipments.forEach(s => {
        if (s.photos && s.photos.length > 0) {
          shipmentPhotoMap[s.workOrderId] = s.photos[0].url;
        }
      });
    } catch (e) {
      console.error('Error fetching shipment photos for thumbnails:', e);
    }

    // Generate thumbnail URLs for inventory grid
    const rowsWithThumbnails = workOrders.rows.map(wo => {
      const data = wo.toJSON();
      data.thumbnailUrl = null;

      // Priority 1: Shipment photos (public Cloudinary URLs — work directly)
      if (shipmentPhotoMap[data.id]) {
        data.thumbnailUrl = shipmentPhotoMap[data.id];
      }

      return data;
    });

    res.json({
      data: rowsWithThumbnails,
      total: workOrders.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/recently-completed - Orders completed from shop floor in last 48h
router.get('/recently-completed', async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const orders = await WorkOrder.findAll({
      where: {
        completedAt: { [Op.gte]: cutoff },
        status: { [Op.in]: ['stored', 'shipped', 'archived'] }
      },
      include: [{ model: WorkOrderPart, as: 'parts' }],
      order: [['completedAt', 'DESC']],
      limit: 20
    });
    res.json({ data: orders });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/:id - Get work order by ID
router.get('/:id', async (req, res, next) => {
  try {
    // Support both UUID and orderNumber
    const idParam = req.params.id;
    let workOrder;
    
    // Check if it's a UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(idParam)) {
      workOrder = await WorkOrder.findByPk(idParam, {
        include: [
          {
            model: WorkOrderPart,
            as: 'parts',
            include: [
              { model: WorkOrderPartFile, as: 'files' },
              { model: Vendor, as: 'vendor', attributes: ['id', 'name', 'contactName', 'contactPhone', 'contactEmail'] }
            ],
            order: [['partNumber', 'ASC']]
          },
          {
            model: WorkOrderDocument,
            as: 'documents'
          }
        ]
      });
    } else {
      // Try to find by orderNumber or drNumber
      workOrder = await WorkOrder.findOne({
        where: idParam.startsWith('DR-') 
          ? { drNumber: parseInt(idParam.replace('DR-', '')) }
          : { orderNumber: idParam },
        include: [
          {
            model: WorkOrderPart,
            as: 'parts',
            include: [
              { model: WorkOrderPartFile, as: 'files' },
              { model: Vendor, as: 'vendor', attributes: ['id', 'name', 'contactName', 'contactPhone', 'contactEmail'] }
            ],
            order: [['partNumber', 'ASC']]
          },
          {
            model: WorkOrderDocument,
            as: 'documents'
          }
        ]
      });
    }

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Rewrite file URLs to use download proxy (handles resource_type mismatches transparently)
    const woJson = workOrder.toJSON();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    if (woJson.parts) {
      for (const part of woJson.parts) {
        if (part.files) {
          for (const file of part.files) {
            file.url = `${baseUrl}/api/workorders/${woJson.id}/parts/${part.id}/files/${file.id}/download`;
          }
        }
      }
    }
    // Rewrite document URLs to use download proxy
    if (woJson.documents) {
      for (const doc of woJson.documents) {
        doc.url = `${baseUrl}/api/workorders/${woJson.id}/documents/${doc.id}/download`;
      }
    }

    res.json({ data: woJson });
  } catch (error) {
    next(error);
  }
});

// POST /api/workorders - Create new work order
router.post('/', async (req, res, next) => {
  try {
    const {
      clientName,
      clientId,
      clientPO,
      clientPurchaseOrderNumber,
      jobNumber,
      contactName,
      contactPhone,
      contactEmail,
      projectDescription,
      notes,
      storageLocation,
      receivedBy,
      requestedDueDate,
      promisedDate,
      status = 'received',
      shipmentIds = [],
      assignDRNumber = false
    } = req.body;

    if (!clientName && !clientId) {
      return res.status(400).json({ error: { message: 'Client is required' } });
    }

    // Resolve client name from clientId if needed
    let resolvedClientName = clientName;
    let resolvedClientId = clientId || null;
    let resolvedClient = null;
    if (resolvedClientId && !resolvedClientName) {
      resolvedClient = await Client.findByPk(resolvedClientId);
      if (resolvedClient) resolvedClientName = resolvedClient.name;
    } else if (resolvedClientId) {
      resolvedClient = await Client.findByPk(resolvedClientId);
    }

    // Determine tax rate: client-specific > admin default
    let effectiveTaxRate = null;
    if (resolvedClient?.customTaxRate) {
      effectiveTaxRate = parseFloat(resolvedClient.customTaxRate) * 100; // stored as decimal, convert to %
    }
    if (!effectiveTaxRate) {
      try {
        const taxSetting = await AppSettings.findOne({ where: { key: 'tax_settings' } });
        effectiveTaxRate = taxSetting?.value?.defaultTaxRate || 9.75;
      } catch (e) { effectiveTaxRate = 9.75; }
    }

    const orderNumber = generateOrderNumber();

    // Start transaction
    const transaction = await sequelize.transaction();
    
    try {
      // Create work order
      const workOrder = await WorkOrder.create({
        orderNumber,
        clientId: resolvedClientId,
        clientName: resolvedClientName,
        clientPurchaseOrderNumber: clientPO || clientPurchaseOrderNumber,
        jobNumber,
        contactName,
        contactPhone,
        contactEmail,
        projectDescription,
        notes,
        storageLocation,
        receivedBy,
        receivedAt: new Date(),
        requestedDueDate: requestedDueDate || null,
        promisedDate: promisedDate || null,
        status,
        taxRate: effectiveTaxRate,
        allMaterialReceived: true
      }, { transaction });

      // Assign DR number if requested
      let drNumber = null;
      if (assignDRNumber) {
        // Check admin setting for next DR number first
        const drSetting = await AppSettings.findOne({ where: { key: 'next_dr_number' }, transaction });
        
        if (drSetting?.value?.nextNumber) {
          drNumber = drSetting.value.nextNumber;
          await drSetting.update({ value: { nextNumber: drNumber + 1 } }, { transaction });
        } else {
          // Fallback: get max from both tables
          const maxDR = await DRNumber.findOne({
            order: [['drNumber', 'DESC']],
            transaction
          });
          drNumber = (maxDR?.drNumber || 0) + 1;
          
          const maxWODR = await WorkOrder.max('drNumber', { transaction });
          if (maxWODR && maxWODR >= drNumber) {
            drNumber = maxWODR + 1;
          }
        }

        // Update work order with DR number
        await workOrder.update({ drNumber }, { transaction });

        // Record DR number assignment
        await DRNumber.create({
          drNumber,
          workOrderId: workOrder.id,
          clientName,
          assignedAt: new Date(),
          assignedBy: req.user?.username || 'system'
        }, { transaction });

        // Log activity
        await logActivity(
          'dr_assigned',
          'work_order',
          workOrder.id,
          `DR-${drNumber}`,
          clientName,
          `DR number assigned to new work order`,
          { orderNumber }
        );
      }

      // Link shipments if provided
      if (shipmentIds && shipmentIds.length > 0) {
        const { Shipment } = require('../models');
        await Shipment.update(
          { workOrderId: workOrder.id },
          { 
            where: { id: shipmentIds },
            transaction
          }
        );
      }

      await transaction.commit();

      // Reload with associations
      const createdOrder = await WorkOrder.findByPk(workOrder.id, {
        include: [{
          model: WorkOrderPart,
          as: 'parts',
          include: [{
            model: WorkOrderPartFile,
            as: 'files'
          }]
        }]
      });

      res.status(201).json({
        data: createdOrder,
        message: drNumber 
          ? `Work order created with DR-${drNumber}`
          : 'Work order created successfully'
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/workorders/:id - Update work order
// PUT /api/workorders/:id/status - Quick status update (shop floor)
router.put('/:id/status', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: { message: 'Status is required' } });
    }
    await workOrder.update({ status });
    res.json({ data: workOrder, message: `Status updated to ${status}` });
  } catch (error) {
    next(error);
  }
});

// POST /api/workorders/:id/mark-complete - Shop floor marks order complete
router.post('/:id/mark-complete', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }
    
    // Verify all parts are completed
    const incompleteParts = workOrder.parts.filter(p => p.status !== 'completed');
    if (incompleteParts.length > 0) {
      return res.status(400).json({ 
        error: { message: `${incompleteParts.length} part(s) not yet completed` }
      });
    }
    
    // Add completion note with timestamp
    const now = new Date();
    const completionNote = `✅ All ${workOrder.parts.length} part(s) completed from shop floor — ${now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })} ${now.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })}`;
    const updatedNotes = workOrder.notes 
      ? `${workOrder.notes}\n\n${completionNote}` 
      : completionNote;
    
    await workOrder.update({ 
      status: 'stored',
      completedAt: now,
      notes: updatedNotes
    });
    
    res.json({ data: workOrder, message: 'Order marked complete and moved to Stored' });
  } catch (error) {
    next(error);
  }
});

// PUT /:id/dr-number - Change DR number (must be unique)
router.put('/:id/dr-number', async (req, res, next) => {
  try {
    const { drNumber } = req.body;
    const newDR = parseInt(drNumber);
    if (!newDR || newDR < 1) {
      return res.status(400).json({ error: { message: 'Invalid DR number' } });
    }

    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    if (workOrder.drNumber === newDR) {
      return res.json({ data: workOrder.toJSON(), message: 'No change' });
    }

    // Check uniqueness across WorkOrders and DRNumbers
    const existingWO = await WorkOrder.findOne({ where: { drNumber: newDR } });
    if (existingWO && existingWO.id !== workOrder.id) {
      return res.status(409).json({ error: { message: `DR-${newDR} is already assigned to another work order` } });
    }

    const transaction = await sequelize.transaction();
    try {
      const oldDR = workOrder.drNumber;

      // Update work order
      await workOrder.update({ drNumber: newDR }, { transaction });

      // Update or create DRNumber record
      if (oldDR) {
        const existingDRRecord = await DRNumber.findOne({ where: { drNumber: oldDR, workOrderId: workOrder.id }, transaction });
        if (existingDRRecord) {
          await existingDRRecord.update({ drNumber: newDR }, { transaction });
        }
      } else {
        await DRNumber.create({
          drNumber: newDR,
          workOrderId: workOrder.id,
          clientName: workOrder.clientName,
          assignedAt: new Date(),
          assignedBy: req.user?.username || 'system'
        }, { transaction });
      }

      await transaction.commit();

      res.json({
        data: workOrder.toJSON(),
        message: `DR number changed from ${oldDR ? 'DR-' + oldDR : 'none'} to DR-${newDR}`
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const {
      clientName,
      clientId: reqClientId,
      clientPurchaseOrderNumber,
      jobNumber,
      storageLocation,
      contactName,
      contactPhone,
      contactEmail,
      notes,
      receivedBy,
      requestedDueDate,
      promisedDate,
      status,
      pickedUpBy,
      signatureData,
      // Pricing fields
      truckingDescription,
      truckingCost,
      taxRate,
      // Minimum override
      minimumOverride,
      minimumOverrideReason
    } = req.body;

    // Helper to check if value was provided (including empty string)
    const getValue = (newVal, oldVal) => newVal !== undefined ? newVal : oldVal;
    
    // Helper for date fields - convert empty string to null
    const getDateValue = (newVal, oldVal) => {
      if (newVal === undefined) return oldVal;
      if (newVal === '' || newVal === null) return null;
      return newVal;
    };

    // Resolve clientId to clientName if needed
    let resolvedClientName = clientName;
    if (reqClientId !== undefined) {
      if (reqClientId) {
        const client = await Client.findByPk(reqClientId);
        if (client) resolvedClientName = client.name;
      }
    }

    // Handle status transitions
    const updates = {
      clientName: getValue(resolvedClientName, workOrder.clientName),
      clientId: reqClientId !== undefined ? (reqClientId || null) : workOrder.clientId,
      clientPurchaseOrderNumber: getValue(clientPurchaseOrderNumber, workOrder.clientPurchaseOrderNumber),
      jobNumber: getValue(jobNumber, workOrder.jobNumber),
      storageLocation: getValue(storageLocation, workOrder.storageLocation),
      contactName: getValue(contactName, workOrder.contactName),
      contactPhone: getValue(contactPhone, workOrder.contactPhone),
      contactEmail: getValue(contactEmail, workOrder.contactEmail),
      notes: getValue(notes, workOrder.notes),
      receivedBy: getValue(receivedBy, workOrder.receivedBy),
      requestedDueDate: getDateValue(requestedDueDate, workOrder.requestedDueDate),
      promisedDate: getDateValue(promisedDate, workOrder.promisedDate)
    };

    // Pricing fields
    if (truckingDescription !== undefined) updates.truckingDescription = truckingDescription || null;
    if (truckingCost !== undefined) updates.truckingCost = truckingCost || null;
    if (taxRate !== undefined) updates.taxRate = taxRate || null;
    if (minimumOverride !== undefined) updates.minimumOverride = minimumOverride;
    if (minimumOverrideReason !== undefined) updates.minimumOverrideReason = minimumOverrideReason || null;

    if (status) {
      updates.status = status;
      
      // Set timestamps based on status
      if (status === 'received' && !workOrder.receivedAt) {
        updates.receivedAt = new Date();
      }
      if (status === 'completed' && !workOrder.completedAt) {
        updates.completedAt = new Date();
      }
      if (status === 'picked_up') {
        updates.pickedUpAt = new Date();
        if (pickedUpBy) updates.pickedUpBy = pickedUpBy;
        if (signatureData) updates.signatureData = signatureData;
      }
    }

    await workOrder.update(updates);

    // Reload with parts
    const updatedOrder = await WorkOrder.findByPk(workOrder.id, {
      include: [{
        model: WorkOrderPart,
        as: 'parts',
        include: [{
          model: WorkOrderPartFile,
          as: 'files'
        }]
      }]
    });

    res.json({
      data: updatedOrder,
      message: 'Work order updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id - Delete work order
router.delete('/:id', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    // Support both UUID and orderNumber
    const idParam = req.params.id;
    let workOrder;
    
    // Check if it's a UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(idParam)) {
      workOrder = await WorkOrder.findByPk(idParam, {
        include: [
          { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
          { model: WorkOrderDocument, as: 'documents' }
        ],
        transaction
      });
    } else {
      // Try to find by orderNumber or drNumber
      workOrder = await WorkOrder.findOne({
        where: idParam.startsWith('DR-') 
          ? { drNumber: parseInt(idParam.replace('DR-', '')) }
          : { orderNumber: idParam },
        include: [
          { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
          { model: WorkOrderDocument, as: 'documents' }
        ],
        transaction
      });
    }

    if (!workOrder) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    console.log('Deleting work order:', workOrder.id);

    // FIRST: Clear ALL foreign key references before deleting anything
    console.log('Clearing DR number references...');
    await DRNumber.update(
      { workOrderId: null }, 
      { where: { workOrderId: workOrder.id }, transaction }
    );
    
    console.log('Clearing PO number references...');
    await PONumber.update(
      { workOrderId: null }, 
      { where: { workOrderId: workOrder.id }, transaction }
    );
    
    console.log('Clearing estimate references...');
    await Estimate.update(
      { workOrderId: null, status: 'accepted' }, 
      { where: { workOrderId: workOrder.id }, transaction }
    );

    // Get inbound order IDs from parts before deleting
    const inboundOrderIds = workOrder.parts
      .filter(p => p.inboundOrderId)
      .map(p => p.inboundOrderId);

    // Delete files from Cloudinary (outside transaction - best effort)
    for (const part of workOrder.parts || []) {
      for (const file of part.files || []) {
        if (file.cloudinaryId) {
          try {
            await cloudinary.uploader.destroy(file.cloudinaryId, { resource_type: 'raw' });
          } catch (e) {
            console.error('Failed to delete from Cloudinary:', e);
          }
        }
      }
    }

    // Delete documents from Cloudinary
    for (const doc of workOrder.documents || []) {
      if (doc.cloudinaryId) {
        try {
          await cloudinary.uploader.destroy(doc.cloudinaryId, { resource_type: 'raw' });
        } catch (e) {
          console.error('Failed to delete document from Cloudinary:', e);
        }
      }
    }

    // Delete documents
    console.log('Deleting documents...');
    await WorkOrderDocument.destroy({ where: { workOrderId: workOrder.id }, transaction });

    // Delete part files
    console.log('Deleting part files...');
    for (const part of workOrder.parts || []) {
      await WorkOrderPartFile.destroy({ where: { workOrderPartId: part.id }, transaction });
    }
    
    // Delete parts
    console.log('Deleting parts...');
    await WorkOrderPart.destroy({ where: { workOrderId: workOrder.id }, transaction });

    // Delete associated inbound orders
    if (inboundOrderIds.length > 0) {
      console.log('Deleting inbound orders:', inboundOrderIds);
      // First clear PO references to these inbound orders
      await PONumber.update(
        { inboundOrderId: null },
        { where: { inboundOrderId: inboundOrderIds }, transaction }
      );
      await InboundOrder.destroy({ where: { id: inboundOrderIds }, transaction });
    }

    // Finally delete the work order
    console.log('Deleting work order record...');
    await workOrder.destroy({ transaction });

    await transaction.commit();
    console.log('Work order deleted successfully');

    res.json({ message: 'Work order deleted successfully' });
  } catch (error) {
    await transaction.rollback();
    console.error('Delete work order error:', error);
    next(error);
  }
});

// ============= PARTS ROUTES =============

// POST /api/workorders/:id/parts - Add a part to work order
router.post('/:id/parts', async (req, res, next) => {
  try {
    console.log('Adding part to work order:', req.params.id);
    console.log('Part data:', JSON.stringify(req.body, null, 2));
    
    const workOrder = await WorkOrder.findByPk(req.params.id);

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Get the next part number
    const existingParts = await WorkOrderPart.count({ where: { workOrderId: workOrder.id } });
    const partNumber = existingParts + 1;

    // Clean numeric fields - convert empty strings to null
    const numericFields = ['laborRate', 'laborHours', 'laborTotal', 'materialUnitCost', 
                          'materialTotal', 'setupCharge', 'otherCharges', 'partTotal'];
    const cleanedData = cleanNumericFields(req.body, numericFields);
    
    // Extract underscore-prefixed fields into formData JSONB
    const extracted = extractFormData(req.body);
    const formDataJson = extracted.formData || null;

    const {
      partType,
      clientPartNumber,
      heatNumber,
      quantity,
      material,
      thickness,
      width,
      length,
      outerDiameter,
      innerDiameter,
      wallThickness,
      rollType,
      radius,
      diameter,
      arcLength,
      arcDegrees,
      sectionSize,
      flangeOut,
      specialInstructions,
      // Material source fields
      materialSource,
      vendorId,
      supplierName,
      materialDescription
    } = req.body;

    if (!partType) {
      return res.status(400).json({ error: { message: 'Part type is required' } });
    }

    // Resolve vendor name from vendorId for backwards compat
    let resolvedVendorId = vendorId || null;
    let resolvedSupplierName = supplierName || null;
    if (resolvedVendorId) {
      const vendor = await Vendor.findByPk(resolvedVendorId);
      if (vendor) resolvedSupplierName = vendor.name;
    }

    console.log('Creating part with vendorId:', resolvedVendorId, 'supplierName:', resolvedSupplierName);

    const part = await WorkOrderPart.create({
      workOrderId: workOrder.id,
      partNumber,
      partType,
      clientPartNumber,
      heatNumber,
      quantity: quantity || 1,
      material,
      thickness,
      width,
      length,
      outerDiameter,
      innerDiameter,
      wallThickness,
      rollType: rollType || null,
      radius,
      diameter,
      arcLength,
      arcDegrees,
      sectionSize,
      flangeOut: flangeOut || false,
      specialInstructions,
      // Material source fields
      materialSource: materialSource || 'customer_supplied',
      vendorId: resolvedVendorId,
      supplierName: resolvedSupplierName,
      materialDescription: materialDescription || null,
      // Form display data
      formData: formDataJson,
      // Pricing fields - use cleaned values
      laborRate: cleanedData.laborRate,
      laborHours: cleanedData.laborHours,
      laborTotal: cleanedData.laborTotal,
      materialUnitCost: cleanedData.materialUnitCost,
      materialTotal: cleanedData.materialTotal,
      setupCharge: cleanedData.setupCharge,
      otherCharges: cleanedData.otherCharges,
      partTotal: cleanedData.partTotal
    });

    console.log('Created part:', part.id, 'vendorId:', part.vendorId);

    // Reload with files
    const createdPart = await WorkOrderPart.findByPk(part.id, {
      include: [{
        model: WorkOrderPartFile,
        as: 'files'
      }]
    });

    res.status(201).json({
      data: createdPart,
      message: 'Part added successfully'
    });
  } catch (error) {
    console.error('Add work order part error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to add part' } });
  }
});

// PUT /api/workorders/:id/parts/:partId - Update a part
router.put('/:id/parts/:partId', async (req, res, next) => {
  try {
    const part = await WorkOrderPart.findOne({
      where: {
        id: req.params.partId,
        workOrderId: req.params.id
      }
    });

    if (!part) {
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    // Clean numeric fields - convert empty strings to null
    const numericFields = ['laborRate', 'laborHours', 'laborTotal', 'materialUnitCost', 
                          'materialTotal', 'setupCharge', 'otherCharges', 'partTotal'];
    const cleanedData = cleanNumericFields(req.body, numericFields);
    
    // Extract underscore-prefixed fields into formData JSONB
    const extractedUpdate = extractFormData(req.body);
    const formDataJson = extractedUpdate.formData || null;

    const {
      partType,
      clientPartNumber,
      heatNumber,
      quantity,
      material,
      thickness,
      width,
      length,
      outerDiameter,
      innerDiameter,
      wallThickness,
      rollType,
      radius,
      diameter,
      arcLength,
      arcDegrees,
      sectionSize,
      flangeOut,
      specialInstructions,
      operatorNotes,
      status,
      completedBy,
      // Material source fields
      materialSource,
      vendorId,
      supplierName,
      materialDescription
    } = req.body;

    const updates = {};
    if (partType !== undefined) updates.partType = partType;
    if (clientPartNumber !== undefined) updates.clientPartNumber = clientPartNumber;
    if (heatNumber !== undefined) updates.heatNumber = heatNumber;
    if (quantity !== undefined) updates.quantity = quantity;
    if (material !== undefined) updates.material = material;
    if (thickness !== undefined) updates.thickness = thickness;
    if (width !== undefined) updates.width = width;
    if (length !== undefined) updates.length = length;
    if (outerDiameter !== undefined) updates.outerDiameter = outerDiameter;
    if (innerDiameter !== undefined) updates.innerDiameter = innerDiameter;
    if (wallThickness !== undefined) updates.wallThickness = wallThickness;
    if (rollType !== undefined) updates.rollType = rollType || null;
    if (radius !== undefined) updates.radius = radius;
    if (diameter !== undefined) updates.diameter = diameter;
    if (arcLength !== undefined) updates.arcLength = arcLength;
    if (arcDegrees !== undefined) updates.arcDegrees = arcDegrees;
    if (sectionSize !== undefined) updates.sectionSize = sectionSize;
    if (flangeOut !== undefined) updates.flangeOut = flangeOut;
    if (specialInstructions !== undefined) updates.specialInstructions = specialInstructions;
    if (operatorNotes !== undefined) updates.operatorNotes = operatorNotes;
    
    // Material source fields - vendorId is primary, supplierName kept in sync
    if (materialSource !== undefined) updates.materialSource = materialSource;
    if (vendorId !== undefined) {
      updates.vendorId = vendorId || null;
      if (vendorId) {
        const vendor = await Vendor.findByPk(vendorId);
        if (vendor) updates.supplierName = vendor.name;
      } else {
        updates.supplierName = null;
      }
    }
    if (materialDescription !== undefined) updates.materialDescription = materialDescription;
    
    // Update formData if underscore-prefixed fields were sent
    if (formDataJson) {
      updates.formData = formDataJson;
    }
    
    // Pricing fields - use cleaned values
    if (cleanedData.laborRate !== undefined) updates.laborRate = cleanedData.laborRate;
    if (cleanedData.laborHours !== undefined) updates.laborHours = cleanedData.laborHours;
    if (cleanedData.laborTotal !== undefined) updates.laborTotal = cleanedData.laborTotal;
    if (cleanedData.materialUnitCost !== undefined) updates.materialUnitCost = cleanedData.materialUnitCost;
    if (cleanedData.materialTotal !== undefined) updates.materialTotal = cleanedData.materialTotal;
    if (cleanedData.setupCharge !== undefined) updates.setupCharge = cleanedData.setupCharge;
    if (cleanedData.otherCharges !== undefined) updates.otherCharges = cleanedData.otherCharges;
    if (cleanedData.partTotal !== undefined) updates.partTotal = cleanedData.partTotal;
    
    if (status !== undefined) {
      updates.status = status;
      if (status === 'completed' && !part.completedAt) {
        updates.completedAt = new Date();
        if (completedBy) updates.completedBy = completedBy;
      }
    }

    await part.update(updates);

    // Reload with files
    const updatedPart = await WorkOrderPart.findByPk(part.id, {
      include: [{
        model: WorkOrderPartFile,
        as: 'files'
      }]
    });

    res.json({
      data: updatedPart,
      message: 'Part updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id/parts/:partId - Delete a part
router.delete('/:id/parts/:partId', async (req, res, next) => {
  try {
    const part = await WorkOrderPart.findOne({
      where: {
        id: req.params.partId,
        workOrderId: req.params.id
      },
      include: [{
        model: WorkOrderPartFile,
        as: 'files'
      }]
    });

    if (!part) {
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    // Delete files from Cloudinary
    for (const file of part.files) {
      if (file.cloudinaryId) {
        try {
          await cloudinary.uploader.destroy(file.cloudinaryId, { resource_type: 'raw' });
        } catch (e) {
          console.error('Failed to delete from Cloudinary:', e);
        }
      }
    }

    await part.destroy();

    // Renumber remaining parts
    const remainingParts = await WorkOrderPart.findAll({
      where: { workOrderId: req.params.id },
      order: [['partNumber', 'ASC']]
    });

    for (let i = 0; i < remainingParts.length; i++) {
      if (remainingParts[i].partNumber !== i + 1) {
        await remainingParts[i].update({ partNumber: i + 1 });
      }
    }

    res.json({ message: 'Part deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// ============= FILE ROUTES =============

// POST /api/workorders/:id/parts/:partId/files - Upload files to a part
router.post('/:id/parts/:partId/files', upload.array('files', 10), async (req, res, next) => {
  const tempFiles = [];
  
  try {
    const part = await WorkOrderPart.findOne({
      where: {
        id: req.params.partId,
        workOrderId: req.params.id
      }
    });

    if (!part) {
      req.files?.forEach(file => cleanupTempFile(file.path));
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: { message: 'No files uploaded' } });
    }

    tempFiles.push(...req.files.map(f => f.path));

    const files = await Promise.all(
      req.files.map(async (file) => {
        // Determine file type
        const ext = path.extname(file.originalname).toLowerCase();
        let fileType = 'other';
        if (ext === '.pdf') fileType = 'pdf_print';
        else if (ext === '.stp' || ext === '.step') fileType = 'step_file';

        // Upload to Cloudinary
        const cloudinaryResult = await cloudinary.uploader.upload(file.path, {
          folder: `work-orders/${req.params.id}/parts/${req.params.partId}`,
          resource_type: 'raw',
          type: 'private',
          use_filename: true,
          unique_filename: true
        });

        // Create database record
        const partFile = await WorkOrderPartFile.create({
          workOrderPartId: part.id,
          fileType,
          filename: file.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: cloudinaryResult.secure_url,
          cloudinaryId: cloudinaryResult.public_id
        });

        cleanupTempFile(file.path);
        return partFile;
      })
    );

    res.status(201).json({
      data: files,
      message: `${files.length} file(s) uploaded successfully`
    });
  } catch (error) {
    console.error('File upload error:', error);
    tempFiles.forEach(cleanupTempFile);
    next(error);
  }
});

// GET /api/workorders/:id/parts/:partId/files/:fileId/signed-url - Get working URL for file
router.get('/:id/parts/:partId/files/:fileId/signed-url', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // Return the download proxy URL - it handles resource_type resolution
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/api/workorders/${req.params.id}/parts/${req.params.partId}/files/${req.params.fileId}/download`;
    
    res.json({
      data: { url, expiresIn: null, originalName: file.originalName || file.filename }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id/parts/:partId/files/:fileId - Delete a file

// GET /api/workorders/:id/parts/:partId/files/:fileId/debug - Debug file URL resolution
router.get('/:id/parts/:partId/files/:fileId/debug', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });
    if (!file) return res.status(404).json({ error: 'File not found in DB' });

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const pubId = file.cloudinaryId;
    const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';
    const versionMatch = file.url?.match(/\/v(\d+)\//);
    const version = versionMatch ? `/v${versionMatch[1]}` : '';

    const urlsToTest = [];
    
    // Signed URLs for private files
    if (pubId && cloudName) {
      try {
        const signedUrl = cloudinary.url(pubId, { resource_type: 'raw', type: 'private', sign_url: true, secure: true });
        urlsToTest.push({ label: 'signed-private', url: signedUrl });
      } catch (e) { urlsToTest.push({ label: 'signed-private', url: 'GENERATION_FAILED: ' + e.message }); }
      
      try {
        const hasExt = pubId.match(/\.\w+$/);
        const format = hasExt ? hasExt[0].replace('.', '') : ext.replace('.', '');
        const dlUrl = cloudinary.utils.private_download_url(pubId, format, { resource_type: 'raw', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        urlsToTest.push({ label: 'private-download', url: dlUrl });
      } catch (e) { urlsToTest.push({ label: 'private-download', url: 'GENERATION_FAILED: ' + e.message }); }
    }
    
    if (file.url) urlsToTest.push({ label: 'stored', url: file.url });
    if (pubId && cloudName) {
      urlsToTest.push({ label: 'raw+ver+ext', url: `https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}${ext}` });
      urlsToTest.push({ label: 'raw+ver', url: `https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}` });
      urlsToTest.push({ label: 'image+ver+ext', url: `https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}${ext}` });
      urlsToTest.push({ label: 'image+ver', url: `https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}` });
    }

    // Test each URL with HEAD request
    const results = [];
    for (const { label, url } of urlsToTest) {
      if (url.startsWith('GENERATION_FAILED')) {
        results.push({ label, url, status: 'n/a' });
        continue;
      }
      const status = await new Promise(resolve => {
        const lib = url.startsWith('https') ? https : http;
        const request = lib.request(url, { method: 'HEAD' }, resp => {
          resp.resume();
          resolve(resp.statusCode);
        });
        request.on('error', (e) => resolve('error: ' + e.message));
        request.setTimeout(5000, () => { request.destroy(); resolve('timeout'); });
        request.end();
      });
      results.push({ label, url: url.substring(0, 150), status });
    }

    res.json({
      file: { id: file.id, cloudinaryId: pubId, storedUrl: file.url, originalName: file.originalName, mimeType: file.mimeType },
      cloudName,
      ext,
      version,
      results
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/:id/parts/:partId/files/:fileId/download - Stream file from Cloudinary
router.get('/:id/parts/:partId/files/:fileId/download', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // Build list of candidate URLs to try
    const urlsToTry = [];
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    
    if (file.cloudinaryId && cloudName) {
      const pubId = file.cloudinaryId;
      const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';
      
      // Work order files are uploaded as raw+private — generate signed URL
      try {
        const signedUrl = cloudinary.url(pubId, {
          resource_type: 'raw',
          type: 'private',
          sign_url: true,
          secure: true
        });
        urlsToTry.push(signedUrl);
      } catch (e) {
        console.error('[file-proxy] Failed to generate signed URL:', e.message);
      }
      
      // Also try authenticated download URL
      try {
        // For raw private, strip extension from pubId for format param
        const hasExt = pubId.match(/\.\w+$/);
        const cleanId = hasExt ? pubId : pubId;
        const format = hasExt ? hasExt[0].replace('.', '') : ext.replace('.', '');
        const signedDownload = cloudinary.utils.private_download_url(cleanId, format, {
          resource_type: 'raw',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        });
        urlsToTry.push(signedDownload);
      } catch (e) {
        console.error('[file-proxy] Failed to generate download URL:', e.message);
      }
    }
    
    // Try stored URL
    if (file.url) urlsToTry.push(file.url);
    
    // Try public URL variants as fallback (for files that were copied from estimates)
    if (file.cloudinaryId && cloudName) {
      const pubId = file.cloudinaryId;
      const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';
      const versionMatch = file.url?.match(/\/v(\d+)\//);
      const version = versionMatch ? `/v${versionMatch[1]}` : '';
      
      urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}${ext}`);
      urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}`);
      urlsToTry.push(`https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}${ext}`);
      urlsToTry.push(`https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}`);
      if (version) {
        urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload/${pubId}${ext}`);
        urlsToTry.push(`https://res.cloudinary.com/${cloudName}/image/upload/${pubId}${ext}`);
      }
    }
    
    // Deduplicate
    const uniqueUrls = [...new Set(urlsToTry)];
    
    console.log(`[file-proxy] Trying ${uniqueUrls.length} URLs for WO file ${file.id} (${file.originalName})`);

    // Try each URL - stream the first one that works
    for (let i = 0; i < uniqueUrls.length; i++) {
      const url = uniqueUrls[i];
      const upstream = await fetchWithRedirects(url);
      if (upstream) {
        console.log(`[file-proxy] SUCCESS on attempt ${i + 1} for WO file ${file.id}`);
        const contentType = file.mimeType || upstream.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName || file.filename || 'file')}"`);
        
        upstream.pipe(res);
        return;
      } else {
        console.log(`[file-proxy] FAIL attempt ${i + 1}: ${url.substring(0, 120)}...`);
      }
    }
    
    console.error(`[file-proxy] ALL URLS FAILED for WO file ${file.id}. cloudinaryId=${file.cloudinaryId}, storedUrl=${file.url}`);
    res.status(404).json({ error: { message: 'File not accessible on storage' } });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/parts/:partId/files/:fileId', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: {
        id: req.params.fileId,
        workOrderPartId: req.params.partId
      }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // Delete from Cloudinary
    if (file.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(file.cloudinaryId, { resource_type: 'raw' });
      } catch (e) {
        console.error('Failed to delete from Cloudinary:', e);
      }
    }

    await file.destroy();

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// ============= SHIP AND ARCHIVE =============

// POST /api/workorders/:id/ship - Mark work order as shipped (auto-archives)
router.post('/:id/ship', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const { shippedBy, notes } = req.body;

    await workOrder.update({
      status: 'shipped',
      shippedAt: new Date()
    });

    // Log activity
    await logActivity(
      'shipped',
      'work_order',
      workOrder.id,
      workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber,
      workOrder.clientName,
      `${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber} shipped to ${workOrder.clientName}`,
      { shippedBy, notes }
    );

    // Also log inventory change
    await logActivity(
      'shipped',
      'inventory',
      workOrder.id,
      workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber,
      workOrder.clientName,
      `${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber} shipped to customer`
    );

    res.json({
      data: workOrder,
      message: `Work order ${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber} marked as shipped`
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/workorders/:id/archive - Manually archive a work order
router.post('/:id/archive', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    await workOrder.update({
      status: 'archived',
      archivedAt: new Date()
    });

    res.json({
      data: workOrder,
      message: 'Work order archived'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/archived - Get archived/shipped work orders
router.get('/archived', async (req, res, next) => {
  try {
    const { clientName, drNumber, limit = 50, offset = 0 } = req.query;
    
    const where = { status: { [Op.in]: ['archived', 'shipped', 'picked_up'] } };
    if (clientName) where.clientName = { [Op.iLike]: `%${clientName}%` };
    if (drNumber) where.drNumber = parseInt(drNumber);

    const workOrders = await WorkOrder.findAndCountAll({
      where,
      include: [
        { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }
      ],
      order: [['updatedAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Batch fetch shipment photos
    const workOrderIds = workOrders.rows.map(wo => wo.id);
    let shipmentPhotoMap = {};
    if (workOrderIds.length > 0) {
      try {
        const shipments = await Shipment.findAll({
          where: { workOrderId: { [Op.in]: workOrderIds } },
          include: [{ model: ShipmentPhoto, as: 'photos' }]
        });
        shipments.forEach(s => {
          if (s.photos && s.photos.length > 0) {
            shipmentPhotoMap[s.workOrderId] = s.photos[0].url;
          }
        });
      } catch (e) {
        console.error('Error fetching shipment photos for thumbnails:', e);
      }
    }

    const rowsWithThumbnails = workOrders.rows.map(wo => {
      const data = wo.toJSON();
      data.thumbnailUrl = shipmentPhotoMap[data.id] || null;
      return data;
    });

    res.json({
      data: rowsWithThumbnails,
      total: workOrders.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Archived workorders error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/duplicate-to-estimate - Create estimate from work order (for repeat orders)
router.post('/:id/duplicate-to-estimate', async (req, res, next) => {
  try {
    const { Estimate, EstimatePart } = require('../models');

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Generate estimate number
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const estimateNumber = `EST-${year}${month}${day}-${random}`;

    // Create new estimate — copy client info, clear pricing
    const newEstimate = await Estimate.create({
      estimateNumber,
      clientName: workOrder.clientName,
      contactName: workOrder.contactName,
      contactEmail: workOrder.contactEmail,
      contactPhone: workOrder.contactPhone,
      clientPurchaseOrderNumber: '',
      projectDescription: workOrder.notes || '',
      internalNotes: `Reorder from ${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber}`,
      taxRate: workOrder.taxRate,
      taxExempt: workOrder.taxExempt,
      status: 'draft'
    });

    // Copy parts — keep specs & labor, clear material pricing
    for (const origPart of (workOrder.parts || [])) {
      const partJson = origPart.toJSON();
      
      // Copy formData but clear material cost fields within it
      let formData = partJson.formData || {};
      if (typeof formData === 'string') {
        try { formData = JSON.parse(formData); } catch(e) { formData = {}; }
      }
      // Clear material pricing in formData
      if (formData.materialTotal) formData.materialTotal = '';
      if (formData.materialUnitCost) formData.materialUnitCost = '';

      await EstimatePart.create({
        estimateId: newEstimate.id,
        partNumber: partJson.partNumber,
        partType: partJson.partType,
        clientPartNumber: partJson.clientPartNumber,
        quantity: partJson.quantity,
        // Specs — keep these
        material: partJson.material,
        thickness: partJson.thickness,
        width: partJson.width,
        length: partJson.length,
        outerDiameter: partJson.outerDiameter,
        wallThickness: partJson.wallThickness,
        sectionSize: partJson.sectionSize,
        rollType: partJson.rollType,
        radius: partJson.radius,
        diameter: partJson.diameter,
        arcDegrees: partJson.arcDegrees,
        flangeOut: partJson.flangeOut,
        specialInstructions: partJson.specialInstructions,
        materialDescription: partJson.materialDescription,
        materialSource: partJson.materialSource,
        supplierName: partJson.supplierName,
        // Labor — keep
        laborTotal: partJson.laborTotal,
        rollingCost: partJson.rollingCost,
        // Material pricing — CLEAR for requoting
        materialUnitCost: 0,
        materialTotal: 0,
        materialMarkupPercent: partJson.materialMarkupPercent || 0,
        otherServicesCost: partJson.otherServicesCost || 0,
        otherServicesMarkupPercent: partJson.otherServicesMarkupPercent || 0,
        // Part total = labor only (material cleared)
        partTotal: partJson.laborTotal || 0,
        // formData — keep all part-specific settings (roll specs, etc.)
        formData
      });
    }

    // Reload with parts
    const createdEstimate = await Estimate.findByPk(newEstimate.id, {
      include: [{ model: EstimatePart, as: 'parts' }]
    });

    res.status(201).json({
      data: createdEstimate,
      message: `Estimate ${estimateNumber} created from ${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber} — material pricing cleared for requoting`
    });
  } catch (error) {
    next(error);
  }
});

// ==================== WORK ORDER DOCUMENTS ====================

// Configure multer for document uploads
const documentUpload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB for documents
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. PDF, images, and Word documents are allowed.'));
    }
  }
});

// POST /api/workorders/:id/documents - Upload documents to work order
router.post('/:id/documents', documentUpload.array('documents', 10), async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: { message: 'No files uploaded' } });
    }

    const documents = [];
    for (const file of req.files) {
      try {
        // Upload to Cloudinary
        const result = await cloudinary.uploader.upload(file.path, {
          folder: `work-orders/${workOrder.id}/documents`,
          resource_type: 'auto',
          access_mode: 'authenticated'
        });

        // Create document record
        const document = await WorkOrderDocument.create({
          workOrderId: workOrder.id,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: result.secure_url,
          cloudinaryId: result.public_id
        });

        documents.push(document);

        // Clean up temp file
        fs.unlinkSync(file.path);
      } catch (uploadError) {
        console.error('Document upload error:', uploadError);
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      }
    }

    res.status(201).json({
      data: documents,
      message: `${documents.length} document(s) uploaded successfully`
    });
  } catch (error) {
    // Clean up any remaining temp files
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      });
    }
    next(error);
  }
});

// GET /api/workorders/:id/documents/:documentId/signed-url - Get signed URL for document
router.get('/:id/documents/:documentId/signed-url', async (req, res, next) => {
  try {
    const document = await WorkOrderDocument.findOne({
      where: { 
        id: req.params.documentId,
        workOrderId: req.params.id
      }
    });

    if (!document) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }

    // Return the download proxy URL (same pattern as part files)
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/api/workorders/${req.params.id}/documents/${req.params.documentId}/download`;
    
    res.json({ data: { url, originalName: document.originalName || document.filename } });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/:id/documents/:documentId/download - Stream document from Cloudinary
router.get('/:id/documents/:documentId/download', async (req, res, next) => {
  try {
    const document = await WorkOrderDocument.findOne({
      where: { 
        id: req.params.documentId,
        workOrderId: req.params.id
      }
    });

    if (!document) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }

    // Build list of candidate URLs to try
    const urlsToTry = [];
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    
    // Try stored URL first — it came directly from Cloudinary upload response
    if (document.url) urlsToTry.push(document.url);
    
    if (document.cloudinaryId && cloudName) {
      const pubId = document.cloudinaryId;
      const hasPdfExt = pubId.toLowerCase().endsWith('.pdf');
      
      if (hasPdfExt) {
        urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload/${pubId}`);
        urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload/${pubId.replace(/\.pdf$/i, '')}`);
      } else {
        urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload/${pubId}.pdf`);
        urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload/${pubId}`);
      }
      
      try { urlsToTry.push(cloudinary.url(pubId, { resource_type: 'raw', type: 'private', sign_url: true, secure: true })); } catch (e) {}
      if (hasPdfExt) {
        try { urlsToTry.push(cloudinary.url(pubId.replace(/\.pdf$/i, ''), { resource_type: 'raw', type: 'private', sign_url: true, secure: true })); } catch (e) {}
      }
      try { urlsToTry.push(cloudinary.url(pubId, { resource_type: 'raw', sign_url: true, secure: true })); } catch (e) {}
      
      const versionMatch = document.url?.match(/\/v(\d+)\//);
      const version = versionMatch ? `/v${versionMatch[1]}` : '';
      if (version) {
        if (hasPdfExt) {
          urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}`);
          urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId.replace(/\.pdf$/i, '')}`);
        } else {
          urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}.pdf`);
          urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}`);
        }
      }
    }
    
    const uniqueUrls = [...new Set(urlsToTry)];
    
    console.log(`[doc-proxy] Trying ${uniqueUrls.length} URLs for document ${document.id} (${document.originalName}), stored url: ${document.url || 'NULL'}`);

    // Try each URL - stream the first one that works
    for (let i = 0; i < uniqueUrls.length; i++) {
      const url = uniqueUrls[i];
      console.log(`[doc-proxy] Attempt ${i + 1}: ${url.substring(0, 120)}...`);
      const upstream = await fetchWithRedirects(url);
      if (upstream) {
        console.log(`[doc-proxy] SUCCESS on attempt ${i + 1} for document ${document.id}`);
        const contentType = document.mimeType || upstream.headers['content-type'] || 'application/pdf';
        res.setHeader('Content-Type', contentType);
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.originalName || 'document.pdf')}"`);
        upstream.pipe(res);
        return;
      }
    }

    // FALLBACK: If this is a purchase order, regenerate the PDF on the fly
    if (document.documentType === 'purchase_order') {
      console.log(`[doc-proxy] All URLs failed — regenerating PO PDF on the fly for document ${document.id}`);
      try {
        const workOrder = await WorkOrder.findByPk(req.params.id, {
          include: [{ model: WorkOrderPart, as: 'parts' }]
        });
        if (workOrder) {
          const poMatch = document.originalName?.match(/^(PO\d+)/);
          const poNumber = poMatch ? poMatch[1] : 'PO0000';
          const supplierMatch = document.originalName?.match(/^PO\d+\s*-\s*(.+?)\.pdf$/i);
          let supplier = supplierMatch ? supplierMatch[1].trim() : 'Unknown Supplier';
          
          // Try to find actual vendor name from parts
          const poParts = workOrder.parts.filter(p => p.materialPurchaseOrderNumber === poNumber);
          if (poParts.length > 0 && poParts[0].vendorId) {
            const vendor = await Vendor.findByPk(poParts[0].vendorId);
            if (vendor) supplier = vendor.name;
          }
          const partsForPdf = poParts.length > 0 ? poParts : workOrder.parts;

          const pdfBuffer = await generatePurchaseOrderPDF(poNumber, supplier, partsForPdf, workOrder);
          
          console.log(`[doc-proxy] Regenerated ${poNumber} on the fly (${pdfBuffer.length} bytes)`);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Length', pdfBuffer.length);
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.originalName || 'PO.pdf')}"`);
          res.send(pdfBuffer);
          
          // Re-upload to Cloudinary in the background so next time it works from cache
          setImmediate(async () => {
            try {
              const uploadResult = await new Promise((resolve, reject) => {
                cloudinary.uploader.upload_stream(
                  { folder: 'purchase-orders', resource_type: 'raw', public_id: `${poNumber}-${workOrder.drNumber}`, format: 'pdf', overwrite: true },
                  (error, result) => { if (error) reject(error); else resolve(result); }
                ).end(pdfBuffer);
              });
              await document.update({ url: uploadResult.secure_url, cloudinaryId: uploadResult.public_id, size: pdfBuffer.length });
              console.log(`[doc-proxy] Background re-upload success: ${uploadResult.secure_url}`);
            } catch (uploadErr) {
              console.error(`[doc-proxy] Background re-upload failed:`, uploadErr.message);
            }
          });
          return;
        }
      } catch (regenErr) {
        console.error(`[doc-proxy] Fallback regeneration failed:`, regenErr.message);
      }
    }

    console.error(`[doc-proxy] ALL URLs failed for document ${document.id}, no fallback available`);
    res.status(502).json({ 
      error: { message: 'Unable to retrieve document from storage.' },
      debug: { urlsTried: uniqueUrls.length, cloudinaryId: document.cloudinaryId, storedUrl: document.url ? 'present' : 'NULL' }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id/documents/:documentId - Delete document
router.delete('/:id/documents/:documentId', async (req, res, next) => {
  try {
    const document = await WorkOrderDocument.findOne({
      where: { 
        id: req.params.documentId,
        workOrderId: req.params.id
      }
    });

    if (!document) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }

    // Delete from Cloudinary
    if (document.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(document.cloudinaryId, { resource_type: 'raw' });
      } catch (e) {
        console.error('Failed to delete from Cloudinary:', e);
      }
    }

    await document.destroy();

    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// POST /api/workorders/:id/documents/:documentId/regenerate - Regenerate a purchase order PDF
router.post('/:id/documents/:documentId/regenerate', async (req, res, next) => {
  try {
    const doc = await WorkOrderDocument.findOne({
      where: { id: req.params.documentId, workOrderId: req.params.id }
    });
    if (!doc) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }
    if (doc.documentType !== 'purchase_order') {
      return res.status(400).json({ error: { message: 'Only purchase order PDFs can be regenerated' } });
    }

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Extract PO number from doc name (e.g. "PO7808 - Supplier Name.pdf" → "PO7808")
    const poMatch = doc.originalName?.match(/^(PO\d+)/);
    const poNumber = poMatch ? poMatch[1] : 'PO0000';

    // Find parts linked to this PO
    const poParts = workOrder.parts.filter(p => p.materialPurchaseOrderNumber === poNumber);
    
    // Determine supplier from doc name or parts
    const supplierMatch = doc.originalName?.match(/^PO\d+\s*-\s*(.+?)\.pdf$/i);
    let supplier = supplierMatch ? supplierMatch[1].trim() : 'Unknown Supplier';
    if (poParts.length > 0 && poParts[0].vendorId) {
      const vendor = await Vendor.findByPk(poParts[0].vendorId);
      if (vendor) supplier = vendor.name;
    }

    // Use all parts if none matched the PO number (fallback)
    const partsForPdf = poParts.length > 0 ? poParts : workOrder.parts;

    console.log(`[regenerate-po] Regenerating ${poNumber} for ${supplier} (${partsForPdf.length} parts)`);

    // Generate PDF
    const pdfBuffer = await generatePurchaseOrderPDF(poNumber, supplier, partsForPdf, workOrder);

    // Delete old Cloudinary file
    if (doc.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(doc.cloudinaryId, { resource_type: 'raw' });
      } catch (e) {
        console.error('[regenerate-po] Failed to delete old file:', e.message);
      }
    }

    // Upload new PDF — use public_id without format to avoid .pdf.pdf
    const uploadResult = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: 'purchase-orders',
          resource_type: 'raw',
          public_id: `${poNumber}-${workOrder.drNumber}`,
          format: 'pdf',
          overwrite: true,
          invalidate: true
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(pdfBuffer);
    });

    // Update document record
    await doc.update({
      url: uploadResult.secure_url,
      cloudinaryId: uploadResult.public_id,
      size: pdfBuffer.length
    });

    console.log(`[regenerate-po] Success — new URL: ${uploadResult.secure_url}`);

    res.json({ 
      message: 'Purchase order PDF regenerated successfully',
      data: { url: uploadResult.secure_url, cloudinaryId: uploadResult.public_id }
    });
  } catch (error) {
    console.error('[regenerate-po] Error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/print-package - Render work order HTML + merge part PDFs into one complete document
// Body: { html: string, mode: 'production' | 'full' }
router.post('/:id/print-package', async (req, res, next) => {
  try {
    const puppeteer = require('puppeteer-core');
    const { execSync } = require('child_process');
    const mode = req.body.mode || 'production';
    const workOrderHtml = req.body.html;

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [
        { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
        { model: WorkOrderDocument, as: 'documents' }
      ]
    });

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    console.log(`[print-package] Building ${mode} package for WO ${workOrder.id}, HTML: ${workOrderHtml ? workOrderHtml.length + ' chars' : 'none'}`);

    // ─── Step 1: Render work order HTML to PDF via Puppeteer ───
    let woPagesPdf = null;
    if (workOrderHtml) {
      try {
        // Find Chrome
        let chromePath;
        if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
          chromePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        } else {
          const candidates = [
            '/app/.chrome-for-testing/chrome-linux64/chrome',
            '/app/.chrome-for-testing/chrome-linux/chrome',
            '/app/.apt/usr/bin/google-chrome',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
          ];
          for (const p of candidates) { if (fs.existsSync(p)) { chromePath = p; break; } }
          if (!chromePath) {
            try {
              const found = execSync('which chrome google-chrome chromium 2>/dev/null || find /app -name "chrome" -type f 2>/dev/null | head -1').toString().trim();
              if (found) chromePath = found.split('\n')[0];
            } catch (e) {}
          }
        }

        if (chromePath) {
          console.log(`[print-package] Rendering HTML with Chrome: ${chromePath}`);
          const browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
          });
          const page = await browser.newPage();
          await page.setContent(workOrderHtml, { waitUntil: 'load', timeout: 15000 });
          woPagesPdf = await page.pdf({
            format: 'Letter',
            margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' },
            printBackground: true
          });
          await browser.close();
          console.log(`[print-package] Rendered work order HTML → ${woPagesPdf.length} bytes`);
        } else {
          console.warn('[print-package] Chrome not found — skipping HTML render');
        }
      } catch (renderErr) {
        console.error('[print-package] HTML render failed:', renderErr.message);
      }
    }

    // ─── Step 2: Collect attached PDFs ───
    const port = process.env.PORT || 5001;
    const baseUrl = `http://localhost:${port}/api/workorders/${workOrder.id}`;
    const pdfSources = [];

    // Part PDFs (both modes)
    const sortedParts = (workOrder.parts || []).sort((a, b) => a.partNumber - b.partNumber);
    for (const part of sortedParts) {
      const pdfFiles = (part.files || []).filter(f => 
        f.mimeType === 'application/pdf' || (f.originalName || '').toLowerCase().endsWith('.pdf')
      );
      for (const file of pdfFiles) {
        pdfSources.push({ 
          label: `Part ${part.partNumber}: ${file.originalName}`,
          proxyUrl: `${baseUrl}/parts/${part.id}/files/${file.id}/download`
        });
      }
    }

    // Full mode: add order documents and purchase orders
    if (mode === 'full' && workOrder.documents) {
      for (const doc of workOrder.documents.filter(d => d.documentType !== 'purchase_order')) {
        if (doc.mimeType === 'application/pdf' || (doc.originalName || '').toLowerCase().endsWith('.pdf')) {
          pdfSources.push({
            label: `Doc: ${doc.originalName}`,
            proxyUrl: `${baseUrl}/documents/${doc.id}/download`
          });
        }
      }
      for (const doc of workOrder.documents.filter(d => d.documentType === 'purchase_order')) {
        pdfSources.push({
          label: `PO: ${doc.originalName}`,
          proxyUrl: `${baseUrl}/documents/${doc.id}/download`
        });
      }
    }

    console.log(`[print-package] Fetching ${pdfSources.length} attached PDFs...`);

    // ─── Step 3: Fetch attached PDFs via internal proxy ───
    const fetchPdfBuffer = (source) => {
      return new Promise((resolve) => {
        const url = source.proxyUrl;
        const options = { headers: {} };
        if (req.headers.cookie) options.headers.cookie = req.headers.cookie;
        if (req.headers.authorization) options.headers.authorization = req.headers.authorization;
        
        const request = http.get(url, options, (resp) => {
          if (resp.statusCode !== 200) {
            resp.resume();
            console.warn(`[print-package] Proxy returned ${resp.statusCode} for ${source.label}`);
            resolve(null);
            return;
          }
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length > 4 && buf.slice(0, 5).toString() === '%PDF-') {
              resolve(buf);
            } else {
              console.warn(`[print-package] Not a valid PDF for ${source.label} (${buf.length} bytes)`);
              resolve(null);
            }
          });
          resp.on('error', () => resolve(null));
        });
        request.on('error', (err) => {
          console.error(`[print-package] Fetch error for ${source.label}: ${err.message}`);
          resolve(null);
        });
        request.setTimeout(15000, () => { request.destroy(); resolve(null); });
      });
    };

    const attachedBuffers = await Promise.all(pdfSources.map(s => fetchPdfBuffer(s)));

    // ─── Step 4: Merge everything into one PDF ───
    const mergedPdf = await PDFLibDocument.create();
    let mergedCount = 0;

    // First: work order details pages
    if (woPagesPdf) {
      try {
        const woDoc = await PDFLibDocument.load(woPagesPdf, { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(woDoc, woDoc.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
        mergedCount++;
        console.log(`[print-package] Added work order details (${woDoc.getPageCount()} pages)`);
      } catch (e) {
        console.warn(`[print-package] Could not add work order pages: ${e.message}`);
      }
    }

    // Then: attached PDFs (part prints, docs, POs)
    for (let i = 0; i < attachedBuffers.length; i++) {
      if (!attachedBuffers[i]) {
        console.warn(`[print-package] Skipping ${pdfSources[i].label} — fetch failed`);
        continue;
      }
      try {
        const srcDoc = await PDFLibDocument.load(attachedBuffers[i], { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
        mergedCount++;
        console.log(`[print-package] Added ${pdfSources[i].label} (${srcDoc.getPageCount()} pages)`);
      } catch (pdfErr) {
        console.warn(`[print-package] Could not merge ${pdfSources[i].label}: ${pdfErr.message}`);
      }
    }

    if (mergedCount === 0) {
      return res.status(404).json({ error: { message: 'No content could be generated' } });
    }

    const mergedBytes = await mergedPdf.save();
    const drLabel = workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber;
    const filename = mode === 'full' 
      ? `${drLabel}_Full_Package.pdf`
      : `${drLabel}_Production_Package.pdf`;

    console.log(`[print-package] Complete! ${mergedCount} docs merged → ${mergedBytes.length} bytes (${filename})`);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': mergedBytes.length
    });
    res.send(Buffer.from(mergedBytes));
  } catch (error) {
    console.error('[print-package] FATAL Error:', error.message, error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'Print package generation failed: ' + error.message } });
    }
  }
});


// POST /api/workorders/:id/order-material - Create purchase orders for work order materials
router.post('/:id/order-material', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    if (!workOrder) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const { purchaseOrderNumber, partIds } = req.body;

    if (!purchaseOrderNumber) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'Purchase order number is required' } });
    }

    if (!partIds || partIds.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'At least one part must be selected' } });
    }

    // Get selected parts
    const selectedParts = workOrder.parts.filter(p => partIds.includes(p.id));
    
    if (selectedParts.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'No valid parts selected' } });
    }

    // Group parts by vendorId (fall back to supplierName for legacy data)
    const supplierGroups = {};
    for (const part of selectedParts) {
      let groupKey, vendorName, vId;
      if (part.vendorId) {
        const vendor = await Vendor.findByPk(part.vendorId, { transaction });
        groupKey = part.vendorId;
        vendorName = vendor ? vendor.name : 'Unknown Supplier';
        vId = part.vendorId;
      } else {
        groupKey = part.supplierName || 'Unknown Supplier';
        vendorName = groupKey;
        vId = null;
      }
      if (!supplierGroups[groupKey]) {
        supplierGroups[groupKey] = { vendorName, vendorId: vId, parts: [] };
      }
      supplierGroups[groupKey].parts.push(part);
    }

    const groupKeys = Object.keys(supplierGroups).sort();
    const createdOrders = [];
    const basePONumber = parseInt(purchaseOrderNumber);

    // Create inbound order for each supplier
    for (let i = 0; i < groupKeys.length; i++) {
      const group = supplierGroups[groupKeys[i]];
      const { vendorName: supplier, vendorId: vId, parts } = group;
      
      // Generate PO number - increment for each supplier
      const poNumber = basePONumber + i;
      const poNumberFormatted = `PO${poNumber}`;

      // Build description from parts
      const materialDescriptions = parts.map(p => 
        `Part ${p.partNumber}: ${p.materialDescription || p.partType} (Qty: ${p.quantity})`
      ).join('\n');

      // Create PONumber record
      try {
        const existingPO = await PONumber.findOne({ where: { poNumber: poNumber }, transaction });
        if (!existingPO) {
          await PONumber.create({
            poNumber: poNumber,
            status: 'active',
            supplier: supplier,
            vendorId: vId,
            workOrderId: workOrder.id,
            clientName: workOrder.clientName,
            description: materialDescriptions
          }, { transaction });
        }
      } catch (poError) {
        console.error('PO creation error:', poError.message);
      }

      // Create inbound order
      const inboundOrder = await InboundOrder.create({
        purchaseOrderNumber: poNumberFormatted,
        supplier: supplier,
        supplierName: supplier,
        vendorId: vId,
        description: materialDescriptions,
        clientName: workOrder.clientName,
        workOrderId: workOrder.id,
        status: 'pending',
        notes: `Material order for DR-${workOrder.drNumber}\nClient: ${workOrder.clientName}`
      }, { transaction });

      // Update PONumber record with inbound order ID
      try {
        await PONumber.update(
          { inboundOrderId: inboundOrder.id },
          { where: { poNumber: poNumber }, transaction }
        );
      } catch (updateError) {
        console.error('PO update error:', updateError.message);
      }

      createdOrders.push({
        inboundOrder,
        supplier,
        poNumber: poNumberFormatted,
        parts: parts.map(p => ({ id: p.id, partNumber: p.partNumber, description: p.materialDescription }))
      });

      // Update parts with PO info
      for (const part of parts) {
        await part.update({
          materialOrdered: true,
          materialPurchaseOrderNumber: poNumberFormatted,
          materialOrderedAt: new Date(),
          inboundOrderId: inboundOrder.id
        }, { transaction });
      }

      // Generate and upload PO PDF
      try {
        const pdfBuffer = await generatePurchaseOrderPDF(poNumberFormatted, supplier, parts, workOrder);
        
        // Upload to Cloudinary
        const uploadResult = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            {
              folder: 'purchase-orders',
              resource_type: 'raw',
              public_id: `${poNumberFormatted}-${workOrder.drNumber}`,
              format: 'pdf'
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          ).end(pdfBuffer);
        });

        // Save document record linked to work order
        await WorkOrderDocument.create({
          workOrderId: workOrder.id,
          originalName: `${poNumberFormatted} - ${supplier}.pdf`,
          mimeType: 'application/pdf',
          size: pdfBuffer.length,
          url: uploadResult.secure_url,
          cloudinaryId: uploadResult.public_id,
          documentType: 'purchase_order'
        }, { transaction });

        console.log(`Generated PO PDF: ${poNumberFormatted} for ${supplier}`);
      } catch (pdfError) {
        console.error('PDF generation error:', pdfError.message);
        // Continue even if PDF fails - the PO record is still created
      }
    }

    // Update next PO number setting
    const nextPO = basePONumber + groupKeys.length;
    await AppSettings.upsert({
      key: 'next_po_number',
      value: { nextNumber: nextPO }
    }, { transaction });

    await transaction.commit();

    // Log activity
    await logActivity(
      'created',
      'purchase_order',
      workOrder.id,
      `PO${basePONumber}`,
      workOrder.clientName,
      `Created ${createdOrders.length} PO(s) for DR-${workOrder.drNumber}`,
      { suppliers: groupKeys.map(k => supplierGroups[k].vendorName), partCount: selectedParts.length }
    );

    res.status(201).json({
      data: {
        purchaseOrders: createdOrders,
        totalOrders: createdOrders.length
      },
      message: `${createdOrders.length} purchase order(s) created`
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Order material error:', error);
    next(error);
  }
});

// ============= ESTIMATE LINKING =============

// GET /api/workorders/linkable-estimates - Search for estimates that can be linked
router.get('/linkable-estimates/search', async (req, res, next) => {
  try {
    const { EstimateLinkService } = require('../services/EstimateLinkService');
    const models = require('../models');
    const linkService = new (require('../services/EstimateLinkService'))(models);
    
    const estimates = await linkService.searchLinkableEstimates(req.query.q);
    
    res.json({
      data: estimates.map(est => ({
        id: est.id,
        estimateNumber: est.estimateNumber,
        clientName: est.clientName,
        contactName: est.contactName,
        projectDescription: est.projectDescription,
        status: est.status,
        grandTotal: est.grandTotal,
        partCount: est.parts?.length || 0,
        createdAt: est.createdAt
      }))
    });
  } catch (error) {
    console.error('Search linkable estimates error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/link-estimate - Link an estimate to this work order
router.post('/:id/link-estimate', async (req, res, next) => {
  try {
    const models = require('../models');
    const linkService = new (require('../services/EstimateLinkService'))(models);
    
    const { estimateId } = req.body;
    
    if (!estimateId) {
      return res.status(400).json({ error: { message: 'estimateId is required' } });
    }

    const result = await linkService.linkEstimateToWorkOrder(req.params.id, estimateId);
    
    res.json({
      data: result.workOrder,
      message: result.message,
      partsCopied: result.partsCopied
    });
  } catch (error) {
    console.error('Link estimate error:', error);
    if (error.message.includes('not found') || error.message.includes('already linked')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    next(error);
  }
});

// POST /api/workorders/:id/unlink-estimate - Unlink an estimate from this work order
router.post('/:id/unlink-estimate', async (req, res, next) => {
  try {
    const models = require('../models');
    const linkService = new (require('../services/EstimateLinkService'))(models);
    
    const result = await linkService.unlinkEstimate(req.params.id);
    
    res.json(result);
  } catch (error) {
    console.error('Unlink estimate error:', error);
    if (error.message.includes('No estimate linked')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    next(error);
  }
});

module.exports = router;
