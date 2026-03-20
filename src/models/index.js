const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');

// Database connection with pool config for Heroku
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: process.env.NODE_ENV === 'production' ? {
      require: true,
      rejectUnauthorized: false
    } : false
  },
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  pool: {
    max: parseInt(process.env.DB_POOL_MAX) || 10,
    min: parseInt(process.env.DB_POOL_MIN) || 2,
    acquire: 30000,
    idle: 10000
  }
});

// User Model
const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  username: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  role: {
    type: DataTypes.ENUM('admin', 'user'),
    defaultValue: 'user'
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  totpSecret: {
    type: DataTypes.STRING,
    allowNull: true
  },
  totpEnabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  isHeadEstimator: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  tableName: 'users',
  timestamps: true,
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        user.password = await bcrypt.hash(user.password, 10);
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        user.password = await bcrypt.hash(user.password, 10);
      }
    }
  }
});

User.prototype.validatePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

// ActivityLog Model
const ActivityLog = sequelize.define('ActivityLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false
  },
  resourceType: {
    type: DataTypes.STRING,
    allowNull: true
  },
  resourceId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  ipAddress: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'activity_logs',
  timestamps: true
});

// Shipment Model
const Shipment = sequelize.define('Shipment', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  qrCode: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  jobNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  clientPurchaseOrderNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  partNumbers: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: []
  },
  quantity: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  status: {
    type: DataTypes.ENUM('received', 'processing', 'stored', 'shipped', 'archived'),
    defaultValue: 'received'
  },
  location: {
    type: DataTypes.STRING,
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  receivedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  receivedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  shippedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  requestedDueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  promisedDate: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'work_orders',
      key: 'id'
    }
  }
}, {
  tableName: 'shipments',
  timestamps: true
});

// ShipmentPhoto Model
const ShipmentPhoto = sequelize.define('ShipmentPhoto', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  shipmentId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'shipments',
      key: 'id'
    }
  },
  filename: {
    type: DataTypes.STRING,
    allowNull: false
  },
  originalName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  mimeType: {
    type: DataTypes.STRING,
    defaultValue: 'image/jpeg'
  },
  size: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false
  },
  cloudinaryId: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'shipment_photos',
  timestamps: true
});

// Associations
Shipment.hasMany(ShipmentPhoto, { 
  foreignKey: 'shipmentId', 
  as: 'photos',
  onDelete: 'CASCADE'
});
ShipmentPhoto.belongsTo(Shipment, { 
  foreignKey: 'shipmentId', 
  as: 'shipment' 
});

// ShipmentDocument Model - for PDF documents (stored on NAS)
const ShipmentDocument = sequelize.define('ShipmentDocument', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  shipmentId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'shipments',
      key: 'id'
    }
  },
  filename: {
    type: DataTypes.STRING,
    allowNull: false
  },
  originalName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  mimeType: {
    type: DataTypes.STRING,
    defaultValue: 'application/pdf'
  },
  size: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false
  },
  cloudinaryId: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'shipment_documents',
  timestamps: true
});

// Document associations
Shipment.hasMany(ShipmentDocument, { 
  foreignKey: 'shipmentId', 
  as: 'documents',
  onDelete: 'CASCADE'
});
ShipmentDocument.belongsTo(Shipment, { 
  foreignKey: 'shipmentId', 
  as: 'shipment' 
});

// AppSettings Model - for synced settings like location positions
const AppSettings = sequelize.define('AppSettings', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  key: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  value: {
    type: DataTypes.JSONB,
    allowNull: false
  }
}, {
  tableName: 'app_settings',
  timestamps: true
});

// InboundOrder Model - for tracking incoming shipments from suppliers
const InboundOrder = sequelize.define('InboundOrder', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  vendorId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  supplierName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  supplier: {
    type: DataTypes.STRING,
    allowNull: true
  },
  purchaseOrderNumber: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  clientId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  // Link to estimate if created from material order
  estimateId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  estimateNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  expectedCost: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  status: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'pending'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  expectedDate: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  receivedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  receivedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  tableName: 'inbound_orders',
  timestamps: true
});

// WorkOrder Model - for client work orders with parts
const WorkOrder = sequelize.define('WorkOrder', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  orderNumber: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  drNumber: {
    type: DataTypes.INTEGER,
    unique: true,
    allowNull: true
  },
  clientId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  clientPurchaseOrderNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  jobNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactPhone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactEmail: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'received'
  },
  priority: {
    type: DataTypes.STRING,
    defaultValue: 'normal',
    allowNull: false
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  receivedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  receivedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  requestedDueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  promisedDate: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  shippedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  archivedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  pickedUpAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  pickedUpBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  pickupHistory: {
    type: DataTypes.JSONB,
    defaultValue: [],
    allowNull: true
  },
  signatureData: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Location for inventory tracking
  storageLocation: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Pricing from estimate (only visible in web interface)
  estimateId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'estimates',
      key: 'id'
    }
  },
  estimateNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  estimateTotal: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  // Material status tracking
  allMaterialReceived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  pendingInboundCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  // Order-level pricing
  truckingDescription: {
    type: DataTypes.STRING,
    allowNull: true
  },
  truckingCost: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  taxRate: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  taxAmount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  subtotal: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  grandTotal: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  // Minimum charge override (copied from estimate)
  minimumOverride: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  minimumOverrideReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Discount
  discountPercent: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  discountAmount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  discountReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Tax exempt
  taxExempt: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  taxExemptReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  taxExemptCertNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // COD Payment Tracking
  codPaid: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: false
  },
  paymentDate: {
    type: DataTypes.DATE,
    allowNull: true
  },
  paymentMethod: {
    type: DataTypes.STRING,
    allowNull: true
  },
  paymentReference: {
    type: DataTypes.STRING,
    allowNull: true
  },
  paymentRecordedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Invoice Tracking
  invoiceNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  invoiceDate: {
    type: DataTypes.DATE,
    allowNull: true
  },
  invoicedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  invoicePdfUrl: {
    type: DataTypes.STRING,
    allowNull: true
  },
  invoicePdfCloudinaryId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  invoiceSkipped: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: false
  },
  invoiceSkipReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  invoiceSkippedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  invoiceSkippedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Void tracking
  isVoided: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  voidedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  voidedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  voidReason: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'work_orders',
  timestamps: true
});

// WorkOrderPart Model - individual parts within a work order
const WorkOrderPart = sequelize.define('WorkOrderPart', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'work_orders',
      key: 'id'
    }
  },
  partNumber: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  partType: {
    type: DataTypes.ENUM('plate_roll', 'section_roll', 'angle_roll', 'beam_roll', 'pipe_roll', 'tube_roll', 'channel_roll', 'flat_bar', 'cone_roll', 'tee_bar', 'press_brake', 'flat_stock', 'fab_service', 'shop_rate', 'rush_service', 'other'),
    allowNull: false
  },
  clientPartNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  heatNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  heatBreakdown: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null
  },
  cutFileReference: {
    type: DataTypes.STRING,
    allowNull: true
  },
  quantity: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  // Dimensions
  material: {
    type: DataTypes.STRING,
    allowNull: true
  },
  thickness: {
    type: DataTypes.STRING,
    allowNull: true
  },
  width: {
    type: DataTypes.STRING,
    allowNull: true
  },
  length: {
    type: DataTypes.STRING,
    allowNull: true
  },
  outerDiameter: {
    type: DataTypes.STRING,
    allowNull: true
  },
  innerDiameter: {
    type: DataTypes.STRING,
    allowNull: true
  },
  wallThickness: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Rolling specifications
  rollType: {
    type: DataTypes.ENUM('easy_way', 'hard_way', 'on_edge'),
    allowNull: true
  },
  radius: {
    type: DataTypes.STRING,
    allowNull: true
  },
  diameter: {
    type: DataTypes.STRING,
    allowNull: true
  },
  arcLength: {
    type: DataTypes.STRING,
    allowNull: true
  },
  arcDegrees: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Section-specific
  sectionSize: {
    type: DataTypes.STRING,
    allowNull: true
  },
  flangeOut: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  // Status
  status: {
    type: DataTypes.ENUM('pending', 'in_progress', 'completed'),
    defaultValue: 'pending'
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  completedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Notes and special instructions
  specialInstructions: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  operatorNotes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Material tracking
  materialSource: {
    type: DataTypes.STRING,
    defaultValue: 'we_order'
  },
  materialReceived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  materialReceivedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  awaitingInboundId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  awaitingPONumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  vendorId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  supplierName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  vendorEstimateNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  materialDescription: {
    type: DataTypes.STRING,
    allowNull: true
  },
  materialOrdered: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  materialOrderedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  materialPurchaseOrderNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  inboundOrderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Pricing fields
  laborRate: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  laborHours: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  laborTotal: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  materialUnitCost: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  materialMarkupPercent: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  materialTotal: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  setupCharge: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  otherCharges: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  partTotal: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  // JSONB to persist form display data (rolling descriptions, specs, etc.)
  formData: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null
  }
}, {
  tableName: 'work_order_parts',
  timestamps: true
});

// WorkOrderPartFile Model - files attached to parts (PDFs, STEP files)
const WorkOrderPartFile = sequelize.define('WorkOrderPartFile', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  workOrderPartId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'work_order_parts',
      key: 'id'
    }
  },
  fileType: {
    type: DataTypes.STRING,
    allowNull: false
  },
  filename: {
    type: DataTypes.STRING,
    allowNull: false
  },
  originalName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  mimeType: {
    type: DataTypes.STRING,
    allowNull: true
  },
  size: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false
  },
  cloudinaryId: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'work_order_part_files',
  timestamps: true
});

// WorkOrderDocument Model - for order-level documents (POs, supplier docs, etc.)
const WorkOrderDocument = sequelize.define('WorkOrderDocument', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'work_orders',
      key: 'id'
    }
  },
  originalName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  mimeType: {
    type: DataTypes.STRING,
    allowNull: true
  },
  size: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false
  },
  cloudinaryId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  documentType: {
    type: DataTypes.STRING,
    allowNull: true // 'customer_po', 'supplier_quote', 'drawing', 'other'
  },
  description: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'work_order_documents',
  timestamps: true
});

// WorkOrder associations
WorkOrder.hasMany(WorkOrderPart, {
  foreignKey: 'workOrderId',
  as: 'parts',
  onDelete: 'CASCADE'
});
WorkOrderPart.belongsTo(WorkOrder, {
  foreignKey: 'workOrderId',
  as: 'workOrder'
});

// WorkOrder -> Shipment association (for linked receiving info & photos)
WorkOrder.hasMany(Shipment, {
  foreignKey: 'workOrderId',
  as: 'shipments'
});
Shipment.belongsTo(WorkOrder, {
  foreignKey: 'workOrderId',
  as: 'workOrder'
});

// WorkOrder document associations
WorkOrder.hasMany(WorkOrderDocument, {
  foreignKey: 'workOrderId',
  as: 'documents',
  onDelete: 'CASCADE'
});
WorkOrderDocument.belongsTo(WorkOrder, {
  foreignKey: 'workOrderId',
  as: 'workOrder'
});

// WorkOrderPart file associations
WorkOrderPart.hasMany(WorkOrderPartFile, {
  foreignKey: 'workOrderPartId',
  as: 'files',
  onDelete: 'CASCADE'
});
WorkOrderPartFile.belongsTo(WorkOrderPart, {
  foreignKey: 'workOrderPartId',
  as: 'part'
});

// Estimate Model - for client estimates/quotes
const Estimate = sequelize.define('Estimate', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  estimateNumber: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  clientId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  contactName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactEmail: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactPhone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  projectDescription: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('draft', 'sent', 'accepted', 'declined', 'archived', 'converted'),
    defaultValue: 'draft'
  },
  // Trucking (estimate-level, not per part)
  truckingDescription: {
    type: DataTypes.STRING,
    allowNull: true
  },
  truckingCost: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  // Totals
  partsSubtotal: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  taxRate: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 7.0
  },
  taxAmount: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  grandTotal: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  // Discount
  discountPercent: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  discountAmount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  discountReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Minimum charge override
  minimumOverride: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  minimumOverrideReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Custom tax
  useCustomTax: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  customTaxReason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Tax exempt (resale certificate)
  taxExempt: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  taxExemptReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  taxExemptCertNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Notes
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  internalNotes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Dates
  validUntil: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  sentAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  acceptedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  archivedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Link to work order if converted
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'work_orders',
      key: 'id'
    }
  },
  drNumber: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  // Track if all materials are customer supplied
  allCustomerSupplied: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  emailLink: {
    type: DataTypes.STRING,
    allowNull: true
  },
  scannedEmailId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Vendor RFQ tracking
  rfqVendorId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  rfqThreadId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  rfqGmailAccountId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  rfqSentAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'estimates',
  timestamps: true
});

// EstimatePart Model - parts within an estimate (replaces EstimateLineItem)
const EstimatePart = sequelize.define('EstimatePart', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  estimateId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'estimates',
      key: 'id'
    }
  },
  partNumber: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  partType: {
    type: DataTypes.ENUM('plate_roll', 'section_roll', 'angle_roll', 'beam_roll', 'pipe_roll', 'tube_roll', 'channel_roll', 'flat_bar', 'cone_roll', 'tee_bar', 'press_brake', 'flat_stock', 'fab_service', 'shop_rate', 'rush_service', 'other'),
    allowNull: false
  },
  clientPartNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  heatNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  cutFileReference: {
    type: DataTypes.STRING,
    allowNull: true
  },
  quantity: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  // Material info
  materialDescription: {
    type: DataTypes.STRING,
    allowNull: true
  },
  vendorId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  supplierName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  vendorEstimateNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  materialUnitCost: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  materialMarkupPercent: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 20
  },
  materialTotal: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  // Service costs
  laborTotal: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  setupCharge: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  otherCharges: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  rollingCost: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  otherServicesCost: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  otherServicesMarkupPercent: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 15
  },
  otherServicesTotal: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  // Part total
  partTotal: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  // Rolling specifications
  material: {
    type: DataTypes.STRING,
    allowNull: true
  },
  thickness: {
    type: DataTypes.STRING,
    allowNull: true
  },
  width: {
    type: DataTypes.STRING,
    allowNull: true
  },
  length: {
    type: DataTypes.STRING,
    allowNull: true
  },
  outerDiameter: {
    type: DataTypes.STRING,
    allowNull: true
  },
  wallThickness: {
    type: DataTypes.STRING,
    allowNull: true
  },
  sectionSize: {
    type: DataTypes.STRING,
    allowNull: true
  },
  rollType: {
    type: DataTypes.ENUM('easy_way', 'hard_way', 'on_edge'),
    allowNull: true
  },
  radius: {
    type: DataTypes.STRING,
    allowNull: true
  },
  diameter: {
    type: DataTypes.STRING,
    allowNull: true
  },
  arcDegrees: {
    type: DataTypes.STRING,
    allowNull: true
  },
  flangeOut: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  specialInstructions: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // We supply material flag
  weSupplyMaterial: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  // Additional Services
  serviceDrilling: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  serviceDrillingCost: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  serviceDrillingVendor: {
    type: DataTypes.STRING,
    allowNull: true
  },
  serviceCutting: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  serviceCuttingCost: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  serviceCuttingVendor: {
    type: DataTypes.STRING,
    allowNull: true
  },
  serviceFitting: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  serviceFittingCost: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  serviceFittingVendor: {
    type: DataTypes.STRING,
    allowNull: true
  },
  serviceWelding: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  serviceWeldingCost: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  serviceWeldingVendor: {
    type: DataTypes.STRING,
    allowNull: true
  },
  serviceWeldingPercent: {
    type: DataTypes.INTEGER,
    defaultValue: 100  // 100% welding by default
  },
  // Material ordering tracking
  materialOrdered: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  materialPurchaseOrderNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  materialOrderedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Material source - we order vs customer supplied
  materialSource: {
    type: DataTypes.STRING,
    defaultValue: 'customer_supplied'
  },
  materialReceived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  materialReceivedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  inboundOrderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // JSONB column to persist form-specific state (underscore-prefixed fields)
  formData: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null
  }
}, {
  tableName: 'estimate_parts',
  timestamps: true
});

// EstimatePartFile Model - files attached to specific parts (drawings, prints, PDFs)
const EstimatePartFile = sequelize.define('EstimatePartFile', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  partId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'estimate_parts',
      key: 'id'
    }
  },
  filename: {
    type: DataTypes.STRING,
    allowNull: false
  },
  originalName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  mimeType: {
    type: DataTypes.STRING,
    allowNull: true
  },
  size: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false
  },
  cloudinaryId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fileType: {
    type: DataTypes.STRING,
    defaultValue: 'other'
  }
}, {
  tableName: 'estimate_part_files',
  timestamps: true
});

// EstimateFile Model - files attached to estimates (DXF, STEP, PDF)
const EstimateFile = sequelize.define('EstimateFile', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  estimateId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'estimates',
      key: 'id'
    }
  },
  filename: {
    type: DataTypes.STRING,
    allowNull: false
  },
  originalName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  mimeType: {
    type: DataTypes.STRING,
    allowNull: true
  },
  size: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false
  },
  cloudinaryId: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'estimate_files',
  timestamps: true
});

// Estimate associations
Estimate.hasMany(EstimatePart, {
  foreignKey: 'estimateId',
  as: 'parts',
  onDelete: 'CASCADE'
});
EstimatePart.belongsTo(Estimate, {
  foreignKey: 'estimateId',
  as: 'estimate'
});

Estimate.hasMany(EstimateFile, {
  foreignKey: 'estimateId',
  as: 'files',
  onDelete: 'CASCADE'
});
EstimateFile.belongsTo(Estimate, {
  foreignKey: 'estimateId',
  as: 'estimate'
});

Estimate.belongsTo(WorkOrder, {
  foreignKey: 'workOrderId',
  as: 'workOrder'
});

// EstimatePartFile associations
EstimatePart.hasMany(EstimatePartFile, {
  foreignKey: 'partId',
  as: 'files',
  onDelete: 'CASCADE'
});
EstimatePartFile.belongsTo(EstimatePart, {
  foreignKey: 'partId',
  as: 'part'
});

// DR Number Model - tracks delivery receipt numbers
const DRNumber = sequelize.define('DRNumber', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  drNumber: {
    type: DataTypes.INTEGER,
    unique: true,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('active', 'void'),
    defaultValue: 'active'
  },
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_orders', key: 'id' }
  },
  estimateId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'estimates', key: 'id' }
  },
  clientId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  voidedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  voidedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  voidReason: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'dr_numbers',
  timestamps: true
});

// PO Number Model - tracks purchase order numbers for material ordering
const PONumber = sequelize.define('PONumber', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  poNumber: {
    type: DataTypes.INTEGER,
    unique: true,
    allowNull: false
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'active'
  },
  supplier: {
    type: DataTypes.STRING,
    allowNull: true
  },
  vendorId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_orders', key: 'id' }
  },
  estimateId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'estimates', key: 'id' }
  },
  inboundOrderId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'inbound_orders', key: 'id' }
  },
  clientId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  voidedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  voidedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  voidReason: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'po_numbers',
  timestamps: true
});

// Invoice Number Model - auto-incrementing invoice numbers
const InvoiceNumber = sequelize.define('InvoiceNumber', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  invoiceNumber: {
    type: DataTypes.INTEGER,
    unique: true,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('active', 'void'),
    defaultValue: 'active'
  },
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_orders', key: 'id' }
  },
  clientId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  voidedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  voidedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  voidReason: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'invoice_numbers',
  timestamps: true
});

// Email Log Model
const EmailLog = sequelize.define('EmailLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  emailType: {
    type: DataTypes.STRING,
    allowNull: false
  },
  recipient: {
    type: DataTypes.STRING,
    allowNull: false
  },
  subject: {
    type: DataTypes.STRING,
    allowNull: false
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  sentAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'sent'
  }
}, {
  tableName: 'email_logs',
  timestamps: true
});

// Daily Activity Model - for tracking changes for daily email summaries
const DailyActivity = sequelize.define('DailyActivity', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  activityType: {
    type: DataTypes.STRING,
    allowNull: false
  },
  resourceType: {
    type: DataTypes.STRING,
    allowNull: false
  },
  resourceId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  resourceNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  includedInEmail: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  emailSentAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'daily_activities',
  timestamps: true
});

// Client Model - for autofill and tax management
const Client = sequelize.define('Client', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  contactName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactPhone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactEmail: {
    type: DataTypes.STRING,
    allowNull: true
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Tax settings
  taxStatus: {
    type: DataTypes.STRING,
    defaultValue: 'taxable' // 'taxable', 'resale', 'exempt'
  },
  resaleCertificate: {
    type: DataTypes.STRING,
    allowNull: true
  },
  customTaxRate: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: true // null means use default rate
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  noTag: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  contacts: {
    type: DataTypes.JSONB,
    defaultValue: [],
    allowNull: true
    // Array of { name, phone, email, isPrimary }
  },
  requiresPartLabels: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  permitStatus: {
    type: DataTypes.STRING,
    defaultValue: 'unverified' // active, closed, inactive, not_found, error, unverified
  },
  permitLastVerified: {
    type: DataTypes.DATE,
    allowNull: true
  },
  permitRawResponse: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  permitOwnerName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  permitDbaName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  paymentTerms: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null
  },
  apEmail: {
    type: DataTypes.STRING,
    allowNull: true
  },
  quickbooksName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Email scanning
  emailScanEnabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  emailScanAddresses: {
    type: DataTypes.JSONB,
    defaultValue: [],
    allowNull: true
    // Array of email addresses to scan for this client
  },
  emailScanParsingNotes: {
    type: DataTypes.TEXT,
    allowNull: true
    // Free text hints for AI parsing e.g. "OR numbers are their reference numbers"
  }
}, {
  tableName: 'clients',
  timestamps: true
});

// GmailAccount - connected Gmail/Workspace accounts for email scanning
const GmailAccount = sequelize.define('GmailAccount', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  accessToken: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  refreshToken: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  tokenExpiry: {
    type: DataTypes.DATE,
    allowNull: true
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  lastScannedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  lastError: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  connectedBy: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'gmail_accounts',
  timestamps: true
});

// ScannedEmail - track processed emails to avoid duplicates
const ScannedEmail = sequelize.define('ScannedEmail', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  gmailMessageId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  gmailThreadId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  gmailAccountId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'gmail_accounts', key: 'id' }
  },
  fromEmail: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fromName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  subject: {
    type: DataTypes.STRING,
    allowNull: true
  },
  receivedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  clientId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'clients', key: 'id' }
  },
  emailType: {
    type: DataTypes.STRING,
    allowNull: true // 'rfq', 'po', 'unknown'
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'processed' // 'processed', 'estimate_created', 'pending_order', 'error', 'ignored'
  },
  estimateId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  pendingOrderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  parsedData: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  parseConfidence: {
    type: DataTypes.STRING,
    allowNull: true // 'high', 'medium', 'low'
  },
  errorMessage: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  gmailLink: {
    type: DataTypes.STRING,
    allowNull: true
  },
  rawBody: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'scanned_emails',
  timestamps: true
});

// PendingOrder - POs awaiting approval before becoming work orders
const PendingOrder = sequelize.define('PendingOrder', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  clientId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'clients', key: 'id' }
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  poNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  referenceNumber: {
    type: DataTypes.STRING,
    allowNull: true // OR number, quote reference, etc.
  },
  matchedEstimateId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  matchedEstimateNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  scannedEmailId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'scanned_emails', key: 'id' }
  },
  emailLink: {
    type: DataTypes.STRING,
    allowNull: true
  },
  subject: {
    type: DataTypes.STRING,
    allowNull: true
  },
  parsedData: {
    type: DataTypes.JSONB,
    allowNull: true
    // { parts: [...], specialInstructions, attachments, etc. }
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'pending' // 'pending', 'approved', 'rejected'
  },
  approvedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  approvedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  rejectedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  rejectedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  rejectionReason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  workOrderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  requestedDate: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'pending_orders',
  timestamps: true
});

GmailAccount.hasMany(ScannedEmail, { foreignKey: 'gmailAccountId', as: 'scannedEmails' });
ScannedEmail.belongsTo(GmailAccount, { foreignKey: 'gmailAccountId', as: 'gmailAccount' });

// Vendor Model - for supplier autofill
const Vendor = sequelize.define('Vendor', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  contactName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactPhone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  contactEmail: {
    type: DataTypes.STRING,
    allowNull: true
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  accountNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  contacts: {
    type: DataTypes.JSONB,
    defaultValue: [],
    allowNull: true
    // Array of { name, phone, email, isPrimary }
  },
  emailScanEnabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  emailScanAddresses: {
    type: DataTypes.JSONB,
    defaultValue: [],
    allowNull: true
  }
}, {
  tableName: 'vendors',
  timestamps: true
});

// Vendor Associations
Vendor.hasMany(WorkOrderPart, { foreignKey: 'vendorId', as: 'workOrderParts' });
WorkOrderPart.belongsTo(Vendor, { foreignKey: 'vendorId', as: 'vendor' });

Vendor.hasMany(EstimatePart, { foreignKey: 'vendorId', as: 'estimateParts' });
EstimatePart.belongsTo(Vendor, { foreignKey: 'vendorId', as: 'vendor' });

Vendor.hasMany(InboundOrder, { foreignKey: 'vendorId', as: 'inboundOrders' });
InboundOrder.belongsTo(Vendor, { foreignKey: 'vendorId', as: 'vendor' });

WorkOrder.hasMany(InboundOrder, { foreignKey: 'workOrderId', as: 'inboundOrders' });
InboundOrder.belongsTo(WorkOrder, { foreignKey: 'workOrderId', as: 'workOrder' });

Vendor.hasMany(PONumber, { foreignKey: 'vendorId', as: 'poNumbers' });
PONumber.belongsTo(Vendor, { foreignKey: 'vendorId', as: 'vendor' });

// Client Associations
Client.hasMany(WorkOrder, { foreignKey: 'clientId', as: 'workOrders' });
WorkOrder.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

Client.hasMany(Estimate, { foreignKey: 'clientId', as: 'estimates' });
Estimate.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

Client.hasMany(InboundOrder, { foreignKey: 'clientId', as: 'inboundOrders' });
InboundOrder.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

Client.hasMany(PONumber, { foreignKey: 'clientId', as: 'poNumbers' });
PONumber.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });
PONumber.belongsTo(WorkOrder, { foreignKey: 'workOrderId', as: 'workOrder' });

// Shop Supply Model - track consumable shop items
const ShopSupply = sequelize.define('ShopSupply', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  category: {
    type: DataTypes.STRING,
    allowNull: true // e.g. "Gas", "Paint", "Safety", "Consumables"
  },
  quantity: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  unit: {
    type: DataTypes.STRING,
    defaultValue: 'each' // "tanks", "cans", "boxes", "rolls", "gallons", "each"
  },
  minQuantity: {
    type: DataTypes.INTEGER,
    defaultValue: 1 // warn when at or below this level
  },
  maxQuantity: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null // max stock level for progress bar
  },
  qrCode: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  lastRefilledAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  lastRefilledBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  lastConsumedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  lastConsumedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  lowStockAcknowledged: {
    type: DataTypes.BOOLEAN,
    defaultValue: false // reset to false when quantity drops to/below min; set true only by refill
  },
  imageUrl: {
    type: DataTypes.STRING,
    allowNull: true
  },
  imageCloudinaryId: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'shop_supplies',
  timestamps: true
});

// Shop Supply Log - track consumption/refill history
const ShopSupplyLog = sequelize.define('ShopSupplyLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  shopSupplyId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'shop_supplies', key: 'id' }
  },
  action: {
    type: DataTypes.STRING, // 'consume', 'refill', 'adjust'
    allowNull: false
  },
  quantityChange: {
    type: DataTypes.INTEGER,
    allowNull: false // negative for consume, positive for refill
  },
  quantityAfter: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  performedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  deviceName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'shop_supply_logs',
  timestamps: true
});

ShopSupply.hasMany(ShopSupplyLog, { foreignKey: 'shopSupplyId', as: 'logs' });
ShopSupplyLog.belongsTo(ShopSupply, { foreignKey: 'shopSupplyId', as: 'supply' });

Client.hasMany(DRNumber, { foreignKey: 'clientId', as: 'drNumbers' });
DRNumber.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

// InvoiceNumber associations
InvoiceNumber.belongsTo(WorkOrder, { foreignKey: 'workOrderId', as: 'workOrder' });
InvoiceNumber.belongsTo(Client, { foreignKey: 'clientId', as: 'client' });

// ApiKey Model - for portal/external API access
const ApiKey = sequelize.define('ApiKey', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false // e.g. "Shop Tablet 1", "Customer Portal"
  },
  key: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: true // null = full access, set = scoped to that client's data
  },
  permissions: {
    type: DataTypes.STRING,
    defaultValue: 'read' // 'read', 'read_write', 'admin'
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true // null = never expires
  },
  createdBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // === IP Security ===
  allowedIPs: {
    type: DataTypes.TEXT, // comma-separated IPs or CIDR ranges, null = any IP allowed
    allowNull: true
  },
  lastIP: {
    type: DataTypes.STRING,
    allowNull: true
  },
  lastIPDate: {
    type: DataTypes.DATE,
    allowNull: true
  },
  revokedReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  revokedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // === Operator Tracking ===
  operatorName: {
    type: DataTypes.STRING,
    allowNull: true // e.g. "Jesus", "Mike" — fixed per tablet
  },
  deviceName: {
    type: DataTypes.STRING,
    allowNull: true // e.g. "Shop Tablet 1", "Brake Press Tablet"
  }
}, {
  tableName: 'api_keys',
  timestamps: true
});

// Shared Todo Items — persistent to-do list visible to all web users
const TodoItem = sequelize.define('TodoItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  type: {
    type: DataTypes.STRING,
    defaultValue: 'general' // 'general', 'estimate_review', 'material_order', 'urgent'
  },
  priority: {
    type: DataTypes.STRING,
    defaultValue: 'normal' // 'low', 'normal', 'high', 'urgent'
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'open' // 'open', 'accepted', 'denied', 'completed'
  },
  estimateId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  estimateNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  createdBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  assignedTo: {
    type: DataTypes.STRING,
    allowNull: true
  },
  completedBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  deniedReason: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'todo_items',
  timestamps: true
});

module.exports = {
  sequelize,
  User,
  ActivityLog,
  Shipment,
  ShipmentPhoto,
  ShipmentDocument,
  AppSettings,
  InboundOrder,
  WorkOrder,
  WorkOrderPart,
  WorkOrderPartFile,
  WorkOrderDocument,
  Estimate,
  EstimatePart,
  EstimatePartFile,
  EstimateFile,
  DRNumber,
  PONumber,
  EmailLog,
  DailyActivity,
  Client,
  Vendor,
  ApiKey,
  ShopSupply,
  ShopSupplyLog,
  TodoItem,
  InvoiceNumber,
  GmailAccount,
  ScannedEmail,
  PendingOrder
};
