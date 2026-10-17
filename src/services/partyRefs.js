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
  // [table, JSONB list column, id key, name key]
  jsonLists: [
    ['work_order_parts', 'outsideProcessing', 'vendorId', 'vendorName'],
    ['estimate_parts', 'outsideProcessing', 'vendorId', 'vendorName'],
    ['work_orders', 'opTransports', 'truckingVendorId', null],
    ['estimates', 'opTransports', 'truckingVendorId', null],
  ],
};

let columnsCache = null;
async function columns(sequelize, transaction) {
  if (columnsCache) return columnsCache;
  const [rows] = await sequelize.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`, { transaction });
  columnsCache = new Set(rows.map(r => `${r.table_name}.${r.column_name}`));
  return columnsCache;
}
const q = (s) => `"${s}"`;
// Names typed by hand differ in case and stray spaces ("a3rel gamma", "A3REL GAMMA ") — they are the
// same party, so name-only matches ignore both (round 13, T23; the portal key's client is matched the
// same way by keyScope).
const nameIs = (col, param) => `lower(trim(${q(col)})) = lower(trim(CAST(:${param} AS text)))`;

async function plan(spec, sequelize, transaction) {
  const have = await columns(sequelize, transaction);
  return {
    linked: spec.linked
      .filter(([t, id]) => have.has(`${t}.${id}`))
      .map(([t, id, names]) => [t, id, names.filter(n => have.has(`${t}.${n}`))]),
    nameOnly: spec.nameOnly.filter(([t, n]) => have.has(`${t}.${n}`)),
  };
}

/** Rename: every row linked by id gets the new name; unlinked rows carrying the old name (ignoring case / spaces) too. */
async function propagateRename(spec, id, oldName, newName, { transaction }) {
  const { sequelize } = require('../models');
  const p = await plan(spec, sequelize, transaction);
  let rows = 0;
  const run = async (sql, replacements) => { const [, meta] = await sequelize.query(sql, { replacements, transaction }); rows += (meta && meta.rowCount) || 0; };
  for (const [t, idCol, names] of p.linked) {
    for (const n of names) {
      await run(`UPDATE ${q(t)} SET ${q(n)} = :newName WHERE ${q(idCol)} = :id AND ${q(n)} IS DISTINCT FROM :newName`, { id, newName });
      if (oldName) await run(`UPDATE ${q(t)} SET ${q(n)} = :newName WHERE ${q(idCol)} IS NULL AND ${nameIs(n, 'oldName')}`, { oldName, newName });
    }
  }
  if (oldName) for (const [t, n] of p.nameOnly) await run(`UPDATE ${q(t)} SET ${q(n)} = :newName WHERE ${nameIs(n, 'oldName')}`, { oldName, newName });
  // names kept inside JSONB lists next to the id (round 12, R20)
  const have = await columns(sequelize, transaction);
  for (const [t, col, idKey, nameKey] of (spec.jsonLists || [])) {
    if (!nameKey || !have.has(`${t}.${col}`)) continue;
    await run(`UPDATE ${q(t)} SET ${q(col)} = (
        SELECT jsonb_agg(CASE WHEN e->>'${idKey}' = CAST(:id AS text) THEN e || jsonb_build_object('${nameKey}', CAST(:newName AS text)) ELSE e END ORDER BY ord)
        FROM jsonb_array_elements(${q(col)}) WITH ORDINALITY AS x(e, ord))
      WHERE jsonb_typeof(${q(col)}) = 'array' AND ${q(col)} @> jsonb_build_array(jsonb_build_object('${idKey}', CAST(:id AS text)))`, { id, newName });
  }
  if (spec === CLIENT) rows += await fixLinkSnapshots(sequelize, transaction, (c) =>
    (c.clientId === id || (!c.clientId && oldName && sameName(c.clientName, oldName))) ? { clientName: newName } : null);
  return rows;
}

/** Merge: everything pointing at the source (by id, or by its name — ignoring case / spaces — when unlinked) moves to the target. */
async function propagateMerge(spec, target, source, { transaction }) {
  const { sequelize } = require('../models');
  const p = await plan(spec, sequelize, transaction);
  let rows = 0;
  const run = async (sql, replacements) => { const [, meta] = await sequelize.query(sql, { replacements, transaction }); rows += (meta && meta.rowCount) || 0; };
  const r = { targetId: target.id, sourceId: source.id, targetName: target.name, sourceName: source.name };
  for (const [t, idCol, names] of p.linked) {
    const setNames = names.map(n => `, ${q(n)} = :targetName`).join('');
    await run(`UPDATE ${q(t)} SET ${q(idCol)} = :targetId${setNames} WHERE ${q(idCol)} = :sourceId`, r);
    for (const n of names) await run(`UPDATE ${q(t)} SET ${q(idCol)} = :targetId, ${q(n)} = :targetName WHERE ${q(idCol)} IS NULL AND ${nameIs(n, 'sourceName')}`, r);
  }
  for (const [t, n] of p.nameOnly) await run(`UPDATE ${q(t)} SET ${q(n)} = :targetName WHERE ${nameIs(n, 'sourceName')}`, r);
  // Ids kept INSIDE JSONB lists (outside-processing lines, trucking trips) move too (round 12, R20)
  const have = await columns(sequelize, transaction);
  for (const [t, col, idKey, nameKey] of (spec.jsonLists || [])) {
    if (!have.has(`${t}.${col}`)) continue;
    const setName = nameKey ? `, '${nameKey}', :targetName` : '';
    await run(`UPDATE ${q(t)} SET ${q(col)} = (
        SELECT jsonb_agg(CASE WHEN e->>'${idKey}' = CAST(:sourceId AS text) THEN e || jsonb_build_object('${idKey}', CAST(:targetId AS text)${setName ? `, '${nameKey}', CAST(:targetName AS text)` : ''}) ELSE e END ORDER BY ord)
        FROM jsonb_array_elements(${q(col)}) WITH ORDINALITY AS x(e, ord))
      WHERE jsonb_typeof(${q(col)}) = 'array' AND ${q(col)} @> jsonb_build_array(jsonb_build_object('${idKey}', CAST(:sourceId AS text)))`, r);
  }
  if (spec === CLIENT) rows += await fixLinkSnapshots(sequelize, transaction, (c) =>
    (c.clientId === source.id || (!c.clientId && sameName(c.clientName, source.name))) ? { clientId: target.id, clientName: target.name } : null);
  await recordMerge(sequelize, spec === CLIENT ? 'clients' : 'vendors', source.id, target.id, transaction);
  return rows;
}

// V11: which client / vendor each merged-away one went into, so Undo of an older delete can follow it
// (app_settings 'party_merge_log' = { clients: { fromId: toId }, vendors: {…} }, newest MERGE_LOG_CAP kept)
const MERGE_LOG_KEY = 'party_merge_log';
const MERGE_LOG_CAP = 5000;
async function recordMerge(sequelize, kind, fromId, toId, transaction) {
  await sequelize.query(`INSERT INTO app_settings (id, key, value, "createdAt", "updatedAt") VALUES (gen_random_uuid(), :k, '{}'::jsonb, now(), now())
    ON CONFLICT (key) DO NOTHING`, { replacements: { k: MERGE_LOG_KEY }, transaction });
  const [[row]] = await sequelize.query(`SELECT value FROM app_settings WHERE key = :k FOR UPDATE`, { replacements: { k: MERGE_LOG_KEY }, transaction });
  const log = (row && row.value && typeof row.value === 'object') ? row.value : {};
  const m = { ...(log[kind] || {}) };
  for (const k of Object.keys(m)) if (m[k] === String(fromId)) m[k] = String(toId);   // earlier merges into the source follow it
  delete m[String(fromId)];
  m[String(fromId)] = String(toId);
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - MERGE_LOG_CAP))) delete m[k];
  log[kind] = m;
  await sequelize.query(`UPDATE app_settings SET value = CAST(:v AS jsonb), "updatedAt" = now() WHERE key = :k`,
    { replacements: { k: MERGE_LOG_KEY, v: JSON.stringify(log) }, transaction });
}
/** The client / vendor id a merged-away id went into (following chains), or null. */
async function mergedInto(sequelize, kind, id, transaction) {
  if (!id) return null;
  const [[row]] = await sequelize.query(`SELECT value FROM app_settings WHERE key = :k`, { replacements: { k: MERGE_LOG_KEY }, transaction });
  const m = (row && row.value && row.value[kind]) || {};
  let cur = m[String(id)] || null;
  for (let i = 0; cur && m[cur] && i < 20; i++) cur = m[cur];
  return cur;
}

// An estimate link remembers the order's client before and after the link (work_orders.estimateLinkSnapshot)
// so Unlink can put it back — keep those in step too (U18: after a merge it pointed at the deleted client
// and Unlink failed for good; after a rename it put back the old name). Only keys the snapshot has change.
const sameName = (a, b) => a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
async function fixLinkSnapshots(sequelize, transaction, change) {
  const have = await columns(sequelize, transaction);
  if (!have.has('work_orders.estimateLinkSnapshot')) return 0;
  const [rows] = await sequelize.query(`SELECT id, "estimateLinkSnapshot" AS s FROM work_orders
    WHERE "estimateLinkSnapshot" IS NOT NULL AND (("estimateLinkSnapshot"->'before') ?| array['clientId','clientName'] OR ("estimateLinkSnapshot"->'after') ?| array['clientId','clientName'])`, { transaction });
  let n = 0;
  for (const r of rows) {
    const s = r.s; let dirty = false;
    for (const side of ['before', 'after']) {
      const c = s && s[side];
      if (!c || !('clientId' in c || 'clientName' in c)) continue;
      const upd = change(c);
      if (!upd) continue;
      for (const [k, v] of Object.entries(upd)) if (k in c && c[k] !== v) { c[k] = v; dirty = true; }
    }
    if (dirty) { await sequelize.query(`UPDATE work_orders SET "estimateLinkSnapshot" = CAST(:s AS jsonb) WHERE id = :id`, { replacements: { s: JSON.stringify(s), id: r.id }, transaction }); n++; }
  }
  return n;
}

module.exports = {
  CLIENT, VENDOR,
  renameClient: (id, oldName, newName, opts) => propagateRename(CLIENT, id, oldName, newName, opts),
  renameVendor: (id, oldName, newName, opts) => propagateRename(VENDOR, id, oldName, newName, opts),
  mergeClients: (target, source, opts) => propagateMerge(CLIENT, target, source, opts),
  mergeVendors: (target, source, opts) => propagateMerge(VENDOR, target, source, opts),
  mergedInto, MERGE_LOG_KEY,
};
