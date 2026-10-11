/**
 * workOrderStatus — one set of rules for changing a work order's status (audit M4).
 *
 * Before: PUT /workorders/:id/status (the tablet chips) stored ANY string, including on voided or
 * invoiced orders, and none of the side effects ran — setting "Stored" from a tablet left
 * completedAt empty and the "In Machine" marker in place, so the job never appeared in Recently
 * Completed and still showed as running. The office edit applied a different subset of side effects.
 *
 * Now both routes (and mark-complete) call planStatusChange(), which
 *  - refuses statuses the system doesn't know (400),
 *  - refuses changing the status of a voided order (409 — un-void it first),
 *  - refuses moving an order that is already in QuickBooks back to an in-shop status (409),
 *  - returns the timestamps to set with the status, and
 *  - applyDoneSideEffects() clears the "In Machine" marker when a job reaches a done state.
 */
const STATUSES = ['waiting_for_materials', 'received', 'processing', 'in_progress', 'completed', 'stored', 'shipped', 'archived'];
const IN_SHOP = ['waiting_for_materials', 'received', 'processing', 'in_progress'];
const DONE = ['completed', 'stored', 'shipped', 'archived'];

const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };
const label = (wo) => (wo.drNumber ? `DR-${wo.drNumber}` : (wo.orderNumber || 'This order'));

/**
 * Validate a change and return the fields to write with it. Throws a 4xx error when not allowed.
 * @returns {object} updates (always includes `status`), or {} when the status doesn't change
 */
function planStatusChange(wo, next, { pickedUpBy, signatureData, now = new Date() } = {}) {
  if (next === undefined || next === null || next === '') return {};
  if (!STATUSES.includes(next)) throw fail(400, `"${next}" isn't a work-order status. Use one of: ${STATUSES.join(', ')}.`);
  if (next === wo.status) return {};
  if (wo.isVoided) throw fail(409, `${label(wo)} is voided, so its status can't change. Un-void it first.`);
  if (wo.iifExportedAt && IN_SHOP.includes(next)) {
    throw fail(409, `${label(wo)} has been invoiced in QuickBooks, so it can't go back to "${next.replace(/_/g, ' ')}". ` +
      `If the work really isn't finished, un-mark it in the Invoice Center first.`);
  }
  const updates = { status: next };
  if (next === 'received' && !wo.receivedAt) updates.receivedAt = now;
  if ((next === 'completed' || next === 'stored') && !wo.completedAt) updates.completedAt = now;
  if (next === 'shipped') {
    if (!wo.completedAt) updates.completedAt = now;
    updates.pickedUpAt = now;
    if (pickedUpBy) updates.pickedUpBy = pickedUpBy;
    if (signatureData) updates.signatureData = signatureData;
  }
  return updates;
}

/** After a status change has been saved: a finished job no longer shows as "in machine". */
async function applyDoneSideEffects(wo, next, { transaction } = {}) {
  if (!DONE.includes(next)) return;
  const { WorkOrderPresence } = require('../models');
  try { await WorkOrderPresence.destroy({ where: { workOrderId: wo.id }, transaction }); } catch (e) { /* advisory */ }
}

module.exports = { planStatusChange, applyDoneSideEffects, STATUSES, DONE, IN_SHOP };
