/**
 * invoiceLock — once a work order's invoice is in QuickBooks, what it charges can't change (audit H10).
 *
 * Before: every part, shipping-charge and pricing write was allowed after export. Editing a part
 * regenerated the customer's PDF with a total QuickBooks had never seen.
 *
 * "In QuickBooks" = WorkOrder.iifExportedAt is set (IIF export, or "mark entered" in the Invoice
 * Center). To change pricing after that, an admin un-marks it (Invoice Center), makes the change,
 * and re-exports / re-enters it — so QuickBooks is updated deliberately, never silently.
 *
 * How a change is judged: the invoice is calculated before and after the change with the same code
 * that builds the invoice (services/invoiceTotals + pricing). The change is refused only if a line
 * amount or the invoice total/tax would differ. So re-saving a form that fills in defaults (a 20%
 * markup on a part with none stored, the default tax rate, tax-exempt for a resale client), adding
 * or removing a $0 line, notes, status, heat numbers, progress, files and shipping details are all
 * still allowed.
 *
 * Enforced with model hooks so it covers every route. Bulk deletes and raw SQL are not covered
 * (deleting a whole work order is guarded separately by the delete-override flow).
 */
const { Op } = require('sequelize');

class InvoiceLockedError extends Error {
  constructor(wo, what) {
    const label = wo.drNumber ? `DR-${wo.drNumber}` : (wo.orderNumber || 'This order');
    const when = wo.iifExportedAt ? ` on ${new Date(wo.iifExportedAt).toLocaleDateString('en-US')}` : '';
    super(`${label} (invoice #${wo.invoiceNumber || '—'}) was entered in QuickBooks${when}, so its pricing is locked` +
      `${what ? ` (this would change ${what})` : ''}. To change it, an admin can un-mark it as entered in the Invoice Center, ` +
      `make the change, then re-export or re-enter it in QuickBooks.`);
    this.status = 409;
    this.code = 'INVOICE_LOCKED';
  }
}

// Paused only for the request that asks (a backup restore) — other users' edits during a restore
// are still checked (round 12, audit N20: the pause used to be process-wide). Outside a request it
// pauses globally. suspendInvoiceLock() returns the function that resumes.
let globalSuspended = 0;
const store = () => { try { return require('./undo').contextStore(); } catch (_) { return null; } };
const isLockSuspended = () => globalSuspended > 0 || !!store()?.invoiceLockSuspended;
function suspendInvoiceLock() {
  const st = store();
  if (st) { st.invoiceLockSuspended = (st.invoiceLockSuspended || 0) + 1; return () => { st.invoiceLockSuspended = Math.max(0, (st.invoiceLockSuspended || 1) - 1); }; }
  globalSuspended++;
  return () => { globalSuspended = Math.max(0, globalSuspended - 1); };
}
const resumeInvoiceLock = () => { const st = store(); if (st && st.invoiceLockSuspended) st.invoiceLockSuspended--; else globalSuspended = Math.max(0, globalSuspended - 1); };

const plain = (x) => (x && typeof x.toJSON === 'function') ? x.toJSON() : { ...x };
const cents = (n) => Math.round((Number(n) || 0) * 100);

/** Load an exported order with everything its invoice depends on, or null if not exported. */
async function loadLockedContext(workOrderId, options) {
  if (!workOrderId) return null;
  const { WorkOrder, WorkOrderPart, ShipmentCharge, Client } = require('../models');
  const transaction = options && options.transaction;
  const wo = await WorkOrder.findByPk(workOrderId, { transaction });
  if (!wo || !wo.iifExportedAt) return null;
  const [parts, charges] = await Promise.all([
    WorkOrderPart.findAll({ where: { workOrderId }, transaction }),
    ShipmentCharge.findAll({ where: { workOrderId }, transaction }),
  ]);
  const { loadLaborMinimums } = require('./pricing');
  const laborMinimums = await loadLaborMinimums({ transaction });
  const clientFor = async (w) => {
    if (w.clientId) { const c = await Client.findByPk(w.clientId, { attributes: ['id', 'taxStatus'], transaction }); if (c) return c; }
    if (w.clientName) return Client.findOne({ where: { name: { [Op.iLike]: w.clientName } }, attributes: ['id', 'taxStatus'], transaction });
    return null;
  };
  return { wo, parts: parts.map(plain), charges: charges.map(plain), laborMinimums, clientFor };
}

/** What the invoice charges: per-line amounts plus total and tax. */
async function invoiceShape(ctx, { wo = ctx.wo, parts = ctx.parts, charges = ctx.charges } = {}) {
  const { computeInvoiceTotals, chargeBilled } = require('./invoiceTotals');
  const { calculatePartTotal } = require('./pricing');
  const client = await ctx.clientFor(plain(wo));
  const t = computeInvoiceTotals({ wo: plain(wo), parts, client, shipmentCharges: charges, laborMinimums: ctx.laborMinimums });
  const lines = new Map();
  for (const p of parts) lines.set('p:' + p.id, cents(calculatePartTotal(p)));
  for (const c of charges) lines.set('c:' + c.id, cents(chargeBilled(c)));
  return { grand: cents(t.grandTotal), tax: cents(t.taxAmount), lines };
}

/** Throw if the invoice would change. `describe` names what changed for the message. */
async function assertSameInvoice(ctx, after) {
  const before = await invoiceShape(ctx);
  const next = await invoiceShape(ctx, after);
  if (before.grand !== next.grand || before.tax !== next.tax) throw new InvoiceLockedError(ctx.wo, 'the invoice total');
  const keys = new Set([...before.lines.keys(), ...next.lines.keys()]);
  for (const k of keys) {
    if ((before.lines.get(k) || 0) !== (next.lines.get(k) || 0)) throw new InvoiceLockedError(ctx.wo, 'a line on the invoice');
  }
}

const mergedPart = (prevPlain, changes) => {
  const out = { ...prevPlain, ...changes };
  if (changes.formData && prevPlain.formData && typeof prevPlain.formData === 'object') out.formData = { ...changes.formData };
  return out;
};

/** Used by routes that must check BEFORE doing irreversible work (e.g. deleting files). */
async function assertPartRemovable(part, options) {
  if (isLockSuspended()) return;
  const ctx = await loadLockedContext(part.workOrderId, options);
  if (!ctx) return;
  await assertSameInvoice(ctx, { parts: ctx.parts.filter(p => p.id !== part.id) });
}

function registerInvoiceLockHooks(models) {
  if (registerInvoiceLockHooks.done) return;
  registerInvoiceLockHooks.done = true;
  const { WorkOrder, WorkOrderPart, ShipmentCharge } = models;

  // ── parts ──
  WorkOrderPart.addHook('beforeCreate', 'invoiceLock', async (inst, options) => {
    if (isLockSuspended()) return;
    const ctx = await loadLockedContext(inst.workOrderId, options);
    if (ctx) await assertSameInvoice(ctx, { parts: [...ctx.parts, { ...plain(inst), id: inst.id || '__new__' }] });
  });
  WorkOrderPart.addHook('beforeUpdate', 'invoiceLock', async (inst, options) => {
    if (isLockSuspended()) return;
    const prev = inst._previousDataValues || {};
    const fields = options.fields || inst.changed() || [];
    if (!fields.length) return;
    const changes = {};
    for (const f of fields) changes[f] = inst.dataValues[f];
    const ids = [...new Set([prev.workOrderId, inst.workOrderId].filter(Boolean))];
    for (const woId of ids) {
      const ctx = await loadLockedContext(woId, options);
      if (!ctx) continue;
      const after = ctx.parts
        .filter(p => p.id !== inst.id || inst.workOrderId === woId)
        .map(p => (p.id === inst.id ? mergedPart(p, changes) : p));
      if (inst.workOrderId === woId && !after.some(p => p.id === inst.id)) after.push(mergedPart(plain(prev), changes));
      await assertSameInvoice(ctx, { parts: after });
    }
  });
  WorkOrderPart.addHook('beforeDestroy', 'invoiceLock', (inst, options) => assertPartRemovable(inst, options));
  WorkOrderPart.addHook('beforeBulkUpdate', 'invoiceLock', async (options) => {
    if (isLockSuspended() || !options.where) return;
    const attrs = { ...(options.attributes || {}) };
    delete attrs.updatedAt;
    if (!Object.keys(attrs).length) return;
    const rows = await WorkOrderPart.findAll({ where: options.where, attributes: ['id', 'workOrderId'], transaction: options.transaction });
    for (const woId of [...new Set(rows.map(r => r.workOrderId))]) {
      const ctx = await loadLockedContext(woId, options);
      if (!ctx) continue;
      const hit = new Set(rows.filter(r => r.workOrderId === woId).map(r => r.id));
      await assertSameInvoice(ctx, { parts: ctx.parts.map(p => (hit.has(p.id) ? mergedPart(p, attrs) : p)) });
    }
  });

  // ── shipping charges ──
  ShipmentCharge.addHook('beforeCreate', 'invoiceLock', async (inst, options) => {
    if (isLockSuspended()) return;
    const ctx = await loadLockedContext(inst.workOrderId, options);
    if (ctx) await assertSameInvoice(ctx, { charges: [...ctx.charges, { ...plain(inst), id: inst.id || '__new__' }] });
  });
  ShipmentCharge.addHook('beforeUpdate', 'invoiceLock', async (inst, options) => {
    if (isLockSuspended()) return;
    const fields = options.fields || inst.changed() || [];
    const changes = {};
    for (const f of fields) changes[f] = inst.dataValues[f];
    const prev = inst._previousDataValues || {};
    for (const woId of [...new Set([prev.workOrderId, inst.workOrderId].filter(Boolean))]) {
      const ctx = await loadLockedContext(woId, options);
      if (!ctx) continue;
      const after = ctx.charges.filter(c => c.id !== inst.id || inst.workOrderId === woId).map(c => (c.id === inst.id ? { ...c, ...changes } : c));
      if (inst.workOrderId === woId && !after.some(c => c.id === inst.id)) after.push({ ...plain(prev), ...changes });
      await assertSameInvoice(ctx, { charges: after });
    }
  });
  ShipmentCharge.addHook('beforeDestroy', 'invoiceLock', async (inst, options) => {
    if (isLockSuspended()) return;
    const ctx = await loadLockedContext(inst.workOrderId, options);
    if (ctx) await assertSameInvoice(ctx, { charges: ctx.charges.filter(c => c.id !== inst.id) });
  });

  // ── the order itself (tax, discount, minimum, trucking, client) ──
  WorkOrder.addHook('beforeUpdate', 'invoiceLock', async (inst, options) => {
    if (isLockSuspended()) return;
    const prev = inst._previousDataValues || {};
    if (!prev.iifExportedAt || !inst.iifExportedAt) return;   // not locked, or being un-marked now
    const fields = options.fields || inst.changed() || [];
    if (!fields.length) return;
    const ctx = await loadLockedContext(inst.id, options);
    if (!ctx) return;
    ctx.wo = { ...plain(ctx.wo), ...prev };                   // before = stored values
    const changes = {};
    for (const f of fields) changes[f] = inst.dataValues[f];
    await assertSameInvoice(ctx, { wo: { ...ctx.wo, ...changes } });
  });
  WorkOrder.addHook('beforeBulkUpdate', 'invoiceLock', async (options) => {
    if (isLockSuspended() || !options.where) return;
    const attrs = { ...(options.attributes || {}) };
    delete attrs.updatedAt;
    if (!Object.keys(attrs).length || 'iifExportedAt' in attrs) return;
    const rows = await WorkOrder.findAll({ where: { [Op.and]: [options.where, { iifExportedAt: { [Op.ne]: null } }] }, attributes: ['id'], transaction: options.transaction });
    for (const r of rows) {
      const ctx = await loadLockedContext(r.id, options);
      if (ctx) await assertSameInvoice(ctx, { wo: { ...plain(ctx.wo), ...attrs } });
    }
  });
}

module.exports = { InvoiceLockedError, registerInvoiceLockHooks, suspendInvoiceLock, resumeInvoiceLock, assertPartRemovable };
