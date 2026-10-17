/**
 * duplicateCopy — what "Duplicate estimate" and "Work order → new estimate (reorder)" carry over
 * (round 14, audit T20). Before, both copied a hand-written field list: service lines kept pointing at
 * the SOURCE's parts (after a convert, at a part on another order), and trips, discount, shipping
 * charges, outside processing and the client id were dropped, so a repeat order was quoted low.
 *
 * A copy is a new quote: everything priced is kept; anything that records work already done on the
 * source (POs, material ordered/received, lot/heat numbers, OP sent/returned, link tags) is cleared.
 */

// Part fields that describe the source job's progress, not the quote
const PART_STATE_FIELDS = new Set([
  'id', 'estimateId', 'workOrderId', 'createdAt', 'updatedAt',
  'lotNumber', 'heatNumber', 'heatCountry', 'actualRunTimeMin',
  'materialOrdered', 'materialPurchaseOrderNumber', 'materialOrderedAt', 'materialReceived', 'materialReceivedAt', 'inboundOrderId',
  'outsideProcessingPONumber', 'outsideProcessingPOSentAt', 'outsideProcessingStatus', 'outsideProcessingExpectedReturn', 'outsideProcessingReturnedAt',
  'rfqSentAt', 'awaitingPONumber',
  // the old order's customer PO line / job number belong to that order, not to a new quote
  'poLineNumber', 'clientJobNumber',
  // work-order progress (the reorder copies from work-order parts)
  'status', 'completedAt', 'completedBy', 'progressCount', 'progressLastUpdatedAt', 'progressLog', 'operatorNotes', 'heatBreakdown', 'awaitingInboundId',
]);
// formData keys that tie a line to its source
const FD_DROP = ['_fromEstimateId', '_estimateLinkRestore', '_linkedPartId', 'lotNumber', 'progressCount', 'progressLog', 'progressLastUpdatedAt', 'status', 'completedAt', 'completedBy', 'heatNumber', 'heatBreakdown'];
// keys inside a trip / outside-processing entry that record that it was ordered
const ENTRY_STATE = ['poNumber', 'poId', 'poSentAt', 'poNumberId', 'status', 'sentAt', 'returnedAt', 'expectedReturn', 'receivedAt', '_fromEstimateId'];

const plain = (x) => (x && typeof x.toJSON === 'function') ? x.toJSON() : (x || {});
const obj = (v) => {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
};

function freshEntries(list) {
  if (!Array.isArray(list)) return list == null ? list : [];
  return list.filter(e => e && typeof e === 'object').map(e => {
    const c = { ...e };
    for (const k of ENTRY_STATE) delete c[k];
    return c;
  });
}

/** Part data for the copy, limited to the target model's columns. Leaves _linkedPartId for remap(). */
function partForCopy(src, targetModel, overrides = {}) {
  const s = plain(src);
  const cols = Object.keys(targetModel.rawAttributes);
  const out = {};
  for (const k of cols) {
    if (PART_STATE_FIELDS.has(k)) continue;
    if (s[k] !== undefined) out[k] = s[k];
  }
  if ('outsideProcessing' in out) out.outsideProcessing = freshEntries(out.outsideProcessing);
  const fd = { ...obj(s.formData) };
  for (const k of FD_DROP) delete fd[k];
  if (Array.isArray(fd.outsideProcessing)) fd.outsideProcessing = freshEntries(fd.outsideProcessing);
  out.formData = fd;
  return Object.assign(out, overrides);
}

/** After creating the copies: point service lines at the COPIED parts. idMap: sourcePartId → newPartId */
async function remapServiceLinks(targetModel, sources, idMap, { transaction } = {}) {
  for (const src of sources) {
    const s = plain(src);
    const link = obj(s.formData)._linkedPartId;
    if (!link || !idMap[s.id]) continue;
    const row = await targetModel.findByPk(idMap[s.id], { transaction });
    if (!row) continue;
    const fd = { ...obj(row.formData) };
    if (idMap[link]) fd._linkedPartId = idMap[link]; else delete fd._linkedPartId;   // parent not copied: stand-alone line
    await row.update({ formData: fd }, { transaction, hooks: false });
  }
}

/** Copy shipping charges from { estimateId } or { workOrderId } onto an estimate. */
async function copyChargesToEstimate(models, from, estimateId, { transaction } = {}) {
  const { ShipmentCharge } = models;
  if (!ShipmentCharge) return 0;
  const rows = await ShipmentCharge.findAll({ where: from, transaction });
  const cols = Object.keys(ShipmentCharge.rawAttributes).filter(k => !['id', 'workOrderId', 'estimateId', 'createdAt', 'updatedAt', 'shipmentId', 'poNumber', 'poNumberId'].includes(k));
  for (const r of rows) {
    const j = plain(r); const data = {};
    for (const k of cols) if (j[k] !== undefined) data[k] = j[k];
    await ShipmentCharge.create({ ...data, estimateId, workOrderId: null }, { transaction });
  }
  return rows.length;
}

module.exports = { partForCopy, remapServiceLinks, copyChargesToEstimate, freshEntries, PART_STATE_FIELDS };
