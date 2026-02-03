const express = require('express');
const { Op } = require('sequelize');
const { PONumber, WorkOrder, Estimate, InboundOrder, DailyActivity, AppSettings, sequelize } = require('../models');

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

// GET /api/po-numbers - Get all PO numbers
router.get('/', async (req, res, next) => {
  try {
    const { status, supplier, limit = 50, offset = 0 } = req.query;
    
    const where = {};
    if (status) where.status = status;
    if (supplier) where.supplier = { [Op.iLike]: `%${supplier}%` };

    const poNumbers = await PONumber.findAndCountAll({
      where,
      order: [['poNumber', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      data: poNumbers.rows,
      total: poNumbers.count
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/po-numbers/next - Get next available PO number
router.get('/next', async (req, res, next) => {
  try {
    // Check settings for custom next number
    const setting = await AppSettings.findOne({ where: { key: 'next_po_number' } });
    
    if (setting?.value?.nextNumber) {
      return res.json({ data: { nextNumber: setting.value.nextNumber } });
    }

    // Find the highest PO number used
    const lastPO = await PONumber.findOne({
      order: [['poNumber', 'DESC']]
    });

    // Default starting point is 7765 (since current is 7764)
    const nextNumber = lastPO ? lastPO.poNumber + 1 : 7765;
    res.json({ data: { nextNumber } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/po-numbers/next - Set next PO number
router.put('/next', async (req, res, next) => {
  try {
    const { nextNumber } = req.body;

    if (!nextNumber || nextNumber < 1) {
      return res.status(400).json({ error: { message: 'Valid next number is required' } });
    }

    // Check if number already exists
    const existing = await PONumber.findOne({ where: { poNumber: nextNumber } });
    if (existing) {
      return res.status(400).json({ error: { message: `PO${nextNumber} already exists` } });
    }

    // Save to settings
    await AppSettings.upsert({
      key: 'next_po_number',
      value: { nextNumber }
    });

    res.json({ data: { nextNumber }, message: 'Next PO number updated' });
  } catch (error) {
    next(error);
  }
});

// POST /api/po-numbers/assign - Assign next PO number (creates entry)
router.post('/assign', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { supplier, estimateId, workOrderId, inboundOrderId, clientName, description, customNumber } = req.body;

    let poNumber;

    if (customNumber) {
      // Check if custom number is available
      const existing = await PONumber.findOne({ where: { poNumber: customNumber }, transaction });
      if (existing) {
        await transaction.rollback();
        return res.status(400).json({ error: { message: `PO${customNumber} already exists` } });
      }
      poNumber = customNumber;
    } else {
      // Get next available number
      const setting = await AppSettings.findOne({ where: { key: 'next_po_number' }, transaction });
      
      if (setting?.value?.nextNumber) {
        poNumber = setting.value.nextNumber;
        // Increment for next time
        await setting.update({ value: { nextNumber: poNumber + 1 } }, { transaction });
      } else {
        const lastPO = await PONumber.findOne({
          order: [['poNumber', 'DESC']],
          transaction
        });
        // Default starting point is 7765
        poNumber = lastPO ? lastPO.poNumber + 1 : 7765;
        
        // Save the next number setting
        await AppSettings.upsert({
          key: 'next_po_number',
          value: { nextNumber: poNumber + 1 }
        }, { transaction });
      }
    }

    // Create PO number entry
    const poEntry = await PONumber.create({
      poNumber,
      status: 'active',
      supplier,
      estimateId,
      workOrderId,
      inboundOrderId,
      clientName,
      description
    }, { transaction });

    // Update inbound order with PO number if provided
    if (inboundOrderId) {
      await InboundOrder.update(
        { poNumber: `PO${poNumber}` },
        { where: { id: inboundOrderId }, transaction }
      );
    }

    await transaction.commit();

    // Log activity
    await logActivity(
      'created',
      'po_number',
      poEntry.id,
      `PO${poNumber}`,
      clientName,
      `PO${poNumber} assigned to ${supplier || 'Unknown Supplier'}`
    );

    res.status(201).json({
      data: poEntry,
      message: `PO${poNumber} assigned`
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

// POST /api/po-numbers/:poNumber/void - Void a PO number
router.post('/:poNumber/void', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const poNumber = parseInt(req.params.poNumber);
    const { reason, voidedBy } = req.body;

    if (!reason) {
      return res.status(400).json({ error: { message: 'Void reason is required' } });
    }

    // Find PO number entry
    const poEntry = await PONumber.findOne({ where: { poNumber }, transaction });
    
    if (!poEntry) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: `PO${poNumber} not found` } });
    }

    if (poEntry.status === 'void') {
      await transaction.rollback();
      return res.status(400).json({ error: { message: `PO${poNumber} is already voided` } });
    }

    // Update PO entry to void
    await poEntry.update({
      status: 'void',
      voidedAt: new Date(),
      voidedBy: voidedBy || 'admin',
      voidReason: reason
    }, { transaction });

    // Clear PO number from inbound order if linked
    if (poEntry.inboundOrderId) {
      await InboundOrder.update(
        { poNumber: null },
        { where: { id: poEntry.inboundOrderId }, transaction }
      );
    }

    // Log activity
    await logActivity(
      'void',
      'po_number',
      poEntry.id,
      `PO${poNumber}`,
      poEntry.clientName,
      `PO${poNumber} voided: ${reason}`
    );

    await transaction.commit();

    res.json({
      data: poEntry,
      message: `PO${poNumber} has been voided`
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

// GET /api/po-numbers/stats - Get PO number statistics
router.get('/stats', async (req, res, next) => {
  try {
    const lastUsed = await PONumber.findOne({
      where: { status: 'active' },
      order: [['poNumber', 'DESC']]
    });

    const setting = await AppSettings.findOne({ where: { key: 'next_po_number' } });
    const nextNumber = setting?.value?.nextNumber || (lastUsed ? lastUsed.poNumber + 1 : 7765);

    const voidedCount = await PONumber.count({ where: { status: 'void' } });
    const activeCount = await PONumber.count({ where: { status: 'active' } });

    res.json({
      data: {
        lastUsed: lastUsed?.poNumber || 7764,
        nextNumber,
        voidedCount,
        activeCount
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/po-numbers/voided - Get all voided PO numbers
router.get('/voided', async (req, res, next) => {
  try {
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
