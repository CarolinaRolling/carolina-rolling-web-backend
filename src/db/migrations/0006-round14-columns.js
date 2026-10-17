/**
 * 0006 — round 14 columns (before the FK migration: a lock timeout there must never keep these columns out). Safe to re-run.
 *  - work_order_payments.cardSurcharge / client_payments.cardSurcharge: the card surcharge a customer
 *    paid on top of an invoice, kept apart from the invoice payment (audit T6)
 *  - work_orders.estimateLinkSnapshot: values an estimate link overwrote, restored on unlink (T22)
 *  - credit_memos.sourceWorkOrderId: an invoice overpayment moved to client credit (T4)
 *  - estimates.customerReference: the customer's RFQ reference on email-scanned estimates (R22);
 *    indexed for the duplicate check (client + reference)
 */
module.exports = {
  async up({ sequelize }) {
    await sequelize.query(`ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS "cardSurcharge" DECIMAL(10,2)`);
    await sequelize.query(`ALTER TABLE client_payments ADD COLUMN IF NOT EXISTS "cardSurcharge" DECIMAL(10,2)`);
    await sequelize.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS "estimateLinkSnapshot" JSONB`);
    await sequelize.query(`ALTER TABLE estimates ADD COLUMN IF NOT EXISTS "customerReference" VARCHAR(255)`);
    // an overpayment on an invoice moved to client credit (T4): the memo remembers which invoice it settles
    await sequelize.query(`ALTER TABLE credit_memos ADD COLUMN IF NOT EXISTS "sourceWorkOrderId" UUID`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS estimates_customer_reference_idx ON estimates (lower(trim("customerReference"))) WHERE "customerReference" IS NOT NULL`);
    return 'cardSurcharge, estimateLinkSnapshot, customerReference, credit_memos.sourceWorkOrderId';
  },
};
