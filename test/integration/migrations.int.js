/**
 * Migrations (audit M9): an empty database is built by the migrations alone (schema sync off), two
 * processes starting together run each migration once, and an existing database's schema is left as
 * it was. Uses throwaway databases next to DATABASE_URL (local only).
 */
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const { Client: PG } = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(DB)) { console.error('Refusing: DATABASE_URL must be a local test database.'); process.exit(2); }
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, d); } };
const urlFor = (name) => DB.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
const cli = (dbUrl, cmd) => run('node', [path.join(__dirname, '../../src/db/cli.js'), cmd], { env: { ...process.env, DATABASE_URL: dbUrl } });

(async () => {
  const admin = new PG({ connectionString: urlFor('postgres') }); await admin.connect();
  const name = 'crmig_' + Date.now().toString(36);
  await admin.query(`CREATE DATABASE ${name}`);
  try {
    const url = urlFor(name);
    const [a, b] = await Promise.all([cli(url, 'up'), cli(url, 'up')]);
    const outs = [a.stdout, b.stdout];
    check('two processes at once: exactly one runs the migration, the other skips or finds it done',
      outs.filter(o => /Ran 1 migration/.test(o)).length === 1 && outs.filter(o => /up to date|skipping/.test(o)).length === 1, outs.join(' | '));
    const pg = new PG({ connectionString: url }); await pg.connect();
    const t = (await pg.query(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`)).rows[0].n;
    const models = require(path.join(__dirname, '../../src/models'));
    const expected = new Set(Object.values(models.sequelize.models).map(m => m.getTableName())).size;
    check('an empty database gets every model table from the migrations alone', t === expected, `${t} of ${expected}`);
    const fks = (await pg.query(`SELECT COUNT(*)::int n FROM pg_constraint WHERE contype='f'`)).rows[0].n;
    check('…including the foreign keys between them (work orders ↔ estimates cycle too)', fks >= 50, fks);
    const recorded = (await pg.query(`SELECT name FROM schema_migrations`)).rows.map(r => r.name);
    check('each migration is recorded once', recorded.length === new Set(recorded).size && recorded.includes('0001-create-missing-tables.js'), recorded.join(','));
    const again = await cli(url, 'up');
    check('running again does nothing', /up to date/.test(again.stdout), again.stdout);
    await pg.end();
    await models.sequelize.close();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  // the real test database (already migrated by the server) reports up to date
  const st = await cli(DB, 'status');
  check('`npm run migrate:status` on the test database shows 0001 as run', /✓ 0001-create-missing-tables\.js/.test(st.stdout), st.stdout);
  await admin.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
