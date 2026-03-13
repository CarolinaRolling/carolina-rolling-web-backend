const express = require('express');
const crypto = require('crypto');
const { ShopSupply, ShopSupplyLog } = require('../models');
const { Op } = require('sequelize');

const router = express.Router();

// GET /api/shop-supplies - List all supplies
router.get('/', async (req, res, next) => {
  try {
    const { active = 'true' } = req.query;
    const where = {};
    if (active === 'true') where.isActive = true;

    const supplies = await ShopSupply.findAll({
      where,
      order: [['category', 'ASC'], ['name', 'ASC']]
    });

    res.json({ data: supplies });
  } catch (error) {
    next(error);
  }
});

// GET /api/shop-supplies/low-stock - Get items at or below min quantity
router.get('/low-stock', async (req, res, next) => {
  try {
    const supplies = await ShopSupply.findAll({
      where: {
        isActive: true,
        lowStockAcknowledged: false,
        quantity: { [Op.lte]: require('sequelize').col('minQuantity') }
      },
      order: [['quantity', 'ASC']]
    });
    res.json({ data: supplies });
  } catch (error) {
    next(error);
  }
});

// GET /api/shop-supplies/qr/:qrCode - Lookup by QR code (for Android scanner)
router.get('/qr/:qrCode', async (req, res, next) => {
  try {
    const supply = await ShopSupply.findOne({ where: { qrCode: req.params.qrCode, isActive: true } });
    if (!supply) {
      return res.status(404).json({ error: { message: 'Item not found' } });
    }
    res.json({ data: supply });
  } catch (error) {
    next(error);
  }
});

// POST /api/shop-supplies - Create new supply item
router.post('/', async (req, res, next) => {
  try {
    const { name, description, category, quantity, unit, minQuantity } = req.body;
    if (!name) {
      return res.status(400).json({ error: { message: 'Name is required' } });
    }

    // Generate unique QR code
    const qrCode = `SUPPLY-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

    const supply = await ShopSupply.create({
      name,
      description: description || null,
      category: category || null,
      quantity: parseInt(quantity) || 0,
      unit: unit || 'each',
      minQuantity: parseInt(minQuantity) || 1,
      qrCode,
      lowStockAcknowledged: (parseInt(quantity) || 0) > (parseInt(minQuantity) || 1)
    });

    // Log initial stock
    if (supply.quantity > 0) {
      await ShopSupplyLog.create({
        shopSupplyId: supply.id,
        action: 'refill',
        quantityChange: supply.quantity,
        quantityAfter: supply.quantity,
        performedBy: req.user?.username || req.operatorName || 'system',
        notes: 'Initial stock'
      });
    }

    res.status(201).json({ data: supply, message: `${name} added to shop supplies` });
  } catch (error) {
    next(error);
  }
});

// PUT /api/shop-supplies/:id - Update supply item
router.put('/:id', async (req, res, next) => {
  try {
    const supply = await ShopSupply.findByPk(req.params.id);
    if (!supply) {
      return res.status(404).json({ error: { message: 'Item not found' } });
    }

    const { name, description, category, unit, minQuantity, isActive } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category !== undefined) updates.category = category;
    if (unit !== undefined) updates.unit = unit;
    if (minQuantity !== undefined) updates.minQuantity = parseInt(minQuantity) || 1;
    if (isActive !== undefined) updates.isActive = isActive;

    await supply.update(updates);
    res.json({ data: supply, message: 'Item updated' });
  } catch (error) {
    next(error);
  }
});

// POST /api/shop-supplies/:id/consume - Consume one unit (QR scan from tablet)
router.post('/:id/consume', async (req, res, next) => {
  try {
    const supply = await ShopSupply.findByPk(req.params.id);
    if (!supply) {
      return res.status(404).json({ error: { message: 'Item not found' } });
    }

    if (supply.quantity <= 0) {
      return res.status(400).json({ error: { message: `${supply.name} is out of stock!` } });
    }

    const qty = parseInt(req.body.quantity) || 1;
    const newQty = Math.max(0, supply.quantity - qty);
    const performedBy = req.body.performedBy || req.operatorName || req.user?.username || 'unknown';
    const deviceName = req.deviceName || null;

    await supply.update({
      quantity: newQty,
      lastConsumedAt: new Date(),
      lastConsumedBy: performedBy,
      // Reset acknowledged flag if now at or below minimum
      lowStockAcknowledged: newQty > supply.minQuantity ? supply.lowStockAcknowledged : false
    });

    await ShopSupplyLog.create({
      shopSupplyId: supply.id,
      action: 'consume',
      quantityChange: -qty,
      quantityAfter: newQty,
      performedBy,
      deviceName,
      notes: req.body.notes || null
    });

    console.log(`[shop-supply] ${performedBy} consumed ${qty} ${supply.unit} of ${supply.name} (${newQty} remaining)`);

    res.json({
      data: supply,
      message: `Took ${qty} ${supply.unit} of ${supply.name}. ${newQty} remaining.`,
      lowStock: newQty <= supply.minQuantity
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/shop-supplies/:id/refill - Refill stock (office use)
router.post('/:id/refill', async (req, res, next) => {
  try {
    const supply = await ShopSupply.findByPk(req.params.id);
    if (!supply) {
      return res.status(404).json({ error: { message: 'Item not found' } });
    }

    const qty = parseInt(req.body.quantity);
    if (!qty || qty <= 0) {
      return res.status(400).json({ error: { message: 'Quantity must be positive' } });
    }

    const newQty = supply.quantity + qty;
    const performedBy = req.user?.username || req.operatorName || 'unknown';

    await supply.update({
      quantity: newQty,
      lastRefilledAt: new Date(),
      lastRefilledBy: performedBy,
      lowStockAcknowledged: true // clear the warning
    });

    await ShopSupplyLog.create({
      shopSupplyId: supply.id,
      action: 'refill',
      quantityChange: qty,
      quantityAfter: newQty,
      performedBy,
      notes: req.body.notes || null
    });

    res.json({
      data: supply,
      message: `Added ${qty} ${supply.unit} of ${supply.name}. Now ${newQty} in stock.`
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/shop-supplies/:id/logs - Get history for an item
router.get('/:id/logs', async (req, res, next) => {
  try {
    const logs = await ShopSupplyLog.findAll({
      where: { shopSupplyId: req.params.id },
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    res.json({ data: logs });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/shop-supplies/:id - Delete supply item
router.delete('/:id', async (req, res, next) => {
  try {
    const supply = await ShopSupply.findByPk(req.params.id);
    if (!supply) {
      return res.status(404).json({ error: { message: 'Item not found' } });
    }
    await ShopSupplyLog.destroy({ where: { shopSupplyId: supply.id } });
    await supply.destroy();
    res.json({ message: `${supply.name} deleted` });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
