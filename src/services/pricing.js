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
