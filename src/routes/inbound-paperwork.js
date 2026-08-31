// ============================================================================
// INBOUND PAPERWORK (Phase 1) — AI scan intake + review queue
// A scanned document is uploaded, AI classifies it (estimate / purchase_order /
// delivery_form), attempts a match, and recommends an action. Nothing auto-files;
// an employee confirms each item in the Review Center "Inbound Paperwork" tab.
// Phase 1 intake = manual upload button. NAS hot-folder + filing round-trip = Phase 2.
// ============================================================================
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Op } = require('sequelize');
const fileStorage = require('../utils/storage');
const {
  InboundPaperwork, Client, Estimate, WorkOrder, InboundOrder, sequelize
} = require('../models');

const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ---- Client matching (mirrors the convert-to-estimate matcher; never creates a client) ----
async function matchClientByName(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n || n.length < 3) return null;
  const clients = await Client.findAll();
  // exact, then contains-either-way on the company name
  for (const c of clients) if ((c.name || '').trim().toLowerCase() === n) return c;
  for (const c of clients) {
    const cn = (c.name || '').trim().toLowerCase();
    if (cn && cn.length >= 3 && (n.includes(cn) || cn.includes(n))) return c;
  }
  return null;
}

// ---- The AI classifier + parser. Reads one scanned doc, returns type + fields. ----
async function classifyDocument(fileBufferBase64, mimeType, originalName) {
  const { getParsingModel } = require('../services/aiConfig');
  const isPdf = (mimeType || '').includes('pdf') || /\.pdf$/i.test(originalName || '');
  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBufferBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: (mimeType || 'image/jpeg'), data: fileBufferBase64 } };

  const systemPrompt = `You classify a single scanned business document for a steel rolling & fabrication shop and extract key identifying fields. The document is exactly ONE of these three types:
- "estimate": a request for quote (RFQ) or an estimate/quote for parts to be made.
- "purchase_order": a purchase order from a CLIENT ordering work from the shop.
- "delivery_form": a packing slip / delivery ticket / bill of lading — EITHER material the shop ORDERED from a supplier, OR material a CLIENT sent in for the shop to work on.

Read the document and respond ONLY with valid JSON (no markdown, no backticks):
{
  "docType": "estimate" | "purchase_order" | "delivery_form" | "unknown",
  "confidence": "high" | "low",
  "clientName": "the client/company this pertains to, best guess, or null",
  "supplierName": "for a supplier delivery, the supplier's name, or null",
  "poNumber": "any purchase order number visible (OUR PO to a supplier, or the client's PO), or null",
  "deliverySubtype": "for delivery_form only: 'supplier' (material we ordered) or 'client_material' (client sent it in) or null",
  "summary": "one short sentence describing what this document is",
  "keyFields": { "anyOtherUsefulLabeledValues": "here" }
}

RULES:
- Pick the single best docType. Use "unknown" only if you truly cannot tell.
- "confidence" is "high" only when the type is obvious and the key identifier (PO number or client name) is clearly legible. Handwritten/blurry/ambiguous -> "low".
- Do NOT invent a PO number or client name. If it's not clearly there, use null.
- For delivery_form, decide supplier vs client_material from context (a supplier's letterhead/packing slip = supplier; a client shipping their own material to the shop = client_material).`;

  const requestBody = JSON.stringify({
    model: getParsingModel(),
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: [ fileBlock, { type: 'text', text: `Filename: "${originalName || 'scan'}". Classify and extract.` } ] }]
  });

  const responseText = await new Promise((resolve, reject) => {
    const apiReq = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          let msg = `AI API error ${apiRes.statusCode}`;
          try { const e = JSON.parse(data); if (e.error?.message) msg = `AI API error: ${e.error.message}`; } catch {}
          reject(new Error(msg));
        } else resolve(data);
      });
    });
    apiReq.on('error', reject);
    apiReq.write(requestBody); apiReq.end();
  });

  const body = JSON.parse(responseText);
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI did not return JSON');
  return JSON.parse(jsonMatch[0]);
}

// ---- Given a classification, work out the best match + recommended action. ----
async function buildRecommendation(parsed) {
  const out = {
    clientId: null, clientName: parsed.clientName || null,
    poNumber: parsed.poNumber || null,
    matchedWorkOrderId: null, matchedEstimateId: null, matchedInboundOrderId: null,
    recommendedAction: 'unknown', recommendationNote: ''
  };

  // Resolve a client (best guess) for filing + matching.
  const client = await matchClientByName(parsed.clientName || parsed.supplierName);
  if (client) { out.clientId = client.id; out.clientName = client.name; }

  if (parsed.docType === 'estimate') {
    out.recommendedAction = 'create_estimate';
    out.recommendationNote = client
      ? `Create a draft estimate for ${client.name}.`
      : `Create a draft estimate${parsed.clientName ? ' for ' + parsed.clientName : ''} (no client match — you'll pick/create one).`;
    return out;
  }

  if (parsed.docType === 'purchase_order') {
    out.recommendedAction = 'create_pending_order';
    out.recommendationNote = client
      ? `Client PO from ${client.name}${parsed.poNumber ? ' (PO ' + parsed.poNumber + ')' : ''} — create a pending order.`
      : `Client PO${parsed.poNumber ? ' ' + parsed.poNumber : ''} — no client match; needs review.`;
    return out;
  }

  if (parsed.docType === 'delivery_form') {
    // Supplier delivery: try to match our PO to a pending inbound order.
    if (parsed.poNumber) {
      const inbound = await InboundOrder.findOne({
        where: {
          purchaseOrderNumber: parsed.poNumber,
          status: { [Op.or]: [null, 'pending'] }
        }
      });
      if (inbound && inbound.workOrderId) {
        out.matchedInboundOrderId = inbound.id;
        out.matchedWorkOrderId = inbound.workOrderId;
        out.recommendedAction = 'receive_supplier_material';
        out.recommendationNote = `Supplier delivery matches inbound PO ${parsed.poNumber} — receive material for its work order.`;
        return out;
      }
    }
    // Client material or unmatched supplier slip: attach to a known order if we can find one by client,
    // otherwise flag needs-instructions.
    if (client) {
      // Is there an open WO for this client we could attach to? (best-guess; employee confirms)
      const openWo = await WorkOrder.findOne({
        where: { clientName: client.name, status: { [Op.notIn]: ['shipped', 'archived'] } },
        order: [['createdAt', 'DESC']]
      });
      if (openWo) {
        out.matchedWorkOrderId = openWo.id;
        out.recommendedAction = 'attach_to_order';
        out.recommendationNote = `Delivery for ${client.name} — looks related to ${openWo.drNumber ? 'DR-' + openWo.drNumber : openWo.orderNumber}. Attach it there (confirm the order).`;
        return out;
      }
    }
    out.recommendedAction = 'needs_instructions';
    out.recommendationNote = client
      ? `Material for ${client.name} but no matching order — needs instructions.`
      : `Delivery with no clear client/order match — needs instructions.`;
    return out;
  }

  out.recommendedAction = 'unknown';
  out.recommendationNote = 'Could not classify — please review.';
  return out;
}

// ---- Background: classify + recommend for a queued item. ----
async function processPaperwork(item, filePath, mimeType) {
  await item.update({ status: 'processing', attempts: (item.attempts || 0) + 1 });
  try {
    const base64 = fs.readFileSync(filePath).toString('base64');
    const parsed = await classifyDocument(base64, mimeType, item.originalName);
    const rec = await buildRecommendation(parsed);
    await item.update({
      status: 'needs_review',
      docType: parsed.docType || 'unknown',
      classifyConfidence: parsed.confidence || 'low',
      parsedData: parsed,
      aiSummary: parsed.summary || '',
      recommendedAction: rec.recommendedAction,
      recommendationNote: rec.recommendationNote,
      clientId: rec.clientId, clientName: rec.clientName,
      matchedWorkOrderId: rec.matchedWorkOrderId,
      matchedEstimateId: rec.matchedEstimateId,
      matchedInboundOrderId: rec.matchedInboundOrderId,
      poNumber: rec.poNumber
    });
  } catch (e) {
    await item.update({ status: 'error', errorMessage: e.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// ==================== ROUTES ====================

// POST /api/inbound-paperwork — upload a scan (Phase 1 manual intake).
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: { message: 'ANTHROPIC_API_KEY not configured' } });
    if (!req.file) return res.status(400).json({ error: { message: 'No file uploaded' } });

    // Store a permanent copy so the review card can show the scan.
    let stored = { url: null, storageId: null };
    try {
      stored = await fileStorage.uploadFile(req.file.path, {
        folder: 'inbound-paperwork',
        originalName: req.file.originalname,
        mimeType: req.file.mimetype
      });
    } catch (e) { console.warn('[InboundPaperwork] store copy failed:', e.message); }

    const item = await InboundPaperwork.create({
      originalName: req.file.originalname,
      fileUrl: stored.url,
      storageId: stored.storageId,
      mimeType: req.file.mimetype,
      status: 'queued'
    });

    res.status(202).json({ data: item, message: 'Uploaded — classifying' });

    // Classify in the background (uses a re-read of the temp file, then deletes it).
    processPaperwork(item, req.file.path, req.file.mimetype);
  } catch (error) {
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
    next(error);
  }
});

// GET /api/inbound-paperwork — list queue items (most recent first) + status counts.
router.get('/', async (req, res, next) => {
  try {
    const items = await InboundPaperwork.findAll({ order: [['createdAt', 'DESC']], limit: 200 });
    const counts = {};
    items.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
    res.json({ data: items, counts });
  } catch (error) { next(error); }
});

// POST /api/inbound-paperwork/:id/confirm — employee confirms the (possibly edited) action.
// Body may override: { action, clientId, workOrderId, inboundOrderId }.
router.post('/:id/confirm', async (req, res, next) => {
  try {
    const item = await InboundPaperwork.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Item not found' } });
    const action = (req.body && req.body.action) || item.recommendedAction;
    const clientId = (req.body && req.body.clientId) || item.clientId;
    const workOrderId = (req.body && req.body.workOrderId) || item.matchedWorkOrderId;
    const inboundOrderId = (req.body && req.body.inboundOrderId) || item.matchedInboundOrderId;

    let resultRef = null;

    if (action === 'receive_supplier_material') {
      // Mark the inbound order received + flip its WO out of waiting_for_materials, and attach the scan.
      if (inboundOrderId) {
        const inbound = await InboundOrder.findByPk(inboundOrderId);
        if (inbound) {
          await inbound.update({ status: 'received', receivedAt: new Date() });
          if (inbound.workOrderId) {
            const { WorkOrderPart } = require('../models');
            await WorkOrderPart.update({ materialReceived: true, materialReceivedAt: new Date() }, { where: { workOrderId: inbound.workOrderId, materialOrdered: true } });
            const wo = await WorkOrder.findByPk(inbound.workOrderId);
            if (wo && wo.status === 'waiting_for_materials') await wo.update({ status: 'received', allMaterialReceived: true });
            resultRef = wo ? (wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber) : null;
          }
        }
      }
      await attachScanToWorkOrder(item, workOrderId);
    } else if (action === 'attach_to_order') {
      await attachScanToWorkOrder(item, workOrderId);
      const wo = workOrderId ? await WorkOrder.findByPk(workOrderId) : null;
      resultRef = wo ? (wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber) : null;
    } else if (action === 'needs_instructions') {
      // Nothing to create; this simply records the decision. The scan stays attached to the queue item
      // (and, in Phase 2, gets filed under the client's "needs instructions" area on the NAS).
      resultRef = item.clientName || 'unassigned';
    } else if (action === 'create_estimate' || action === 'create_pending_order') {
      // Phase 1: record intent + point the user to the existing flow. (Full auto-create via the existing
      // estimate/PO parsers is a fast follow — kept explicit here so nothing is created without review.)
      resultRef = 'manual';
    }

    // Compute the NAS filing destination: Type / Client / Year / Month. The NAS watcher polls for this
    // and moves the physical scan there (Phase 2). Client falls back to _Unidentified.
    let destClientName = item.clientName;
    if (!destClientName && clientId) { try { const c = await Client.findByPk(clientId); destClientName = c?.name || null; } catch {} }
    const nasDestination = computeNasDestination(item.docType, destClientName, item.createdAt);

    await item.update({ status: 'confirmed', resolvedAction: action, resultRef, clientId, matchedWorkOrderId: workOrderId, matchedInboundOrderId: inboundOrderId, nasDestination, errorMessage: null });
    res.json({ data: item, message: 'Confirmed' });
  } catch (error) { next(error); }
});

// Build "Type / Client / Year / Month" for NAS filing. Sanitizes each segment for a filesystem path.
function computeNasDestination(docType, clientName, createdAt) {
  const typeFolder = { estimate: 'Estimates', purchase_order: 'Purchase Orders', delivery_form: 'Delivery Forms' }[docType] || 'Other';
  const safe = (s) => String(s || '').replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  const client = safe(clientName) || '_Unidentified';
  const d = createdAt ? new Date(createdAt) : new Date();
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${typeFolder}/${client}/${year}/${month}`;
}

// Attach the stored scan to a work order's documents.
async function attachScanToWorkOrder(item, workOrderId) {
  if (!workOrderId || !item.fileUrl) return;
  try {
    const { WorkOrderDocument } = require('../models');
    await WorkOrderDocument.create({
      workOrderId,
      originalName: item.originalName || 'scan.pdf',
      mimeType: item.mimeType || 'application/pdf',
      url: item.fileUrl,
      cloudinaryId: item.storageId,
      documentType: 'delivery_form'
    });
  } catch (e) { console.warn('[InboundPaperwork] attach to WO failed:', e.message); }
}

// POST /api/inbound-paperwork/:id/reclassify — employee corrects the type; re-runs recommendation.
router.post('/:id/reclassify', async (req, res, next) => {
  try {
    const item = await InboundPaperwork.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Item not found' } });
    const docType = req.body && req.body.docType;
    if (!docType) return res.status(400).json({ error: { message: 'docType required' } });
    const parsed = { ...(item.parsedData || {}), docType };
    const rec = await buildRecommendation(parsed);
    await item.update({
      docType, parsedData: parsed, status: 'needs_review',
      recommendedAction: rec.recommendedAction, recommendationNote: rec.recommendationNote,
      clientId: rec.clientId, clientName: rec.clientName,
      matchedWorkOrderId: rec.matchedWorkOrderId, matchedInboundOrderId: rec.matchedInboundOrderId, poNumber: rec.poNumber
    });
    res.json({ data: item });
  } catch (error) { next(error); }
});

// DELETE /api/inbound-paperwork/:id — dismiss an item.
router.delete('/:id', async (req, res, next) => {
  try {
    await InboundPaperwork.destroy({ where: { id: req.params.id } });
    res.json({ data: { ok: true } });
  } catch (error) { next(error); }
});

// ==================== NAS FILING ROUND-TRIP (Phase 2) ====================
// The NAS watcher uploads scans (POST /), holds each file locally keyed by the returned item id, then
// polls pending-filing for confirmed items that have a destination, moves the file there, and reports back.

// GET /api/inbound-paperwork/nas/pending-filing — confirmed items with a destination not yet filed.
router.get('/nas/pending-filing', async (req, res, next) => {
  try {
    const items = await InboundPaperwork.findAll({
      where: { status: 'confirmed', nasDestination: { [Op.ne]: null } },
      order: [['updatedAt', 'ASC']], limit: 100
    });
    res.json({ data: items.map(i => ({ id: i.id, originalName: i.originalName, nasDestination: i.nasDestination, docType: i.docType, clientName: i.clientName })) });
  } catch (error) { next(error); }
});

// POST /api/inbound-paperwork/:id/nas-filed — the watcher reports it moved the file into place.
// Body: { filedPath } (optional, the final path on the NAS).
router.post('/:id/nas-filed', async (req, res, next) => {
  try {
    const item = await InboundPaperwork.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Item not found' } });
    await item.update({ status: 'filed', nasProcessingRef: (req.body && req.body.filedPath) || item.nasProcessingRef });
    res.json({ data: { ok: true } });
  } catch (error) { next(error); }
});

module.exports = router;
