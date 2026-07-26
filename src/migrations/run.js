require('dotenv').config();

/**
 * DISABLED — this script used to run `sequelize.sync({ alter: true })`, which is exactly what
 * dropped-and-recreated columns on every invocation and eventually drove work_order_parts into
 * Postgres's 1600-column ceiling, taking the app down.
 *
 * The live schema is now managed entirely by the `ADD COLUMN IF NOT EXISTS` migration block in
 * src/index.js, which runs on every boot and never drops anything. There is no longer any
 * reason to run a sync-based migration, and doing so against production would re-create the
 * outage — so this script now refuses to run rather than quietly doing damage.
 *
 * To add a column: add it to the model AND add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 * line to the migrations array in src/index.js. That is the single source of truth.
 */

console.error('`npm run migrate` is disabled. Schema changes are handled by the migration');
console.error('block in src/index.js (ADD COLUMN IF NOT EXISTS). See that file for details.');
console.error('');
console.error('Running sync({ alter: true }) here is what caused the 2026-07 column-limit');
console.error('outage — it will not be re-enabled.');
process.exit(1);
