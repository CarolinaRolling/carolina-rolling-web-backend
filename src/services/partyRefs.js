/**
 * partyRefs — keep every copy of a client's or vendor's name and id in step (audit M1).
 *
 * Many tables store the client/vendor name next to its id (so lists and PDFs don't need a join).
 * Before:
 *  - a client rename updated work orders and estimates only; payments, credit memos, refunds, DR /
 *    PO / invoice numbers, deliveries, shipments and the client's portal API key kept the old name —
 *    and the portal key is matched BY NAME, so a rename locked the client out of the portal;
 *  - a client merge skipped client payments, credit memos, refunds, the convert queue and scanned
 *    paperwork, leaving them pointing at the deleted client; its error handling swallowed failures
 *    inside the transaction (which makes Postgres abort the rest silently);
 *  - a vendor rename updated nothing at all.
 *
 * Now one table-driven function per operation, inside one transaction, never swallowing errors.
 * A table or column that doesn't exist in this database is skipped up front.
 */
const CLIENT = {
  linked: [   // [table, id column, name columns]
    ['work_orders', 'clientId', ['clientName']],
    ['estimates', 'clientId', ['clientName']],
    ['inbound_orders', 'clientId', ['clientName']],
    ['dr_numbers', 'clientId', ['clientName']],
    ['invoice_numbers', 'clientId', ['clientName']],
    ['po_numbers', 'clientId', ['clientName']],
    ['pending_orders', 'clientId', ['clientName']],
    ['client_payments', 'clientId', ['clientName']],
    ['credit_memos', 'clientId', ['clientName']],
    ['refunds', 'clientId', ['clientName']],
    ['convert_queue_items', 'clientId', ['clientName']],
    ['inbound_paperwork', 'clientId', ['clientName']],
    ['scanned_emails', 'clientId', []],
  ],
  nameOnly: [['shipments', 'clientName'], ['api_keys', 'clientName']],
};
const VENDOR = {
  linked: [
    ['inbound_orders', 'vendorId', ['supplierName', 'supplier']],
    ['work_order_parts', 'vendorId', ['supplierName']],
    ['estimate_parts', 'vendorId', ['supplierName']],
    ['po_numbers', 'vendorId', ['supplier']],
    ['vendor_issues', 'vendorId', ['vendorName']],
    ['shipment_charges', 'vendorId', ['vendorName']],
    ['liabilities', 'vendorId', ['vendor']],
    ['work_order_parts', 'outsideProcessingVendorId', ['outsideProcessingVendorName']],
    ['estimate_parts', 'outsideProcessingVendorId', ['outsideProcessingVendorName']],
    ['estimates', 'rfqVendorId', []],
  ],
  nameOnly: [['api_keys', 'vendorName']],
};

let columnsCache = null;
async function columns(sequelize, transaction) {
  if (columnsCache) return columnsCache;
  const [rows] = await sequelize.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`, { transaction });
  columnsCache = new Set(rows.map(r => `${r.table_name}.${r.column_name}`));
  return columnsCache;
}
const q = (s) => `"${s}"`;

async function plan(spec, sequelize, transaction) {
  const have = await columns(sequelize, transaction);
  return {
    linked: spec.linked
      .filter(([t, id]) => have.has(`${t}.${id}`))
      .map(([t, id, names]) => [t, id, names.filter(n => have.has(`${t}.${n}`))]),
    nameOnly: spec.nameOnly.filter(([t, n]) => have.has(`${t}.${n}`)),
  };
}

/** Rename: every row linked by id gets the new name; unlinked rows carrying the exact old name too. */
async function propagateRename(spec, id, oldName, newName, { transaction }) {
  const { sequelize } = require('../models');
  const p = await plan(spec, sequelize, transaction);
  let rows = 0;
  const run = async (sql, replacements) => { const [, meta] = await sequelize.query(sql, { replacements, transaction }); rows += (meta && meta.rowCount) || 0; };
  for (const [t, idCol, names] of p.linked) {
    for (const n of names) {
      await run(`UPDATE ${q(t)} SET ${q(n)} = :newName WHERE ${q(idCol)} = :id AND ${q(n)} IS DISTINCT FROM :newName`, { id, newName });
      if (oldName) await run(`UPDATE ${q(t)} SET ${q(n)} = :newName WHERE ${q(idCol)} IS NULL AND ${q(n)} = :oldName`, { oldName, newName });
    }
  }
  if (oldName) for (const [t, n] of p.nameOnly) await run(`UPDATE ${q(t)} SET ${q(n)} = :newName WHERE ${q(n)} = :oldName`, { oldName, newName });
  return rows;
}

/** Merge: everything pointing at the source (by id, or by its exact name when unlinked) moves to the target. */
async function propagateMerge(spec, target, source, { transaction }) {
  const { sequelize } = require('../models');
  const p = await plan(spec, sequelize, transaction);
  let rows = 0;
  const run = async (sql, replacements) => { const [, meta] = await sequelize.query(sql, { replacements, transaction }); rows += (meta && meta.rowCount) || 0; };
  const r = { targetId: target.id, sourceId: source.id, targetName: target.name, sourceName: source.name };
  for (const [t, idCol, names] of p.linked) {
    const setNames = names.map(n => `, ${q(n)} = :targetName`).join('');
    await run(`UPDATE ${q(t)} SET ${q(idCol)} = :targetId${setNames} WHERE ${q(idCol)} = :sourceId`, r);
    for (const n of names) await run(`UPDATE ${q(t)} SET ${q(idCol)} = :targetId, ${q(n)} = :targetName WHERE ${q(idCol)} IS NULL AND ${q(n)} = :sourceName`, r);
  }
  for (const [t, n] of p.nameOnly) await run(`UPDATE ${q(t)} SET ${q(n)} = :targetName WHERE ${q(n)} = :sourceName`, r);
  return rows;
}

module.exports = {
  CLIENT, VENDOR,
  renameClient: (id, oldName, newName, opts) => propagateRename(CLIENT, id, oldName, newName, opts),
  renameVendor: (id, oldName, newName, opts) => propagateRename(VENDOR, id, oldName, newName, opts),
  mergeClients: (target, source, opts) => propagateMerge(CLIENT, target, source, opts),
  mergeVendors: (target, source, opts) => propagateMerge(VENDOR, target, source, opts),
};
