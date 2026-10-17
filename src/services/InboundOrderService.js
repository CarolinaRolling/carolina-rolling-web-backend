// ============= INBOUND ORDER SERVICE =============
// All inbound order business logic in one place

const { INBOUND_STATUSES } = require('../constants');

const conflict = (message, code) => { const e = new Error(message); e.status = 409; e.code = code; return e; };
const isReceived = (order) => order.status === INBOUND_STATUSES.RECEIVED || !!order.receivedAt;

class InboundOrderService {
  constructor(models) {
    this.models = models;
  }

  // Get inbound order by ID
  async getById(id) {
    const { InboundOrder, Vendor, WorkOrder } = this.models;
    return InboundOrder.findByPk(id, {
      include: [
        { model: Vendor, as: 'vendor', attributes: ['id', 'name', 'contactName', 'contactPhone', 'contactEmail'] },
        { model: WorkOrder, as: 'workOrder', attributes: ['id', 'orderNumber', 'drNumber', 'clientName', 'clientPurchaseOrderNumber', 'status'] }
      ]
    });
  }

  // Get all inbound orders
  async getAll(options = {}) {
    const { InboundOrder, Vendor, WorkOrder } = this.models;
    const { status, offset = 0 } = options;
    const { Op } = require('sequelize');
    const include = [
      { model: Vendor, as: 'vendor', attributes: ['id', 'name', 'contactName', 'contactPhone', 'contactEmail'] },
      { model: WorkOrder, as: 'workOrder', attributes: ['id', 'orderNumber', 'drNumber', 'clientName', 'clientPurchaseOrderNumber', 'status'] }
    ];
    const order = [['createdAt', 'DESC']];
    const DONE = ['received', 'cancelled'];
    const explicitLimit = options.limit !== undefined && options.limit !== '';

    // Before: a fixed 100 newest — once there were more, older deliveries still expected dropped off
    // the tablets and the Inbound page (audit M10). With no limit sent: every open delivery plus the
    // 100 most recent received/cancelled ones. status=open → open ones only. A limit pages as before.
    if (!explicitLimit && (!status || status === 'open')) {
      const OPEN = { [Op.or]: [{ status: null }, { status: { [Op.notIn]: DONE } }] };
      const open = await InboundOrder.findAll({ where: OPEN, include, order });
      if (status === 'open') return open;
      const done = await InboundOrder.findAll({ where: { status: { [Op.in]: DONE } }, include, order, limit: 100 });
      return [...open, ...done].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    const where = {};
    if (status === 'open') where[Op.or] = [{ status: null }, { status: { [Op.notIn]: DONE } }];
    else if (status) where.status = status;
    return InboundOrder.findAll({
      where, include, order,
      limit: Math.min(parseInt(options.limit) || 100, 5000),
      offset: parseInt(offset) || 0
    });
  }

  // Create inbound order
  async create(data) {
    const { InboundOrder, Vendor } = this.models;

    // Resolve vendor name from vendorId
    let supplierName = data.supplierName;
    if (data.vendorId && !supplierName) {
      const vendor = await Vendor.findByPk(data.vendorId);
      if (vendor) supplierName = vendor.name;
    }

    if (!supplierName || !data.purchaseOrderNumber || !data.description || !data.clientName) {
      throw new Error('Missing required fields: vendor/supplierName, purchaseOrderNumber, description, clientName');
    }

    return InboundOrder.create({
      vendorId: data.vendorId || null,
      supplierName: supplierName,
      supplier: supplierName,
      purchaseOrderNumber: data.purchaseOrderNumber,
      description: data.description,
      clientName: data.clientName,
      status: data.status || INBOUND_STATUSES.PENDING,
      workOrderId: data.workOrderId || null,
      expectedDate: data.expectedDate || null
    });
  }

  // Update inbound order
  async update(id, data) {
    const order = await this.getById(id);
    
    if (!order) {
      throw new Error('Inbound order not found');
    }

    // The PO number ties the delivery to its PO record and to the parts ordered on it; changing it
    // here alone left those behind on the old number (round 13, R21). Refuse — the PO is released or
    // reassigned from the PO screen instead.
    if (data.purchaseOrderNumber !== undefined && data.purchaseOrderNumber !== null && data.purchaseOrderNumber !== ''
        && String(data.purchaseOrderNumber).trim() !== String(order.purchaseOrderNumber || '').trim()) {
      throw conflict(`This delivery is for ${order.purchaseOrderNumber}. Its PO number can't be changed here (the PO and the parts ordered on it would stay on the old number) — release or reassign the PO instead.`, 'PO_NUMBER_LOCKED');
    }

    // status / receivedAt / receivedBy are not edited here (U8: {status:'pending', receivedAt:null}
    // un-received a delivery so it could be deleted, and {status:'received'} marked it received without
    // receiving its parts). Status changes go through updateStatus / markReceived.
    await order.update({
      supplierName: data.supplierName || order.supplierName,
      purchaseOrderNumber: data.purchaseOrderNumber || order.purchaseOrderNumber,
      description: data.description || order.description,
      clientName: data.clientName || order.clientName,
      expectedDate: data.expectedDate !== undefined ? data.expectedDate : order.expectedDate
    });

    return this.getById(id);
  }

  // Delete inbound order. A RECEIVED delivery is the receiving record PO release and the material
  // history rely on — only an admin may delete it (round 13, R21). options.isAdmin comes from the route.
  async delete(id, options = {}) {
    const { sequelize } = this.models;
    const transaction = options.transaction || await sequelize.transaction();
    const own = !options.transaction;

    try {
      await this._destroy(id, { transaction, isAdmin: !!options.isAdmin });
      if (own) await transaction.commit();
      return { success: true, message: 'Inbound order deleted successfully' };
    } catch (error) {
      if (own && !transaction.finished) await transaction.rollback();
      throw error;
    }
  }

  async _destroy(id, { transaction, isAdmin }) {
    const { InboundOrder, WorkOrderPart, PONumber } = this.models;
    const order = await InboundOrder.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('Inbound order not found');
    if (isReceived(order) && !isAdmin) {
      throw conflict('This delivery has already been received — it is the receiving record for its PO, so only an admin can delete it.', 'DELIVERY_RECEIVED');
    }

    // Clear references in work order parts
    await WorkOrderPart.update(
      { inboundOrderId: null },
      { where: { inboundOrderId: id }, transaction }
    );

    // Clear references in PO numbers
    await PONumber.update(
      { inboundOrderId: null },
      { where: { inboundOrderId: id }, transaction }
    );

    await order.destroy({ transaction });
    return order;
  }

  // Convert a delivery into a received shipment (web: Inbound details → "Convert to Shipment").
  // Before, the browser created the shipment and then deleted the delivery in two calls — a failure
  // in between left both, or a shipment with the delivery gone — and the shipment wasn't put on the
  // delivery's work order (round 13, R21). Now one transaction, on the server: the shipment is created on
  // the delivery's work order and the delivery is received (kept as the PO's receiving record).
  async convertToShipment(id, options = {}) {
    const { InboundOrder, Shipment, sequelize } = this.models;
    return sequelize.transaction(async (transaction) => {
      // Same lock order as receiving (work order, then the delivery), so the two can't deadlock
      const peek = await InboundOrder.findByPk(id, { attributes: ['id', 'workOrderId'], transaction });
      if (peek && peek.workOrderId) await this.models.WorkOrder.findByPk(peek.workOrderId, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
      const order = await InboundOrder.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!order) throw new Error('Inbound order not found');
      // U36: converting a received delivery again makes a second shipment — refused unless an admin
      // explicitly asks for it (force)
      if (isReceived(order) && !(options.isAdmin && options.force)) {
        throw conflict(options.isAdmin
          ? 'This delivery has already been received, so a shipment for it probably exists already. Convert it again only if you are sure (send force).'
          : 'This delivery has already been received, so a shipment for it probably exists already — only an admin can convert it again.', 'DELIVERY_RECEIVED');
      }
      // No order on the delivery (material ordered on an estimate before it became an order): use the
      // order of the parts stamped with this delivery (U21)
      let workOrderId = order.workOrderId || null;
      if (!workOrderId && this.models.WorkOrderPart) {
        const part = await this.models.WorkOrderPart.findOne({ where: { inboundOrderId: id }, attributes: ['workOrderId'], order: [['createdAt', 'ASC']], transaction });
        if (part && part.workOrderId) workOrderId = part.workOrderId;
      }
      const supplier = order.supplierName || order.supplier || '';
      // W9: the shipment is for the order's client (the delivery's may be stale, e.g. from before an
      // estimate for another client was linked)
      let clientName = order.clientName;
      if (workOrderId) {
        const wo = await this.models.WorkOrder.findByPk(workOrderId, { attributes: ['id', 'clientName'], transaction });
        if (wo && wo.clientName && String(wo.clientName).trim()) clientName = wo.clientName;
      }
      const shipment = await Shipment.create({
        qrCode: `SHIP-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
        clientName,
        description: order.description,
        notes: `From supplier: ${supplier}\nPO#: ${order.purchaseOrderNumber}`,
        workOrderId,
        receivedBy: options.receivedBy || null,
        receivedAt: new Date(),
        partNumbers: [],
        quantity: 1,
      }, { transaction });
      // The material arrived: receive it like the dock does (parts marked received, the work order's
      // material status updated) and KEEP the delivery as the PO's receiving record, instead of deleting
      // it and leaving the parts "ordered, not received" with nothing to receive against (review of round 14)
      if (!isReceived(order)) await require('./materialReceiving').receiveInboundOrder(id, { receivedBy: options.receivedBy || null, transaction });
      return shipment;
    });
  }

  // Update status
  async updateStatus(id, status, options = {}) {
    const order = await this.getById(id);
    
    if (!order) {
      throw new Error('Inbound order not found');
    }

    if (status === INBOUND_STATUSES.RECEIVED && isReceived(order)) return order;
    // Un-receiving a delivery (U8): admin only; its received date goes with it. The parts received on
    // it are not un-received.
    if (status !== INBOUND_STATUSES.RECEIVED && isReceived(order)) {
      if (!options.isAdmin) throw conflict('This delivery has already been received — only an admin can set it back to not received.', 'DELIVERY_RECEIVED');
      await order.update({ status, receivedAt: null, receivedBy: null });
      return this.getById(id);
    }

    if (status === INBOUND_STATUSES.RECEIVED) {
      // Same receive as the dock and the scanned paperwork — also updates the work order (audit H12)
      await require('./materialReceiving').receiveInboundOrder(id, {});
      return this.getById(id);
    }

    await order.update({ status });
    return this.getById(id);
  }

  // Mark as received
  async markReceived(id, receivedBy) {
    const order = await this.getById(id);
    
    if (!order) {
      throw new Error('Inbound order not found');
    }

    await require('./materialReceiving').receiveInboundOrder(id, { receivedBy });
    return this.getById(id);
  }
}

module.exports = InboundOrderService;
