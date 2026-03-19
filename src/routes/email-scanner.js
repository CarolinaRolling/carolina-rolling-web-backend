const express = require('express');
const { GmailAccount, ScannedEmail, PendingOrder, Client, Estimate, WorkOrder, WorkOrderPart, AppSettings, sequelize } = require('../models');
const { getOAuth2Client, runScan, getScanConfig } = require('../services/emailScanner');
const { Op } = require('sequelize');

const router = express.Router();

// ==================== GMAIL OAUTH ====================

// GET /api/email-scanner/oauth/start - Start OAuth flow for connecting a Gmail account
router.get('/oauth/start', async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(400).json({ error: { message: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.' } });
    }
    const oauth2 = getOAuth2Client();
    const authUrl = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.labels',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/userinfo.email'
      ]
    });
    res.json({ data: { authUrl } });
  } catch (error) { next(error); }
});

// GET /api/email-scanner/oauth/callback - OAuth callback (redirected from Google)
router.get('/oauth/callback', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('No authorization code received');

    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    // Get user email
    const oauth2Api = require('googleapis').google.oauth2({ version: 'v2', auth: oauth2 });
    const userInfo = await oauth2Api.userinfo.get();
    const email = userInfo.data.email;

    // Upsert account
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

    // Redirect back to admin page
    const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'http://localhost:3000';
    res.redirect(`${baseUrl}/admin/shop-config?tab=emailScanner&connected=${email}`);
  } catch (error) {
    console.error('[EmailScanner] OAuth callback error:', error.message);
    const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'http://localhost:3000';
    res.redirect(`${baseUrl}/admin/shop-config?tab=emailScanner&error=${encodeURIComponent(error.message)}`);
  }
});

// ==================== ACCOUNT MANAGEMENT ====================

// GET /api/email-scanner/accounts - List connected Gmail accounts
router.get('/accounts', async (req, res, next) => {
  try {
    const accounts = await GmailAccount.findAll({
      attributes: ['id', 'email', 'isActive', 'lastScannedAt', 'lastError', 'connectedBy', 'createdAt'],
      order: [['createdAt', 'ASC']]
    });
    res.json({ data: accounts });
  } catch (error) { next(error); }
});

// DELETE /api/email-scanner/accounts/:id - Disconnect a Gmail account
router.delete('/accounts/:id', async (req, res, next) => {
  try {
    const account = await GmailAccount.findByPk(req.params.id);
    if (!account) return res.status(404).json({ error: { message: 'Account not found' } });
    await account.update({ isActive: false, accessToken: null, refreshToken: null });
    res.json({ message: `${account.email} disconnected` });
  } catch (error) { next(error); }
});

// PUT /api/email-scanner/accounts/:id/toggle - Toggle active state
router.put('/accounts/:id/toggle', async (req, res, next) => {
  try {
    const account = await GmailAccount.findByPk(req.params.id);
    if (!account) return res.status(404).json({ error: { message: 'Account not found' } });
    await account.update({ isActive: !account.isActive });
    res.json({ data: account, message: `${account.email} ${account.isActive ? 'enabled' : 'paused'}` });
  } catch (error) { next(error); }
});

// ==================== GENERAL NOTES ====================

// GET /api/email-scanner/general-notes - Get general AI parsing notes
router.get('/general-notes', async (req, res, next) => {
  try {
    const setting = await AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
    res.json({ data: setting?.value || '' });
  } catch (error) { next(error); }
});

// PUT /api/email-scanner/general-notes - Update general AI parsing notes
router.put('/general-notes', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const existing = await AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
    if (existing) {
      await existing.update({ value: notes || '' });
    } else {
      await AppSettings.create({ key: 'email_scanner_general_notes', value: notes || '' });
    }
    res.json({ data: notes, message: 'General notes saved' });
  } catch (error) { next(error); }
});

// ==================== SCANNER CONTROL ====================

// GET /api/email-scanner/status - Scanner status
router.get('/status', async (req, res, next) => {
  try {
    const accounts = await GmailAccount.findAll({ where: { isActive: true } });
    const { emailToClient } = await getScanConfig();
    const recentEmails = await ScannedEmail.count({ where: { createdAt: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
    const pendingCount = await PendingOrder.count({ where: { status: 'pending' } });

    res.json({
      data: {
        connectedAccounts: accounts.length,
        monitoredAddresses: Object.keys(emailToClient).length,
        emailsProcessedToday: recentEmails,
        pendingOrders: pendingCount,
        googleConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        anthropicConfigured: !!process.env.ANTHROPIC_API_KEY
      }
    });
  } catch (error) { next(error); }
});

// POST /api/email-scanner/scan-now - Trigger manual scan
router.post('/scan-now', async (req, res, next) => {
  try {
    const results = await runScan(true); // Force scan even outside business hours
    res.json({ data: results, message: `Scan complete: ${results.processed || 0} emails processed` });
  } catch (error) {
    console.error('[EmailScanner] Manual scan error:', error.message);
    next(error);
  }
});

// GET /api/email-scanner/history - Recent scanned emails
router.get('/history', async (req, res, next) => {
  try {
    const emails = await ScannedEmail.findAll({
      order: [['createdAt', 'DESC']],
      limit: 50,
      include: [{ model: GmailAccount, as: 'gmailAccount', attributes: ['email'] }]
    });
    res.json({ data: emails });
  } catch (error) { next(error); }
});

// ==================== PENDING ORDERS ====================

// GET /api/email-scanner/pending-orders - List pending orders
router.get('/pending-orders', async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query;
    const where = status === 'all' ? {} : { status };
    const orders = await PendingOrder.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    res.json({ data: orders });
  } catch (error) { next(error); }
});

// POST /api/email-scanner/pending-orders/:id/approve - Approve a pending order
router.post('/pending-orders/:id/approve', async (req, res, next) => {
  try {
    const order = await PendingOrder.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: { message: 'Pending order not found' } });
    if (order.status !== 'pending') return res.status(400).json({ error: { message: 'Order is not pending' } });

    const { clientPurchaseOrderNumber, notes } = req.body;

    // Find the matched estimate to convert
    let workOrderId = null;
    if (order.matchedEstimateId) {
      // TODO: Could auto-convert estimate to WO here
      // For now, just link the PO info
    }

    await order.update({
      status: 'approved',
      approvedBy: req.user?.username || 'admin',
      approvedAt: new Date(),
      notes: notes || order.notes,
      workOrderId
    });

    res.json({ data: order, message: 'Order approved' });
  } catch (error) { next(error); }
});

// POST /api/email-scanner/pending-orders/:id/reject - Reject a pending order
router.post('/pending-orders/:id/reject', async (req, res, next) => {
  try {
    const order = await PendingOrder.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: { message: 'Pending order not found' } });
    if (order.status !== 'pending') return res.status(400).json({ error: { message: 'Order is not pending' } });

    await order.update({
      status: 'rejected',
      rejectedBy: req.user?.username || 'admin',
      rejectedAt: new Date(),
      rejectionReason: req.body.reason || null
    });

    res.json({ data: order, message: 'Order rejected' });
  } catch (error) { next(error); }
});

// ==================== GENERAL NOTES ====================

// GET /api/email-scanner/general-notes - Get general AI parsing notes
router.get('/general-notes', async (req, res, next) => {
  try {
    const { AppSettings } = require('../models');
    const setting = await AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
    res.json({ data: setting?.value || '' });
  } catch (error) { next(error); }
});

// PUT /api/email-scanner/general-notes - Save general AI parsing notes
router.put('/general-notes', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const { AppSettings } = require('../models');
    const existing = await AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
    if (existing) { await existing.update({ value: notes || '' }); }
    else { await AppSettings.create({ key: 'email_scanner_general_notes', value: notes || '' }); }
    res.json({ data: notes, message: 'General notes saved' });
  } catch (error) { next(error); }
});

// ==================== CLIENT CONFIG ====================

// GET /api/email-scanner/monitored-clients - Get clients with email scanning enabled
router.get('/monitored-clients', async (req, res, next) => {
  try {
    const clients = await Client.findAll({
      where: { emailScanEnabled: true, isActive: true },
      attributes: ['id', 'name', 'emailScanAddresses', 'emailScanParsingNotes']
    });
    res.json({ data: clients });
  } catch (error) { next(error); }
});

// POST /api/email-scanner/retry/:id - Retry a failed scanned email
router.post('/retry/:id', async (req, res, next) => {
  try {
    const email = await ScannedEmail.findByPk(req.params.id);
    if (!email) return res.status(404).json({ error: { message: 'Scanned email not found' } });

    if (!email.rawBody) {
      return res.status(400).json({ error: { message: 'No email body stored — cannot retry' } });
    }

    // Find client info
    const client = email.clientId ? await Client.findByPk(email.clientId) : null;
    const clientName = client?.name || 'Unknown';
    const parsingNotes = client?.emailScanParsingNotes || '';

    // Re-parse with AI
    const { parseEmailWithAI, getScanConfig } = require('../services/emailScanner');
    const generalNotesSetting = await require('../models').AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
    const generalNotes = generalNotesSetting?.value || '';
    const parsed = await parseEmailWithAI(email.rawBody, email.subject || '', clientName, parsingNotes, generalNotes);

    if (!parsed) {
      await email.update({ status: 'error', errorMessage: 'AI parsing returned no result (retry)' });
      return res.status(400).json({ error: { message: 'AI parsing failed again. Check Anthropic API key and credits.' } });
    }

    await email.update({
      emailType: parsed.emailType || 'rfq',
      parsedData: parsed,
      parseConfidence: parsed.confidence || 'medium',
      errorMessage: null
    });

    const { Op } = require('sequelize');
    const { TodoItem, User, EstimatePart } = require('../models');

    if (parsed.emailType === 'po') {
      // Check duplicate
      let skip = false;
      if (parsed.poNumber) {
        const existing = await PendingOrder.findOne({ where: { poNumber: parsed.poNumber, clientId: email.clientId, status: 'pending' } });
        if (existing) skip = true;
      }
      if (!skip) {
        let matchedEstimate = null;
        if (parsed.referencesQuote) {
          matchedEstimate = await Estimate.findOne({ where: { [Op.or]: [{ estimateNumber: parsed.referencesQuote }, { estimateNumber: { [Op.iLike]: `%${parsed.referencesQuote}%` } }] } });
        }
        const pending = await PendingOrder.create({
          clientId: email.clientId, clientName, poNumber: parsed.poNumber || null,
          referenceNumber: parsed.referencesQuote || parsed.referenceNumber || null,
          matchedEstimateId: matchedEstimate?.id || null, matchedEstimateNumber: matchedEstimate?.estimateNumber || parsed.referencesQuote || null,
          scannedEmailId: email.id, emailLink: email.gmailLink, subject: email.subject, parsedData: parsed, status: 'pending'
        });
        await email.update({ status: 'pending_order', pendingOrderId: pending.id });
      }
      res.json({ data: email, message: 'Retry successful — pending order created' });
    } else {
      // RFQ — create estimate
      const estNumber = parsed.referenceNumber || `EST-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
      const existingEst = await Estimate.findOne({ where: { estimateNumber: estNumber } });
      if (existingEst) {
        await email.update({ status: 'ignored', errorMessage: 'Duplicate estimate number' });
        return res.json({ data: email, message: `Estimate ${estNumber} already exists` });
      }

      const estimate = await Estimate.create({
        estimateNumber: estNumber, clientName, clientId: email.clientId,
        status: 'draft', notes: parsed.notes || null, emailLink: email.gmailLink, scannedEmailId: email.id
      });
      for (let i = 0; i < (parsed.parts || []).length; i++) {
        const p = parsed.parts[i];
        await EstimatePart.create({
          estimateId: estimate.id, partNumber: i + 1, partType: p.partType || 'plate_roll',
          quantity: parseInt(p.quantity) || 1, material: p.material || null, thickness: p.thickness || null,
          width: p.width || null, length: p.length || null, outerDiameter: p.outerDiameter || p.diameter || null,
          diameter: p.diameter || p.outerDiameter || null, wallThickness: p.wallThickness || null,
          specialInstructions: p.specialInstructions || null, clientPartNumber: p.clientPartNumber || null,
          materialDescription: p.description || null
        });
      }
      const headEst = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
      await TodoItem.create({
        title: `Review pricing: ${estNumber} — ${clientName}`,
        description: `Auto-created from email (retry). ${(parsed.parts || []).length} part(s). Confidence: ${parsed.confidence || 'unknown'}.`,
        type: 'estimate_review', priority: 'high', assignedTo: headEst?.username || null,
        estimateId: estimate.id, estimateNumber: estNumber, createdBy: 'Email Scanner'
      });
      await email.update({ status: 'estimate_created', estimateId: estimate.id });
      res.json({ data: email, message: `Retry successful — estimate ${estNumber} created` });
    }
  } catch (error) {
    console.error('[EmailScanner] Retry error:', error.message);
    next(error);
  }
});

// DELETE /api/email-scanner/history/:id - Delete a scanned email record
router.delete('/history/:id', async (req, res, next) => {
  try {
    const email = await ScannedEmail.findByPk(req.params.id);
    if (!email) return res.status(404).json({ error: { message: 'Not found' } });
    await email.destroy();
    res.json({ message: 'Deleted' });
  } catch (error) { next(error); }
});

module.exports = router;
