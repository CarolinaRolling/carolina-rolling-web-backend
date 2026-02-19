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

// PUT /api/po-numbers/:poNumber/reassign - Change a PO number to a different number
router.put('/:poNumber/reassign', async (req, res, next) => {
  try {
    const { PONumber, WorkOrderPart, InboundOrder, sequelize } = require('../models');
    const oldPO = parseInt(req.params.poNumber);
    const newPO = parseInt(req.body.newPoNumber);

    if (!newPO || newPO < 1) {
      return res.status(400).json({ error: { message: 'Invalid new PO number' } });
    }
    if (oldPO === newPO) {
      return res.json({ message: 'No change' });
    }

    const poEntry = await PONumber.findOne({ where: { poNumber: oldPO } });
    if (!poEntry) {
      return res.status(404).json({ error: { message: `PO${oldPO} not found` } });
    }

    // Check if new number already exists
    const existing = await PONumber.findOne({ where: { poNumber: newPO } });
    if (existing) {
      return res.status(409).json({ error: { message: `PO${newPO} already exists` } });
    }

    const transaction = await sequelize.transaction();
    try {
      // Update the PO record
      await poEntry.update({ poNumber: newPO }, { transaction });

      // Update any work order parts that reference the old PO number
      await WorkOrderPart.update(
        { materialPurchaseOrderNumber: `PO${newPO}` },
        { where: { materialPurchaseOrderNumber: `PO${oldPO}` }, transaction }
      );

      // Update any inbound orders that reference the old PO number
      await InboundOrder.update(
        { poNumber: `PO${newPO}` },
        { where: { poNumber: `PO${oldPO}` }, transaction }
      );

      await transaction.commit();
      res.json({ data: poEntry.toJSON(), message: `PO number changed from PO${oldPO} to PO${newPO}` });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

// DELETE /api/po-numbers/:poNumber/release - Release a PO number (delete entry so it can be reused)
router.delete('/:poNumber/release', async (req, res, next) => {
  try {
    const { PONumber, InboundOrder, WorkOrderPart } = require('../models');
    const poNumber = parseInt(req.params.poNumber);
    const poEntry = await PONumber.findOne({ where: { poNumber } });
    
    if (!poEntry) {
      return res.status(404).json({ error: { message: `PO${poNumber} not found` } });
    }

    // Clear PO reference from any work order parts
    await WorkOrderPart.update(
      { materialPurchaseOrderNumber: null, materialOrdered: false, inboundOrderId: null },
      { where: { materialPurchaseOrderNumber: `PO${poNumber}` } }
    );

    // Clear PO from linked inbound order if exists
    if (poEntry.inboundOrderId) {
      await InboundOrder.update(
        { poNumber: null },
        { where: { id: poEntry.inboundOrderId } }
      );
    }

    // Delete the PO entry entirely
    await poEntry.destroy();

    res.json({ message: `PO${poNumber} has been released and can be reused` });
  } catch (error) {
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
