// ============= CENTRALIZED CONSTANTS =============
// All statuses, enums, and configuration in one place

// Work Order Statuses - the main workflow
const WORK_ORDER_STATUSES = {
  WAITING_FOR_MATERIALS: 'waiting_for_materials',
  RECEIVED: 'received',
  PROCESSING: 'processing',
  STORED: 'stored',
  SHIPPED: 'shipped',
  ARCHIVED: 'archived'
};

// Work Order Status Labels for display
const WORK_ORDER_STATUS_LABELS = {
  waiting_for_materials: 'Waiting for Materials',
  received: 'Received',
  processing: 'Processing',
  stored: 'Stored',
  shipped: 'Shipped',
  archived: 'Archived'
};

// Part Statuses
const PART_STATUSES = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed'
};

// Estimate Statuses
const ESTIMATE_STATUSES = {
  DRAFT: 'draft',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  CONVERTED: 'converted',
  ARCHIVED: 'archived'
};

// Material Source Options
const MATERIAL_SOURCES = {
  CUSTOMER: 'customer',
  WE_ORDER: 'we_order'
};

// Inbound Order Statuses
const INBOUND_STATUSES = {
  PENDING: 'pending',
  ORDERED: 'ordered',
  SHIPPED: 'shipped',
  RECEIVED: 'received'
};

// PO Number Statuses
const PO_STATUSES = {
  ACTIVE: 'active',
  VOID: 'void'
};

// DR Number Statuses
const DR_STATUSES = {
  ACTIVE: 'active',
  VOID: 'void'
};

// Part Types
const PART_TYPES = {
  PLATE_ROLL: 'plate_roll',
  SECTION_ROLL: 'section_roll',
  ANGLE_ROLL: 'angle_roll',
  BEAM_ROLL: 'beam_roll',
  PIPE_ROLL: 'pipe_roll',
  CHANNEL_ROLL: 'channel_roll',
  FLAT_BAR: 'flat_bar',
  OTHER: 'other'
};

// Roll Types
const ROLL_TYPES = {
  EASY_WAY: 'easy_way',
  HARD_WAY: 'hard_way'
};

// Numeric fields that need cleaning (empty string -> null)
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

// Default values
const DEFAULTS = {
  TAX_RATE: 9.75,
  LABOR_RATE: 125.00,
  MATERIAL_MARKUP: 20,
  STARTING_DR_NUMBER: 2950,
  STARTING_PO_NUMBER: 7765
};

// Helper function to clean numeric fields
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

// Helper to generate estimate number
function generateEstimateNumber() {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `EST-${year}${month}${day}-${random}`;
}

// Helper to generate work order number
function generateWorkOrderNumber() {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `WO-${year}${month}${day}-${random}`;
}

module.exports = {
  WORK_ORDER_STATUSES,
  WORK_ORDER_STATUS_LABELS,
  PART_STATUSES,
  ESTIMATE_STATUSES,
  MATERIAL_SOURCES,
  INBOUND_STATUSES,
  PO_STATUSES,
  DR_STATUSES,
  PART_TYPES,
  ROLL_TYPES,
  NUMERIC_FIELDS,
  DEFAULTS,
  cleanNumericFields,
  generateEstimateNumber,
  generateWorkOrderNumber
};
