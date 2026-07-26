#!/usr/bin/env node
/**
 * Schema drift check — reports what `sequelize.sync({ alter: true })` WOULD do, without
 * doing any of it.
 *
 * Why you need this: production has been running `sync({ alter: true })` on every boot, so
 * if anyone ever added a model field without a matching migration, sync has been silently
 * creating that column for you and nobody noticed the migration was missing. Turn sync off
 * and those columns stop appearing on a fresh database.
 *
 * Run this against a RESTORED COPY of production before trusting the sync-off change:
 *
 *     DATABASE_URL=postgres://...copy... node backend/scripts/schema-drift-check.js
 *
 * Read the output like this:
 *   ADD COLUMN     -> a missing migration. Write it before disabling sync.
 *   DROP COLUMN    -> sync has been ready to delete this column and its data. Investigate.
 *   ALTER COLUMN   -> a type mismatch. Usually harmless DECIMAL/ENUM churn, but check.
 *
 * Nothing here writes to the database. It only inspects and compares.
 */

const { sequelize } = require('../src/models');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Point it at a RESTORED COPY, never production.');
    process.exit(1);
  }

  await sequelize.authenticate();
  const qi = sequelize.getQueryInterface();

  const models = Object.values(sequelize.models);
  let addCount = 0, dropCount = 0, typeCount = 0, missingTables = 0;

  console.log(`Comparing ${models.length} models against the live schema...\n`);

  for (const model of models) {
    const table = model.getTableName();
    const tableName = typeof table === 'string' ? table : table.tableName;

    let live;
    try {
      live = await qi.describeTable(table);
    } catch (e) {
      console.log(`TABLE MISSING   ${tableName}  (sync would CREATE it)`);
      missingTables++;
      continue;
    }

    const attrs = model.getAttributes();
    const modelCols = new Map();
    for (const key of Object.keys(attrs)) {
      modelCols.set(attrs[key].field || key, attrs[key]);
    }

    // Model has it, database does not -> sync would ADD it (a missing migration)
    for (const [col, attr] of modelCols) {
      if (!(col in live)) {
        console.log(`ADD COLUMN      ${tableName}.${col}   type=${attr.type && attr.type.key}`);
        addCount++;
      }
    }

    // Database has it, model does not -> sync would DROP it, taking the data with it
    for (const col of Object.keys(live)) {
      if (!modelCols.has(col)) {
        console.log(`DROP COLUMN     ${tableName}.${col}   <-- DATA LOSS if sync runs`);
        dropCount++;
      }
    }

    // Both have it but the types disagree -> sync would issue ALTER COLUMN TYPE
    for (const [col, attr] of modelCols) {
      if (!(col in live)) continue;
      const modelType = String((attr.type && attr.type.toString && attr.type.toString()) || '').toUpperCase();
      const liveType = String(live[col].type || '').toUpperCase();
      if (!modelType || !liveType) continue;
      const norm = (t) => t.replace(/\s+/g, '').replace('CHARACTERVARYING', 'VARCHAR')
        .replace('TIMESTAMPWITHTIMEZONE', 'TIMESTAMPTZ').replace(/\(\d+(,\d+)?\)/g, '');
      if (norm(modelType) !== norm(liveType)) {
        console.log(`ALTER COLUMN    ${tableName}.${col}   live=${liveType}  model=${modelType}`);
        typeCount++;
      }
    }
  }

  console.log('\n---');
  console.log(`tables sync would create: ${missingTables}`);
  console.log(`columns sync would add:   ${addCount}   <- each one is a migration you are missing`);
  console.log(`columns sync would DROP:  ${dropCount}   <- each one is data at risk`);
  console.log(`columns sync would alter: ${typeCount}   <- mostly DECIMAL/ENUM churn, verify anyway`);
  console.log('\nIf adds and drops are both 0, disabling sync in production is safe.');

  await sequelize.close();
}

main().catch((err) => {
  console.error('Drift check failed:', err.message);
  process.exit(1);
});
