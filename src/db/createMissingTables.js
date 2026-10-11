/**
 * Create every table the models define that the database doesn't have yet — create-only.
 *
 * Existing tables are never altered: no column is added, changed or dropped here (the alter-style
 * sync is what once drove work_order_parts into Postgres's 1600-column limit). New tables are created
 * one model at a time; a table whose foreign key points at a table that doesn't exist yet (work orders
 * ↔ estimates reference each other) is created without that key first and the key is added in a
 * second pass.
 *
 * Used by migration 0001 (so an empty database is built on the first boot; existing tables untouched)
 * and by SCHEMA_SYNC_MODE=safe (which also syncs ENUM values / declared indexes on existing tables).
 * @returns {string[]} the tables created
 */
async function createMissingTables(sequelize, { syncExisting = false } = {}) {
  const qi = sequelize.getQueryInterface();
  const created = [], keyless = [];
  for (const model of Object.values(sequelize.models)) {
    if (await qi.tableExists(model.getTableName())) {
      // Existing tables are left completely alone by the migration. SCHEMA_SYNC_MODE=safe also lets
      // Sequelize add missing ENUM values / model-declared indexes to them (syncExisting).
      if (syncExisting) await model.sync({});
      continue;
    }
    try { await model.sync({}); }
    catch (e) { await model.sync({ withoutForeignKeyConstraints: true }); keyless.push(model); }
    created.push(model.getTableName());
  }
  for (const model of keyless) {
    const table = model.getTableName();
    for (const [name, attr] of Object.entries(model.rawAttributes)) {
      const ref = attr.references; if (!ref || !ref.model) continue;
      const refTable = typeof ref.model === 'string' ? ref.model : ref.model.tableName || ref.model.getTableName();
      const col = attr.field || name;
      try {
        await sequelize.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${col}_fkey" FOREIGN KEY ("${col}") REFERENCES "${refTable}" ("${ref.key || 'id'}")` +
          ` ON DELETE ${attr.onDelete || (attr.allowNull === false ? 'NO ACTION' : 'SET NULL')} ON UPDATE ${attr.onUpdate || 'CASCADE'}`);
      } catch (e) { console.warn(`[schema] could not add ${table}.${col} → ${refTable}: ${e.message}`); }
    }
  }
  return created;
}

module.exports = { createMissingTables };
