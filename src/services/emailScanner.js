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
async function parseEmailWithAI(emailBody, subject, clientName, parsingNotes, generalNotes) {
  try {
    console.log(`[EmailScanner] Calling Anthropic API for: "${subject}" from ${clientName}`);
    console.log(`[EmailScanner] API key present: ${!!process.env.ANTHROPIC_API_KEY} (${(process.env.ANTHROPIC_API_KEY || '').substring(0, 10)}...)`);
    
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `You are an expert at parsing emails from clients requesting quotes for metal rolling, forming, and fabrication services. 
You work for Carolina Rolling Company, a metal rolling shop.

Your job is to extract structured data from client emails. These emails request quotes for rolling steel plates, cones, pipes, angles, channels, beams, etc.

COMMON ABBREVIATIONS:
- OD = outer diameter, ID = inner diameter
- R/T or R&T = rolled and tacked (tack welded along the seam)
- V/H = vertical height (for cones)
- pc = piece(s)
- SA-516-70, A36, 304/304L, 316L, SA-240 = material grades
- Shell = cylindrical plate roll
- EW = easy way (rolling along the length, width becomes circumference)
- HW = hard way (rolling along the width, length becomes circumference)
- ISOF = inside out flange

PART TYPES AND THEIR FORM FIELDS:

plate_roll — Flat plate rolled into a cylinder (shell, ring, segment):
  Fields: material, thickness, width (= shell height), length (flat arc length), outerDiameter OR diameter, arcDegrees (360 for full cylinder), rollType (easy_way or hard_way)
  Note: "Shell Height" = the width of the plate. "Shell Length" = the flat arc length. If they say "R/T to 144 OD" that means outerDiameter=144.
  If they give both width and OD you can calculate length: length = π × OD × (arcDegrees/360). But if they provide length, use it.

cone_roll — Conical shape (frustum, reducer):
  Fields: material, thickness, outerDiameter (large end OD), diameter (small end OD), width (slant height or V/H), arcDegrees
  Note: V/H means vertical height of the cone. Two different diameters = cone.

pipe_roll — Pipe or tube bending:
  Fields: material, outerDiameter, wallThickness, radius (centerline bend radius), arcDegrees
  Note: Pipe is specified by OD and wall thickness, NOT width/length.

angle_roll — Angle iron rolling:
  Fields: material, legSize (e.g. "3x3" — just the leg dimensions, NO thickness), thickness (e.g. "0.375"), radius OR diameter, arcDegrees, rollType (easy_way, hard_way, on_edge), length
  Note: "L3x3x3/8" → legSize="3x3", thickness="0.375". The legSize is JUST leg1 x leg2. Thickness is always separate.

channel_roll — Channel rolling:
  Fields: material, sectionSize (e.g. "C8x11.5" — full designation with weight), radius OR diameter, arcDegrees, flangeOut (boolean), rollType, length
  Note: Channel sizes include the weight: "C8x11.5", "MC8x22.8". Do NOT separate thickness — use the full designation.

beam_roll — Beam/wide flange rolling:
  Fields: material, sectionSize (e.g. "W8x31" or "S8x23" — full designation), radius OR diameter, arcDegrees, rollType (easy_way or hard_way), length

tee_bar — Tee bar rolling:
  Fields: material, sectionSize (e.g. "WT5x22.5" — full designation), radius OR diameter, arcDegrees, rollType, length

flat_bar — Flat bar rolling:
  Fields: material, thickness, width, radius OR diameter, arcDegrees, rollType (easy_way, hard_way, on_edge), length
  Note: Width and thickness are separate fields. "1/2 x 4 flat" → width="4", thickness="0.500"

square_tube_roll — Square or rectangular tube rolling:
  Fields: material, sectionSize (e.g. "2x2" or "4x2"), wallThickness, radius OR diameter, arcDegrees, rollType, length

flat_stock — Flat stock (plate without rolling):
  Fields: material, thickness, width, length

press_brake — Press brake forming:
  Fields: material, thickness, width, length, specialInstructions

fab_service — Fabrication service (welding, fitting, etc.):
  Fields: specialInstructions, description

IMPORTANT RULES:
- All dimensions should be in INCHES (convert if given in feet, mm, etc.)
- "thickness" is plate thickness (e.g. "0.500", "3/8", "0.375")
- For plate rolls: "width" = height of the shell, "length" = flat developed length
- If they say "rolled and tack welded" or "R/T", put that in specialInstructions
- If they mention "no bevel", "square and resquare", "stress relieve", etc. put in specialInstructions
- materialSource: set to "customer_supplied" unless they ask you to supply material
- Convert fractions to decimals (3/8 = 0.375, 1/2 = 0.500, 5/8 = 0.625, 3/4 = 0.750)

${generalNotes ? `\nGENERAL SHOP NOTES:\n${generalNotes}\n` : ''}
${parsingNotes ? `\nCLIENT-SPECIFIC NOTES:\n${parsingNotes}\n` : ''}

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
      "radius": null,
      "arcDegrees": "360",
      "rollType": "easy_way or hard_way or on_edge or null",
      "legSize": "for angle_roll only: leg dimensions like 3x3 (NO thickness)",
      "sectionSize": "for channel/beam/tee: full designation like C8x11.5, W8x31, WT5x22.5",
      "wallThickness": "for pipe_roll or square_tube_roll",
      "flangeOut": "for channel_roll: true or false",
      "specialInstructions": "Rolled and tack welded, no bevel, square and resquare",
      "clientPartNumber": "127250-535S1",
      "description": "Shell - 120\\" x 452.16\\" x 0.500 SA-516-70, R/T to 144\\" OD"
    }
  ],
  "notes": "any delivery or special notes",
  "attachmentMentions": ["list of mentioned file names"]
}

If this is a PO (purchase order) rather than an RFQ, set emailType to "po" and extract the PO number and any reference to a previous quote.`,
      messages: [
        { role: 'user', content: `Email from: ${clientName}\nSubject: ${subject}\n\n${emailBody}` }
      ]
    });

    const https = require('https');
    const responseText = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`[EmailScanner] API response status: ${res.statusCode}`);
          if (res.statusCode !== 200) {
            console.error(`[EmailScanner] AI API error ${res.statusCode}: ${data.substring(0, 500)}`);
            reject(new Error(`API ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    const data = JSON.parse(responseText);
    const text = data.content?.[0]?.text || '';
    console.log(`[EmailScanner] AI response (first 200): ${text.substring(0, 200)}`);
    
    // Clean and parse JSON
    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);
    console.log(`[EmailScanner] Parsed: type=${parsed.emailType}, parts=${(parsed.parts || []).length}, confidence=${parsed.confidence}`);
    return parsed;
  } catch (err) {
    console.error('[EmailScanner] AI parse error:', err.message, err.stack);
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

// Build formData object that matches what the frontend form components expect
function buildFormData(p) {
  const fd = {};
  const type = p.partType || 'plate_roll';

  // Common fields
  if (p.material) fd.material = p.material;
  if (p.quantity) fd.quantity = String(p.quantity);
  if (p.specialInstructions) fd.specialInstructions = p.specialInstructions;
  if (p.clientPartNumber) fd.clientPartNumber = p.clientPartNumber;
  if (p.description) fd._materialDescription = p.description;
  fd.materialSource = p.materialSource || 'customer_supplied';

  if (type === 'plate_roll') {
    if (p.thickness) fd.thickness = p.thickness;
    if (p.width) fd.width = p.width;
    if (p.length) fd.length = p.length;
    // Roll value — prefer diameter
    if (p.outerDiameter || p.diameter) {
      fd._rollValue = String(p.outerDiameter || p.diameter);
      fd._rollMeasureType = 'diameter';
      fd._rollMeasurePoint = 'outside';
    } else if (p.radius) {
      fd._rollValue = String(p.radius);
      fd._rollMeasureType = 'radius';
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    fd._rollToMethod = '';
  }

  else if (type === 'cone_roll') {
    if (p.thickness) fd.thickness = p.thickness;
    // Large end = outerDiameter, small end = diameter
    if (p.outerDiameter) {
      fd._coneLargeDia = String(p.outerDiameter);
      fd._coneLargeDiaType = 'outside';
      fd._coneLargeDiaMeasure = 'diameter';
    }
    if (p.diameter) {
      fd._coneSmallDia = String(p.diameter);
      fd._coneSmallDiaType = 'outside';
      fd._coneSmallDiaMeasure = 'diameter';
    }
    if (p.width) fd._coneHeight = String(p.width); // V/H = cone height
    fd._coneType = 'concentric';
    fd._coneRadialSegments = '1';
  }

  else if (type === 'pipe_roll') {
    if (p.outerDiameter) fd.outerDiameter = String(p.outerDiameter);
    if (p.wallThickness) fd.wallThickness = String(p.wallThickness);
    // Look up common pipe size or set as custom
    fd._pipeSize = 'Custom';
    if (p.outerDiameter || p.diameter) {
      fd._rollValue = String(p.radius || p.diameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = 'centerline';
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'angle_roll') {
    // Angle uses separate legSize and thickness
    const legs = p.legSize || p.sectionSize || '';
    // Strip "L" prefix and thickness if AI included it (e.g. "L3x3x3/8" → "3x3")
    const cleanLegs = legs.replace(/^L/i, '').replace(/x[\d/.]+$/, '').trim();
    // Check if legSize matches known sizes (e.g. "3x3")
    const KNOWN_ANGLES = ['0.5x0.5','0.75x0.75','1x1','1.25x1.25','1.5x1.5','2x2','2.5x2.5','3x3','4x4','5x5','6x6','1x2','2x3','3x4','4x5','4x6'];
    if (cleanLegs && KNOWN_ANGLES.includes(cleanLegs)) {
      fd._angleSize = cleanLegs;
    } else if (cleanLegs) {
      fd._angleSize = 'Custom';
      fd._customAngleSize = cleanLegs;
    }
    fd.sectionSize = legs;
    if (p.thickness) fd.thickness = p.thickness;
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = 'inside';
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'channel_roll') {
    const size = p.sectionSize || '';
    // Channel sizes are full designations like "C8x11.5"
    fd._channelSize = size || 'Custom';
    if (size) fd._customChannelSize = size;
    fd.sectionSize = size;
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = 'outside';
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    if (p.flangeOut !== undefined) fd.flangeOut = p.flangeOut;
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'beam_roll') {
    const size = p.sectionSize || '';
    fd._beamSize = size || 'Custom';
    if (size) fd._customBeamSize = size;
    fd.sectionSize = size;
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = 'outside';
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'flat_bar') {
    if (p.thickness) fd.thickness = p.thickness;
    if (p.width) fd.width = p.width;
    if (p.sectionSize) {
      fd._barSize = 'Custom';
      fd._customBarSize = p.sectionSize;
      fd._barShape = 'flat';
    } else if (p.width && p.thickness) {
      fd._barSize = 'Custom';
      fd._customBarSize = `${p.width}x${p.thickness}`;
      fd._barShape = p.width === p.thickness ? 'square' : 'flat';
    }
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = 'centerline';
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'tee_bar') {
    const size = p.sectionSize || '';
    fd._teeSize = size || 'Custom';
    if (size) fd._customTeeSize = size;
    fd.sectionSize = size;
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = 'outside';
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'press_brake') {
    if (p.thickness) fd.thickness = p.thickness;
    if (p.width) fd.width = p.width;
    if (p.length) fd.length = p.length;
  }

  else if (type === 'flat_stock') {
    if (p.thickness) fd.thickness = p.thickness;
    if (p.width) fd.width = p.width;
    if (p.length) fd.length = p.length;
  }

  // fab_service and shop_rate just use specialInstructions/description
  return fd;
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

    // Create parts with proper formData
    for (let i = 0; i < (parsed.parts || []).length; i++) {
      const p = parsed.parts[i];
      const formData = buildFormData(p);
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
        radius: p.radius || null,
        arcDegrees: p.arcDegrees || null,
        rollType: p.rollType || null,
        flangeOut: p.flangeOut || false,
        specialInstructions: p.specialInstructions || null,
        clientPartNumber: p.clientPartNumber || null,
        materialDescription: p.description || null,
        materialSource: p.materialSource || 'customer_supplied',
        formData: formData
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

  // Load general AI parsing notes
  const generalNotesSetting = await AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
  const generalNotes = generalNotesSetting?.value || '';

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
          const parsed = await parseEmailWithAI(bodyText, subject, clientInfo.clientName, clientInfo.parsingNotes, generalNotes);

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
  getScanConfig,
  buildFormData
};
