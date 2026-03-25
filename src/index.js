require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const cron = require('node-cron');
const { sequelize, Shipment, ShipmentPhoto, ShipmentDocument, User, AppSettings, WorkOrder, Client, DailyActivity, Estimate } = require('./models');
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
const quickbooksRoutes = require('./routes/quickbooks');
const shopSuppliesRoutes = require('./routes/shop-supplies');
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
app.use(compression()); // Gzip responses — big win for 80+ part WO JSON
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Request timing — logs slow requests to Heroku logs (>2s)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 2000) {
      console.warn(`[SLOW] ${req.method} ${req.originalUrl} ${ms}ms (${res.statusCode})`);
    }
  });
  next();
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Serve static assets (orientation diagrams, etc.)
app.use('/assets', express.static(path.join(__dirname, 'assets')));

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

// Email Scanner - OAuth callback MUST be before authenticate middleware (Google redirects browser here)
const { getOAuth2Client } = require('./services/emailScanner');
app.get('/api/email-scanner/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('No authorization code received');

    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    const { google } = require('googleapis');
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const userInfo = await oauth2Api.userinfo.get();
    const email = userInfo.data.email;

    const { GmailAccount } = require('./models');
    const [account, created] = await GmailAccount.findOrCreate({
      where: { email },
      defaults: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        isActive: true,
        connectedBy: 'admin'
      }
    });
    if (!created) {
      await account.update({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || account.refreshToken,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        isActive: true,
        lastError: null
      });
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${baseUrl}/admin/shop-config?tab=emailScanner&connected=${encodeURIComponent(email)}`);
  } catch (error) {
    console.error('[EmailScanner] OAuth callback error:', error.message);
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${baseUrl}/admin/shop-config?tab=emailScanner&error=${encodeURIComponent(error.message)}`);
  }
});

// All other routes require authentication (JWT token or API key)
const { authenticate } = require('./routes/auth');
app.use('/api/shipments', authenticate, shipmentRoutes);
app.use('/api/settings', authenticate, settingsRoutes);
app.use('/api/inbound', authenticate, inboundRoutes);
app.use('/api/workorders', authenticate, workordersRoutes);
app.use('/api/estimates', authenticate, estimatesRoutes);
app.use('/api/backup', authenticate, backupRoutes);
const businessRoutes = require('./routes/business');
app.use('/api/business', authenticate, businessRoutes);
app.use('/api/dr-numbers', authenticate, drNumbersRoutes);
app.use('/api/po-numbers', authenticate, poNumbersRoutes);
app.use('/api/email', authenticate, emailRoutes);
app.use('/api', authenticate, clientsVendorsRoutes);
app.use('/api', authenticate, permitVerificationRoutes);
app.use('/api/quickbooks', authenticate, quickbooksRoutes);
app.use('/api/shop-supplies', authenticate, shopSuppliesRoutes);
const todoRoutes = require('./routes/todos');
app.use('/api/todos', authenticate, todoRoutes);

// Email Scanner (authenticated routes only - callback handled above)
const emailScannerRoutes = require('./routes/email-scanner');
app.use('/api/email-scanner', authenticate, emailScannerRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message || err);
  
  // Handle Sequelize validation errors
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    const messages = err.errors?.map(e => e.message).join(', ') || err.message;
    return res.status(400).json({
      error: { message: messages }
    });
  }
  
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

// Cleanup job: Two-phase cleanup for shipped items
// Phase 1: Delete photos/images from Cloudinary after 3 months (keeps shipment record for reference)
// Phase 2: Delete entire shipment record after 6 months
async function cleanupOldShippedItems() {
  try {
    // === Phase 1: Strip photos from shipments shipped 3+ months ago ===
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    const shipmentsToStrip = await Shipment.findAll({
      where: {
        status: { [Op.in]: ['shipped', 'archived'] },
        [Op.or]: [
          { shippedAt: { [Op.lt]: threeMonthsAgo } },
          { shippedAt: null, updatedAt: { [Op.lt]: threeMonthsAgo } }
        ]
      },
      include: [{ model: ShipmentPhoto, as: 'photos' }]
    });
    
    const shipmentsWithPhotos = shipmentsToStrip.filter(s => s.photos && s.photos.length > 0);
    if (shipmentsWithPhotos.length > 0) {
      let deletedCount = 0;
      console.log(`[Cleanup] Stripping photos from ${shipmentsWithPhotos.length} shipments older than 3 months...`);
      
      for (const shipment of shipmentsWithPhotos) {
        for (const photo of shipment.photos) {
          if (photo.cloudinaryId) {
            try {
              await cloudinary.uploader.destroy(photo.cloudinaryId);
              deletedCount++;
            } catch (e) {
              console.error(`[Cleanup] Failed to delete Cloudinary image ${photo.cloudinaryId}:`, e.message);
            }
          }
          await photo.destroy();
        }
      }
      console.log(`[Cleanup] Phase 1 complete: Deleted ${deletedCount} photos from ${shipmentsWithPhotos.length} shipments`);
    }

    // === Phase 2: Delete entire shipment records shipped 6+ months ago ===
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const shipmentsToDelete = await Shipment.findAll({
      where: {
        status: { [Op.in]: ['shipped', 'archived'] },
        [Op.or]: [
          { shippedAt: { [Op.lt]: sixMonthsAgo } },
          { shippedAt: null, updatedAt: { [Op.lt]: sixMonthsAgo } }
        ]
      },
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ]
    });
    
    if (shipmentsToDelete.length > 0) {
      console.log(`[Cleanup] Deleting ${shipmentsToDelete.length} shipment records older than 6 months...`);
      
      for (const shipment of shipmentsToDelete) {
        // Delete any remaining photos from Cloudinary
        for (const photo of shipment.photos) {
          if (photo.cloudinaryId) {
            try { await cloudinary.uploader.destroy(photo.cloudinaryId); } catch (e) {}
          }
        }
        
        // Delete documents from Cloudinary
        for (const doc of shipment.documents) {
          if (doc.cloudinaryId) {
            try { await cloudinary.uploader.destroy(doc.cloudinaryId, { resource_type: 'raw' }); } catch (e) {}
          }
        }
        
        await shipment.destroy();
      }
      console.log(`[Cleanup] Phase 2 complete: Deleted ${shipmentsToDelete.length} shipment records`);
    }
  } catch (error) {
    console.error('[Cleanup] Error:', error);
  }
}

// Database sync and server start
async function startServer() {
  // Start listening IMMEDIATELY so Heroku doesn't kill us during DB sync
  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    const { getProvider } = require('./utils/storage');
    console.log(`File storage: ${getProvider() === 's3' ? 'Amazon S3 (' + process.env.AWS_S3_BUCKET + ')' : 'Cloudinary (legacy)'}`);
  });

  // Prevent Heroku H13 (Connection closed without response) and H18 (Server Request Interrupted)
  // Heroku's router timeout is 30s, keep Node's alive longer to avoid premature close
  server.keepAliveTimeout = 65000; // 65s > Heroku's 55s ALB idle timeout
  server.headersTimeout = 66000;   // Slightly higher than keepAlive

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

    // Add rush_service to partType ENUMs BEFORE sync
    try {
      for (const table of ['work_order_parts', 'estimate_parts']) {
        const [typeInfo] = await sequelize.query(
          `SELECT udt_name FROM information_schema.columns WHERE table_name = '${table}' AND column_name = 'partType'`
        );
        if (typeInfo.length > 0) {
          const enumName = typeInfo[0].udt_name;
          const [vals] = await sequelize.query(`SELECT unnest(enum_range(NULL::${enumName}))::text as val`);
          if (!vals.some(v => v.val === 'rush_service')) {
            await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'rush_service'`);
            console.log(`Added rush_service to ${enumName}`);
          }
        }
      }
    } catch (enumErr) {
      console.log('Pre-sync rush_service enum addition:', enumErr.message);
    }

    // Add on_edge to rollType ENUMs BEFORE sync (for channel rolls)
    try {
      for (const table of ['work_order_parts', 'estimate_parts']) {
        const [typeInfo] = await sequelize.query(
          `SELECT udt_name FROM information_schema.columns WHERE table_name = '${table}' AND column_name = 'rollType'`
        );
        if (typeInfo.length > 0) {
          const enumName = typeInfo[0].udt_name;
          const [vals] = await sequelize.query(`SELECT unnest(enum_range(NULL::${enumName}))::text as val`);
          if (!vals.some(v => v.val === 'on_edge')) {
            await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'on_edge'`);
            console.log(`Added on_edge to ${enumName}`);
          }
        }
      }
    } catch (enumErr) {
      console.log('Pre-sync on_edge enum addition:', enumErr.message);
    }

    // Convert po_numbers status from ENUM to VARCHAR (to support 'archived')
    try {
      const [poCol] = await sequelize.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'po_numbers' AND column_name = 'status'`
      );
      if (poCol.length > 0 && poCol[0].data_type === 'USER-DEFINED') {
        await sequelize.query(`ALTER TABLE po_numbers ALTER COLUMN status TYPE VARCHAR(255) USING status::text`);
        await sequelize.query(`DROP TYPE IF EXISTS "enum_po_numbers_status"`);
        console.log('Converted po_numbers.status from ENUM to VARCHAR');
      }
    } catch (enumErr) {
      console.log('PO status pre-sync conversion:', enumErr.message);
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

    // Migrate picked_up status to shipped (consolidated statuses)
    try {
      const [results] = await sequelize.query(`UPDATE work_orders SET status = 'shipped' WHERE status = 'picked_up'`);
      const count = results?.rowCount || results?.length || 0;
      if (count > 0) console.log(`Migrated ${count} work orders from picked_up to shipped`);
    } catch (e) { /* ignore */ }

    // Reset vacation days on Jan 1 each year
    try {
      const currentYear = new Date().getFullYear();
      const [vacReset] = await sequelize.query(
        `UPDATE employees SET "vacationDaysUsed" = 0, "vacationLog" = '[]', "vacationResetYear" = ${currentYear} WHERE "vacationResetYear" IS NULL OR "vacationResetYear" < ${currentYear}`
      );
      const vacCount = vacReset?.rowCount || vacReset?.length || 0;
      if (vacCount > 0) console.log(`Reset vacation days for ${vacCount} employees (year ${currentYear})`);
    } catch (e) { /* ignore */ }

    // Backfill vendorId on POs and InboundOrders that only have supplier name
    try {
      const [poFixed] = await sequelize.query(`
        UPDATE po_numbers SET "vendorId" = v.id 
        FROM vendors v 
        WHERE po_numbers."vendorId" IS NULL 
        AND po_numbers.supplier IS NOT NULL 
        AND LOWER(po_numbers.supplier) = LOWER(v.name)
      `);
      const [ioFixed] = await sequelize.query(`
        UPDATE inbound_orders SET "vendorId" = v.id 
        FROM vendors v 
        WHERE inbound_orders."vendorId" IS NULL 
        AND (
          (inbound_orders."supplierName" IS NOT NULL AND LOWER(inbound_orders."supplierName") = LOWER(v.name))
          OR (inbound_orders.supplier IS NOT NULL AND LOWER(inbound_orders.supplier) = LOWER(v.name))
        )
      `);
      const poCount = poFixed?.rowCount || 0;
      const ioCount = ioFixed?.rowCount || 0;
      if (poCount > 0 || ioCount > 0) console.log(`Backfilled vendorId: ${poCount} POs, ${ioCount} inbound orders`);
    } catch (e) { console.log('VendorId backfill skipped:', e.message); }

    // Backfill clientId on WOs, Estimates, etc. that only have clientName
    try {
      const tables = ['work_orders', 'estimates', 'po_numbers', 'inbound_orders', 'dr_numbers'];
      let totalFixed = 0;
      for (const tbl of tables) {
        try {
          const [fixed] = await sequelize.query(`
            UPDATE "${tbl}" SET "clientId" = c.id 
            FROM clients c 
            WHERE "${tbl}"."clientId" IS NULL 
            AND "${tbl}"."clientName" IS NOT NULL 
            AND LOWER("${tbl}"."clientName") = LOWER(c.name)
          `);
          totalFixed += fixed?.rowCount || 0;
        } catch {}
      }
      if (totalFixed > 0) console.log(`Backfilled clientId: ${totalFixed} records across tables`);
    } catch (e) { console.log('ClientId backfill skipped:', e.message); }
    
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
            const hasRushService = vals.some(v => v.val === 'rush_service');
            if (!hasRushService) {
              await sequelize.query(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS 'rush_service'`);
              console.log(`Added rush_service to ${enumName}`);
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
      // Ensure vendorEstimateNumber column exists on work_order_parts
      if (!wopColNames.includes('vendorEstimateNumber')) {
        await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "vendorEstimateNumber" VARCHAR(255) DEFAULT NULL`);
        console.log('Added vendorEstimateNumber to work_order_parts');
      }
      // Backfill vendorEstimateNumber from linked estimate parts where missing
      try {
        const [bfResult] = await sequelize.query(`
          UPDATE work_order_parts wop
          SET "vendorEstimateNumber" = ep."vendorEstimateNumber"
          FROM work_orders wo
          JOIN estimates e ON e.id = wo."estimateId"
          JOIN estimate_parts ep ON ep."estimateId" = e.id AND ep."partNumber" = wop."partNumber"
          WHERE wop."workOrderId" = wo.id
          AND ep."vendorEstimateNumber" IS NOT NULL AND ep."vendorEstimateNumber" != ''
          AND (wop."vendorEstimateNumber" IS NULL OR wop."vendorEstimateNumber" = '')
        `);
        const bfCount = bfResult?.rowCount || 0;
        if (bfCount > 0) console.log(`Backfilled vendorEstimateNumber for ${bfCount} work order parts from estimates`);
      } catch (bfErr) {
        console.log('vendorEstimateNumber backfill:', bfErr.message);
      }
      // Backfill clientPartNumber from linked estimate parts where missing
      try {
        const [cpResult] = await sequelize.query(`
          UPDATE work_order_parts wop
          SET "clientPartNumber" = ep."clientPartNumber"
          FROM work_orders wo
          JOIN estimates e ON e.id = wo."estimateId"
          JOIN estimate_parts ep ON ep."estimateId" = e.id AND ep."partNumber" = wop."partNumber"
          WHERE wop."workOrderId" = wo.id
          AND ep."clientPartNumber" IS NOT NULL AND ep."clientPartNumber" != ''
          AND (wop."clientPartNumber" IS NULL OR wop."clientPartNumber" = '')
        `);
        const cpCount = cpResult?.rowCount || 0;
        if (cpCount > 0) console.log(`Backfilled clientPartNumber for ${cpCount} work order parts from estimates`);
      } catch (bfErr) {
        console.log('clientPartNumber backfill:', bfErr.message);
      }
      // Backfill heatNumber from linked estimate parts where missing
      try {
        const [hnResult] = await sequelize.query(`
          UPDATE work_order_parts wop
          SET "heatNumber" = ep."heatNumber"
          FROM work_orders wo
          JOIN estimates e ON e.id = wo."estimateId"
          JOIN estimate_parts ep ON ep."estimateId" = e.id AND ep."partNumber" = wop."partNumber"
          WHERE wop."workOrderId" = wo.id
          AND ep."heatNumber" IS NOT NULL AND ep."heatNumber" != ''
          AND (wop."heatNumber" IS NULL OR wop."heatNumber" = '')
        `);
        const hnCount = hnResult?.rowCount || 0;
        if (hnCount > 0) console.log(`Backfilled heatNumber for ${hnCount} work order parts from estimates`);
      } catch (bfErr) {
        console.log('heatNumber backfill:', bfErr.message);
      }
      // Ensure heatBreakdown column exists
      if (!wopColNames.includes('heatBreakdown')) {
        await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "heatBreakdown" JSONB DEFAULT NULL`);
        console.log('Added heatBreakdown to work_order_parts');
      }
    } catch (wopErr) {
      console.error('Work order parts column check warning:', wopErr.message);
    }

    // Ensure estimate_parts has vendorEstimateNumber column
    try {
      const [epCols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'estimate_parts'`
      );
      const epColNames = epCols.map(c => c.column_name);
      if (!epColNames.includes('vendorEstimateNumber')) {
        await sequelize.query(`ALTER TABLE estimate_parts ADD COLUMN "vendorEstimateNumber" VARCHAR(255) DEFAULT NULL`);
        console.log('Added vendorEstimateNumber to estimate_parts');
      }
    } catch (epErr) {
      console.error('Estimate parts column check warning:', epErr.message);
    }

    // Ensure shop_supplies has imageUrl column
    try {
      const [ssCols] = await sequelize.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'shop_supplies'`);
      const ssColNames = ssCols.map(c => c.column_name);
      if (!ssColNames.includes('imageUrl')) {
        await sequelize.query(`ALTER TABLE shop_supplies ADD COLUMN "imageUrl" VARCHAR(255) DEFAULT NULL`);
        await sequelize.query(`ALTER TABLE shop_supplies ADD COLUMN "imageCloudinaryId" VARCHAR(255) DEFAULT NULL`);
        console.log('Added imageUrl/imageCloudinaryId to shop_supplies');
      }
    } catch (ssErr) {
      console.error('Shop supplies column check:', ssErr.message);
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
    
    // Archive old estimates on startup
    try {
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      const [archiveCount] = await Estimate.update(
        { status: 'archived', archivedAt: new Date() },
        { where: { status: { [Op.notIn]: ['archived', 'accepted'] }, createdAt: { [Op.lt]: oneMonthAgo } } }
      );
      if (archiveCount > 0) console.log(`Archived ${archiveCount} estimates older than 1 month`);
    } catch (e) { console.log('Estimate archive:', e.message); }
    
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

    // Auto-backup to Cloudinary every Saturday at 11 PM Pacific
    const { runAutoBackup } = require('./routes/backup');
    cron.schedule('0 23 * * 6', async () => {
      console.log('[CRON] Running scheduled Saturday night auto-backup...');
      try {
        const result = await runAutoBackup(false);
        if (result.success) {
          console.log(`[CRON] Auto-backup successful: ${(result.size / 1024).toFixed(0)}KB`);
        } else {
          console.error('[CRON] Auto-backup failed:', result.error);
        }
      } catch (err) {
        console.error('[CRON] Auto-backup error:', err.message);
      }
    }, {
      timezone: 'America/Los_Angeles'
    });
    console.log('Auto-backup configured for every Saturday at 11 PM Pacific');

    // Auto-archive old estimates daily at 1:00 AM Pacific
    cron.schedule('0 1 * * *', async () => {
      try {
        const { Op } = require('sequelize');
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        const [count] = await Estimate.update(
          { status: 'archived', archivedAt: new Date() },
          { where: { status: { [Op.notIn]: ['archived', 'accepted'] }, createdAt: { [Op.lt]: oneMonthAgo } } }
        );
        if (count > 0) console.log(`[auto-archive] Archived ${count} estimates older than 1 month`);
      } catch (err) {
        console.error('[auto-archive] Failed:', err.message);
      }
    }, { timezone: 'America/Los_Angeles' });
    console.log('Auto-archive configured for daily at 1:00 AM Pacific');

    // Email Scanner — every 5 minutes during business hours
    cron.schedule('*/5 * * * *', async () => {
      try {
        const { runScan } = require('./services/emailScanner');
        const result = await runScan();
        if (result.processed > 0) {
          console.log(`[EmailScanner] Processed ${result.processed} emails, ${result.estimates} estimates, ${result.pendingOrders} pending orders`);
        }
      } catch (err) {
        console.error('[EmailScanner] Cron error:', err.message);
      }
    });
    console.log('Email scanner cron configured for every 5 minutes');

    // AI Parse Retry — check every minute for emails needing retry
    cron.schedule('* * * * *', async () => {
      try {
        const { processRetries } = require('./services/emailScanner');
        await processRetries();
      } catch (err) {
        console.error('[EmailScanner] Retry cron error:', err.message);
      }
    });
    console.log('AI parse retry timer configured (every minute)');

    // Trash cleanup — permanently delete estimates trashed > 30 days ago (runs daily at 2 AM)
    cron.schedule('0 2 * * *', async () => {
      try {
        const { Estimate, EstimatePart, EstimateFile, EstimatePartFile } = require('./models');
        const { Op } = require('sequelize');
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const trashed = await Estimate.findAll({
          where: { trashedAt: { [Op.lt]: cutoff } },
          include: [{ model: EstimateFile, as: 'files' }]
        });
        if (trashed.length > 0) {
          for (const est of trashed) {
            for (const file of est.files || []) {
              if (file.cloudinaryId) try { const cloudinary = require('cloudinary').v2; await cloudinary.uploader.destroy(file.cloudinaryId); } catch {}
            }
            await EstimatePartFile.destroy({ where: { '$part.estimateId$': est.id }, include: [{ model: EstimatePart, as: 'part' }] }).catch(() => {});
            await EstimatePart.destroy({ where: { estimateId: est.id } });
            await EstimateFile.destroy({ where: { estimateId: est.id } });
            await est.destroy();
          }
          console.log(`[Trash] Permanently deleted ${trashed.length} estimates older than 30 days`);
        }
      } catch (err) {
        console.error('[Trash] Cleanup error:', err.message);
      }
    });
    console.log('Trash cleanup cron configured (daily at 2 AM, 30-day retention)');

  } catch (error) {
    console.error('Startup error (server still running):', error.message);
  }
}

startServer();
