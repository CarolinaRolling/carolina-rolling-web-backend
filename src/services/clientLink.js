/**
 * clientLink — every work order and estimate that names a client carries that client's id (round 13,
 * audit T3).
 *
 * Before: estimates never stored a clientId, so orders converted from them (and tablet walk-in orders,
 * shipments that create orders) had none. Take Payment, client statements and client history look
 * orders up by clientId, so those invoices were missing — statements understated what was owed. Only a
 * backfill at server start repaired them, until the next one.
 *
 * Now a model hook fills the id from the name (same match as the client list: trimmed, any case)
 * whenever a work order or estimate is created, or its client name changes without an id being given.
 */
async function idForName(name, transaction) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const { Client, sequelize } = require('../models');
  const c = await Client.findOne({ where: sequelize.where(sequelize.fn('lower', sequelize.fn('trim', sequelize.col('name'))), n),
    attributes: ['id'], transaction });
  return c ? c.id : null;
}

function registerClientIdHooks(models) {
  if (registerClientIdHooks.done) return;
  registerClientIdHooks.done = true;
  for (const Model of [models.WorkOrder, models.Estimate].filter(Boolean)) {
    Model.addHook('beforeCreate', 'clientLink', async (inst, options) => {
      if (!inst.clientId && inst.clientName) inst.clientId = await idForName(inst.clientName, options && options.transaction);
    });
    Model.addHook('beforeUpdate', 'clientLink', async (inst, options) => {
      const nameChanged = inst.changed('clientName');
      const idChanged = inst.changed('clientId');
      if (nameChanged && !idChanged) inst.clientId = await idForName(inst.clientName, options && options.transaction);
      else if (!inst.clientId && inst.clientName) inst.clientId = await idForName(inst.clientName, options && options.transaction);
    });
  }
}

/** Fill missing ids on existing rows (run at start-up). */
async function backfillClientIds(sequelize) {
  let n = 0;
  for (const tbl of ['work_orders', 'estimates', 'po_numbers', 'inbound_orders', 'dr_numbers', 'invoice_numbers']) {
    try {
      const [, meta] = await sequelize.query(`UPDATE "${tbl}" t SET "clientId" = c.id FROM clients c
        WHERE t."clientId" IS NULL AND t."clientName" IS NOT NULL AND lower(trim(t."clientName")) = lower(trim(c.name))`);
      n += (meta && meta.rowCount) || 0;
    } catch (_) { /* table/column may not exist */ }
  }
  return n;
}

module.exports = { registerClientIdHooks, backfillClientIds, idForName };
