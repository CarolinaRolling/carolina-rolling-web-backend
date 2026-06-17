require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const cron = require('node-cron');
const { sequelize, Shipment, ShipmentPhoto, ShipmentDocument, User, AppSettings, WorkOrder, Client, DailyActivity, Estimate, TodoItem } = require('./models');
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
// Middleware to block portal/vendor API keys from accessing internal routes
// Middleware to block portal/vendor API keys from write operations on internal routes
// Client portal keys (clientName set) may still do GET reads on workorders
const blockPortalKeys = (req, res, next) => {
  if (req.apiKey && req.apiKey.vendorName && !req.apiKey.deviceName) {
    return res.status(403).json({ error: { message: 'Vendor API keys cannot access this endpoint. Use /api/vendor-portal/* routes.' } });
  }
  // Client portal keys — allow GET reads, block writes
  if (req.apiKey && req.apiKey.clientName && !req.apiKey.deviceName) {
    if (req.method !== 'GET') {
      return res.status(403).json({ error: { message: 'Client portal API keys are read-only. Use /api/portal/* for portal actions.' } });
    }
  }
  next();
};

app.use('/api/workorders', authenticate, blockPortalKeys, workordersRoutes);
app.use('/api/estimates', authenticate, blockPortalKeys, estimatesRoutes);
app.use('/api/backup', authenticate, backupRoutes);
const businessRoutes = require('./routes/business');
app.use('/api/business', authenticate, blockPortalKeys, businessRoutes);
app.use('/api/inspections', authenticate, blockPortalKeys, require('./routes/inspection'));
app.use('/api/ginger', authenticate, blockPortalKeys, require('./routes/ginger'));
app.use('/api/dr-numbers', authenticate, drNumbersRoutes);
app.use('/api/po-numbers', authenticate, poNumbersRoutes);
app.use('/api/email', authenticate, emailRoutes);




// Communication Center scan log (in-memory, last 100 entries)
const commScanLog = [];
let commScanStatus = { running: false, startedAt: null, completedAt: null, error: null, cancelled: false };

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
// Rebuild the Gmail deep link so it opens in the correct account (authuser) — fixes old links too
function withGmailLink(emailInstance, accMap) {
  const j = emailInstance.toJSON ? emailInstance.toJSON() : emailInstance;
  const authuser = accMap[j.gmailAccountId];
  const id = j.gmailMessageId;
  if (authuser && id) {
    j.gmailLink = 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(authuser) + '#all/' + id;
  }
  return j;
}

app.get('/api/com-center/emails', authenticate, async (req, res) => {
  try {
    const { ScannedEmail, GmailAccount } = require('./models');
    const { Op } = require('sequelize');
    const { category, archived, limit = 100, offset = 0 } = req.query;
    const where = { commProcessed: true, emailType: 'comm_center' };
    if (category && category !== 'all') where.commCategory = category;
    where.commArchived = archived === 'true';
    const emails = await ScannedEmail.findAll({
      where, order: [['receivedAt', 'DESC']], limit: parseInt(limit), offset: parseInt(offset)
    });
    const total = await ScannedEmail.count({ where });
    const accts = await GmailAccount.findAll({ attributes: ['id', 'email'] });
    const accMap = Object.fromEntries(accts.map(a => [a.id, a.email]));
    const data = emails.map(e => withGmailLink(e, accMap));
    res.json({ data, total });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Resolve a reliable Gmail deep link on demand (fetches the RFC Message-ID and targets the right account)
app.get('/api/com-center/emails/:id/gmail-url', authenticate, async (req, res) => {
  try {
    const { ScannedEmail, GmailAccount } = require('./models');
    const { google } = require('googleapis');
    const email = await ScannedEmail.findByPk(req.params.id);
    if (!email) return res.status(404).json({ error: { message: 'Not found' } });
    const account = await GmailAccount.findByPk(email.gmailAccountId);
    let url = email.gmailLink; // fallback to stored link
    if (account && email.gmailMessageId) {
      try {
        const oauth2 = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
        oauth2.setCredentials({ access_token: account.accessToken, refresh_token: account.refreshToken, expiry_date: account.tokenExpiry });
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        const detail = await gmail.users.messages.get({ userId: 'me', id: email.gmailMessageId, format: 'metadata', metadataHeaders: ['Message-ID', 'Message-Id'] });
        const headers = detail.data.payload?.headers || [];
        const mid = (headers.find(h => (h.name || '').toLowerCase() === 'message-id')?.value || '').replace(/[<>]/g, '').trim();
        if (mid && account.email) {
          // Open the specific message: rfc822msgid search (reliable find) + the message id to auto-open it
          const query = encodeURIComponent('rfc822msgid:' + mid);
          const inner = 'https://mail.google.com/mail/u/0/#search/' + query + '/' + email.gmailMessageId;
          url = 'https://accounts.google.com/AccountChooser?Email=' + encodeURIComponent(account.email) + '&continue=' + encodeURIComponent(inner);
        }
      } catch (gErr) { console.warn('[CommCenter] gmail-url resolve failed:', gErr.message); }
    }
    res.json({ data: { url } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// One-time cleanup: mark conversations with no activity in N days (default 21) as responded
app.post('/api/com-center/cleanup-stale', authenticate, async (req, res) => {
  try {
    const { sequelize } = require('./models');
    const days = parseInt(req.body && req.body.days) || 21;
    const [, meta] = await sequelize.query(
      `UPDATE scanned_emails
         SET "commResponded" = true, "commHandledManually" = true
       WHERE "emailType" = 'comm_center'
         AND "commArchived" = false
         AND "commResponded" = false
         AND COALESCE("commLastMessageAt", "receivedAt") < NOW() - make_interval(days => :days)`,
      { replacements: { days } }
    );
    res.json({ data: { updated: (meta && meta.rowCount) || 0 } });
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

// Quote coverage: tracked quote-requests / needs-response with responded state
app.get('/api/com-center/coverage', authenticate, async (req, res) => {
  try {
    const { ScannedEmail, GmailAccount } = require('./models');
    const { Op } = require('sequelize');
    const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const where = {
      emailType: 'comm_center', commArchived: false,
      receivedAt: { [Op.gte]: since },
      [Op.or]: [{ commIsQuoteRequest: true }, { commNeedsResponse: true }],
    };
    if (req.query.quotesOnly === 'true') { delete where[Op.or]; where.commIsQuoteRequest = true; }
    const emails = await ScannedEmail.findAll({ where, order: [['receivedAt', 'DESC']], limit: 300 });
    // Keep the newest record per thread
    const byThread = new Map();
    for (const e of emails) {
      const key = e.gmailThreadId || e.id;
      const prev = byThread.get(key);
      if (!prev || new Date(e.receivedAt) > new Date(prev.receivedAt)) byThread.set(key, e);
    }
    const accts = await GmailAccount.findAll({ attributes: ['id', 'email'] });
    const accMap = Object.fromEntries(accts.map(a => [a.id, a.email]));
    const list = [...byThread.values()].map(e => withGmailLink(e, accMap));
    const awaiting = list.filter(e => !e.commResponded && !e.commHandledManually).length;
    res.json({ data: list, awaiting });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Manually mark a thread handled (forces green)
app.patch('/api/com-center/emails/:id/handled', authenticate, async (req, res) => {
  try {
    const { ScannedEmail } = require('./models');
    const email = await ScannedEmail.findByPk(req.params.id);
    if (!email) return res.status(404).json({ error: { message: 'Not found' } });
    const handled = req.body.handled !== false;
    const updates = { commHandledManually: handled, commResponded: handled ? true : email.commResponded };
    if (email.gmailThreadId) {
      await ScannedEmail.update(updates, { where: { gmailThreadId: email.gmailThreadId } });
    } else {
      await email.update(updates);
    }
    res.json({ data: { ...email.toJSON(), ...updates } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Run the coverage scan on demand
app.post('/api/com-center/coverage/scan', authenticate, async (req, res) => {
  try {
    const { runCoverageScan } = require('./services/commCenter');
    const result = await runCoverageScan();
    res.json({ data: result });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Re-sort the existing backlog with the latest classifier (runs in the background)
app.post('/api/com-center/reclassify', authenticate, async (req, res) => {
  try {
    const { reclassifyExisting, runCoverageScan } = require('./services/commCenter');
    // Fire-and-forget — Heroku caps requests at 30s, so don't await the full pass
    (async () => {
      try { await reclassifyExisting(); await runCoverageScan(); }
      catch (e) { console.error('[CommCenter] reclassify error:', e.message); }
    })();
    res.json({ data: { started: true } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Bills queue: bill-category emails with extracted invoice data
app.get('/api/com-center/bills', authenticate, async (req, res) => {
  try {
    const { ScannedEmail, GmailAccount } = require('./models');
    const { Op } = require('sequelize');
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const emails = await ScannedEmail.findAll({
      where: { emailType: 'comm_center', commCategory: 'bill', commArchived: false, receivedAt: { [Op.gte]: since } },
      order: [['receivedAt', 'DESC']], limit: 200,
    });
    const accts = await GmailAccount.findAll({ attributes: ['id', 'email'] });
    const accMap = Object.fromEntries(accts.map(a => [a.id, a.email]));
    const data = emails.map(e => withGmailLink(e, accMap));
    const pending = data.filter(e => (e.billStatus || 'pending') === 'pending').length;
    res.json({ data, pending });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Approve / reject a bill
app.patch('/api/com-center/bills/:id/status', authenticate, async (req, res) => {
  try {
    const { ScannedEmail } = require('./models');
    const email = await ScannedEmail.findByPk(req.params.id);
    if (!email) return res.status(404).json({ error: { message: 'Not found' } });
    const status = ['pending', 'approved', 'rejected'].includes(req.body.status) ? req.body.status : 'pending';
    await email.update({ billStatus: status });
    res.json({ data: { id: email.id, billStatus: status } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Run bill extraction now (background — vision calls are slow)
app.post('/api/com-center/bills/scan', authenticate, async (req, res) => {
  try {
    const { runBillScan } = require('./services/commCenter');
    (async () => { try { await runBillScan(); } catch (e) { console.error('[Bills] scan error:', e.message); } })();
    res.json({ data: { started: true } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// AI model settings — editable so a retired model can be swapped without a redeploy
app.get('/api/settings/ai-models', authenticate, (req, res) => {
  try {
    const { getAiModels, DEFAULTS } = require('./services/aiConfig');
    res.json({ data: { ...getAiModels(), defaults: DEFAULTS } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.put('/api/settings/ai-models', authenticate, async (req, res) => {
  try {
    const { AppSettings } = require('./models');
    const { setAiModels, getAiModels } = require('./services/aiConfig');
    const parsingModel = (req.body.parsingModel || '').trim();
    const triageModel = (req.body.triageModel || '').trim();
    if (!parsingModel || !triageModel) return res.status(400).json({ error: { message: 'Both model names are required' } });
    const value = { parsingModel, triageModel };
    await AppSettings.upsert({ key: 'ai_models', value });
    setAiModels(value);
    res.json({ data: getAiModels() });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Operations — parts completed in a given week, attributed to whoever's tablet marked them done
app.get('/api/operations/production', authenticate, async (req, res) => {
  try {
    const { WorkOrderPart, WorkOrder } = require('./models');
    const { Op } = require('sequelize');
    let start;
    if (req.query.start) {
      start = new Date(req.query.start + 'T00:00:00');
    } else {
      start = new Date(); start.setHours(0, 0, 0, 0);
      const dow = start.getDay();
      start.setDate(start.getDate() + (dow === 0 ? -6 : 1 - dow)); // Monday
    }
    if (isNaN(start.getTime())) return res.status(400).json({ error: { message: 'Invalid start date' } });
    const end = new Date(start); end.setDate(end.getDate() + 7);

    const rows = await WorkOrderPart.findAll({
      where: { status: 'completed', completedAt: { [Op.gte]: start, [Op.lt]: end } },
      include: [{ model: WorkOrder, as: 'workOrder', attributes: ['drNumber', 'orderNumber', 'clientName'] }],
      order: [['completedAt', 'ASC']],
    });
    const parts = rows.map(p => ({
      id: p.id,
      completedBy: p.completedBy || 'Unassigned',
      completedAt: p.completedAt,
      description: p.description || p.partType || 'Part',
      partType: p.partType || null,
      quantity: p.quantity != null ? p.quantity : null,
      laborHours: p.laborHours != null ? parseFloat(p.laborHours) : null,
      dr: p.workOrder ? (p.workOrder.drNumber || p.workOrder.orderNumber) : null,
      clientName: p.workOrder ? p.workOrder.clientName : null,
    }));
    res.json({ data: { weekStart: start.toISOString(), weekEnd: end.toISOString(), parts } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.get('/api/com-center/logs', authenticate, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({ data: commScanLog, status: commScanStatus });
});

app.get('/api/com-center/test-connection', authenticate, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const { GmailAccount } = require('./models');
    const { getGmailClient } = require('./services/emailScanner');
    const accounts = await GmailAccount.findAll({ where: { isActive: true } });
    const results = [];
    for (const account of accounts) {
      try {
        const gmail = await getGmailClient(account);
        const profile = await Promise.race([
          gmail.users.getProfile({ userId: 'me' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 10s')), 10000))
        ]);
        const messagesTotal = profile.data.messagesTotal || 0;
        results.push({ account: account.email || account.id, ok: true, messagesTotal });
        logComm('info', 'Test connection OK: ' + (account.email || account.id) + ' (' + messagesTotal + ' messages)');
      } catch (e) {
        results.push({ account: account.email || account.id, ok: false, error: e.message });
        logComm('error', 'Test connection FAILED: ' + (account.email || account.id), e.message);
      }
    }
    res.json({ data: { results } });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// Diagnostic: test Gmail connectivity without full scan
app.get('/api/com-center/test-connection', authenticate, async (req, res) => {
  try {
    const { GmailAccount } = require('./models');
    const { getGmailClient } = require('./services/emailScanner');
    const accounts = await GmailAccount.findAll({ where: { isActive: true } });
    if (!accounts.length) return res.json({ ok: false, message: 'No active Gmail accounts found' });
    const results = [];
    for (const account of accounts) {
      try {
        const gmail = await Promise.race([
          getGmailClient(account),
          new Promise((_, reject) => setTimeout(() => reject(new Error('getGmailClient timeout after 10s')), 10000))
        ]);
        const profile = await Promise.race([
          gmail.users.getProfile({ userId: 'me' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('getProfile timeout after 10s')), 10000))
        ]);
        results.push({ account: account.email || account.id, ok: true, email: profile.data.emailAddress, messagesTotal: profile.data.messagesTotal });
      } catch (e) {
        results.push({ account: account.email || account.id, ok: false, error: e.message });
      }
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/com-center/cancel-scan', authenticate, (req, res) => {
  if (commScanStatus.running) {
    commScanStatus.cancelled = true;
    logComm('warn', 'Scan cancel requested by user');
    res.json({ message: 'Cancel requested' });
  } else {
    res.json({ message: 'No scan running' });
  }
});

app.post('/api/com-center/scan-now', authenticate, async (req, res) => {
  try {
    // Run the comm scanner immediately in background
    res.json({ message: 'Scan started' });
    setImmediate(async () => {
      if (commScanStatus.running) { logComm('warn', 'Scan already in progress — skipping'); return; }
      commScanStatus = { running: true, startedAt: new Date().toISOString(), completedAt: null, error: null, cancelled: false };
      logComm('info', 'Manual scan started');
      try {
        const { GmailAccount, ScannedEmail, Client, Vendor } = require('./models');
        const { google } = require('googleapis');
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

        const { getGmailClient } = require('./services/emailScanner');
        const accounts = await GmailAccount.findAll({ where: { isActive: true } });
        const ownEmails = new Set(accounts.map(a => (a.email || '').toLowerCase().trim()).filter(Boolean));
        logComm('info', 'Found ' + accounts.length + ' Gmail account(s) to scan');
        for (const account of accounts) {
          if (commScanStatus.cancelled) { logComm('warn', 'Scan cancelled by user'); break; }
          try {
            logComm('info', 'Scanning account: ' + (account.email || account.id));
            let gmail;
            try {
              gmail = await Promise.race([
                getGmailClient(account),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getGmailClient timeout — token may be expired')), 15000))
              ]);
              logComm('info', 'Gmail client ready for ' + (account.email || account.id));
            } catch (clientErr) {
              logComm('error', 'Failed to get Gmail client for ' + (account.email || account.id), clientErr.message);
              continue;
            }
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
                const detail = await gmailWithTimeout(() => gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' }));
                const headers = detail.data.payload?.headers || [];
                const fromHeader = headers.find(h => h.name === 'From')?.value || '';
                const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
                const dateHeader = headers.find(h => h.name === 'Date')?.value;
                const snippet = detail.data.snippet || '';
                const fromMatch = fromHeader.match(/<(.+?)>/) || [null, fromHeader];
                const fromEmail = (fromMatch[1] || fromHeader).toLowerCase().trim();
                const fromName = fromHeader.replace(/<.*>/, '').replace(/"/g, '').trim();
                if (ownEmails.has(fromEmail) || monitoredAddrs.has(fromEmail) || fromEmail.includes('noreply') || fromEmail.includes('no-reply') || fromEmail.includes('donotreply') || fromEmail.includes('mailer-daemon')) {
                  await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [commLabelId] } });
                  continue;
                }
                let triage;
                if (vendorAddrs[fromEmail]) {
                  triage = { category: 'vendor', isQuoteRequest: false, needsResponse: false };
                } else {
                  const { classifyEmail, extractEmailBody } = require('./services/commCenter');
                  const fullBody = extractEmailBody(detail.data.payload);
                  triage = await classifyEmail({ from: fromHeader, subject, snippet, body: fullBody, knownClient: clientAddrs[fromEmail] || null });
                }
                const category = triage.category;
                const gmailLink = 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(account.email || '') + '#all/' + msg.id;
                const [emailRecord, created] = await ScannedEmail.findOrCreate({
                  where: { gmailMessageId: msg.id },
                  defaults: { gmailAccountId: account.id, gmailThreadId: detail.data.threadId, fromEmail, fromName: fromName || fromEmail, subject, receivedAt: dateHeader ? new Date(dateHeader) : new Date(), commCategory: category, commIsQuoteRequest: triage.isQuoteRequest, commNeedsResponse: triage.needsResponse, commProcessed: true, commSnippet: snippet.substring(0, 500), commArchived: false, gmailLink, status: 'processed', emailType: 'comm_center' }
                });
                if (!created) await emailRecord.update({ commCategory: category, commIsQuoteRequest: triage.isQuoteRequest, commNeedsResponse: triage.needsResponse, commProcessed: true, commSnippet: snippet.substring(0, 500), gmailLink });
                await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [commLabelId] } });
              } catch (msgErr) { console.error('[CommScanner] msg error:', msgErr.message); }
            }
          } catch (accErr) { console.error('[CommScanner] account error:', accErr.message); }
        }
        commScanStatus = { running: false, startedAt: commScanStatus.startedAt, completedAt: new Date().toISOString(), error: null, cancelled: false };
        logComm('info', 'Manual scan complete');
      } catch (e) {
        commScanStatus = { running: false, startedAt: commScanStatus.startedAt, completedAt: new Date().toISOString(), error: e.message, cancelled: false };
        logComm('error', 'Scan failed: ' + e.message, e.stack ? e.stack.split('\n').slice(0,3).join('\n') : null);
      }
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
    const { Op: portalOp } = require('sequelize');
    // Whitelist: only show document types appropriate for clients
    const PORTAL_ALLOWED_TYPES = ['coc', 'shipping_doc', 'mtr', 'usmca', 'invoice', 'general'];
    const documents = await portalModels.WorkOrderDocument.findAll({
      where: {
        workOrderId: workOrder.id,
        portalVisible: true,
        documentType: { [portalOp.in]: PORTAL_ALLOWED_TYPES }
      },
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
    const migrations = [
        `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "contactExtension" VARCHAR(255)`,
        `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS "contactExtension" VARCHAR(255)`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "progressCount" INTEGER DEFAULT 0`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "progressLastUpdatedAt" TIMESTAMP WITH TIME ZONE`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "progressLog" JSONB DEFAULT '[]'`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "internalNotes" TEXT`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "serviceFitting" BOOLEAN DEFAULT false`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "serviceFittingCost" DECIMAL(10,2)`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "serviceFittingVendor" VARCHAR(255)`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "serviceWelding" BOOLEAN DEFAULT false`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "serviceWeldingCost" DECIMAL(10,2)`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "serviceWeldingVendor" VARCHAR(255)`,
        `ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS "serviceWeldingPercent" INTEGER DEFAULT 100`,
        `ALTER TABLE employees ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 999`,
        `ALTER TABLE clients ADD COLUMN IF NOT EXISTS "requiresCoc" BOOLEAN DEFAULT false`,
        `ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commCategory" VARCHAR(50)`,
        `ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commProcessed" BOOLEAN DEFAULT false`,
        `ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commSnippet" TEXT`,
        `ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commArchived" BOOLEAN DEFAULT false`,
        `ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 999`,
    ];
    // Create work_order_payments table
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS work_order_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workOrderId" UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
        "paymentType" VARCHAR(20) NOT NULL DEFAULT 'partial',
        amount DECIMAL(10,2) NOT NULL,
        "paymentDate" DATE NOT NULL,
        "paymentMethod" VARCHAR(100),
        "paymentReference" VARCHAR(255),
        notes TEXT,
        "recordedBy" VARCHAR(255),
        "voidedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
    } catch (e) { console.log('work_order_payments table skip:', e.message); }

    // Create shipment_charges table
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS shipment_charges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "estimateId" UUID REFERENCES estimates(id) ON DELETE CASCADE,
        "workOrderId" UUID REFERENCES work_orders(id) ON DELETE CASCADE,
        "sortOrder" INTEGER DEFAULT 0,
        "carrierType" VARCHAR(50) DEFAULT 'contracted',
        "vendorId" UUID,
        "vendorName" VARCHAR(255),
        "pickupLocation" TEXT,
        "pickupIsShop" BOOLEAN DEFAULT false,
        "dropoffLocation" TEXT,
        "dropoffIsShop" BOOLEAN DEFAULT false,
        "shippingCost" DECIMAL(10,2) DEFAULT 0,
        "shippingMarkup" DECIMAL(5,2) DEFAULT 0,
        "materialsCost" DECIMAL(10,2) DEFAULT 0,
        "materialsMarkup" DECIMAL(5,2) DEFAULT 0,
        notes TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      // Fix vendorId column type if created with wrong INTEGER type
      try {
        await sequelize.query(`ALTER TABLE shipment_charges DROP COLUMN IF EXISTS "vendorId"`);
        await sequelize.query(`ALTER TABLE shipment_charges ADD COLUMN IF NOT EXISTS "vendorId" UUID`);
        console.log('shipment_charges vendorId fixed to UUID');
      } catch (e2) { console.log('vendorId already correct type'); }
      console.log('shipment_charges table ready');
    } catch (e) { console.log('shipment_charges table error:', e.message); }

    // Create new payment system tables
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS client_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "clientId" UUID,
        "clientName" VARCHAR(255) NOT NULL,
        "paymentDate" DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        method VARCHAR(50) DEFAULT 'check',
        reference VARCHAR(255),
        notes TEXT,
        "recordedBy" VARCHAR(255),
        "voidedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS payment_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "clientPaymentId" UUID REFERENCES client_payments(id) ON DELETE CASCADE,
        "workOrderId" UUID REFERENCES work_orders(id) ON DELETE CASCADE,
        amount DECIMAL(10,2) NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS credit_memos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "clientId" UUID,
        "clientName" VARCHAR(255) NOT NULL,
        date DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        "remainingAmount" DECIMAL(10,2) NOT NULL,
        reason TEXT,
        "sourceClientPaymentId" UUID,
        "voidedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS credit_memo_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "creditMemoId" UUID REFERENCES credit_memos(id) ON DELETE CASCADE,
        "workOrderId" UUID,
        "clientPaymentId" UUID,
        amount DECIMAL(10,2) NOT NULL,
        "appliedAt" DATE NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS refunds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "clientId" UUID,
        "clientName" VARCHAR(255) NOT NULL,
        date DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        method VARCHAR(50) DEFAULT 'check',
        reference VARCHAR(255),
        reason TEXT,
        "sourceWorkOrderId" UUID,
        "sourceClientPaymentId" UUID,
        "recordedBy" VARCHAR(255),
        "voidedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      console.log('Payment system tables ready');
    } catch (e) { console.log('Payment tables error:', e.message); }



    // Add 'inspection' to part type ENUMs
    try {
      await sequelize.query(`ALTER TYPE "enum_work_order_parts_partType" ADD VALUE IF NOT EXISTS 'inspection'`);
      await sequelize.query(`ALTER TYPE "enum_estimate_parts_partType" ADD VALUE IF NOT EXISTS 'inspection'`);
    } catch(e) { /* may already exist */ }

    // Create inspection tables
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS inspection_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workOrderId" UUID REFERENCES work_orders(id) ON DELETE CASCADE,
        "workOrderPartId" UUID,
        "inspectionPartId" UUID,
        "inspectionType" VARCHAR(50) DEFAULT 'cylinder',
        "unitCount" INTEGER DEFAULT 1,
        status VARCHAR(50) DEFAULT 'not_started',
        "completedAt" TIMESTAMP WITH TIME ZONE,
        "operatorName" VARCHAR(255),
        notes TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      await sequelize.query(`CREATE TABLE IF NOT EXISTS inspection_units (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "inspectionJobId" UUID REFERENCES inspection_jobs(id) ON DELETE CASCADE,
        "unitId" VARCHAR(100) NOT NULL,
        sequence INTEGER NOT NULL,
        "preRoll" JSONB DEFAULT '{}',
        "postRoll" JSONB DEFAULT '{}',
        "preRollComplete" BOOLEAN DEFAULT false,
        "postRollComplete" BOOLEAN DEFAULT false,
        "labelPrinted" BOOLEAN DEFAULT false,
        "clientNotes" TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      console.log('Inspection tables ready');
    } catch(e) { console.log('Inspection tables error:', e.message); }

    // Comm Center — quote coverage tracking columns
    try {
      await sequelize.query(`ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commIsQuoteRequest" BOOLEAN DEFAULT false`);
      await sequelize.query(`ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commNeedsResponse" BOOLEAN DEFAULT false`);
      await sequelize.query(`ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commResponded" BOOLEAN DEFAULT false`);
      await sequelize.query(`ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commLastMessageAt" TIMESTAMP WITH TIME ZONE`);
      await sequelize.query(`ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commCoverageCheckedAt" TIMESTAMP WITH TIME ZONE`);
      await sequelize.query(`ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "commHandledManually" BOOLEAN DEFAULT false`);
      await sequelize.query(`ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "billData" JSONB`);
      await sequelize.query(`ALTER TABLE scanned_emails ADD COLUMN IF NOT EXISTS "billStatus" VARCHAR(20)`);
      console.log('Comm coverage columns ready');
    } catch(e) { console.log('Comm coverage columns error:', e.message); }

    // Load editable AI model config (admin can change models when one is retired)
    try { await require('./services/aiConfig').loadAiModels(); } catch(e) { console.log('aiConfig load error:', e.message); }

    // Add USMCA per-order fields to work_orders table
    try {
      await sequelize.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "usmcaImporterName" VARCHAR(255)`);
      await sequelize.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "usmcaImporterAddress" TEXT`);
      await sequelize.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "usmcaHtsCode" VARCHAR(50)`);
      await sequelize.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "usmcaOriginCriteria" VARCHAR(10)`);
    } catch (e) { console.log('USMCA WO fields skip:', e.message); }

    // Add USMCA fields to clients table
    try {
      await sequelize.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS "autoGenerateUSMCA" BOOLEAN DEFAULT false`);
      await sequelize.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS "usmcaFormat" VARCHAR(20) DEFAULT 'format1'`);
      await sequelize.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS "usmcaHtsCode" VARCHAR(50)`);
      await sequelize.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS "usmcaImporterName" VARCHAR(255)`);
      await sequelize.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS "usmcaImporterAddress" TEXT`);
      await sequelize.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS "usmcaOriginCriteria" VARCHAR(10) DEFAULT 'A'`);
    } catch (e) { console.log('USMCA client fields skip:', e.message); }

    // Create work_order_invoice_sends table
    try {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS work_order_invoice_sends (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workOrderId" UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
        "sentAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "sentMethod" VARCHAR(100),
        "sentTo" TEXT,
        "sentFrom" TEXT,
        "gmailDraftId" VARCHAR(255),
        notes TEXT,
        "recordedBy" VARCHAR(255),
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
    } catch (e) { console.log('work_order_invoice_sends skip:', e.message); }

    // Add invoice export tracking fields
    try {
      await sequelize.query(`ALTER TABLE invoice_numbers ADD COLUMN IF NOT EXISTS "iifExportedAt" TIMESTAMP WITH TIME ZONE`);
      await sequelize.query(`ALTER TABLE invoice_numbers ADD COLUMN IF NOT EXISTS "iifBatchId" VARCHAR(255)`);
      await sequelize.query(`ALTER TABLE invoice_numbers ADD COLUMN IF NOT EXISTS "invoicePdfUrl" TEXT`);
      await sequelize.query(`ALTER TABLE invoice_numbers ADD COLUMN IF NOT EXISTS "invoicePdfGenerated" BOOLEAN DEFAULT false`);
    } catch (e) { console.log('Invoice fields migration skip:', e.message); }

    // Fix existing MTR/COC docs that weren't set as portalVisible
    try {
      await sequelize.query(`UPDATE work_order_documents SET "portalVisible" = true WHERE "documentType" IN ('mtr','coc','shipping_doc') AND "portalVisible" = false`);
      console.log('MTR/COC portalVisible backfill complete');
    } catch (e) { console.log('portalVisible backfill skip:', e.message); }

    for (const sql of migrations) {
      try { await sequelize.query(sql); } catch (e) { console.log('migration skip:', e.message.split('\n')[0]); }
    }
    console.log('column migrations ensured');

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
          // Log success to DailyActivity
          try {
            await DailyActivity.create({
              activityType: 'system',
              resourceType: 'backup',
              description: `✅ Auto-backup completed — ${(result.size / 1024).toFixed(0)}KB saved to Cloudinary`
            });
          } catch {}
          // Store last backup status in AppSettings
          try {
            await AppSettings.upsert({ key: 'last_backup_status', value: { status: 'success', timestamp: new Date().toISOString(), size: result.size } });
          } catch {}
        } else {
          console.error('[CRON] Auto-backup failed:', result.error);
          await notifyBackupFailure(result.error || 'Unknown error');
        }
      } catch (err) {
        console.error('[CRON] Auto-backup error:', err.message);
        await notifyBackupFailure(err.message);
      }
    }, {
      timezone: 'America/Los_Angeles'
    });

    // Helper: notify admin of backup failure via todo + email
    async function notifyBackupFailure(errorMessage) {
      const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      // 1. Create urgent todo visible in dashboard
      try {
        await TodoItem.create({
          title: '🚨 Auto-Backup Failed',
          description: `The scheduled Saturday backup failed at ${timestamp}.\n\nError: ${errorMessage}\n\nPlease run a manual backup from the Admin → Backup page and check the error.`,
          priority: 'urgent',
          status: 'pending',
          category: 'system',
          dueDate: new Date()
        });
        console.log('[BACKUP] Failure todo created');
      } catch (e) {
        console.error('[BACKUP] Failed to create failure todo:', e.message);
      }
      // Store failure status in AppSettings for dashboard display
      try {
        await AppSettings.upsert({ key: 'last_backup_status', value: { status: 'failed', timestamp: new Date().toISOString(), error: errorMessage } });
      } catch {}
      // 2. Send email alert via SMTP if configured
      try {
        if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_PORT === '465',
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          });
          const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
          await transporter.sendMail({
            from: `"CR Admin System" <${process.env.SMTP_USER}>`,
            to: adminEmail,
            subject: `🚨 CR Admin Auto-Backup Failed - ${timestamp}`,
            html: `
              <div style="font-family:sans-serif;max-width:500px">
                <h2 style="color:#c62828">⚠️ Backup Failed</h2>
                <p>The scheduled Saturday night backup for <strong>CR Admin</strong> failed at ${timestamp}.</p>
                <div style="background:#fff3f3;border:1px solid #ffcdd2;border-radius:6px;padding:12px;margin:12px 0">
                  <strong>Error:</strong><br><code>${errorMessage}</code>
                </div>
                <p><strong>Action needed:</strong> Please log into CR Admin and run a manual backup from <em>Admin → Backup</em>.</p>
                <p style="color:#888;font-size:12px">This is an automated alert from CR Admin.</p>
              </div>
            `
          });
          console.log('[BACKUP] Failure email sent to', adminEmail);
        } else {
          console.log('[BACKUP] SMTP not configured — skipping failure email');
        }
      } catch (e) {
        console.error('[BACKUP] Failed to send failure email:', e.message);
      }
    }
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
        const ownEmailsCron = new Set(accounts.map(a => (a.email || '').toLowerCase().trim()).filter(Boolean));
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

                const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
                const headers = detail.data.payload?.headers || [];
                const fromHeader = headers.find(h => h.name === 'From')?.value || '';
                const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
                const dateHeader = headers.find(h => h.name === 'Date')?.value;
                const snippet = detail.data.snippet || '';

                // Extract from email
                const fromMatch = fromHeader.match(/<(.+?)>/) || [null, fromHeader];
                const fromEmail = (fromMatch[1] || fromHeader).toLowerCase().trim();
                const fromName = fromHeader.replace(/<.*>/, '').replace(/"/g, '').trim();

                // Skip our own sent emails
                if (ownEmailsCron.has(fromEmail)) {
                  await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [commLabelId] } });
                  continue;
                }

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

                // Classify (body-aware via snippet) — category + quote/needs-response flags
                let triage;
                if (vendorAddrs[fromEmail]) {
                  triage = { category: 'vendor', isQuoteRequest: false, needsResponse: false };
                } else {
                  const { classifyEmail, extractEmailBody } = require('./services/commCenter');
                  const fullBody = extractEmailBody(detail.data.payload);
                  triage = await classifyEmail({ from: fromHeader, subject, snippet, body: fullBody, knownClient: clientAddrs[fromEmail] || null });
                }
                const category = triage.category;

                // Save to ScannedEmail
                const gmailLink = 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(account.email || '') + '#all/' + msg.id;
                const [emailRec2, created2] = await ScannedEmail.findOrCreate({
                  where: { gmailMessageId: msg.id },
                  defaults: { gmailAccountId: account.id, gmailThreadId: detail.data.threadId, fromEmail, fromName: fromName || fromEmail, subject, receivedAt: dateHeader ? new Date(dateHeader) : new Date(), commCategory: category, commIsQuoteRequest: triage.isQuoteRequest, commNeedsResponse: triage.needsResponse, commProcessed: true, commSnippet: snippet.substring(0, 500), commArchived: false, gmailLink, status: 'processed', emailType: 'comm_center' }
                });
                if (!created2) await emailRec2.update({ commCategory: category, commIsQuoteRequest: triage.isQuoteRequest, commNeedsResponse: triage.needsResponse, commProcessed: true, commSnippet: snippet.substring(0, 500), gmailLink });

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

        // Refresh quote-coverage (responded vs awaiting) for tracked threads
        try {
          const { runCoverageScan } = require('./services/commCenter');
          await runCoverageScan();
        } catch (covErr) {
          console.error('[CommCenter] coverage scan error:', covErr.message);
        }

        // Extract any new bills (PDF invoices) into the review queue
        try {
          const { runBillScan } = require('./services/commCenter');
          await runBillScan();
        } catch (billErr) {
          console.error('[CommCenter] bill scan error:', billErr.message);
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

    // Ginger — daily 5:00 AM scheduling/priority scan
    cron.schedule('0 5 * * *', async () => {
      console.log('Running 5:00 AM Ginger priority scan...');
      try {
        const { runGingerScan } = require('./services/gingerScan');
        const result = await runGingerScan();
        console.log(`[Ginger] 5AM scan: ${result.total} finding(s)`);
      } catch (err) {
        console.error('[Ginger] 5AM scan error:', err.message);
      }
    });
    console.log('Ginger priority scan cron configured for 5:00 AM daily');

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
