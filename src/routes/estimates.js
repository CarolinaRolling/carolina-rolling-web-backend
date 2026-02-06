const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const { Op } = require('sequelize');
const { Estimate, EstimatePart, EstimatePartFile, EstimateFile, WorkOrder, WorkOrderPart, WorkOrderPartFile, InboundOrder, AppSettings, DRNumber, PONumber, DailyActivity, sequelize } = require('../models');

const router = express.Router();

// Helper to clean numeric fields - convert empty strings to null
// List of all numeric fields that might be passed
const NUMERIC_FIELDS = [
  'laborRate', 'laborHours', 'laborTotal', 'laborMarkupPercent',
  'materialUnitCost', 'materialTotal', 'materialMarkupPercent',
  'rollingCost', 'rollingMarkupPercent', 'rollingTotal',
  'otherServicesCost', 'otherServicesMarkupPercent', 'otherServicesTotal',
  'setupCharge', 'otherCharges', 'partTotal', 'quantity',
  'serviceDrillingCost', 'serviceCuttingCost', 'serviceFittingCost',
  'serviceWeldingCost', 'serviceWeldingPercent',
  'truckingCost', 'taxRate', 'taxAmount', 'subtotal', 'grandTotal'
];

function cleanNumericFields(data, fields = NUMERIC_FIELDS) {
  const cleaned = { ...data };
  fields.forEach(field => {
    if (cleaned[field] === '' || cleaned[field] === undefined) {
      cleaned[field] = null;
    } else if (cleaned[field] !== null && cleaned[field] !== undefined) {
      const num = parseFloat(cleaned[field]);
      cleaned[field] = isNaN(num) ? null : num;
    }
  });
  return cleaned;
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

// Temp uploads directory
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.pdf', '.dxf', '.step', '.stp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DXF, and STEP files are allowed.'));
    }
  }
});

function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error cleaning up temp file:', error);
  }
}

// Generate estimate number
function generateEstimateNumber() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `EST-${year}${month}${day}-${random}`;
}

// Calculate part totals
function calculatePartTotals(part) {
  const qty = parseInt(part.quantity) || 1;
  
  // Material costs - only if we supply material
  const weSupplyMaterial = part.weSupplyMaterial === true || part.weSupplyMaterial === 'true';
  const materialUnitCost = weSupplyMaterial ? (parseFloat(part.materialUnitCost) || 0) : 0;
  const materialMarkup = weSupplyMaterial ? (parseFloat(part.materialMarkupPercent) || 0) : 0;
  const materialTotal = materialUnitCost * qty * (1 + materialMarkup / 100);

  // Rolling cost (always required)
  const rollingCost = parseFloat(part.rollingCost) || 0;
  
  // Additional Services
  const drillingCost = part.serviceDrilling ? (parseFloat(part.serviceDrillingCost) || 0) : 0;
  const cuttingCost = part.serviceCutting ? (parseFloat(part.serviceCuttingCost) || 0) : 0;
  const fittingCost = part.serviceFitting ? (parseFloat(part.serviceFittingCost) || 0) : 0;
  const weldingCost = part.serviceWelding ? (parseFloat(part.serviceWeldingCost) || 0) : 0;
  
  // Legacy other services (keep for backward compatibility)
  const otherServicesCost = parseFloat(part.otherServicesCost) || 0;
  const otherServicesMarkup = parseFloat(part.otherServicesMarkupPercent) || 15;
  const otherServicesTotal = otherServicesCost * (1 + otherServicesMarkup / 100);

  // Total additional services
  const additionalServicesTotal = drillingCost + cuttingCost + fittingCost + weldingCost;

  const partTotal = materialTotal + rollingCost + otherServicesTotal + additionalServicesTotal;

  return {
    materialTotal: materialTotal.toFixed(2),
    otherServicesTotal: otherServicesTotal.toFixed(2),
    partTotal: partTotal.toFixed(2)
  };
}

// Calculate estimate totals
function calculateEstimateTotals(parts, truckingCost, taxRate, taxExempt = false, discountPercent = 0, discountAmount = 0) {
  let partsSubtotal = 0;
  parts.forEach(part => {
    partsSubtotal += parseFloat(part.partTotal) || 0;
  });

  // Apply discount
  let discountAmt = 0;
  if (parseFloat(discountPercent) > 0) {
    discountAmt = partsSubtotal * (parseFloat(discountPercent) / 100);
  } else if (parseFloat(discountAmount) > 0) {
    discountAmt = parseFloat(discountAmount);
  }
  const afterDiscount = partsSubtotal - discountAmt;

  const trucking = parseFloat(truckingCost) || 0;
  const taxAmount = taxExempt ? 0 : afterDiscount * (parseFloat(taxRate) / 100);
  const grandTotal = afterDiscount + taxAmount + trucking;

  return {
    partsSubtotal: partsSubtotal.toFixed(2),
    taxAmount: taxAmount.toFixed(2),
    grandTotal: grandTotal.toFixed(2)
  };
}

// GET /api/estimates/check-orphaned - Find estimates that point to non-existent work orders (MUST BE BEFORE /:id routes)
router.get('/check-orphaned', async (req, res, next) => {
  try {
    const estimates = await Estimate.findAll({
      where: {
        workOrderId: { [Op.ne]: null }
      }
    });
    
    const orphaned = [];
    for (const estimate of estimates) {
      const workOrder = await WorkOrder.findByPk(estimate.workOrderId);
      if (!workOrder) {
        orphaned.push({
          estimateId: estimate.id,
          estimateNumber: estimate.estimateNumber,
          clientName: estimate.clientName,
          workOrderId: estimate.workOrderId,
          status: estimate.status
        });
      }
    }
    
    res.json({ 
      data: orphaned,
      count: orphaned.length,
      message: orphaned.length > 0 
        ? `Found ${orphaned.length} estimate(s) pointing to non-existent work orders`
        : 'No orphaned estimates found'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/estimates - Get all estimates
router.get('/', async (req, res, next) => {
  try {
    const { status, archived, clientName, limit = 50, offset = 0 } = req.query;
    
    const where = {};
    
    if (archived === 'true') {
      where.status = 'archived';
    } else if (archived === 'false' || !archived) {
      where.status = { [Op.ne]: 'archived' };
    }
    
    if (status && status !== 'all') {
      where.status = status;
    }
    
    if (clientName) {
      where.clientName = { [Op.iLike]: `%${clientName}%` };
    }

    const estimates = await Estimate.findAndCountAll({
      where,
      include: [
        { model: EstimatePart, as: 'parts', order: [['partNumber', 'ASC']] },
        { model: EstimateFile, as: 'files' }
      ],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      data: estimates.rows,
      total: estimates.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/estimates/:id - Get estimate by ID
router.get('/:id', async (req, res, next) => {
  try {
    const estimate = await Estimate.findByPk(req.params.id, {
      include: [
        { 
          model: EstimatePart, 
          as: 'parts', 
          order: [['partNumber', 'ASC']],
          include: [{ model: EstimatePartFile, as: 'files' }]
        },
        { model: EstimateFile, as: 'files' }
      ]
    });

    if (!estimate) {
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    res.json({ data: estimate });
  } catch (error) {
    next(error);
  }
});

// POST /api/estimates - Create new estimate
router.post('/', async (req, res, next) => {
  try {
    const {
      clientName,
      contactName,
      contactEmail,
      contactPhone,
      projectDescription,
      notes,
      internalNotes,
      validUntil,
      taxRate,
      useCustomTax,
      customTaxReason,
      truckingDescription,
      truckingCost
    } = req.body;

    if (!clientName) {
      return res.status(400).json({ error: { message: 'Client name is required' } });
    }

    // Get default tax rate from settings if not provided
    let effectiveTaxRate = taxRate;
    if (effectiveTaxRate === undefined) {
      const taxSetting = await AppSettings.findOne({ where: { key: 'tax_settings' } });
      effectiveTaxRate = taxSetting?.value?.defaultTaxRate || 7.0;
    }

    const estimateNumber = generateEstimateNumber();

    // Create estimate
    const estimate = await Estimate.create({
      estimateNumber,
      clientName,
      contactName,
      contactEmail,
      contactPhone,
      projectDescription,
      notes,
      internalNotes,
      validUntil: validUntil || null,
      taxRate: effectiveTaxRate,
      useCustomTax: useCustomTax || false,
      customTaxReason,
      truckingDescription,
      truckingCost: parseFloat(truckingCost) || 0,
      status: 'draft'
    });

    const createdEstimate = await Estimate.findByPk(estimate.id, {
      include: [
        { model: EstimatePart, as: 'parts' },
        { model: EstimateFile, as: 'files' }
      ]
    });

    res.status(201).json({
      data: createdEstimate,
      message: 'Estimate created successfully'
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/estimates/:id - Update estimate
router.put('/:id', async (req, res, next) => {
  try {
    const estimate = await Estimate.findByPk(req.params.id, {
      include: [{ model: EstimatePart, as: 'parts' }]
    });

    if (!estimate) {
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    const updates = {};
    const fields = ['clientName', 'contactName', 'contactEmail', 'contactPhone', 
      'projectDescription', 'notes', 'internalNotes', 'validUntil', 'taxRate',
      'useCustomTax', 'customTaxReason', 'truckingDescription', 'truckingCost', 'status'];
    
    fields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (updates.status) {
      if (updates.status === 'sent' && !estimate.sentAt) {
        updates.sentAt = new Date();
      }
      if (updates.status === 'accepted' && !estimate.acceptedAt) {
        updates.acceptedAt = new Date();
      }
      if (updates.status === 'archived' && !estimate.archivedAt) {
        updates.archivedAt = new Date();
      }
    }

    await estimate.update(updates);

    // Recalculate totals
    const parts = await EstimatePart.findAll({ where: { estimateId: estimate.id } });
    const totals = calculateEstimateTotals(
      parts, 
      updates.truckingCost ?? estimate.truckingCost, 
      updates.taxRate ?? estimate.taxRate,
      updates.taxExempt ?? estimate.taxExempt
    );
    await estimate.update(totals);

    const updatedEstimate = await Estimate.findByPk(estimate.id, {
      include: [
        { model: EstimatePart, as: 'parts' },
        { model: EstimateFile, as: 'files' }
      ]
    });

    res.json({
      data: updatedEstimate,
      message: 'Estimate updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/estimates/:id - Delete estimate
router.delete('/:id', async (req, res, next) => {
  try {
    const estimate = await Estimate.findByPk(req.params.id, {
      include: [{ model: EstimateFile, as: 'files' }]
    });

    if (!estimate) {
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    // Delete files from Cloudinary
    for (const file of estimate.files || []) {
      if (file.cloudinaryId) {
        try {
          await cloudinary.uploader.destroy(file.cloudinaryId, { resource_type: 'raw' });
        } catch (e) {
          console.error('Failed to delete from Cloudinary:', e);
        }
      }
    }

    await estimate.destroy();

    res.json({ message: 'Estimate deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// ============= PARTS =============

// POST /api/estimates/:id/parts - Add part
router.post('/:id/parts', async (req, res, next) => {
  try {
    const estimate = await Estimate.findByPk(req.params.id);

    if (!estimate) {
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    const existingParts = await EstimatePart.count({ where: { estimateId: estimate.id } });
    
    const partData = cleanNumericFields({
      estimateId: estimate.id,
      partNumber: existingParts + 1,
      ...req.body
    });

    // Calculate part totals (skip for plate_roll and angle_roll which have their own pricing)
    if (!['plate_roll', 'angle_roll', 'flat_stock'].includes(partData.partType)) {
      const totals = calculatePartTotals(partData);
      Object.assign(partData, totals);
    }
    
    const part = await EstimatePart.create(partData);

    // Recalculate estimate totals
    const allParts = await EstimatePart.findAll({ where: { estimateId: estimate.id } });
    const estimateTotals = calculateEstimateTotals(allParts, estimate.truckingCost, estimate.taxRate);
    await estimate.update(estimateTotals);

    res.status(201).json({
      data: part,
      message: 'Part added'
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/estimates/:id/parts/:partId - Update part
router.put('/:id/parts/:partId', async (req, res, next) => {
  try {
    const part = await EstimatePart.findOne({
      where: { id: req.params.partId, estimateId: req.params.id }
    });

    if (!part) {
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    const updates = cleanNumericFields({ ...req.body });
    
    // Calculate part totals (skip for plate_roll and angle_roll which have their own pricing)
    const mergedPart = { ...part.toJSON(), ...updates };
    if (!['plate_roll', 'angle_roll', 'flat_stock'].includes(mergedPart.partType)) {
      const totals = calculatePartTotals(mergedPart);
      Object.assign(updates, totals);
    }

    await part.update(updates);

    // Recalculate estimate totals
    const estimate = await Estimate.findByPk(req.params.id);
    const allParts = await EstimatePart.findAll({ where: { estimateId: estimate.id } });
    const estimateTotals = calculateEstimateTotals(allParts, estimate.truckingCost, estimate.taxRate);
    await estimate.update(estimateTotals);

    res.json({
      data: part,
      message: 'Part updated'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/estimates/:id/parts/:partId - Delete part
router.delete('/:id/parts/:partId', async (req, res, next) => {
  try {
    const part = await EstimatePart.findOne({
      where: { id: req.params.partId, estimateId: req.params.id }
    });

    if (!part) {
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    const deletedPartNumber = part.partNumber;
    await part.destroy();

    // Renumber remaining parts
    const remainingParts = await EstimatePart.findAll({
      where: { estimateId: req.params.id, partNumber: { [Op.gt]: deletedPartNumber } },
      order: [['partNumber', 'ASC']]
    });
    
    for (const p of remainingParts) {
      await p.update({ partNumber: p.partNumber - 1 });
    }

    // Recalculate estimate totals
    const estimate = await Estimate.findByPk(req.params.id);
    const allParts = await EstimatePart.findAll({ where: { estimateId: estimate.id } });
    const estimateTotals = calculateEstimateTotals(allParts, estimate.truckingCost, estimate.taxRate);
    await estimate.update(estimateTotals);

    res.json({ message: 'Part deleted' });
  } catch (error) {
    next(error);
  }
});

// ============= PART FILES =============

// GET /api/estimates/:id/parts/:partId/files - Get files for a specific part
router.get('/:id/parts/:partId/files', async (req, res, next) => {
  try {
    const part = await EstimatePart.findOne({
      where: { id: req.params.partId, estimateId: req.params.id }
    });

    if (!part) {
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    const files = await EstimatePartFile.findAll({
      where: { partId: part.id },
      order: [['createdAt', 'DESC']]
    });

    res.json({ data: files });
  } catch (error) {
    next(error);
  }
});

// POST /api/estimates/:id/parts/:partId/files - Upload file to a specific part
router.post('/:id/parts/:partId/files', upload.single('file'), async (req, res, next) => {
  try {
    const part = await EstimatePart.findOne({
      where: { id: req.params.partId, estimateId: req.params.id }
    });

    if (!part) {
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    if (!req.file) {
      return res.status(400).json({ error: { message: 'No file uploaded' } });
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'estimate-part-files',
      resource_type: 'auto'
    });

    // Clean up local file
    fs.unlinkSync(req.file.path);

    // Determine file type from request or default to 'other'
    const fileType = req.body.fileType || 'other';

    // Create file record
    const partFile = await EstimatePartFile.create({
      partId: part.id,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      url: result.secure_url,
      cloudinaryId: result.public_id,
      fileType: fileType
    });

    res.status(201).json({
      data: partFile,
      message: 'File uploaded'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/estimates/:id/parts/:partId/files/:fileId - Delete a part file
router.delete('/:id/parts/:partId/files/:fileId', async (req, res, next) => {
  try {
    const file = await EstimatePartFile.findOne({
      where: { id: req.params.fileId, partId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // Delete from Cloudinary
    if (file.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(file.cloudinaryId);
      } catch (err) {
        console.error('Failed to delete from Cloudinary:', err);
      }
    }

    await file.destroy();
    res.json({ message: 'File deleted' });
  } catch (error) {
    next(error);
  }
});

// ============= ORDER MATERIAL =============

// POST /api/estimates/:id/order-material - Create purchase orders for materials
router.post('/:id/order-material', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const estimate = await Estimate.findByPk(req.params.id, {
      include: [{ model: EstimatePart, as: 'parts' }]
    });

    if (!estimate) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Estimate not found' } });
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
    const selectedParts = estimate.parts.filter(p => partIds.includes(p.id));
    
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

      // Calculate total material cost for this supplier
      const totalCost = parts.reduce((sum, p) => {
        const unitCost = parseFloat(p.materialUnitCost) || 0;
        const qty = parseInt(p.quantity) || 1;
        return sum + (unitCost * qty);
      }, 0);

      // Create PONumber record
      try {
        const existingPO = await PONumber.findOne({ where: { poNumber: poNumber }, transaction });
        if (!existingPO) {
          await PONumber.create({
            poNumber: poNumber,
            status: 'active',
            supplier: supplier,
            estimateId: estimate.id,
            clientName: estimate.clientName,
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
        clientName: estimate.clientName,
        estimateId: estimate.id,
        estimateNumber: estimate.estimateNumber,
        expectedCost: totalCost,
        status: 'pending',
        notes: `Material order for Estimate ${estimate.estimateNumber}\nClient: ${estimate.clientName}\nContact: ${estimate.contactName || 'N/A'}`
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
        parts: parts.map(p => ({ id: p.id, partNumber: p.partNumber, description: p.materialDescription })),
        totalCost
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
    }

    // Update next PO number setting
    const nextPO = basePONumber + suppliers.length;
    await AppSettings.upsert({
      key: 'next_po_number',
      value: { nextNumber: nextPO }
    }, { transaction });

    await transaction.commit();

    res.status(201).json({
      data: {
        purchaseOrders: createdOrders,
        totalOrders: createdOrders.length
      },
      message: `${createdOrders.length} purchase order(s) created`
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

// ============= FILES =============

// POST /api/estimates/:id/files - Upload files
router.post('/:id/files', upload.array('files', 10), async (req, res, next) => {
  const tempFiles = [];

  try {
    const estimate = await Estimate.findByPk(req.params.id);

    if (!estimate) {
      req.files?.forEach(file => cleanupTempFile(file.path));
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: { message: 'No files uploaded' } });
    }

    tempFiles.push(...req.files.map(f => f.path));

    const files = await Promise.all(
      req.files.map(async (file) => {
        const cloudinaryResult = await cloudinary.uploader.upload(file.path, {
          folder: `estimates/${estimate.id}`,
          resource_type: 'raw',
          type: 'private',
          use_filename: true,
          unique_filename: true
        });

        const estimateFile = await EstimateFile.create({
          estimateId: estimate.id,
          filename: file.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: cloudinaryResult.secure_url,
          cloudinaryId: cloudinaryResult.public_id
        });

        cleanupTempFile(file.path);
        return estimateFile;
      })
    );

    res.status(201).json({
      data: files,
      message: `${files.length} file(s) uploaded`
    });
  } catch (error) {
    tempFiles.forEach(cleanupTempFile);
    next(error);
  }
});

// GET /api/estimates/:id/files/:fileId/signed-url - Get signed URL
router.get('/:id/files/:fileId/signed-url', async (req, res, next) => {
  try {
    const file = await EstimateFile.findOne({
      where: { id: req.params.fileId, estimateId: req.params.id }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    if (file.cloudinaryId) {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const signedUrl = cloudinary.utils.private_download_url(
        file.cloudinaryId,
        'raw',
        { resource_type: 'raw', expires_at: expiresAt, attachment: true }
      );

      return res.json({
        data: { url: signedUrl, expiresIn: 3600, originalName: file.originalName }
      });
    }

    res.json({
      data: { url: file.url, expiresIn: null, originalName: file.originalName }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/estimates/:id/files/:fileId - Delete file
router.delete('/:id/files/:fileId', async (req, res, next) => {
  try {
    const file = await EstimateFile.findOne({
      where: { id: req.params.fileId, estimateId: req.params.id }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    if (file.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(file.cloudinaryId, { resource_type: 'raw' });
      } catch (e) {
        console.error('Failed to delete from Cloudinary:', e);
      }
    }

    await file.destroy();

    res.json({ message: 'File deleted' });
  } catch (error) {
    next(error);
  }
});

// ============= CONVERT TO WORK ORDER =============

// Helper to get next DR number
async function getNextDRNumber(transaction) {
  const setting = await AppSettings.findOne({ where: { key: 'next_dr_number' }, transaction });
  
  if (setting?.value?.nextNumber) {
    const drNumber = setting.value.nextNumber;
    await setting.update({ value: { nextNumber: drNumber + 1 } }, { transaction });
    return drNumber;
  }

  const lastDR = await DRNumber.findOne({
    order: [['drNumber', 'DESC']],
    transaction
  });
  return lastDR ? lastDR.drNumber + 1 : 1;
}

// POST /api/estimates/:id/convert - Convert estimate to work order (for customer supplied)
router.post('/:id/convert', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const estimate = await Estimate.findByPk(req.params.id, {
      include: [
        { model: EstimatePart, as: 'parts' },
        { model: EstimateFile, as: 'files' }
      ],
      transaction
    });

    if (!estimate) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    const { clientPurchaseOrderNumber, promisedDate, storageLocation, customDRNumber } = req.body;

    // Check if all parts are customer supplied
    const allCustomerSupplied = estimate.parts.every(p => p.materialSource === 'customer_supplied');
    const hasOrderedMaterial = estimate.parts.some(p => p.materialSource === 'we_order' && p.materialOrdered);

    // For we_order materials that haven't been ordered yet, don't allow direct conversion
    if (!allCustomerSupplied && !hasOrderedMaterial) {
      const needsOrdering = estimate.parts.filter(p => p.materialSource === 'we_order' && !p.materialOrdered);
      if (needsOrdering.length > 0) {
        await transaction.rollback();
        return res.status(400).json({ 
          error: { 
            message: 'Order material first, or mark parts as customer supplied',
            partsNeedingOrder: needsOrdering.length
          } 
        });
      }
    }

    // Assign DR number (for customer supplied, assign immediately)
    let drNumber;
    if (allCustomerSupplied) {
      if (customDRNumber) {
        const existingDR = await DRNumber.findOne({ where: { drNumber: customDRNumber }, transaction });
        if (existingDR) {
          await transaction.rollback();
          return res.status(400).json({ error: { message: `DR-${customDRNumber} already exists` } });
        }
        drNumber = customDRNumber;
      } else {
        drNumber = await getNextDRNumber(transaction);
      }
    }

    // Generate work order number using DR number if available
    const orderNumber = drNumber ? `DR-${drNumber}` : `WO-${Date.now()}`;

    // Create work order
    const workOrder = await WorkOrder.create({
      orderNumber,
      drNumber,
      clientName: estimate.clientName,
      clientPurchaseOrderNumber,
      contactName: estimate.contactName,
      contactPhone: estimate.contactPhone,
      contactEmail: estimate.contactEmail,
      notes: estimate.projectDescription,
      promisedDate: promisedDate || null,
      storageLocation,
      status: 'received',
      receivedAt: new Date(),
      estimateId: estimate.id,
      estimateNumber: estimate.estimateNumber,
      estimateTotal: estimate.grandTotal,
      allMaterialReceived: allCustomerSupplied,
      pendingInboundCount: allCustomerSupplied ? 0 : estimate.parts.filter(p => p.materialSource === 'we_order' && !p.materialReceived).length
    }, { transaction });

    // Create work order parts from estimate parts
    for (const estPart of estimate.parts) {
      await WorkOrderPart.create({
        workOrderId: workOrder.id,
        partNumber: estPart.partNumber,
        partType: estPart.partType,
        clientPartNumber: estPart.clientPartNumber,
        heatNumber: estPart.heatNumber,
        quantity: estPart.quantity,
        material: estPart.material,
        thickness: estPart.thickness,
        width: estPart.width,
        length: estPart.length,
        outerDiameter: estPart.outerDiameter,
        wallThickness: estPart.wallThickness,
        sectionSize: estPart.sectionSize,
        rollType: estPart.rollType,
        radius: estPart.radius,
        diameter: estPart.diameter,
        arcDegrees: estPart.arcDegrees,
        flangeOut: estPart.flangeOut,
        specialInstructions: estPart.specialInstructions,
        status: 'pending',
        materialSource: estPart.materialSource,
        materialReceived: estPart.materialSource === 'customer_supplied' || estPart.materialReceived,
        materialReceivedAt: estPart.materialSource === 'customer_supplied' ? new Date() : estPart.materialReceivedAt,
        awaitingInboundId: estPart.inboundOrderId,
        awaitingPONumber: estPart.materialPurchaseOrderNumber,
        supplierName: estPart.supplierName,
        vendorId: estPart.vendorId || null,
        materialDescription: estPart.materialDescription
      }, { transaction });
    }

    // Create DR number entry if assigned
    if (drNumber) {
      await DRNumber.create({
        drNumber,
        status: 'active',
        workOrderId: workOrder.id,
        estimateId: estimate.id,
        clientName: estimate.clientName
      }, { transaction });
    }

    // Update estimate status and link to work order
    await estimate.update({
      status: 'accepted',
      acceptedAt: new Date(),
      workOrderId: workOrder.id,
      drNumber,
      allCustomerSupplied
    }, { transaction });

    // Log activity
    await logActivity(
      'created',
      'work_order',
      workOrder.id,
      orderNumber,
      estimate.clientName,
      `Work Order ${orderNumber} created from ${estimate.estimateNumber}`,
      { drNumber, estimateNumber: estimate.estimateNumber, partsCount: estimate.parts.length }
    );

    await transaction.commit();

    // Reload work order with parts
    const createdOrder = await WorkOrder.findByPk(workOrder.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    res.status(201).json({
      data: {
        workOrder: createdOrder,
        estimate,
        drNumber
      },
      message: drNumber ? `Work Order DR-${drNumber} created` : 'Work Order created'
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

// POST /api/estimates/:id/duplicate - Duplicate an estimate (for repeat orders)
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const original = await Estimate.findByPk(req.params.id, {
      include: [{ model: EstimatePart, as: 'parts' }]
    });

    if (!original) {
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    const { notes } = req.body;

    // Generate new estimate number
    const estimateNumber = generateEstimateNumber();

    // Create new estimate
    const newEstimate = await Estimate.create({
      estimateNumber,
      clientName: original.clientName,
      contactName: original.contactName,
      contactEmail: original.contactEmail,
      contactPhone: original.contactPhone,
      projectDescription: original.projectDescription,
      notes: notes || original.notes,
      internalNotes: `Duplicated from ${original.estimateNumber}. ${original.internalNotes || ''}`,
      taxRate: original.taxRate,
      truckingDescription: original.truckingDescription,
      truckingCost: original.truckingCost,
      status: 'draft'
    });

    // Copy parts
    for (const origPart of original.parts) {
      const partData = {
        estimateId: newEstimate.id,
        partNumber: origPart.partNumber,
        partType: origPart.partType,
        clientPartNumber: origPart.clientPartNumber,
        quantity: origPart.quantity,
        materialDescription: origPart.materialDescription,
        supplierName: origPart.supplierName,
        materialUnitCost: origPart.materialUnitCost,
        materialMarkupPercent: origPart.materialMarkupPercent,
        rollingCost: origPart.rollingCost,
        otherServicesCost: origPart.otherServicesCost,
        otherServicesMarkupPercent: origPart.otherServicesMarkupPercent,
        material: origPart.material,
        thickness: origPart.thickness,
        width: origPart.width,
        length: origPart.length,
        outerDiameter: origPart.outerDiameter,
        wallThickness: origPart.wallThickness,
        sectionSize: origPart.sectionSize,
        rollType: origPart.rollType,
        radius: origPart.radius,
        diameter: origPart.diameter,
        arcDegrees: origPart.arcDegrees,
        flangeOut: origPart.flangeOut,
        specialInstructions: origPart.specialInstructions,
        materialSource: origPart.materialSource
      };

      if (!['plate_roll', 'angle_roll', 'flat_stock'].includes(partData.partType)) {
        const totals = calculatePartTotals(partData);
        Object.assign(partData, totals);
      }
      await EstimatePart.create(partData);
    }

    // Recalculate totals
    const parts = await EstimatePart.findAll({ where: { estimateId: newEstimate.id } });
    const estimateTotals = calculateEstimateTotals(parts, newEstimate.truckingCost, newEstimate.taxRate);
    await newEstimate.update(estimateTotals);

    // Reload with parts
    const createdEstimate = await Estimate.findByPk(newEstimate.id, {
      include: [{ model: EstimatePart, as: 'parts' }]
    });

    // Log activity
    await logActivity(
      'created',
      'estimate',
      newEstimate.id,
      estimateNumber,
      newEstimate.clientName,
      `Estimate ${estimateNumber} created (duplicated from ${original.estimateNumber})`,
      { duplicatedFrom: original.estimateNumber }
    );

    res.status(201).json({
      data: createdEstimate,
      message: `Estimate ${estimateNumber} created from ${original.estimateNumber}`
    });
  } catch (error) {
    next(error);
  }
});

// ============= ARCHIVE OLD ESTIMATES =============

// POST /api/estimates/archive-old - Archive estimates older than 1 month
router.post('/archive-old', async (req, res, next) => {
  try {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const [count] = await Estimate.update(
      { status: 'archived', archivedAt: new Date() },
      {
        where: {
          status: { [Op.notIn]: ['archived', 'accepted'] },
          createdAt: { [Op.lt]: oneMonthAgo }
        }
      }
    );

    res.json({ message: `${count} estimates archived` });
  } catch (error) {
    next(error);
  }
});

// ============= PDF GENERATION =============

// GET /api/estimates/:id/pdf - Generate estimate PDF
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const estimate = await Estimate.findByPk(req.params.id, {
      include: [{ model: EstimatePart, as: 'parts', order: [['partNumber', 'ASC']] }]
    });

    if (!estimate) {
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    // Get Square fee rate from settings (default 2.9% + $0.30)
    const squareSetting = await AppSettings.findOne({ where: { key: 'square_fees' } });
    const squareRate = squareSetting?.value?.rate || 2.9;
    const squareFixed = squareSetting?.value?.fixed || 0.30;

    // Generate PDF using PDFKit
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Estimate-${estimate.estimateNumber}.pdf"`);

    // Pipe to response
    doc.pipe(res);

    // Helper functions
    const formatCurrency = (amount) => {
      const num = parseFloat(amount) || 0;
      return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const formatDate = (date) => {
      if (!date) return '';
      return new Date(date).toLocaleDateString('en-US', { 
        year: 'numeric', month: 'long', day: 'numeric' 
      });
    };

    // Colors
    const primaryColor = '#1976d2';
    const darkColor = '#333';
    const grayColor = '#666';
    const lightGray = '#e0e0e0';

    // ========== HEADER WITH LOGO ==========
    // Try to add logo
    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    try {
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 35, { width: 80 });
      }
    } catch (e) {
      console.log('Logo not found, using text header');
    }

    // Company name and info (next to logo)
    doc.fontSize(18).fillColor(darkColor).font('Helvetica-Bold').text('CAROLINA ROLLING CO. INC.', 140, 40);
    doc.font('Helvetica').fontSize(9).fillColor(grayColor);
    doc.text('9152 Sonrisa St., Bellflower, CA 90706', 140, 62);
    doc.text('Phone: (562) 633-1044', 140, 74);
    doc.text('Email: keetitrolling@carolinarolling.com', 140, 86);
    
    // Estimate title and number (right side)
    doc.fontSize(22).fillColor(primaryColor).font('Helvetica-Bold').text('ESTIMATE', 400, 40, { align: 'right' });
    doc.font('Helvetica').fontSize(11).fillColor(darkColor).text(estimate.estimateNumber, 400, 68, { align: 'right' });
    doc.fontSize(9).fillColor(grayColor).text(`Date: ${formatDate(estimate.createdAt)}`, 400, 85, { align: 'right' });
    if (estimate.validUntil) {
      doc.text(`Valid Until: ${formatDate(estimate.validUntil)}`, 400, 98, { align: 'right' });
    }

    // Divider line
    doc.strokeColor(lightGray).lineWidth(1).moveTo(50, 120).lineTo(562, 120).stroke();

    // ========== CLIENT INFO ==========
    let yPos = 135;
    doc.fontSize(10).fillColor(primaryColor).font('Helvetica-Bold').text('PREPARED FOR:', 50, yPos);
    doc.font('Helvetica');
    yPos += 16;
    doc.fontSize(12).fillColor(darkColor).font('Helvetica-Bold').text(estimate.clientName, 50, yPos);
    doc.font('Helvetica');
    yPos += 16;
    if (estimate.contactName) {
      doc.fontSize(10).fillColor(grayColor).text(`Attn: ${estimate.contactName}`, 50, yPos);
      yPos += 13;
    }
    if (estimate.contactEmail) {
      doc.text(estimate.contactEmail, 50, yPos);
      yPos += 13;
    }
    if (estimate.contactPhone) {
      doc.text(estimate.contactPhone, 50, yPos);
      yPos += 13;
    }

    // Tax Exempt Badge (right side of client section)
    if (estimate.taxExempt) {
      doc.fontSize(10).fillColor('#c62828').font('Helvetica-Bold')
        .text('TAX EXEMPT', 400, 135, { align: 'right' });
      doc.font('Helvetica');
      if (estimate.taxExemptCertNumber) {
        doc.fontSize(8).fillColor(grayColor)
          .text(`Cert#: ${estimate.taxExemptCertNumber}`, 400, 150, { align: 'right' });
      }
    }

    // Project description
    if (estimate.projectDescription) {
      yPos += 8;
      doc.fontSize(9).fillColor(grayColor).text('Project:', 50, yPos);
      doc.fillColor(darkColor).text(estimate.projectDescription, 95, yPos, { width: 400 });
      yPos += doc.heightOfString(estimate.projectDescription, { width: 400 }) + 5;
    }

    // ========== PARTS TABLE ==========
    yPos += 15;
    doc.strokeColor(lightGray).lineWidth(1).moveTo(50, yPos).lineTo(562, yPos).stroke();
    yPos += 10;

    doc.fontSize(12).fillColor(primaryColor).text('SERVICES & MATERIALS', 50, yPos);
    yPos += 25;

    // Table header
    doc.fontSize(9).fillColor(grayColor);
    doc.text('ITEM', 50, yPos);
    doc.text('DESCRIPTION', 120, yPos);
    doc.text('QTY', 380, yPos, { width: 40, align: 'center' });
    doc.text('AMOUNT', 480, yPos, { align: 'right' });
    yPos += 15;
    doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
    yPos += 10;

    // Parts
    const sortedParts = estimate.parts.sort((a, b) => a.partNumber - b.partNumber);
    
    for (const part of sortedParts) {
      // Check if we need a new page
      if (yPos > 680) {
        doc.addPage();
        yPos = 50;
      }

      // Part header
      doc.fontSize(10).fillColor(darkColor).font('Helvetica-Bold');
      const partTypeLabel = part.partType.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
      doc.text(`Part ${part.partNumber} - ${partTypeLabel}`, 50, yPos);
      doc.font('Helvetica');
      yPos += 15;

      // Build description without showing markup percentages
      let description = '';
      
      // Material info (simplified - no markup shown)
      if (part.materialSource === 'customer_supplied') {
        description += 'Customer Supplied Material\n';
      } else if (part.materialDescription) {
        description += `Material: ${part.materialDescription}\n`;
      }

      // Specs
      const specs = [];
      if (part.material) specs.push(part.material);
      if (part.thickness) specs.push(`${part.thickness}" thick`);
      if (part.width) specs.push(`${part.width}" wide`);
      if (part.length) specs.push(`${part.length}" long`);
      if (part.outerDiameter) specs.push(`${part.outerDiameter}" OD`);
      if (part.sectionSize) specs.push(part.sectionSize);
      if (specs.length > 0) {
        description += `Specs: ${specs.join(', ')}\n`;
      }

      // Rolling specs
      const rollSpecs = [];
      if (part.diameter) rollSpecs.push(`${part.diameter}" dia`);
      if (part.radius) rollSpecs.push(`${part.radius}" radius`);
      if (part.arcDegrees) rollSpecs.push(`${part.arcDegrees}°`);
      if (part.rollType) rollSpecs.push(part.rollType.replace('_', ' '));
      if (part.flangeOut) rollSpecs.push('Flange Out');
      if (rollSpecs.length > 0) {
        description += `Rolling: ${rollSpecs.join(', ')}\n`;
      }

      if (part.specialInstructions) {
        description += `Note: ${part.specialInstructions}\n`;
      }

      doc.fontSize(9).fillColor(grayColor);
      doc.text(description.trim(), 120, yPos - 15, { width: 250 });
      
      // Quantity
      doc.text(part.quantity.toString(), 380, yPos - 15, { width: 40, align: 'center' });
      
      // Amount (part total, no breakdown shown)
      doc.fillColor(darkColor).text(formatCurrency(part.partTotal), 480, yPos - 15, { align: 'right' });

      yPos += Math.max(doc.heightOfString(description.trim(), { width: 250 }), 15) + 10;
      
      // Light divider between parts
      doc.strokeColor('#f0f0f0').lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
      yPos += 10;
    }

    // ========== TRUCKING ==========
    if (parseFloat(estimate.truckingCost) > 0 || estimate.truckingDescription) {
      if (yPos > 680) {
        doc.addPage();
        yPos = 50;
      }
      
      doc.fontSize(10).fillColor(darkColor).font('Helvetica-Bold').text('Trucking/Delivery', 50, yPos);
      doc.font('Helvetica');
      yPos += 15;
      
      if (estimate.truckingDescription) {
        doc.fontSize(9).fillColor(grayColor).text(estimate.truckingDescription, 120, yPos - 15, { width: 250 });
      }
      doc.fillColor(darkColor).text(formatCurrency(estimate.truckingCost), 480, yPos - 15, { align: 'right' });
      yPos += 20;
    }

    // ========== TOTALS ==========
    if (yPos > 620) {
      doc.addPage();
      yPos = 50;
    }

    yPos += 10;
    doc.strokeColor(lightGray).lineWidth(1).moveTo(350, yPos).lineTo(562, yPos).stroke();
    yPos += 15;

    // Subtotal
    doc.fontSize(10).fillColor(grayColor).text('Subtotal:', 350, yPos);
    doc.fillColor(darkColor).text(formatCurrency(estimate.partsSubtotal), 480, yPos, { align: 'right' });
    yPos += 18;

    // Trucking (if any)
    if (parseFloat(estimate.truckingCost) > 0) {
      doc.fillColor(grayColor).text('Trucking:', 350, yPos);
      doc.fillColor(darkColor).text(formatCurrency(estimate.truckingCost), 480, yPos, { align: 'right' });
      yPos += 18;
    }

    // Tax
    if (estimate.taxExempt) {
      doc.fillColor(grayColor).text('Tax:', 350, yPos);
      doc.fillColor('#c62828').text('EXEMPT', 480, yPos, { align: 'right' });
      yPos += 18;
    } else if (parseFloat(estimate.taxAmount) > 0) {
      doc.fillColor(grayColor).text(`Tax (${estimate.taxRate}%):`, 350, yPos);
      doc.fillColor(darkColor).text(formatCurrency(estimate.taxAmount), 480, yPos, { align: 'right' });
      yPos += 18;
    }

    // Grand Total
    doc.strokeColor(lightGray).lineWidth(1).moveTo(350, yPos).lineTo(562, yPos).stroke();
    yPos += 10;
    doc.fontSize(14).fillColor(primaryColor).font('Helvetica-Bold').text('TOTAL:', 350, yPos);
    doc.text(formatCurrency(estimate.grandTotal), 480, yPos, { align: 'right' });
    doc.font('Helvetica');
    yPos += 30;

    // ========== CREDIT CARD SECTION ==========
    if (yPos > 680) {
      doc.addPage();
      yPos = 50;
    }

    doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
    yPos += 15;

    // Calculate credit card total
    const grandTotal = parseFloat(estimate.grandTotal) || 0;
    const ccFee = (grandTotal * squareRate / 100) + squareFixed;
    const ccTotal = grandTotal + ccFee;

    doc.fontSize(9).fillColor(grayColor);
    doc.text('PAYMENT BY CREDIT CARD (Square)', 50, yPos);
    yPos += 15;
    
    doc.fontSize(10).fillColor(darkColor);
    doc.text(`Processing Fee (${squareRate}% + $${squareFixed.toFixed(2)}):`, 300, yPos);
    doc.text(formatCurrency(ccFee), 480, yPos, { align: 'right' });
    yPos += 15;
    
    doc.font('Helvetica-Bold').fillColor(primaryColor);
    doc.text('Credit Card Total:', 300, yPos);
    doc.text(formatCurrency(ccTotal), 480, yPos, { align: 'right' });
    doc.font('Helvetica');
    yPos += 25;

    // ========== NOTES ==========
    if (estimate.notes) {
      if (yPos > 680) {
        doc.addPage();
        yPos = 50;
      }
      
      doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
      yPos += 15;
      
      doc.fontSize(10).fillColor(primaryColor).text('NOTES:', 50, yPos);
      yPos += 15;
      doc.fontSize(9).fillColor(grayColor).text(estimate.notes, 50, yPos, { width: 500 });
    }

    // ========== FOOTER ==========
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor(grayColor);
      doc.text(
        'Carolina Rolling Co. Inc. | 9152 Sonrisa St., Bellflower, CA 90706 | (562) 633-1044 | keetitrolling@carolinarolling.com',
        50, 745, { align: 'center', width: 512 }
      );
      doc.text(
        `${estimate.estimateNumber} | Page ${i + 1} of ${pageCount}`,
        50, 756, { align: 'center', width: 512 }
      );
    }

    // Finalize
    doc.end();

  } catch (error) {
    console.error('PDF generation error:', error);
    next(error);
  }
});

// ============= CONVERT TO WORK ORDER =============

// POST /api/estimates/:id/convert-to-workorder - Convert estimate to work order
router.post('/:id/convert-to-workorder', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const estimate = await Estimate.findByPk(req.params.id, {
      include: [
        { model: EstimatePart, as: 'parts', include: [{ model: EstimatePartFile, as: 'files' }] },
        { model: EstimateFile, as: 'files' }
      ]
    });

    if (!estimate) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }

    if (estimate.status === 'converted' || estimate.workOrderId) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'Estimate has already been converted to a work order' } });
    }

    const { clientPurchaseOrderNumber, requestedDueDate, promisedDate, notes } = req.body;

    // Get next DR number - check both dr_numbers table AND work_orders table
    const maxDRFromTable = await DRNumber.max('drNumber') || 0;
    const maxDRFromWorkOrders = await WorkOrder.max('drNumber') || 0;
    const maxDR = Math.max(maxDRFromTable, maxDRFromWorkOrders, 2950);
    const nextDRNumber = maxDR + 1;

    // Create DR number record
    const drRecord = await DRNumber.create({
      drNumber: nextDRNumber,
      status: 'active'
    }, { transaction });

    // Generate order number
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const orderNumber = `WO-${year}${month}${day}-${random}`;

    // Create work order from estimate
    const workOrder = await WorkOrder.create({
      orderNumber,
      drNumber: nextDRNumber,
      clientName: estimate.clientName,
      contactName: estimate.contactName,
      contactPhone: estimate.contactPhone,
      contactEmail: estimate.contactEmail,
      clientPurchaseOrderNumber: clientPurchaseOrderNumber || null,
      notes: notes || estimate.notes,
      status: 'waiting_for_materials',
      estimateId: estimate.id,
      estimateNumber: estimate.estimateNumber,
      estimateTotal: estimate.grandTotal,
      requestedDueDate: requestedDueDate || null,
      promisedDate: promisedDate || null,
      // Copy order-level pricing
      truckingDescription: estimate.truckingDescription,
      truckingCost: estimate.truckingCost,
      taxRate: estimate.taxRate,
      taxAmount: estimate.taxAmount,
      subtotal: estimate.subtotal,
      grandTotal: estimate.grandTotal
    }, { transaction });

    // Update DR record with work order ID
    await drRecord.update({ workOrderId: workOrder.id }, { transaction });

    // Create work order parts from estimate parts
    for (const estimatePart of estimate.parts) {
      const workOrderPart = await WorkOrderPart.create({
        workOrderId: workOrder.id,
        partNumber: estimatePart.partNumber,
        partType: estimatePart.partType,
        clientPartNumber: estimatePart.clientPartNumber,
        heatNumber: estimatePart.heatNumber,
        quantity: estimatePart.quantity,
        materialDescription: estimatePart.materialDescription,
        material: estimatePart.material,
        thickness: estimatePart.thickness,
        width: estimatePart.width,
        length: estimatePart.length,
        outerDiameter: estimatePart.outerDiameter,
        wallThickness: estimatePart.wallThickness,
        sectionSize: estimatePart.sectionSize,
        rollType: estimatePart.rollType,
        radius: estimatePart.radius,
        diameter: estimatePart.diameter,
        arcDegrees: estimatePart.arcDegrees,
        flangeOut: estimatePart.flangeOut,
        specialInstructions: estimatePart.specialInstructions,
        status: 'pending',
        // Copy supplier info for material ordering
        supplierName: estimatePart.supplierName,
        vendorId: estimatePart.vendorId || null,
        // Set materialSource - prefer estimate's materialSource, fall back to weSupplyMaterial flag
        materialSource: estimatePart.materialSource || (estimatePart.weSupplyMaterial ? 'we_order' : 'customer_supplied'),
        // Copy pricing fields
        laborRate: estimatePart.laborRate,
        laborHours: estimatePart.laborHours,
        laborTotal: estimatePart.laborTotal,
        materialUnitCost: estimatePart.materialUnitCost,
        materialTotal: estimatePart.materialTotal,
        setupCharge: estimatePart.setupCharge,
        otherCharges: estimatePart.otherCharges,
        partTotal: estimatePart.partTotal
      }, { transaction });

      // Copy part files to work order part files
      if (estimatePart.files && estimatePart.files.length > 0) {
        for (const file of estimatePart.files) {
          await WorkOrderPartFile.create({
            workOrderPartId: workOrderPart.id,
            filename: file.filename,
            originalName: file.originalName,
            mimeType: file.mimeType,
            size: file.size,
            url: file.url,
            cloudinaryId: file.cloudinaryId,
            fileType: file.fileType
          }, { transaction });
        }
      }
    }

    // Update estimate status - use 'accepted' and link to work order
    await estimate.update({
      status: 'accepted',
      workOrderId: workOrder.id
    }, { transaction });

    await transaction.commit();

    // Log activity
    await logActivity(
      'created',
      'work_order',
      workOrder.id,
      `DR-${nextDRNumber}`,
      estimate.clientName,
      `Work order created from estimate ${estimate.estimateNumber}`,
      { estimateNumber: estimate.estimateNumber, partsCount: estimate.parts.length }
    );

    // Fetch complete work order
    const completeWorkOrder = await WorkOrder.findByPk(workOrder.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    res.status(201).json({
      data: {
        workOrder: completeWorkOrder
      },
      message: `Work order DR-${nextDRNumber} created successfully`
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Convert to work order error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to convert estimate' } });
  }
});

// POST /api/estimates/:id/reset-conversion - Reset an estimate's conversion status (admin use)
router.post('/:id/reset-conversion', async (req, res, next) => {
  try {
    const estimate = await Estimate.findByPk(req.params.id);
    
    if (!estimate) {
      return res.status(404).json({ error: { message: 'Estimate not found' } });
    }
    
    // Check if the linked work order actually exists
    let workOrderExists = false;
    if (estimate.workOrderId) {
      const workOrder = await WorkOrder.findByPk(estimate.workOrderId);
      workOrderExists = !!workOrder;
    }
    
    if (workOrderExists) {
      return res.status(400).json({ 
        error: { 
          message: 'Work order exists. Cannot reset. Delete the work order first or view it.',
          workOrderId: estimate.workOrderId
        } 
      });
    }
    
    // Reset the estimate
    await estimate.update({
      workOrderId: null,
      status: 'accepted' // Set back to accepted so it can be converted again
    });
    
    res.json({ 
      data: estimate,
      message: 'Estimate conversion reset. You can now convert it again.' 
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
