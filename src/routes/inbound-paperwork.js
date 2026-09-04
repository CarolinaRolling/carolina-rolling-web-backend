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
    const raw = fs.readFileSync(filePath);
    // Diagnostic + guard: confirm the backend actually received a valid file before sending it to the AI.
    const looksPdf = /\.pdf$/i.test(item.originalName || '') || (mimeType || '').includes('pdf');
    if (raw.length === 0) throw new Error('The uploaded scan was empty (0 bytes) — the upload may have been truncated.');
    if (looksPdf) {
      const head = raw.slice(0, 5).toString('latin1');
      if (head !== '%PDF-') {
        throw new Error(`The uploaded file isn't a valid PDF (starts with "${head.replace(/[^\x20-\x7e]/g, '?')}", size ${raw.length}). The scan may have been corrupted in transit — try re-scanning.`);
      }
    }
    const base64 = raw.toString('base64');
    // Guard against the Anthropic ~32MB request cap (base64 inflates ~33%).
    if (base64.length > 28 * 1024 * 1024) {
      const mb = (base64.length / 1024 / 1024).toFixed(1);
      throw new Error(`This scan is too large for the AI (about ${mb}MB after encoding; limit ~28MB) — usually high-resolution photos. Scan at lower quality (150–200 DPI) or reduce the file size, then re-scan.`);
    }
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

    // Sanitize + cap the original name. Scanner/watcher leftovers can produce absurdly long or odd names
    // (e.g. chained UUIDs) that could blow past column limits or upset the storage key — never let that 500.
    const rawName = req.file.originalname || 'scan.pdf';
    const ext = path.extname(rawName) || '.pdf';
    let safeName = path.basename(rawName, ext).replace(/[^\w.\- ]/g, '').slice(0, 120).trim() || 'scan';
    safeName = `${safeName}${ext}`;

    // Store a permanent copy so the review card can show the scan.
    let stored = { url: null, storageId: null };
    try {
      stored = await fileStorage.uploadFile(req.file.path, {
        folder: 'inbound-paperwork',
        originalName: safeName,
        mimeType: req.file.mimetype
      });
    } catch (e) { console.warn('[InboundPaperwork] store copy failed:', e.message); }

    let item;
    try {
      item = await InboundPaperwork.create({
        originalName: safeName,
        fileUrl: stored.url,
        storageId: stored.storageId,
        mimeType: req.file.mimetype,
        status: 'queued'
      });
    } catch (e) {
      console.error('[InboundPaperwork] create failed:', e.message);
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: { message: 'Could not queue this scan: ' + e.message } });
    }

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
      let woForCheck = null;
      if (inboundOrderId) {
        const inbound = await InboundOrder.findByPk(inboundOrderId);
        if (inbound) {
          await inbound.update({ status: 'received', receivedAt: new Date() });
          if (inbound.workOrderId) {
            const { WorkOrderPart } = require('../models');
            await WorkOrderPart.update({ materialReceived: true, materialReceivedAt: new Date() }, { where: { workOrderId: inbound.workOrderId, materialOrdered: true } });
            const wo = await WorkOrder.findByPk(inbound.workOrderId);
            woForCheck = wo;
            if (wo && wo.status === 'waiting_for_materials') await wo.update({ status: 'received', allMaterialReceived: true });
            resultRef = wo ? (wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber) : null;
          }
        }
      }
      await attachScanToWorkOrder(item, workOrderId);
      // Did the dock employee actually register a shipment for this work order? If NOT, the office is
      // receiving off the paper alone — flag it so they can ask the receiving employee to receive it.
      if (woForCheck) {
        try {
          const { Shipment } = require('../models');
          const shipCount = await Shipment.count({ where: { workOrderId: woForCheck.id } });
          if (shipCount === 0) {
            // Park on a follow-up state instead of fully done, so the office sees the open task.
            await item.update({ status: 'awaiting_dock_receive', resolvedAction: 'receive_supplier_material', resultRef, clientId, matchedWorkOrderId: workOrderId, matchedInboundOrderId: inboundOrderId, recommendationNote: `Received from the scan, but no shipment was registered on the dock for ${resultRef || 'this order'}. Ask receiving to register/receive the shipment, then clear this.`, errorMessage: null });
            return res.json({ data: await InboundPaperwork.findByPk(item.id), message: 'Received — but no dock shipment; flagged for follow-up' });
          }
        } catch (e) { /* if the check fails, don't block the receive */ }
      }
    } else if (action === 'attach_to_order') {
      await attachScanToWorkOrder(item, workOrderId);
      const wo = workOrderId ? await WorkOrder.findByPk(workOrderId) : null;
      resultRef = wo ? (wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber) : null;
    } else if (action === 'needs_instructions') {
      // Material physically arrived but there's no order telling the shop what to do with it. Create an
      // UNLINKED shipment (workOrderId null) so it shows up in the "Waiting for Instructions" list where
      // it gets assigned to a job — same as a walk-in delivery the office logs manually.
      const { Shipment } = require('../models');
      const parsed = item.parsedData || {};
      const qrCode = `SHIP-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
      const ship = await Shipment.create({
        qrCode,
        clientName: item.clientName || parsed.clientName || parsed.supplierName || 'Unknown',
        clientPurchaseOrderNumber: item.poNumber || parsed.poNumber || null,
        description: parsed.summary || item.aiSummary || item.originalName || 'Scanned delivery',
        quantity: 1,
        notes: `Created from scanned delivery paperwork (${item.originalName || 'scan'}).`,
        receivedAt: new Date(),
        workOrderId: null
      });
      // Attach the scan image to the shipment so the office can see the paperwork.
      if (item.fileUrl) {
        try {
          const { ShipmentDocument } = require('../models');
          if (ShipmentDocument) await ShipmentDocument.create({ shipmentId: ship.id, filename: item.originalName || 'scan.pdf', originalName: item.originalName || 'scan.pdf', mimeType: item.mimeType || 'application/pdf', url: item.fileUrl, cloudinaryId: item.storageId });
        } catch (e) { /* shipment doc attach is best-effort */ }
      }
      resultRef = ship.qrCode;
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

// POST /api/inbound-paperwork/:id/clear-dock-receive — office confirms the shipment is now received.
router.post('/:id/clear-dock-receive', async (req, res, next) => {
  try {
    const item = await InboundPaperwork.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Item not found' } });
    // Compute the filing destination now that it's fully done.
    let destClientName = item.clientName;
    const nasDestination = computeNasDestination(item.docType, destClientName, item.createdAt);
    await item.update({ status: 'confirmed', recommendationNote: null, nasDestination });
    res.json({ data: item, message: 'Cleared' });
  } catch (error) { next(error); }
});

// POST /api/inbound-paperwork/:id/convert-to-estimate — turn a scanned RFQ/estimate into a draft estimate.
// Resolves a client first (matched or provided via body.clientId). If none, returns 409 NO_CLIENT so the
// UI can prompt (mirrors the Comm Center convert). On success, runs the estimate AI parser on the scan.
router.post('/:id/convert-to-estimate', async (req, res, next) => {
  try {
    const item = await InboundPaperwork.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Item not found' } });

    // Resolve client.
    let client = null;
    if (req.body && req.body.clientId) client = await Client.findByPk(req.body.clientId);
    if (!client && item.clientId) client = await Client.findByPk(item.clientId);
    if (!client && item.clientName) client = await matchClientByName(item.clientName);
    if (!client) {
      return res.status(409).json({
        error: { code: 'NO_CLIENT', message: 'No matching client. Pick or create one, then convert.' },
        data: { clientName: item.clientName, docType: item.docType }
      });
    }

    // Get the scan bytes back from storage and hand them to the shared convert helper.
    let buffer;
    try { buffer = await fileStorage.downloadToBuffer(item.storageId, item.fileUrl); }
    catch (e) { return res.status(400).json({ error: { message: 'Could not read the scan file: ' + e.message } }); }

    const scannedLike = { id: null, fromName: '', fromEmail: '', subject: item.originalName || 'Scanned RFQ', gmailLink: null, contacts: client.contacts };
    const attachments = [{ originalName: item.originalName || 'scan.pdf', buffer }];
    const estimatesRouter = require('./estimates');
    const { estimate, jobId, error: convertErr } = await estimatesRouter.createEstimateAndParseAttachments(client, scannedLike, attachments, '');

    if (!estimate) {
      // Parse failed / no parts — nothing created (rolled back). Leave the paperwork item in review so it
      // can be retried, and surface why.
      await item.update({ status: 'needs_review', errorMessage: convertErr || 'AI parse failed' });
      return res.status(422).json({ error: { message: convertErr || 'Could not convert this scan to an estimate.' } });
    }

    // Mark the paperwork item done + point it at the new estimate. Compute filing destination.
    const nasDestination = computeNasDestination(item.docType, client.name, item.createdAt);
    await item.update({ status: 'confirmed', resolvedAction: 'converted_to_estimate', resultRef: estimate.estimateNumber, clientId: client.id, clientName: client.name, matchedEstimateId: estimate.id, nasDestination });

    res.status(202).json({ data: { estimateId: estimate.id, estimateNumber: estimate.estimateNumber, jobId, clientName: client.name }, message: 'Estimate created' });
  } catch (error) { next(error); }
});

// POST /api/inbound-paperwork/:id/convert-to-order — turn a scanned client PO into a Pending Order.
// Resolves a client first (409 NO_CLIENT if none, like the estimate convert), tries to auto-match an
// existing estimate by PO#/reference, and creates a PendingOrder that flows into the Review Center Orders tab.
router.post('/:id/convert-to-order', async (req, res, next) => {
  try {
    const item = await InboundPaperwork.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Item not found' } });

    // Resolve client.
    let client = null;
    if (req.body && req.body.clientId) client = await Client.findByPk(req.body.clientId);
    if (!client && item.clientId) client = await Client.findByPk(item.clientId);
    if (!client && item.clientName) client = await matchClientByName(item.clientName);
    if (!client) {
      return res.status(409).json({
        error: { code: 'NO_CLIENT', message: 'No matching client. Pick or create one, then convert.' },
        data: { clientName: item.clientName, docType: item.docType }
      });
    }

    const parsed = item.parsedData || {};
    const poNumber = item.poNumber || parsed.poNumber || null;
    const referenceNumber = parsed.referenceNumber || parsed.referencesQuote || null;

    // Don't create a duplicate pending order for the same PO + client.
    const { PendingOrder } = require('../models');
    if (poNumber) {
      const dup = await PendingOrder.findOne({ where: { poNumber, clientId: client.id, status: 'pending' } });
      if (dup) {
        await item.update({ status: 'confirmed', resolvedAction: 'converted_to_order', resultRef: poNumber, clientId: client.id, clientName: client.name, nasDestination: computeNasDestination(item.docType, client.name, item.createdAt) });
        return res.json({ data: { pendingOrderId: dup.id, poNumber, duplicate: true }, message: 'A pending order for this PO already exists' });
      }
    }

    // Try to auto-match an existing estimate by PO#/reference for this client.
    let matchedEstimate = null;
    const tryMatch = async (num) => {
      if (!num || matchedEstimate) return;
      matchedEstimate = await Estimate.findOne({
        where: { clientId: client.id, [Op.or]: [ { estimateNumber: num }, { estimateNumber: { [Op.iLike]: `%${num}%` } } ] }
      });
    };
    await tryMatch(referenceNumber);
    await tryMatch(poNumber);

    const pending = await PendingOrder.create({
      clientId: client.id,
      clientName: client.name,
      poNumber: poNumber,
      referenceNumber: referenceNumber,
      matchedEstimateId: matchedEstimate?.id || null,
      matchedEstimateNumber: matchedEstimate?.estimateNumber || null,
      subject: item.originalName || 'Scanned PO',
      parsedData: parsed,
      status: 'pending'
    });

    // Attach the scan to the pending order? PendingOrder has no doc store; the scan stays on the paperwork
    // item and gets filed to the archive. Mark the item done + compute filing destination.
    const nasDestination = computeNasDestination(item.docType, client.name, item.createdAt);
    await item.update({ status: 'confirmed', resolvedAction: 'converted_to_order', resultRef: poNumber || 'PO', clientId: client.id, clientName: client.name, matchedEstimateId: matchedEstimate?.id || null, nasDestination });

    res.status(201).json({ data: { pendingOrderId: pending.id, poNumber, matchedEstimateNumber: matchedEstimate?.estimateNumber || null, clientName: client.name }, message: 'Pending order created' });
  } catch (error) { next(error); }
});

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

// POST /api/inbound-paperwork/dismiss-all — clear items in the review list (not yet confirmed/filed).
// Body: { status } optional to target a specific status; default clears the active review states.
router.post('/dismiss-all', async (req, res, next) => {
  try {
    const status = req.body && req.body.status;
    const where = status ? { status } : { status: { [Op.in]: ['needs_review', 'queued', 'processing', 'error'] } };
    const n = await InboundPaperwork.destroy({ where });
    res.json({ data: { dismissed: n } });
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
