const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const { Op } = require('sequelize');
const { WorkOrder, WorkOrderPart, WorkOrderPartFile, WorkOrderDocument, DailyActivity, DRNumber, InboundOrder, PONumber, AppSettings, Estimate, sequelize } = require('../models');

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
    
    // By default, exclude archived unless specifically requested
    if (archived === 'true') {
      where.status = 'archived';
    } else if (archived === 'only') {
      where.status = 'archived';
    } else if (status) {
      where.status = status;
    } else {
      where.status = { [Op.ne]: 'archived' };
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

    res.json({
      data: workOrders.rows,
      total: workOrders.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
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
            include: [{
              model: WorkOrderPartFile,
              as: 'files'
            }],
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
            include: [{
              model: WorkOrderPartFile,
              as: 'files'
            }],
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

    res.json({ data: workOrder });
  } catch (error) {
    next(error);
  }
});

// POST /api/workorders - Create new work order
router.post('/', async (req, res, next) => {
  try {
    const {
      clientName,
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

    if (!clientName) {
      return res.status(400).json({ error: { message: 'Client name is required' } });
    }

    const orderNumber = generateOrderNumber();

    // Start transaction
    const transaction = await sequelize.transaction();
    
    try {
      // Create work order
      const workOrder = await WorkOrder.create({
        orderNumber,
        clientName,
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
        // Get next DR number
        const maxDR = await DRNumber.findOne({
          order: [['drNumber', 'DESC']],
          transaction
        });
        drNumber = (maxDR?.drNumber || 0) + 1;
        
        // Also check work orders table
        const maxWODR = await WorkOrder.max('drNumber', { transaction });
        if (maxWODR && maxWODR >= drNumber) {
          drNumber = maxWODR + 1;
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
router.put('/:id', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const {
      clientName,
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
      signatureData
    } = req.body;

    // Helper to check if value was provided (including empty string)
    const getValue = (newVal, oldVal) => newVal !== undefined ? newVal : oldVal;
    
    // Helper for date fields - convert empty string to null
    const getDateValue = (newVal, oldVal) => {
      if (newVal === undefined) return oldVal;
      if (newVal === '' || newVal === null) return null;
      return newVal;
    };

    // Handle status transitions
    const updates = {
      clientName: getValue(clientName, workOrder.clientName),
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
        ]
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
        ]
      });
    }

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Delete files from Cloudinary
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

    // Clear foreign key references
    await DRNumber.update({ workOrderId: null }, { where: { workOrderId: workOrder.id } });
    await PONumber.update({ workOrderId: null }, { where: { workOrderId: workOrder.id } });
    
    // Update estimate to allow re-conversion
    await Estimate.update(
      { workOrderId: null, status: 'accepted' }, 
      { where: { workOrderId: workOrder.id } }
    );

    // Delete documents
    await WorkOrderDocument.destroy({ where: { workOrderId: workOrder.id } });

    // Delete associated parts and files
    for (const part of workOrder.parts || []) {
      await WorkOrderPartFile.destroy({ where: { workOrderPartId: part.id } });
    }
    await WorkOrderPart.destroy({ where: { workOrderId: workOrder.id } });

    await workOrder.destroy();

    res.json({ message: 'Work order deleted successfully' });
  } catch (error) {
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
      supplierName,
      materialDescription
    } = req.body;

    if (!partType) {
      return res.status(400).json({ error: { message: 'Part type is required' } });
    }

    console.log('Creating part with supplierName:', supplierName);
    console.log('Creating part with materialSource:', materialSource);
    console.log('Creating part with materialDescription:', materialDescription);

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
      rollType,
      radius,
      diameter,
      arcLength,
      arcDegrees,
      sectionSize,
      flangeOut: flangeOut || false,
      specialInstructions,
      // Material source fields
      materialSource: materialSource || 'customer',
      supplierName: supplierName || null,
      materialDescription: materialDescription || null,
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

    console.log('Created part:', part.id, 'supplierName:', part.supplierName);

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
    if (rollType !== undefined) updates.rollType = rollType;
    if (radius !== undefined) updates.radius = radius;
    if (diameter !== undefined) updates.diameter = diameter;
    if (arcLength !== undefined) updates.arcLength = arcLength;
    if (arcDegrees !== undefined) updates.arcDegrees = arcDegrees;
    if (sectionSize !== undefined) updates.sectionSize = sectionSize;
    if (flangeOut !== undefined) updates.flangeOut = flangeOut;
    if (specialInstructions !== undefined) updates.specialInstructions = specialInstructions;
    if (operatorNotes !== undefined) updates.operatorNotes = operatorNotes;
    
    // Material source fields
    if (materialSource !== undefined) updates.materialSource = materialSource;
    if (supplierName !== undefined) updates.supplierName = supplierName;
    if (materialDescription !== undefined) updates.materialDescription = materialDescription;
    
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
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const signedUrl = cloudinary.utils.private_download_url(
        file.cloudinaryId,
        'raw',
        {
          resource_type: 'raw',
          expires_at: expiresAt,
          attachment: false
        }
      );

      return res.json({
        data: {
          url: signedUrl,
          expiresIn: 3600,
          originalName: file.originalName || file.filename
        }
      });
    }

    res.json({
      data: {
        url: file.url,
        expiresIn: null,
        originalName: file.originalName || file.filename
      }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id/parts/:partId/files/:fileId - Delete a file
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

// GET /api/workorders/archived - Get archived work orders (for 5 year retention)
router.get('/archived', async (req, res, next) => {
  try {
    const { clientName, drNumber, limit = 50, offset = 0 } = req.query;
    
    const where = { status: 'archived' };
    if (clientName) where.clientName = { [Op.iLike]: `%${clientName}%` };
    if (drNumber) where.drNumber = parseInt(drNumber);

    // Only show archived within 5 years
    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    where.archivedAt = { [Op.gte]: fiveYearsAgo };

    const workOrders = await WorkOrder.findAndCountAll({
      where,
      include: [{ model: WorkOrderPart, as: 'parts' }],
      order: [['archivedAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      data: workOrders.rows,
      total: workOrders.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
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

    // Generate signed URL (valid for 1 hour)
    const signedUrl = cloudinary.url(document.cloudinaryId, {
      sign_url: true,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    });

    res.json({ data: { url: signedUrl || document.url } });
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

    // Group parts by supplier
    const supplierGroups = {};
    selectedParts.forEach(part => {
      const supplier = part.supplierName || 'Unknown Supplier';
      if (!supplierGroups[supplier]) {
        supplierGroups[supplier] = [];
      }
      supplierGroups[supplier].push(part);
    });

    const suppliers = Object.keys(supplierGroups).sort();
    const createdOrders = [];
    const basePONumber = parseInt(purchaseOrderNumber);

    // Create inbound order for each supplier
    for (let i = 0; i < suppliers.length; i++) {
      const supplier = suppliers[i];
      const parts = supplierGroups[supplier];
      
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
    const nextPO = basePONumber + suppliers.length;
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
      { suppliers: suppliers, partCount: selectedParts.length }
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

module.exports = router;
