/**
 * pricingRecovery — put back work-order part prices that went missing, from the estimate the order
 * came from. Drives the "Fix Pricing" banner and button on the work-order page.
 *
 * How prices went missing (fixed in round 3, M15): before 11 Oct 2026, every tablet tap on a part —
 * a status change, a progress count, an operator note — saved the part with all its price columns
 * blank. Two kinds of damage are left behind:
 *
 *  A. "All blank": total, labor and material all empty. The old Fix Pricing handled these, but the
 *     next tablet tap blanked them again, so the fix looked like it didn't work.
 *  B. "Material blank, total too low": someone opened a part from (A) in the office and saved it. The
 *     form recalculated the total with material at $0, so the part now has a labor-only total. The
 *     old banner didn't appear (the part has a total) and the old Fix skipped it — but it is
 *     undercharging the material.
 *
 * Both are now detected and repaired from the matching estimate part. Labor that was entered on the
 * work order is kept; only the missing material is put back and the total recalculated.
 *
 * Parts are matched to estimate parts by line number AND part type; if that fails, by part type +
 * client part number + quantity when exactly one estimate part fits. Nothing is guessed beyond that.
 */
const { buildWorkOrderPartFromEstimate } = require('./pricing');

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const has = (v) => num(v) > 0;
const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

const EA_PRICED = ['plate_roll', 'shaped_plate', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar',
  'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll', 'fab_service', 'shop_rate'];
const SKIP_TYPES = ['rush_service'];

function matchEstimatePart(wp, estParts, used) {
  const free = estParts.filter(ep => !used.has(ep.id));
  let m = free.find(ep => ep.partNumber === wp.partNumber && ep.partType === wp.partType);
  if (m) return m;
  const c = free.filter(ep => ep.partType === wp.partType
    && (ep.clientPartNumber || '') === (wp.clientPartNumber || '')
    && (parseInt(ep.quantity) || 1) === (parseInt(wp.quantity) || 1));
  return c.length === 1 ? c[0] : null;
}

/** Estimate material cost each (the forms write materialTotal; the estimate's own panel writes materialUnitCost) */
function estimateMaterialEach(ep) {
  const fd = ep.formData && typeof ep.formData === 'object' ? ep.formData : {};
  return num(ep.materialTotal) || num(ep.materialUnitCost) || num(fd.materialUnitCost);
}

/**
 * Work out what to change on one part. Returns null when nothing needs fixing.
 * @returns {{ kind: 'all'|'material', patch: object, before: number, after: number }}
 */
function planPart(wpIn, epIn) {
  const wp = plain(wpIn), ep = plain(epIn);
  if (!ep || SKIP_TYPES.includes(wp.partType)) return null;
  const rebuilt = buildWorkOrderPartFromEstimate(ep);

  // A. everything blank → take the estimate's pricing as converted
  if (!has(wp.partTotal)) {
    if (!has(rebuilt.partTotal) && !has(ep.partTotal)) return null;   // estimate has nothing to copy either
    const patch = {};
    for (const f of ['materialTotal', 'materialUnitCost', 'materialMarkupPercent', 'laborTotal', 'setupCharge', 'otherCharges', 'partTotal']) {
      if (rebuilt[f] !== undefined && rebuilt[f] !== null) patch[f] = rebuilt[f];
    }
    if (!Object.keys(patch).length) return null;
    return { kind: 'all', patch, before: 0, after: num(patch.partTotal) };
  }

  // B. total present but material blank while the estimate had material → put the material back and
  //    recalculate the total with the work order's own labor
  if (!EA_PRICED.includes(wp.partType)) return null;
  const woMat = num(wp.materialTotal) || num(wp.materialUnitCost);
  const estMat = estimateMaterialEach(ep);
  if (woMat > 0 || !(estMat > 0)) return null;
  const matPatch = {
    materialTotal: rebuilt.materialTotal != null ? rebuilt.materialTotal : estMat,
    materialMarkupPercent: rebuilt.materialMarkupPercent,
  };
  if (num(ep.materialUnitCost) > 0) matPatch.materialUnitCost = num(ep.materialUnitCost);
  // Same calculation conversion uses, run on the WORK ORDER part with the material restored
  const recomputed = buildWorkOrderPartFromEstimate({ ...wp, ...matPatch, formData: wp.formData });
  const after = num(recomputed.partTotal);
  if (!(after > num(wp.partTotal))) return null;   // only ever adds the missing material
  return { kind: 'material', patch: { ...matPatch, partTotal: after }, before: num(wp.partTotal), after };
}

/** Plan (and optionally apply) the fix for a whole work order. */
async function recoverWorkOrderPricing(workOrderId, { apply = false } = {}) {
  const { WorkOrder, WorkOrderPart, EstimatePart } = require('../models');
  const wo = await WorkOrder.findByPk(workOrderId, { include: [{ model: WorkOrderPart, as: 'parts' }] });
  if (!wo) { const e = new Error('Work order not found'); e.status = 404; throw e; }
  if (!wo.estimateId) return { wo, items: [], reason: 'This work order is not linked to an estimate, so there is nothing to copy pricing from.' };
  const estParts = (await EstimatePart.findAll({ where: { estimateId: wo.estimateId } })).map(plain);
  const used = new Set();
  const items = [];
  for (const wp of [...(wo.parts || [])].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0))) {
    const ep = matchEstimatePart(wp, estParts, used);
    if (!ep) continue;
    used.add(ep.id);
    const plan = planPart(wp, ep);
    if (plan) items.push({ part: wp, estimatePart: ep, ...plan });
  }
  if (apply) {
    for (const it of items) {
      try {
        await it.part.update(it.patch);
        it.applied = true;
      } catch (e) {
        it.applied = false;
        it.error = e.code === 'INVOICE_LOCKED'
          ? 'this order is in QuickBooks — un-mark it in the Invoice Center first'
          : e.message;
      }
    }
  }
  return { wo, items };
}

const money = (n) => `$${num(n).toFixed(2)}`;
function describe(it) {
  const label = `Part ${it.part.partNumber}${it.part.clientPartNumber ? ` (${it.part.clientPartNumber})` : ''}`;
  if (it.kind === 'all') return `${label}: prices were blank — restore from the estimate, total ${money(it.after)}`;
  return `${label}: material was missing — add ${money(it.patch.materialTotal)} each (+${num(it.patch.materialMarkupPercent)}%), total ${money(it.before)} → ${money(it.after)}`;
}

module.exports = { recoverWorkOrderPricing, planPart, matchEstimatePart, describe };
