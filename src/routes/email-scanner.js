const express = require('express');
const { GmailAccount, ScannedEmail, PendingOrder, Client, Estimate, WorkOrder, WorkOrderPart, sequelize } = require('../models');
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

module.exports = router;
