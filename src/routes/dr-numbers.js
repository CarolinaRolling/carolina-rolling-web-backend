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

    res.json({
      data: drNumbers.rows,
      total: drNumbers.count
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dr-numbers/next - Get next available DR number
router.get('/next', async (req, res, next) => {
  try {
    // Check settings for custom next number
    const setting = await AppSettings.findOne({ where: { key: 'next_dr_number' } });
    
    if (setting?.value?.nextNumber) {
      return res.json({ data: { nextNumber: setting.value.nextNumber } });
    }

    // Find the highest DR number used
    const lastDR = await DRNumber.findOne({
      order: [['drNumber', 'DESC']]
    });

    const nextNumber = lastDR ? lastDR.drNumber + 1 : 1;
    res.json({ data: { nextNumber } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/dr-numbers/next - Set next DR number
router.put('/next', async (req, res, next) => {
  try {
    const { nextNumber } = req.body;

    if (!nextNumber || nextNumber < 1) {
      return res.status(400).json({ error: { message: 'Valid next number is required' } });
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

    let drNumber;

    if (customNumber) {
      // Check if custom number is available
      const existing = await DRNumber.findOne({ where: { drNumber: customNumber }, transaction });
      if (existing) {
        await transaction.rollback();
        return res.status(400).json({ error: { message: `DR-${customNumber} already exists` } });
      }
      drNumber = customNumber;
    } else {
      // Get next available number
      const setting = await AppSettings.findOne({ where: { key: 'next_dr_number' }, transaction });
      
      if (setting?.value?.nextNumber) {
        drNumber = setting.value.nextNumber;
        // Increment for next time
        await setting.update({ value: { nextNumber: drNumber + 1 } }, { transaction });
      } else {
        const lastDR = await DRNumber.findOne({
          order: [['drNumber', 'DESC']],
          transaction
        });
        drNumber = lastDR ? lastDR.drNumber + 1 : 1;
      }
    }

    // Create DR number entry
    const drEntry = await DRNumber.create({
      drNumber,
      status: 'active',
      estimateId,
      workOrderId,
      clientName
    }, { transaction });

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

// POST /api/dr-numbers/:drNumber/void - Void a DR number
router.post('/:drNumber/void', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const drNumber = parseInt(req.params.drNumber);
    const { reason, voidedBy } = req.body;

    if (!reason) {
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

    // Delete associated work order and parts
    if (drEntry.workOrderId) {
      const workOrder = await WorkOrder.findByPk(drEntry.workOrderId, { transaction });
      if (workOrder) {
        // Delete work order parts first
        await WorkOrderPart.destroy({ where: { workOrderId: workOrder.id }, transaction });
        // Delete work order
        await workOrder.destroy({ transaction });
      }
    }

    // Update DR entry to void
    await drEntry.update({
      status: 'void',
      voidedAt: new Date(),
      voidedBy: voidedBy || 'admin',
      voidReason: reason,
      workOrderId: null
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
