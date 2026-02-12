const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const { Op } = require('sequelize');
const { WorkOrder, WorkOrderPart, WorkOrderPartFile, WorkOrderDocument, DailyActivity, DRNumber, InboundOrder, PONumber, AppSettings, Estimate, Vendor, Client, Shipment, ShipmentPhoto, sequelize } = require('../models');

const router = express.Router();

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
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      
      // Header
      doc.fontSize(24).font('Helvetica-Bold').text('PURCHASE ORDER', { align: 'center' });
      doc.moveDown(0.5);
      
      // PO Number
      doc.fontSize(16).fillColor('#1976d2').text(poNumber, { align: 'center' });
      doc.fillColor('black');
      doc.moveDown(1);
      
      // Company Info (left) and PO Info (right)
      const startY = doc.y;
      
      // From section
      doc.fontSize(10).font('Helvetica-Bold').text('FROM:', 50, startY);
      doc.font('Helvetica').text('Carolina Rolling, Inc.', 50, startY + 15);
      doc.text('Your Address Here', 50, startY + 28);
      doc.text('Phone: (xxx) xxx-xxxx', 50, startY + 41);
      
      // To section
      doc.font('Helvetica-Bold').text('TO:', 300, startY);
      doc.font('Helvetica').text(supplier, 300, startY + 15);
      
      // PO Details
      doc.font('Helvetica-Bold').text('DATE:', 450, startY);
      doc.font('Helvetica').text(new Date().toLocaleDateString(), 450, startY + 15);
      
      doc.y = startY + 70;
      doc.moveDown(1);
      
      // Reference info
      doc.fontSize(10).font('Helvetica-Bold').text('Reference Information', { underline: true });
      doc.moveDown(0.3);
      doc.font('Helvetica');
      doc.text(`Work Order: DR-${workOrder.drNumber}`);
      doc.text(`Client: ${workOrder.clientName}`);
      if (workOrder.clientPurchaseOrderNumber) {
        doc.text(`Client PO: ${workOrder.clientPurchaseOrderNumber}`);
      }
      doc.moveDown(1);
      
      // Items table header
      doc.font('Helvetica-Bold');
      const tableTop = doc.y;
      doc.rect(50, tableTop, 510, 20).fillAndStroke('#e3f2fd', '#1976d2');
      doc.fillColor('black');
      doc.text('Part #', 55, tableTop + 5);
      doc.text('Qty', 100, tableTop + 5);
      doc.text('Description', 140, tableTop + 5);
      
      // Items
      doc.font('Helvetica');
      let itemY = tableTop + 25;
      
      parts.forEach((part, index) => {
        const rowHeight = 40;
        
        // Alternate row colors
        if (index % 2 === 0) {
          doc.rect(50, itemY - 5, 510, rowHeight).fill('#f5f5f5');
        }
        doc.fillColor('black');
        
        doc.text(part.partNumber.toString(), 55, itemY);
        doc.text(part.quantity.toString(), 100, itemY);
        
        // Wrap description
        const description = part.materialDescription || part.partType || 'N/A';
        doc.text(description, 140, itemY, { width: 400 });
        
        itemY += rowHeight;
        
        // Check if we need a new page
        if (itemY > 700) {
          doc.addPage();
          itemY = 50;
        }
      });
      
      // Footer
      doc.moveDown(2);
      doc.fontSize(10).font('Helvetica-Bold').text('Notes:', 50);
      doc.font('Helvetica').text('Please reference the PO number on all correspondence and shipments.', 50);
      doc.moveDown(1);
      doc.text(`Material is for: ${workOrder.clientName} - DR-${workOrder.drNumber}`);
      
      // Signature line
      doc.moveDown(2);
      doc.text('_______________________________', 50);
      doc.text('Authorized Signature', 50);
      
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

    // Rewrite file URLs to use our download proxy (handles old resource_type mismatches)
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
    if (resolvedClientId && !resolvedClientName) {
      const client = await Client.findByPk(resolvedClientId);
      if (client) resolvedClientName = client.name;
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
    const completionNote = `✅ All ${workOrder.parts.length} part(s) completed from shop floor — ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
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

// GET /api/workorders/:id/parts/:partId/files/:fileId/signed-url - Get signed URL for file
router.get('/:id/parts/:partId/files/:fileId/signed-url', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    if (file.cloudinaryId) {
      // Try signed URL first (works for files uploaded as raw+private)
      try {
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        const signedUrl = cloudinary.utils.private_download_url(
          file.cloudinaryId,
          'raw',
          { resource_type: 'raw', expires_at: expiresAt, attachment: false }
        );

        // Verify it works with a HEAD request
        const https = require('https');
        const works = await new Promise((resolve) => {
          https.request(signedUrl, { method: 'HEAD' }, (resp) => {
            resolve(resp.statusCode === 200);
          }).on('error', () => resolve(false)).end();
        });

        if (works) {
          return res.json({
            data: { url: signedUrl, expiresIn: 3600, originalName: file.originalName || file.filename }
          });
        }
      } catch (e) {
        // signed URL failed, try public URLs
      }

      // Fallback for files copied from estimates (uploaded with resource_type: 'auto')
      const cloudName = cloudinary.config().cloud_name;
      const ext = (file.originalName || file.filename || '').split('.').pop() || '';
      const rawUrl = `https://res.cloudinary.com/${cloudName}/raw/upload/${file.cloudinaryId}`;
      const imageUrl = `https://res.cloudinary.com/${cloudName}/image/upload/${file.cloudinaryId}${ext ? '.' + ext : ''}`;

      const https = require('https');
      const checkUrl = (url) => new Promise((resolve) => {
        https.request(url, { method: 'HEAD' }, (resp) => {
          resolve(resp.statusCode === 200);
        }).on('error', () => resolve(false)).end();
      });

      if (await checkUrl(rawUrl)) {
        return res.json({ data: { url: rawUrl, expiresIn: null, originalName: file.originalName || file.filename } });
      }
      if (await checkUrl(imageUrl)) {
        return res.json({ data: { url: imageUrl, expiresIn: null, originalName: file.originalName || file.filename } });
      }
    }

    // Last resort: stored URL
    res.json({
      data: { url: file.url, expiresIn: null, originalName: file.originalName || file.filename }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id/parts/:partId/files/:fileId - Delete a file

// GET /api/workorders/:id/parts/:partId/files/:fileId/download - Redirect to working file URL
router.get('/:id/parts/:partId/files/:fileId/download', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    if (file.cloudinaryId) {
      const cloudName = cloudinary.config().cloud_name;
      const ext = (file.originalName || file.filename || '').split('.').pop() || '';
      const urls = [
        file.url,
        `https://res.cloudinary.com/${cloudName}/raw/upload/${file.cloudinaryId}`,
        `https://res.cloudinary.com/${cloudName}/image/upload/${file.cloudinaryId}${ext ? '.' + ext : ''}`
      ];

      const https = require('https');
      for (const url of urls) {
        const works = await new Promise((resolve) => {
          https.request(url, { method: 'HEAD' }, (resp) => {
            resolve(resp.statusCode === 200);
          }).on('error', () => resolve(false)).end();
        });
        if (works) return res.redirect(url);
      }
    }

    // Last resort
    return res.redirect(file.url);
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

// POST /api/workorders/:id/duplicate-to-estimate - Create estimate from archived work order
router.post('/:id/duplicate-to-estimate', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Return data needed to create estimate (actual creation happens in estimate route)
    const estimateData = {
      clientName: workOrder.clientName,
      contactName: workOrder.contactName,
      contactEmail: workOrder.contactEmail,
      contactPhone: workOrder.contactPhone,
      projectDescription: workOrder.notes,
      parts: workOrder.parts.map(p => ({
        partNumber: p.partNumber,
        partType: p.partType,
        clientPartNumber: p.clientPartNumber,
        quantity: p.quantity,
        material: p.material,
        thickness: p.thickness,
        width: p.width,
        length: p.length,
        outerDiameter: p.outerDiameter,
        wallThickness: p.wallThickness,
        sectionSize: p.sectionSize,
        rollType: p.rollType,
        radius: p.radius,
        diameter: p.diameter,
        arcDegrees: p.arcDegrees,
        flangeOut: p.flangeOut,
        specialInstructions: p.specialInstructions,
        materialSource: p.materialSource,
        materialDescription: p.materialDescription,
        supplierName: p.supplierName
      })),
      sourceWorkOrder: {
        id: workOrder.id,
        orderNumber: workOrder.orderNumber,
        drNumber: workOrder.drNumber
      }
    };

    res.json({
      data: estimateData,
      message: `Ready to create estimate from ${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber}`
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

    // For Cloudinary raw files (PDFs), just return the direct URL
    // Cloudinary signed URLs work differently for raw vs image resources
    if (document.url) {
      res.json({ data: { url: document.url } });
    } else if (document.cloudinaryId) {
      // Try to generate a download URL for raw files
      const downloadUrl = cloudinary.url(document.cloudinaryId, {
        resource_type: 'raw',
        flags: 'attachment'
      });
      res.json({ data: { url: downloadUrl } });
    } else {
      res.status(404).json({ error: { message: 'Document URL not available' } });
    }
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
