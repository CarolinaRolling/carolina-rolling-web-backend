const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const fileStorage = require('../utils/storage');
const { Op } = require('sequelize');
const { Estimate, EstimatePart, EstimatePartFile, EstimateFile, WorkOrder, WorkOrderPart, WorkOrderPartFile, InboundOrder, AppSettings, DRNumber, PONumber, DailyActivity, Client, sequelize } = require('../models');

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

// Extract underscore-prefixed fields from part data into formData JSONB
function extractFormData(data) {
  const formData = {};
  const cleaned = {};
  // UI-only fields that should never be stored in formData
  const excludeFromFormData = ['_vendorSearch', '_shapeFile'];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) {
      if (!excludeFromFormData.includes(key)) {
        formData[key] = value;
      }
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
  return refreshDerivedFields(obj);
}

/**
 * Rebuild derived text fields from raw database columns.
 * Ensures _rollingDescription direction matches actual rollType.
 */
function refreshDerivedFields(part) {
  if (part._rollingDescription && part.rollType) {
    let dir = '';
    if (part.partType === 'tee_bar') {
      dir = part.rollType === 'easy_way' ? 'SO' : part.rollType === 'on_edge' ? 'SU' : 'SI';
    } else {
      dir = part.rollType === 'easy_way' ? 'EW' : part.rollType === 'on_edge' ? 'OE' : 'HW';
    }
    const allDirs = ['EW', 'HW', 'OE', 'SO', 'SI', 'SU'];
    const dirRegex = new RegExp('\\b(' + allDirs.join('|') + ')\\b', 'g');
    const matches = part._rollingDescription.match(dirRegex);
    if (matches && matches.length > 0 && !matches.includes(dir)) {
      part._rollingDescription = part._rollingDescription.replace(dirRegex, dir);
    }
  }
  return part;
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
    const allowedTypes = [
      'application/pdf',
      'application/stp',
      'application/step',
      'model/step',
      'application/octet-stream',
      'image/png',
      'image/jpeg',
      'image/gif'
    ];
    const allowedExtensions = ['.pdf', '.dxf', '.step', '.stp', '.dwg', '.png', '.jpg', '.jpeg', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, DXF, DWG, STEP, and image files.'));
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
const EA_PRICED_TYPES = ['plate_roll', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll', 'fab_service', 'shop_rate'];

// Parse dimension string: "3/8"" → 0.375, "1-1/2"" → 1.5, "2.5" → 2.5, "24 ga" → 0.025
function parseDimension(val) {
  if (!val) return 0;
  const s = String(val).trim().replace(/["\u2033]/g, '');
  if (!isNaN(s) && s !== '') return parseFloat(s);
  const gaugeMatch = s.match(/^(\d+)\s*ga/i);
  if (gaugeMatch) {
    const gaugeMap = { 24: 0.025, 22: 0.030, 20: 0.036, 18: 0.048, 16: 0.060, 14: 0.075, 12: 0.105, 11: 0.120, 10: 0.135 };
    return gaugeMap[parseInt(gaugeMatch[1])] || 0;
  }
  const mixedMatch = s.match(/^(\d+)\s*[-\u2013]\s*(\d+)\s*\/\s*(\d+)/);
  if (mixedMatch) return parseInt(mixedMatch[1]) + parseInt(mixedMatch[2]) / parseInt(mixedMatch[3]);
  const fracMatch = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (fracMatch) return parseInt(fracMatch[1]) / parseInt(fracMatch[2]);
  const leadMatch = s.match(/^([\d.]+)/);
  if (leadMatch) return parseFloat(leadMatch[1]);
  return 0;
}

function getPartSize(part) {
  // Handle Sequelize model instances - use dataValues for plain object spread
  const raw = part.dataValues ? part.dataValues : part;
  const fd = (raw.formData && typeof raw.formData === 'object') ? raw.formData : {};
  const merged = { ...raw, ...fd };
  if (merged.partType === 'plate_roll' || merged.partType === 'flat_stock') return parseDimension(merged.thickness);
  if (merged.partType === 'angle_roll') return parseDimension(merged._angleSize || merged.sectionSize || '');
  if (merged.partType === 'pipe_roll') return parseDimension(merged.outerDiameter);
  if (merged.partType === 'tube_roll') return parseDimension(merged._tubeSize || merged.sectionSize || '');
  if (merged.partType === 'flat_bar') return parseDimension(merged._barSize || merged.sectionSize || '');
  if (merged.partType === 'channel_roll') return parseDimension(merged._channelSize || merged.sectionSize || '');
  if (merged.partType === 'beam_roll') return parseDimension(merged._beamSize || merged.sectionSize || '');
  if (merged.partType === 'tee_bar') return parseDimension(merged._teeSize || merged.sectionSize || '');
  if (merged.partType === 'cone_roll') return parseFloat(merged._coneLargeDia) || parseDimension(merged.sectionSize || '');
  return parseDimension(merged.sectionSize || merged.thickness || '');
}

function getPartWidth(part) {
  const raw = part.dataValues ? part.dataValues : part;
  const fd = (raw.formData && typeof raw.formData === 'object') ? raw.formData : {};
  return parseDimension(fd.width || raw.width);
}

function getLaborMinimum(part, laborMinimums) {
  if (!laborMinimums || !laborMinimums.length) return null;
  const partSize = getPartSize(part);
  const partWidth = getPartWidth(part);
  let bestSpecificRule = null, bestGeneralRule = null;

  for (const rule of laborMinimums) {
    if (rule.partType !== part.partType) continue;

    const hasMinSize = rule.minSize != null && rule.minSize !== '' && parseFloat(rule.minSize) > 0;
    const hasMaxSize = rule.maxSize != null && rule.maxSize !== '' && parseFloat(rule.maxSize) > 0;
    const hasMinWidth = rule.minWidth != null && rule.minWidth !== '' && parseFloat(rule.minWidth) > 0;
    const hasMaxWidth = rule.maxWidth != null && rule.maxWidth !== '' && parseFloat(rule.maxWidth) > 0;
    const hasSizeConstraints = hasMinSize || hasMaxSize;
    const hasWidthConstraints = hasMinWidth || hasMaxWidth;

    if (!hasSizeConstraints && !hasWidthConstraints) {
      if (!bestGeneralRule || parseFloat(rule.minimum) > parseFloat(bestGeneralRule.minimum)) bestGeneralRule = rule;
      continue;
    }

    let sizeOk = true;
    if (hasSizeConstraints) {
      if (partSize <= 0) sizeOk = false;
      else {
        if (hasMinSize && partSize < parseFloat(rule.minSize)) sizeOk = false;
        if (hasMaxSize && partSize > parseFloat(rule.maxSize)) sizeOk = false;
      }
    }
    let widthOk = true;
    if (hasWidthConstraints) {
      if (partWidth <= 0) widthOk = false;
      else {
        if (hasMinWidth && partWidth < parseFloat(rule.minWidth)) widthOk = false;
        if (hasMaxWidth && partWidth > parseFloat(rule.maxWidth)) widthOk = false;
      }
    }
    if (sizeOk && widthOk) {
      if (!bestSpecificRule || parseFloat(rule.minimum) > parseFloat(bestSpecificRule.minimum)) bestSpecificRule = rule;
    }
  }
  // Only return a specific match or a general (no-constraints) match
  // Never fall back to a constrained rule that didn't match - that causes wrong minimums
  return bestSpecificRule || bestGeneralRule || null;
}

function roundUpMaterial(amount, rounding) {
  if (!amount || amount <= 0) return amount;
  if (rounding === 'dollar') return Math.ceil(amount);
  if (rounding === 'five') return Math.ceil(amount / 5) * 5;
  return amount;
}

function getMinimumInfo(parts, minimumOverride, laborMinimums) {
  let totalLabor = 0, totalMaterial = 0, highestMinimum = 0, highestMinRule = null;
  parts.forEach(part => {
    if (!EA_PRICED_TYPES.includes(part.partType)) return;
    const fd = (part.formData && typeof part.formData === 'object') ? part.formData : {};
    const laborEach = parseFloat(part.laborTotal) || 0;
    const materialCost = parseFloat(part.materialTotal) || 0;
    const materialMarkup = parseFloat(part.materialMarkupPercent) || parseFloat(fd.materialMarkupPercent) || 0;
    const materialEachRaw = materialCost * (1 + materialMarkup / 100);
    const materialEach = roundUpMaterial(materialEachRaw, fd._materialRounding || part._materialRounding);
    const qty = parseInt(part.quantity) || 1;
    totalLabor += laborEach * qty;
    totalMaterial += materialEach * qty;

    const rule = getLaborMinimum(part, laborMinimums);
    if (rule && parseFloat(rule.minimum) > highestMinimum) {
      highestMinimum = parseFloat(rule.minimum);
      highestMinRule = rule;
    }
  });

  const minimumApplies = !minimumOverride && highestMinimum > 0 && totalLabor > 0 && totalLabor < highestMinimum;
  const adjustedLabor = minimumApplies ? highestMinimum : totalLabor;
  const laborDifference = minimumApplies ? (highestMinimum - totalLabor) : 0;
  return { totalLabor, totalMaterial, highestMinimum, highestMinRule, minimumApplies, adjustedLabor, laborDifference };
}

async function loadLaborMinimums() {
  const defaults = [
    { partType: 'plate_roll', label: 'Plate \u2264 3/8"', sizeField: 'thickness', maxSize: 0.375, minWidth: '', maxWidth: '', minimum: 125 },
    { partType: 'plate_roll', label: 'Plate \u2264 3/8" (24-60" wide)', sizeField: 'thickness', maxSize: 0.375, minWidth: 24, maxWidth: 60, minimum: 150 },
    { partType: 'plate_roll', label: 'Plate > 3/8"', sizeField: 'thickness', minSize: 0.376, minWidth: '', maxWidth: '', minimum: 200 },
    { partType: 'angle_roll', label: 'Angle \u2264 2x2', sizeField: 'angleSize', maxSize: 2, minWidth: '', maxWidth: '', minimum: 150 },
    { partType: 'angle_roll', label: 'Angle > 2x2', sizeField: 'angleSize', minSize: 2.01, minWidth: '', maxWidth: '', minimum: 250 },
  ];
  try {
    const setting = await AppSettings.findOne({ where: { key: 'labor_minimums' } });
    if (setting && setting.value) {
      const parsed = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) { /* use defaults */ }
  return defaults;
}

// Check if a client is tax exempt by looking up the Client record directly
async function isClientTaxExempt(clientName) {
  if (!clientName) return false;
  try {
    const client = await Client.findOne({ where: { name: clientName } });
    if (!client) return false;
    return client.taxStatus === 'resale' || client.taxStatus === 'exempt' ||
      (!!client.resaleCertificate && client.permitStatus === 'active');
  } catch (e) { return false; }
}

function calculateEstimateTotals(parts, truckingCost, taxRate, taxExempt = false, discountPercent = 0, discountAmount = 0, minInfo = null) {
  // Ensure taxExempt is boolean (SQLite may store as 0/1)
  const isExempt = taxExempt === true || taxExempt === 1 || taxExempt === '1' || taxExempt === 'true';
  let partsSubtotal = 0;

  if (minInfo && minInfo.minimumApplies) {
    // When minimum applies: sum ea-priced material + adjusted labor, plus non-ea parts
    let nonEaTotal = 0;
    parts.forEach(part => {
      if (EA_PRICED_TYPES.includes(part.partType) || part.partType === 'rush_service') return;
      nonEaTotal += parseFloat(part.partTotal) || 0;
    });
    partsSubtotal = nonEaTotal + minInfo.totalMaterial + minInfo.adjustedLabor;
  } else {
    parts.forEach(part => {
      if (part.partType === 'rush_service') return; // rush calculated separately below
      partsSubtotal += parseFloat(part.partTotal) || 0;
    });
  }

  // Rush service amounts
  let expediteAmount = 0, emergencyAmount = 0;
  const rushPart = parts.find(p => p.partType === 'rush_service');
  if (rushPart) {
    const fd = (rushPart.formData && typeof rushPart.formData === 'object') ? rushPart.formData : rushPart;
    if (fd._expediteEnabled) {
      if (fd._expediteType === 'custom_amt') {
        expediteAmount = parseFloat(fd._expediteCustomAmt) || 0;
      } else {
        let pct = parseFloat(fd._expediteType) || 0;
        if (fd._expediteType === 'custom_pct') pct = parseFloat(fd._expediteCustomPct) || 0;
        expediteAmount = partsSubtotal * (pct / 100);
      }
    }
    if (fd._emergencyEnabled) {
      const emergOpts = { 'Saturday': 600, 'Saturday Night': 800, 'Sunday': 600, 'Sunday Night': 800 };
      emergencyAmount = emergOpts[fd._emergencyDay] || 0;
    }
  }
  partsSubtotal += expediteAmount + emergencyAmount;

  // Apply discount
  let discountAmt = 0;
  if (parseFloat(discountPercent) > 0) {
    discountAmt = partsSubtotal * (parseFloat(discountPercent) / 100);
  } else if (parseFloat(discountAmount) > 0) {
    discountAmt = parseFloat(discountAmount);
  }
  const afterDiscount = partsSubtotal - discountAmt;

  const trucking = parseFloat(truckingCost) || 0;
  const taxAmount = isExempt ? 0 : afterDiscount * (parseFloat(taxRate) / 100);
  const grandTotal = afterDiscount + taxAmount + trucking;

  return {
    partsSubtotal: partsSubtotal.toFixed(2),
    taxAmount: taxAmount.toFixed(2),
    grandTotal: grandTotal.toFixed(2)
  };
}

// Async wrapper that loads labor minimums and applies them
async function calculateEstimateTotalsWithMinimums(parts, estimate) {
  const laborMinimums = await loadLaborMinimums();
  const minInfo = getMinimumInfo(parts, estimate.minimumOverride, laborMinimums);
  // Coerce taxExempt to boolean (SQLite stores as 0/1)
  const taxExempt = estimate.taxExempt === true || estimate.taxExempt === 1 || estimate.taxExempt === '1' || estimate.taxExempt === 'true';
  return calculateEstimateTotals(
    parts, estimate.truckingCost, estimate.taxRate, taxExempt,
    estimate.discountPercent, estimate.discountAmount, minInfo
  );
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

// POST /api/estimates/recalculate-all - Recalculate totals for all estimates (fixes tax-exempt totals)
router.post('/recalculate-all', async (req, res, next) => {
  try {
    const estimates = await Estimate.findAll({
      include: [{ model: EstimatePart, as: 'parts' }]
    });
    let fixed = 0;
    for (const estimate of estimates) {
      try {
        const totals = await calculateEstimateTotalsWithMinimums(estimate.parts, estimate);
        const oldGT = parseFloat(estimate.grandTotal) || 0;
        const newGT = parseFloat(totals.grandTotal) || 0;
        if (Math.abs(oldGT - newGT) > 0.01) {
          await estimate.update(totals);
          fixed++;
        }
      } catch (e) { /* skip */ }
    }
    res.json({ message: `Recalculated ${estimates.length} estimates, ${fixed} had changed totals` });
  } catch (error) {
    next(error);
  }
});

// GET /api/estimates - Get all estimates
router.get('/', async (req, res, next) => {
  try {
    const { status, archived, clientName, search, limit = 200, offset = 0 } = req.query;
    
    const where = {};
    
    // If searching, search across ALL statuses (including archived/accepted)
    if (search) {
      const searchLower = `%${search}%`;
      where[Op.or] = [
        { clientName: { [Op.iLike]: searchLower } },
        { estimateNumber: { [Op.iLike]: searchLower } },
        { contactName: { [Op.iLike]: searchLower } },
        { projectDescription: { [Op.iLike]: searchLower } }
      ];
    } else {
    if (archived === 'true') {
      where.status = { [Op.in]: ['archived', 'accepted'] };
    } else if (archived === 'false' || !archived) {
      where.status = { [Op.notIn]: ['archived', 'accepted'] };
    }
    
    if (status && status !== 'all') {
      where.status = status;
    }
    
    if (clientName) {
      where.clientName = { [Op.iLike]: `%${clientName}%` };
    }
    }

    // API key client scoping — restrict to key's allowed client
    if (req.apiKey && req.apiKey.clientName) {
      where.clientName = { [Op.iLike]: `%${req.apiKey.clientName}%` };
    }

    const estimates = await Estimate.findAndCountAll({
      where,
      include: [
        { model: EstimatePart, as: 'parts', order: [['partNumber', 'ASC']] },
        { model: EstimateFile, as: 'files' }
      ],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      distinct: true
    });

    // Recalculate totals on-the-fly to ensure tax-exempt estimates show correct values
    const laborMinimums = await loadLaborMinimums();
    // Build a cache of client tax-exempt status to avoid repeated DB queries
    const clientNames = [...new Set(estimates.rows.map(e => e.clientName).filter(Boolean))];
    const clientExemptMap = {};
    for (const name of clientNames) {
      clientExemptMap[name] = await isClientTaxExempt(name);
    }
    for (const estimate of estimates.rows) {
      let isExempt = estimate.taxExempt === true || estimate.taxExempt === 1 || estimate.taxExempt === '1' || estimate.taxExempt === 'true';
      // Also check client record directly
      if (!isExempt && clientExemptMap[estimate.clientName]) {
        isExempt = true;
        // Fix the DB (fire-and-forget)
        Estimate.update({ taxExempt: true, taxExemptReason: 'Resale' }, { where: { id: estimate.id } }).catch(() => {});
      }
      const minInfo = getMinimumInfo(estimate.parts, estimate.minimumOverride, laborMinimums);
      const totals = calculateEstimateTotals(
        estimate.parts, estimate.truckingCost, estimate.taxRate, isExempt,
        estimate.discountPercent, estimate.discountAmount, minInfo
      );
      // Check if totals changed before overwriting
      const storedGT = parseFloat(estimate.grandTotal) || 0;
      const needsUpdate = Math.abs(storedGT - parseFloat(totals.grandTotal)) > 0.01;
      // Update display values
      estimate.partsSubtotal = totals.partsSubtotal;
      estimate.taxAmount = totals.taxAmount;
      estimate.grandTotal = totals.grandTotal;
      // Persist if different (fire-and-forget)
      if (needsUpdate) {
        Estimate.update(totals, { where: { id: estimate.id } }).catch(() => {});
      }
    }

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

    // API key client scoping
    if (req.apiKey && req.apiKey.clientName) {
      if (!estimate.clientName || !estimate.clientName.toLowerCase().includes(req.apiKey.clientName.toLowerCase())) {
        return res.status(403).json({ error: { message: 'Access denied' } });
      }
    }

    // Merge formData fields back into parts for frontend
    const estimateData = estimate.toJSON();
    if (estimateData.parts) {
      // Rewrite file URLs to use download proxy (only for Cloudinary — S3 URLs are permanent)
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      for (const p of estimateData.parts) {
        if (p.files) {
          for (const f of p.files) {
            const isS3 = (f.cloudinaryId && f.cloudinaryId.startsWith('s3:')) || (f.url && f.url.includes('amazonaws.com'));
            if (!isS3) {
              f.url = `${baseUrl}/api/estimates/${estimateData.id}/parts/${p.id}/files/${f.id}/download`;
            }
          }
        }
      }
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
      truckingCost,
      taxExempt,
      taxExemptReason,
      taxExemptCertNumber,
      discountPercent,
      discountAmount,
      discountReason
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

    // Use custom estimate number if provided, otherwise auto-generate
    let estimateNumber;
    if (req.body.estimateNumber && req.body.estimateNumber.trim()) {
      estimateNumber = req.body.estimateNumber.trim();
      const existing = await Estimate.findOne({ where: { estimateNumber } });
      if (existing) {
        return res.status(409).json({ error: { message: `Estimate number "${estimateNumber}" is already in use` } });
      }
    } else {
      estimateNumber = generateEstimateNumber();
    }

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
      taxExempt: taxExempt || false,
      taxExemptReason: taxExemptReason || null,
      taxExemptCertNumber: taxExemptCertNumber || null,
      discountPercent: parseFloat(discountPercent) || 0,
      discountAmount: parseFloat(discountAmount) || 0,
      discountReason: discountReason || null,
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
      'useCustomTax', 'customTaxReason', 'truckingDescription', 'truckingCost', 'status',
      'taxExempt', 'taxExemptCertNumber', 'taxExemptReason',
      'discountPercent', 'discountAmount', 'discountReason',
      'minimumOverride', 'minimumOverrideReason'];
    
    fields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // Handle custom estimate number with uniqueness check
    if (req.body.estimateNumber !== undefined && req.body.estimateNumber !== estimate.estimateNumber) {
      const newNum = req.body.estimateNumber.trim();
      if (!newNum) {
        return res.status(400).json({ error: { message: 'Estimate number cannot be empty' } });
      }
      const existing = await Estimate.findOne({ where: { estimateNumber: newNum } });
      if (existing && existing.id !== estimate.id) {
        return res.status(409).json({ error: { message: `Estimate number "${newNum}" is already in use` } });
      }
      updates.estimateNumber = newNum;
      // Sync to linked work order if exists
      if (estimate.workOrderId) {
        await WorkOrder.update({ estimateNumber: newNum }, { where: { id: estimate.workOrderId } });
      }
    }

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

    // Ensure taxExempt is proper boolean after update (SQLite stores as 0/1)
    if (estimate.taxExempt !== undefined) {
      estimate.taxExempt = estimate.taxExempt === true || estimate.taxExempt === 1 || estimate.taxExempt === '1' || estimate.taxExempt === 'true';
    }

    // Recalculate totals with minimum charge logic
    const parts = await EstimatePart.findAll({ where: { estimateId: estimate.id } });
    const totals = await calculateEstimateTotalsWithMinimums(parts, estimate);
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
          await fileStorage.deleteFile(file.cloudinaryId);
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
    if (!['plate_roll', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll', 'fab_service', 'shop_rate'].includes(partData.partType)) {
      const totals = calculatePartTotals(partData);
      Object.assign(partData, totals);
    }
    
    const part = await EstimatePart.create(partData);

    // Recalculate estimate totals
    const allParts = await EstimatePart.findAll({ where: { estimateId: estimate.id } });
    const estimateTotals = await calculateEstimateTotalsWithMinimums(allParts, estimate);
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
    if (!['plate_roll', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll', 'fab_service', 'shop_rate'].includes(mergedPart.partType)) {
      const totals = calculatePartTotals(mergedPart);
      Object.assign(updates, totals);
    }

    await part.update(updates);

    // Recalculate estimate totals
    const estimate = await Estimate.findByPk(req.params.id);
    const allParts = await EstimatePart.findAll({ where: { estimateId: estimate.id } });
    const estimateTotals = await calculateEstimateTotalsWithMinimums(allParts, estimate);
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
    const estimateTotals = await calculateEstimateTotalsWithMinimums(allParts, estimate);
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

// POST /api/estimates/:id/parts/:partId/files - Upload file(s) to a specific part
router.post('/:id/parts/:partId/files', upload.array('files', 10), async (req, res, next) => {
  const tempFiles = [];
  try {
    const part = await EstimatePart.findOne({
      where: { id: req.params.partId, estimateId: req.params.id }
    });

    if (!part) {
      req.files?.forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    // Support both single file (field='file') and multi file (field='files')
    const uploadedFiles = req.files || [];
    if (req.file) uploadedFiles.push(req.file);
    
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: { message: 'No file uploaded' } });
    }

    tempFiles.push(...uploadedFiles.map(f => f.path));

    const fileType = req.body.fileType || 'other';
    
    const savedFiles = await Promise.all(uploadedFiles.map(async (file) => {
      // Determine file type from extension
      const ext = path.extname(file.originalname).toLowerCase();
      let detectedType = fileType;
      if (ext === '.pdf') detectedType = 'drawing';
      else if (ext === '.stp' || ext === '.step') detectedType = 'step_file';
      else if (ext === '.dxf') detectedType = 'drawing';

      // Upload file
      const result = await fileStorage.uploadFile(file.path, {
        folder: `estimates/${req.params.id}/parts/${req.params.partId}`,
        originalName: file.originalname,
        mimeType: file.mimetype
      });

      // Clean up local file
      try { fs.unlinkSync(file.path); } catch(e){}

      // Create file record
      const partFile = await EstimatePartFile.create({
        partId: part.id,
        filename: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url: result.url,
        cloudinaryId: result.storageId,
        fileType: detectedType
      });

      return partFile;
    }));

    res.status(201).json({
      data: savedFiles.length === 1 ? savedFiles[0] : savedFiles,
      message: `${savedFiles.length} file(s) uploaded`
    });
  } catch (error) {
    tempFiles.forEach(p => { try { fs.unlinkSync(p); } catch(e){} });
    next(error);
  }
});

// GET /api/estimates/:id/parts/:partId/files/:fileId/view - Get viewable URL for a part file
router.get('/:id/parts/:partId/files/:fileId/view', async (req, res, next) => {
  try {
    const file = await EstimatePartFile.findOne({
      where: { id: req.params.fileId, partId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // Return direct S3 URL or proxy URL for Cloudinary
    const isS3 = (file.cloudinaryId && file.cloudinaryId.startsWith('s3:')) || (file.url && file.url.includes('amazonaws.com'));
    if (isS3) {
      res.json({ data: { url: file.url, originalName: file.originalName } });
    } else {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const url = `${baseUrl}/api/estimates/${req.params.id}/parts/${req.params.partId}/files/${req.params.fileId}/download`;
      res.json({ data: { url, originalName: file.originalName } });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/estimates/:id/parts/:partId/files/:fileId/debug - Debug file URL resolution
router.get('/:id/parts/:partId/files/:fileId/debug', async (req, res, next) => {
  try {
    const file = await EstimatePartFile.findOne({
      where: { id: req.params.fileId, partId: req.params.partId }
    });
    if (!file) return res.status(404).json({ error: 'File not found in DB' });

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const pubId = file.cloudinaryId;
    const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';
    const versionMatch = file.url?.match(/\/v(\d+)\//);
    const version = versionMatch ? `/v${versionMatch[1]}` : '';

    const urlsToTest = [];
    if (file.url) urlsToTest.push({ label: 'stored', url: file.url });
    if (pubId && cloudName) {
      urlsToTest.push({ label: 'raw+ver+ext', url: `https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}${ext}` });
      urlsToTest.push({ label: 'raw+ver', url: `https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}` });
      urlsToTest.push({ label: 'image+ver+ext', url: `https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}${ext}` });
      urlsToTest.push({ label: 'image+ver', url: `https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}` });
      if (version) {
        urlsToTest.push({ label: 'raw+ext', url: `https://res.cloudinary.com/${cloudName}/raw/upload/${pubId}${ext}` });
        urlsToTest.push({ label: 'image+ext', url: `https://res.cloudinary.com/${cloudName}/image/upload/${pubId}${ext}` });
      }
    }

    // Test each URL with HEAD request
    const results = [];
    for (const { label, url } of urlsToTest) {
      const status = await new Promise(resolve => {
        const lib = url.startsWith('https') ? https : http;
        const request = lib.request(url, { method: 'HEAD' }, resp => {
          resp.resume();
          resolve(resp.statusCode);
        });
        request.on('error', () => resolve('error'));
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

// GET /api/estimates/:id/parts/:partId/files/:fileId/download - Stream file from storage
router.get('/:id/parts/:partId/files/:fileId/download', async (req, res, next) => {
  try {
    const file = await EstimatePartFile.findOne({
      where: { id: req.params.fileId, partId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // S3 files: redirect directly — URLs are permanent and public
    if (file.cloudinaryId && file.cloudinaryId.startsWith('s3:')) {
      return res.redirect(file.url);
    }
    if (file.url && file.url.includes('.s3.') && file.url.includes('amazonaws.com')) {
      return res.redirect(file.url);
    }

    // Build list of candidate URLs to try
    const urlsToTry = [];
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    
    if (file.cloudinaryId && cloudName) {
      const pubId = file.cloudinaryId;
      const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';
      
      // Always try signed URLs first (files may be private)
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
        const hasExt = pubId.match(/\.\w+$/);
        const format = hasExt ? hasExt[0].replace('.', '') : ext.replace('.', '');
        const signedDownload = cloudinary.utils.private_download_url(pubId, format, {
          resource_type: 'raw',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        });
        urlsToTry.push(signedDownload);
      } catch (e) {
        console.error('[file-proxy] Failed to generate download URL:', e.message);
      }
      
      // Try stored URL
      if (file.url) urlsToTry.push(file.url);
      
      // Try public URL variants as fallback
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
    } else {
      // No cloudinaryId - just try stored URL
      if (file.url) urlsToTry.push(file.url);
    }
    
    // Deduplicate
    const uniqueUrls = [...new Set(urlsToTry)];
    
    console.log(`[file-proxy] Trying ${uniqueUrls.length} URLs for file ${file.id} (${file.originalName}):`, uniqueUrls);

    // Try each URL - stream the first one that works
    for (const url of uniqueUrls) {
      const upstream = await fetchWithRedirects(url);
      if (upstream) {
        console.log(`[file-proxy] SUCCESS: ${url}`);
        const contentType = file.mimeType || upstream.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName || file.filename || 'file')}"`);
        
        // Fix stored URL for future requests if a different URL worked (skip signed URLs)
        if (url !== file.url && !url.includes('?')) {
          file.update({ url }).catch(() => {});
        }
        
        upstream.pipe(res);
        return;
      }
    }
    
    console.error(`[file-proxy] ALL URLS FAILED for file ${file.id}. cloudinaryId=${file.cloudinaryId}, storedUrl=${file.url}`);
    res.status(404).json({ error: { message: 'File not accessible on storage' } });
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
        await fileStorage.deleteFile(file.cloudinaryId);
      } catch (err) {
        // Try image type for old files uploaded with resource_type: 'auto'
        try {
          await fileStorage.deleteFile(file.cloudinaryId);
        } catch (err2) {
          console.error('Failed to delete from Cloudinary:', err2);
        }
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
        const uploadResult = await fileStorage.uploadFile(file.path, {
          folder: `estimates/${estimate.id}`,
          originalName: file.originalname,
          mimeType: file.mimetype
        });

        const estimateFile = await EstimateFile.create({
          estimateId: estimate.id,
          filename: file.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: uploadResult.url,
          cloudinaryId: uploadResult.storageId
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

    // API key client scoping
    if (req.apiKey && req.apiKey.clientName) {
      const estimate = await Estimate.findByPk(req.params.id);
      if (!estimate || !estimate.clientName || !estimate.clientName.toLowerCase().includes(req.apiKey.clientName.toLowerCase())) {
        return res.status(403).json({ error: { message: 'Access denied' } });
      }
    }

    // Return proxy download URL for consistent file serving
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/api/estimates/${req.params.id}/files/${req.params.fileId}/download`;

    res.json({
      data: { url, expiresIn: null, originalName: file.originalName }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/estimates/:id/files/:fileId/download - Stream estimate-level file
router.get('/:id/files/:fileId/download', async (req, res, next) => {
  try {
    const file = await EstimateFile.findOne({
      where: { id: req.params.fileId, estimateId: req.params.id }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // API key client scoping
    if (req.apiKey && req.apiKey.clientName) {
      const estimate = await Estimate.findByPk(req.params.id);
      if (!estimate || !estimate.clientName || !estimate.clientName.toLowerCase().includes(req.apiKey.clientName.toLowerCase())) {
        return res.status(403).json({ error: { message: 'Access denied' } });
      }
    }

    // S3 files: redirect directly — URLs are permanent and public
    if (file.cloudinaryId && file.cloudinaryId.startsWith('s3:')) {
      return res.redirect(file.url);
    }
    if (file.url && file.url.includes('.s3.') && file.url.includes('amazonaws.com')) {
      return res.redirect(file.url);
    }

    const urlsToTry = [];
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;

    if (file.cloudinaryId && cloudName) {
      const pubId = file.cloudinaryId;
      const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';

      // Always try signed URLs first (files may be private)
      try {
        const signedUrl = cloudinary.url(pubId, { resource_type: 'raw', type: 'private', sign_url: true, secure: true });
        urlsToTry.push(signedUrl);
      } catch (e) { console.error('[file-proxy] signed URL error:', e.message); }
      try {
        const hasExt = pubId.match(/\.\w+$/);
        const format = hasExt ? hasExt[0].replace('.', '') : ext.replace('.', '');
        const signedDownload = cloudinary.utils.private_download_url(pubId, format, { resource_type: 'raw', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        urlsToTry.push(signedDownload);
      } catch (e) { console.error('[file-proxy] download URL error:', e.message); }

      if (file.url) urlsToTry.push(file.url);

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
    } else {
      if (file.url) urlsToTry.push(file.url);
    }

    const uniqueUrls = [...new Set(urlsToTry)];
    console.log(`[file-proxy] Trying ${uniqueUrls.length} URLs for estimate file ${file.id} (${file.originalName})`);

    for (const url of uniqueUrls) {
      const upstream = await fetchWithRedirects(url);
      if (upstream) {
        console.log(`[file-proxy] SUCCESS for estimate file ${file.id}`);
        const contentType = file.mimeType || upstream.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName || file.filename || 'file')}"`);
        if (url !== file.url && !url.includes('?')) {
          file.update({ url }).catch(() => {});
        }
        upstream.pipe(res);
        return;
      }
    }

    console.error(`[file-proxy] ALL URLS FAILED for estimate file ${file.id}. cloudinaryId=${file.cloudinaryId}, storedUrl=${file.url}`);
    res.status(404).json({ error: { message: 'File not accessible on storage' } });
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
        await fileStorage.deleteFile(file.cloudinaryId);
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

  // Fallback: check both tables for max
  const lastDR = await DRNumber.findOne({
    order: [['drNumber', 'DESC']],
    transaction
  });
  const maxWODR = await WorkOrder.max('drNumber', { transaction }) || 0;
  const maxDR = Math.max(lastDR?.drNumber || 0, maxWODR);
  return maxDR + 1;
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

    // Check if all parts have material on hand (customer supplied or in stock)
    const allMaterialOnHand = estimate.parts.every(p => ['customer_supplied', 'in_stock'].includes(p.materialSource));
    const hasOrderedMaterial = estimate.parts.some(p => p.materialSource === 'we_order' && p.materialOrdered);

    // For we_order materials that haven't been ordered yet, don't allow direct conversion
    if (!allMaterialOnHand && !hasOrderedMaterial) {
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

    // Assign DR number (for material on hand, assign immediately)
    let drNumber;
    if (allMaterialOnHand) {
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

    // Create work order using shared utility
    const { buildWorkOrderFromEstimate, buildWorkOrderPartFromEstimate } = require('../services/pricing');
    
    const woData = buildWorkOrderFromEstimate(estimate, {
      orderNumber,
      drNumber,
      clientPurchaseOrderNumber,
      notes: estimate.projectDescription,
      promisedDate: promisedDate || null,
      storageLocation,
      status: 'received',
      receivedAt: new Date(),
      allMaterialReceived: allMaterialOnHand,
      pendingInboundCount: allMaterialOnHand ? 0 : estimate.parts.filter(p => p.materialSource === 'we_order' && !p.materialReceived).length
    });

    const workOrder = await WorkOrder.create(woData, { transaction });

    // Create work order parts from estimate parts using shared utility
    for (const estPart of estimate.parts) {
      try {
        const partData = buildWorkOrderPartFromEstimate(estPart);
        partData.workOrderId = workOrder.id;
        // Override material received status for customer-supplied/in-stock parts
        if (['customer_supplied', 'in_stock'].includes(partData.materialSource)) {
          partData.materialReceived = true;
          partData.materialReceivedAt = new Date();
        }
        if (estPart.inboundOrderId) partData.awaitingInboundId = estPart.inboundOrderId;
        if (estPart.materialPurchaseOrderNumber) partData.awaitingPONumber = estPart.materialPurchaseOrderNumber;

        await WorkOrderPart.create(partData, { transaction });
      } catch (partErr) {
        console.error(`Failed to create WO part #${estPart.partNumber} (type: ${estPart.partType}):`, partErr.message);
        if (partErr.errors) partErr.errors.forEach(e => console.error(`  Validation: ${e.path} - ${e.message}`));
        throw new Error(`Failed on part #${estPart.partNumber} (${estPart.partType}): ${partErr.message}`);
      }
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
      allCustomerSupplied: allMaterialOnHand
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
        vendorEstimateNumber: origPart.vendorEstimateNumber,
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

      if (!['plate_roll', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll', 'fab_service', 'shop_rate'].includes(partData.partType)) {
        const totals = calculatePartTotals(partData);
        Object.assign(partData, totals);
      }
      await EstimatePart.create(partData);
    }

    // Recalculate totals
    const parts = await EstimatePart.findAll({ where: { estimateId: newEstimate.id } });
    const estimateTotals = await calculateEstimateTotalsWithMinimums(parts, newEstimate);
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

    // API key client scoping
    if (req.apiKey && req.apiKey.clientName) {
      if (!estimate.clientName || !estimate.clientName.toLowerCase().includes(req.apiKey.clientName.toLowerCase())) {
        return res.status(403).json({ error: { message: 'Access denied' } });
      }
    }

    // Ensure taxExempt is a proper boolean (SQLite stores as 0/1)
    let isTaxExempt = estimate.taxExempt === true || estimate.taxExempt === 1 || estimate.taxExempt === '1' || estimate.taxExempt === 'true';
    
    // Also check the Client record directly - this is the authoritative source
    if (!isTaxExempt) {
      isTaxExempt = await isClientTaxExempt(estimate.clientName);
      if (isTaxExempt) {
        // Fix the DB while we're at it
        await estimate.update({ taxExempt: true, taxExemptReason: 'Resale' });
      }
    }
    estimate.taxExempt = isTaxExempt;

    console.log(`[PDF] Estimate ${estimate.estimateNumber}: taxExempt=${isTaxExempt}, taxRate=${estimate.taxRate}`);

    // Recalculate totals with minimum charge logic (stored values may not include minimums)
    const pdfTotals = await calculateEstimateTotalsWithMinimums(estimate.parts, estimate);
    // Override stored totals with recalculated values for PDF rendering
    estimate.partsSubtotal = pdfTotals.partsSubtotal;
    estimate.taxAmount = pdfTotals.taxAmount;
    estimate.grandTotal = pdfTotals.grandTotal;

    console.log(`[PDF] Recalculated: subtotal=${pdfTotals.partsSubtotal}, taxAmount=${pdfTotals.taxAmount}, grandTotal=${pdfTotals.grandTotal}`);

    // Also compute minimum info for display on PDF
    const pdfLaborMinimums = await loadLaborMinimums();
    const pdfMinInfo = getMinimumInfo(estimate.parts, estimate.minimumOverride, pdfLaborMinimums);

    // Debug: log minimum calculation details
    console.log(`[PDF] Minimum check: totalLabor=${pdfMinInfo.totalLabor}, highestMinimum=${pdfMinInfo.highestMinimum}, minimumApplies=${pdfMinInfo.minimumApplies}, override=${estimate.minimumOverride}`);
    if (pdfMinInfo.minimumApplies) {
      console.log(`[PDF] Minimum adjustment: adjustedLabor=${pdfMinInfo.adjustedLabor}, laborDifference=${pdfMinInfo.laborDifference}, rule=${pdfMinInfo.highestMinRule?.label}`);
    }
    estimate.parts.forEach(p => {
      const size = getPartSize(p);
      const matchedRule = getLaborMinimum(p, pdfLaborMinimums);
      console.log(`[PDF] Part ${p.partNumber}: type=${p.partType}, size=${size}, laborTotal=${p.laborTotal}, partTotal=${p.partTotal}, qty=${p.quantity}, matchedRule=${matchedRule?.label || 'none'} (min=${matchedRule?.minimum || 'N/A'})`);
    });

    // Square fees are hardcoded: In-Person 2.6% + $0.15, Manual 3.5% + $0.15

    // Generate PDF using PDFKit
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'LETTER', bufferPages: true });

    // Register custom font for company name
    const yellowcakePath = path.join(__dirname, '../assets/fonts/Yellowcake-Regular.ttf');
    try {
      if (fs.existsSync(yellowcakePath)) {
        doc.registerFont('Yellowcake', yellowcakePath);
      }
    } catch (e) {
      console.log('Yellowcake font not found, using Helvetica fallback');
    }

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
        year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Los_Angeles'
      });
    };

    // Merge formData into parts
    const mergedParts = estimate.parts.map(p => {
      const obj = p.toJSON ? p.toJSON() : { ...p };
      if (obj.formData && typeof obj.formData === 'object') {
        Object.assign(obj, obj.formData);
      }
      return refreshDerivedFields(obj);
    });

    // Part type labels
    const PART_LABELS = {
      plate_roll: 'Plate Roll', angle_roll: 'Angle Roll', pipe_roll: 'Pipes/Tubes/Round',
      tube_roll: 'Sq/Rect Tube Roll', channel_roll: 'Channel Roll', beam_roll: 'Beam Roll',
      flat_bar: 'Flat Bar Roll', flat_stock: 'Flat Stock', cone_roll: 'Cone Roll',
      tee_bar: 'Tee Bar Roll', press_brake: 'Press Brake', fab_service: 'Fabrication Service', shop_rate: 'Shop Rate', other: 'Other'
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
        doc.image(logoPath, 50, 22, { width: 65 });
      }
    } catch (e) {
      console.log('Logo not found, using text header');
    }

    // Company name using custom Yellowcake font
    let hasYellowcake = false;
    try {
      if (fs.existsSync(yellowcakePath)) {
        hasYellowcake = true;
      }
    } catch (e) {}
    if (hasYellowcake) {
      doc.fontSize(15).fillColor(darkColor).font('Yellowcake').text('Carolina Rolling Co. Inc.', 130, 32, { lineBreak: false });
    } else {
      doc.fontSize(15).fillColor(darkColor).font('Helvetica-Bold').text('CAROLINA ROLLING CO. INC.', 130, 32, { lineBreak: false });
    }
    doc.font('Helvetica').fontSize(8.5).fillColor(grayColor);
    doc.text('9152 Sonrisa St., Bellflower, CA 90706', 130, 52, { lineBreak: false });
    doc.text('Phone: (562) 633-1044  |  Email: keepitrolling@carolinarolling.com', 130, 63, { lineBreak: false });
    
    // ESTIMATE + number + date — top right corner
    doc.fontSize(16).fillColor(primaryColor).font('Helvetica-Bold');
    doc.text('ESTIMATE', 350, 32, { width: 212, align: 'right', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor);
    doc.text(estimate.estimateNumber, 350, 52, { width: 212, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(grayColor);
    doc.text(`Date: ${formatDate(estimate.createdAt)}`, 350, 65, { width: 212, align: 'right', lineBreak: false });
    if (estimate.validUntil) {
      doc.text(`Valid Until: ${formatDate(estimate.validUntil)}`, 350, 76, { width: 212, align: 'right', lineBreak: false });
    }

    // Divider line
    doc.strokeColor(lightGray).lineWidth(1).moveTo(50, 90).lineTo(562, 90).stroke();

    // ========== CLIENT INFO ==========
    let yPos = 102;
    doc.fontSize(10).fillColor(primaryColor).font('Helvetica-Bold').text('PREPARED FOR:', 50, yPos, { lineBreak: false });
    doc.font('Helvetica');
    yPos += 16;
    doc.fontSize(12).fillColor(darkColor).font('Helvetica-Bold').text(estimate.clientName, 50, yPos, { lineBreak: false });
    doc.font('Helvetica');
    yPos += 16;
    if (estimate.contactName) {
      doc.fontSize(10).fillColor(grayColor).text(`Attn: ${estimate.contactName}`, 50, yPos, { lineBreak: false });
      yPos += 13;
    }
    if (estimate.contactEmail) { doc.text(estimate.contactEmail, 50, yPos, { lineBreak: false }); yPos += 13; }
    if (estimate.contactPhone) { doc.text(estimate.contactPhone, 50, yPos, { lineBreak: false }); yPos += 13; }

    // Tax Exempt Badge (right side)
    if (estimate.taxExempt) {
      doc.fontSize(10).fillColor('#c62828').font('Helvetica-Bold')
        .text('TAX EXEMPT', 400, 102, { align: 'right', width: 112, lineBreak: false });
      doc.font('Helvetica');
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

    doc.fontSize(12).fillColor(primaryColor).text('SERVICES & MATERIALS', 50, yPos, { lineBreak: false });
    yPos += 25;

    // Table header
    doc.fontSize(8).fillColor(grayColor);
    doc.text('ITEM', 50, yPos, { lineBreak: false });
    doc.text('DESCRIPTION', 85, yPos, { lineBreak: false });
    doc.text('QTY', 400, yPos, { width: 30, align: 'center', lineBreak: false });
    doc.text('UNIT', 440, yPos, { width: 50, align: 'right', lineBreak: false });
    doc.text('AMOUNT', 500, yPos, { width: 62, align: 'right', lineBreak: false });
    yPos += 12;
    doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
    yPos += 8;

    // Parts - group services under their parent part
    const sortedAll = mergedParts.sort((a, b) => a.partNumber - b.partNumber);
    const regularParts = sortedAll.filter(p => !['fab_service', 'shop_rate'].includes(p.partType) || !p._linkedPartId);
    const servicePartsArr = sortedAll.filter(p => ['fab_service', 'shop_rate'].includes(p.partType) && p._linkedPartId);
    const sortedParts = [];
    const usedSvcIds = new Set();
    regularParts.forEach(rp => {
      sortedParts.push(rp);
      servicePartsArr.forEach(sp => {
        if (String(sp._linkedPartId) === String(rp.id) && !usedSvcIds.has(sp.id)) {
          sortedParts.push(sp);
          usedSvcIds.add(sp.id);
        }
      });
    });
    servicePartsArr.forEach(sp => { if (!usedSvcIds.has(sp.id)) sortedParts.push(sp); });

    for (const part of sortedParts) {
      if (yPos > 680) { doc.addPage(); yPos = 50; }

      let partLabel = PART_LABELS[part.partType] || part.partType;
      if (part.partType === 'flat_bar' && (part.formData?._barShape === 'square' || part._barShape === 'square')) {
        partLabel = 'Square Bar Roll';
      }
      const qty = parseInt(part.quantity) || 1;
      const matCost = parseFloat(part.materialTotal) || 0;
      const matMarkup = parseFloat(part.materialMarkupPercent) || 0;
      const matEachRaw = matCost * (1 + matMarkup / 100);
      // Apply rounding
      const rounding = part.formData?._materialRounding || part._materialRounding || 'none';
      let matEach = matEachRaw;
      if (rounding === 'dollar' && matEach > 0) matEach = Math.ceil(matEach);
      if (rounding === 'five' && matEach > 0) matEach = Math.ceil(matEach / 5) * 5;
      // Show original labor per unit (no minimum adjustment on line items)
      const labEach = parseFloat(part.laborTotal) || 0;
      const unitPrice = matEach + labEach;
      const lineTotal = unitPrice * qty;

      // Build clean description lines
      const descLines = [];

      // Client part number
      if (part.clientPartNumber) {
        descLines.push(`Client Part#: ${part.clientPartNumber}`);
      }

      // Material description - for cones, always rebuild from fields to avoid stale/garbled data
      if (part.partType === 'cone_roll') {
        const fd = part.formData || {};
        const thk = part.thickness || fd.thickness || '';
        const ldType = (fd._coneLargeDiaType || 'inside') === 'inside' ? 'ID' : (fd._coneLargeDiaType === 'outside' ? 'OD' : 'CLD');
        const sdType = (fd._coneSmallDiaType || 'inside') === 'inside' ? 'ID' : (fd._coneSmallDiaType === 'outside' ? 'OD' : 'CLD');
        const ld = parseFloat(fd._coneLargeDia) || 0;
        const sd = parseFloat(fd._coneSmallDia) || 0;
        const vh = parseFloat(fd._coneHeight) || 0;
        const grade = part.material || '';
        const origin = fd._materialOrigin || '';
        let coneLine = thk ? thk + ' ' : '';
        coneLine += 'Cone - ';
        if (ld && sd && vh) coneLine += ld.toFixed(1) + '" ' + ldType + ' x ' + sd.toFixed(1) + '" ' + sdType + ' x ' + vh.toFixed(1) + '" VH';
        if (grade) coneLine += ' ' + grade;
        if (origin) coneLine += ' ' + origin;
        descLines.push(coneLine);
      } else if (part.materialDescription) {
        descLines.push(part.materialDescription);
      } else {
        // Build from individual fields
        const specs = [];
        if (part.material) specs.push(part.material);
        if (part.sectionSize) {
          const sizeDisplay = part.partType === 'pipe_roll' && part._schedule ? part.sectionSize.replace(' Pipe', ` Sch ${part._schedule} Pipe`) : part.sectionSize;
          specs.push(sizeDisplay);
        }
        if (part.thickness) specs.push(part.thickness);
        if (part.width) specs.push(`${part.width}" wide`);
        if (part.length) specs.push(part.length.toString().includes("'") || part.length.toString().includes('"') ? part.length : `${part.length}" long`);
        if (part.outerDiameter) specs.push(`${part.outerDiameter}" OD`);
        if (part.wallThickness && part.wallThickness !== 'SOLID') specs.push(`${part.wallThickness}" wall`);
        if (part.wallThickness === 'SOLID') specs.push('Solid Bar');
        if (specs.length) descLines.push(specs.join(' x '));
      }

      // Rolling info
      const rollVal = part.diameter || part.radius;
      if (rollVal) {
        const specLabel = getSpecLabel(part);
        const dirLabel = getRollDirLabel(part);
        let rollLine = `Roll: ${rollVal}" ${specLabel}`;
        if (dirLabel) rollLine += ` (${dirLabel})`;
        if (part.arcDegrees) rollLine += ` | Arc: ${part.arcDegrees} deg`;
        descLines.push(rollLine);
      }

      // Complete rings note
      if (part._completeRings && part._ringsNeeded) {
        descLines.push(`${part._ringsNeeded} complete ring(s) required`);
      }

      // Orientation option text
      if ((part.partType === 'angle_roll' || part.partType === 'channel_roll') && part._orientationOption) {
        const combo = part.rollType === 'easy_way' ? 'EW-OD' : 'HW-ID';
        descLines.push(`Orientation: ${combo} Option ${part._orientationOption}`);
      }

      // Cone info: type + segments + layout file
      if (part.partType === 'cone_roll') {
        const cType = part._coneType || 'concentric';
        if (cType === 'eccentric') {
          descLines.push('Eccentric' + (part._coneEccentricAngle ? ' = ' + part._coneEccentricAngle + ' deg' : ''));
        } else {
          descLines.push('Concentric');
        }
        // Segment info only if segmented (>1 radial segments)
        const rSegs = parseInt(part._coneRadialSegments) || 1;
        if (rSegs > 1) {
          const layerPrefix = (part._coneSegmentDetails && part._coneSegmentDetails.length > 1) ? part._coneSegmentDetails.length + ' layers x ' : '';
          descLines.push(layerPrefix + rSegs + ' @ ' + (360 / rSegs).toFixed(0) + ' deg');
        }
      }

      // Material source (skip for fab services and shop rate)
      if (!['fab_service', 'shop_rate'].includes(part.partType)) {
        if (part.materialSource === 'customer_supplied') {
          descLines.push(`Material supplied by: ${estimate.clientName || 'Customer'}`);
        } else if (part.materialSource === 'in_stock') {
          descLines.push('Material supplied by: Carolina Rolling Company');
        } else {
          descLines.push('Material supplied by: Carolina Rolling Company');
        }
      }

      // Layout filename (cone cut file reference)
      if (part.partType === 'cone_roll' && part.cutFileReference) {
        descLines.push(`Layout Filename: ${part.cutFileReference}`);
      }

      // Material/Rolling pricing breakdown
      if (matEach > 0) descLines.push(`Material: ${formatCurrency(matEach)}`);
      if (labEach > 0) descLines.push(`${part.partType === 'fab_service' ? 'Service' : part.partType === 'shop_rate' ? 'Shop Rate' : (part.partType === 'flat_stock' ? 'Handling' : 'Rolling')}: ${formatCurrency(labEach)}`);

      // Shop rate warning
      if (part.partType === 'shop_rate') {
        descLines.push('* Pricing based on estimated hours - actual cost may vary');
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

      const isLinkedSvc = ['fab_service', 'shop_rate'].includes(part.partType) && part._linkedPartId;
      const linkedParentPart = isLinkedSvc ? sortedParts.find(p => String(p.id) === String(part._linkedPartId)) : null;
      const xOffset = isLinkedSvc ? 20 : 0;

      // Service background tint
      if (isLinkedSvc) {
        doc.save().rect(50 + xOffset, yPos - 2, 512 - xOffset, rowHeight + 4).fill('#e0e0e0').restore();
      }

      // Part number
      doc.fontSize(9).fillColor(isLinkedSvc ? '#444' : primaryColor).font('Helvetica-Bold');
      doc.text(isLinkedSvc ? '+' : `#${part.partNumber}`, 50 + xOffset, yPos, { lineBreak: false });

      // Part type + description  
      doc.fontSize(8).fillColor(isLinkedSvc ? '#444' : darkColor).font('Helvetica-Bold');
      doc.text(partLabel + (isLinkedSvc && linkedParentPart ? ` (for Part #${linkedParentPart.partNumber})` : ''), 85 + xOffset, yPos, { lineBreak: false });
      doc.font('Helvetica').fillColor(grayColor);
      doc.text(description, 85 + xOffset, yPos + 11, { width: 300 - xOffset });
      
      // Quantity
      doc.fillColor(darkColor).text(qty.toString(), 400, yPos, { width: 30, align: 'center', lineBreak: false });
      
      // Unit price
      doc.text(formatCurrency(unitPrice), 440, yPos, { width: 50, align: 'right', lineBreak: false });

      // Line total
      doc.font('Helvetica-Bold').text(formatCurrency(lineTotal), 500, yPos, { width: 62, align: 'right', lineBreak: false });
      doc.font('Helvetica');

      yPos += rowHeight + 4;

      // Orientation diagram image for angle/channel rolls
      if ((part.partType === 'angle_roll' || part.partType === 'channel_roll') && part._orientationOption) {
        const imgPrefix = part.partType === 'channel_roll' ? 'Channel' : '';
        const imgFile = part.rollType === 'easy_way' 
          ? `${imgPrefix}EWODOp${part._orientationOption}.png` 
          : `${imgPrefix}HWIDOp${part._orientationOption}.png`;
        const imgPath = path.join(__dirname, '..', 'assets', 'angle-orientation', imgFile);
        try {
          if (fs.existsSync(imgPath)) {
            if (yPos + 90 > 700) { doc.addPage(); yPos = 50; }
            doc.image(imgPath, 85, yPos, { width: 160 });
            doc.fontSize(7).fillColor(grayColor).text(
              `${part.rollType === 'easy_way' ? 'EW-OD' : 'HW-ID'} Option ${part._orientationOption}`,
              85, yPos + 72, { width: 160, align: 'center' }
            );
            yPos += 88;
          }
        } catch (e) { /* image not found, skip */ }
      }
      
      // Light divider
      doc.strokeColor('#eee').lineWidth(0.5).moveTo(85, yPos).lineTo(562, yPos).stroke();
      yPos += 6;
    }

    // ========== TRUCKING ==========
    if (parseFloat(estimate.truckingCost) > 0 || estimate.truckingDescription) {
      if (yPos > 680) { doc.addPage(); yPos = 50; }
      
      doc.fontSize(9).fillColor(darkColor).font('Helvetica-Bold').text('Trucking / Delivery', 85, yPos, { lineBreak: false });
      doc.font('Helvetica');
      if (estimate.truckingDescription) {
        doc.fontSize(8).fillColor(grayColor).text(estimate.truckingDescription, 85, yPos + 11, { width: 300 });
      }
      doc.fontSize(8).fillColor(darkColor).font('Helvetica-Bold')
        .text(formatCurrency(estimate.truckingCost), 500, yPos, { width: 62, align: 'right', lineBreak: false });
      doc.font('Helvetica');
      yPos += 30;
    }

    // ========== TOTALS ==========
    if (yPos > 620) { doc.addPage(); yPos = 50; }

    yPos += 10;
    doc.strokeColor(lightGray).lineWidth(1).moveTo(350, yPos).lineTo(562, yPos).stroke();
    yPos += 15;

    // Minimum charge adjustment (the difference between minimum and actual labor)
    if (pdfMinInfo.minimumApplies && pdfMinInfo.laborDifference > 0) {
      doc.fontSize(8).fillColor('#e65100').text(
        `Minimum Labor Charge (${pdfMinInfo.highestMinRule?.label || ''})`,
        350, yPos, { lineBreak: false }
      );
      doc.text(`+${formatCurrency(pdfMinInfo.laborDifference)}`, 480, yPos, { align: 'right', width: 82, lineBreak: false });
      doc.fillColor(darkColor);
      yPos += 16;
    }

    // Subtotal
    doc.fontSize(10).fillColor(grayColor).text('Subtotal:', 350, yPos, { lineBreak: false });
    doc.fillColor(darkColor).text(formatCurrency(estimate.partsSubtotal), 480, yPos, { align: 'right', width: 82, lineBreak: false });
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
      doc.fillColor('#c62828').text(discountDisplay, 350, yPos, { lineBreak: false });
      doc.text(`-${formatCurrency(discountValue)}`, 480, yPos, { align: 'right', width: 82, lineBreak: false });
      doc.fillColor(darkColor);
      yPos += 18;
    }

    // Trucking
    if (parseFloat(estimate.truckingCost) > 0) {
      doc.fillColor(grayColor).text('Trucking:', 350, yPos, { lineBreak: false });
      doc.fillColor(darkColor).text(formatCurrency(estimate.truckingCost), 480, yPos, { align: 'right', width: 82, lineBreak: false });
      yPos += 18;
    }

    // Tax
    if (estimate.taxExempt) {
      doc.fillColor(grayColor).text('Tax:', 350, yPos, { lineBreak: false });
      doc.fillColor('#c62828').text('EXEMPT', 480, yPos, { align: 'right', width: 82, lineBreak: false });
      yPos += 18;
    } else if (parseFloat(estimate.taxAmount) > 0) {
      doc.fillColor(grayColor).text(`Tax (${estimate.taxRate}%):`, 350, yPos, { lineBreak: false });
      doc.fillColor(darkColor).text(formatCurrency(estimate.taxAmount), 480, yPos, { align: 'right', width: 82, lineBreak: false });
      yPos += 18;
    }

    // Grand Total
    doc.strokeColor(lightGray).lineWidth(1).moveTo(350, yPos).lineTo(562, yPos).stroke();
    yPos += 10;
    doc.fontSize(14).fillColor(primaryColor).font('Helvetica-Bold').text('TOTAL:', 350, yPos, { lineBreak: false });
    doc.text(formatCurrency(estimate.grandTotal), 480, yPos, { align: 'right', width: 82, lineBreak: false });
    doc.font('Helvetica');
    yPos += 30;

    // ========== CREDIT CARD SECTION ==========
    if (yPos > 680) { doc.addPage(); yPos = 50; }

    doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
    yPos += 15;

    const grandTotal = parseFloat(estimate.grandTotal) || 0;
    const ccInPersonFee = (grandTotal * 2.6 / 100) + 0.15;
    const ccInPersonTotal = grandTotal + ccInPersonFee;
    const ccManualFee = (grandTotal * 3.5 / 100) + 0.15;
    const ccManualTotal = grandTotal + ccManualFee;

    doc.fontSize(9).font('Helvetica-Bold').fillColor(darkColor);
    doc.text('Total with Credit Card Fees', 50, yPos, { align: 'right', width: 512, lineBreak: false });
    doc.font('Helvetica');
    yPos += 14;
    
    doc.fontSize(9).fillColor(darkColor);
    doc.text(`In-Person (2.6% + $0.15): ${formatCurrency(ccInPersonTotal)}`, 50, yPos, { align: 'right', width: 512, lineBreak: false });
    yPos += 13;
    doc.text(`Manual (3.5% + $0.15): ${formatCurrency(ccManualTotal)}`, 50, yPos, { align: 'right', width: 512, lineBreak: false });
    yPos += 25;

    // ========== NOTES ==========
    if (estimate.notes) {
      if (yPos > 680) { doc.addPage(); yPos = 50; }
      
      doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
      yPos += 15;
      
      doc.fontSize(10).fillColor(primaryColor).text('NOTES:', 50, yPos, { lineBreak: false });
      yPos += 15;
      doc.fontSize(9).fillColor(grayColor).text(estimate.notes, 50, yPos, { width: 500 });
    }

    // ========== FOOTER ==========
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      // Temporarily remove bottom margin so writing near page bottom doesn't auto-create pages
      const savedBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(grayColor);
      doc.text(
        'Carolina Rolling Co. Inc. | 9152 Sonrisa St., Bellflower, CA 90706 | (562) 633-1044 | keepitrolling@carolinarolling.com',
        50, 745, { align: 'center', width: 512, lineBreak: false }
      );
      doc.text(
        `${estimate.estimateNumber} | Page ${i + 1} of ${pageCount}`,
        50, 756, { align: 'center', width: 512, lineBreak: false }
      );
      doc.page.margins.bottom = savedBottomMargin;
    }

    doc.end();

  } catch (error) {
    console.error('PDF generation error:', error);
    if (!res.headersSent) {
      next(error);
    } else {
      res.end();
    }
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

    const { clientPurchaseOrderNumber, requestedDueDate, promisedDate, notes, materialReceived, customDRNumber } = req.body;

    // Get DR number - custom or auto
    let drNumber;
    if (customDRNumber) {
      // Check if custom DR already exists
      const existingDR = await DRNumber.findOne({ where: { drNumber: parseInt(customDRNumber) }, transaction });
      const existingWO = await WorkOrder.findOne({ where: { drNumber: parseInt(customDRNumber) }, transaction });
      if (existingDR || existingWO) {
        await transaction.rollback();
        return res.status(400).json({ error: { message: `DR-${customDRNumber} already exists` } });
      }
      drNumber = parseInt(customDRNumber);
    } else {
      drNumber = await getNextDRNumber(transaction);
    }

    // Create DR number record
    const drRecord = await DRNumber.create({
      drNumber,
      status: 'active'
    }, { transaction });

    // Generate order number
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const orderNumber = `WO-${year}${month}${day}-${random}`;

    // Create work order from estimate using shared utility
    const { buildWorkOrderFromEstimate, buildWorkOrderPartFromEstimate } = require('../services/pricing');
    
    const woData = buildWorkOrderFromEstimate(estimate, {
      orderNumber,
      drNumber,
      clientPurchaseOrderNumber: clientPurchaseOrderNumber || null,
      notes: notes || estimate.notes,
      status: materialReceived ? 'received' : 'waiting_for_materials',
      receivedAt: materialReceived ? new Date() : null,
      allMaterialReceived: materialReceived ? true : false,
      requestedDueDate: requestedDueDate || null,
      promisedDate: promisedDate || null
    });

    const workOrder = await WorkOrder.create(woData, { transaction });

    // Update DR record with work order ID
    await drRecord.update({ workOrderId: workOrder.id }, { transaction });

    // Create work order parts from estimate parts using shared utility
    const estimateToWoPartIdMap = {};
    for (const estimatePart of estimate.parts) {
      try {
        const partData = buildWorkOrderPartFromEstimate(estimatePart);
        partData.workOrderId = workOrder.id;
        
        console.log(`[convert] Part #${partData.partNumber} (${partData.partType}): labor=${partData.laborTotal}, material=${partData.materialTotal}, total=${partData.partTotal}`);

        const workOrderPart = await WorkOrderPart.create(partData, { transaction });

        // Track estimate part ID → work order part ID mapping
        estimateToWoPartIdMap[estimatePart.id] = workOrderPart.id;

        // Copy part files to work order part files
        if (estimatePart.files && estimatePart.files.length > 0) {
          for (const file of estimatePart.files) {
            // Normalize estimate fileType values to work order values
            let fileType = file.fileType || 'other';
            const ext = (file.originalName || file.filename || '').toLowerCase();
            if (ext.endsWith('.pdf') || fileType === 'drawing' || fileType === 'print') {
              fileType = 'pdf_print';
            } else if (ext.endsWith('.stp') || ext.endsWith('.step') || fileType === 'step_file') {
              fileType = 'step_file';
            } else if (fileType === 'specification') {
              fileType = 'other';
            }
            
            await WorkOrderPartFile.create({
              workOrderPartId: workOrderPart.id,
              filename: file.filename,
              originalName: file.originalName,
              mimeType: file.mimeType,
              size: file.size,
              url: file.url,
              cloudinaryId: file.cloudinaryId,
              fileType
            }, { transaction });
          }
        }
      } catch (partErr) {
        console.error(`Failed to create WO part #${estimatePart.partNumber} (type: ${estimatePart.partType}):`, partErr.message);
        if (partErr.errors) partErr.errors.forEach(e => console.error(`  Validation: ${e.path} - ${e.message}`));
        throw new Error(`Failed on part #${estimatePart.partNumber} (${estimatePart.partType}): ${partErr.message}`);
      }
    }

    // Second pass: remap _linkedPartId in formData for service parts
    // The estimate's _linkedPartId points to estimate part IDs - we need to update to WO part IDs
    for (const estimatePart of estimate.parts) {
      const fd = estimatePart.formData && typeof estimatePart.formData === 'object' ? estimatePart.formData : {};
      if (fd._linkedPartId && estimateToWoPartIdMap[fd._linkedPartId]) {
        const woPartId = estimateToWoPartIdMap[estimatePart.id];
        const newLinkedId = estimateToWoPartIdMap[fd._linkedPartId];
        const updatedFormData = { ...fd, _linkedPartId: newLinkedId };
        await WorkOrderPart.update(
          { formData: updatedFormData },
          { where: { id: woPartId }, transaction }
        );
        console.log(`[convert] Remapped _linkedPartId for part #${estimatePart.partNumber}: ${fd._linkedPartId} → ${newLinkedId}`);
      }
    }

    // Update estimate status - use 'accepted' and link to work order
    const statusUpdates = {
      status: 'accepted',
      workOrderId: workOrder.id
    };
    if (!estimate.sentAt) statusUpdates.sentAt = new Date();
    if (!estimate.acceptedAt) statusUpdates.acceptedAt = new Date();
    await estimate.update(statusUpdates, { transaction });

    await transaction.commit();

    // Log activity
    await logActivity(
      'created',
      'work_order',
      workOrder.id,
      `DR-${drNumber}`,
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
      message: `Work order DR-${drNumber} created successfully`
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Convert to work order error:', error);
    // Include validation details if available
    const details = error.errors ? error.errors.map(e => `${e.path}: ${e.message}`).join(', ') : '';
    const msg = details 
      ? `Validation error: ${details}` 
      : (error.message || 'Failed to convert estimate');
    res.status(error.message?.includes('Validation') ? 400 : 500).json({ error: { message: msg } });
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

// POST /api/estimates/:id/ai-parse-document - Upload image/PDF and parse with AI
router.post('/:id/ai-parse-document', upload.single('file'), async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: { message: 'ANTHROPIC_API_KEY not configured' } });
    }

    const estimate = await Estimate.findByPk(req.params.id, {
      include: [{ model: EstimatePart, as: 'parts' }]
    });
    if (!estimate) return res.status(404).json({ error: { message: 'Estimate not found' } });

    if (!req.file) return res.status(400).json({ error: { message: 'No file uploaded' } });

    const filePath = req.file.path;
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    const ext = path.extname(req.file.originalname).toLowerCase();
    const clientName = estimate.clientName || 'Unknown Client';

    // Load general AI notes
    const generalNotesSetting = await AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
    const generalNotes = generalNotesSetting?.value || '';

    // Load client-specific notes
    let clientNotes = '';
    if (estimate.clientId) {
      const client = await Client.findByPk(estimate.clientId);
      clientNotes = client?.emailScanParsingNotes || '';
    }

    // Build the content array for Claude
    const contentItems = [];

    if (ext === '.pdf') {
      contentItems.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64Data }
      });
    } else {
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      const mediaType = mimeMap[ext] || 'image/jpeg';
      contentItems.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64Data }
      });
    }

    contentItems.push({
      type: 'text',
      text: `This is a document from client: ${clientName}. Parse it as a request for quote (RFQ) for metal rolling, forming, or fabrication services. Extract all parts, dimensions, materials, and quantities. ${req.body.additionalNotes || ''}`
    });

    // System prompt — reuse from email scanner with modifications for document parsing
    const systemPrompt = `You are an expert at reading drawings, RFQs, purchase orders, and specification documents for metal rolling, forming, and fabrication.
You work for Carolina Rolling Company, a metal rolling shop.

Read the uploaded document carefully and extract ALL parts that need to be quoted. This could be a drawing, a table of parts, a letter requesting services, or a spec sheet.

COMMON ABBREVIATIONS:
- OD = outer diameter, ID = inner diameter
- R/T or R&T = rolled and tacked (tack welded along seam)
- V/H = vertical height (for cones), EW = easy way, HW = hard way
- ISOF = inside out flange

PART TYPES:
- plate_roll: Flat plate rolled into cylinder/shell. Fields: material, thickness, width (shell height), length, outerDiameter, arcDegrees (360=full cylinder), rollType (easy_way/hard_way)
- shaped_plate: Round plates, donuts, custom shapes (NOT rolled). Fields: material, thickness, outerDiameter, innerDiameter (donuts), donutPurpose
- cone_roll: Conical/frustum. Fields: material, thickness, outerDiameter (large end), diameter (small end), width (slant height)
- pipe_roll: Pipe/tube bending. Fields: material, outerDiameter, wallThickness, radius, arcDegrees
- angle_roll: Angle iron. Fields: material, legSize (e.g. "3x3"), thickness, radius/diameter, arcDegrees
- channel_roll: C-channel. Fields: material, sectionSize (e.g. "C8x11.5"), radius/diameter, arcDegrees
- beam_roll: I/H-beam. Fields: material, sectionSize (e.g. "W8x31"), radius/diameter, arcDegrees
- tube_roll: Square/rect tube. Fields: material, sectionSize (e.g. "4x4x1/4"), radius/diameter, arcDegrees
- flat_bar: Flat/square bar. Fields: material, barSize (e.g. "4x1/2"), radius/diameter, arcDegrees
- tee_bar: Structural tee. Fields: material, sectionSize (e.g. "WT5x15"), radius/diameter, arcDegrees
- press_brake: Press brake forming. Fields: material, thickness, description
- flat_stock: Ship flat (no rolling). Fields: material, thickness, width, length, description
- fab_service: Welding/fitting. Fields: fabType, parentPartIndex, description
- shop_rate: Hourly work. Fields: description, laborHours, laborRate

Thickness format: Use fractions like '1/2"', '3/8"'. Only decimals if no fraction match.

${generalNotes ? `GENERAL SHOP NOTES:\n${generalNotes}\n` : ''}
${clientNotes ? `CLIENT-SPECIFIC NOTES:\n${clientNotes}\n` : ''}

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "parts": [
    {
      "partType": "plate_roll",
      "quantity": 1,
      "material": "A36",
      "thickness": "1/2\\"",
      "width": "120",
      "length": "452",
      "outerDiameter": "144",
      "radius": null,
      "arcDegrees": "360",
      "rollType": "easy_way",
      "legSize": null,
      "sectionSize": null,
      "barSize": null,
      "wallThickness": null,
      "innerDiameter": null,
      "specialInstructions": "",
      "clientPartNumber": "",
      "description": "auto-generated material description",
      "missingFields": ["thickness"],
      "missingFieldNotes": "No thickness given"
    }
  ],
  "notes": "any delivery or project notes found",
  "documentType": "drawing" or "rfq" or "spec_sheet" or "po" or "other",
  "aiNotes": "summary of what was found and any issues"
}`;

    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: contentItems }]
    });

    const https = require('https');
    const responseText = await new Promise((resolve, reject) => {
      const apiReq = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      }, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          if (apiRes.statusCode !== 200) {
            console.error(`[AI-Parse] API error ${apiRes.statusCode}: ${data.substring(0, 500)}`);
            reject(new Error(`AI API ${apiRes.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      apiReq.on('error', reject);
      apiReq.write(requestBody);
      apiReq.end();
    });

    const data = JSON.parse(responseText);
    const text = data.content?.[0]?.text || '';
    console.log(`[AI-Parse] Response (first 300): ${text.substring(0, 300)}`);

    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

    // Use buildFormData from email scanner to convert to our form format
    const { buildFormData } = require('../services/emailScanner');
    const partsWithFormData = (parsed.parts || []).map((p, i) => {
      const formData = buildFormData(p);
      return {
        ...p,
        partNumber: (estimate.parts?.length || 0) + i + 1,
        formData
      };
    });

    // Cleanup uploaded file
    try { fs.unlinkSync(filePath); } catch {}

    console.log(`[AI-Parse] Parsed ${partsWithFormData.length} parts from ${req.file.originalname}`);

    res.json({
      data: {
        parts: partsWithFormData,
        notes: parsed.notes || '',
        documentType: parsed.documentType || 'unknown',
        aiNotes: parsed.aiNotes || '',
        fileName: req.file.originalname
      },
      message: `Parsed ${partsWithFormData.length} parts from document`
    });
  } catch (error) {
    // Cleanup on error
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    console.error('[AI-Parse] Error:', error.message);
    next(error);
  }
});

module.exports = router;
