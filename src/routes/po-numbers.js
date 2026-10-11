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
    const adjustedFrom = poEntry.get('adjustedFrom');
    res.status(201).json({
      data: poEntry,
      message: adjustedFrom ? `PO${poEntry.poNumber} assigned (PO${adjustedFrom} had just been taken)` : `PO${poEntry.poNumber} assigned`
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

// Every place a PO number string is stored (audit H11). Reassign/release must update all of them —
// the old code only touched work-order parts and a non-existent InboundOrder.poNumber column.
async function renamePOEverywhere(fromStr, toStr, transaction) {
  const { sequelize, WorkOrderPart, InboundOrder, EstimatePart } = require('../models');
  await WorkOrderPart.update({ materialPurchaseOrderNumber: toStr }, { where: { materialPurchaseOrderNumber: fromStr }, transaction });
  await WorkOrderPart.update({ awaitingPONumber: toStr }, { where: { awaitingPONumber: fromStr }, transaction });
  await EstimatePart.update({ materialPurchaseOrderNumber: toStr }, { where: { materialPurchaseOrderNumber: fromStr }, transaction });
  if (toStr !== null) await InboundOrder.update({ purchaseOrderNumber: toStr }, { where: { purchaseOrderNumber: fromStr }, transaction });
  // Older single outside-processing PO field on parts
  await WorkOrderPart.update({ outsideProcessingPONumber: toStr }, { where: { outsideProcessingPONumber: fromStr }, transaction });
  await EstimatePart.update({ outsideProcessingPONumber: toStr }, { where: { outsideProcessingPONumber: fromStr }, transaction });
  // Trucking (TR) POs live in the work order's opTransports list
  await sequelize.query(`
    UPDATE work_orders SET "opTransports" = (
      SELECT jsonb_agg(CASE WHEN e->>'poNumber' = :from THEN
               (CASE WHEN CAST(:to AS text) IS NULL THEN e - 'poNumber' ELSE jsonb_set(e, '{poNumber}', to_jsonb(CAST(:to AS text))) END)
             ELSE e END)
      FROM jsonb_array_elements("opTransports") e)
    WHERE jsonb_typeof("opTransports") = 'array' AND "opTransports" @> jsonb_build_array(jsonb_build_object('poNumber', CAST(:from AS text)))`,
    { replacements: { from: fromStr, to: toStr }, transaction });
  // Service / outside-processing POs stamped inside the outsideProcessing JSON list
  for (const table of ['work_order_parts', 'estimate_parts']) {
    await sequelize.query(`
      UPDATE ${table} SET "outsideProcessing" = (
        SELECT jsonb_agg(CASE WHEN e->>'poNumber' = :from THEN
                 (CASE WHEN CAST(:to AS text) IS NULL THEN e - 'poNumber' - 'poSentAt' ELSE jsonb_set(e, '{poNumber}', to_jsonb(CAST(:to AS text))) END)
               ELSE e END)
        FROM jsonb_array_elements("outsideProcessing") e)
      WHERE jsonb_typeof("outsideProcessing") = 'array' AND "outsideProcessing" @> jsonb_build_array(jsonb_build_object('poNumber', CAST(:from AS text)))`,
      { replacements: { from: fromStr, to: toStr }, transaction });
  }
}

// PUT /api/po-numbers/:poNumber/reassign - Change a PO number to a different number
router.put('/:poNumber/reassign', async (req, res, next) => {
  try {
    const { PONumber, sequelize, AppSettings } = require('../models');
    const { acquire, LOCK_KEYS } = require('../services/numberAllocator');
    const oldPO = parseInt(req.params.poNumber);
    const newPO = parseInt(req.body.newPoNumber);

    if (!newPO || newPO < 1) {
      return res.status(400).json({ error: { message: 'Invalid new PO number' } });
    }
    if (oldPO === newPO) {
      return res.json({ message: 'No change' });
    }

    // Checks and changes under the PO lock, in one transaction
    const result = await sequelize.transaction(async (transaction) => {
      await acquire(sequelize, LOCK_KEYS.po, transaction);
      const poEntry = await PONumber.findOne({ where: { poNumber: oldPO }, transaction });
      if (!poEntry) return { status: 404, message: `PO${oldPO} not found` };
      const existing = await PONumber.findOne({ where: { poNumber: newPO }, transaction });
      if (existing) return { status: 409, message: `PO${newPO} already exists` };

      await poEntry.update({ poNumber: newPO }, { transaction });
      // Keep the prefix the PO already uses (PO / OP / TR) wherever it's stored
      for (const pfx of ['PO', 'OP', 'TR']) await renamePOEverywhere(`${pfx}${oldPO}`, `${pfx}${newPO}`, transaction);
      // Counter only moves forward
      const row = await AppSettings.findOne({ where: { key: 'next_po_number' }, transaction });
      const cur = parseInt(row?.value?.nextNumber, 10) || 0;
      if (newPO + 1 > cur && newPO >= cur) await AppSettings.upsert({ key: 'next_po_number', value: { nextNumber: newPO + 1 } }, { transaction });
      return { status: 200, data: poEntry.toJSON() };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: { message: result.message } });
    res.json({ data: result.data, message: `PO number changed from PO${oldPO} to PO${newPO}` });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/po-numbers/:poNumber/release - Release a PO number (delete entry so it can be reused)
router.delete('/:poNumber/release', async (req, res, next) => {
  try {
    const { PONumber, InboundOrder, WorkOrderPart, sequelize } = require('../models');
    const { acquire, LOCK_KEYS } = require('../services/numberAllocator');
    const poNumber = parseInt(req.params.poNumber);

    // One transaction under the PO lock — the old version had none and could stop half-way
    const result = await sequelize.transaction(async (transaction) => {
      await acquire(sequelize, LOCK_KEYS.po, transaction);
      const poEntry = await PONumber.findOne({ where: { poNumber }, transaction });
      if (!poEntry) return { status: 404, message: `PO${poNumber} not found` };

      // Its expected deliveries: the linked one, or (service / OP POs) any carrying this number
      const { Op } = require('sequelize');
      const inbounds = await InboundOrder.findAll({ where: { [Op.or]: [
        ...(poEntry.inboundOrderId ? [{ id: poEntry.inboundOrderId }] : []),
        { purchaseOrderNumber: [`PO${poNumber}`, `OP${poNumber}`, `TR${poNumber}`] },
      ] }, transaction });
      if (inbounds.some(i => i.status === 'received')) {
        return { status: 409, message: `Material on PO${poNumber} was already received, so the number can't be released. Void the PO instead.` };
      }

      // Clear PO reference from work order parts, then everywhere else the number is stored
      await WorkOrderPart.update(
        { materialPurchaseOrderNumber: null, materialOrdered: false, inboundOrderId: null },
        { where: { materialPurchaseOrderNumber: `PO${poNumber}` }, transaction }
      );
      for (const pfx of ['PO', 'OP', 'TR']) await renamePOEverywhere(`${pfx}${poNumber}`, null, transaction);
      // The PO row references the delivery, so remove the PO first, then its expected deliveries
      await poEntry.destroy({ transaction });
      for (const i of inbounds) await i.destroy({ transaction });
      return { status: 200 };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: { message: result.message } });
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

// POST /api/po-numbers/:id/archive - Archive a PO
router.post('/:id/archive', async (req, res, next) => {
  try {
    const { PONumber } = require('../models');
    const po = await PONumber.findByPk(req.params.id);
    if (!po) return res.status(404).json({ error: { message: 'PO not found' } });
    if (po.status === 'void') return res.status(400).json({ error: { message: 'Cannot archive a voided PO' } });
    await po.update({ status: 'archived' });
    res.json({ data: po, message: `PO${po.poNumber} archived` });
  } catch (error) {
    next(error);
  }
});

// POST /api/po-numbers/:id/unarchive - Restore archived PO to active
router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const { PONumber } = require('../models');
    const po = await PONumber.findByPk(req.params.id);
    if (!po) return res.status(404).json({ error: { message: 'PO not found' } });
    if (po.status !== 'archived') return res.status(400).json({ error: { message: 'PO is not archived' } });
    await po.update({ status: 'active' });
    res.json({ data: po, message: `PO${po.poNumber} restored to active` });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
