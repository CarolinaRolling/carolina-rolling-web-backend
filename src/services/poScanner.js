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

module.exports = { extractPurchaseOrder };
