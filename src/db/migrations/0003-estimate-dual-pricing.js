/**
 * 0003 — estimates.showDualPricing (round 10, R32). The estimate screen's "Show dual pricing" box and
 * the estimate PDF both used it, but the column only existed on work orders, so it never saved.
 * Adds one column with a default; existing estimates are unchanged. Safe to re-run.
 */
module.exports = {
  async up({ sequelize }) {
    await sequelize.query(`ALTER TABLE estimates ADD COLUMN IF NOT EXISTS "showDualPricing" BOOLEAN NOT NULL DEFAULT false`);
    return 'estimates.showDualPricing';
  },
};
