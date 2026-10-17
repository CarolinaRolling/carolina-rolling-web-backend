/**
 * 0004 — idempotency_keys (round 12, audits N19 / N23 / R30). A client that retries a request — a
 * double-click on "Record payment", or a tablet that timed out creating a shipment and tapped again —
 * sends the same Idempotency-Key header; the server answers the retry with the first result instead of
 * doing it twice. Rows older than a day are pruned. Safe to re-run.
 */
module.exports = {
  async up({ sequelize }) {
    await sequelize.query(`CREATE TABLE IF NOT EXISTS idempotency_keys (
      "key" VARCHAR(200) PRIMARY KEY,
      "method" VARCHAR(10) NOT NULL,
      "path" VARCHAR(500) NOT NULL,
      "status" INTEGER,
      "body" JSONB,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys ("createdAt")`);
    return 'idempotency_keys';
  },
};
