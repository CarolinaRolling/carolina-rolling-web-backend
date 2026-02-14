require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const cron = require('node-cron');
const { sequelize, Shipment, ShipmentPhoto, ShipmentDocument, User, AppSettings, WorkOrder, Client, DailyActivity } = require('./models');
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
const permitVerificationRoutes = require('./routes/permit-verification');
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
app.use('/api', permitVerificationRoutes);

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
    
    // CRITICAL: Convert work_orders status from ENUM to VARCHAR BEFORE sync
    // (sync will fail if model says STRING but DB has ENUM)
    try {
      const [colInfo] = await sequelize.query(
        `SELECT data_type, udt_name FROM information_schema.columns WHERE table_name = 'work_orders' AND column_name = 'status'`
      );
      if (colInfo.length > 0 && colInfo[0].data_type === 'USER-DEFINED') {
        await sequelize.query(`ALTER TABLE work_orders ALTER COLUMN status TYPE VARCHAR(255) USING status::text`);
        await sequelize.query(`DROP TYPE IF EXISTS "enum_work_orders_status"`);
        console.log('Converted work_orders.status from ENUM to VARCHAR');
      } else {
        console.log('work_orders.status is already VARCHAR (or table does not exist yet)');
      }
    } catch (enumErr) {
      console.log('Work orders status pre-sync conversion:', enumErr.message);
    }

    // Convert work_order_part_files fileType from ENUM to VARCHAR BEFORE sync
    try {
      const [wopfCol] = await sequelize.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'work_order_part_files' AND column_name = 'fileType'`
      );
      if (wopfCol.length > 0 && wopfCol[0].data_type === 'USER-DEFINED') {
        await sequelize.query(`ALTER TABLE work_order_part_files ALTER COLUMN "fileType" TYPE VARCHAR(255) USING "fileType"::text`);
        await sequelize.query(`DROP TYPE IF EXISTS "enum_work_order_part_files_fileType"`);
        console.log('Converted work_order_part_files.fileType from ENUM to VARCHAR');
      }
    } catch (enumErr) {
      console.log('WO part files fileType pre-sync conversion:', enumErr.message);
    }

    // Convert estimate_part_files fileType from ENUM to VARCHAR BEFORE sync
    try {
      const [epfCol] = await sequelize.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'estimate_part_files' AND column_name = 'fileType'`
      );
      if (epfCol.length > 0 && epfCol[0].data_type === 'USER-DEFINED') {
        await sequelize.query(`ALTER TABLE estimate_part_files ALTER COLUMN "fileType" TYPE VARCHAR(255) USING "fileType"::text`);
        await sequelize.query(`DROP TYPE IF EXISTS "enum_estimate_part_files_fileType"`);
        console.log('Converted estimate_part_files.fileType from ENUM to VARCHAR');
      }
    } catch (enumErr) {
      console.log('Estimate part files fileType pre-sync conversion:', enumErr.message);
    }

    // Convert work_order_parts materialSource from ENUM to VARCHAR BEFORE sync
    try {
      const [msCol] = await sequelize.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'work_order_parts' AND column_name = 'materialSource'`
      );
      if (msCol.length > 0 && msCol[0].data_type === 'USER-DEFINED') {
        await sequelize.query(`ALTER TABLE work_order_parts ALTER COLUMN "materialSource" TYPE VARCHAR(255) USING "materialSource"::text`);
        await sequelize.query(`DROP TYPE IF EXISTS "enum_work_order_parts_materialSource"`);
        console.log('Converted work_order_parts.materialSource from ENUM to VARCHAR');
      }
    } catch (enumErr) {
      console.log('WO parts materialSource pre-sync conversion:', enumErr.message);
    }
    
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
            const hasCone = vals.some(v => v.val === 'cone_roll');
            if (!hasCone) {
              await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'cone_roll'`);
              console.log(`Added cone_roll to ${enumName}`);
            }
            const hasTee = vals.some(v => v.val === 'tee_bar');
            if (!hasTee) {
              await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'tee_bar'`);
              console.log(`Added tee_bar to ${enumName}`);
            }
            const hasPressBrake = vals.some(v => v.val === 'press_brake');
            if (!hasPressBrake) {
              await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'press_brake'`);
              console.log(`Added press_brake to ${enumName}`);
            }
            const hasFabService = vals.some(v => v.val === 'fab_service');
            if (!hasFabService) {
              await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'fab_service'`);
              console.log(`Added fab_service to ${enumName}`);
            }
            const hasShopRate = vals.some(v => v.val === 'shop_rate');
            if (!hasShopRate) {
              await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'shop_rate'`);
              console.log(`Added shop_rate to ${enumName}`);
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

    // Add receivedBy and workOrderId to inbound_orders if not present
    try {
      const [inbCols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'inbound_orders'`
      );
      const inbColNames = inbCols.map(c => c.column_name);
      if (!inbColNames.includes('receivedBy')) {
        await sequelize.query(`ALTER TABLE inbound_orders ADD COLUMN "receivedBy" VARCHAR(255)`);
        console.log('Added receivedBy to inbound_orders');
      }
      if (!inbColNames.includes('workOrderId')) {
        await sequelize.query(`ALTER TABLE inbound_orders ADD COLUMN "workOrderId" UUID`);
        console.log('Added workOrderId to inbound_orders');
      }
    } catch (inbErr) {
      console.error('Inbound column check warning:', inbErr.message);
    }
    
    // Add 'archived' to shipments status ENUM if not present
    try {
      await sequelize.query(`ALTER TYPE "enum_shipments_status" ADD VALUE IF NOT EXISTS 'archived'`);
      console.log('Ensured archived exists in shipments status enum');
    } catch (enumErr) {
      // Type might not exist or value already exists - both are fine
      console.log('Shipment enum check:', enumErr.message);
    }

    // Ensure work_orders has archivedAt and shippedAt columns
    try {
      const [woCols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'work_orders'`
      );
      const woColNames = woCols.map(c => c.column_name);
      if (!woColNames.includes('archivedAt')) {
        await sequelize.query(`ALTER TABLE work_orders ADD COLUMN "archivedAt" TIMESTAMPTZ`);
        console.log('Added archivedAt to work_orders');
      }
      if (!woColNames.includes('shippedAt')) {
        await sequelize.query(`ALTER TABLE work_orders ADD COLUMN "shippedAt" TIMESTAMPTZ`);
        console.log('Added shippedAt to work_orders');
      }
      if (!woColNames.includes('minimumOverride')) {
        await sequelize.query(`ALTER TABLE work_orders ADD COLUMN "minimumOverride" BOOLEAN DEFAULT false`);
        console.log('Added minimumOverride to work_orders');
      }
      if (!woColNames.includes('minimumOverrideReason')) {
        await sequelize.query(`ALTER TABLE work_orders ADD COLUMN "minimumOverrideReason" VARCHAR(255)`);
        console.log('Added minimumOverrideReason to work_orders');
      }
      if (!woColNames.includes('completedAt')) {
        await sequelize.query(`ALTER TABLE work_orders ADD COLUMN "completedAt" TIMESTAMPTZ`);
        console.log('Added completedAt to work_orders');
      }
      if (!woColNames.includes('pickedUpAt')) {
        await sequelize.query(`ALTER TABLE work_orders ADD COLUMN "pickedUpAt" TIMESTAMPTZ`);
        console.log('Added pickedUpAt to work_orders');
      }
      if (!woColNames.includes('pickedUpBy')) {
        await sequelize.query(`ALTER TABLE work_orders ADD COLUMN "pickedUpBy" VARCHAR(255)`);
        console.log('Added pickedUpBy to work_orders');
      }
    } catch (woColErr) {
      console.error('Work orders column check warning:', woColErr.message);
    }

    // Ensure work_order_parts has formData column
    try {
      const [wopCols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'work_order_parts'`
      );
      const wopColNames = wopCols.map(c => c.column_name);
      if (!wopColNames.includes('formData')) {
        await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "formData" JSONB DEFAULT NULL`);
        console.log('Added formData to work_order_parts');
        
        // Backfill formData from linked estimate parts
        try {
          await sequelize.query(`
            UPDATE work_order_parts wop
            SET "formData" = ep."formData"
            FROM work_orders wo
            JOIN estimates e ON e.id = wo."estimateId"
            JOIN estimate_parts ep ON ep."estimateId" = e.id AND ep."partNumber" = wop."partNumber"
            WHERE wop."workOrderId" = wo.id
            AND ep."formData" IS NOT NULL
            AND wop."formData" IS NULL
          `);
          console.log('Backfilled formData for existing work order parts');
        } catch (bfErr) {
          console.error('Backfill warning:', bfErr.message);
        }
      }
    } catch (wopErr) {
      console.error('Work order parts column check warning:', wopErr.message);
    }

    // Add noTag column to clients table
    try {
      const [clientCols] = await sequelize.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'clients'`);
      if (!clientCols.some(c => c.column_name === 'noTag')) {
        await sequelize.query(`ALTER TABLE clients ADD COLUMN "noTag" BOOLEAN DEFAULT false`);
        console.log('Added noTag column to clients');
      }
      if (!clientCols.some(c => c.column_name === 'permitStatus')) {
        await sequelize.query(`ALTER TABLE clients ADD COLUMN "permitStatus" VARCHAR(255) DEFAULT 'unverified'`);
        console.log('Added permitStatus column to clients');
      }
      if (!clientCols.some(c => c.column_name === 'permitLastVerified')) {
        await sequelize.query(`ALTER TABLE clients ADD COLUMN "permitLastVerified" TIMESTAMPTZ DEFAULT NULL`);
        console.log('Added permitLastVerified column to clients');
      }
      if (!clientCols.some(c => c.column_name === 'permitRawResponse')) {
        await sequelize.query(`ALTER TABLE clients ADD COLUMN "permitRawResponse" TEXT DEFAULT NULL`);
        console.log('Added permitRawResponse column to clients');
      }
      if (!clientCols.some(c => c.column_name === 'permitOwnerName')) {
        await sequelize.query(`ALTER TABLE clients ADD COLUMN "permitOwnerName" VARCHAR(255) DEFAULT NULL`);
        console.log('Added permitOwnerName column to clients');
      }
      if (!clientCols.some(c => c.column_name === 'permitDbaName')) {
        await sequelize.query(`ALTER TABLE clients ADD COLUMN "permitDbaName" VARCHAR(255) DEFAULT NULL`);
        console.log('Added permitDbaName column to clients');
      }
    } catch (ntErr) {
      console.error('Client column check warning:', ntErr.message);
    }
    
    // Initialize default admin user
    await initializeAdmin();
    
    // Run cleanup on startup
    await cleanupOldShippedItems();
    
    // Run cleanup every 24 hours
    setInterval(cleanupOldShippedItems, 24 * 60 * 60 * 1000);
    
    // Comprehensive morning digest at 5:00 AM Pacific
    cron.schedule('0 5 * * *', async () => {
      console.log('Running 5:00 AM comprehensive daily digest...');
      try {
        // Check if schedule email is enabled
        const setting = await AppSettings.findOne({
          where: { key: 'schedule_email' }
        });
        
        if (setting?.value?.enabled !== false) {
          const result = await sendScheduleEmail();
          console.log('Morning digest result:', result);
        } else {
          console.log('Daily digest email is disabled, skipping');
        }
      } catch (error) {
        console.error('Failed to send daily digest:', error);
      }
    }, {
      timezone: 'America/Los_Angeles'
    });
    
    console.log('Morning digest configured for 5:00 AM Pacific');
    
    // Afternoon activity update at 2:30 PM Pacific
    cron.schedule('30 14 * * *', async () => {
      console.log('Running 2:30 PM activity summary email...');
      try {
        const result = await sendDailyEmail();
        console.log('2:30 PM activity summary result:', result);
      } catch (error) {
        console.error('Failed to send 2:30 PM activity summary:', error);
      }
    }, {
      timezone: 'America/Los_Angeles'
    });
    
    console.log('Afternoon activity summary configured for 2:30 PM Pacific');

    // Yearly CDTFA permit verification — runs January 2nd at 3 AM Pacific
    cron.schedule('0 3 2 1 *', async () => {
      console.log('[CRON] Starting annual CDTFA permit verification...');
      try {
        const { verifyBatch } = require('./services/permitVerification');
        const { Op } = require('sequelize');
        const clients = await Client.findAll({
          where: { isActive: true, resaleCertificate: { [Op.ne]: null } }
        });
        const withPermits = clients.filter(c => c.resaleCertificate && c.resaleCertificate.trim());
        console.log(`[CRON] Found ${withPermits.length} clients with resale certificates`);
        
        // Log start
        await DailyActivity.create({
          activityType: 'verification',
          resourceType: 'system',
          description: `Annual CDTFA permit verification started — ${withPermits.length} clients to verify`
        });

        if (withPermits.length === 0) return;

        let verified = 0, active = 0, closed = 0, failed = 0;
        const permits = withPermits.map(c => ({ id: c.id, permitNumber: c.resaleCertificate.trim() }));
        await verifyBatch(permits, async (result) => {
          try {
            const client = await Client.findByPk(result.clientId);
            if (client) {
              await client.update({
                permitStatus: result.status,
                permitLastVerified: new Date(),
                permitRawResponse: result.rawResponse,
                permitOwnerName: result.ownerName || null,
                permitDbaName: result.dbaName || null
              });
              verified++;
              if (result.status === 'Active') active++;
              else if (result.status === 'Closed') closed++;
              else failed++;
            }
          } catch (e) { console.error('[CRON] DB update failed:', e.message); failed++; }
        }, 60000); // 1 minute between each

        // Log completion
        await DailyActivity.create({
          activityType: 'verification',
          resourceType: 'system',
          description: `Annual CDTFA verification complete — ${verified} verified: ${active} active, ${closed} closed, ${failed} failed`
        });

        console.log('[CRON] Annual permit verification complete');
      } catch (err) {
        console.error('[CRON] Annual permit verification failed:', err);
        try {
          await DailyActivity.create({
            activityType: 'verification',
            resourceType: 'system',
            description: `Annual CDTFA verification FAILED: ${err.message}`
          });
        } catch(e) {}
      }
    }, {
      timezone: 'America/Los_Angeles'
    });
    console.log('Annual CDTFA permit verification configured for January 2nd at 3:00 AM Pacific');

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
