/**
 * 0009 — work_orders.lotSuffixHighWater (round 17, W6): the highest lot suffix (<DR>-n) ever handed out
 * on the order, so a deleted part's lot is never issued again. Seeded from the "<current DR>-n" lots (n of
 * 1-9 digits) on each order's live parts (only raises it). Safe to re-run.
 */
module.exports = {
  async up({ sequelize }) {
    await sequelize.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "lotSuffixHighWater" INTEGER`);
    const [, meta] = await sequelize.query(`UPDATE work_orders w SET "lotSuffixHighWater" = s.hw
      FROM (SELECT p."workOrderId", MAX(substring(trim(p."lotNumber") from '^[0-9]+-([0-9]{1,9})$')::int) AS hw
            FROM work_order_parts p JOIN work_orders o ON o.id = p."workOrderId"
            WHERE o."drNumber" IS NOT NULL AND trim(p."lotNumber") ~ ('^' || o."drNumber"::text || '-[0-9]{1,9}$')
            GROUP BY p."workOrderId") s
      WHERE w.id = s."workOrderId" AND COALESCE(w."lotSuffixHighWater", 0) < s.hw`);
    return `work_orders.lotSuffixHighWater (seeded on ${(meta && meta.rowCount) || 0} order(s))`;
  },
};
