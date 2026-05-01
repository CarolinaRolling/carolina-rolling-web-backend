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




// Communication Center scan log (in-memory, last 100 entries)
const commScanLog = [];
let commScanStatus = { running: false, startedAt: null, completedAt: null, error: null };

function logComm(level, message, detail = null) {
  const entry = { ts: new Date().toISOString(), level, message, detail };
  commScanLog.unshift(entry);
  if (commScanLog.length > 100) commScanLog.pop();
  if (level === 'error') console.error('[CommScanner]', message, detail || '');
  else console.log('[CommScanner]', message);
}

// Helper: Gmail call with timeout
async function gmailWithTimeout(fn, timeoutMs = 20000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Gmail API timeout after ' + timeoutMs + 'ms')), timeoutMs))
  ]);
}

// Communication Center API
app.get('/api/com-center/emails', authenticate, async (req, res) => {
  try {
    const { ScannedEmail } = require('./models');
    const { Op } = require('sequelize');
    const { category, archived, limit = 100, offset = 0 } = req.query;
    const where = { commProcessed: true, emailType: 'comm_center' };
    if (category && category !== 'all') where.commCategory = category;
    where.commArchived = archived === 'true';
    const emails = await ScannedEmail.findAll({
      where, order: [['receivedAt', 'DESC']], limit: parseInt(limit), offset: parseInt(offset)
    });
    const total = await ScannedEmail.count({ where });
    res.json({ data: emails, total });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.patch('/api/com-center/emails/:id/archive', authenticate, async (req, res) => {
  try {
    const { ScannedEmail } = require('./models');
    const email = await ScannedEmail.findByPk(req.params.id);
    if (!email) return res.status(404).json({ error: { message: 'Not found' } });
    await email.update({ commArchived: !email.commArchived });
    res.json({ data: email });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.patch('/api/com-center/emails/:id/category', authenticate, async (req, res) => {
  try {
    const { ScannedEmail } = require('./models');
    const email = await ScannedEmail.findByPk(req.params.id);
    if (!email) return res.status(404).json({ error: { message: 'Not found' } });
    await email.update({ commCategory: req.body.category });
    res.json({ data: email });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.get('/api/com-center/logs', authenticate, (req, res) => {
  res.json({ data: commScanLog, status: commScanStatus });
});

app.post('/api/com-center/scan-now', authenticate, async (req, res) => {
  try {
    // Run the comm scanner immediately in background
    res.json({ message: 'Scan started' });
    setImmediate(async () => {
      if (commScanStatus.running) { logComm('warn', 'Scan already in progress — skipping'); return; }
      commScanStatus = { running: true, startedAt: new Date().toISOString(), completedAt: null, error: null };
      logComm('info', 'Manual scan started');
      try {
        const { GmailAccount, ScannedEmail, Client, Vendor } = require('./models');
        const { google } = require('googleapis');
        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const { Op } = require('sequelize');

        const monitoredClients = await Client.findAll({ where: { emailScanEnabled: true, isActive: true }, attributes: ['emailScanAddresses'] });
        const monitoredAddrs = new Set();
        monitoredClients.forEach(c => (c.emailScanAddresses || []).forEach(a => monitoredAddrs.add(a.toLowerCase().trim())));

        const allVendors = await Vendor.findAll({ where: { isActive: true }, attributes: ['name', 'emailScanAddresses', 'contactEmail'] });
        const vendorAddrs = {};
        allVendors.forEach(v => {
          const addrs = [...(v.emailScanAddresses || [])];
          if (v.contactEmail) addrs.push(v.contactEmail);
          addrs.forEach(a => { vendorAddrs[a.toLowerCase().trim()] = v.name; });
        });

        const allClients = await Client.findAll({ where: { isActive: true }, attributes: ['name', 'emailScanAddresses', 'contacts', 'emailScanEnabled'] });
        const clientAddrs = {};
        allClients.filter(c => !c.emailScanEnabled).forEach(c => {
          (c.emailScanAddresses || []).forEach(a => { clientAddrs[a.toLowerCase().trim()] = c.name; });
          (c.contacts || []).forEach(ct => { if (ct.email) clientAddrs[ct.email.toLowerCase().trim()] = c.name; });
        });

        const accounts = await GmailAccount.findAll({ where: { isActive: true } });
        logComm('info', 'Found ' + accounts.length + ' Gmail account(s) to scan');
        for (const account of accounts) {
          try {
            logComm('info', 'Scanning account: ' + (account.email || account.id));
            const oauth2 = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
            oauth2.setCredentials({ access_token: account.accessToken, refresh_token: account.refreshToken, expiry_date: account.tokenExpiry });
            const gmail = google.gmail({ version: 'v1', auth: oauth2 });
            const res2 = await gmailWithTimeout(() => gmail.users.messages.list({ userId: 'me', q: '-label:cr-processed -label:cr-comm-scanned newer_than:2d', maxResults: 50 }));
            const messages = res2.data.messages || [];
            logComm('info', 'Found ' + messages.length + ' new message(s) on ' + (account.email || account.id));
            if (!messages.length) continue;
            const labelsRes = await gmailWithTimeout(() => gmail.users.labels.list({ userId: 'me' }));
            let commLabelId;
            const existingLabel = (labelsRes.data.labels || []).find(l => l.name === 'cr-comm-scanned');
            if (existingLabel) { commLabelId = existingLabel.id; }
            else { const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'cr-comm-scanned', labelListVisibility: 'labelShow', messageListVisibility: 'show' } }); commLabelId = created.data.id; }

            for (const msg of messages) {
              try {
                const existing = await ScannedEmail.findOne({ where: { gmailMessageId: msg.id, commProcessed: true } });
                if (existing) continue;
                logComm('info', 'Processing message ' + msg.id.substring(0, 8) + '...');
                const detail = await gmailWithTimeout(() => gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }));
                const headers = detail.data.payload?.headers || [];
                const fromHeader = headers.find(h => h.name === 'From')?.value || '';
                const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
                const dateHeader = headers.find(h => h.name === 'Date')?.value;
                const snippet = detail.data.snippet || '';
                const fromMatch = fromHeader.match(/<(.+?)>/) || [null, fromHeader];
                const fromEmail = (fromMatch[1] || fromHeader).toLowerCase().trim();
                const fromName = fromHeader.replace(/<.*>/, '').replace(/"/g, '').trim();
                if (monitoredAddrs.has(fromEmail) || fromEmail.includes('noreply') || fromEmail.includes('no-reply') || fromEmail.includes('donotreply') || fromEmail.includes('mailer-daemon')) {
                  await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [commLabelId] } });
                  continue;
                }
                let category = 'general';
                if (vendorAddrs[fromEmail]) { category = 'vendor'; }
                else if (clientAddrs[fromEmail]) { category = 'client_inquiry'; }
                else {
                  const classifyRes = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 50, messages: [{ role: 'user', content: 'Classify this email into one category. Reply with ONLY the category word. Categories: client_inquiry, vendor, bill, marketing, spam, general. From: ' + fromHeader + ' Subject: ' + subject + ' Snippet: ' + snippet.substring(0, 200) }] });
                  const raw = classifyRes.content[0]?.text?.trim().toLowerCase() || 'general';
                  const validCats = ['client_inquiry', 'vendor', 'bill', 'marketing', 'spam', 'general'];
                  category = validCats.includes(raw) ? raw : 'general';
                }
                const gmailLink = 'https://mail.google.com/mail/u/0/#inbox/' + msg.id;
                await ScannedEmail.upsert({ gmailMessageId: msg.id, gmailAccountId: account.id, gmailThreadId: detail.data.threadId, fromEmail, fromName: fromName || fromEmail, subject, receivedAt: dateHeader ? new Date(dateHeader) : new Date(), commCategory: category, commProcessed: true, commSnippet: snippet.substring(0, 500), commArchived: false, gmailLink, status: 'processed', emailType: 'comm_center' }, { conflictFields: ['gmailMessageId'] });
                await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [commLabelId] } });
              } catch (msgErr) { console.error('[CommScanner] msg error:', msgErr.message); }
            }
          } catch (accErr) { console.error('[CommScanner] account error:', accErr.message); }
        }
        console.log('[CommScanner] Manual scan complete');
      } catch (e) { console.error('[CommScanner] scan-now error:', e.message); }
    });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});


app.use('/api', authenticate, clientsVendorsRoutes);
app.use('/api', authenticate, permitVerificationRoutes);
app.use('/api/quickbooks', authenticate, quickbooksRoutes);
app.use('/api/shop-supplies', authenticate, shopSuppliesRoutes);
const todoRoutes = require('./routes/todos');
app.use('/api/todos', authenticate, todoRoutes);

// Vendor Portal routes — vendor-scoped API key access, no JWT
const vendorPortalRoutes = require('./routes/vendor-portal');
app.use('/api/vendor-portal', vendorPortalRoutes);

// Client Portal routes — mounted at /api/portal for portal app access
const portalRouter = require('express').Router();
const portalModels = require('./models');
const portalFileStorage = require('./utils/storage');

// GET /api/portal/:drNumber/documents - list portal-visible documents for a DR
portalRouter.get('/:drNumber/documents', async (req, res, next) => {
  try {
    const drNumber = parseInt(req.params.drNumber);
    if (!drNumber) return res.status(400).json({ error: { message: 'Invalid DR number' } });
    const workOrder = await portalModels.WorkOrder.findOne({ where: { drNumber } });
    if (!workOrder) return res.status(404).json({ error: { message: 'Order not found' } });
    const documents = await portalModels.WorkOrderDocument.findAll({
      where: { workOrderId: workOrder.id, portalVisible: true },
      order: [['createdAt', 'DESC']]
    });
    const data = await Promise.all(documents.map(async (d) => {
      let downloadUrl = null;
      try {
        const sid = d.cloudinaryId || d.url;
        if (sid) downloadUrl = await portalFileStorage.getPresignedUrl(sid, 3600, d.originalName);
        if (!downloadUrl) downloadUrl = d.url; // fallback to raw URL
      } catch {}
      return { id: d.id, name: d.originalName, type: d.documentType, mimeType: d.mimeType, size: d.size, date: d.createdAt, workOrderId: workOrder.id, drNumber, downloadUrl };
    }));
    res.json({ data });
  } catch (error) { next(error); }
});

// GET /api/portal/:drNumber/documents/:docId/download - download a portal-visible document
portalRouter.get('/:drNumber/documents/:docId/download', async (req, res, next) => {
  try {
    const drNumber = parseInt(req.params.drNumber);
    if (!drNumber) return res.status(400).json({ error: { message: 'Invalid DR number' } });
    const workOrder = await portalModels.WorkOrder.findOne({ where: { drNumber } });
    if (!workOrder) return res.status(404).json({ error: { message: 'Order not found' } });
    const document = await portalModels.WorkOrderDocument.findOne({
      where: { id: req.params.docId, workOrderId: workOrder.id, portalVisible: true }
    });
    if (!document) return res.status(404).json({ error: { message: 'Document not found or not available' } });
    const sid = document.cloudinaryId || document.url;
    if (sid) {
      let presignedUrl = await portalFileStorage.getPresignedUrl(sid, 3600, document.originalName);
      if (!presignedUrl) presignedUrl = document.url;
      res.json({ data: { url: presignedUrl, name: document.originalName, mimeType: document.mimeType } });
    } else {
      res.status(404).json({ error: { message: 'File not available' } });
    }
  } catch (error) { next(error); }
});

// GET /api/portal/estimate/:estimateNumber/files - list portal-visible files for an estimate
portalRouter.get('/estimate/:estimateNumber/files', async (req, res, next) => {
  try {
    const estimate = await portalModels.Estimate.findOne({ where: { estimateNumber: req.params.estimateNumber } });
    if (!estimate) return res.status(404).json({ error: { message: 'Estimate not found' } });
    const parts = await portalModels.EstimatePart.findAll({ where: { estimateId: estimate.id }, include: [{ model: portalModels.EstimatePartFile, as: 'files', where: { portalVisible: true }, required: true }] });
    const files = await Promise.all(parts.flatMap(p => (p.files || []).map(async (f) => {
      let downloadUrl = null;
      try {
        const sid = f.cloudinaryId || f.url;
        if (sid) downloadUrl = await portalFileStorage.getPresignedUrl(sid, 3600, f.originalName || f.filename);
        if (!downloadUrl) downloadUrl = f.url;
      } catch {}
      return { id: f.id, name: f.originalName || f.filename, type: f.fileType, mimeType: f.mimeType, size: f.size, date: f.createdAt, partNumber: p.partNumber, partType: p.partType, downloadUrl };
    })));
    res.json({ data: files });
  } catch (error) { next(error); }
});

// GET /api/portal/estimate/:estimateNumber/files/:fileId/download - download a portal-visible estimate file
portalRouter.get('/estimate/:estimateNumber/files/:fileId/download', async (req, res, next) => {
  try {
    const estimate = await portalModels.Estimate.findOne({ where: { estimateNumber: req.params.estimateNumber } });
    if (!estimate) return res.status(404).json({ error: { message: 'Estimate not found' } });
    const parts = await portalModels.EstimatePart.findAll({ where: { estimateId: estimate.id }, include: [{ model: portalModels.EstimatePartFile, as: 'files' }] });
    const file = parts.flatMap(p => p.files || []).find(f => f.id === req.params.fileId && f.portalVisible);
    if (!file) return res.status(404).json({ error: { message: 'File not found or not available' } });
    const sid = file.cloudinaryId || file.url;
    if (sid) {
      let presignedUrl = await portalFileStorage.getPresignedUrl(sid, 3600, file.originalName || file.filename);
      if (!presignedUrl) presignedUrl = file.url;
      res.json({ data: { url: presignedUrl, name: file.originalName || file.filename, mimeType: file.mimeType } });
    } else {
      res.status(404).json({ error: { message: 'File not available' } });
    }
  } catch (error) { next(error); }
});

app.use('/api/portal', authenticate, portalRouter);


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
    
    // Explicitly add contactExtension to work_orders and estimates if missing
    // (alter:true sometimes misses new columns on Heroku Postgres)
    try {
      await sequelize.query(`
        ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "contactExtension" VARCHAR(255);
        ALTER TABLE estimates ADD COLUMN IF NOT EXISTS "contactExtension" VARCHAR(255);
        ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "progressCount" INTEGER;
        ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "progressLastUpdatedAt" TIMESTAMP WITH TIME ZONE;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 999;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS "requiresCoc" BOOLEAN DEFAULT false;
        ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commCategory" VARCHAR(50);
        ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commProcessed" BOOLEAN DEFAULT false;
        ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commSnippet" TEXT;
        ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commArchived" BOOLEAN DEFAULT false;
        ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "progressLog" JSONB DEFAULT '[]';
        ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 999;
      `);
      console.log('column migrations ensured');
    } catch (e) {
      console.log('column migration error:', e.message);
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

    // Ensure portalVisible column exists on work_order_documents and estimate_part_files
    try {
      await sequelize.query(`ALTER TABLE work_order_documents ADD COLUMN IF NOT EXISTS "portalVisible" BOOLEAN DEFAULT false`);
      console.log('Ensured portalVisible column on work_order_documents');
    } catch (e) { console.log('portalVisible migration (wo_docs):', e.message); }
    try {
      await sequelize.query(`ALTER TABLE estimate_part_files ADD COLUMN IF NOT EXISTS "portalVisible" BOOLEAN DEFAULT false`);
      console.log('Ensured portalVisible column on estimate_part_files');
    } catch (e) { console.log('portalVisible migration (est_files):', e.message); }

    // Ensure signatureName column exists on users
    try {
      await sequelize.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "signatureName" VARCHAR(255)`);
      console.log('Ensured signatureName column on users');
    } catch (e) { console.log('signatureName migration:', e.message); }

    // Outside processing service type, status, and dates
    try {
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "outsideProcessingServiceType" VARCHAR(255)`);
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "outsideProcessingStatus" VARCHAR(50) DEFAULT 'not_sent'`);
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "outsideProcessingExpectedReturn" TIMESTAMPTZ`);
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "outsideProcessingReturnedAt" TIMESTAMPTZ`);
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "outsideProcessingExpediteCost" DECIMAL(10,2) DEFAULT 0`);
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "outsideProcessing" JSONB DEFAULT '[]'::jsonb`);
      await sequelize.query(`ALTER TABLE estimate_parts ADD COLUMN IF NOT EXISTS "outsideProcessing" JSONB DEFAULT '[]'::jsonb`);
      await sequelize.query(`ALTER TABLE estimates ADD COLUMN IF NOT EXISTS "opTransports" JSONB DEFAULT '[]'::jsonb`);
      await sequelize.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "opTransports" JSONB DEFAULT '[]'::jsonb`);
      // Vendor portal migrations
      await sequelize.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS "vendorName" VARCHAR(255)`);
      await sequelize.query(`ALTER TABLE work_order_part_files ADD COLUMN IF NOT EXISTS "vendorPortalVisible" BOOLEAN DEFAULT false NOT NULL`);
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS vendor_issues (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "workOrderId" UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
          "workOrderPartId" UUID REFERENCES work_order_parts(id) ON DELETE SET NULL,
          "vendorId" UUID REFERENCES vendors(id) ON DELETE SET NULL,
          "vendorName" VARCHAR(255) NOT NULL,
          "poNumber" VARCHAR(255),
          "reportedBy" VARCHAR(255),
          description TEXT NOT NULL,
          "photoUrl" VARCHAR(500),
          "photoStorageId" VARCHAR(500),
          status VARCHAR(50) DEFAULT 'open',
          "reportedAt" TIMESTAMPTZ DEFAULT NOW(),
          "resolvedAt" TIMESTAMPTZ,
          "resolvedBy" VARCHAR(255),
          "resolutionNotes" TEXT,
          "createdAt" TIMESTAMPTZ DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_vendor_issues_wo ON vendor_issues("workOrderId")`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_vendor_issues_status ON vendor_issues(status)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_vendor_issues_vendor ON vendor_issues("vendorId")`);
      console.log('Ensured outside processing tracking columns on work_order_parts');
    } catch (e) { console.log('outside processing tracking migration:', e.message); }

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
    // Check every 15 minutes for WOs where all parts are done but order not completed
    cron.schedule('*/15 * * * *', async () => {
      try {
        const { WorkOrder, WorkOrderPart, TodoItem, User } = require('./models');
        const { Op } = require('sequelize');
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        // Find active WOs not yet completed/shipped
        const activeWOs = await WorkOrder.findAll({
          where: { status: { [Op.in]: ['processing', 'in_progress', 'received', 'work_order_generated'] } },
          attributes: ['id', 'drNumber', 'orderNumber', 'clientName', 'status']
        });
        for (const wo of activeWOs) {
          const parts = await WorkOrderPart.findAll({
            where: { workOrderId: wo.id },
            attributes: ['id', 'status', 'completedAt', 'partType']
          });
          const relevant = parts.filter(p => !['rush_service'].includes(p.partType));
          if (relevant.length === 0) continue;
          const allDone = relevant.every(p => p.status === 'completed');
          if (!allDone) continue;
          // Find latest completedAt
          const latestDone = relevant.reduce((latest, p) => {
            if (!p.completedAt) return latest;
            return !latest || new Date(p.completedAt) > new Date(latest) ? p.completedAt : latest;
          }, null);
          if (!latestDone || new Date(latestDone) > oneHourAgo) continue;
          // Check if todo already exists for this WO
          const label = wo.drNumber || wo.orderNumber;
          const existing = await TodoItem.findOne({
            where: { title: { [Op.like]: `%${label}%` }, type: 'general', createdBy: 'Auto-Complete Check', isDone: false }
          });
          if (existing) continue;
          const headUser = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
          await TodoItem.create({
            title: `✅ All parts complete — confirm with operator: ${label} (${wo.clientName || ''})`,
            description: `All parts on ${label} were marked complete over 1 hour ago but the work order has not been marked complete.

Please confirm with the operator and mark the order complete if ready.`,
            type: 'general',
            priority: 'high',
            assignedTo: headUser?.username || null,
            createdBy: 'Auto-Complete Check'
          });
          console.log('[CRON] All-parts-done reminder created for ' + label);
        }
      } catch (e) {
        console.error('[CRON] All-parts-done check error:', e.message);
      }
    });

    // Communication Center scanner — every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
      try {
        const { GmailAccount, ScannedEmail, Client, Vendor } = require('./models');
        const { google } = require('googleapis');
        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        // Build set of monitored addresses (handled by estimate scanner — skip these)
        const monitoredClients = await Client.findAll({ where: { emailScanEnabled: true, isActive: true }, attributes: ['emailScanAddresses'] });
        const monitoredAddrs = new Set();
        monitoredClients.forEach(c => (c.emailScanAddresses || []).forEach(a => monitoredAddrs.add(a.toLowerCase().trim())));

        // Build vendor address map
        const allVendors = await Vendor.findAll({ where: { isActive: true }, attributes: ['name', 'emailScanAddresses', 'contactEmail'] });
        const vendorAddrs = {};
        allVendors.forEach(v => {
          const addrs = [...(v.emailScanAddresses || [])];
          if (v.contactEmail) addrs.push(v.contactEmail);
          addrs.forEach(a => { vendorAddrs[a.toLowerCase().trim()] = v.name; });
        });

        // Build unmonitored known client address map
        const allClients = await Client.findAll({ where: { isActive: true }, attributes: ['name', 'emailScanAddresses', 'contacts'] });
        const clientAddrs = {};
        allClients.filter(c => !c.emailScanEnabled).forEach(c => {
          (c.emailScanAddresses || []).forEach(a => { clientAddrs[a.toLowerCase().trim()] = c.name; });
          (c.contacts || []).forEach(ct => { if (ct.email) clientAddrs[ct.email.toLowerCase().trim()] = c.name; });
        });

        const accounts = await GmailAccount.findAll({ where: { isActive: true } });
        for (const account of accounts) {
          try {
            const oauth2 = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
            oauth2.setCredentials({ access_token: account.accessToken, refresh_token: account.refreshToken, expiry_date: account.tokenExpiry });
            const gmail = google.gmail({ version: 'v1', auth: oauth2 });

            // Fetch emails NOT labeled cr-processed AND NOT labeled cr-comm-scanned, last 2 days
            const res = await gmail.users.messages.list({
              userId: 'me',
              q: '-label:cr-processed -label:cr-comm-scanned newer_than:2d',
              maxResults: 50
            });
            const messages = res.data.messages || [];
            if (!messages.length) continue;

            // Get or create cr-comm-scanned label
            const labelsRes = await gmail.users.labels.list({ userId: 'me' });
            let commLabelId;
            const existingLabel = (labelsRes.data.labels || []).find(l => l.name === 'cr-comm-scanned');
            if (existingLabel) { commLabelId = existingLabel.id; }
            else {
              const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'cr-comm-scanned', labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
              commLabelId = created.data.id;
            }

            for (const msg of messages) {
              try {
                // Skip if already processed by comm scanner
                const existing = await ScannedEmail.findOne({ where: { gmailMessageId: msg.id, commProcessed: true } });
                if (existing) continue;

                const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
                const headers = detail.data.payload?.headers || [];
                const fromHeader = headers.find(h => h.name === 'From')?.value || '';
                const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
                const dateHeader = headers.find(h => h.name === 'Date')?.value;
                const snippet = detail.data.snippet || '';

                // Extract from email
                const fromMatch = fromHeader.match(/<(.+?)>/) || [null, fromHeader];
                const fromEmail = (fromMatch[1] || fromHeader).toLowerCase().trim();
                const fromName = fromHeader.replace(/<.*>/, '').replace(/"/g, '').trim();

                // Skip monitored addresses — estimate scanner handles these
                if (monitoredAddrs.has(fromEmail)) {
                  await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [commLabelId] } });
                  continue;
                }

                // Skip no-reply / automated senders
                if (fromEmail.includes('noreply') || fromEmail.includes('no-reply') || fromEmail.includes('donotreply') || fromEmail.includes('mailer-daemon')) {
                  await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [commLabelId] } });
                  continue;
                }

                // Determine category
                let category = 'general';
                if (vendorAddrs[fromEmail]) {
                  category = 'vendor';
                } else if (clientAddrs[fromEmail]) {
                  category = 'client_inquiry';
                } else {
                  // AI classification
                  const classifyRes = await anthropic.messages.create({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 50,
                    messages: [{ role: 'user', content: 'Classify this email into one category. Reply with ONLY the category word. Categories: client_inquiry, vendor, bill, marketing, spam, general. From: ' + fromHeader + ' Subject: ' + subject + ' Snippet: ' + snippet.substring(0, 200) }]
                  });
                  const raw = classifyRes.content[0]?.text?.trim().toLowerCase() || 'general';
                  const validCats = ['client_inquiry', 'vendor', 'bill', 'marketing', 'spam', 'general'];
                  category = validCats.includes(raw) ? raw : 'general';
                }

                // Save to ScannedEmail
                const gmailLink = 'https://mail.google.com/mail/u/0/#inbox/' + msg.id;
                await ScannedEmail.upsert({
                  gmailMessageId: msg.id,
                  gmailAccountId: account.id,
                  gmailThreadId: detail.data.threadId,
                  fromEmail,
                  fromName: fromName || fromEmail,
                  subject,
                  receivedAt: dateHeader ? new Date(dateHeader) : new Date(),
                  commCategory: category,
                  commProcessed: true,
                  commSnippet: snippet.substring(0, 500),
                  commArchived: false,
                  gmailLink,
                  status: 'processed',
                  emailType: 'comm_center'
                }, { conflictFields: ['gmailMessageId'] });

                // Apply label
                await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [commLabelId] } });
              } catch (msgErr) {
                logComm('error', 'Message error (cron)', msgErr.message);
              }
            }
          } catch (accErr) {
            logComm('error', 'Account error (cron): ' + (account.email || account.id), accErr.message);
          }
        }
      } catch (e) {
        console.error('[CommScanner] Fatal error:', e.message);
      }
    });

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
