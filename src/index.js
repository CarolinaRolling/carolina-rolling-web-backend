require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const cron = require('node-cron');
const { sequelize, Shipment, ShipmentPhoto, ShipmentDocument, User, AppSettings, WorkOrder } = require('./models');
const shipmentRoutes = require('./routes/shipments');
const settingsRoutes = require('./routes/settings');
const { sendScheduleEmail } = require('./routes/settings');
const inboundRoutes = require('./routes/inbound');
const workordersRoutes = require('./routes/workorders');
const estimatesRoutes = require('./routes/estimates');
const backupRoutes = require('./routes/backup');
const drNumbersRoutes = require('./routes/dr-numbers');
const poNumbersRoutes = require('./routes/po-numbers');
const emailRoutes = require('./routes/email');
const { sendDailyEmail } = require('./routes/email');
const { router: authRoutes, initializeAdmin } = require('./routes/auth');
const clientsVendorsRoutes = require('./routes/clients-vendors');
const { Op } = require('sequelize');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Heroku (needed for correct protocol detection)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Shipment Tracker API is running',
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/shipments', shipmentRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/inbound', inboundRoutes);
app.use('/api/workorders', workordersRoutes);
app.use('/api/estimates', estimatesRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/dr-numbers', drNumbersRoutes);
app.use('/api/po-numbers', poNumbersRoutes);
app.use('/api/email', emailRoutes);
app.use('/api', clientsVendorsRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

// Cleanup job: Delete shipped items older than 1 month
async function cleanupOldShippedItems() {
  try {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    
    // Find old shipped items
    const oldShipments = await Shipment.findAll({
      where: {
        status: 'shipped',
        shippedAt: {
          [Op.lt]: oneMonthAgo
        }
      },
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ]
    });
    
    if (oldShipments.length > 0) {
      console.log(`Cleaning up ${oldShipments.length} shipped items older than 1 month...`);
      
      // Delete each shipment and its associated files
      for (const shipment of oldShipments) {
        // Delete photos from Cloudinary
        for (const photo of shipment.photos) {
          if (photo.cloudinaryId) {
            try {
              await cloudinary.uploader.destroy(photo.cloudinaryId);
              console.log(`Deleted Cloudinary image: ${photo.cloudinaryId}`);
            } catch (e) {
              console.error(`Failed to delete Cloudinary image ${photo.cloudinaryId}:`, e.message);
            }
          }
        }
        
        // Delete documents from Cloudinary (if stored there) 
        for (const doc of shipment.documents) {
          if (doc.cloudinaryId) {
            try {
              await cloudinary.uploader.destroy(doc.cloudinaryId, { resource_type: 'raw' });
              console.log(`Deleted Cloudinary document: ${doc.cloudinaryId}`);
            } catch (e) {
              console.error(`Failed to delete Cloudinary document ${doc.cloudinaryId}:`, e.message);
            }
          }
          // Note: NAS documents are referenced by URL but not auto-deleted from NAS
          // since the backend can't access the local NAS. Consider manual cleanup or
          // a separate NAS cleanup script if needed.
        }
        
        // Delete the shipment record (cascade will handle photo/document DB records)
        await shipment.destroy();
        console.log(`Deleted shipment: ${shipment.id} (${shipment.clientName})`);
      }
      
      console.log(`Cleanup complete: Deleted ${oldShipments.length} old shipped items with associated files`);
    }
  } catch (error) {
    console.error('Cleanup job error:', error);
  }
}

// Database sync and server start
async function startServer() {
  try {
    await sequelize.authenticate();
    console.log('Database connected successfully');
    
    // Sync models - use alter to add new columns
    // This is safe for adding new nullable columns
    try {
      await sequelize.sync({ alter: true });
      console.log('Database synchronized');
    } catch (syncErr) {
      console.error('Database sync warning (non-fatal):', syncErr.message);
      console.log('Continuing with existing schema - run migrations manually if needed');
    }
    
    // Ensure critical columns exist (sync may fail silently with enum conflicts)
    try {
      const [cols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'estimate_parts'`
      );
      const colNames = cols.map(c => c.column_name);
      
      if (!colNames.includes('laborTotal')) {
        await sequelize.query(`ALTER TABLE estimate_parts ADD COLUMN "laborTotal" DECIMAL(10,2)`);
        console.log('Added laborTotal to estimate_parts');
      }
      if (!colNames.includes('setupCharge')) {
        await sequelize.query(`ALTER TABLE estimate_parts ADD COLUMN "setupCharge" DECIMAL(10,2)`);
        console.log('Added setupCharge to estimate_parts');
      }
      if (!colNames.includes('otherCharges')) {
        await sequelize.query(`ALTER TABLE estimate_parts ADD COLUMN "otherCharges" DECIMAL(10,2)`);
        console.log('Added otherCharges to estimate_parts');
      }
    } catch (colErr) {
      console.error('Column check warning:', colErr.message);
    }
    
    // Add flat_stock to partType ENUMs if not present
    try {
      const enumTables = [
        { table: 'estimate_parts', col: 'partType' },
        { table: 'work_order_parts', col: 'partType' }
      ];
      for (const { table, col } of enumTables) {
        try {
          // Get the enum type name
          const [typeInfo] = await sequelize.query(
            `SELECT udt_name FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '"${col}"' OR (table_name = '${table}' AND column_name = '${col}')`
          );
          if (typeInfo.length > 0) {
            const enumName = typeInfo[0].udt_name;
            // Check if flat_stock exists
            const [vals] = await sequelize.query(`SELECT unnest(enum_range(NULL::${enumName}))::text as val`);
            const hasFlat = vals.some(v => v.val === 'flat_stock');
            if (!hasFlat) {
              await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'flat_stock'`);
              console.log(`Added flat_stock to ${enumName}`);
            }
            const hasTube = vals.some(v => v.val === 'tube_roll');
            if (!hasTube) {
              await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'tube_roll'`);
              console.log(`Added tube_roll to ${enumName}`);
            }
          }
        } catch (enumErr) {
          // Might fail if already exists or different DB
        }
      }
    } catch (enumErr) {
      console.error('Enum update warning:', enumErr.message);
    }

    // Add discount columns to estimates if not present
    try {
      const [estCols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'estimates'`
      );
      const estColNames = estCols.map(c => c.column_name);
      const discountCols = [
        { name: 'discountPercent', type: 'DECIMAL(5,2)' },
        { name: 'discountAmount', type: 'DECIMAL(10,2)' },
        { name: 'discountReason', type: 'VARCHAR(255)' },
        { name: 'minimumOverride', type: 'BOOLEAN DEFAULT false' },
        { name: 'minimumOverrideReason', type: 'VARCHAR(255)' }
      ];
      for (const col of discountCols) {
        if (!estColNames.includes(col.name)) {
          await sequelize.query(`ALTER TABLE estimates ADD COLUMN "${col.name}" ${col.type}`);
          console.log(`Added ${col.name} to estimates`);
        }
      }
    } catch (discErr) {
      console.error('Discount column check warning:', discErr.message);
    }

    // Add formData JSONB column to estimate_parts if not present
    try {
      const [partCols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'estimate_parts'`
      );
      const partColNames = partCols.map(c => c.column_name);
      if (!partColNames.includes('formData')) {
        await sequelize.query(`ALTER TABLE estimate_parts ADD COLUMN "formData" JSONB`);
        console.log('Added formData column to estimate_parts');
      }
    } catch (formErr) {
      console.error('formData column check warning:', formErr.message);
    }
    
    // Initialize default admin user
    await initializeAdmin();
    
    // Run cleanup on startup
    await cleanupOldShippedItems();
    
    // Run cleanup every 24 hours
    setInterval(cleanupOldShippedItems, 24 * 60 * 60 * 1000);
    
    // Schedule daily email at 6:00 AM Pacific Time
    // Cron runs in UTC, Pacific is UTC-8 (or UTC-7 during DST)
    // 6 AM Pacific = 14:00 UTC (standard) or 13:00 UTC (DST)
    // Using 14:00 UTC for PST (winter) - adjust if needed
    cron.schedule('0 14 * * *', async () => {
      console.log('Running scheduled daily email job...');
      try {
        // Check if schedule email is enabled
        const setting = await AppSettings.findOne({
          where: { key: 'schedule_email' }
        });
        
        if (setting?.value?.enabled !== false) {
          const result = await sendScheduleEmail();
          console.log('Daily schedule email result:', result);
        } else {
          console.log('Daily schedule email is disabled, skipping');
        }
      } catch (error) {
        console.error('Failed to send daily schedule email:', error);
      }
    }, {
      timezone: 'America/Los_Angeles'  // This handles DST automatically
    });
    
    console.log('Daily schedule email cron job configured for 6:00 AM Pacific');
    
    // NEW: Daily summary emails at 5:00 AM and 2:30 PM Eastern
    cron.schedule('0 5 * * *', async () => {
      console.log('Running 5:00 AM daily summary email...');
      try {
        const result = await sendDailyEmail();
        console.log('5:00 AM daily summary result:', result);
      } catch (error) {
        console.error('Failed to send 5:00 AM daily summary:', error);
      }
    }, {
      timezone: 'America/New_York'
    });
    
    cron.schedule('30 14 * * *', async () => {
      console.log('Running 2:30 PM daily summary email...');
      try {
        const result = await sendDailyEmail();
        console.log('2:30 PM daily summary result:', result);
      } catch (error) {
        console.error('Failed to send 2:30 PM daily summary:', error);
      }
    }, {
      timezone: 'America/New_York'
    });
    
    console.log('Daily summary emails configured for 5:00 AM and 2:30 PM Eastern');

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
