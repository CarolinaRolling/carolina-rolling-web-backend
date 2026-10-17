// ============= INBOUND ROUTES =============
// Clean routes that delegate to service

const express = require('express');
const router = express.Router();
const multer = require('multer');
const poUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Service will be injected
let inboundService = null;

// Middleware to ensure service is available
const ensureService = (req, res, next) => {
  if (!inboundService) {
    const models = require('../models');
    const { InboundOrderService } = require('../services');
    inboundService = new InboundOrderService(models);
  }
  next();
};

router.use(ensureService);

// GET all inbound orders
router.get('/', async (req, res, next) => {
  try {
    const orders = await inboundService.getAll(req.query);
    res.json({
      data: orders,
      total: orders.length
    });
  } catch (error) {
    console.error('Error fetching inbound orders:', error);
    next(error);
  }
});

// GET single inbound order by ID
router.get('/:id', async (req, res, next) => {
  try {
    const order = await inboundService.getById(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: { message: 'Inbound order not found' } });
    }
    
    res.json({ data: order });
  } catch (error) {
    console.error('Error fetching inbound order:', error);
    next(error);
  }
});

// POST create new inbound order
router.post('/', async (req, res, next) => {
  try {
    const order = await inboundService.create(req.body);
    res.status(201).json({ data: order });
  } catch (error) {
    console.error('Error creating inbound order:', error);
    if (error.message.includes('Missing required')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    next(error);
  }
});

// PUT update inbound order
router.put('/:id', async (req, res, next) => {
  try {
    const order = await inboundService.update(req.params.id, req.body);
    res.json({ data: order });
  } catch (error) {
    console.error('Error updating inbound order:', error);
    if (error.message === 'Inbound order not found') {
      return res.status(404).json({ error: { message: error.message } });
    }
    if (error.status && error.status < 500) return res.status(error.status).json({ error: { message: error.message, code: error.code } });
    next(error);
  }
});

// PUT update status
router.put('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: { message: 'status is required' } });
    // un-receiving is admin only (U8)
    const { isAdminCaller } = require('../services/staffRoles');
    const order = await inboundService.updateStatus(req.params.id, status, { isAdmin: isAdminCaller(req) });
    res.json({ data: order });
  } catch (error) {
    console.error('Error updating inbound order status:', error);
    if (error.message === 'Inbound order not found') {
      return res.status(404).json({ error: { message: error.message } });
    }
    if (error.status && error.status < 500) return res.status(error.status).json({ error: { message: error.message, code: error.code } });
    next(error);
  }
});

// PUT mark as received
router.put('/:id/receive', async (req, res, next) => {
  try {
    const { receivedBy } = req.body;
    const order = await inboundService.markReceived(req.params.id, receivedBy);
    res.json({ data: order, message: 'Marked as received' });
  } catch (error) {
    console.error('Error marking inbound order as received:', error);
    if (error.message === 'Inbound order not found') {
      return res.status(404).json({ error: { message: error.message } });
    }
    if (error.status && error.status < 500) return res.status(error.status).json({ error: { message: error.message, code: error.code } });
    next(error);
  }
});

// DELETE inbound order
router.delete('/:id', async (req, res, next) => {
  try {
    // A received delivery is the receiving record its PO relies on — admin only (round 13, R21)
    const { isAdminCaller } = require('../services/staffRoles');
    const result = await inboundService.delete(req.params.id, { isAdmin: isAdminCaller(req) });
    res.json(result);
  } catch (error) {
    console.error('Error deleting inbound order:', error);
    if (error.message === 'Inbound order not found') {
      return res.status(404).json({ error: { message: error.message } });
    }
    if (error.status && error.status < 500) return res.status(error.status).json({ error: { message: error.message, code: error.code } });
    next(error);
  }
});

// POST convert a delivery into a received shipment — one transaction on the server (round 13, R21);
// the shipment goes on the delivery's work order when it has one. Replaces the web app's
// create-shipment-then-delete-delivery pair of calls.
router.post('/:id/convert-to-shipment', async (req, res, next) => {
  try {
    const { isAdminCaller } = require('../services/staffRoles');
    const receivedBy = (req.body && req.body.receivedBy) || (req.user && (req.user.username || req.user.name)) || null;
    // a received delivery converts again only for an admin who sends force: true (U36)
    const shipment = await inboundService.convertToShipment(req.params.id, { isAdmin: isAdminCaller(req), receivedBy, force: !!(req.body && req.body.force === true) });
    res.status(201).json({ data: shipment, message: 'Converted to shipment' });
  } catch (error) {
    console.error('Error converting inbound order to shipment:', error);
    if (error.message === 'Inbound order not found') {
      return res.status(404).json({ error: { message: error.message } });
    }
    if (error.status && error.status < 500) return res.status(error.status).json({ error: { message: error.message, code: error.code } });
    next(error);
  }
});

// POST /api/inbound/scan-po - Stage 1: extract structured data from an uploaded customer PO
// (PDF or photo) using a vision model, and return it for the employee to review. Does NOT create
// anything — extraction only. (Matching to estimates + discrepancy flagging come in later stages.)
router.post('/scan-po', poUpload.single('po'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: { message: 'No file uploaded' } });
    }
    const { extractPurchaseOrder, matchEstimates } = require('../services/poScanner');
    const result = await extractPurchaseOrder(req.file.buffer, req.file.mimetype);
    if (result.error) {
      const msgs = {
        no_api_key: 'AI extraction is not configured (missing API key).',
        empty_file: 'The uploaded file was empty.',
        unsupported_type: 'Unsupported file type — upload a PDF or an image (JPG/PNG).',
        empty_response: 'The AI could not read anything from this file — try a clearer scan/photo.',
        extract_failed: 'Could not read the purchase order — try a clearer scan/photo.',
        api_error: 'AI extraction failed — please try again.',
      };
      return res.status(422).json({ error: { message: msgs[result.error] || 'Could not read the purchase order.', code: result.error } });
    }

    // Stage 2: match against open estimates (draft/sent — the ones awaiting an order).
    let matches = [];
    try {
      const { Estimate, EstimatePart } = require('../models');
      const { Op } = require('sequelize');
      const estimates = await Estimate.findAll({
        where: { status: { [Op.in]: ['draft', 'sent', 'accepted'] } },
        attributes: ['id', 'estimateNumber', 'clientName', 'clientPurchaseOrderNumber', 'status'],
        include: [{ model: EstimatePart, as: 'parts', attributes: ['materialDescription', 'quantity', 'formData'] }],
        order: [['createdAt', 'DESC']],
        limit: 400,
      });
      matches = matchEstimates(result, estimates.map(e => e.toJSON()));
    } catch (e) {
      console.warn('[scan-po] estimate matching failed:', e.message);
    }

    res.json({ data: result, matches, fileName: req.file.originalname, mimeType: req.file.mimetype });
  } catch (error) { next(error); }
});

module.exports = router;
