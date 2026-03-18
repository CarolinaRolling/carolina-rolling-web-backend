const express = require('express');
const { TodoItem, User } = require('../models');
const { Op } = require('sequelize');

const router = express.Router();

// GET /api/todos - Get open todos (and recent completed)
router.get('/', async (req, res, next) => {
  try {
    const showCompleted = req.query.showCompleted === 'true';
    const where = showCompleted
      ? {} 
      : { status: { [Op.in]: ['open'] } };

    const items = await TodoItem.findAll({
      where,
      order: [
        ['status', 'ASC'], // open first
        ['priority', 'ASC'], // urgent first (alphabetical: high, low, normal, urgent — need custom)
        ['createdAt', 'DESC']
      ]
    });

    // Custom sort: urgent > high > normal > low, then by date
    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    const sorted = items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      const ap = priorityOrder[a.priority] ?? 2;
      const bp = priorityOrder[b.priority] ?? 2;
      if (ap !== bp) return ap - bp;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json({ data: sorted });
  } catch (error) {
    next(error);
  }
});

// POST /api/todos - Create a new todo
router.post('/', async (req, res, next) => {
  try {
    const { title, description, type, priority, assignedTo, estimateId, estimateNumber } = req.body;
    if (!title) {
      return res.status(400).json({ error: { message: 'Title is required' } });
    }

    let finalAssignedTo = assignedTo || null;

    // Auto-assign estimate reviews to head estimator
    if (type === 'estimate_review' && !finalAssignedTo) {
      const headEstimator = await User.findOne({ where: { isHeadEstimator: true, isActive: true } });
      if (headEstimator) {
        finalAssignedTo = headEstimator.username;
      }
    }

    const item = await TodoItem.create({
      title,
      description: description || null,
      type: type || 'general',
      priority: priority || 'normal',
      assignedTo: finalAssignedTo,
      estimateId: estimateId || null,
      estimateNumber: estimateNumber || null,
      createdBy: req.user?.username || 'system'
    });

    res.status(201).json({ data: item, message: 'Task created' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/todos/:id - Update a todo
router.put('/:id', async (req, res, next) => {
  try {
    const item = await TodoItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Task not found' } });

    const { title, description, priority, assignedTo, status } = req.body;
    await item.update({
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(priority !== undefined && { priority }),
      ...(assignedTo !== undefined && { assignedTo }),
      ...(status !== undefined && { status })
    });

    res.json({ data: item, message: 'Task updated' });
  } catch (error) {
    next(error);
  }
});

// POST /api/todos/:id/complete - Mark as completed
router.post('/:id/complete', async (req, res, next) => {
  try {
    const item = await TodoItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Task not found' } });

    await item.update({
      status: 'completed',
      completedBy: req.user?.username || 'unknown',
      completedAt: new Date()
    });

    res.json({ data: item, message: 'Task completed' });
  } catch (error) {
    next(error);
  }
});

// POST /api/todos/:id/accept - Accept estimate review
router.post('/:id/accept', async (req, res, next) => {
  try {
    const item = await TodoItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Task not found' } });

    const reviewerName = req.user?.username || 'unknown';

    await item.update({
      status: 'accepted',
      completedBy: reviewerName,
      completedAt: new Date()
    });

    // Create notification for all users that review is complete
    if (item.type === 'estimate_review' && item.estimateId) {
      // Look up estimate for number and client name
      const { Estimate } = require('../models');
      let estLabel = item.estimateNumber || 'Estimate';
      let clientName = '';
      try {
        const est = await Estimate.findByPk(item.estimateId);
        if (est) {
          estLabel = est.estimateNumber || estLabel;
          clientName = est.clientName || '';
        }
      } catch (e) { /* ignore lookup failure */ }

      const titleParts = [estLabel];
      if (clientName) titleParts.push(clientName);

      await TodoItem.create({
        title: `✅ ${titleParts.join(' — ')} review complete — ready to send`,
        description: `Reviewed and approved by ${reviewerName}. Estimate is ready to be sent to the client.`,
        type: 'general',
        priority: 'normal',
        estimateId: item.estimateId,
        estimateNumber: estLabel,
        createdBy: reviewerName
      });
    }

    res.json({ data: item, message: 'Estimate accepted' });
  } catch (error) {
    next(error);
  }
});

// POST /api/todos/:id/deny - Deny estimate review
router.post('/:id/deny', async (req, res, next) => {
  try {
    const item = await TodoItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Task not found' } });

    const { reason } = req.body;
    await item.update({
      status: 'denied',
      deniedReason: reason || '',
      completedBy: req.user?.username || 'unknown',
      completedAt: new Date()
    });

    res.json({ data: item, message: 'Estimate denied' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/todos/:id - Delete a todo
router.delete('/:id', async (req, res, next) => {
  try {
    const item = await TodoItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: { message: 'Task not found' } });
    await item.destroy();
    res.json({ message: 'Task deleted' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
