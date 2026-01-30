const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');

// Database connection
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: process.env.NODE_ENV === 'production' ? {
      require: true,
      rejectUnauthorized: false
    } : false
  },
  logging: process.env.NODE_ENV === 'development' ? console.log : false
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
    type: DataTypes.ENUM('received', 'processing', 'stored', 'shipped'),
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
  supplierName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  purchaseOrderNumber: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  clientName: {
    type: DataTypes.STRING,
    allowNull: false
  }
}, {
  tableName: 'inbound_orders',
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
  InboundOrder
};
