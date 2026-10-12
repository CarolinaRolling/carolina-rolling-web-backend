/**
 * 0002 — columns the Undo feature needs on deletion_archive (round 8). Adds columns and indexes
 * only; existing archive rows are kept as they are (they show as "older snapshot" and can be viewed,
 * not undone automatically). Safe to re-run.
 */
module.exports = {
  async up({ sequelize }) {
    const q = (sql) => sequelize.query(sql);
    await q(`ALTER TABLE deletion_archive ADD COLUMN IF NOT EXISTS "tableName" VARCHAR(255)`);
    await q(`ALTER TABLE deletion_archive ADD COLUMN IF NOT EXISTS "groupId" UUID`);
    await q(`ALTER TABLE deletion_archive ADD COLUMN IF NOT EXISTS "storageIds" TEXT[]`);
    await q(`ALTER TABLE deletion_archive ADD COLUMN IF NOT EXISTS "restoredAt" TIMESTAMPTZ`);
    await q(`ALTER TABLE deletion_archive ADD COLUMN IF NOT EXISTS "restoredBy" VARCHAR(255)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_deletion_archive_group ON deletion_archive ("groupId")`);
    await q(`CREATE INDEX IF NOT EXISTS idx_deletion_archive_storage ON deletion_archive USING GIN ("storageIds")`);
    return 'deletion_archive: tableName, groupId, storageIds, restoredAt, restoredBy';
  },
};
