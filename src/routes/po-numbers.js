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
  // Moving the PO counter is an admin decision, and never far past the highest PO (round 13, T12 —
  // any user could set it to 8,888,888 and every later PO would start there)
  if (!require('../services/staffRoles').isAdminCaller(req)) return res.status(403).json({ error: { message: 'Only an admin can set the next PO number.' } });
  try {
    const { nextNumber } = req.body;
    const n = parseInt(nextNumber, 10);
    const { PONumber } = require('../models');
    const high = (await PONumber.max('poNumber')) || 0;
    if (Number.isFinite(n) && high && n > high + 1000) {
      return res.status(400).json({ error: { message: `PO${n} is more than 1000 past the highest PO in use (PO${high}). Check for a typo.` } });
    }
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

// Every place a PO number string is stored (audit H11) — lives in PONumberService so void can use it too (V10)
const renamePOEverywhere = (...args) => require('../services/PONumberService').renamePOEverywhere(...args);

// PUT /api/po-numbers/:poNumber/reassign - Change a PO number to a different number
router.put('/:poNumber/reassign', async (req, res, next) => {
  // Renumbering a PO the vendor already has is an admin decision (round 12, audit N15)
  if (req.user?.role !== 'admin' && req.apiKey?.permissions !== 'admin') {
    return res.status(403).json({ error: { message: 'Only an admin can change a PO number.' } });
  }
  try {
    const { PONumber, InboundOrder, sequelize, AppSettings } = require('../models');
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
      // A typo with an extra digit would move the automatic sequence for good (same guard as assign)
      const high = (await PONumber.max('poNumber', { transaction })) || 0;
      if (high && newPO > high + 1000) return { status: 400, message: `PO${newPO} is far past the highest PO in use (PO${high}). Check the number for a typo.` };
      // Material already received on it: the vendor's paperwork carries the old number
      const { Op } = require('sequelize');
      const received = await InboundOrder.findOne({ where: { status: 'received', [Op.or]: [
        ...(poEntry.inboundOrderId ? [{ id: poEntry.inboundOrderId }] : []),
        { purchaseOrderNumber: [`PO${oldPO}`, `OP${oldPO}`, `TR${oldPO}`] },
      ] }, transaction });
      if (received) return { status: 409, message: `Material on PO${oldPO} was already received, so its number can't be changed (the vendor's paperwork carries it).` };

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
    const poNumber = req._poNumberFromId || parseInt(req.params.poNumber);

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

      // What Undo must put back (R26): the parts' PO fields cleared below. PO stamps inside trip /
      // outside-processing lists are not restored — Undo says so.
      const relink = [];
      const [pts] = await sequelize.query(`SELECT id, "materialPurchaseOrderNumber" AS m, "materialOrdered" AS o, "inboundOrderId" AS i,
          "awaitingPONumber" AS a, "outsideProcessingPONumber" AS op FROM work_order_parts
        WHERE "materialPurchaseOrderNumber" IN (:s) OR "awaitingPONumber" IN (:s) OR "outsideProcessingPONumber" IN (:s)`,
        { replacements: { s: [`PO${poNumber}`, `OP${poNumber}`, `TR${poNumber}`] }, transaction });
      for (const p of pts) {
        if (p.m) relink.push({ table: 'work_order_parts', col: 'materialPurchaseOrderNumber', value: p.m, ids: [p.id] });
        if (p.m && p.o) relink.push({ table: 'work_order_parts', col: 'materialOrdered', value: true, when: false, ids: [p.id] });
        if (p.i) relink.push({ table: 'work_order_parts', col: 'inboundOrderId', value: p.i, ids: [p.id] });
        if (p.a) relink.push({ table: 'work_order_parts', col: 'awaitingPONumber', value: p.a, ids: [p.id] });
        if (p.op) relink.push({ table: 'work_order_parts', col: 'outsideProcessingPONumber', value: p.op, ids: [p.id] });
      }
      const [eps] = await sequelize.query(`SELECT id, "materialPurchaseOrderNumber" AS m, "outsideProcessingPONumber" AS op,
          "materialOrdered" AS o, "materialOrderedAt" AS oa, "inboundOrderId" AS i FROM estimate_parts
        WHERE "materialPurchaseOrderNumber" IN (:s) OR "outsideProcessingPONumber" IN (:s)`,
        { replacements: { s: [`PO${poNumber}`, `OP${poNumber}`, `TR${poNumber}`] }, transaction });
      for (const p of eps) {
        if (p.m) relink.push({ table: 'estimate_parts', col: 'materialPurchaseOrderNumber', value: p.m, ids: [p.id] });
        // U22: the order fields release now clears on estimate parts too
        if (p.m && p.o) relink.push({ table: 'estimate_parts', col: 'materialOrdered', value: true, when: false, ids: [p.id] });
        if (p.m && p.oa) relink.push({ table: 'estimate_parts', col: 'materialOrderedAt', value: p.oa, ids: [p.id] });
        if (p.m && p.i) relink.push({ table: 'estimate_parts', col: 'inboundOrderId', value: p.i, ids: [p.id] });
        if (p.op) relink.push({ table: 'estimate_parts', col: 'outsideProcessingPONumber', value: p.op, ids: [p.id] });
      }
      const undoNote = `PO${poNumber} is back with its parts; re-enter it on any trip or outside-processing line that showed it.`;

      // Clear PO reference from work order parts, then everywhere else the number is stored
      await WorkOrderPart.update(
        { materialPurchaseOrderNumber: null, materialOrdered: false, inboundOrderId: null },
        { where: { materialPurchaseOrderNumber: `PO${poNumber}` }, transaction }
      );
      for (const pfx of ['PO', 'OP', 'TR']) await renamePOEverywhere(`${pfx}${poNumber}`, null, transaction);
      // The PO row references the delivery, so remove the PO first, then its expected deliveries
      await poEntry.destroy({ transaction, undoRelink: relink, undoNote });
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
  // Deleting a PO is the same as releasing it (round 13, T15): under the PO lock, refused once material
  // was received on it, and the number cleared everywhere it is stored (OP/TR numbers on parts, trips
  // and estimates used to be left pointing at a PO that no longer existed)
  try {
    const { PONumber } = require('../models');
    const po = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await PONumber.findByPk(req.params.id) : null;
    if (!po) return res.status(404).json({ error: { message: 'PO number not found' } });
    req._poNumberFromId = po.poNumber;
    const release = router.stack.find(l => l.route && l.route.path === '/:poNumber/release' && l.route.methods.delete);
    return release.route.stack[0].handle(req, res, next);
  } catch (error) { next(error); }
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
