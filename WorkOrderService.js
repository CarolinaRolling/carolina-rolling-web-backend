const { google } = require('googleapis');
const { GmailAccount, ScannedEmail, PendingOrder, Client, Vendor, Estimate, EstimatePart, EstimateFile, EstimatePartFile, TodoItem, User, AppSettings } = require('../models');
const { Op } = require('sequelize');
const fileStorage = require('../utils/storage');

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
    attributes: ['id', 'name', 'emailScanAddresses', 'emailScanParsingNotes', 'contacts']
  });

  // Build a map: email address → client info
  const emailToClient = {};
  clients.forEach(client => {
    const addresses = client.emailScanAddresses || [];
    addresses.forEach(addr => {
      emailToClient[addr.toLowerCase().trim()] = {
        clientId: client.id,
        clientName: client.name,
        parsingNotes: client.emailScanParsingNotes || '',
        contacts: client.contacts || [],
        type: 'client'
      };
    });
  });

  // Also monitor vendors
  const vendors = await Vendor.findAll({
    where: { emailScanEnabled: true, isActive: true },
    attributes: ['id', 'name', 'emailScanAddresses', 'contactEmail']
  });

  const emailToVendor = {};
  vendors.forEach(vendor => {
    const addresses = vendor.emailScanAddresses || [];
    // Also include the primary contactEmail
    addresses.forEach(addr => {
      emailToVendor[addr.toLowerCase().trim()] = {
        vendorId: vendor.id,
        vendorName: vendor.name,
        type: 'vendor'
      };
    });
  });
  // Also add vendor primary emails
  for (const vendor of vendors) {
    if (vendor.contactEmail) {
      const addr = vendor.contactEmail.toLowerCase().trim();
      if (!emailToVendor[addr]) {
        emailToVendor[addr] = { vendorId: vendor.id, vendorName: vendor.name, type: 'vendor' };
      }
    }
  }

  return { clients, emailToClient, vendors, emailToVendor };
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
    // Truncate very long emails to avoid API token limits
    const truncatedBody = emailBody && emailBody.length > 8000 ? emailBody.substring(0, 8000) + '\n...[truncated]' : (emailBody || '');
    console.log(`[EmailScanner] Calling Anthropic API for: "${subject}" from ${clientName} (body: ${truncatedBody.length} chars)`);
    console.log(`[EmailScanner] API key present: ${!!process.env.ANTHROPIC_API_KEY} (${(process.env.ANTHROPIC_API_KEY || '').substring(0, 10)}...)`);
    
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
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
  IMPORTANT: if the drawing says "56 ID" or "roll to 56 ID", set outerDiameter=56 AND measurePoint="ID". If it says "56 OD", set outerDiameter=56 AND measurePoint="OD".
  unitPrice: if the document shows a price per piece (e.g. "100.00/PC", "$100 each"), set unitPrice to that number (labor/rolling cost only, not material).
  Note: "Shell Height" = the width of the plate. "Shell Length" = the flat arc length. If they say "R/T to 144 OD" that means outerDiameter=144, measurePoint="OD". If they say "R/T to 56 ID", set outerDiameter=56, measurePoint="ID".
  If they give both width and OD you can calculate length: length = π × OD × (arcDegrees/360). But if they provide length, use it.

shaped_plate — Round plates, donuts (rings), and custom-shaped plates (NOT rolled — flat or formed):
  Fields: material, thickness, outerDiameter (OD), innerDiameter (ID — donuts only), width/length (custom shapes only), donutPurpose
  Use this type when: "round plate", "circle", "disc", "donut", "ring plate", "blank", "flange plate", custom shape cut from plate
  Do NOT use plate_roll for these — plate_roll is for bending/rolling. shaped_plate is for flat cut shapes.
  donutPurpose: "cylinder" if forming to fit a cylinder, "head" if forming to fit an elliptical head, omit if flat

cone_roll — Conical shape (frustum, reducer):
  Fields: material, thickness, outerDiameter (large end OD), diameter (small end OD), width (slant height or V/H), arcDegrees
  Note: V/H means vertical height of the cone. Two different diameters = cone.

pipe_roll — Pipe or tube bending:
  Fields: material, outerDiameter, wallThickness, radius (centerline bend radius), arcDegrees
  Note: Pipe is specified by OD and wall thickness, NOT width/length.

angle_roll — Angle iron rolling:
  Fields: material, legSize (e.g. "3x3" — just the leg dimensions, NO thickness), thickness (e.g. "0.375"), radius OR diameter, arcDegrees, rollType (easy_way, hard_way, on_edge), length
  CRITICAL: "2x2 angle" means an angle with 2" x 2" legs — it is ONE part with legSize="2x2", NOT 2 pieces! Same for "3x3 angle", "4x4 angle", etc. The NxN is the leg dimensions.
  "L3x3x3/8" → legSize="3x3", thickness="0.375". The legSize is JUST leg1 x leg2. Thickness is always separate.
  If they want multiple pieces, they'll say "2 pc 2x2 angle" or "qty 2 — 2x2 angle".

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
  Fields: specialInstructions, description, fabType, parentPartIndex
  fabType values: "weld_100" (100% weld/full pen weld), "tack_weld", "bevel", "bracing", "fit" (fit only), "cut_to_size", "finishing", "other"
  IMPORTANT: fab_service parts MUST have a "parentPartIndex" field set to the 0-based index of the rolling/forming part they belong to.
  Example: If part index 0 is a plate_roll and they want it tack welded, create a fab_service with parentPartIndex=0.
  Only create a SEPARATE fab_service if the email explicitly requests welding/beveling/fitting AS A SERVICE.
  Do NOT create fab_service for "R/T" or "rolled and tacked" — that goes in the plate_roll's specialInstructions instead.
  DO create fab_service for: "100% weld", "full penetration weld", "bevel prep", "fit and weld", "grind smooth"

shop_rate — Hourly labor charges:
  Fields: specialInstructions, description, parentPartIndex (optional)

IMPORTANT RULES:
- All dimensions should be in INCHES (convert if given in feet, mm, etc.)
- NEVER confuse section dimensions with quantity! "2x2 angle" = 1 angle with 2"x2" legs. "3x3x1/4 angle" = 1 angle with 3"x3" legs and 1/4" thickness. "4x2 flat" = 1 flat bar 4" wide x 2" thick. Quantity is only specified with words like "qty", "pc", "pcs", "pieces", or a number BEFORE the part description (e.g. "3 pc 2x2 angle" = qty 3). If no quantity is mentioned, default to 1.
- Each unique part line in the email = ONE entry in the parts array. Do NOT split a single part into multiple entries.
- For plate rolls: "width" = height of the shell, "length" = flat developed length
- If they say "rolled and tack welded" or "R/T", put that in the ROLLING PART's specialInstructions — do NOT create a separate fab_service for tack welding
- Only create a separate fab_service part for explicit services like "100% weld", "full pen weld", "bevel", "fit and weld", "grind smooth"
- Every fab_service MUST include "parentPartIndex" pointing to which rolling part it belongs to (0-based index in the parts array)
- If the email mentions a requested delivery date, need-by date, due date, or ship date, extract it as "requestedDate" in YYYY-MM-DD format. Convert relative dates like "next Friday" or "2 weeks" to actual dates based on today's date.
- materialSource: set to "customer_supplied" unless they ask you to supply material
- If information is MISSING from the email (thickness, diameter, material, etc.), leave the field as null and add it to missingFields

AVAILABLE DROPDOWN OPTIONS — You MUST pick from these lists when possible. Only use "Custom" if the value doesn't match any option:

Thickness options (for plate_roll, press_brake, flat_stock, angle_roll):
  "24 ga", "20 ga", "16 ga", "14 ga", "12 ga", "11 ga", "10 ga", '1/8"', '3/16"', '1/4"', '5/16"', '3/8"', '1/2"', '5/8"', '3/4"', '7/8"', '1"', '1-1/4"', '1-1/2"', '2"'
  IMPORTANT: Use the FRACTION format with quotes, e.g. '3/8"' not "0.375". Only use decimals if the value doesn't match a fraction.

Angle sizes (legSize field — legs only, NO thickness):
  "0.5x0.5", "0.75x0.75", "1x1", "1.25x1.25", "1.5x1.5", "2x2", "2.5x2.5", "3x3", "4x4", "5x5", "6x6", "1x2", "2x3", "3x4", "4x5", "4x6"

Channel sizes (sectionSize field — full designation):
  "C3x4.1", "C3x5", "C3x6", "C4x5.4", "C4x7.25", "C5x6.7", "C5x9", "C6x8.2", "C6x10.5", "C6x13", "C7x9.8", "C7x12.25", "C7x14.75", "C8x11.5", "C8x13.75", "C8x18.75", "C9x13.4", "C9x15", "C9x20", "C10x15.3", "C10x20", "C10x25", "C10x30", "C12x20.7", "C12x25", "C12x30", "C15x33.9", "C15x40", "C15x50"

Beam sizes (sectionSize field — full designation):
  W-shapes: "W4x13", "W5x16", "W5x19", "W6x9", "W6x12", "W6x15", "W6x16", "W6x20", "W6x25", "W8x10", "W8x13", "W8x15", "W8x18", "W8x21", "W8x24", "W8x28", "W8x31", "W8x35", "W8x40", "W8x48", "W8x58", "W8x67", "W10x12" thru "W10x112", "W12x14" thru "W12x120", "W14x22" thru "W14x132", "W16x26" thru "W16x100", "W18x35" thru "W18x119", "W21x44" thru "W21x122"
  S-shapes: "S3x5.7", "S3x7.5", "S4x7.7", "S4x9.5", "S5x10", "S6x12.5", "S6x17.25", "S8x18.4", "S8x23", "S10x25.4", "S10x35", "S12x31.8", "S12x35", "S12x40.8", "S12x50"

Tee sizes (sectionSize field): "WT2x6.5", "WT2.5x8", "WT3x4.5" thru "WT3x10", "WT4x5" thru "WT4x29", "WT5x6" thru "WT5x38.5", "WT6x7" thru "WT6x60", "WT7x11" thru "WT7x66"

Flat bar sizes (_barSize field — width x thickness in fractions):
  "1/2x1/4", "3/4x1/4", "3/4x3/8", "1x1/4", "1x3/8", "1x1/2", "1-1/2x1/4", "1-1/2x3/8", "1-1/2x1/2", "2x1/4", "2x3/8", "2x1/2", "2x3/4", "3x1/4", "3x3/8", "3x1/2", "3x3/4", "3x1", "4x3/8", "4x1/2", "4x3/4", "4x1", "5x3/8", "5x1/2", "5x3/4", "5x1", "6x3/8", "6x1/2", "6x3/4", "6x1", "8x1/2", "8x3/4", "8x1", "10x1/2", "10x3/4", "10x1", "12x1/2", "12x3/4", "12x1"

${generalNotes ? `\nGENERAL SHOP NOTES:\n${generalNotes}\n` : ''}
${parsingNotes ? `\nCLIENT-SPECIFIC NOTES:\n${parsingNotes}\n` : ''}

Respond ONLY with valid JSON (no markdown, no backticks). Format:
{
  "emailType": "rfq" or "po" or "general",
  "referenceNumber": "OR number, quote reference, or null",
  "poNumber": "PO number if this is a purchase order, or null",
  "referencesQuote": "reference to previous quote/OR if PO, or null",
  "confidence": "high", "medium", or "low",
  "parts": [
    {
      "partType": "plate_roll",
      "quantity": 1,
      "material": "SA-516-70",
      "thickness": "1/2\\"",
      "width": "120",
      "length": "452.16",
      "outerDiameter": "144",
      "diameter": "144",
      "radius": null,
      "arcDegrees": "360",
      "rollType": "easy_way",
      "legSize": "for angle_roll only: e.g. 3x3",
      "sectionSize": "for channel/beam/tee: e.g. C8x11.5",
      "barSize": "for flat_bar: e.g. 4x1/2",
      "wallThickness": "for pipe_roll",
      "flangeOut": false,
      "fabType": "for fab_service: weld_100, tack_weld, bevel, bracing, fit, cut_to_size, finishing, other",
      "parentPartIndex": "for fab_service: 0-based index of the parent part in this array (e.g. 0 for first part)",
      "specialInstructions": "Rolled and tack welded, no bevel",
      "clientPartNumber": "127250-535S1",
      "description": "auto-generated material description",
      "missingFields": ["thickness", "material"],
      "missingFieldNotes": "No thickness specified. No material grade given."
    }
  ],
  "notes": "delivery or special notes",
  "requestedDate": "requested delivery/completion date if mentioned (YYYY-MM-DD format), or null",
  "attachmentMentions": ["file names mentioned"],
  "aiNotes": "Overall notes about what info was missing or unclear in this email"
}

CRITICAL: For missingFields, list any field the client did NOT provide that is needed to complete the estimate. Common missing fields: thickness, material, diameter/radius, arcDegrees, length, rollType. Add a human-readable note in missingFieldNotes explaining what's missing.

If this is a PO (purchase order) rather than an RFQ:
- Set emailType to "po" ONLY if the email contains EXPLICIT order language such as:
  * An actual PO number ("PO #12345", "Purchase Order 67890")
  * Clear order instructions ("Please proceed", "Go ahead with the order", "We'd like to place an order", "Approved — please schedule")
  * Formal purchase authorization language
- Set emailType to "po" ONLY if there is CLEAR, UNAMBIGUOUS intent to place an order
- Do NOT set emailType to "po" for vague affirmations like "thank you", "sounds good", "looks good", "great", "perfect", "ok", "got it", "thanks for the quote", "we appreciate it"
- A "thank you" reply to a quote is NOT a purchase order — it is "general"
- The presence of quoted/forwarded quote text below a short reply does NOT make it a PO
- Extract the client's PO number into "poNumber"
- Look CAREFULLY for any reference to a previous quote, estimate, or OR number. Check:
  * Subject line for patterns like "RE: Quote...", "OR#12345", "EST-240319-001", "Ref: ..."
  * Body for phrases like "per your quote", "reference estimate", "per OR#...", "as quoted"
  * Any number that looks like our estimate format (EST-XXXXXX or OR followed by digits)
- Put the found reference in "referencesQuote" — this is critical for linking POs to estimates
- If the email is a reply to a quote/RFQ conversation, check the quoted/forwarded text for our estimate numbers too

If the email does NOT contain any parts, material requests, or RFQ/PO content:
- Set emailType to "general"
- Set parts to an empty array []
- Still extract any reference numbers, dates, and notes
- This includes emails like: general inquiries, scheduling questions, status updates, thank you notes, delivery coordination, etc.

CRITICAL — FOLLOW-UP DETECTION:
Many emails are FOLLOW-UPS to a previous quote or RFQ conversation, NOT new requests. Classify these as "general", NOT "rfq" or "po":
- "Thank you" / "Thanks" / "Got it" / "Sounds good" / "Looks good" / "Great" / "Perfect" / "OK" → ALWAYS "general", NEVER "po"
- "Thanks for the quote" / "We appreciate it" / "Received" → ALWAYS "general"
- Any reply under 20 words of NEW content (excluding quoted/forwarded text) → ALWAYS "general" unless it contains an explicit PO number
- Questions about a quote already sent (pricing questions, lead time, delivery, availability) → general  
- "When can you have this done?" / "What's the lead time?" → general
- "Can you send the quote again?" / "I didn't receive the PDF" → general
- "We're reviewing and will get back to you" / "Let me check with my team" → general
- "Please hold off on this" / "We'll pass on this one" → general
- Status updates about material or delivery → general
- Replies that quote/forward the SAME parts from a previous email but add no NEW parts → general
- If the email body is mostly quoted/forwarded text from a previous conversation with only a short new message → general
- Short emails (under 50 words of NEW content, not counting quoted/forwarded text) that don't contain specific part dimensions → general

Only classify as "rfq" if the email contains GENUINELY NEW part requests with specific dimensions, quantities, or material specifications that were NOT in a previous email in the thread.

Add a "summary" field in your response: a 1-2 sentence plain-English summary of what the email is about (for all email types).`,
      messages: [
        { role: 'user', content: `Email from: ${clientName}\nSubject: ${subject}\n\n${truncatedBody}` }
      ]
    });

    const https = require('https');

    // Helper: make one attempt to the Anthropic API
    const attemptAPICall = () => new Promise((resolve, reject) => {
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
          if (res.statusCode === 529) {
            // Overloaded — signal caller to retry
            reject({ retryable: true, statusCode: 529, body: data });
          } else if (res.statusCode !== 200) {
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

    // Retry up to 3 times on 529 overloaded with exponential backoff: 8s, 24s, 72s
    const MAX_RETRIES = 3;
    const BACKOFF_MS = [8000, 24000, 72000];
    let responseText;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        responseText = await attemptAPICall();
        break; // success
      } catch (err) {
        if (err.retryable && attempt < MAX_RETRIES) {
          const waitMs = BACKOFF_MS[attempt];
          console.warn(`[EmailScanner] API overloaded (529) — retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, waitMs));
        } else if (err.retryable) {
          // Exhausted retries
          console.error(`[EmailScanner] API still overloaded after ${MAX_RETRIES} retries — giving up`);
          throw new Error(`API 529: Overloaded — try again later`);
        } else {
          throw err; // non-retryable error
        }
      }
    }

    const data = JSON.parse(responseText);
    const text = data.content?.[0]?.text || '';
    console.log(`[EmailScanner] AI response (first 200): ${text.substring(0, 200)}`);
    
    // Clean and parse JSON
    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (jsonErr) {
      console.error(`[EmailScanner] JSON parse failed. Raw response (first 500): ${text.substring(0, 500)}`);
      console.error(`[EmailScanner] Clean text (first 500): ${clean.substring(0, 500)}`);
      // Try to extract partial JSON if it was truncated
      const lastBrace = clean.lastIndexOf('}');
      if (lastBrace > 0) {
        try {
          parsed = JSON.parse(clean.substring(0, lastBrace + 1));
          console.log(`[EmailScanner] Recovered partial JSON (truncated at char ${lastBrace})`);
        } catch {
          throw new Error(`Invalid JSON from AI: ${jsonErr.message}`);
        }
      } else {
        throw new Error(`Invalid JSON from AI: ${jsonErr.message}`);
      }
    }
    console.log(`[EmailScanner] Parsed: type=${parsed.emailType}, parts=${(parsed.parts || []).length}, confidence=${parsed.confidence}`);
    return parsed;
  } catch (err) {
    console.error('[EmailScanner] AI parse error:', err.message);
    // Return a structured error so callers can see what went wrong
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

  // Helper: resolve measure point from AI response, with a default fallback
  const resolveMP = (part, fallback) => {
    if (part.measurePoint === 'inside' || part.measurePoint === 'ID') return 'inside';
    if (part.measurePoint === 'outside' || part.measurePoint === 'OD') return 'outside';
    if (part.measurePoint === 'centerline' || part.measurePoint === 'CL' || part.measurePoint === 'CLD') return 'centerline';
    return fallback;
  };

  // Common fields
  if (p.material) fd.material = p.material;
  if (p.quantity) fd.quantity = String(p.quantity);
  if (p.specialInstructions) fd.specialInstructions = p.specialInstructions;
  if (p.clientPartNumber) fd.clientPartNumber = p.clientPartNumber;
  if (p.description) fd._materialDescription = p.description;
  fd.materialSource = p.materialSource || 'customer_supplied';
  // Pricing from PO or quote document
  if (p.unitPrice && parseFloat(p.unitPrice) > 0) {
    fd.laborTotal = String(parseFloat(p.unitPrice).toFixed(2));
    fd._baseLaborTotal = String(parseFloat(p.unitPrice).toFixed(2));
  }

  if (type === 'plate_roll') {
    if (p.thickness) fd.thickness = p.thickness;
    if (p.width) fd.width = p.width;
    if (p.length) fd.length = p.length;
    // Roll value — resolve measurePoint first, then pick the right diameter field
    const mp = resolveMP(p, null); // null = not specified
    if (p.outerDiameter || p.diameter || p.innerDiameter || p.radius) {
      if (p.innerDiameter && (!p.outerDiameter || mp === 'inside')) {
        // Explicit innerDiameter field or measurePoint says inside
        fd._rollValue = String(p.innerDiameter);
        fd._rollMeasureType = 'diameter';
        fd._rollMeasurePoint = 'inside';
      } else if (p.radius) {
        fd._rollValue = String(p.radius);
        fd._rollMeasureType = 'radius';
        fd._rollMeasurePoint = mp || 'inside';
      } else {
        // outerDiameter or diameter field — but respect measurePoint if AI specified it
        fd._rollValue = String(p.outerDiameter || p.diameter);
        fd._rollMeasureType = p.measureType || 'diameter';
        // If AI explicitly said ID/inside, honour it even if it put value in outerDiameter
        fd._rollMeasurePoint = mp || 'outside';
      }
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    fd._rollToMethod = '';
  }

  else if (type === 'shaped_plate') {
    if (p.thickness) fd.thickness = p.thickness;
    if (p.outerDiameter) fd.outerDiameter = String(p.outerDiameter);
    if (p.innerDiameter) fd._innerDiameter = String(p.innerDiameter);
    if (p.width) fd.width = p.width;
    if (p.length) fd.length = p.length;
    // Determine shape type
    if (p.innerDiameter || (p.description && p.description.toLowerCase().includes('donut'))) {
      fd._shapeType = 'donut';
    } else if (p.outerDiameter && !p.width && !p.length) {
      fd._shapeType = 'round';
    } else if (p.description && (p.description.toLowerCase().includes('custom') || p.description.toLowerCase().includes('dxf'))) {
      fd._shapeType = 'custom';
      fd._customDescription = p.description;
    } else {
      fd._shapeType = 'round';
    }
    if (p.donutPurpose) fd._donutPurpose = p.donutPurpose;
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
    fd._pipeSize = 'Custom';
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = resolveMP(p, 'centerline');
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'angle_roll') {
    // Angle uses separate legSize and thickness
    let legs = (p.legSize || p.sectionSize || '').replace(/^L/i, '').trim();
    // If AI included thickness as third segment (e.g. "3x3x3/8"), strip it
    // Only strip if there are 3+ segments separated by 'x'
    const segments = legs.split(/x/i);
    if (segments.length >= 3) {
      // First two are legs, rest is thickness
      legs = segments[0] + 'x' + segments[1];
    }
    // Check if legSize matches known sizes
    const KNOWN_ANGLES = ['0.5x0.5','0.75x0.75','1x1','1.25x1.25','1.5x1.5','2x2','2.5x2.5','3x3','4x4','5x5','6x6','1x2','2x3','3x4','4x5','4x6'];
    if (legs && KNOWN_ANGLES.includes(legs)) {
      fd._angleSize = legs;
    } else if (legs) {
      fd._angleSize = 'Custom';
      fd._customAngleSize = legs;
    }
    fd.sectionSize = legs;
    if (p.thickness) fd.thickness = p.thickness;
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = resolveMP(p, 'inside');
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'channel_roll') {
    const size = p.sectionSize || '';
    fd._channelSize = size || 'Custom';
    if (size) fd._customChannelSize = size;
    fd.sectionSize = size;
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = resolveMP(p, 'outside');
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
      fd._rollMeasurePoint = resolveMP(p, 'outside');
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
      fd._rollMeasurePoint = resolveMP(p, 'centerline');
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
      fd._rollMeasurePoint = resolveMP(p, 'outside');
    }
    if (p.arcDegrees) fd.arcDegrees = String(p.arcDegrees);
    if (p.rollType) fd.rollType = p.rollType;
    if (p.length) { fd._lengthOption = 'custom'; fd._customLength = String(p.length); fd.length = String(p.length); }
  }

  else if (type === 'tube_roll') {
    const size = p.sectionSize || '';
    fd._tubeSize = size || 'Custom';
    if (size) fd._customTubeSize = size;
    fd.sectionSize = size;
    if (p.outerDiameter || p.diameter || p.radius) {
      fd._rollValue = String(p.radius || p.diameter || p.outerDiameter || '');
      fd._rollMeasureType = p.radius ? 'radius' : 'diameter';
      fd._rollMeasurePoint = resolveMP(p, 'centerline');
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

  // fab_service — needs fabType and will get _linkedPartId after parts are created
  if (type === 'fab_service') {
    if (p.fabType) fd._fabType = p.fabType;
    if (p.description) fd._serviceDescription = p.description;
    // _linkedPartId gets set in createEstimateFromParsed after all parts exist
  }

  // shop_rate
  if (type === 'shop_rate') {
    if (p.description) fd._serviceDescription = p.description;
  }
  // Store missing fields info for highlighting
  if (p.missingFields && p.missingFields.length > 0) {
    fd._missingFields = p.missingFields;
    fd._missingFieldNotes = p.missingFieldNotes || '';
  }

  // Store barSize for flat_bar matching
  if (type === 'flat_bar' && p.barSize) {
    const KNOWN_BARS = ['1/2x1/4','3/4x1/4','3/4x3/8','1x1/4','1x3/8','1x1/2','1-1/2x1/4','1-1/2x3/8','1-1/2x1/2','2x1/4','2x3/8','2x1/2','2x3/4','3x1/4','3x3/8','3x1/2','3x3/4','3x1','4x3/8','4x1/2','4x3/4','4x1','5x3/8','5x1/2','5x3/4','5x1','6x3/8','6x1/2','6x3/4','6x1','8x1/2','8x3/4','8x1','10x1/2','10x3/4','10x1','12x1/2','12x3/4','12x1'];
    if (KNOWN_BARS.includes(p.barSize)) {
      fd._barSize = p.barSize;
    } else {
      fd._barSize = 'Custom';
      fd._customBarSize = p.barSize;
    }
  }

  return fd;
}

// Collect all PDF and image attachments from a Gmail message payload (handles nested multipart)
function collectAttachments(payload) {
  const results = [];
  function walk(part) {
    if (!part) return;
    const mt = part.mimeType || '';
    const isPdf = mt === 'application/pdf' || (part.filename || '').match(/\.pdf$/i);
    const isImg = mt.startsWith('image/') || (part.filename || '').match(/\.(png|jpg|jpeg|gif|tiff|tif|bmp|webp)$/i);
    if ((isPdf || isImg) && part.body?.attachmentId) {
      results.push({ part, isPdf: !!isPdf, mimeType: isPdf ? 'application/pdf' : mt });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return results;
}

// Merge parts from drawing PDFs into email-parsed parts using quantity context from email
// Strategy: if email body gave us quantities but "all dimensions from drawing", replace with drawing-parsed parts
function mergeAttachmentParts(emailParsed, attachmentResults) {
  // attachmentResults: [{ filename, parts: [...], buffer }]
  
  // Build merged parts list
  // Case 1: email body had no real parts (all missing fields) → use drawing parts only, respect email qty
  // Case 2: email had 1 part per drawing → match by index, merge fields
  // Case 3: email had named parts → try to match by clientPartNumber or index
  
  const emailParts = (emailParsed.parts || []).filter(p =>
    !['fab_service', 'shop_rate'].includes(p.partType)
  );
  const allDrawingParts = attachmentResults.flatMap(r => r.parts || []);
  
  if (allDrawingParts.length === 0) return emailParsed; // no useful data from drawings
  
  // If email had no substantive parts (all missing dims) or just 1 generic entry for multiple drawings
  const emailHasNoDims = emailParts.length === 0 ||
    emailParts.every(p => (p.missingFields || []).length > 2 || (!p.thickness && !p.outerDiameter && !p.diameter && !p.radius && !p.width && !p.sectionSize));

  if (emailHasNoDims || (emailParts.length <= 1 && allDrawingParts.length > 1)) {
    // Use drawing parts as authoritative, preserve quantities from email if 1:1 match
    const mergedParts = [];
    for (let i = 0; i < allDrawingParts.length; i++) {
      const dp = { ...allDrawingParts[i] };
      // Apply email quantity if 1:1 match between email parts and drawings
      if (emailParts[i] && emailParts[i].quantity && !dp.quantity) {
        dp.quantity = emailParts[i].quantity;
      } else if (emailParts.length === 1 && allDrawingParts.length > 1 && emailParts[0].quantity) {
        // Single email line like "3 parts per attached" — spread qty evenly (1 each by default)
        dp.quantity = dp.quantity || 1;
      }
      // Preserve clientPartNumber from email if drawing didn't find one
      if (emailParts[i] && emailParts[i].clientPartNumber && !dp.clientPartNumber) {
        dp.clientPartNumber = emailParts[i].clientPartNumber;
      }
      // Attach which file this part came from
      dp._sourceFile = attachmentResults[Math.floor(i / Math.max(1, allDrawingParts.length / attachmentResults.length))]?.filename;
      mergedParts.push(dp);
    }
    // Add fab_service parts from email parse back in
    const fabParts = (emailParsed.parts || []).filter(p => ['fab_service', 'shop_rate'].includes(p.partType));
    return { ...emailParsed, parts: [...mergedParts, ...fabParts], _parsedFromAttachments: true };
  }

  // Case: email parts match drawing count — merge drawing dims into email parts
  if (emailParts.length === allDrawingParts.length) {
    const mergedParts = emailParts.map((ep, i) => {
      const dp = allDrawingParts[i];
      // Drawing wins on dimensions; email wins on quantity and part numbers
      const merged = { ...dp };
      if (ep.quantity) merged.quantity = ep.quantity;
      if (ep.clientPartNumber && !merged.clientPartNumber) merged.clientPartNumber = ep.clientPartNumber;
      if (ep.materialSource) merged.materialSource = ep.materialSource;
      merged._sourceFile = attachmentResults[i]?.filename;
      return merged;
    });
    const fabParts = (emailParsed.parts || []).filter(p => ['fab_service', 'shop_rate'].includes(p.partType));
    return { ...emailParsed, parts: [...mergedParts, ...fabParts], _parsedFromAttachments: true };
  }

  // Fallback: append drawing parts that have useful dimensions not in email parts
  return emailParsed;
}

// Create an estimate from parsed email data
async function createEstimateFromParsed(parsed, clientInfo, scannedEmail, attachmentFiles = []) {
  try {
    // Use reference number as estimate number for clients like GNB
    const estNumber = parsed.referenceNumber || generateEstimateNumber();
    
    // Check for duplicate
    const existing = await Estimate.findOne({ where: { estimateNumber: estNumber } });
    if (existing) {
      console.log(`[EmailScanner] Estimate ${estNumber} already exists, skipping`);
      return { duplicate: true, estimateId: existing.id };
    }

    // Build internal notes from AI analysis
    const missingInfo = (parsed.parts || [])
      .filter(p => p.missingFieldNotes)
      .map((p, i) => `Part #${i + 1}: ${p.missingFieldNotes}`)
      .join('\n');
    const internalNotes = [parsed.aiNotes, missingInfo].filter(Boolean).join('\n\n') || null;

    // Match sender email to a contact in the client's contacts array
    const senderEmail = (scannedEmail.fromEmail || '').toLowerCase().trim();
    const matchedContact = senderEmail
      ? (clientInfo.contacts || []).find(c => c.email && c.email.toLowerCase().trim() === senderEmail)
      : null;
    const primaryContact = (clientInfo.contacts || []).find(c => c.isPrimary) || (clientInfo.contacts || [])[0] || null;
    const contactToUse = matchedContact || primaryContact || null;

    if (matchedContact) {
      console.log(`[EmailScanner] Matched sender ${senderEmail} to contact "${matchedContact.name}" for ${clientInfo.clientName}`);
    } else if (primaryContact) {
      console.log(`[EmailScanner] No contact matched sender ${senderEmail} — using primary contact "${primaryContact.name}" for ${clientInfo.clientName}`);
    }

    const estimate = await Estimate.create({
      estimateNumber: estNumber,
      clientName: clientInfo.clientName,
      clientId: clientInfo.clientId,
      contactName: contactToUse?.name || null,
      contactEmail: contactToUse?.email || null,
      contactPhone: contactToUse?.phone || null,
      contactExtension: contactToUse?.extension || null,
      status: 'draft',
      notes: parsed.notes || null,
      internalNotes: internalNotes,
      emailLink: scannedEmail.gmailLink,
      scannedEmailId: scannedEmail.id
    });

    // Create parts with proper formData — track IDs for fab service linking
    const createdPartIds = []; // index → part ID
    for (let i = 0; i < (parsed.parts || []).length; i++) {
      const p = parsed.parts[i];
      const formData = buildFormData(p);
      const part = await EstimatePart.create({
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
        sectionSize: p.sectionSize || p.legSize || null,
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
      createdPartIds.push(part.id);

      // Save the source drawing/PDF to this part if available
      const sourceFilename = p._sourceFile;
      const sourceFile = sourceFilename
        ? attachmentFiles.find(f => f.filename === sourceFilename)
        : (attachmentFiles.length === 1 ? attachmentFiles[0] : attachmentFiles[i]);
      if (sourceFile && sourceFile.buffer) {
        try {
          const uploadResult = await fileStorage.uploadBuffer(sourceFile.buffer, {
            folder: `estimates/${estimate.id}/parts`,
            filename: sourceFile.filename,
            mimeType: sourceFile.mimeType || 'application/pdf'
          });
          await EstimatePartFile.create({
            partId: part.id,
            filename: sourceFile.filename,
            originalName: sourceFile.filename,
            mimeType: sourceFile.mimeType || 'application/pdf',
            size: sourceFile.buffer.length,
            url: uploadResult.url,
            cloudinaryId: uploadResult.storageId,
            fileType: sourceFile.mimeType === 'application/pdf' ? 'pdf_print' : 'drawing',
            portalVisible: false
          });
          console.log(`[EmailScanner] Saved attachment "${sourceFile.filename}" to part #${i + 1}`);
        } catch (fileErr) {
          console.error(`[EmailScanner] Failed to save attachment to part #${i + 1}: ${fileErr.message}`);
        }
      }
    }

    // Link fab_service/shop_rate parts to their parent parts
    for (let i = 0; i < (parsed.parts || []).length; i++) {
      const p = parsed.parts[i];
      if ((p.partType === 'fab_service' || p.partType === 'shop_rate') && p.parentPartIndex !== undefined && p.parentPartIndex !== null) {
        const parentId = createdPartIds[p.parentPartIndex];
        if (parentId) {
          const fabPartId = createdPartIds[i];
          await EstimatePart.update(
            { formData: { ...buildFormData(p), _linkedPartId: parentId } },
            { where: { id: fabPartId } }
          );
          console.log(`[EmailScanner] Linked fab_service part #${i + 1} to parent part #${p.parentPartIndex + 1}`);
        }
      }
    }

    // Auto-send for review
    const headEstimator = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
    await TodoItem.create({
      title: `Review pricing: ${estNumber} — ${clientInfo.clientName}`,
      description: `Auto-created from email. ${(parsed.parts || []).length} part(s). Confidence: ${parsed.confidence || 'unknown'}.${attachmentFiles && attachmentFiles.length > 0 ? ` ${attachmentFiles.length} drawing(s) parsed and attached.` : ''}`,
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

    // Try to match to existing estimate — multiple strategies
    let matchedEstimate = null;

    // Strategy 1: AI extracted a reference to our quote/estimate number
    if (!matchedEstimate && parsed.referencesQuote) {
      matchedEstimate = await Estimate.findOne({
        where: {
          [Op.or]: [
            { estimateNumber: parsed.referencesQuote },
            { estimateNumber: { [Op.iLike]: `%${parsed.referencesQuote}%` } }
          ]
        }
      });
      if (matchedEstimate) console.log(`[EmailScanner] Matched by reference number: ${parsed.referencesQuote} → ${matchedEstimate.estimateNumber}`);
    }

    // Strategy 2: AI extracted a generic reference number — check against estimate numbers for this client
    if (!matchedEstimate && parsed.referenceNumber) {
      matchedEstimate = await Estimate.findOne({
        where: {
          clientId: clientInfo.clientId,
          [Op.or]: [
            { estimateNumber: parsed.referenceNumber },
            { estimateNumber: { [Op.iLike]: `%${parsed.referenceNumber}%` } }
          ]
        }
      });
      if (matchedEstimate) console.log(`[EmailScanner] Matched by client reference: ${parsed.referenceNumber} → ${matchedEstimate.estimateNumber}`);
    }

    // Strategy 3: Same Gmail thread — if an earlier email in this thread created an estimate
    if (!matchedEstimate && scannedEmail.gmailThreadId) {
      const threadSibling = await ScannedEmail.findOne({
        where: {
          gmailThreadId: scannedEmail.gmailThreadId,
          id: { [Op.ne]: scannedEmail.id },
          estimateId: { [Op.ne]: null }
        },
        order: [['createdAt', 'DESC']]
      });
      if (threadSibling?.estimateId) {
        matchedEstimate = await Estimate.findByPk(threadSibling.estimateId);
        if (matchedEstimate) console.log(`[EmailScanner] Matched by Gmail thread: threadId=${scannedEmail.gmailThreadId} → ${matchedEstimate.estimateNumber}`);
      }
    }

    // Strategy 4: Scan email body for our estimate number pattern (EST-XXXXXX)
    if (!matchedEstimate && scannedEmail.rawBody) {
      const estMatch = scannedEmail.rawBody.match(/EST-[\d-]+/i);
      if (estMatch) {
        matchedEstimate = await Estimate.findOne({ where: { estimateNumber: estMatch[0] } });
        if (matchedEstimate) console.log(`[EmailScanner] Matched by EST pattern in body: ${estMatch[0]} → ${matchedEstimate.estimateNumber}`);
      }
    }

    // Strategy 5: Check subject line for estimate/OR number patterns
    if (!matchedEstimate && scannedEmail.subject) {
      // Look for OR numbers, estimate numbers, quote references
      const subjectPatterns = [
        /EST-[\d-]+/i,
        /OR[\s#-]*(\d+)/i,
        /(?:quote|estimate|ref|reference)[\s#:]*([A-Z0-9-]+)/i
      ];
      for (const pattern of subjectPatterns) {
        const m = scannedEmail.subject.match(pattern);
        if (m) {
          const searchTerm = m[1] || m[0];
          matchedEstimate = await Estimate.findOne({
            where: {
              clientId: clientInfo.clientId,
              [Op.or]: [
                { estimateNumber: searchTerm },
                { estimateNumber: { [Op.iLike]: `%${searchTerm}%` } }
              ]
            }
          });
          if (matchedEstimate) {
            console.log(`[EmailScanner] Matched by subject pattern: "${searchTerm}" → ${matchedEstimate.estimateNumber}`);
            break;
          }
        }
      }
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
      status: 'pending',
      requestedDate: parsed.requestedDate || null
    });

    console.log(`[EmailScanner] Created pending order PO#${parsed.poNumber} for ${clientInfo.clientName}`);
    return { pendingOrderId: pending.id };
  } catch (err) {
    console.error('[EmailScanner] Create pending order error:', err.message);
    return { error: err.message };
  }
}

// Scan lock to prevent concurrent scans causing deadlocks
let scanRunning = false;

// Main scan function — scans all connected accounts
async function runScan() {
  if (scanRunning) {
    console.log('[EmailScanner] Scan already in progress, skipping');
    return { skipped: true, reason: 'Scan already in progress' };
  }
  scanRunning = true;

  try {
    return await _runScanInternal();
  } catch (fatalErr) {
    console.error('[EmailScanner] Fatal scan error:', fatalErr.message);
    return { error: fatalErr.message, processed: 0, estimates: 0, pendingOrders: 0, errors: 1 };
  } finally {
    scanRunning = false;
  }
}

async function _runScanInternal() {

  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: 'ANTHROPIC_API_KEY not configured' };
  }

  const accounts = await GmailAccount.findAll({ where: { isActive: true } });
  if (accounts.length === 0) {
    return { skipped: true, reason: 'No Gmail accounts connected' };
  }

  const { emailToClient, emailToVendor } = await getScanConfig();
  if (Object.keys(emailToClient).length === 0 && Object.keys(emailToVendor).length === 0) {
    return { skipped: true, reason: 'No email scanning configured' };
  }

  // Load general AI parsing notes
  const generalNotesSetting = await AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
  const generalNotes = generalNotesSetting?.value || '';

  const results = { processed: 0, estimates: 0, pendingOrders: 0, errors: 0, accounts: [] };

  for (const account of accounts) {
    const accountResult = { email: account.email, processed: 0, errors: [] };

    try {
      const gmail = await getGmailClient(account);

      // Build search query: from monitored addresses OR replies to our RFQs
      const allAddresses = [...Object.keys(emailToClient), ...Object.keys(emailToVendor)];
      const queryParts = [];
      if (allAddresses.length > 0) {
        queryParts.push(`(${allAddresses.map(e => `from:${e}`).join(' OR ')})`);
      }
      // Also search for any replies to our RFQ emails (catches vendor responses)
      queryParts.push('subject:RFQ-');
      
      // Use a wider window — go back 2 hours before lastScannedAt to catch edge cases
      const afterDate = account.lastScannedAt 
        ? Math.floor((new Date(account.lastScannedAt).getTime() - 2 * 60 * 60 * 1000) / 1000)
        : Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

      const query = `(${queryParts.join(' OR ')}) after:${afterDate} -label:cr-processed`;
      
      console.log(`[EmailScanner] ${account.email}: Query: ${query}`);
      console.log(`[EmailScanner] ${account.email}: Monitoring ${Object.keys(emailToClient).length} client emails, ${Object.keys(emailToVendor).length} vendor emails`);

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

          // Skip our own sent emails
          if (fromEmail === account.email.toLowerCase()) {
            console.log(`[EmailScanner] Skipping own sent email: ${subject}`);
            continue;
          }

          // Extract body text and build Gmail link early — needed for all paths
          const bodyText = extractTextFromParts(fullMsg.data.payload);
          const gmailLink = `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#inbox/${msg.id}`;

          console.log(`[EmailScanner] Processing: from=${fromEmail}, subject="${subject}", thread=${fullMsg.data.threadId}`);

          // FIRST: Check if this email is in a thread that matches an RFQ we sent
          // This catches vendor responses even if the vendor isn't in the scan list
          const threadId = fullMsg.data.threadId;
          let rfqEstimate = null;
          if (threadId) {
            rfqEstimate = await Estimate.findOne({
              where: { rfqThreadId: threadId }
            });
          }
          // Also check subject for RFQ-EST pattern
          if (!rfqEstimate && subject) {
            const rfqMatch = subject.match(/RFQ-([A-Z0-9-]+)/i);
            if (rfqMatch) {
              rfqEstimate = await Estimate.findOne({
                where: { [Op.or]: [
                  { estimateNumber: rfqMatch[1] },
                  { estimateNumber: { [Op.iLike]: `%${rfqMatch[1]}%` } }
                ]}
              });
            }
          }

          if (rfqEstimate) {
            // ===== VENDOR RESPONSE to our RFQ =====
            const vendorInfo = emailToVendor[fromEmail];
            const vendorName = vendorInfo?.vendorName || fromName || fromEmail;
            
            // Check if already processed
            const alreadyScanned = await ScannedEmail.findOne({
              where: { gmailMessageId: msg.id, gmailAccountId: account.id }
            });
            if (alreadyScanned) continue;

            const scannedEmail = await ScannedEmail.create({
              gmailMessageId: msg.id,
              gmailThreadId: threadId || null,
              gmailAccountId: account.id,
              fromEmail, fromName, subject,
              receivedAt: date ? new Date(date) : new Date(),
              emailType: 'vendor_response',
              status: 'processed',
              gmailLink,
              rawBody: bodyText.substring(0, 10000),
              estimateId: rfqEstimate.id
            });

            console.log(`[EmailScanner] Vendor response from ${vendorName} for ${rfqEstimate.estimateNumber}`);

            // Check for PDF attachments
            let attachedPdf = false;
            if (fullMsg.data.payload?.parts) {
              for (const part of fullMsg.data.payload.parts) {
                if (part.mimeType === 'application/pdf' && part.body?.attachmentId) {
                  try {
                    const attachment = await gmail.users.messages.attachments.get({
                      userId: 'me', messageId: msg.id, id: part.body.attachmentId
                    });
                    const pdfData = Buffer.from(attachment.data.data, 'base64');
                    const fileName = part.filename || `vendor-quote-${vendorName}.pdf`;

                    const cloudinary = require('cloudinary').v2;
                    const uploadResult = await new Promise((resolve, reject) => {
                      const stream = cloudinary.uploader.upload_stream(
                        { resource_type: 'raw', folder: 'estimate-files', public_id: `vendor-quote-${rfqEstimate.estimateNumber}-${Date.now()}` },
                        (error, result) => { if (error) reject(error); else resolve(result); }
                      );
                      stream.end(pdfData);
                    });

                    await EstimateFile.create({
                      estimateId: rfqEstimate.id,
                      filename: uploadResult.public_id,
                      originalName: fileName,
                      mimeType: 'application/pdf',
                      size: pdfData.length,
                      url: uploadResult.secure_url,
                      cloudinaryId: uploadResult.public_id,
                      fileType: 'vendor_quote'
                    });

                    attachedPdf = true;
                    console.log(`[EmailScanner] Saved vendor PDF: ${fileName} → ${rfqEstimate.estimateNumber}`);
                  } catch (pdfErr) {
                    console.error(`[EmailScanner] Failed to save vendor PDF:`, pdfErr.message);
                  }
                }
              }
            }

            // Build short pricing summary for internal notes using AI
            const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
            let pricingSummary = bodyText.substring(0, 2000).trim();
            
            // Try to use AI for a concise summary
            if (process.env.ANTHROPIC_API_KEY && bodyText.trim()) {
              try {
                const https = require('https');
                const summaryBody = JSON.stringify({
                  model: 'claude-sonnet-4-20250514',
                  max_tokens: 500,
                  system: 'Extract material pricing from this vendor quote email. Format as a SHORT list:\nMaterial pricing:\nPart #1: $XX ea (brief description)\nPart #2: $XX ea (brief description)\n\nIf lead time or availability is mentioned, add one line for that. Keep it very concise. No other text.',
                  messages: [{ role: 'user', content: bodyText.substring(0, 3000) }]
                });
                const summaryText = await new Promise((resolve, reject) => {
                  const req = https.request({
                    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(summaryBody) }
                  }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                      if (res.statusCode === 200) {
                        try { resolve(JSON.parse(data).content?.[0]?.text || ''); } catch { resolve(''); }
                      } else { resolve(''); }
                    });
                  });
                  req.on('error', () => resolve(''));
                  req.write(summaryBody);
                  req.end();
                });
                if (summaryText.trim()) pricingSummary = summaryText.trim();
              } catch (e) {
                console.warn('[EmailScanner] AI summary failed, using raw text');
              }
            }
            
            const noteBlock = `\n\n***Supplier quote: ${vendorName} (${timestamp})***\n📧 ${gmailLink}\n${pricingSummary}\n***Supplier quote: end***`;
            const currentNotes = rfqEstimate.internalNotes || '';
            await rfqEstimate.update({ internalNotes: currentNotes + noteBlock });
            console.log(`[EmailScanner] Appended vendor quote to ${rfqEstimate.estimateNumber} internal notes`);

            await scannedEmail.update({
              status: attachedPdf ? 'vendor_pdf_saved' : 'vendor_text_saved',
              parsedData: { vendorName, estimateNumber: rfqEstimate.estimateNumber, attachedPdf }
            });

            // Create todo for estimator
            const headEstimator = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
            await TodoItem.create({
              title: `📨 Vendor quote received: ${rfqEstimate.estimateNumber} — ${vendorName}`,
              description: `${vendorName} replied to RFQ-${rfqEstimate.estimateNumber}.${attachedPdf ? ' PDF attached.' : ' Text captured in internal notes.'}`,
              type: 'estimate_review', priority: 'high',
              assignedTo: headEstimator?.username || null,
              estimateId: rfqEstimate.id,
              estimateNumber: rfqEstimate.estimateNumber,
              createdBy: 'Email Scanner'
            });

            // Label as processed
            try {
              let labelId;
              const labelsRes = await gmail.users.labels.list({ userId: 'me' });
              const existingLabel = labelsRes.data.labels.find(l => l.name === 'cr-processed');
              if (existingLabel) { labelId = existingLabel.id; }
              else {
                const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'cr-processed', labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
                labelId = created.data.id;
              }
              await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [labelId] } });
            } catch (labelErr) { console.warn('[EmailScanner] Label error:', labelErr.message); }

            accountResult.processed++;
            results.processed++;
            continue;
          }

          // Match to client or vendor
          const clientInfo = emailToClient[fromEmail];
          const vendorInfo = emailToVendor[fromEmail];
          if (!clientInfo && !vendorInfo) {
            console.log(`[EmailScanner] Skipping — from=${fromEmail} not in any monitored list. Subject: "${subject}"`);
            continue;
          }

          if (vendorInfo && !clientInfo) {
            // Vendor email that didn't match any RFQ thread — check for invoice
            const invoiceKeywords = /invoice|payment\s*due|remittance|amount\s*due|net\s*\d+|statement|billing|past\s*due|balance\s*due/i;
            const looksLikeInvoice = invoiceKeywords.test(subject) || invoiceKeywords.test(bodyText.substring(0, 1000));
            
            // Check for PDF attachment
            let pdfAttachment = null;
            const checkParts = (parts) => {
              if (!parts) return;
              for (const part of parts) {
                if (part.mimeType === 'application/pdf' || (part.filename && part.filename.match(/\.pdf$/i))) {
                  pdfAttachment = part;
                  return;
                }
                if (part.parts) checkParts(part.parts);
              }
            };
            checkParts(fullMsg.data.payload?.parts);

            if (looksLikeInvoice || pdfAttachment) {
              console.log(`[EmailScanner] Vendor invoice detected from ${vendorInfo.vendorName}: "${subject}" (pdf=${!!pdfAttachment})`);
              
              // Create scanned email record
              const scannedEmail = await ScannedEmail.create({
                gmailMessageId: msg.id,
                gmailThreadId: fullMsg.data.threadId || null,
                gmailAccountId: account.id,
                fromEmail, fromName, subject,
                receivedAt: date ? new Date(date) : new Date(),
                emailType: 'vendor_invoice',
                status: 'processed',
                gmailLink,
                rawBody: bodyText.substring(0, 10000)
              });

              // Download PDF if present
              let pdfBuffer = null;
              let pdfFilename = 'invoice.pdf';
              if (pdfAttachment && pdfAttachment.body?.attachmentId) {
                try {
                  const attRes = await gmail.users.messages.attachments.get({
                    userId: 'me', messageId: msg.id, id: pdfAttachment.body.attachmentId
                  });
                  pdfBuffer = Buffer.from(attRes.data.data, 'base64');
                  pdfFilename = pdfAttachment.filename || 'invoice.pdf';
                } catch (e) { console.warn('[EmailScanner] Failed to download PDF:', e.message); }
              }

              // AI parse the invoice (use email body + PDF text if available)
              let invoiceData = null;
              try {
                const https = require('https');
                const messages = [{ role: 'user', content: [] }];
                
                // Add PDF as document if available
                if (pdfBuffer) {
                  messages[0].content.push({
                    type: 'document',
                    source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') }
                  });
                }
                messages[0].content.push({
                  type: 'text',
                  text: `Vendor: ${vendorInfo.vendorName}\nEmail subject: ${subject}\n\nEmail body:\n${bodyText.substring(0, 3000)}\n\nExtract invoice details from this vendor email/document.`
                });

                const parseBody = JSON.stringify({
                  model: 'claude-sonnet-4-20250514', max_tokens: 1000,
                  system: `Extract invoice/bill information. Return ONLY valid JSON:\n{\n  "vendorInvoiceNumber": "vendor's invoice/reference number or null",\n  "poNumber": "our PO number referenced (PO followed by digits) or null",\n  "amount": 0.00,\n  "dueDate": "YYYY-MM-DD or null",\n  "description": "brief description of what the invoice is for",\n  "lineItems": [{"description": "item", "amount": 0.00}]\n}`,
                  messages
                });

                const parseText = await new Promise((resolve, reject) => {
                  const req = https.request({
                    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(parseBody) }
                  }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                      if (res.statusCode === 200) {
                        try { resolve(JSON.parse(data).content?.[0]?.text || ''); } catch { resolve(''); }
                      } else { console.error(`[EmailScanner] Invoice AI error: ${res.statusCode}`); resolve(''); }
                    });
                  });
                  req.on('error', () => resolve(''));
                  req.write(parseBody); req.end();
                });

                if (parseText.trim()) {
                  const clean = parseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                  invoiceData = JSON.parse(clean);
                  console.log(`[EmailScanner] AI extracted: invoice=${invoiceData.vendorInvoiceNumber}, amount=${invoiceData.amount}, PO=${invoiceData.poNumber}`);
                }
              } catch (e) { console.error('[EmailScanner] Invoice AI parse error:', e.message); }

              // Upload PDF to Cloudinary
              let fileUrl = null, fileCloudinaryId = null;
              if (pdfBuffer) {
                try {
                  const tmpPath = require('path').join(__dirname, `../../uploads/invoice-${Date.now()}.pdf`);
                  require('fs').writeFileSync(tmpPath, pdfBuffer);
                  const uploadResult = await fileStorage.uploadFile(tmpPath, {
                    folder: 'bill-invoices', resource_type: 'raw',
                    public_id: `vendor-invoice-${Date.now()}`
                  });
                  fileUrl = uploadResult.url;
                  fileCloudinaryId = uploadResult.storageId;
                  try { require('fs').unlinkSync(tmpPath); } catch {}
                } catch (e) { console.warn('[EmailScanner] PDF upload failed:', e.message); }
              }

              // Try to match our PO
              let linkedPOId = null;
              if (invoiceData?.poNumber) {
                const poNum = parseInt((invoiceData.poNumber + '').replace(/\D/g, ''));
                if (poNum) {
                  const po = await PONumber.findOne({ where: { poNumber: poNum } });
                  if (po) linkedPOId = po.id;
                }
              }

              // Create pending bill
              const liability = await Liability.create({
                name: invoiceData?.description || `Invoice from ${vendorInfo.vendorName}`,
                category: 'materials',
                amount: invoiceData?.amount || 0,
                dueDate: invoiceData?.dueDate || null,
                vendor: vendorInfo.vendorName,
                vendorId: vendorInfo.vendorId || null,
                vendorInvoiceNumber: invoiceData?.vendorInvoiceNumber || null,
                poNumber: invoiceData?.poNumber || null,
                linkedPOId,
                status: 'pending_review',
                invoiceFileUrl: fileUrl,
                invoiceFileCloudinaryId: fileCloudinaryId,
                createdBy: 'email_scanner',
                scannedEmailId: scannedEmail.id,
                lineItems: invoiceData?.lineItems || null,
                notes: `Auto-detected from email: "${subject}"\n📧 ${gmailLink}`
              });

              await scannedEmail.update({ status: 'vendor_invoice', parsedData: invoiceData });

              // Create todo
              const { TodoItem, User } = require('../models');
              const headEstimator = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
              await TodoItem.create({
                title: `📨 Vendor invoice: ${vendorInfo.vendorName} — $${(invoiceData?.amount || 0).toFixed(2)}`,
                description: `Invoice ${invoiceData?.vendorInvoiceNumber || '(no number)'}${invoiceData?.poNumber ? ` for ${invoiceData.poNumber}` : ''}\n📧 ${gmailLink}`,
                type: 'general', priority: 'high',
                assignedTo: headEstimator?.username || null,
                createdBy: 'Email Scanner'
              });

              // Label as processed
              try {
                let labelId;
                const labelsRes = await gmail.users.labels.list({ userId: 'me' });
                const existingLabel = labelsRes.data.labels.find(l => l.name === 'cr-processed');
                if (existingLabel) { labelId = existingLabel.id; }
                else { const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'cr-processed', labelListVisibility: 'labelShow', messageListVisibility: 'show' } }); labelId = created.data.id; }
                await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [labelId] } });
              } catch {}

              accountResult.processed++;
              results.processed++;
              continue;
            }

            console.log(`[EmailScanner] Skipping — vendor email from ${fromEmail} (${vendorInfo.vendorName}) — not an RFQ response or invoice`);
            continue;
          }

          if (!clientInfo) {
            console.log(`[EmailScanner] Skipping — no client match for ${fromEmail}`);
            continue;
          }

          // ===== CLIENT EMAIL — existing flow =====
          // Create scanned email record
          const scannedEmail = await ScannedEmail.create({
            gmailMessageId: msg.id,
            gmailThreadId: fullMsg.data.threadId || null,
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

          // THREAD DEDUP: Check if this Gmail thread already created an estimate
          // If so, check if this is a PO (should create pending order) or just a follow-up (todo only)
          // EXCEPTION: if the email has PDF/image attachments, treat as a NEW RFQ regardless of thread
          const hasAttachments = collectAttachments(fullMsg.data.payload).length > 0;
          const thisThreadId = fullMsg.data.threadId;
          if (thisThreadId && !hasAttachments) {
            const prevInThread = await ScannedEmail.findOne({
              where: { 
                gmailThreadId: thisThreadId,
                status: { [Op.in]: ['estimate_created', 'pending_order'] },
                id: { [Op.ne]: scannedEmail.id }
              }
            });
            if (prevInThread && prevInThread.estimateId) {
              const existingEstimate = await Estimate.findByPk(prevInThread.estimateId);
              if (existingEstimate) {
                console.log(`[EmailScanner] Thread match for ${existingEstimate.estimateNumber}: "${subject}" — checking if PO...`);
                
                // Do full AI parse to check if this is a PO
                const parsed = await parseEmailWithAI(bodyText, subject, clientInfo.clientName, clientInfo.parsingNotes, generalNotes);
                
                // If AI failed, schedule retry
                if (!parsed) {
                  const retryCount = (scannedEmail.retryCount || 0) + 1;
                  const retryDelays = [60, 120, 240, 480, 960];
                  if (retryCount <= 5) {
                    const delaySec = retryDelays[Math.min(retryCount - 1, retryDelays.length - 1)];
                    const nextRetry = new Date(Date.now() + delaySec * 1000);
                    await scannedEmail.update({ status: 'error', errorMessage: `AI parse failed (attempt ${retryCount}/5)`, retryCount, nextRetryAt: nextRetry });
                    await manageAIWarningTodo(retryCount, subject, clientInfo.clientName);
                  } else {
                    await scannedEmail.update({ status: 'error', errorMessage: 'AI parsing failed after 5 attempts', retryCount, nextRetryAt: null });
                    await manageAIWarningTodo(retryCount, subject, clientInfo.clientName);
                  }
                  accountResult.errors.push(`${subject}: AI parse failed (thread)`);
                  results.errors++;
                  continue;
                }
                
                // Safeguard: short replies like "thank you" should never be POs
                // Strip quoted/forwarded text and check actual new content length
                const newContent = bodyText.replace(/^>.*$/gm, '').replace(/On .*wrote:/g, '').replace(/-{2,}.*Original Message.*-{2,}[\s\S]*/i, '').replace(/From:.*Sent:.*To:.*Subject:[\s\S]*/i, '').trim();
                const wordCount = newContent.split(/\s+/).filter(w => w.length > 0).length;
                const shortReplyPatterns = /^\s*(thank|thanks|thx|got it|sounds good|looks good|great|perfect|ok|okay|received|appreciate|will review|we('ll| will) (review|look|check|get back))/i;
                const hasPONumber = parsed && parsed.poNumber && parsed.poNumber.length > 0;
                const isShortReply = wordCount < 25 && !hasPONumber;
                const isThankYou = shortReplyPatterns.test(newContent);
                
                if (parsed && parsed.emailType === 'po' && (isShortReply || isThankYou)) {
                  console.log(`[EmailScanner] Override: AI said PO but content is too short (${wordCount} words) or is a thank-you reply. Treating as general follow-up.`);
                  parsed.emailType = 'general';
                }
                
                if (parsed && parsed.emailType === 'po') {
                  // This is a PO for an existing estimate — create pending order
                  console.log(`[EmailScanner] PO detected in thread for ${existingEstimate.estimateNumber}`);
                  parsed.referencesQuote = parsed.referencesQuote || existingEstimate.estimateNumber;
                  
                  await scannedEmail.update({
                    emailType: 'po',
                    parsedData: parsed,
                    parseConfidence: parsed.confidence || 'medium',
                    estimateId: existingEstimate.id
                  });

                  const poResult = await createPendingOrderFromParsed(parsed, clientInfo, scannedEmail);
                  if (poResult.pendingOrderId) {
                    await scannedEmail.update({ status: 'pending_order', pendingOrderId: poResult.pendingOrderId });
                    results.pendingOrders++;
                  }

                  // Label as processed
                  try {
                    let labelId;
                    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
                    const existingLabel = labelsRes.data.labels.find(l => l.name === 'cr-processed');
                    if (existingLabel) { labelId = existingLabel.id; }
                    else { const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'cr-processed', labelListVisibility: 'labelShow', messageListVisibility: 'show' } }); labelId = created.data.id; }
                    await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [labelId] } });
                  } catch {}

                  accountResult.processed++;
                  results.processed++;
                  continue;
                }

                // Not a PO — treat as follow-up
                let summary = `Follow-up from ${clientInfo.clientName}: "${subject}"`;
                if (parsed && parsed.summary) {
                  summary = parsed.summary;
                } else if (parsed && parsed.aiNotes) {
                  summary = parsed.aiNotes;
                } else {
                  // Quick AI summary
                  try {
                    const https = require('https');
                    const sumBody = JSON.stringify({
                      model: 'claude-sonnet-4-20250514', max_tokens: 200,
                      system: 'Summarize this email in 1-2 sentences. Be concise. Just the key point.',
                      messages: [{ role: 'user', content: bodyText.substring(0, 2000) }]
                    });
                    const sumText = await new Promise((resolve, reject) => {
                      const req = https.request({
                        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(sumBody) }
                      }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(data).content?.[0]?.text || '' : ''); } catch { resolve(''); } });
                      });
                      req.on('error', () => resolve(''));
                      req.write(sumBody); req.end();
                    });
                    if (sumText.trim()) summary = sumText.trim();
                  } catch {}
                }

                const headEstimator = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
                await TodoItem.create({
                  title: `📩 Follow-up: ${existingEstimate.estimateNumber} — ${clientInfo.clientName}`,
                  description: `${summary}\n\n📧 ${gmailLink}`,
                  type: 'estimate_review', priority: 'medium',
                  assignedTo: headEstimator?.username || null,
                  estimateId: existingEstimate.id,
                  estimateNumber: existingEstimate.estimateNumber,
                  createdBy: 'Email Scanner'
                });

                await scannedEmail.update({ 
                  status: 'follow_up', emailType: 'general',
                  estimateId: existingEstimate.id,
                  parsedData: { followUpTo: existingEstimate.estimateNumber, summary }
                });

                // Label as processed
                try {
                  let labelId;
                  const labelsRes = await gmail.users.labels.list({ userId: 'me' });
                  const existingLabel = labelsRes.data.labels.find(l => l.name === 'cr-processed');
                  if (existingLabel) { labelId = existingLabel.id; }
                  else { const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'cr-processed', labelListVisibility: 'labelShow', messageListVisibility: 'show' } }); labelId = created.data.id; }
                  await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [labelId] } });
                } catch {}

                accountResult.processed++;
                results.processed++;
                continue; // Skip full AI parsing
              }
            }
          }

          // ===== ATTACHMENT COLLECTION + PDF PARSING =====
          // Download all PDF/image attachments and parse each with AI before email text parse
          const attachmentFiles = [];
          const attachmentParsedResults = [];
          try {
            const rawPayload = fullMsg.data.payload;
            const attParts = collectAttachments(rawPayload);
            if (attParts.length > 0) {
              console.log(`[EmailScanner] Found ${attParts.length} attachment(s) in email from ${clientInfo.clientName}`);
            }
            // Download all attachments first (fast — just Gmail API calls)
            const downloadedAtts = [];
            for (const att of attParts) {
              try {
                const attRes = await gmail.users.messages.attachments.get({
                  userId: 'me', messageId: msg.id, id: att.part.body.attachmentId
                });
                const buffer = Buffer.from(attRes.data.data, 'base64');
                const filename = att.part.filename || `attachment-${Date.now()}.${att.isPdf ? 'pdf' : 'png'}`;
                console.log(`[EmailScanner] Downloaded attachment "${filename}" (${Math.round(buffer.length / 1024)}KB)`);
                downloadedAtts.push({ att, buffer, filename });
                attachmentFiles.push({ filename, buffer, mimeType: att.mimeType });
              } catch (attErr) {
                console.error(`[EmailScanner] Failed to download attachment: ${attErr.message}`);
              }
            }
            // Parse all PDFs in parallel with a 25-second timeout per call
            const parseWithTimeout = (buffer, mimeType, name) => {
              const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('PDF parse timeout')), 25000)
              );
              return Promise.race([
                parseDocumentWithAI(buffer, mimeType, clientInfo.clientName, clientInfo.parsingNotes),
                timeout
              ]);
            };
            const parsePromises = downloadedAtts.map(({ buffer, filename, att }) =>
              parseWithTimeout(buffer, att.mimeType, filename)
                .then(docParsed => {
                  if (docParsed && (docParsed.parts || []).length > 0) {
                    console.log(`[EmailScanner] Attachment "${filename}" → ${docParsed.parts.length} part(s)`);
                    attachmentParsedResults.push({ filename, parts: docParsed.parts });
                  } else {
                    console.log(`[EmailScanner] Attachment "${filename}" → no parts found`);
                    attachmentParsedResults.push({ filename, parts: [] });
                  }
                })
                .catch(docErr => {
                  console.error(`[EmailScanner] Failed to parse attachment "${filename}": ${docErr.message}`);
                  attachmentParsedResults.push({ filename, parts: [] });
                })
            );
            await Promise.all(parsePromises);
          } catch (attCollectErr) {
            console.error(`[EmailScanner] Attachment collection error: ${attCollectErr.message}`);
          }

          // Parse with AI (only reaches here for genuinely new conversations)
          const parsed = await parseEmailWithAI(bodyText, subject, clientInfo.clientName, clientInfo.parsingNotes, generalNotes);

          if (!parsed) {
            const retryCount = (scannedEmail.retryCount || 0) + 1;
            const retryDelays = [60, 120, 240, 480, 960]; // 1m, 2m, 4m, 8m, 16m
            if (retryCount <= 5) {
              const delaySec = retryDelays[Math.min(retryCount - 1, retryDelays.length - 1)];
              const nextRetry = new Date(Date.now() + delaySec * 1000);
              await scannedEmail.update({ 
                status: 'error', 
                errorMessage: `AI parse failed (attempt ${retryCount}/5). Auto-retry at ${nextRetry.toLocaleTimeString()}.`,
                retryCount,
                nextRetryAt: nextRetry
              });
              console.log(`[EmailScanner] AI parse failed for "${subject}" — retry ${retryCount}/5 scheduled in ${delaySec}s`);
              // Manage warning todo (single instance)
              await manageAIWarningTodo(retryCount, subject, clientInfo.clientName);
            } else {
              await scannedEmail.update({ 
                status: 'error', 
                errorMessage: `AI parsing failed after 5 attempts. Manual retry required.`,
                retryCount,
                nextRetryAt: null
              });
              await manageAIWarningTodo(retryCount, subject, clientInfo.clientName);
            }
            accountResult.errors.push(`${subject}: AI parse failed`);
            results.errors++;
            continue;
          }

          await scannedEmail.update({
            emailType: parsed.emailType || 'rfq',
            parsedData: parsed,
            parseConfidence: parsed.confidence || 'medium'
          });

          // Check if email has no parts (general inquiry, status update, etc.)
          const hasParts = (parsed.parts || []).length > 0;

          // If drawings were parsed and found parts, upgrade to rfq before the general check fires
          const attachmentHasParts = attachmentParsedResults.some(r => (r.parts || []).length > 0);
          if (attachmentHasParts && (parsed.emailType === 'general' || !hasParts)) {
            console.log(`[EmailScanner] Email body was general/no-parts but drawings found parts — upgrading to rfq`);
            parsed.emailType = 'rfq';
          }
          
          if (parsed.emailType === 'general' || (!hasParts && !attachmentHasParts)) {
            // No parts — create todo notification with summary
            const summary = parsed.summary || parsed.aiNotes || `General email: "${subject}"`;
            
            const headEstimator = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
            await TodoItem.create({
              title: `📧 ${clientInfo.clientName}: ${subject}`,
              description: `${summary}\n\n📧 ${gmailLink}`,
              type: 'general', priority: 'low',
              assignedTo: headEstimator?.username || null,
              createdBy: 'Email Scanner'
            });

            await scannedEmail.update({ 
              status: 'notification', 
              emailType: 'general',
              errorMessage: null 
            });
            console.log(`[EmailScanner] General email from ${clientInfo.clientName} — "${subject}" — todo created`);
            accountResult.processed++;
            results.processed++;
          } else if (parsed.emailType === 'po') {
            // Safeguard: short replies should never be POs
            const newContent2 = bodyText.replace(/^>.*$/gm, '').replace(/On .*wrote:/g, '').replace(/-{2,}.*Original Message.*-{2,}[\s\S]*/i, '').replace(/From:.*Sent:.*To:.*Subject:[\s\S]*/i, '').trim();
            const wc2 = newContent2.split(/\s+/).filter(w => w.length > 0).length;
            const hasPO2 = parsed.poNumber && parsed.poNumber.length > 0;
            const shortPat = /^\s*(thank|thanks|thx|got it|sounds good|looks good|great|perfect|ok|okay|received|appreciate)/i;
            if ((wc2 < 25 && !hasPO2) || shortPat.test(newContent2)) {
              console.log(`[EmailScanner] Override: AI said PO but content too short (${wc2} words). Treating as general.`);
              parsed.emailType = 'general';
            }
          }

          
          if (parsed.emailType === 'po') {
            // PO → create pending order
            const poResult = await createPendingOrderFromParsed(parsed, clientInfo, scannedEmail);
            if (poResult.pendingOrderId) {
              await scannedEmail.update({ status: 'pending_order', pendingOrderId: poResult.pendingOrderId });
              results.pendingOrders++;
            } else if (poResult.duplicate) {
              await scannedEmail.update({ status: 'ignored', errorMessage: 'Duplicate PO' });
            }
          } else if (parsed.emailType === 'rfq') {
            // RFQ → create estimate
            // Merge drawing-parsed parts into email parse result
            const mergedParsed = attachmentParsedResults.length > 0
              ? mergeAttachmentParts(parsed, attachmentParsedResults)
              : parsed;
            if (mergedParsed._parsedFromAttachments) {
              console.log(`[EmailScanner] Using ${attachmentParsedResults.length} drawing(s) as primary source for parts`);
              // Drawings found parts — upgrade to rfq even if email body was vague
              if (mergedParsed.emailType === 'general') {
                mergedParsed.emailType = 'rfq';
                console.log(`[EmailScanner] Upgraded to rfq — drawings provided part specs`);
              }
            }
            const estResult = await createEstimateFromParsed(mergedParsed, clientInfo, scannedEmail, attachmentFiles);
            if (estResult.estimateId) {
              await scannedEmail.update({ status: 'estimate_created', estimateId: estResult.estimateId });
              results.estimates++;
            } else if (estResult.duplicate) {
              await scannedEmail.update({ status: 'ignored', errorMessage: 'Duplicate estimate' });
            } else if (estResult.error) {
              await scannedEmail.update({ status: 'error', errorMessage: estResult.error });
              results.errors++;
            }
          } else if (parsed.emailType !== 'general') {
            // Overridden to general (e.g. "thank you" that AI mistakenly called a PO)
            // Note: true general emails are already handled above — this only fires for
            // unexpected emailType values to avoid creating a duplicate todo.
            const summary = parsed.summary || parsed.aiNotes || `Follow-up email: "${subject}"`;
            const headEstimator = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
            await TodoItem.create({
              title: `📧 ${clientInfo.clientName}: ${subject}`,
              description: `${summary}\n\n📧 ${gmailLink}`,
              type: 'general', priority: 'low',
              assignedTo: headEstimator?.username || null,
              createdBy: 'Email Scanner'
            });
            await scannedEmail.update({ status: 'notification', emailType: 'general', errorMessage: null });
            console.log(`[EmailScanner] Overridden to general: ${clientInfo.clientName} — "${subject}"`);
            accountResult.processed++;
            results.processed++;
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
          // Retry once on deadlock
          if (msgErr.message && msgErr.message.includes('deadlock')) {
            console.warn(`[EmailScanner] Deadlock on message ${msg.id}, retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            try {
              // Just skip this message — it'll be picked up next scan
              console.log(`[EmailScanner] Skipping deadlocked message, will retry next scan`);
            } catch (retryErr) {
              console.error(`[EmailScanner] Retry failed:`, retryErr.message);
            }
          } else {
            console.error(`[EmailScanner] Message error:`, msgErr.message);
          }
          accountResult.errors.push(msgErr.message);
          results.errors++;
        }
        // Small delay between messages to reduce DB contention
        await new Promise(r => setTimeout(r, 500));
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

// Manage a single AI warning todo (create or update, never duplicate)
async function manageAIWarningTodo(retryCount, subject, clientName) {
  const { TodoItem } = require('../models');
  const WARNING_TITLE = '⚠️ AI Email Parsing Error';

  // Find existing warning todo
  const existing = await TodoItem.findOne({
    where: { title: WARNING_TITLE, type: 'general', createdBy: 'Email Scanner' },
    order: [['createdAt', 'DESC']]
  });

  if (retryCount > 5) {
    // Permanent failure
    const desc = `🔴 AI has failed to parse 5 times. Please check AI status.\n\nLast failed email: "${subject}" from ${clientName}.\n\nTroubleshooting:\n• Check Anthropic API key and credits\n• Check Heroku logs for error details\n• Try manual retry from Admin → Email Scanner`;
    if (existing && !existing.completed) {
      await existing.update({ description: desc, priority: 'high' });
    } else {
      await TodoItem.create({ title: WARNING_TITLE, description: desc, type: 'general', priority: 'high', createdBy: 'Email Scanner' });
    }
  } else {
    // Retrying
    const desc = `AI parsing error on "${subject}" from ${clientName}.\nAttempt ${retryCount}/5 — auto-retrying.\n\nThis warning will be removed if the retry succeeds.`;
    if (existing && !existing.completed) {
      await existing.update({ description: desc, priority: 'medium' });
    } else {
      await TodoItem.create({ title: WARNING_TITLE, description: desc, type: 'general', priority: 'medium', createdBy: 'Email Scanner' });
    }
  }
}

// Remove AI warning todo (called on success)
async function clearAIWarningTodo() {
  const { TodoItem } = require('../models');
  const existing = await TodoItem.findOne({
    where: { title: '⚠️ AI Email Parsing Error', type: 'general', createdBy: 'Email Scanner', completed: false },
    order: [['createdAt', 'DESC']]
  });
  if (existing) {
    await existing.update({ completed: true });
    console.log('[EmailScanner] Cleared AI warning todo');
  }
}

// Process pending retries — called on a timer
async function processRetries() {
  const { ScannedEmail, Client } = require('../models');
  const { Op } = require('sequelize');
const fileStorage = require('../utils/storage');
  
  const pendingRetries = await ScannedEmail.findAll({
    where: {
      status: 'error',
      nextRetryAt: { [Op.lte]: new Date() },
      retryCount: { [Op.lte]: 5 }
    },
    order: [['nextRetryAt', 'ASC']],
    limit: 3 // Process max 3 at a time to avoid API overload
  });

  if (pendingRetries.length === 0) return;

  console.log(`[EmailScanner] Processing ${pendingRetries.length} retry(ies)`);

  const generalNotesSetting = await require('../models').AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
  const generalNotes = generalNotesSetting?.value || '';

  for (const email of pendingRetries) {
    if (!email.rawBody) {
      await email.update({ status: 'error', errorMessage: 'No raw body stored — cannot retry', nextRetryAt: null });
      continue;
    }

    const client = email.clientId ? await Client.findByPk(email.clientId) : null;
    const clientName = client?.name || 'Unknown';
    const parsingNotes = client?.emailScanParsingNotes || '';

    console.log(`[EmailScanner] Retry ${email.retryCount}/5 for "${email.subject}" from ${clientName}`);

    try {
      const parsed = await parseEmailWithAI(email.rawBody, email.subject || '', clientName, parsingNotes, generalNotes);
      
      if (parsed) {
        // Success! Clear error state
        await email.update({
          status: 'processed',
          emailType: parsed.emailType || 'rfq',
          parsedData: parsed,
          parseConfidence: parsed.confidence || 'medium',
          errorMessage: null,
          nextRetryAt: null
        });
        console.log(`[EmailScanner] Retry SUCCESS for "${email.subject}"`);
        
        // Clear warning todo if no more pending retries
        const remaining = await ScannedEmail.count({
          where: { status: 'error', nextRetryAt: { [Op.not]: null }, retryCount: { [Op.lte]: 5 } }
        });
        if (remaining === 0) {
          await clearAIWarningTodo();
        }
      } else {
        // Still failing
        const retryCount = (email.retryCount || 0) + 1;
        const retryDelays = [60, 120, 240, 480, 960];
        if (retryCount <= 5) {
          const delaySec = retryDelays[Math.min(retryCount - 1, retryDelays.length - 1)];
          const nextRetry = new Date(Date.now() + delaySec * 1000);
          await email.update({
            errorMessage: `AI parse failed (attempt ${retryCount}/5). Next retry at ${nextRetry.toLocaleTimeString()}.`,
            retryCount,
            nextRetryAt: nextRetry
          });
          await manageAIWarningTodo(retryCount, email.subject, clientName);
        } else {
          await email.update({
            errorMessage: 'AI parsing failed after 5 attempts. Manual retry required.',
            retryCount,
            nextRetryAt: null
          });
          await manageAIWarningTodo(retryCount, email.subject, clientName);
        }
      }
    } catch (err) {
      console.error(`[EmailScanner] Retry error for "${email.subject}":`, err.message);
      const retryCount = (email.retryCount || 0) + 1;
      if (retryCount <= 5) {
        const nextRetry = new Date(Date.now() + 120000); // 2 min fallback
        await email.update({ retryCount, nextRetryAt: nextRetry, errorMessage: `Retry error: ${err.message}` });
      } else {
        await email.update({ retryCount, nextRetryAt: null, errorMessage: `Failed after 5 retries: ${err.message}` });
        await manageAIWarningTodo(retryCount, email.subject, 'Unknown');
      }
    }
  }
}

module.exports = {
  getOAuth2Client,
  getGmailClient,
  runScan,
  isBusinessHours,
  parseEmailWithAI,
  parseDocumentWithAI,
  getScanConfig,
  buildFormData,
  processRetries
};

// Parse an uploaded image or PDF with Claude Vision API
async function parseDocumentWithAI(fileBuffer, mimeType, clientName, parsingNotes) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

    const generalNotesSetting = await AppSettings.findOne({ where: { key: 'email_scanner_general_notes' } });
    const generalNotes = generalNotesSetting?.value || '';

    const base64Data = fileBuffer.toString('base64');
    const isPdf = mimeType === 'application/pdf';

    // Build content array with the document
    const userContent = [];
    if (isPdf) {
      userContent.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64Data }
      });
    } else {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64Data }
      });
    }
    userContent.push({
      type: 'text',
      text: `This is a document from client "${clientName || 'Unknown'}". Extract all parts/materials from this document and return structured JSON. Look for: material specs, dimensions, quantities, rolling/forming requirements, part numbers, and any special instructions. If it's a drawing, extract the dimensions and material callouts from the title block and notes.`
    });

    // Reuse the same system prompt as email parsing
    const systemPrompt = buildParsingSystemPrompt(generalNotes, parsingNotes || '');

    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
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
          if (res.statusCode !== 200) {
            console.error(`[DocParser] AI API error ${res.statusCode}: ${data.substring(0, 500)}`);
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
    console.log(`[DocParser] AI response (first 300): ${text.substring(0, 300)}`);

    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);
    console.log(`[DocParser] Parsed: parts=${(parsed.parts || []).length}, confidence=${parsed.confidence}`);
    return parsed;
  } catch (err) {
    console.error('[DocParser] Error:', err.message);
    throw err;
  }
}

// Extract the system prompt into a reusable function
function buildParsingSystemPrompt(generalNotes, parsingNotes) {
  return `You are an expert at parsing documents from clients requesting quotes for metal rolling, forming, and fabrication services. 
You work for Carolina Rolling Company, a metal rolling shop.

Your job is to extract structured data from client documents (emails, drawings, faxes, PDFs, handwritten notes). These request quotes for rolling steel plates, cones, pipes, angles, channels, beams, etc.

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
  IMPORTANT: if the drawing says "56 ID" or "roll to 56 ID", set outerDiameter=56 AND measurePoint="ID". If it says "56 OD", set outerDiameter=56 AND measurePoint="OD".
  unitPrice: if the document shows a price per piece (e.g. "100.00/PC", "$100 each"), set unitPrice to that number (labor/rolling cost only, not material).

shaped_plate — Round plates, donuts (rings), and custom-shaped plates (NOT rolled — flat or formed):
  Fields: material, thickness, outerDiameter (OD), innerDiameter (ID — donuts only), width/length (custom shapes only), donutPurpose

cone_roll — Conical shape (frustum, reducer):
  Fields: material, thickness, outerDiameter (large end OD), diameter (small end OD), width (slant height or V/H), arcDegrees

pipe_roll — Pipe or tube bending:
  Fields: material, outerDiameter, wallThickness, radius (centerline bend radius), arcDegrees

angle_roll — Angle iron rolling:
  Fields: material, legSize (e.g. "3x3"), thickness, radius OR diameter, arcDegrees, rollType, length
  unitPrice: if a price per piece is shown, set unitPrice.

flat_bar — Flat bar and square bar bending:
  Fields: material, barSize (e.g. "4x1/2"), radius OR diameter, arcDegrees, rollType, length

tube_roll — Square/rectangular tube rolling:
  Fields: material, sectionSize (e.g. "4x4x1/4"), radius OR diameter, arcDegrees, rollType

channel_roll — C-channel rolling:
  Fields: material, sectionSize (e.g. "C8x11.5"), radius OR diameter, arcDegrees, rollType (easy_way, hard_way, flanges_out)

beam_roll — I-beam/H-beam rolling:
  Fields: material, sectionSize (e.g. "W8x31"), radius OR diameter, arcDegrees, rollType (easy_way, hard_way)

press_brake — Press brake forming from print:
  Fields: material, thickness, width, length, description

flat_stock — Ship flat, no rolling:
  Fields: material, thickness, width, length, description

fab_service — Welding, fitting, cut-to-fit:
  Fields: fabType (weld_100, tack_weld, bevel, bracing, fit, cut_to_size, finishing, other), parentPartIndex, description

${generalNotes ? `\nGENERAL SHOP NOTES:\n${generalNotes}\n` : ''}
${parsingNotes ? `\nCLIENT-SPECIFIC NOTES:\n${parsingNotes}\n` : ''}

Respond ONLY with valid JSON (no markdown, no backticks). Format:
{
  "emailType": "rfq",
  "confidence": "high", "medium", or "low",
  "parts": [
    {
      "partType": "plate_roll",
      "quantity": 1,
      "material": "SA-516-70",
      "thickness": "1/2\\"",
      "width": "120",
      "length": "452.16",
      "outerDiameter": "144",
      "diameter": "144",
      "radius": null,
      "arcDegrees": "360",
      "rollType": "easy_way",
      "legSize": null,
      "sectionSize": null,
      "barSize": null,
      "wallThickness": null,
      "innerDiameter": null,
      "flangeOut": false,
      "fabType": null,
      "parentPartIndex": null,
      "specialInstructions": "notes about this part",
      "clientPartNumber": "if visible on drawing",
      "description": "auto-generated material description",
      "measurePoint": "ID or OD or CL — how the diameter was specified on the drawing",
      "unitPrice": 100.00,
      "missingFields": ["thickness"],
      "missingFieldNotes": "No thickness specified on drawing"
    }
  ],
  "notes": "general notes about the document",
  "aiNotes": "What info was missing or unclear"
}

CRITICAL: For missingFields, list any field the client did NOT provide. Common missing fields: thickness, material, diameter/radius, arcDegrees, length, rollType.
If reading a drawing, extract info from the title block, bill of materials, dimension callouts, and notes. If handwritten, do your best to interpret the writing.`;
}
