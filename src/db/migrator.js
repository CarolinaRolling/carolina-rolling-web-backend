/**
 * Schema migrations (audit M9).
 *
 * Each file in src/db/migrations (NNNN-description.js, run in name order) exports
 *   module.exports = { async up({ sequelize, queryInterface, models }) { … } }
 * and runs ONCE per database; what has run is recorded in the schema_migrations table.
 *
 * Migrations run at startup before anything else touches the schema. A Postgres advisory lock makes
 * sure only one server process runs them even when several dynos start together; the others
 * wait for it to finish (up to 2 minutes), then re-check. Migrations are not wrapped in a transaction (so DDL that can't run in one, like
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

// ---- DDL that is already done (audits U26 / U27) -------------------------------------------------
// ALTER TABLE … ADD COLUMN IF NOT EXISTS / ALTER COLUMN TYPE take an ACCESS EXCLUSIVE lock even when
// there is nothing to do, so under a long read they queue every query on the table. ddlAlreadyDone()
// answers from the catalogs (no table lock) whether a statement would change anything: true = done,
// skip it; false = needed or not understood (run it as before).
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const identName = (t) => (t[0] === '"' ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase());
// split "a, b(1,2), c" at top-level commas (outside parentheses and quotes)
function splitTopLevel(text) {
  const out = []; let depth = 0, cur = '', quote = null;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// a type as written in DDL → format_type() spelling; null when not recognised
function normType(t) {
  const s = t.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
  let m;
  if ((m = s.match(/^(?:decimal|numeric)\((\d+)(?:,(\d+))?\)$/))) return `numeric(${m[1]},${m[2] || 0})`;
  if ((m = s.match(/^(?:varchar|character varying)\((\d+)\)$/))) return `character varying(${m[1]})`;
  const plain = { 'decimal': 'numeric', 'numeric': 'numeric', 'varchar': 'character varying', 'character varying': 'character varying',
    'text': 'text', 'uuid': 'uuid', 'jsonb': 'jsonb', 'json': 'json', 'boolean': 'boolean', 'bool': 'boolean', 'date': 'date',
    'int': 'integer', 'integer': 'integer', 'int4': 'integer', 'bigint': 'bigint', 'int8': 'bigint', 'smallint': 'smallint', 'int2': 'smallint',
    'double precision': 'double precision', 'float8': 'double precision', 'real': 'real', 'float4': 'real',
    'timestamptz': 'timestamp with time zone', 'timestamp with time zone': 'timestamp with time zone',
    'timestamp': 'timestamp without time zone', 'timestamp without time zone': 'timestamp without time zone' };
  return plain[s] || null;
}
async function ddlAlreadyDone(run, sql) {
  try {
    const text = String(sql).trim().replace(/;\s*$/, '');
    // More than one statement (a ";" outside quotes): only the first would be checked — run it (review of round 15)
    if (/;/.test(text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\$\$[\s\S]*?\$\$/g, ''))) return false;
    let m;
    // CREATE TABLE / INDEX IF NOT EXISTS name
    if ((m = text.match(new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(${QNAME})`, 'i')))
      || (m = text.match(new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+(${IDENT})\\s+ON\\b`, 'i')))) {
      const [[r]] = await run(`SELECT to_regclass(:n) IS NOT NULL AS ok`, { replacements: { n: m[1] } });
      return !!(r && r.ok);
    }
    m = text.match(new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QNAME})\\s+([\\s\\S]+)$`, 'i'));
    if (!m) return false;
    const table = m[1];
    const actions = splitTopLevel(m[2]);
    if (!actions.length) return false;
    const [cols] = await run(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
      WHERE a.attrelid = to_regclass(:t) AND a.attnum > 0 AND NOT a.attisdropped`, { replacements: { t: table } });
    if (!cols.length) return false;   // table missing (or not understood): run it, as before
    const have = new Map(cols.map(c => [c.name, c.type]));
    for (const a of actions) {
      let x;
      if ((x = a.match(new RegExp(`^ADD\\s+(?:COLUMN\\s+)?IF\\s+NOT\\s+EXISTS\\s+(${IDENT})\\s`, 'i')))) {
        if (!have.has(identName(x[1]))) return false;
      } else if ((x = a.match(new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+([\\s\\S]+?)(?:\\s+USING\\s[\\s\\S]*)?$`, 'i')))) {
        const want = normType(x[2]);
        if (!want || have.get(identName(x[1])) !== want) return false;
      } else return false;
    }
    return true;
  } catch (_) { return false; }   // never let the check itself stop a change
}

const isLockTimeout = (e) => (e && (e.parent?.code || e.original?.code)) === '55P03' || /lock timeout/i.test((e && e.message) || '');

/**
 * The `sequelize` a migration receives (U26): the same instance, except that a schema change issued
 * outside a transaction runs in its own short transaction with SET LOCAL lock_timeout, so it waits at
 * most `timeout` for its table lock instead of queueing every query on that table behind a long read.
 * A timed-out statement is retried (`attempts` in all, backing off 2 s, 4 s, 8 s …); still locked →
 * throws a "lock timeout" error, which fails the migration (retried in the background / next start).
 * Changes already in place (ddlAlreadyDone) are skipped without taking any lock.
 */
function lockLimitedSequelize(sequelize, { timeout = '5s', attempts = 4, log = console.log } = {}) {
  const DDL = /^\s*(ALTER|CREATE|DROP|DO|COMMENT)\b/i;
  const original = (sql, options) => sequelize.query(sql, options);
  const proxy = Object.create(sequelize);
  proxy.query = async function (sql, options) {
    const text = typeof sql === 'string' ? sql : (sql && sql.query) || '';
    if ((options && options.transaction) || !DDL.test(text) || /\bCONCURRENTLY\b/i.test(text) || /^\s*ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i.test(text)) {
      return original(sql, options);
    }
    if (await ddlAlreadyDone(original, text)) return [[], null];
    const what = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    for (let n = 1; ; n++) {
      try {
        return await sequelize.transaction(async (t) => {
          await original(`SET LOCAL lock_timeout = '${timeout}'`, { transaction: t });
          return original(sql, { ...(options || {}), transaction: t });
        });
      } catch (e) {
        if (!isLockTimeout(e)) throw e;
        if (n >= attempts) throw new Error(`lock timeout: table busy, lock not available within ${timeout} (${attempts} tries): ${what}`);
        log(`[migrate] table busy (lock not available within ${timeout}) — retrying in ${2 ** n}s: ${what}`);
        await new Promise(r => setTimeout(r, 2000 * 2 ** (n - 1)));
      }
    }
  };
  return proxy;
}

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

/**
 * Run every migration that hasn't run yet. Returns [{ name, result }]. Throws on the first failure.
 *
 * Several dynos starting together: one takes the advisory lock and migrates. The others used to skip
 * and serve on a schema that wasn't finished yet (round 13, R23). Now they WAIT — polling the lock
 * every `pollMs` (default 2 s) for up to `waitMs` (default 120 s) — and once it is free take it
 * themselves and re-check what is pending: normally nothing (the other server finished), and if that
 * server crashed or a migration failed there, it is retried here (every migration is safe to re-run).
 * Each migration's schema changes wait at most `lockTimeout` per try for their table lock, `lockAttempts`
 * tries (U26); a table still busy fails the migration with a "lock timeout" error.
 * Still locked after `waitMs` → throws, so startup reports the migration as failed (/health 503)
 * instead of claiming the database is up to date.
 */
async function runMigrations(sequelize, { log = console.log, pollMs = 2000, waitMs = 120000, lockTimeout = '5s', lockAttempts = 4 } = {}) {
  const pending = () => applied(sequelize).then(rows => { const done = new Set(rows.map(r => r.name)); return listMigrations().filter(f => !done.has(f)); });
  const started = Date.now();
  let waited = false;
  for (;;) {
    // Advisory lock held by an open transaction on one connection for as long as the migrations run.
    // Migrations run on other pooled connections — do not enable Sequelize CLS, or they would join
    // this transaction.
    const out = await sequelize.transaction(async (lockTx) => {
      const [[{ got }]] = await sequelize.query(`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS got`, { transaction: lockTx });
      if (!got) return null;
      if (waited) log(`[migrate] the other server finished after ${Math.round((Date.now() - started) / 1000)}s — re-checking pending migrations`);
      // created under the lock: two CREATE TABLE IF NOT EXISTS at the same instant can collide in Postgres
      await ensureTable(sequelize);
      const ran = [];
      const migSeq = lockLimitedSequelize(sequelize, { timeout: lockTimeout, attempts: lockAttempts, log });   // U26
      for (const name of await pending()) {
        const mod = require(path.join(DIR, name));
        log(`[migrate] running ${name}…`);
        const result = await mod.up({ sequelize: migSeq, queryInterface: sequelize.getQueryInterface(), models: sequelize.models });
        await sequelize.query(`INSERT INTO schema_migrations (name, result) VALUES (:name, :result) ON CONFLICT (name) DO NOTHING`,
          { replacements: { name, result: result ? String(result).slice(0, 2000) : null } });
        log(`[migrate] ${name} done${result ? ': ' + result : ''}`);
        ran.push({ name, result });
      }
      return ran;
    });
    if (out) return out;
    if (!waited) log('[migrate] another server is running migrations — waiting for it to finish');
    waited = true;
    if (Date.now() - started >= waitMs) {
      throw new Error(`another server has held the migration lock for over ${Math.round(waitMs / 1000)}s — this server did not check the schema; restart it once that server has finished`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

async function status(sequelize) {
  await ensureTable(sequelize);
  const done = new Map((await applied(sequelize)).map(r => [r.name, r]));
  return listMigrations().map(name => ({ name, ran: done.has(name), at: done.get(name)?.run_at || null, result: done.get(name)?.result || null }));
}

module.exports = { runMigrations, status, listMigrations, ddlAlreadyDone, lockLimitedSequelize, isLockTimeout };
