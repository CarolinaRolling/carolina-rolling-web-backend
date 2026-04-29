// ============= INBOUND ROUTES =============
// Clean routes that delegate to service

const express = require('express');
const router = express.Router();

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
    next(error);
  }
});

// PUT update status
router.put('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const order = await inboundService.updateStatus(req.params.id, status);
    res.json({ data: order });
  } catch (error) {
    console.error('Error updating inbound order status:', error);
    if (error.message === 'Inbound order not found') {
      return res.status(404).json({ error: { message: error.message } });
    }
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
    next(error);
  }
});

// DELETE inbound order
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await inboundService.delete(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error deleting inbound order:', error);
    if (error.message === 'Inbound order not found') {
      return res.status(404).json({ error: { message: error.message } });
    }
    next(error);
  }
});

module.exports = router;
