const express = require('express');
const { DeletionArchive } = require('../models');
const { Op } = require('sequelize');
const { requireAdmin } = require('./auth');

const undo = require('../services/undo');

const router = express.Router();
// Deleted records can hold anything (payments, employees) and Undo changes live data: admins only.
router.use(requireAdmin);

/**
 * Deleted Items (round 8): browse what was deleted, see the snapshot, and Undo.
 *
 * Every delete of a business record is snapshotted first (services/undo). Undo puts back the whole
 * group deleted together — a work order with its parts, files and messages — in one transaction:
 * all of it comes back, or nothing does and the reason is shown (e.g. the DR number was reused).
 */

// GET /api/deletion-archive — most recent deletions, newest first.
// Optional: ?model=WorkOrder  ?search=DR-2963  ?limit=50
router.get('/', async (req, res, next) => {
  try {
    const { model, search: rawSearch, limit = 50, offset = 0, status, groupId } = req.query;
    const search = rawSearch && String(rawSearch).replace(/[\\%_]/g, (c) => '\\' + c);   // match % and _ literally
    const where = {};
    if (groupId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId)) return res.status(400).json({ error: { message: 'Invalid groupId' } });
      where.groupId = groupId;
    }
    if (model) where.modelName = model;
    if (status === 'deleted') where.restoredAt = null;
    if (status === 'restored') where.restoredAt = { [Op.ne]: null };
    if (search) {
      where[Op.or] = [
        { label: { [Op.iLike]: `%${search}%` } },
        { recordId: { [Op.iLike]: `%${search}%` } },
        { deletedBy: { [Op.iLike]: `%${search}%` } },
        { reason: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows, count } = await DeletionArchive.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: Math.min(parseInt(limit, 10) || 50, 500),
      offset: parseInt(offset, 10) || 0,
      // The snapshot can be large — omit it from the list and fetch it per record.
      attributes: ['id', 'modelName', 'tableName', 'recordId', 'label', 'deletedBy', 'reason', 'createdAt',
        'groupId', 'restoredAt', 'restoredBy', 'storageIds'],
    });

    res.json({ data: rows.map(r => ({ ...r.toJSON(), undoable: !!r.tableName && !r.restoredAt })), total: count });
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

// POST /api/deletion-archive/:id/undo — restore this deletion (and everything deleted with it)
router.post('/:id/undo', async (req, res, next) => {
  try {
    const result = await undo.undoDeletion(req.params.id, { by: req.user?.username });
    const message = result.alreadyThere
      ? 'Nothing needed restoring: those records are still there (the delete did not go through).'
      : `Restored ${result.restored} item(s)` + (result.truncated ? '. Note: this was a very large delete — some deeply nested records were not saved and could not be brought back.' : '');
    res.json({ data: result, message });
  } catch (error) {
    if (error instanceof undo.UndoError) return res.status(error.status).json({ error: { message: error.message } });
    next(error);
  }
});

// DELETE /api/deletion-archive/:id — purge one entry (destroys the safety net for it)
router.delete('/:id', async (req, res, next) => {
  try {
    const entry = await DeletionArchive.findByPk(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: { message: 'Archive entry not found' } });
    }
    await entry.destroy();
    const { deleteStoredFilesIfUnused } = require('../services/fileRefs');
    if (entry.storageIds?.length && !entry.restoredAt) deleteStoredFilesIfUnused(entry.storageIds, { resourceType: 'any' }).catch(() => {});
    res.json({ message: 'Archive entry purged' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
