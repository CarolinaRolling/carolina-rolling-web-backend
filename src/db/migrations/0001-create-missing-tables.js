/**
 * 0001 — create any table the models define that doesn't exist yet.
 *
 * On the live database every table already exists, so this does nothing and is just recorded.
 * On an EMPTY database (a fresh install, or disaster recovery: new database + restore a backup)
 * it builds every table, so the rest of startup works on the first boot. Before this, an empty
 * database with schema sync off (the production default) never got its tables at all.
 *
 * Create-only: never alters or drops anything.
 */
const { createMissingTables } = require('../createMissingTables');

module.exports = {
  async up({ sequelize }) {
    const created = await createMissingTables(sequelize);
    return created.length ? `created ${created.length} table(s): ${created.join(', ')}` : 'all tables already exist — nothing to do';
  },
};
