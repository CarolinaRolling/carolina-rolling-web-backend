const express = require('express');
const { Op } = require('sequelize');
const { DRNumber, WorkOrder, WorkOrderPart, Estimate, EstimatePart, InboundOrder, DailyActivity, AppSettings, sequelize } = require('../models');

const router = express.Router();

// Helper to log activity for daily email
async function logActivity(type, resourceType, resourceId, resourceNumber, clientName, description, details = {}) {
  try {
    await DailyActivity.create({
      activityType: type,
      resourceType,
      resourceId,
      resourceNumber,
      clientName,
      description,
      details
    });
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}

// GET /api/dr-numbers - Get all DR numbers
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    
    const where = {};
    if (status) where.status = status;

    const drNumbers = await DRNumber.findAndCountAll({
      where,
      order: [['drNumber', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Enrich with work order clientName (authoritative source)
    const enriched = await Promise.all(drNumbers.rows.map(async (dr) => {
      const data = dr.toJSON();
      if (data.workOrderId) {
        try {
          const wo = await WorkOrder.findByPk(data.workOrderId, { attributes: ['clientName'] });
          if (wo && wo.clientName) {
            data.clientName = wo.clientName;
          }
        } catch (_) {}
      }
      return data;
    }));

    res.json({
      data: enriched,
      total: drNumbers.count
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dr-numbers/next - Get next available DR number
router.get('/next', async (req, res, next) => {
  try {
    // What the allocator will actually hand out: max(setting, highest in use + 1) (V25)
    const setting = await AppSettings.findOne({ where: { key: 'next_dr_number' } });
    const configured = parseInt(setting?.value?.nextNumber, 10) || 0;
    const high = Math.max((await DRNumber.max('drNumber')) || 0, (await WorkOrder.max('drNumber')) || 0);
    const nextNumber = Math.max(configured, high + 1);
    res.json({ data: { nextNumber } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/dr-numbers/next - Set next DR number
router.put('/next', async (req, res, next) => {
  try {
    // A whole number, stored as a number: "20" stored as text made the allocator do "20"+1 = "201" (U42)
    const nextNumber = Number(req.body && req.body.nextNumber);

    if (!Number.isInteger(nextNumber) || nextNumber < 1) {
      return res.status(400).json({ error: { message: 'Valid next number is required' } });
    }
    // Moving the DR sequence is an admin action, and a typo far past the highest DR is refused (R17)
    if (req.user?.role !== 'admin') return res.status(403).json({ error: { message: 'Only an admin can set the next DR number.' } });
    const jump = await require('../services/drGuard').jumpProblem(require('../models'), parseInt(nextNumber));
    if (jump) return res.status(jump.status).json({ error: { message: jump.message } });

    // V25: at or below a DR already in use would be skipped anyway — say so instead of saving it
    const high = Math.max((await DRNumber.max('drNumber')) || 0, (await WorkOrder.max('drNumber')) || 0);
    if (nextNumber <= high) {
      return res.status(400).json({ error: { message: `DR-${high} is already in use — the next DR number must be higher than ${high}.` } });
    }

    // Check if number already exists
    const existing = await DRNumber.findOne({ where: { drNumber: nextNumber } });
    if (existing) {
      return res.status(400).json({ error: { message: `DR-${nextNumber} already exists` } });
    }

    // Save to settings
    await AppSettings.upsert({
      key: 'next_dr_number',
      value: { nextNumber }
    });

    res.json({ data: { nextNumber }, message: 'Next DR number updated' });
  } catch (error) {
    next(error);
  }
});

// POST /api/dr-numbers/assign - Assign next DR number (creates entry)
router.post('/assign', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { estimateId, workOrderId, clientName, customNumber } = req.body;

    // The shared, locked allocator (R17 / R34: this used an unlocked max + 1)
    const alloc = require('../services/numberAllocator');
    const models = require('../models');
    let drNumber;
    try {
      if (customNumber) {
        const jump = await require('../services/drGuard').jumpProblem(models, parseInt(customNumber), { transaction });
        if (jump) { await transaction.rollback(); return res.status(jump.status).json({ error: { message: jump.message } }); }
        drNumber = await alloc.reserveCustomDRNumber(models, transaction, customNumber);
      } else {
        drNumber = await alloc.allocateDRNumber(models, transaction);
      }
    } catch (e) {
      if (e.status === 400) { await transaction.rollback(); return res.status(400).json({ error: { message: e.message } }); }
      throw e;
    }

    // Create DR number entry
    const drEntry = await DRNumber.create({
      drNumber,
      status: 'active',
      estimateId,
      workOrderId,
      clientName
    }, { transaction });

    // Stamp the number onto the work order itself. Creating only the DRNumber row left the
    // work order with drNumber = null, so it still showed as DR-less everywhere and there was
    // no way to repair one short of deleting and rebuilding it.
    if (workOrderId) {
      const wo = await WorkOrder.findByPk(workOrderId, { transaction });
      if (!wo) {
        await transaction.rollback();
        return res.status(404).json({ error: { message: 'Work order not found' } });
      }
      if (wo.drNumber && wo.drNumber !== drNumber) {
        await transaction.rollback();
        return res.status(400).json({ error: { message: `Work order already has DR-${wo.drNumber}` } });
      }
      await wo.update({ drNumber }, { transaction });
    }

    await transaction.commit();

    res.status(201).json({
      data: drEntry,
      message: `DR-${drNumber} assigned`
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

// DELETE /api/dr-numbers/:drNumber/release - Release a DR number (delete entry so it can be reused)
router.delete('/:drNumber/release', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  try {
    const drNumber = parseInt(req.params.drNumber);
    const models = require('../models');
    const guard = require('../services/drGuard');
    await guard.lockDR(sequelize, transaction);   // one DR writer at a time (R17)
    const drEntry = await DRNumber.findOne({ where: { drNumber }, transaction });
    if (!drEntry) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: `DR-${drNumber} not found` } });
    }
    const wo = drEntry.workOrderId ? await WorkOrder.findByPk(drEntry.workOrderId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    // Admins only, and never on an order with an invoice or payments (R17)
    const problem = await guard.drActionProblem(models, req, wo || { id: null }, 'release', { transaction });
    if (problem) { await transaction.rollback(); return res.status(problem.status).json({ error: { message: problem.message } }); }

    // Lot numbers are "<DR>-<line>": once the order has shipped, those lots are on certs / COCs the
    // customer holds, and a reused DR would print the same lots again (audit T17)
    // V7: any pickup (a partial one sets no shipped/picked-up stamp) counts as shipped
    if (wo && guard.hasShipped(wo)) {
      await transaction.rollback();
      return res.status(409).json({ error: { code: 'DR_SHIPPED', message: `DR-${drNumber} has shipped (in full or in part) — its lot numbers are on the customer's paperwork, so it can't be released for reuse. Void it instead.` } });
    }
    // Clear the number from the order (the order stays) and from the estimate it came from — the
    // estimate stays linked to its order (this used to unlink it, wrongly)
    // What Undo must put back (R26): the order's DR, the estimate's, and the lots cleared below
    const relink = [];
    if (wo) {
      relink.push({ table: 'work_orders', col: 'drNumber', value: drNumber, ids: [wo.id] });
      const [lots] = await sequelize.query(`SELECT id, "lotNumber" FROM work_order_parts WHERE "workOrderId" = :id AND "lotNumber" LIKE :p`,
        { replacements: { id: wo.id, p: `${drNumber}-%` }, transaction });
      for (const l of lots) relink.push({ table: 'work_order_parts', col: 'lotNumber', value: l.lotNumber, ids: [l.id], onlyIf: { table: 'work_orders', col: 'drNumber', id: wo.id, value: drNumber } });
    }
    const ests = await Estimate.findAll({ where: { drNumber }, attributes: ['id'], transaction });
    if (ests.length) relink.push({ table: 'estimates', col: 'drNumber', value: drNumber, ids: ests.map(e => e.id) });
    if (wo) {
      await wo.update({ drNumber: null }, { transaction });
      // ...and the lots made from it, so a reused DR doesn't hand out the same lot numbers (T17)
      await sequelize.query(`UPDATE work_order_parts SET "lotNumber" = NULL
        WHERE "workOrderId" = :id AND "lotNumber" LIKE :p`, { replacements: { id: wo.id, p: `${drNumber}-%` }, transaction });
      await sequelize.query(`UPDATE work_order_parts SET "formData" = "formData" - 'lotNumber'
        WHERE "workOrderId" = :id AND jsonb_typeof("formData") = 'object' AND "formData"->>'lotNumber' LIKE :p`, { replacements: { id: wo.id, p: `${drNumber}-%` }, transaction });
    }
    await Estimate.update({ drNumber: null }, { where: { drNumber }, transaction });
    await drEntry.destroy({ transaction, undoRelink: relink });
    await transaction.commit();

    await logActivity('deleted', 'dr_number', drEntry.id, `DR-${drNumber}`, drEntry.clientName,
      `DR-${drNumber} released/deleted by ${req.user?.username || 'unknown'}`);
    res.json({ message: `DR-${drNumber} has been released and can be reused` });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    next(error);
  }
});

// POST /api/dr-numbers/:drNumber/void - Void a DR number
router.post('/:drNumber/void', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const drNumber = parseInt(req.params.drNumber);
    const { reason, voidedBy } = req.body;

    if (!reason) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'Void reason is required' } });
    }

    // Find DR number entry
    const drEntry = await DRNumber.findOne({ where: { drNumber }, transaction });
    
    if (!drEntry) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: `DR-${drNumber} not found` } });
    }

    if (drEntry.status === 'void') {
      await transaction.rollback();
      return res.status(400).json({ error: { message: `DR-${drNumber} is already voided` } });
    }

    // Mark associated work order as voided — keep the record intact for expense tracking
    if (drEntry.workOrderId) {
      const workOrder = await WorkOrder.findByPk(drEntry.workOrderId, { transaction, lock: transaction.LOCK.UPDATE });
      // invoiced / in QuickBooks: admins only; with payments: void those first (R17)
      const problem = workOrder ? await require('../services/drGuard').drActionProblem(require('../models'), req, workOrder, 'void', { transaction }) : null;
      if (problem) { await transaction.rollback(); return res.status(problem.status).json({ error: { message: problem.message } }); }
      if (workOrder) {
        await workOrder.update({
          isVoided: true,
          voidedAt: new Date(),
          voidedBy: voidedBy || 'admin',
          voidReason: reason,
          notes: (workOrder.notes || '') + `\n\n⛔ VOIDED: ${reason} (by ${voidedBy || 'admin'} on ${new Date().toLocaleDateString()})`
        }, { transaction });
      }
    }

    // Update DR entry to void — keep workOrderId for reference
    await drEntry.update({
      status: 'void',
      voidedAt: new Date(),
      voidedBy: voidedBy || 'admin',
      voidReason: reason
    }, { transaction });

    // Log activity
    await logActivity(
      'void',
      'dr_number',
      drEntry.id,
      `DR-${drNumber}`,
      drEntry.clientName,
      `DR-${drNumber} voided: ${reason}`
    );

    await transaction.commit();

    res.json({
      data: drEntry,
      message: `DR-${drNumber} has been voided`
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

// POST /api/dr-numbers/:drNumber/unvoid - Restore a voided DR number
router.post('/:drNumber/unvoid', async (req, res, next) => {
  // Restoring puts the order (and its invoice) back into receivables — admin only (round 12, N14)
  if (!require('../services/staffRoles').isAdminCaller(req)) return res.status(403).json({ error: { message: 'Only an admin can restore a voided DR number.' } });
  const transaction = await sequelize.transaction();
  try {
    const drNumber = parseInt(req.params.drNumber);
    const drEntry = await DRNumber.findOne({ where: { drNumber }, transaction });
    
    if (!drEntry) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: `DR-${drNumber} not found` } });
    }
    if (drEntry.status !== 'void') {
      await transaction.rollback();
      return res.status(400).json({ error: { message: `DR-${drNumber} is not voided` } });
    }

    // Restore work order
    if (drEntry.workOrderId) {
      const workOrder = await WorkOrder.findByPk(drEntry.workOrderId, { transaction });
      if (workOrder) {
        // While voided, its invoice number counted as free and may have gone to another order.
        if (workOrder.invoiceNumber) {
          const { Op } = require('sequelize');
          const holder = await WorkOrder.findOne({ where: { invoiceNumber: workOrder.invoiceNumber, id: { [Op.ne]: workOrder.id },
            [Op.or]: [{ isVoided: null }, { isVoided: false }] }, transaction });
          if (holder) {
            await transaction.rollback();
            return res.status(409).json({ error: { message: `Can't restore DR-${drNumber}: its invoice #${workOrder.invoiceNumber} is now used by ${holder.drNumber ? 'DR-' + holder.drNumber : holder.orderNumber}. Clear or change one of the invoice numbers first.` } });
          }
        }
        await workOrder.update({
          isVoided: false,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
          notes: (workOrder.notes || '').replace(/\n\n⛔ VOIDED:.*$/s, '')
        }, { transaction });
      }
    }

    await drEntry.update({
      status: 'active',
      voidedAt: null,
      voidedBy: null,
      voidReason: null
    }, { transaction });

    await logActivity('restored', 'dr_number', drEntry.id, `DR-${drNumber}`, drEntry.clientName, `DR-${drNumber} restored from void`);
    await transaction.commit();

    res.json({ data: drEntry, message: `DR-${drNumber} has been restored` });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

// GET /api/dr-numbers/stats - Get DR number statistics
router.get('/stats', async (req, res, next) => {
  try {
    const lastUsed = await DRNumber.findOne({
      where: { status: 'active' },
      order: [['drNumber', 'DESC']]
    });

    const setting = await AppSettings.findOne({ where: { key: 'next_dr_number' } });
    const nextNumber = setting?.value?.nextNumber || (lastUsed ? lastUsed.drNumber + 1 : 1);

    const voidedCount = await DRNumber.count({ where: { status: 'void' } });
    const activeCount = await DRNumber.count({ where: { status: 'active' } });

    res.json({
      data: {
        lastUsed: lastUsed?.drNumber || 0,
        nextNumber,
        voidedCount,
        activeCount
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dr-numbers/voided - Get all voided DR numbers
router.get('/voided', async (req, res, next) => {
  try {
    const voided = await DRNumber.findAll({
      where: { status: 'void' },
      order: [['voidedAt', 'DESC']]
    });

    res.json({ data: voided });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
