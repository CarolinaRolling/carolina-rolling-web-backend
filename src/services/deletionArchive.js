/**
 * Snapshot a record (and optionally its children) before deleting it.
 *
 * Nothing in this system was soft-deleted and deletes were barely logged, so a mistaken delete
 * was unrecoverable and often untraceable. This writes a JSON snapshot to `deletion_archive`
 * first, which changes no existing query behaviour and works for every model.
 *
 * Archiving must never block the delete the user asked for. If archiving fails it logs loudly
 * and returns false; the caller proceeds. Losing the safety net is bad, but refusing to delete
 * because the safety net is broken would be worse.
 */

async function archiveRecord(instance, options = {}) {
  const { modelName, label, deletedBy, reason, include = [], transaction } = options;
  if (!instance) return false;

  try {
    const { DeletionArchive } = require('../models');

    // toJSON() on an instance loaded with includes already carries the children.
    const snapshot = typeof instance.toJSON === 'function' ? instance.toJSON() : instance;

    for (const child of include) {
      if (snapshot[child] === undefined) continue;
    }

    await DeletionArchive.create({
      modelName: modelName || instance.constructor?.name || 'unknown',
      recordId: String(instance.id ?? snapshot.id ?? ''),
      label: label || null,
      snapshot,
      deletedBy: deletedBy || null,
      reason: reason || null,
    }, transaction ? { transaction } : {});

    return true;
  } catch (err) {
    console.error('[deletionArchive] FAILED to archive before delete —',
      options.modelName || 'record', options.label || '', err.message);
    return false;
  }
}

/**
 * Convenience label builder so archived rows are findable without parsing JSON.
 */
function labelFor(record) {
  if (!record) return null;
  if (record.drNumber) return `DR-${record.drNumber}`;
  if (record.estimateNumber) return String(record.estimateNumber);
  if (record.orderNumber) return String(record.orderNumber);
  if (record.poNumber) return `PO${record.poNumber}`;
  if (record.name) return String(record.name);
  return null;
}

module.exports = { archiveRecord, labelFor };
