// poScanner.js — extract structured data from a customer Purchase Order (PDF or photo) using a
// vision model, so the system can find the matching estimate and flag discrepancies.
//
// Stage 1: extraction only. Given a base64 file + mime type, return the client, PO number, and line
// items (description, dimensions, quantity). Later stages match this against estimates.
//
// The read is best-effort — client POs vary (clean PDFs, phone photos of crumpled paper). Callers
// must treat the output as a suggestion for a human to verify, never as ground truth.

const { getParsingModel } = require('./aiConfig');

const PO_SYS = `You extract fields from a CUSTOMER PURCHASE ORDER received by a contract steel-rolling shop (they roll steel into rings and bend/roll structural shapes). The PO is from a client ordering parts. Reply with ONLY JSON, no markdown:
{"clientName":string|null,"poNumber":string|null,"poDate":"YYYY-MM-DD"|null,"lineItems":[{"description":string,"material":string|null,"shape":string|null,"dimensions":string|null,"diameter":string|null,"quantity":number|null,"unit":string|null}],"notes":string|null,"confidence":"high|medium|low"}

Guidance:
- clientName = the company that ISSUED the PO (the buyer/customer), not the shop.
- poNumber = the customer's purchase order number (look for "PO", "P.O.", "Purchase Order #", "Order No").
- lineItems = each distinct item ordered. description = the full item text as written. shape = angle/beam/channel/flat bar/pipe/tube/tee/plate/other if identifiable. dimensions = size text like "1-1/2 x 1-1/2 x 1/4" or "4 x 1/4". diameter = ring/roll diameter or ID if stated (e.g. "24\\" ID"). quantity = number ordered; unit = pcs/rings/lengths/ft if stated.
- Preserve fractions and units exactly as written; do not convert or round.
- confidence = your overall confidence in the read: high for a clean typed PO, low for a blurry/handwritten photo.
- Use null for any field not present. Never invent a PO number or client.`;

function callClaudeVision(content) {
  const reqBody = JSON.stringify({ model: getParsingModel(), max_tokens: 1500, system: PO_SYS, messages: [{ role: 'user', content }] });
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(reqBody) },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('PO extract timeout')));
    req.write(reqBody); req.end();
  });
}

/**
 * Extract structured data from a PO file.
 * @param {Buffer} buffer  the file bytes
 * @param {string} mimeType  e.g. 'application/pdf', 'image/jpeg', 'image/png'
 * @returns {Promise<object>} { clientName, poNumber, poDate, lineItems[], notes, confidence } or { error }
 */
async function extractPurchaseOrder(buffer, mimeType) {
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'no_api_key' };
  if (!buffer || !buffer.length) return { error: 'empty_file' };

  const b64 = buffer.toString('base64');
  let block;
  if (mimeType === 'application/pdf') {
    block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  } else if (/^image\/(jpeg|png|gif|webp)$/.test(mimeType || '')) {
    block = { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } };
  } else {
    return { error: 'unsupported_type', mimeType };
  }

  try {
    const raw = await callClaudeVision([block, { type: 'text', text: 'Extract the purchase order fields as specified.' }]);
    const data = JSON.parse(raw);
    if (data.error) return { error: 'api_error', detail: data.error };
    const text = (data.content?.[0]?.text || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    if (!text) return { error: 'empty_response' };
    const parsed = JSON.parse(text);
    // Normalize shape
    parsed.lineItems = Array.isArray(parsed.lineItems) ? parsed.lineItems : [];
    parsed.confidence = parsed.confidence || 'medium';
    return parsed;
  } catch (err) {
    return { error: 'extract_failed', detail: err.message };
  }
}

module.exports = { extractPurchaseOrder, matchEstimates };

// ---------------------------------------------------------------------------
// Stage 2: match extracted PO data against open estimates and score candidates.
// ---------------------------------------------------------------------------

// Normalize text for comparison: lowercase, drop punctuation, collapse whitespace.
function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9. ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pull comparable numeric tokens (dimensions, diameters) out of a text string. e.g. "52.75 x 228.55"
// and "73.75 OD" -> ["52.75","228.55","73.75"]. Used to compare PO line items to estimate parts
// without depending on exact wording.
function numTokens(s) {
  const out = new Set();
  const matches = String(s || '').match(/\d+(?:\.\d+)?(?:\s*[-/]\s*\d+(?:\.\d+)?)?/g) || [];
  for (const m of matches) {
    const cleaned = m.replace(/\s+/g, '');
    // skip trivially small integers (like a lone "1" or "2") that add noise
    const val = parseFloat(cleaned);
    if (!isNaN(val) && val >= 3) out.add(cleaned);
  }
  return out;
}

// Simple fuzzy similarity for client names (0..1): token overlap + substring bonus. Handles the
// "Howell" vs "Nowell" OCR case reasonably (shared "owell steel" tokens) without external deps.
function nameSimilarity(a, b) {
  const na = normText(a), nb = normText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const tokenScore = shared / Math.max(ta.size, tb.size);
  // Character-level closeness on the whole string (catches single-letter OCR errors).
  const maxLen = Math.max(na.length, nb.length);
  let same = 0; for (let i = 0; i < Math.min(na.length, nb.length); i++) if (na[i] === nb[i]) same++;
  const charScore = same / maxLen;
  return Math.max(tokenScore, charScore * 0.85);
}

/**
 * Score open estimates against extracted PO data.
 * @param {object} po  extracted PO { clientName, poNumber, lineItems[] }
 * @param {Array} estimates  each { id, estimateNumber, clientName, clientPurchaseOrderNumber, status, parts:[{materialDescription, quantity, formData}] }
 * @returns {Array} ranked candidates [{ estimateId, estimateNumber, clientName, status, score, reasons[] }]
 */
function matchEstimates(po, estimates) {
  const poItems = Array.isArray(po.lineItems) ? po.lineItems : [];
  // Precompute the PO's numeric fingerprint (all dims/diameters across all line items).
  const poNums = new Set();
  for (const li of poItems) {
    for (const t of numTokens([li.description, li.dimensions, li.diameter].filter(Boolean).join(' '))) poNums.add(t);
  }
  const poPo = normText(po.poNumber);

  const scored = estimates.map(est => {
    const reasons = [];
    let score = 0;

    // 1) Client name similarity (fuzzy — tolerates the Howell/Nowell OCR slip).
    const nameSim = nameSimilarity(po.clientName, est.clientName);
    if (nameSim >= 0.6) {
      score += nameSim * 40;
      reasons.push(nameSim >= 0.9 ? `Client matches (${est.clientName})` : `Client likely matches (${est.clientName})`);
    }

    // 2) Exact client PO number match, when the estimate happens to have one stored (rare early on,
    //    strong signal when present).
    if (poPo && normText(est.clientPurchaseOrderNumber) && normText(est.clientPurchaseOrderNumber) === poPo) {
      score += 40;
      reasons.push(`PO number matches (${po.poNumber})`);
    }

    // 3) Part-content overlap: how many of the PO's numeric tokens (dims/diameters) appear in this
    //    estimate's parts. This is the workhorse when there's no PO/SO number to key on.
    const estNums = new Set();
    for (const p of (est.parts || [])) {
      for (const t of numTokens([p.materialDescription, JSON.stringify(p.formData || {})].join(' '))) estNums.add(t);
    }
    let overlap = 0;
    for (const t of poNums) if (estNums.has(t)) overlap++;
    if (poNums.size > 0 && overlap > 0) {
      const frac = overlap / poNums.size;
      score += frac * 40;
      reasons.push(`${overlap} of ${poNums.size} dimensions match`);
    }

    // 4) Part-count agreement (soft signal).
    if (poItems.length && (est.parts || []).length) {
      if (poItems.length === est.parts.length) { score += 5; reasons.push(`Same number of items (${poItems.length})`); }
    }

    return {
      estimateId: est.id,
      estimateNumber: est.estimateNumber,
      clientName: est.clientName,
      status: est.status,
      score: Math.round(score),
      reasons,
    };
  })
  .filter(c => c.score >= 20)         // drop weak noise
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);

  return scored;
}
