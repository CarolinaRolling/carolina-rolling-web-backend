// ============= PO NUMBERS ROUTES =============
// Clean routes that delegate to service

const express = require('express');
const router = express.Router();

// Service will be injected
let poService = null;

// Middleware to ensure service is available
const ensureService = (req, res, next) => {
  if (!poService) {
    const models = require('../models');
    const { PONumberService } = require('../services');
    poService = new PONumberService(models);
  }
  next();
};

router.use(ensureService);

// GET /api/po-numbers - Get all PO numbers
router.get('/', async (req, res, next) => {
  try {
    const result = await poService.getAll(req.query);
    res.json({
      data: result.rows,
      total: result.count
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/po-numbers/next - Get next available PO number
router.get('/next', async (req, res, next) => {
  try {
    const nextNumber = await poService.getNextNumber();
    res.json({ data: { nextNumber } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/po-numbers/next - Set next PO number
router.put('/next', async (req, res, next) => {
  try {
    const { nextNumber } = req.body;
    const result = await poService.setNextNumber(nextNumber);
    res.json({ data: result, message: 'Next PO number updated' });
  } catch (error) {
    if (error.message.includes('already exists') || error.message.includes('Valid next')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    next(error);
  }
});

// POST /api/po-numbers/assign - Assign next PO number (creates entry)
router.post('/assign', async (req, res, next) => {
  try {
    const poEntry = await poService.assign(req.body);
    res.status(201).json({
      data: poEntry,
      message: `PO${poEntry.poNumber} assigned`
    });
  } catch (error) {
    if (error.message.includes('already exists')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    next(error);
  }
});

// POST /api/po-numbers/:poNumber/void - Void a PO number
router.post('/:poNumber/void', async (req, res, next) => {
  try {
    const { reason, voidedBy } = req.body;
    const poEntry = await poService.void(req.params.poNumber, reason, voidedBy);
    res.json({
      data: poEntry,
      message: `PO${req.params.poNumber} has been voided`
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: { message: error.message } });
    }
    if (error.message.includes('already voided') || error.message.includes('required')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    next(error);
  }
});

// DELETE /api/po-numbers/:id - Delete a PO number
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await poService.delete(req.params.id);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: { message: error.message } });
    }
    next(error);
  }
});

// GET /api/po-numbers/stats - Get PO number statistics
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await poService.getStats();
    res.json({ data: stats });
  } catch (error) {
    next(error);
  }
});

// GET /api/po-numbers/voided - Get all voided PO numbers
router.get('/voided', async (req, res, next) => {
  try {
    const { PONumber } = require('../models');
    const voided = await PONumber.findAll({
      where: { status: 'void' },
      order: [['voidedAt', 'DESC']]
    });
    res.json({ data: voided });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
