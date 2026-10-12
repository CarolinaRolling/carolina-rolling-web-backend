/**
 * fileRefs — delete a stored file (S3 / Cloudinary) only when nothing else still points at it
 * (audit H13).
 *
 * Before: several features re-use the same stored file instead of copying it — converting an
 * estimate copies its part files and documents onto the work order with the SAME storage id, and a
 * scanned delivery paper is linked to the shipment with the same id. Deleting the file in one place
 * (or deleting the estimate) destroyed the object the other record still showed, leaving a broken
 * link on the work order.
 *
 * Now every delete site calls `deleteStoredFileIfUnused(id, { exclude })` AFTER its own row is gone
 * (or names the rows about to go in `exclude`), and the object is only removed when no row in any
 * table below still references it. If the check itself fails, the file is kept — a leftover file
 * costs a few cents; a missing one is a broken record.
 */
const fileStorage = require('../utils/storage');

// Every column that holds a storage id
const REFS = [
  ['work_order_part_files', 'cloudinaryId'],
  ['work_order_documents', 'cloudinaryId'],
  ['estimate_part_files', 'cloudinaryId'],
  ['estimate_files', 'cloudinaryId'],
  ['shipment_photos', 'cloudinaryId'],
  ['shipment_documents', 'cloudinaryId'],
  ['inbound_paperwork', 'storageId'],
  ['work_orders', 'invoicePdfCloudinaryId'],
  ['shop_supplies', 'imageCloudinaryId'],
  ['liabilities', 'invoiceFileCloudinaryId'],
  ['work_order_messages', 'imageStorageId'],
  ['vendor_issues', 'photoStorageId'],
];

let undoTableSet = null;
function undoTables() {
  if (!undoTableSet) {
    const models = require('../models');
    undoTableSet = new Set(require('./undo').ARCHIVED_MODELS.map(n => models[n] && models[n].getTableName()).filter(Boolean));
  }
  return undoTableSet;
}

let existingRefs = null;   // the subset of REFS that exist in this database (checked once)
async function refsInDb(sequelize) {
  if (existingRefs) return existingRefs;
  const [rows] = await sequelize.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`);
  const have = new Set(rows.map(r => `${r.table_name}.${r.column_name}`));
  existingRefs = REFS.filter(([t, c]) => have.has(`${t}.${c}`));
  return existingRefs;
}

/**
 * How many rows reference `storageId`, not counting the rows listed in `exclude`
 * ([{ table, id }] — rows that are being deleted in the same operation).
 */
async function countReferences(storageId, { exclude = [], transaction } = {}) {
  const { sequelize } = require('../models');
  const refs = await refsInDb(sequelize);
  let total = 0;
  // A deleted record that can still be undone keeps its files (round 8). The GIN index makes this cheap.
  try {
    const [[{ n }]] = await sequelize.query(`SELECT COUNT(*)::int AS n FROM deletion_archive WHERE "storageIds" @> ARRAY[:id]::text[] AND "restoredAt" IS NULL`,
      { replacements: { id: storageId }, transaction });
    total += n;
  } catch (_) { /* archive columns not there yet (before migration 0002) */ }
  for (const [table, col] of refs) {
    const skip = exclude.filter(e => e.table === table).map(e => e.id).filter(Boolean);
    const [[{ n }]] = await sequelize.query(
      `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${col}" = :id` + (skip.length ? ` AND id NOT IN (:skip)` : ''),
      { replacements: { id: storageId, skip }, transaction });
    total += n;
  }
  return total;
}

/** Delete the stored object unless another row still uses it. Never throws. Returns true if deleted. */
const RECHECK_MS = parseInt(process.env.FILE_RECHECK_MS) || 60 * 1000;
async function deleteStoredFileIfUnused(storageId, { exclude, resourceType, transaction, recheck = false } = {}) {
  if (!storageId) return false;
  // The row being removed is one Deleted Items can bring back (round 8), and this call comes before
  // its delete — the snapshot that will hold the file doesn't exist yet. Check again shortly, after
  // the delete: by then the snapshot references the file (kept until it expires), or — if no snapshot
  // was taken (paused during a restore, or it failed) — nothing does and the file is removed then.
  if (!recheck && (exclude || []).some(e => undoTables().has(e.table))) {
    const t = setTimeout(() => deleteStoredFileIfUnused(storageId, { resourceType, recheck: 1 }).catch(() => {}), RECHECK_MS);
    if (t.unref) t.unref();
    console.log(`[files] kept ${storageId} for now: its record can be undone (checked again after the delete)`);
    return false;
  }
  try {
    const n = await countReferences(storageId, { exclude, transaction });
    if (n > 0) {
      console.log(`[files] kept ${storageId}: still used by ${n} other record(s)`);
      // A re-check that still finds a user may have run before a slow delete committed: look twice more
      if (recheck && recheck < 3) { const t = setTimeout(() => deleteStoredFileIfUnused(storageId, { resourceType, recheck: recheck + 1 }).catch(() => {}), RECHECK_MS * 10); if (t.unref) t.unref(); }
      return false;
    }
  } catch (e) {
    console.warn(`[files] could not check references for ${storageId}, keeping it: ${e.message}`);
    return false;
  }
  try {
    // 'any': the caller doesn't know how the file was stored (Cloudinary keeps images and other files
    // apart and ignores a delete of the wrong kind) — try both. S3 ids have one kind.
    if (resourceType === 'any') {
      await fileStorage.deleteFile(storageId, 'raw');
      if (!String(storageId).startsWith('s3:')) await fileStorage.deleteFile(storageId, 'image');
    } else await fileStorage.deleteFile(storageId, resourceType);
    return true;
  }
  catch (e) { console.warn(`[files] delete failed for ${storageId}: ${e.message}`); return false; }
}

/** Same, for many ids — run after the database change has committed. */
async function deleteStoredFilesIfUnused(ids, opts) {
  for (const id of [...new Set((ids || []).filter(Boolean))]) await deleteStoredFileIfUnused(id, opts);
}

module.exports = { deleteStoredFileIfUnused, deleteStoredFilesIfUnused, countReferences, REFS };
