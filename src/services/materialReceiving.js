/**
 * materialReceiving — the ONE way material is marked received (audit H12).
 *
 * Before: three places received material, each differently.
 *  - Dock receiving (shipments) and the scanned-paperwork "receive" marked EVERY part on the work
 *    order that had material ordered as received — so when one of two suppliers delivered, the order
 *    showed all material in and left "waiting for materials" while the other PO was still out. The
 *    same happened when an outside-processing (OP) return arrived.
 *  - The Inbound screen marked only that PO's parts but never updated the work order, so it could
 *    sit in "waiting for materials" forever.
 *
 * Now a delivery is received by its inbound order: only the parts ordered on THAT PO are marked, and
 * the work order's allMaterialReceived / status are then worked out from all of its parts. The work
 * order moves from "waiting for materials" to "received" only when nothing ordered is still out.
 */
const { Op } = require('sequelize');
const models = () => require('../models');

const RECEIVED = 'received';

/**
 * Work out allMaterialReceived from the parts, and move the order out of waiting_for_materials when
 * everything ordered is in. Returns the updated work order (or null).
 */
async function refreshWorkOrderMaterialStatus(workOrderId, { transaction, receivedBy } = {}) {
  const { WorkOrder, WorkOrderPart } = models();
  if (!workOrderId) return null;
  const wo = await WorkOrder.findByPk(workOrderId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!wo) return null;
  const outstanding = await WorkOrderPart.count({
    where: { workOrderId, materialOrdered: true, [Op.or]: [{ materialReceived: false }, { materialReceived: null }] },
    transaction,
  });
  const updates = {};
  const all = outstanding === 0;
  if (all) {
    if (wo.allMaterialReceived !== true) updates.allMaterialReceived = true;
    if (wo.status === 'waiting_for_materials') updates.status = 'received';
  } else if (wo.status === 'waiting_for_materials' && wo.allMaterialReceived !== false) {
    // Only an order that is waiting for material is marked "not all in" — an order that was already
    // marked received (e.g. by hand) is never flipped back by an unrelated delivery.
    updates.allMaterialReceived = false;
  }
  if (all && receivedBy && !wo.receivedBy) updates.receivedBy = receivedBy;
  if (Object.keys(updates).length) await wo.update(updates, { transaction });
  return wo;
}

// "PO 7801", "po-7801", "7801" → "7801"; outside-processing / trucking POs keep their prefix
const normPO = (v) => {
  const s = String(v || '').toUpperCase().replace(/[\s#-]/g, '');
  return s.replace(/^PO/, '');
};
const isServicePO = (v) => /^(OP|TR)/.test(String(v || '').toUpperCase().replace(/\s/g, ''));

/**
 * Parts that belong to an inbound order: the ones stamped with its id. For older orders whose parts
 * were never stamped: the ordered parts on the same work order with the same PO number — and, when
 * this was the order's last open material delivery, any remaining unstamped ordered parts (what the
 * old code did, but only when it can't be someone else's delivery).
 */
async function partsForInbound(inbound, transaction) {
  const { WorkOrderPart, InboundOrder } = models();
  const stamped = await WorkOrderPart.findAll({ where: { inboundOrderId: inbound.id }, transaction });
  if (stamped.length || !inbound.workOrderId || isServicePO(inbound.purchaseOrderNumber)) return stamped;
  const unstamped = await WorkOrderPart.findAll({
    where: { workOrderId: inbound.workOrderId, materialOrdered: true, inboundOrderId: null }, transaction,
  });
  const want = normPO(inbound.purchaseOrderNumber);
  const byPO = want ? unstamped.filter(p => normPO(p.materialPurchaseOrderNumber) === want) : [];
  if (byPO.length) return byPO;
  const otherOpen = (await InboundOrder.findAll({
    where: { workOrderId: inbound.workOrderId, id: { [Op.ne]: inbound.id }, status: { [Op.notIn]: [RECEIVED, 'cancelled'] } },
    attributes: ['purchaseOrderNumber'], transaction,
  })).filter(o => !isServicePO(o.purchaseOrderNumber));
  return otherOpen.length ? [] : unstamped;
}

/**
 * Receive one inbound order (one PO delivery). Idempotent. Must be given a transaction or opens one.
 * @returns {{ inbound, parts: number, workOrder }}
 */
async function receiveInboundOrder(inboundOrderId, { receivedBy = null, transaction } = {}) {
  const { sequelize, InboundOrder, WorkOrderPart } = models();
  const run = async (t) => {
    // Lock order everywhere: work order first, then its inbound order (same as the dock and the
    // work-order delete) so two receives of the same delivery can't deadlock.
    const peek = await InboundOrder.findByPk(inboundOrderId, { attributes: ['id', 'workOrderId'], transaction: t });
    if (peek && peek.workOrderId) await models().WorkOrder.findByPk(peek.workOrderId, { attributes: ['id'], transaction: t, lock: t.LOCK.UPDATE });
    const inbound = await InboundOrder.findByPk(inboundOrderId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!inbound) { const e = new Error('Inbound order not found'); e.status = 404; throw e; }
    if (inbound.status === 'cancelled') { const e = new Error(`${inbound.purchaseOrderNumber || 'This order'} was cancelled and can't be received.`); e.status = 409; throw e; }
    const now = new Date();
    if (inbound.status !== RECEIVED) {
      await inbound.update({ status: RECEIVED, receivedAt: inbound.receivedAt || now, receivedBy: receivedBy || inbound.receivedBy || null }, { transaction: t });
    }
    const parts = (await partsForInbound(inbound, t)).filter(p => !p.materialReceived);
    if (parts.length) {
      await WorkOrderPart.update({ materialReceived: true, materialReceivedAt: now }, { where: { id: parts.map(p => p.id) }, transaction: t });
    }
    const woIds = new Set(parts.map(p => p.workOrderId));
    if (inbound.workOrderId) woIds.add(inbound.workOrderId);
    let workOrder = null;
    for (const id of woIds) {
      const wo = await refreshWorkOrderMaterialStatus(id, { transaction: t, receivedBy });
      if (id === inbound.workOrderId) workOrder = wo;
    }
    return { inbound, parts: parts.length, workOrder };
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

/**
 * Material arrived for a work order without naming a PO (e.g. walk-in / customer material received
 * onto an existing order). Same as before: every ordered part on the order is marked received —
 * then the order's status is worked out the same way as above.
 */
async function receiveAllForWorkOrder(workOrderId, { receivedBy = null, transaction } = {}) {
  const { sequelize, WorkOrderPart } = models();
  const run = async (t) => {
    await WorkOrderPart.update({ materialReceived: true, materialReceivedAt: new Date() }, {
      where: { workOrderId, materialOrdered: true, [Op.or]: [{ materialReceived: false }, { materialReceived: null }] }, transaction: t,
    });
    return refreshWorkOrderMaterialStatus(workOrderId, { transaction: t, receivedBy });
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

module.exports = { receiveInboundOrder, receiveAllForWorkOrder, refreshWorkOrderMaterialStatus };
