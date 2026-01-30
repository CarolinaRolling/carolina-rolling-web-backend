const express = require('express');
const router = express.Router();
const { InboundOrder } = require('../models');

// GET all inbound orders
router.get('/', async (req, res) => {
  try {
    const orders = await InboundOrder.findAll({
      order: [['createdAt', 'DESC']]
    });
    
    res.json({
      data: orders,
      total: orders.length
    });
  } catch (error) {
    console.error('Error fetching inbound orders:', error);
    res.status(500).json({ error: 'Failed to fetch inbound orders' });
  }
});

// GET single inbound order by ID
router.get('/:id', async (req, res) => {
  try {
    const order = await InboundOrder.findByPk(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Inbound order not found' });
    }
    
    res.json({ data: order });
  } catch (error) {
    console.error('Error fetching inbound order:', error);
    res.status(500).json({ error: 'Failed to fetch inbound order' });
  }
});

// POST create new inbound order
router.post('/', async (req, res) => {
  try {
    const { supplierName, purchaseOrderNumber, description, clientName } = req.body;
    
    if (!supplierName || !purchaseOrderNumber || !description || !clientName) {
      return res.status(400).json({ 
        error: 'Missing required fields: supplierName, purchaseOrderNumber, description, clientName' 
      });
    }
    
    const order = await InboundOrder.create({
      supplierName,
      purchaseOrderNumber,
      description,
      clientName
    });
    
    res.status(201).json({ data: order });
  } catch (error) {
    console.error('Error creating inbound order:', error);
    res.status(500).json({ error: 'Failed to create inbound order' });
  }
});

// PUT update inbound order
router.put('/:id', async (req, res) => {
  try {
    const order = await InboundOrder.findByPk(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Inbound order not found' });
    }
    
    const { supplierName, purchaseOrderNumber, description, clientName } = req.body;
    
    await order.update({
      supplierName: supplierName || order.supplierName,
      purchaseOrderNumber: purchaseOrderNumber || order.purchaseOrderNumber,
      description: description || order.description,
      clientName: clientName || order.clientName
    });
    
    res.json({ data: order });
  } catch (error) {
    console.error('Error updating inbound order:', error);
    res.status(500).json({ error: 'Failed to update inbound order' });
  }
});

// DELETE inbound order
router.delete('/:id', async (req, res) => {
  try {
    const order = await InboundOrder.findByPk(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Inbound order not found' });
    }
    
    await order.destroy();
    
    res.json({ message: 'Inbound order deleted successfully' });
  } catch (error) {
    console.error('Error deleting inbound order:', error);
    res.status(500).json({ error: 'Failed to delete inbound order' });
  }
});

module.exports = router;
