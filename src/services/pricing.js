/**
 * Shared pricing and conversion utilities
 * Single source of truth for pricing calculations and estimate→WO data transfer
 */

const { AppSettings } = require('../models');

// ==================== PRICING ====================

// Round up material cost based on rounding setting
function roundUpMaterial(value, rounding) {
  if (!rounding || rounding === 'none' || !value || value <= 0) return value;
  if (rounding === 'dollar') return Math.ceil(value);
  if (rounding === 'five') return Math.ceil(value / 5) * 5;
  return value;
}

// Calculate a single part's total cost
function calculatePartTotal(part) {
  const fd = part.formData && typeof part.formData === 'object' ? part.formData : {};
  
  // Try stored partTotal first
  const stored = parseFloat(part.partTotal);
  if (stored && stored > 0) return stored;

  // Calculate from components
  const matCost = parseFloat(part.materialTotal) || parseFloat(fd.materialTotal) || 0;
  const matMarkup = parseFloat(part.materialMarkupPercent) || parseFloat(fd.materialMarkupPercent) || 0;
  const matEach = roundUpMaterial(matCost * (1 + matMarkup / 100), fd._materialRounding);
  const labEach = parseFloat(part.laborTotal) || parseFloat(fd.laborTotal) || 0;
  const setup = parseFloat(part.setupCharge) || parseFloat(fd.setupCharge) || 0;
  const other = parseFloat(part.otherCharges) || parseFloat(fd.otherCharges) || 0;
  // Outside processing with markup
  const opCost = parseFloat(part.outsideProcessingCost) || 0;
  const opMarkup = parseFloat(part.outsideProcessingMarkupPercent) || 0;
  const opEach = Math.round(opCost * (1 + opMarkup / 100) * 100) / 100;
  const opTransport = parseFloat(part.outsideProcessingTransportCost) || 0;
  const opTransportMarkup = parseFloat(part.outsideProcessingTransportMarkupPercent) || 0;
  const opTransportEach = Math.round(opTransport * (1 + opTransportMarkup / 100) * 100) / 100;
  const qty = parseInt(part.quantity) || 1;

  return Math.round((matEach + labEach + setup + other + opEach + opTransportEach) * qty * 100) / 100;
}

// Load labor minimums from settings
async function loadLaborMinimums() {
  try {
    const setting = await AppSettings.findOne({ where: { key: 'labor_minimums' } });
    if (setting?.value) return JSON.parse(setting.value);
  } catch (e) {}
  return [];
}

// Calculate minimum labor adjustment for a set of parts
function calculateMinimumAdjustment(parts, minimumOverride, laborMinimums) {
  if (minimumOverride) return { applies: false, adjustment: 0, totalLabor: 0, minimum: 0 };
  
  let totalLabor = 0;
  let highestMin = 0;
  let highestRule = null;

  for (const part of parts) {
    if (['fab_service', 'shop_rate'].includes(part.partType)) continue;
    const fd = part.formData && typeof part.formData === 'object' ? part.formData : {};
    totalLabor += parseFloat(part.laborTotal) || parseFloat(fd.laborTotal) || 0;
    
    for (const rule of laborMinimums) {
      if (rule.partTypes && rule.partTypes.includes(part.partType)) {
        const min = parseFloat(rule.minimum) || 0;
        if (min > highestMin) {
          highestMin = min;
          highestRule = rule;
        }
      }
    }
  }

  const applies = highestMin > 0 && totalLabor < highestMin;
  return {
    applies,
    adjustment: applies ? Math.round((highestMin - totalLabor) * 100) / 100 : 0,
    totalLabor,
    minimum: highestMin,
    rule: highestRule
  };
}

// Calculate full order totals (parts + minimum + discount + tax + trucking)
async function calculateOrderTotals(parts, orderData) {
  const minimums = await loadLaborMinimums();
  
  // Parts subtotal
  let partsSubtotal = 0;
  for (const part of parts) {
    partsSubtotal += calculatePartTotal(part);
  }
  partsSubtotal = Math.round(partsSubtotal * 100) / 100;

  // Minimum labor adjustment
  const minInfo = calculateMinimumAdjustment(parts, orderData.minimumOverride, minimums);
  if (minInfo.applies) {
    partsSubtotal += minInfo.adjustment;
    partsSubtotal = Math.round(partsSubtotal * 100) / 100;
  }

  // Discount
  let discountTotal = 0;
  const discountPct = parseFloat(orderData.discountPercent) || 0;
  const discountAmt = parseFloat(orderData.discountAmount) || 0;
  if (discountPct > 0) {
    discountTotal = Math.round(partsSubtotal * discountPct / 100 * 100) / 100;
  } else if (discountAmt > 0) {
    discountTotal = discountAmt;
  }
  const afterDiscount = Math.round((partsSubtotal - discountTotal) * 100) / 100;

  // Trucking
  const trucking = parseFloat(orderData.truckingCost) || 0;

  // Tax
  const taxRate = orderData.taxExempt ? 0 : (parseFloat(orderData.taxRate) || 0);
  const taxableAmount = afterDiscount; // trucking typically not taxed
  const taxAmount = Math.round(taxableAmount * taxRate / 100 * 100) / 100;

  // Grand total
  const grandTotal = Math.round((afterDiscount + trucking + taxAmount) * 100) / 100;

  return {
    partsSubtotal,
    minimumAdjustment: minInfo.adjustment,
    minimumApplies: minInfo.applies,
    discountTotal,
    afterDiscount,
    trucking,
    taxableAmount,
    taxRate,
    taxAmount,
    grandTotal
  };
}

// ==================== ESTIMATE → WO CONVERSION FIELD MAPS ====================

// Fields that copy directly from Estimate → WorkOrder (shared column names)
const ORDER_FIELD_MAP = {
  // Client info
  clientName: 'clientName',
  clientId: 'clientId',
  contactName: 'contactName',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  // Pricing
  truckingDescription: 'truckingDescription',
  truckingCost: 'truckingCost',
  opTransports: 'opTransports',
  taxRate: 'taxRate',
  taxExempt: 'taxExempt',
  taxExemptReason: 'taxExemptReason',
  taxExemptCertNumber: 'taxExemptCertNumber',
  taxAmount: 'taxAmount',
  // Minimums & discounts
  minimumOverride: 'minimumOverride',
  minimumOverrideReason: 'minimumOverrideReason',
  discountPercent: 'discountPercent',
  discountAmount: 'discountAmount',
  discountReason: 'discountReason',
  // Notes
  notes: 'notes'
};

// Build WO data from estimate (order-level)
function buildWorkOrderFromEstimate(estimate, overrides = {}) {
  const data = {};
  for (const [estField, woField] of Object.entries(ORDER_FIELD_MAP)) {
    const val = estimate[estField];
    if (val !== undefined && val !== null) {
      data[woField] = val;
    }
  }
  // Special mappings
  data.estimateId = estimate.id;
  data.estimateNumber = estimate.estimateNumber;
  data.estimateTotal = estimate.grandTotal;
  data.subtotal = estimate.partsSubtotal;
  data.grandTotal = estimate.grandTotal;
  
  // Apply overrides (clientPurchaseOrderNumber, requestedDueDate, etc.)
  Object.assign(data, overrides);
  
  return data;
}

// Fields that copy from EstimatePart → WorkOrderPart
const PART_SHARED_FIELDS = [
  'partNumber', 'partType', 'clientPartNumber', 'heatNumber', 'cutFileReference',
  'quantity', 'material', 'thickness', 'width', 'length',
  'outerDiameter', 'wallThickness', 'sectionSize', 'rollType',
  'radius', 'diameter', 'arcDegrees', 'flangeOut',
  'specialInstructions', 'materialDescription',
  // Supplier
  'vendorId', 'supplierName', 'vendorEstimateNumber',
  // Material tracking
  'materialSource', 'materialReceived', 'materialReceivedAt',
  'materialOrdered', 'materialOrderedAt', 'materialPurchaseOrderNumber', 'inboundOrderId',
  // Pricing
  'laborTotal', 'materialUnitCost', 'materialMarkupPercent', 'materialTotal',
  'setupCharge', 'otherCharges', 'partTotal',
  // Outside Processing
  'outsideProcessingVendorId', 'outsideProcessingVendorName', 'outsideProcessingDescription',
  'outsideProcessingCost', 'outsideProcessingMarkupPercent',
  'outsideProcessingTransportCost', 'outsideProcessingTransportMarkupPercent',
  'outsideProcessingPONumber', 'outsideProcessingPOSentAt',
  // Multi-operation outside processing (JSONB array)
  'outsideProcessing',
  // RFQ contact tracking
  'rfqContactName', 'rfqContactEmail', 'rfqSentAt',
  // Form data (the big one)
  'formData'
];

// Build WO part from estimate part
function buildWorkOrderPartFromEstimate(estimatePart) {
  const data = {};
  const fd = estimatePart.formData && typeof estimatePart.formData === 'object' ? estimatePart.formData : {};

  for (const field of PART_SHARED_FIELDS) {
    let val = estimatePart[field];
    // For pricing fields, fall back to formData if top-level is empty
    if ((val === null || val === undefined || val === '' || val === 0) && fd[field] !== undefined) {
      val = fd[field];
    }
    // Special case: if outsideProcessing is an empty array but formData has a populated one, use formData
    if (field === 'outsideProcessing' && Array.isArray(val) && val.length === 0 && Array.isArray(fd[field]) && fd[field].length > 0) {
      val = fd[field];
    }
    if (val !== undefined) {
      data[field] = val;
    }
  }

  // Extra fields from formData that WO model has but estimate doesn't store at top level
  if (!data.laborRate && fd.laborRate) data.laborRate = fd.laborRate;
  if (!data.laborHours && fd.laborHours) data.laborHours = fd.laborHours;

  // Default materialSource for service types
  if (!data.materialSource) {
    if (['fab_service', 'shop_rate'].includes(data.partType)) {
      data.materialSource = 'customer_supplied';
    } else {
      data.materialSource = estimatePart.weSupplyMaterial ? 'we_order' : 'customer_supplied';
    }
  }

  // Recalculate laborTotal and partTotal from source values to ensure the WO part always
  // has correct top-level pricing columns. The estimate part may store the base labor in
  // formData._baseLaborTotal (set by the form components). Use that when available, then
  // fall back to the stored laborTotal column. This mirrors what handleSavePart does on resave.
  const EA_PRICED = ['plate_roll', 'shaped_plate', 'angle_roll', 'flat_stock', 'pipe_roll',
    'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake',
    'cone_roll', 'fab_service', 'shop_rate'];
  if (EA_PRICED.includes(data.partType)) {
    const qty = parseInt(data.quantity) || 1;
    const matCost = parseFloat(data.materialTotal) || 0;
    // Default markup to 20% if not set — matches frontend display behavior
    const matMarkupRaw = parseFloat(data.materialMarkupPercent);
    const matMarkup = isNaN(matMarkupRaw) ? 20 : matMarkupRaw;
    const matEachRaw = Math.round(matCost * (1 + matMarkup / 100) * 100) / 100;
    // Apply material rounding if specified
    const rounding = fd._materialRounding || 'none';
    const matEach = rounding === 'dollar' && matEachRaw > 0 ? Math.ceil(matEachRaw)
      : rounding === 'five' && matEachRaw > 0 ? Math.ceil(matEachRaw / 5) * 5
      : matEachRaw;
    // Use _baseLaborTotal from formData when available — it holds the pre-markup rolling cost
    const baseLabEach = parseFloat(fd._baseLaborTotal) || parseFloat(data.laborTotal) || 0;
    // Bundle outside processing cost into labor line (same as estimate display)
    const ops = Array.isArray(data.outsideProcessing) ? data.outsideProcessing : [];
    const opEnabled = ops.length > 0;
    let opCostLot = 0, opProfitLot = 0;
    ops.forEach(op => {
      const cost = parseFloat(op.costPerPart) || 0;
      const expedite = parseFloat(op.expediteCost) || 0;
      const markup = parseFloat(op.markup) || 0;
      opCostLot += (cost + expedite) * qty;
      opProfitLot += cost * (markup / 100) * qty;
    });
    const opCostPerPart = qty > 0 ? opCostLot / qty : 0;
    const opProfitPerPart = qty > 0 ? opProfitLot / qty : 0;
    const effectiveBase = opEnabled ? 0 : baseLabEach;
    const laborEach = effectiveBase + opProfitPerPart;
    data.laborTotal = parseFloat(laborEach.toFixed(2));
    data.partTotal = parseFloat(((matEach + laborEach + opCostPerPart) * qty).toFixed(2));
  }

  // Default status
  data.status = 'pending';

  return data;
}

module.exports = {
  roundUpMaterial,
  calculatePartTotal,
  loadLaborMinimums,
  calculateMinimumAdjustment,
  calculateOrderTotals,
  buildWorkOrderFromEstimate,
  buildWorkOrderPartFromEstimate,
  ORDER_FIELD_MAP,
  PART_SHARED_FIELDS
};
