const express = require('express');
const { DeletionArchive } = require('../models');
const { Op } = require('sequelize');
const { requireAdmin } = require('./auth');

const router = express.Router();

/**
 * Read access to the deletion archive.
 *
 * The archive exists so a mistaken delete is recoverable. These endpoints let you find and
 * inspect what was removed; they deliberately do NOT auto-restore. Re-inserting a work order
 * and its parts touches DR numbers, PO links, inbound orders and file records, and doing that
 * blindly could collide with whatever was created after the delete. Pull the snapshot, look at
 * it, then decide.
 */

// GET /api/deletion-archive — most recent deletions, newest first.
// Optional: ?model=WorkOrder  ?search=DR-2963  ?limit=50
router.get('/', async (req, res, next) => {
  try {
    const { model, search, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (model) where.modelName = model;
    if (search) {
      where[Op.or] = [
        { label: { [Op.iLike]: `%${search}%` } },
        { recordId: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows, count } = await DeletionArchive.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0,
      // The snapshot can be large — omit it from the list and fetch it per record.
      attributes: ['id', 'modelName', 'recordId', 'label', 'deletedBy', 'reason', 'createdAt'],
    });

    res.json({ data: rows, total: count });
  } catch (error) {
    next(error);
  }
});

// GET /api/deletion-archive/:id — the full snapshot, including children.
router.get('/:id', async (req, res, next) => {
  try {
    const entry = await DeletionArchive.findByPk(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: { message: 'Archive entry not found' } });
    }
    res.json({ data: entry });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/deletion-archive/:id — purge one entry. Admin only: this is the one action here
// that destroys the safety net itself.
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const entry = await DeletionArchive.findByPk(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: { message: 'Archive entry not found' } });
    }
    await entry.destroy();
    res.json({ message: 'Archive entry purged' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
