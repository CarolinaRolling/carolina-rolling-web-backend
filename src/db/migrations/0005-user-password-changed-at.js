/**
 * 0005 — users.passwordChangedAt (round 12, R34 / N24). A sign-in token issued before the password was
 * last changed is refused, so changing a password (or an admin resetting it) signs that user out
 * everywhere. Existing users get NULL (no tokens are invalidated by the deploy). Safe to re-run.
 */
module.exports = {
  async up({ sequelize }) {
    await sequelize.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMPTZ`);
    return 'users.passwordChangedAt';
  },
};
