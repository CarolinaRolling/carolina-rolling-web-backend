const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const { Op } = require('sequelize');
const { Estimate, EstimatePart, EstimatePartFile, EstimateFile, WorkOrder, WorkOrderPart, WorkOrderPartFile, InboundOrder, AppSettings, DRNumber, PONumber, DailyActivity, sequelize } = require('../models');

const router = express.Router();

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

    // Merge formData fields back into parts for frontend
    const estimateData = estimate.toJSON();
    if (estimateData.parts) {
      estimateData.parts = estimateData.parts.map(p => {
        if (p.formData && typeof p.formData === 'object') {
          return { ...p, ...p.formData };
        }
        return p;
      });
    }

    res.json({ data: estimateData });
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
    
    let partData = cleanNumericFields({
      estimateId: estimate.id,
      partNumber: existingParts + 1,
      ...req.body
    });

    // Sanitize ENUM fields — empty strings break Postgres
    if (partData.rollType === '') partData.rollType = null;

    // Extract underscore-prefixed fields into formData JSONB
    partData = extractFormData(partData);

    // Calculate part totals (skip for ea-priced types which compute their own partTotal)
    if (!['plate_roll', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll'].includes(partData.partType)) {
      const totals = calculatePartTotals(partData);
      Object.assign(partData, totals);
    }
    
    const part = await EstimatePart.create(partData);

    // Recalculate estimate totals
    const allParts = await EstimatePart.findAll({ where: { estimateId: estimate.id } });
    const estimateTotals = calculateEstimateTotals(allParts, estimate.truckingCost, estimate.taxRate);
    await estimate.update(estimateTotals);

    res.status(201).json({
      data: mergeFormData(part),
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

    let updates = cleanNumericFields({ ...req.body });
    
    // Sanitize ENUM fields — empty strings break Postgres
    if (updates.rollType === '') updates.rollType = null;

    // Extract underscore-prefixed fields into formData JSONB
    updates = extractFormData(updates);
    
    // Calculate part totals (skip for ea-priced types which compute their own partTotal)
    const mergedPart = { ...part.toJSON(), ...updates };
    if (!['plate_roll', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll'].includes(mergedPart.partType)) {
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
      data: mergeFormData(part),
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
        materialSource: origPart.materialSource,
        materialTotal: origPart.materialTotal,
        laborTotal: origPart.laborTotal,
        partTotal: origPart.partTotal,
        formData: origPart.formData
      };

      if (!['plate_roll', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll'].includes(partData.partType)) {
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

    // Merge formData into parts
    const mergedParts = estimate.parts.map(p => {
      const obj = p.toJSON ? p.toJSON() : { ...p };
      if (obj.formData && typeof obj.formData === 'object') {
        Object.assign(obj, obj.formData);
      }
      return obj;
    });

    // Part type labels
    const PART_LABELS = {
      plate_roll: 'Plate Roll', angle_roll: 'Angle Roll', pipe_roll: 'Pipe/Tube Roll',
      tube_roll: 'Sq/Rect Tube Roll', channel_roll: 'Channel Roll', beam_roll: 'Beam Roll',
      flat_bar: 'Flat Bar Roll', flat_stock: 'Flat Stock', cone_roll: 'Cone Roll',
      tee_bar: 'Tee Bar Roll', press_brake: 'Press Brake', other: 'Other'
    };

    // Spec abbreviation helper
    const getSpecLabel = (part) => {
      const mp = part._rollMeasurePoint || 'inside';
      const isRad = !!part.radius && !part.diameter;
      if (mp === 'inside') return isRad ? 'ISR' : 'ID';
      if (mp === 'outside') return isRad ? 'OSR' : 'OD';
      return isRad ? 'CLR' : 'CLD';
    };

    // Roll direction label helper
    const getRollDirLabel = (part) => {
      if (!part.rollType) return '';
      if (part.partType === 'tee_bar') {
        return part.rollType === 'easy_way' ? 'SO' : part.rollType === 'on_edge' ? 'SU' : 'SI';
      }
      return part.rollType === 'easy_way' ? 'EW' : part.rollType === 'on_edge' ? 'OE' : 'HW';
    };

    // Colors
    const primaryColor = '#1976d2';
    const darkColor = '#333';
    const grayColor = '#666';
    const lightGray = '#e0e0e0';

    // ========== HEADER WITH LOGO ==========
    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    try {
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 35, { width: 80 });
      }
    } catch (e) {
      console.log('Logo not found, using text header');
    }

    // Company name and info
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
    if (estimate.contactEmail) { doc.text(estimate.contactEmail, 50, yPos); yPos += 13; }
    if (estimate.contactPhone) { doc.text(estimate.contactPhone, 50, yPos); yPos += 13; }

    // Tax Exempt Badge (right side)
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
    doc.fontSize(8).fillColor(grayColor);
    doc.text('ITEM', 50, yPos);
    doc.text('DESCRIPTION', 85, yPos);
    doc.text('QTY', 400, yPos, { width: 30, align: 'center' });
    doc.text('UNIT', 440, yPos, { width: 50, align: 'right' });
    doc.text('AMOUNT', 500, yPos, { width: 62, align: 'right' });
    yPos += 12;
    doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
    yPos += 8;

    // Parts
    const sortedParts = mergedParts.sort((a, b) => a.partNumber - b.partNumber);
    
    for (const part of sortedParts) {
      if (yPos > 680) { doc.addPage(); yPos = 50; }

      const partLabel = PART_LABELS[part.partType] || part.partType;
      const qty = parseInt(part.quantity) || 1;
      const matCost = parseFloat(part.materialTotal) || 0;
      const matMarkup = parseFloat(part.materialMarkupPercent) || 0;
      const matEach = matCost * (1 + matMarkup / 100);
      const labEach = parseFloat(part.laborTotal) || 0;
      const unitPrice = matEach + labEach;
      const lineTotal = parseFloat(part.partTotal) || (unitPrice * qty);

      // Build clean description lines
      const descLines = [];

      // Material description (already includes size info)
      if (part.materialDescription) {
        descLines.push(part.materialDescription);
      } else {
        // Build from individual fields
        const specs = [];
        if (part.material) specs.push(part.material);
        if (part.sectionSize) specs.push(part.sectionSize);
        if (part.thickness) specs.push(part.thickness);
        if (part.width) specs.push(`${part.width}" wide`);
        if (part.length) specs.push(part.length.toString().includes("'") || part.length.toString().includes('"') ? part.length : `${part.length}" long`);
        if (part.outerDiameter) specs.push(`${part.outerDiameter}" OD`);
        if (part.wallThickness) specs.push(`${part.wallThickness}" wall`);
        if (specs.length) descLines.push(specs.join(' × '));
      }

      // Rolling info
      const rollVal = part.diameter || part.radius;
      if (rollVal) {
        const specLabel = getSpecLabel(part);
        const dirLabel = getRollDirLabel(part);
        let rollLine = `Roll: ${rollVal}" ${specLabel}`;
        if (dirLabel) rollLine += ` (${dirLabel})`;
        if (part.arcDegrees) rollLine += ` | Arc: ${part.arcDegrees}°`;
        descLines.push(rollLine);
      }

      // Material source
      if (part.materialSource === 'customer_supplied') {
        descLines.push('Customer Supplied');
      } else if (part.supplierName) {
        descLines.push(`Supplier: ${part.supplierName}`);
      }

      // Special instructions (truncated)
      if (part.specialInstructions) {
        const instr = part.specialInstructions.length > 80 
          ? part.specialInstructions.substring(0, 80) + '...' 
          : part.specialInstructions;
        descLines.push(`Note: ${instr}`);
      }

      const description = descLines.join('\n');
      const descHeight = doc.fontSize(8).heightOfString(description, { width: 300 });
      const rowHeight = Math.max(descHeight, 12) + 8;

      // Check page break with full row height
      if (yPos + rowHeight > 700) { doc.addPage(); yPos = 50; }

      // Part number
      doc.fontSize(9).fillColor(primaryColor).font('Helvetica-Bold');
      doc.text(`#${part.partNumber}`, 50, yPos);

      // Part type + description  
      doc.fontSize(8).fillColor(darkColor).font('Helvetica-Bold');
      doc.text(partLabel, 85, yPos);
      doc.font('Helvetica').fillColor(grayColor);
      doc.text(description, 85, yPos + 11, { width: 300 });
      
      // Quantity
      doc.fillColor(darkColor).text(qty.toString(), 400, yPos, { width: 30, align: 'center' });
      
      // Unit price
      doc.text(formatCurrency(unitPrice), 440, yPos, { width: 50, align: 'right' });

      // Line total
      doc.font('Helvetica-Bold').text(formatCurrency(lineTotal), 500, yPos, { width: 62, align: 'right' });
      doc.font('Helvetica');

      yPos += rowHeight + 4;
      
      // Light divider
      doc.strokeColor('#eee').lineWidth(0.5).moveTo(85, yPos).lineTo(562, yPos).stroke();
      yPos += 6;
    }

    // ========== TRUCKING ==========
    if (parseFloat(estimate.truckingCost) > 0 || estimate.truckingDescription) {
      if (yPos > 680) { doc.addPage(); yPos = 50; }
      
      doc.fontSize(9).fillColor(darkColor).font('Helvetica-Bold').text('Trucking / Delivery', 85, yPos);
      doc.font('Helvetica');
      if (estimate.truckingDescription) {
        doc.fontSize(8).fillColor(grayColor).text(estimate.truckingDescription, 85, yPos + 11, { width: 300 });
      }
      doc.fontSize(8).fillColor(darkColor).font('Helvetica-Bold')
        .text(formatCurrency(estimate.truckingCost), 500, yPos, { width: 62, align: 'right' });
      doc.font('Helvetica');
      yPos += 30;
    }

    // ========== TOTALS ==========
    if (yPos > 620) { doc.addPage(); yPos = 50; }

    yPos += 10;
    doc.strokeColor(lightGray).lineWidth(1).moveTo(350, yPos).lineTo(562, yPos).stroke();
    yPos += 15;

    // Subtotal
    doc.fontSize(10).fillColor(grayColor).text('Subtotal:', 350, yPos);
    doc.fillColor(darkColor).text(formatCurrency(estimate.partsSubtotal), 480, yPos, { align: 'right' });
    yPos += 18;

    // Discount
    const discPct = parseFloat(estimate.discountPercent) || 0;
    const discAmt = parseFloat(estimate.discountAmount) || 0;
    if (discPct > 0 || discAmt > 0) {
      const discountDisplay = discPct > 0 
        ? `Discount (${discPct}%):` 
        : 'Discount:';
      const discountValue = discPct > 0
        ? (parseFloat(estimate.partsSubtotal) || 0) * discPct / 100
        : discAmt;
      doc.fillColor('#c62828').text(discountDisplay, 350, yPos);
      doc.text(`-${formatCurrency(discountValue)}`, 480, yPos, { align: 'right' });
      doc.fillColor(darkColor);
      yPos += 18;
    }

    // Trucking
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
    if (yPos > 680) { doc.addPage(); yPos = 50; }

    doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
    yPos += 15;

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
      if (yPos > 680) { doc.addPage(); yPos = 50; }
      
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
