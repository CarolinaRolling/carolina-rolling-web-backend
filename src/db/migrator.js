/**
 * Schema migrations (audit M9).
 *
 * Each file in src/db/migrations (NNNN-description.js, run in name order) exports
 *   module.exports = { async up({ sequelize, queryInterface, models }) { … } }
 * and runs ONCE per database; what has run is recorded in the schema_migrations table.
 *
 * Migrations run at startup before anything else touches the schema. A Postgres advisory lock makes
 * sure only one server process runs them even when several dynos start together; the others
 * skip. Migrations are not wrapped in a transaction (so DDL that can't run in one, like
 * CREATE INDEX CONCURRENTLY, is allowed). RULE: every migration must be safe to run again after a
 * partial failure (IF NOT EXISTS, guarded UPDATEs) — it is recorded only after it succeeds — a failed migration is retried on the next start and stops the ones after it.
 *
 * The older ALTER/CREATE statements in src/index.js still run on every boot as before (they are all
 * written to be safe to repeat). New schema changes go here instead:
 *   1. add the field to the model in src/models/index.js
 *   2. add src/db/migrations/NNNN-what-it-does.js using ADD COLUMN IF NOT EXISTS / CREATE … IF NOT EXISTS
 *   3. `npm run migrate:status` shows what has and hasn't run
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 8410099;

function listMigrations() {
  return fs.readdirSync(DIR).filter(f => /^\d{4}-.+\.js$/.test(f)).sort();
}

async function ensureTable(sequelize) {
  await sequelize.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) PRIMARY KEY, run_at TIMESTAMPTZ NOT NULL DEFAULT now(), result TEXT)`);
}

async function applied(sequelize) {
  const [rows] = await sequelize.query(`SELECT name, run_at, result FROM schema_migrations ORDER BY name`);
  return rows;
}

/** Run every migration that hasn't run yet. Returns [{ name, result }]. Throws on the first failure. */
async function runMigrations(sequelize, { log = console.log } = {}) {
  const pending = () => applied(sequelize).then(rows => { const done = new Set(rows.map(r => r.name)); return listMigrations().filter(f => !done.has(f)); });
  // Advisory lock held by an open transaction on one connection for as long as the migrations run.
  // TRY-lock: a server starting while another is already migrating skips (it doesn't queue up behind
  // it and then retry a migration that just failed). Migrations run on other pooled connections — do
  // not enable Sequelize CLS, or they would join this transaction.
  return sequelize.transaction(async (lockTx) => {
    const [[{ got }]] = await sequelize.query(`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS got`, { transaction: lockTx });
    if (!got) { log('[migrate] another server is running migrations — skipping here'); return []; }
    // created under the lock: two CREATE TABLE IF NOT EXISTS at the same instant can collide in Postgres
    await ensureTable(sequelize);
    const ran = [];
    for (const name of await pending()) {
      const mod = require(path.join(DIR, name));
      log(`[migrate] running ${name}…`);
      const result = await mod.up({ sequelize, queryInterface: sequelize.getQueryInterface(), models: sequelize.models });
      await sequelize.query(`INSERT INTO schema_migrations (name, result) VALUES (:name, :result) ON CONFLICT (name) DO NOTHING`,
        { replacements: { name, result: result ? String(result).slice(0, 2000) : null } });
      log(`[migrate] ${name} done${result ? ': ' + result : ''}`);
      ran.push({ name, result });
    }
    return ran;
  });
}

async function status(sequelize) {
  await ensureTable(sequelize);
  const done = new Map((await applied(sequelize)).map(r => [r.name, r]));
  return listMigrations().map(name => ({ name, ran: done.has(name), at: done.get(name)?.run_at || null, result: done.get(name)?.result || null }));
}

module.exports = { runMigrations, status, listMigrations };
