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
async function deleteStoredFileIfUnused(storageId, { exclude, resourceType, transaction } = {}) {
  if (!storageId) return false;
  try {
    const n = await countReferences(storageId, { exclude, transaction });
    if (n > 0) {
      console.log(`[files] kept ${storageId}: still used by ${n} other record(s)`);
      return false;
    }
  } catch (e) {
    console.warn(`[files] could not check references for ${storageId}, keeping it: ${e.message}`);
    return false;
  }
  try { await fileStorage.deleteFile(storageId, resourceType); return true; }
  catch (e) { console.warn(`[files] delete failed for ${storageId}: ${e.message}`); return false; }
}

/** Same, for many ids — run after the database change has committed. */
async function deleteStoredFilesIfUnused(ids, opts) {
  for (const id of [...new Set((ids || []).filter(Boolean))]) await deleteStoredFileIfUnused(id, opts);
}

module.exports = { deleteStoredFileIfUnused, deleteStoredFilesIfUnused, countReferences, REFS };
