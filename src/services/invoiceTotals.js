/**
 * invoiceTotals — the ONE place a work order's invoice total is calculated (audit C4).
 *
 * Before this module the total was computed in five different ways (QuickBooks IIF export,
 * invoice PDF, AR ledger, client balance/statement, invoice email) and they disagreed on the
 * labor minimum, tax exemption, the rush fee, and stale stored grandTotal values.
 *
 * The rules below are copied EXACTLY from the QuickBooks IIF export (routes/quickbooks.js
 * buildInvoiceIIF), because QuickBooks is the accounting record. Matching it means nothing
 * changes in what you send to QuickBooks — the PDF, ledger, balances and emails now agree with it.
 *
 *   parts      = Σ calculatePartTotal(part) for every part (linked services included)
 *   rush       = first rush_service part with no stored price: expedite % of labor and/or
 *                emergency off-hours fee (rounded to cents)
 *   shipping   = Σ shipment charges (each rounded), or legacy truckingCost if there are none
 *   minimum    = labor-minimum adjustment unless minimumOverride
 *   discount   = discountPercent of (parts + rush + shipping + minimum), or discountAmount
 *   taxable    = everything except shipping, after discount   (0 when resale / tax exempt)
 *   tax        = round(taxable × taxRate%)
 *   preTax     = parts + rush + shipping + minimum − discount   (the IIF TRNS amount)
 *   grandTotal = preTax + tax
 *
 * Tax exempt = client taxStatus 'resale'/'exempt' OR the work order's taxExempt flag.
 *
 * Which number is "the" invoice amount (invoiceAmount):
 *   • Exported to QuickBooks after this change → the total frozen at export (totalsComputedAt set).
 *     Later edits don't move it, so the ledger keeps matching QuickBooks.
 *   • Exported before this change → exactly what the AR ledger showed before (stored + charges),
 *     so historic balances don't shift on deploy.
 *   • Not exported, with priced parts → calculated live.
 *   • Not exported, no priced parts (legacy / not yet priced) → the stored total, as before.
 */
const { calculatePartTotal, partBreakdown, calculateMinimumAdjustment, loadLaborMinimums } = require('./pricing');

const SERVICE_TYPES = ['fab_service', 'shop_rate', 'rush_service'];
const EMERGENCY_FEES = { 'Saturday': 600, 'Saturday Night': 800, 'Sunday': 600, 'Sunday Night': 800 };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fdOf = (p) => (p && p.formData && typeof p.formData === 'object') ? p.formData : {};
const plain = (x) => (x && typeof x.toJSON === 'function') ? x.toJSON() : x;

function chargeBilled(c) {
  return (parseFloat(c.shippingCost) || 0) * (1 + (parseFloat(c.shippingMarkup) || 0) / 100)
       + (parseFloat(c.materialsCost) || 0) * (1 + (parseFloat(c.materialsMarkup) || 0) / 100);
}

function isTaxExempt(wo, client) {
  const s = (client?.taxStatus || '').toLowerCase();
  return s === 'resale' || s === 'exempt' || wo?.taxExempt === true || wo?.taxExempt === 'true';
}

/** Rush / emergency fee for a rush_service part whose price lives in formData. */
function rushFee(rushPart, parts) {
  const fd = fdOf(rushPart);
  let amount = 0;
  const labels = [];
  if (fd._expediteEnabled) {
    if (fd._expediteType === 'custom_amt') {
      amount += parseFloat(fd._expediteCustomAmt) || 0;
      labels.push('Expedite Fee');
    } else {
      let pct = parseFloat(fd._expediteType) || 0;
      if (fd._expediteType === 'custom_pct') pct = parseFloat(fd._expediteCustomPct) || 0;
      // Expedite applies to LABOR ONLY (not material)
      let laborBase = 0;
      for (const bp of parts) {
        if (bp.partType === 'rush_service') continue;
        if (bp.partType === 'fab_service' || bp.partType === 'shop_rate') {
          laborBase += calculatePartTotal(bp);
        } else {
          try {
            const bd = partBreakdown(bp);
            laborBase += (parseFloat(bd.labEach) || 0) * (parseInt(bp.quantity) || 1);
          } catch (e) { /* skip unreadable part */ }
        }
      }
      amount += round2(laborBase * (pct / 100));
      labels.push(`Expedite Service (${pct}% of labor)`);
    }
  }
  if (fd._emergencyEnabled) {
    const em = EMERGENCY_FEES[fd._emergencyDay] || 0;
    if (em > 0) { amount += em; labels.push(`Emergency Off-Hours (${fd._emergencyDay})`); }
  }
  // The IIF export only bills a positive rush fee
  return { amount: amount > 0 ? round2(amount) : 0, label: labels.join(' + ') || 'Rush / Emergency Service' };
}

/**
 * Pure calculation — no database access. Pass everything in.
 * @param {object} args
 * @param {object} args.wo               work order (model instance or plain object)
 * @param {Array}  args.parts            work order parts
 * @param {object} [args.client]         client ({ taxStatus })
 * @param {Array}  [args.shipmentCharges]
 * @param {Array}  [args.laborMinimums]  from loadLaborMinimums()
 */
function computeInvoiceTotals({ wo, parts = [], client = null, shipmentCharges = [], laborMinimums = [] }) {
  wo = plain(wo) || {};
  parts = (parts || []).map(plain);
  const sorted = [...parts].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
  const regular = sorted.filter(p => !SERVICE_TYPES.includes(p.partType));
  const services = sorted.filter(p => SERVICE_TYPES.includes(p.partType));

  // Services attach to a parent part (explicit _linkedPartId, else the nearest part before them).
  // A linked service always counts toward its parent line; an unlinked one only when > 0.
  // (Same rule as the IIF export.)
  let partsSubtotal = 0;
  for (const p of regular) partsSubtotal += calculatePartTotal(p);
  for (const svc of services) {
    const fd = fdOf(svc);
    let linked = false;
    if (fd._linkedPartId && regular.some(p => String(p.id) === String(fd._linkedPartId))) linked = true;
    if (!linked && regular.some(p => (p.partNumber || 0) < (svc.partNumber || 0))) linked = true;
    const amt = calculatePartTotal(svc);
    if (linked || amt > 0) partsSubtotal += amt;
  }

  // Rush fee — first rush_service part without a stored price
  const rushPart = sorted.find(p => p.partType === 'rush_service' && calculatePartTotal(p) <= 0) || null;
  const rush = rushPart ? rushFee(rushPart, parts) : { amount: 0, label: '' };

  // Shipping & handling (never taxed)
  const activeCharges = (shipmentCharges || []).map(plain).filter(c => chargeBilled(c) > 0);
  let shippingTotal = 0;
  let usesLegacyTrucking = false;
  if (activeCharges.length > 0) {
    for (const c of activeCharges) shippingTotal += round2(chargeBilled(c));
  } else if ((parseFloat(wo.truckingCost) || 0) > 0) {
    shippingTotal = parseFloat(wo.truckingCost);
    usesLegacyTrucking = true;
  }

  let running = partsSubtotal + rush.amount + shippingTotal;

  // Labor minimum
  let minimumAdjustment = 0;
  if (!wo.minimumOverride) {
    const info = calculateMinimumAdjustment(sorted, wo.minimumOverride, laborMinimums || []);
    if (info.applies) minimumAdjustment = info.adjustment;
  }
  running += minimumAdjustment;

  // Discount
  const discountPercent = parseFloat(wo.discountPercent) || 0;
  const discountAmountField = parseFloat(wo.discountAmount) || 0;
  let discountTotal = 0;
  if (discountPercent > 0) discountTotal = round2(running * discountPercent / 100);
  else if (discountAmountField > 0) discountTotal = discountAmountField;
  running -= discountTotal;

  const exempt = isTaxExempt(wo, client);
  const taxRate = exempt ? 0 : (parseFloat(wo.taxRate) || 0);
  const taxableAmount = exempt ? 0 : round2(running - shippingTotal);
  const taxAmount = round2(taxableAmount * taxRate / 100);
  const preTaxTotal = round2(running);
  const grandTotal = round2(preTaxTotal + taxAmount);

  return {
    partsSubtotal: round2(partsSubtotal),
    rushAmount: rush.amount,
    rushLabel: rush.label,
    rushPartId: rushPart ? rushPart.id : null,
    minimumAdjustment: round2(minimumAdjustment),
    discountPercent,
    discountTotal: round2(discountTotal),
    shippingTotal: round2(shippingTotal),
    usesLegacyTrucking,
    isTaxExempt: exempt,
    taxRate,
    taxableAmount,
    // Parts after minimum and discount, before tax — the "Parts Subtotal" row on the invoice
    partsAfterDiscount: round2(preTaxTotal - shippingTotal),
    taxAmount,
    preTaxTotal,
    grandTotal,
  };
}

/**
 * True when the work order has priced parts, i.e. the calculated total is meaningful.
 * (The labor minimum alone doesn't count: unpriced parts have zero labor, so the minimum would
 * otherwise turn an unpriced order into a "minimum-only" invoice.)
 */
function hasPricedLines(totals) {
  return !!totals && (totals.partsSubtotal + totals.rushAmount) > 0;
}

/** The amount to bill/collect for a work order — see the header comment for the rules. */
function invoiceAmount(totals, wo) {
  wo = plain(wo) || {};
  const stored = round2(parseFloat(wo.grandTotal) || 0);
  const chargeShipping = totals && !totals.usesLegacyTrucking ? totals.shippingTotal : 0;
  if (wo.iifExportedAt) {
    if (wo.totalsComputedAt) return stored;                              // frozen at export
    if (stored > 0) return round2(stored + chargeShipping);             // exported before this change
    return totals ? totals.grandTotal : 0;
  }
  if (hasPricedLines(totals)) return totals.grandTotal;
  if (wo.totalsComputedAt) return stored;                                // stored already includes shipping
  if (stored > 0) return round2(stored + chargeShipping);
  return totals ? totals.shippingTotal : 0;
}

// ─────────────────────────── database helpers ───────────────────────────

/**
 * Load and compute totals for many work orders in a few queries.
 * The client is resolved the same way as the QuickBooks export: by clientId, else by name.
 * @returns {Promise<Map<string, {wo, totals, amount}>>}
 */
async function loadInvoiceTotals(woIds, { transaction } = {}) {
  const ids = [...new Set((woIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const { WorkOrder, WorkOrderPart, ShipmentCharge, Client } = require('../models');
  const { Op } = require('sequelize');
  const [wos, parts, charges, laborMinimums] = await Promise.all([
    WorkOrder.findAll({ where: { id: ids }, transaction }),
    WorkOrderPart.findAll({ where: { workOrderId: ids }, transaction }),
    ShipmentCharge.findAll({ where: { workOrderId: ids }, transaction }).catch(() => []),
    loadLaborMinimums(),
  ]);
  const clientIds = [...new Set(wos.map(w => w.clientId).filter(Boolean))];
  const clients = clientIds.length
    ? await Client.findAll({ where: { id: clientIds }, attributes: ['id', 'name', 'taxStatus'], transaction })
    : [];
  const clientById = new Map(clients.map(c => [c.id, c]));
  // Fallback by name for orders without a (valid) clientId — same as resolveClient() in quickbooks.js
  const byName = new Map();
  const names = [...new Set(wos.filter(w => !clientById.has(w.clientId) && w.clientName).map(w => w.clientName))];
  for (const name of names) {
    const c = await Client.findOne({ where: { name: { [Op.iLike]: name } }, attributes: ['id', 'name', 'taxStatus'], transaction });
    if (c) byName.set(name, c);
  }
  const partsBy = new Map(); parts.forEach(p => { const k = p.workOrderId; if (!partsBy.has(k)) partsBy.set(k, []); partsBy.get(k).push(p); });
  const chargesBy = new Map(); charges.forEach(c => { const k = c.workOrderId; if (!chargesBy.has(k)) chargesBy.set(k, []); chargesBy.get(k).push(c); });
  for (const wo of wos) {
    const client = clientById.get(wo.clientId) || byName.get(wo.clientName) || null;
    const totals = computeInvoiceTotals({
      wo, parts: partsBy.get(wo.id) || [], client, shipmentCharges: chargesBy.get(wo.id) || [], laborMinimums,
    });
    out.set(wo.id, { wo, totals, amount: invoiceAmount(totals, wo) });
  }
  return out;
}

/**
 * Recompute and store grandTotal / taxAmount (full invoice total, shipping included) so code that
 * reads the stored columns sees the same number as the invoice. Marks the row with
 * totalsComputedAt. Never touches an order already exported to QuickBooks (frozen), and never
 * replaces a legacy stored total on an order without priced parts.
 */
async function refreshStoredTotals(woId, { transaction, force = false } = {}) {
  const { WorkOrder } = require('../models');
  const entry = (await loadInvoiceTotals([woId], { transaction })).get(woId);
  if (!entry) return null;
  const { wo, totals } = entry;
  if (wo.iifExportedAt && !force) return null;
  let grand, tax;
  if (hasPricedLines(totals)) { grand = totals.grandTotal; tax = totals.taxAmount; }
  else if (wo.totalsComputedAt) { grand = totals.shippingTotal; tax = 0; }   // parts were removed / unpriced
  else return null;                                                          // legacy: leave as is
  const storedGrand = round2(parseFloat(wo.grandTotal) || 0);
  const storedTax = round2(parseFloat(wo.taxAmount) || 0);
  if (wo.totalsComputedAt && Math.abs(storedGrand - grand) < 0.005 && Math.abs(storedTax - tax) < 0.005) return totals;
  await WorkOrder.update(
    { grandTotal: grand, taxAmount: tax, totalsComputedAt: new Date() },
    { where: { id: woId }, hooks: false, silent: true, transaction }
  );
  return totals;
}

/** Freeze totals as they are sent to QuickBooks. Call BEFORE setting iifExportedAt. */
async function snapshotTotalsForExport(woIds, { transaction } = {}) {
  let n = 0;
  for (const id of [...new Set(woIds || [])]) {
    try { if (await refreshStoredTotals(id, { transaction, force: true })) n++; }
    catch (e) { console.warn('[invoiceTotals] export snapshot failed for', id, e.message); }
  }
  return n;
}

// Coalesce many part saves in one request into one refresh per work order, never run two refreshes
// for the same order at once (a slow older one could otherwise write after a newer one), and allow
// bulk jobs such as a backup restore to pause the hooks entirely.
const pending = new Map();   // woId -> timer
const running = new Map();   // woId -> { again: boolean }
let suspended = 0;
function suspendTotalsHooks() { suspended++; }
function resumeTotalsHooks() { suspended = Math.max(0, suspended - 1); }

function runRefresh(woId) {
  if (running.has(woId)) { running.get(woId).again = true; return; }
  const state = { again: false };
  running.set(woId, state);
  refreshStoredTotals(woId)
    .catch(e => console.warn('[invoiceTotals] refresh failed for', woId, e.message))
    .finally(() => { running.delete(woId); if (state.again) runRefresh(woId); });
}
function scheduleRefresh(woId, options) {
  if (!woId || suspended) return;
  const run = () => {
    if (pending.has(woId)) return;
    pending.set(woId, setTimeout(() => { pending.delete(woId); runRefresh(woId); }, 250));
  };
  const t = options && options.transaction;
  if (t && typeof t.afterCommit === 'function') t.afterCommit(run); else run();
}

const WO_PRICING_FIELDS = ['taxRate', 'taxExempt', 'discountPercent', 'discountAmount', 'minimumOverride', 'truckingCost', 'clientId', 'clientName'];
// Part columns that can change a price. Updates touching none of these (tablet progress, status,
// heat numbers, notes…) skip the refresh.
const PART_PRICING_FIELDS = ['partTotal', 'quantity', 'laborTotal', 'laborRate', 'laborHours', 'materialTotal', 'materialUnitCost',
  'materialMarkupPercent', 'setupCharge', 'otherCharges', 'rollingCost', 'partType', 'partNumber', 'formData', 'workOrderId',
  'outsideProcessingCost', 'outsideProcessingMarkupPercent', 'outsideProcessingTransportCost', 'outsideProcessingTransportMarkupPercent'];

/** Keep stored totals fresh whenever parts, shipping charges or order pricing change. */
function registerTotalsHooks(models) {
  const { WorkOrder, WorkOrderPart, ShipmentCharge } = models;
  if (registerTotalsHooks.done) return;
  registerTotalsHooks.done = true;

  const whereWoIds = async (Model, options) => {
    const w = options && options.where;
    if (!w) return [];
    if (w.workOrderId && (typeof w.workOrderId === 'string' || Array.isArray(w.workOrderId))) {
      return [].concat(w.workOrderId);
    }
    try {
      const rows = await Model.findAll({ where: w, attributes: ['workOrderId'], transaction: options.transaction, raw: true });
      return rows.map(r => r.workOrderId);
    } catch (e) { return []; }
  };

  for (const Model of [WorkOrderPart, ShipmentCharge]) {
    if (!Model) continue;
    const isPart = Model === WorkOrderPart;
    const touchesPrice = (options) => !isPart || !options || !Array.isArray(options.fields)
      || options.fields.some(f => PART_PRICING_FIELDS.includes(f));
    const one = (inst, options) => scheduleRefresh(inst.workOrderId, options);
    Model.addHook('afterCreate', 'invoiceTotals', one);
    Model.addHook('afterUpdate', 'invoiceTotals', (inst, options) => {
      if (!touchesPrice(options)) return;
      one(inst, options);
      const prev = inst.previous ? inst.previous('workOrderId') : null;   // part moved between orders
      if (prev && prev !== inst.workOrderId) scheduleRefresh(prev, options);
    });
    Model.addHook('afterDestroy', 'invoiceTotals', one);
    Model.addHook('afterBulkCreate', 'invoiceTotals', (insts, options) => insts.forEach(i => one(i, options)));
    Model.addHook('beforeBulkDestroy', 'invoiceTotals', async (options) => { if (!suspended) options._totalsWoIds = await whereWoIds(Model, options); });
    Model.addHook('afterBulkDestroy', 'invoiceTotals', (options) => (options._totalsWoIds || []).forEach(id => scheduleRefresh(id, options)));
    // Capture affected orders BEFORE the update too, in case it changes a column used in the where.
    Model.addHook('beforeBulkUpdate', 'invoiceTotals', async (options) => {
      if (!suspended && touchesPrice(options)) options._totalsWoIds = await whereWoIds(Model, options);
    });
    Model.addHook('afterBulkUpdate', 'invoiceTotals', async (options) => {
      if (suspended || !touchesPrice(options)) return;
      const ids = new Set([...(options._totalsWoIds || []), ...(await whereWoIds(Model, options))]);
      ids.forEach(id => scheduleRefresh(id, options));
    });
  }
  WorkOrder.addHook('afterUpdate', 'invoiceTotals', (inst, options) => {
    const fields = options && options.fields ? options.fields : [];
    if (fields.some(f => WO_PRICING_FIELDS.includes(f))) scheduleRefresh(inst.id, options);
  });
}

module.exports = {
  computeInvoiceTotals,
  invoiceAmount,
  hasPricedLines,
  snapshotTotalsForExport,
  suspendTotalsHooks,
  resumeTotalsHooks,
  isTaxExempt,
  rushFee,
  chargeBilled,
  loadInvoiceTotals,
  refreshStoredTotals,
  registerTotalsHooks,
  round2,
};
