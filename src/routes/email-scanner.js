const express = require('express');
const { GmailAccount, ScannedEmail, PendingOrder, Client, Vendor, Estimate, EstimatePart, EstimateFile, WorkOrder, WorkOrderPart, AppSettings, sequelize } = require('../models');
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
      prompt: 'consent select_account',
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
    const results = await runScan();
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

// DELETE /api/email-scanner/pending-orders/:id - Delete a pending order permanently
router.delete('/pending-orders/:id', async (req, res, next) => {
  try {
    const order = await PendingOrder.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: { message: 'Pending order not found' } });
    await order.destroy();
    res.json({ message: 'Pending order deleted' });
  } catch (error) { next(error); }
});

// PUT /api/email-scanner/pending-orders/:id/link-estimate - Link an estimate to a pending order
router.put('/pending-orders/:id/link-estimate', async (req, res, next) => {
  try {
    const order = await PendingOrder.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: { message: 'Pending order not found' } });
    const { estimateId } = req.body;
    if (!estimateId) {
      // Unlink
      await order.update({ matchedEstimateId: null, matchedEstimateNumber: null });
      return res.json({ data: order, message: 'Estimate unlinked' });
    }
    const estimate = await Estimate.findByPk(estimateId);
    if (!estimate) return res.status(404).json({ error: { message: 'Estimate not found' } });
    await order.update({ matchedEstimateId: estimate.id, matchedEstimateNumber: estimate.estimateNumber });
    res.json({ data: order, message: `Linked to ${estimate.estimateNumber}` });
  } catch (error) { next(error); }
});

// GET /api/email-scanner/search-estimates - Search estimates for linking
router.get('/search-estimates', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ data: [] });
    const estimates = await Estimate.findAll({
      where: {
        [Op.or]: [
          { estimateNumber: { [Op.iLike]: `%${q}%` } },
          { clientName: { [Op.iLike]: `%${q}%` } }
        ],
        status: { [Op.notIn]: ['archived'] }
      },
      attributes: ['id', 'estimateNumber', 'clientName', 'status', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: 10
    });
    res.json({ data: estimates });
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
    const { parseEmailWithAI, getScanConfig, buildFormData } = require('../services/emailScanner');
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
      const createdPartIds = [];
      for (let i = 0; i < (parsed.parts || []).length; i++) {
        const p = parsed.parts[i];
        const formData = buildFormData(p);
        const part = await EstimatePart.create({
          estimateId: estimate.id, partNumber: i + 1, partType: p.partType || 'plate_roll',
          quantity: parseInt(p.quantity) || 1, material: p.material || null, thickness: p.thickness || null,
          width: p.width || null, length: p.length || null, outerDiameter: p.outerDiameter || p.diameter || null,
          diameter: p.diameter || p.outerDiameter || null, wallThickness: p.wallThickness || null,
          sectionSize: p.sectionSize || p.legSize || null, radius: p.radius || null, arcDegrees: p.arcDegrees || null,
          rollType: p.rollType || null, flangeOut: p.flangeOut || false,
          specialInstructions: p.specialInstructions || null, clientPartNumber: p.clientPartNumber || null,
          materialDescription: p.description || null, materialSource: p.materialSource || 'customer_supplied',
          formData: formData
        });
        createdPartIds.push(part.id);
      }
      // Link fab services to parent parts
      for (let i = 0; i < (parsed.parts || []).length; i++) {
        const p = parsed.parts[i];
        if ((p.partType === 'fab_service' || p.partType === 'shop_rate') && p.parentPartIndex !== undefined && p.parentPartIndex !== null) {
          const parentId = createdPartIds[p.parentPartIndex];
          if (parentId) {
            await EstimatePart.update(
              { formData: { ...buildFormData(p), _linkedPartId: parentId } },
              { where: { id: createdPartIds[i] } }
            );
          }
        }
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

// POST /api/email-scanner/reply-with-pdf/:estimateId - Create Gmail draft reply with PDF attached
router.post('/reply-with-pdf/:estimateId', async (req, res, next) => {
  try {
    const estimate = await Estimate.findByPk(req.params.estimateId);
    if (!estimate) return res.status(404).json({ error: { message: 'Estimate not found' } });
    if (!estimate.scannedEmailId) return res.status(400).json({ error: { message: 'This estimate was not created from a scanned email' } });

    const scannedEmail = await ScannedEmail.findByPk(estimate.scannedEmailId);
    if (!scannedEmail) return res.status(400).json({ error: { message: 'Scanned email record not found' } });

    const gmailAccount = await GmailAccount.findByPk(scannedEmail.gmailAccountId);
    if (!gmailAccount || !gmailAccount.isActive) return res.status(400).json({ error: { message: 'Gmail account not connected' } });

    const { getGmailClient } = require('../services/emailScanner');
    const gmail = await getGmailClient(gmailAccount);

    // Fetch the original message to get the RFC822 Message-ID header (needed for proper threading)
    let rfc822MessageId = '';
    try {
      const origMsg = await gmail.users.messages.get({
        userId: 'me',
        id: scannedEmail.gmailMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'Message-Id']
      });
      const headers = origMsg.data.payload?.headers || [];
      const msgIdHeader = headers.find(h => h.name.toLowerCase() === 'message-id');
      rfc822MessageId = msgIdHeader?.value || '';
    } catch (e) {
      console.warn('[Reply] Could not fetch original Message-ID:', e.message);
    }

    // Fetch PDF from our own API
    const http = require('http');
    const port = process.env.PORT || 5001;
    const authHeader = req.headers.authorization;
    const pdfBuffer = await new Promise((resolve, reject) => {
      const pdfReq = http.request({
        hostname: 'localhost',
        port,
        path: `/api/estimates/${req.params.estimateId}/pdf`,
        method: 'GET',
        headers: { 'Authorization': authHeader }
      }, (pdfRes) => {
        if (pdfRes.statusCode !== 200) {
          reject(new Error(`PDF generation failed: ${pdfRes.statusCode}`));
          return;
        }
        const chunks = [];
        pdfRes.on('data', chunk => chunks.push(chunk));
        pdfRes.on('end', () => resolve(Buffer.concat(chunks)));
      });
      pdfReq.on('error', reject);
      pdfReq.end();
    });

    const boundary = 'boundary_' + Date.now();
    const fileName = `Estimate-${estimate.estimateNumber}.pdf`;
    const toEmail = scannedEmail.fromEmail;
    const subject = `Re: ${(scannedEmail.subject || 'Quote').replace(/^Re:\s*/i, '')}`;
    const bodyText = req.body.message || `Hi,\n\nPlease find the attached quote for your review.\n\nThank you,\nCarolina Rolling Co.`;

    // Build proper MIME with In-Reply-To using RFC822 Message-ID
    const headerLines = [
      `MIME-Version: 1.0`,
      `To: ${toEmail}`,
      `Subject: ${subject}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`
    ];
    if (rfc822MessageId) {
      headerLines.push(`In-Reply-To: ${rfc822MessageId}`);
      headerLines.push(`References: ${rfc822MessageId}`);
    }

    const messageParts = [
      ...headerLines,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      bodyText,
      '',
      `--${boundary}`,
      `Content-Type: application/pdf; name="${fileName}"`,
      `Content-Disposition: attachment; filename="${fileName}"`,
      'Content-Transfer-Encoding: base64',
      '',
      pdfBuffer.toString('base64'),
      '',
      `--${boundary}--`
    ];

    const rawMessage = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage).toString('base64url');

    // Create draft in the same thread
    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedMessage,
          threadId: scannedEmail.gmailThreadId || undefined
        }
      }
    });

    // The draft response has draft.data.message.id (the message ID inside the draft)
    const draftMsgId = draft.data.message?.id || draft.data.id;

    // Gmail compose URL — open the draft for editing
    const draftUrl = `https://mail.google.com/mail/?authuser=${encodeURIComponent(gmailAccount.email)}#inbox/${draftMsgId}`;

    console.log(`[Reply] Draft created: id=${draft.data.id}, msgId=${draftMsgId}, thread=${scannedEmail.gmailThreadId}, to=${toEmail}`);

    res.json({ data: { draftUrl, draftId: draft.data.id }, message: 'Draft created with PDF attached' });
  } catch (error) {
    console.error('[EmailScanner] Reply with PDF error:', error.message);
    next(error);
  }
});

// ==================== VENDOR RFQ EMAIL ====================

// POST /api/email-scanner/vendor-rfq/:estimateId - Create Gmail draft RFQ to vendor
router.post('/vendor-rfq/:estimateId', async (req, res, next) => {
  try {
    const { vendorId, contactEmail, partIds, gmailAccountId } = req.body;
    
    const estimate = await Estimate.findByPk(req.params.estimateId, {
      include: [{ model: EstimatePart, as: 'parts' }]
    });
    if (!estimate) return res.status(404).json({ error: { message: 'Estimate not found' } });

    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Vendor not found' } });

    // Pick Gmail account — use specified or first active
    let gmailAccount;
    if (gmailAccountId) {
      gmailAccount = await GmailAccount.findByPk(gmailAccountId);
    }
    if (!gmailAccount) {
      gmailAccount = await GmailAccount.findOne({ where: { isActive: true }, order: [['createdAt', 'ASC']] });
    }
    if (!gmailAccount) return res.status(400).json({ error: { message: 'No Gmail account connected' } });

    const toEmail = contactEmail || vendor.contactEmail;
    if (!toEmail) return res.status(400).json({ error: { message: 'No vendor email address' } });

    // Filter parts if specific IDs provided, otherwise use all non-service parts
    let partsToQuote = estimate.parts.filter(p => !['fab_service', 'shop_rate'].includes(p.partType));
    if (partIds && partIds.length > 0) {
      partsToQuote = estimate.parts.filter(p => partIds.includes(p.id));
    }

    // Build materials list
    const materialLines = partsToQuote.map((p, i) => {
      const fd = p.formData && typeof p.formData === 'object' ? p.formData : {};
      const desc = fd._materialDescription || p.materialDescription || '';
      const qty = p.quantity || 1;
      const specialInstr = p.specialInstructions ? `\n   Notes: ${p.specialInstructions}` : '';
      return `${i + 1}. (${qty}) ${desc}${specialInstr}`;
    }).join('\n\n');

    const subject = `RFQ-${estimate.estimateNumber}`;
    const bodyText = `Hi ${vendor.contactName || ''},\n\nCould you please provide pricing and availability for the following materials:\n\n${materialLines}\n\nPlease reference RFQ-${estimate.estimateNumber} in your response.\n\nThank you,\nCarolina Rolling Co.`;

    const { getGmailClient } = require('../services/emailScanner');
    const gmail = await getGmailClient(gmailAccount);

    const boundary = 'boundary_' + Date.now();
    const messageParts = [
      `MIME-Version: 1.0`,
      `To: ${toEmail}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      '',
      bodyText
    ];

    const rawMessage = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage).toString('base64url');

    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: encodedMessage } }
    });

    // Save RFQ tracking on the estimate
    // We'll get the threadId after the email is sent — for now save what we can
    const draftMsgId = draft.data.message?.id;
    let threadId = draft.data.message?.threadId;

    await estimate.update({
      rfqVendorId: vendorId,
      rfqGmailAccountId: gmailAccount.id,
      rfqThreadId: threadId || null,
      rfqSentAt: new Date()
    });

    const draftUrl = `https://mail.google.com/mail/?authuser=${encodeURIComponent(gmailAccount.email)}#inbox/${draftMsgId}`;

    console.log(`[VendorRFQ] Draft created for ${estimate.estimateNumber} → ${toEmail}, thread=${threadId}`);

    res.json({
      data: { draftUrl, draftId: draft.data.id, threadId },
      message: `RFQ draft created for ${vendor.name}`
    });
  } catch (error) {
    console.error('[VendorRFQ] Error:', error.message);
    next(error);
  }
});

// GET /api/email-scanner/vendor-contacts/:vendorId - Get vendor contacts for selection
router.get('/vendor-contacts/:vendorId', async (req, res, next) => {
  try {
    const vendor = await Vendor.findByPk(req.params.vendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Vendor not found' } });
    
    const contacts = [];
    // Add primary contact
    if (vendor.contactEmail) {
      contacts.push({ name: vendor.contactName || vendor.name, email: vendor.contactEmail, isPrimary: true });
    }
    // Add additional contacts from contacts array
    if (vendor.contacts && Array.isArray(vendor.contacts)) {
      for (const c of vendor.contacts) {
        if (c.email && !contacts.find(x => x.email === c.email)) {
          contacts.push({ name: c.name || '', email: c.email, isPrimary: c.isPrimary || false });
        }
      }
    }
    res.json({ data: contacts });
  } catch (error) { next(error); }
});

// ==================== VENDOR PO EMAIL ====================

// POST /api/email-scanner/vendor-po/:workOrderId - Create Gmail draft PO to vendor in same RFQ thread
router.post('/vendor-po/:workOrderId', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.workOrderId);
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });
    if (!wo.estimateId) return res.status(400).json({ error: { message: 'Work order has no linked estimate' } });

    const estimate = await Estimate.findByPk(wo.estimateId);
    if (!estimate) return res.status(400).json({ error: { message: 'Linked estimate not found' } });
    if (!estimate.rfqVendorId) return res.status(400).json({ error: { message: 'No vendor RFQ was sent for this estimate' } });

    const vendor = await Vendor.findByPk(estimate.rfqVendorId);
    if (!vendor) return res.status(400).json({ error: { message: 'Vendor not found' } });

    const gmailAccount = estimate.rfqGmailAccountId 
      ? await GmailAccount.findByPk(estimate.rfqGmailAccountId)
      : await GmailAccount.findOne({ where: { isActive: true } });
    if (!gmailAccount) return res.status(400).json({ error: { message: 'No Gmail account' } });

    const toEmail = req.body.contactEmail || vendor.contactEmail;
    if (!toEmail) return res.status(400).json({ error: { message: 'No vendor email' } });

    // Fetch PO PDF
    const http = require('http');
    const port = process.env.PORT || 5001;
    const authHeader = req.headers.authorization;
    
    // Build PO number for filename
    const poNumber = wo.poNumber || wo.materialPurchaseOrderNumber || `DR-${wo.drNumber}`;
    
    let pdfBuffer;
    try {
      pdfBuffer = await new Promise((resolve, reject) => {
        const pdfReq = http.request({
          hostname: 'localhost', port,
          path: `/api/po-numbers/${wo.id}/pdf`,
          method: 'GET',
          headers: { 'Authorization': authHeader }
        }, (pdfRes) => {
          if (pdfRes.statusCode !== 200) { reject(new Error(`PO PDF failed: ${pdfRes.statusCode}`)); return; }
          const chunks = [];
          pdfRes.on('data', chunk => chunks.push(chunk));
          pdfRes.on('end', () => resolve(Buffer.concat(chunks)));
        });
        pdfReq.on('error', reject);
        pdfReq.end();
      });
    } catch (e) {
      console.warn('[VendorPO] PO PDF not available, sending without attachment:', e.message);
      pdfBuffer = null;
    }

    const { getGmailClient } = require('../services/emailScanner');
    const gmail = await getGmailClient(gmailAccount);

    const subject = `PO for RFQ-${estimate.estimateNumber}`;
    const bodyText = req.body.message || `Hi ${vendor.contactName || ''},\n\nPlease find the attached purchase order referencing RFQ-${estimate.estimateNumber}.\n\nThank you,\nCarolina Rolling Co.`;

    let rawMessage;
    if (pdfBuffer) {
      const boundary = 'boundary_' + Date.now();
      const fileName = `PO-${poNumber}.pdf`;
      
      // Get RFC822 Message-ID for threading
      let rfc822MessageId = '';
      if (estimate.rfqThreadId) {
        try {
          const msgs = await gmail.users.messages.list({ userId: 'me', q: `in:sent subject:"RFQ-${estimate.estimateNumber}"`, maxResults: 1 });
          if (msgs.data.messages?.[0]) {
            const orig = await gmail.users.messages.get({ userId: 'me', id: msgs.data.messages[0].id, format: 'metadata', metadataHeaders: ['Message-ID'] });
            const h = orig.data.payload?.headers?.find(h => h.name.toLowerCase() === 'message-id');
            if (h) rfc822MessageId = h.value;
          }
        } catch (e) { /* ignore */ }
      }

      const headerLines = [
        `MIME-Version: 1.0`,
        `To: ${toEmail}`,
        `Subject: ${subject}`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`
      ];
      if (rfc822MessageId) {
        headerLines.push(`In-Reply-To: ${rfc822MessageId}`);
        headerLines.push(`References: ${rfc822MessageId}`);
      }

      rawMessage = [
        ...headerLines, '',
        `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', '', bodyText, '',
        `--${boundary}`, `Content-Type: application/pdf; name="${fileName}"`,
        `Content-Disposition: attachment; filename="${fileName}"`,
        'Content-Transfer-Encoding: base64', '', pdfBuffer.toString('base64'), '',
        `--${boundary}--`
      ].join('\r\n');
    } else {
      rawMessage = [
        `MIME-Version: 1.0`, `To: ${toEmail}`, `Subject: ${subject}`,
        `Content-Type: text/plain; charset="UTF-8"`, '', bodyText
      ].join('\r\n');
    }

    const encodedMessage = Buffer.from(rawMessage).toString('base64url');
    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedMessage,
          threadId: estimate.rfqThreadId || undefined
        }
      }
    });

    const draftMsgId = draft.data.message?.id || draft.data.id;
    const draftUrl = `https://mail.google.com/mail/?authuser=${encodeURIComponent(gmailAccount.email)}#inbox/${draftMsgId}`;

    console.log(`[VendorPO] Draft created for DR-${wo.drNumber} → ${toEmail}`);
    res.json({ data: { draftUrl, draftId: draft.data.id }, message: 'PO draft created' });
  } catch (error) {
    console.error('[VendorPO] Error:', error.message);
    next(error);
  }
});

module.exports = router;
