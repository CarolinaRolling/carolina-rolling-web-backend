/**
 * 0008 — refunds.creditMemoId (round 16): a refund paid out of a credit memo remembers it, so voiding
 * the refund puts the credit back on the memo. Safe to re-run.
 */
module.exports = {
  async up({ sequelize }) {
    await sequelize.query(`ALTER TABLE refunds ADD COLUMN IF NOT EXISTS "creditMemoId" UUID`);
    return 'refunds.creditMemoId';
  },
};
