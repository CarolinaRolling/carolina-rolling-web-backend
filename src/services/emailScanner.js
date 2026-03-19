const { google } = require('googleapis');
const { GmailAccount, ScannedEmail, PendingOrder, Client, Estimate, EstimatePart, TodoItem, User, AppSettings } = require('../models');
const { Op } = require('sequelize');

// Google OAuth2 client
function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:5001'}/api/email-scanner/oauth/callback`
  );
}

// Get Gmail client for a specific account
async function getGmailClient(account) {
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.tokenExpiry ? new Date(account.tokenExpiry).getTime() : null
  });

  // Auto-refresh if expired
  oauth2.on('tokens', async (tokens) => {
    const updates = {};
    if (tokens.access_token) updates.accessToken = tokens.access_token;
    if (tokens.refresh_token) updates.refreshToken = tokens.refresh_token;
    if (tokens.expiry_date) updates.tokenExpiry = new Date(tokens.expiry_date);
    if (Object.keys(updates).length > 0) {
      await account.update(updates);
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2 });
}

// Get all client email addresses that should be scanned
async function getScanConfig() {
  const clients = await Client.findAll({
    where: { emailScanEnabled: true, isActive: true },
    attributes: ['id', 'name', 'emailScanAddresses', 'emailScanParsingNotes']
  });

  // Build a map: email address → client info
  const emailToClient = {};
  clients.forEach(client => {
    const addresses = client.emailScanAddresses || [];
    addresses.forEach(addr => {
      emailToClient[addr.toLowerCase().trim()] = {
        clientId: client.id,
        clientName: client.name,
        parsingNotes: client.emailScanParsingNotes || ''
      };
    });
  });

  return { clients, emailToClient };
}

// Check if within business hours (6 AM - 5 PM Pacific)
function isBusinessHours() {
  const now = new Date();
  const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const hour = pacific.getHours();
  const day = pacific.getDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5 && hour >= 6 && hour < 17;
}

// Parse email body to extract text content
function extractTextFromParts(payload) {
  let text = '';
  
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    text += Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    // Strip HTML tags for plain text
    text += html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      text += '\n' + extractTextFromParts(part);
    }
  }

  return text.trim();
}

// Get email header value
function getHeader(headers, name) {
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : null;
}

// Extract email address from "Name <email>" format
function extractEmail(fromStr) {
  if (!fromStr) return '';
  const match = fromStr.match(/<([^>]+)>/);
  return (match ? match[1] : fromStr).toLowerCase().trim();
}

// Extract display name from "Name <email>" format
function extractName(fromStr) {
  if (!fromStr) return '';
  const match = fromStr.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : fromStr.split('@')[0];
}

// Use Claude API to parse email content
async function parseEmailWithAI(emailBody, subject, clientName, parsingNotes) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: `You are an expert at parsing emails from clients requesting quotes for metal rolling, forming, and fabrication services. 
You work for Carolina Rolling Company, a metal rolling shop.

Your job is to extract structured data from client emails. These emails request quotes for rolling steel plates, cones, pipes, angles, channels, beams, etc.

Common abbreviations:
- OD = outer diameter, ID = inner diameter
- R/T = rolled and tacked (welded)
- V/H = vertical height (for cones)
- pc = piece(s)
- SA-516-70, A36, 304/304L, 316L = material grades
- Shell = cylindrical plate roll

Part types to identify:
- plate_roll: flat plate rolled into a cylinder
- cone_roll: conical shape
- pipe_roll: pipe or tube bending
- angle_roll: angle iron rolling
- channel_roll: channel rolling  
- beam_roll: beam rolling
- flat_bar: flat bar rolling
- press_brake: press brake forming

${parsingNotes ? `\nClient-specific notes: ${parsingNotes}` : ''}

Respond ONLY with valid JSON (no markdown, no backticks). Format:
{
  "emailType": "rfq" or "po",
  "referenceNumber": "OR number, PO number, or null",
  "poNumber": "PO number if this is a purchase order, or null",
  "referencesQuote": "reference to previous quote/OR if PO, or null",
  "confidence": "high", "medium", or "low",
  "parts": [
    {
      "partType": "plate_roll",
      "quantity": 1,
      "material": "SA-516-70",
      "thickness": "0.500",
      "width": "120",
      "length": "452.16",
      "outerDiameter": "144",
      "diameter": "144",
      "specialInstructions": "Rolled and tack welded, no bevel, square and resquare",
      "clientPartNumber": "127250-535S1",
      "description": "Shell - 120\" x 452.16\" x 0.500 SA-516-70, R/T to 144\" OD"
    }
  ],
  "notes": "any delivery or special notes",
  "attachmentMentions": ["list of mentioned file names"]
}

If this is a PO (purchase order) rather than an RFQ, set emailType to "po" and extract the PO number and any reference to a previous quote.`,
        messages: [
          { role: 'user', content: `Email from: ${clientName}\nSubject: ${subject}\n\n${emailBody}` }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AI API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    
    // Clean and parse JSON
    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[EmailScanner] AI parse error:', err.message);
    return null;
  }
}

// Generate estimate number (match existing format)
function generateEstimateNumber() {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `EST-${y}${m}${d}-${rand}`;
}

// Create an estimate from parsed email data
async function createEstimateFromParsed(parsed, clientInfo, scannedEmail) {
  try {
    // Use reference number as estimate number for clients like GNB
    const estNumber = parsed.referenceNumber || generateEstimateNumber();
    
    // Check for duplicate
    const existing = await Estimate.findOne({ where: { estimateNumber: estNumber } });
    if (existing) {
      console.log(`[EmailScanner] Estimate ${estNumber} already exists, skipping`);
      return { duplicate: true, estimateId: existing.id };
    }

    const estimate = await Estimate.create({
      estimateNumber: estNumber,
      clientName: clientInfo.clientName,
      clientId: clientInfo.clientId,
      status: 'draft',
      notes: parsed.notes || null,
      emailLink: scannedEmail.gmailLink,
      scannedEmailId: scannedEmail.id
    });

    // Create parts
    for (let i = 0; i < (parsed.parts || []).length; i++) {
      const p = parsed.parts[i];
      await EstimatePart.create({
        estimateId: estimate.id,
        partNumber: i + 1,
        partType: p.partType || 'plate_roll',
        quantity: parseInt(p.quantity) || 1,
        material: p.material || null,
        thickness: p.thickness || null,
        width: p.width || null,
        length: p.length || null,
        outerDiameter: p.outerDiameter || p.diameter || null,
        diameter: p.diameter || p.outerDiameter || null,
        wallThickness: p.wallThickness || null,
        sectionSize: p.sectionSize || null,
        specialInstructions: p.specialInstructions || null,
        clientPartNumber: p.clientPartNumber || null,
        materialDescription: p.description || null
      });
    }

    // Auto-send for review
    const headEstimator = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
    await TodoItem.create({
      title: `Review pricing: ${estNumber} — ${clientInfo.clientName}`,
      description: `Auto-created from email. ${(parsed.parts || []).length} part(s). Confidence: ${parsed.confidence || 'unknown'}.`,
      type: 'estimate_review',
      priority: 'high',
      assignedTo: headEstimator?.username || null,
      estimateId: estimate.id,
      estimateNumber: estNumber,
      createdBy: 'Email Scanner'
    });

    console.log(`[EmailScanner] Created estimate ${estNumber} for ${clientInfo.clientName} with ${(parsed.parts || []).length} parts`);
    return { estimateId: estimate.id, estimateNumber: estNumber };
  } catch (err) {
    console.error('[EmailScanner] Create estimate error:', err.message);
    return { error: err.message };
  }
}

// Create a pending order from a PO email
async function createPendingOrderFromParsed(parsed, clientInfo, scannedEmail) {
  try {
    // Check duplicate
    if (parsed.poNumber) {
      const existing = await PendingOrder.findOne({ 
        where: { poNumber: parsed.poNumber, clientId: clientInfo.clientId, status: 'pending' } 
      });
      if (existing) {
        console.log(`[EmailScanner] PO ${parsed.poNumber} already pending, skipping`);
        return { duplicate: true };
      }
    }

    // Try to match to existing estimate
    let matchedEstimate = null;
    if (parsed.referencesQuote) {
      matchedEstimate = await Estimate.findOne({
        where: {
          [Op.or]: [
            { estimateNumber: parsed.referencesQuote },
            { estimateNumber: { [Op.iLike]: `%${parsed.referencesQuote}%` } }
          ]
        }
      });
    }

    const pending = await PendingOrder.create({
      clientId: clientInfo.clientId,
      clientName: clientInfo.clientName,
      poNumber: parsed.poNumber || null,
      referenceNumber: parsed.referencesQuote || parsed.referenceNumber || null,
      matchedEstimateId: matchedEstimate?.id || null,
      matchedEstimateNumber: matchedEstimate?.estimateNumber || parsed.referencesQuote || null,
      scannedEmailId: scannedEmail.id,
      emailLink: scannedEmail.gmailLink,
      subject: scannedEmail.subject,
      parsedData: parsed,
      status: 'pending'
    });

    console.log(`[EmailScanner] Created pending order PO#${parsed.poNumber} for ${clientInfo.clientName}`);
    return { pendingOrderId: pending.id };
  } catch (err) {
    console.error('[EmailScanner] Create pending order error:', err.message);
    return { error: err.message };
  }
}

// Main scan function — scans all connected accounts
async function runScan(forceOutsideHours = false) {
  if (!forceOutsideHours && !isBusinessHours()) {
    return { skipped: true, reason: 'Outside business hours' };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: 'ANTHROPIC_API_KEY not configured' };
  }

  const accounts = await GmailAccount.findAll({ where: { isActive: true } });
  if (accounts.length === 0) {
    return { skipped: true, reason: 'No Gmail accounts connected' };
  }

  const { emailToClient } = await getScanConfig();
  if (Object.keys(emailToClient).length === 0) {
    return { skipped: true, reason: 'No client email scanning configured' };
  }

  const results = { processed: 0, estimates: 0, pendingOrders: 0, errors: 0, accounts: [] };

  for (const account of accounts) {
    const accountResult = { email: account.email, processed: 0, errors: [] };

    try {
      const gmail = await getGmailClient(account);

      // Build search query: from any of the configured client emails, newer than last scan
      const fromAddresses = Object.keys(emailToClient);
      const fromQuery = fromAddresses.map(e => `from:${e}`).join(' OR ');
      
      // Search for unread messages or messages after last scan
      const afterDate = account.lastScannedAt 
        ? Math.floor(new Date(account.lastScannedAt).getTime() / 1000)
        : Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000); // Default: last 24h

      const query = `(${fromQuery}) after:${afterDate} -label:cr-processed`;

      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 20
      });

      const messages = listRes.data.messages || [];
      console.log(`[EmailScanner] ${account.email}: Found ${messages.length} new messages`);

      for (const msg of messages) {
        try {
          // Check if already processed
          const already = await ScannedEmail.findOne({
            where: { gmailMessageId: msg.id, gmailAccountId: account.id }
          });
          if (already) continue;

          // Fetch full message
          const fullMsg = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full'
          });

          const headers = fullMsg.data.payload?.headers || [];
          const from = getHeader(headers, 'From') || '';
          const subject = getHeader(headers, 'Subject') || '';
          const date = getHeader(headers, 'Date');
          const fromEmail = extractEmail(from);
          const fromName = extractName(from);

          // Match to client
          const clientInfo = emailToClient[fromEmail];
          if (!clientInfo) continue; // Not from a monitored address

          // Extract body text
          const bodyText = extractTextFromParts(fullMsg.data.payload);
          
          // Build Gmail link
          const gmailLink = `https://mail.google.com/mail/u/0/#inbox/${msg.id}`;

          // Create scanned email record
          const scannedEmail = await ScannedEmail.create({
            gmailMessageId: msg.id,
            gmailAccountId: account.id,
            fromEmail,
            fromName,
            subject,
            receivedAt: date ? new Date(date) : new Date(),
            clientId: clientInfo.clientId,
            emailType: 'unknown',
            status: 'processed',
            gmailLink,
            rawBody: bodyText.substring(0, 10000) // Cap at 10k chars
          });

          // Parse with AI
          const parsed = await parseEmailWithAI(bodyText, subject, clientInfo.clientName, clientInfo.parsingNotes);

          if (!parsed) {
            await scannedEmail.update({ status: 'error', errorMessage: 'AI parsing returned no result' });
            accountResult.errors.push(`${subject}: AI parse failed`);
            results.errors++;
            continue;
          }

          await scannedEmail.update({
            emailType: parsed.emailType || 'rfq',
            parsedData: parsed,
            parseConfidence: parsed.confidence || 'medium'
          });

          if (parsed.emailType === 'po') {
            // PO → create pending order
            const poResult = await createPendingOrderFromParsed(parsed, clientInfo, scannedEmail);
            if (poResult.pendingOrderId) {
              await scannedEmail.update({ status: 'pending_order', pendingOrderId: poResult.pendingOrderId });
              results.pendingOrders++;
            } else if (poResult.duplicate) {
              await scannedEmail.update({ status: 'ignored', errorMessage: 'Duplicate PO' });
            }
          } else {
            // RFQ → create estimate
            const estResult = await createEstimateFromParsed(parsed, clientInfo, scannedEmail);
            if (estResult.estimateId) {
              await scannedEmail.update({ status: 'estimate_created', estimateId: estResult.estimateId });
              results.estimates++;
            } else if (estResult.duplicate) {
              await scannedEmail.update({ status: 'ignored', errorMessage: 'Duplicate estimate' });
            } else if (estResult.error) {
              await scannedEmail.update({ status: 'error', errorMessage: estResult.error });
              results.errors++;
            }
          }

          // Label email as processed in Gmail
          try {
            // Create label if it doesn't exist
            let labelId;
            const labelsRes = await gmail.users.labels.list({ userId: 'me' });
            const existing = labelsRes.data.labels.find(l => l.name === 'cr-processed');
            if (existing) {
              labelId = existing.id;
            } else {
              const created = await gmail.users.labels.create({
                userId: 'me',
                requestBody: { name: 'cr-processed', labelListVisibility: 'labelShow', messageListVisibility: 'show' }
              });
              labelId = created.data.id;
            }
            await gmail.users.messages.modify({
              userId: 'me',
              id: msg.id,
              requestBody: { addLabelIds: [labelId] }
            });
          } catch (labelErr) {
            console.warn('[EmailScanner] Label error:', labelErr.message);
          }

          accountResult.processed++;
          results.processed++;

        } catch (msgErr) {
          console.error(`[EmailScanner] Message error:`, msgErr.message);
          accountResult.errors.push(msgErr.message);
          results.errors++;
        }
      }

      await account.update({ lastScannedAt: new Date(), lastError: null });
    } catch (acctErr) {
      console.error(`[EmailScanner] Account ${account.email} error:`, acctErr.message);
      await account.update({ lastError: acctErr.message });
      accountResult.errors.push(acctErr.message);
    }

    results.accounts.push(accountResult);
  }

  console.log(`[EmailScanner] Scan complete: ${results.processed} processed, ${results.estimates} estimates, ${results.pendingOrders} pending orders, ${results.errors} errors`);
  return results;
}

module.exports = {
  getOAuth2Client,
  getGmailClient,
  runScan,
  isBusinessHours,
  parseEmailWithAI,
  getScanConfig
};
