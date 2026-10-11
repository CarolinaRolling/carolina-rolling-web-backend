#!/usr/bin/env node
/**
 *   npm run migrate          run any migrations that haven't run yet (the server also does this at startup)
 *   npm run migrate:status   list every migration and whether it has run on this database
 */
require('dotenv').config();
const { sequelize } = require('../models');
const { runMigrations, status } = require('./migrator');

(async () => {
  const cmd = process.argv[2] || 'up';
  if (cmd === 'status') {
    for (const m of await status(sequelize)) {
      console.log(`${m.ran ? '✓' : '·'} ${m.name}${m.ran ? `  (ran ${new Date(m.at).toISOString()})${m.result ? ' — ' + m.result : ''}` : '  — not run yet'}`);
    }
  } else {
    const ran = await runMigrations(sequelize);
    console.log(ran.length ? `Ran ${ran.length} migration(s).` : 'Nothing to run — the database is up to date.');
  }
  await sequelize.close();
})().catch(async (e) => { console.error('Migration failed:', e.message); try { await sequelize.close(); } catch (_) {} process.exit(1); });
