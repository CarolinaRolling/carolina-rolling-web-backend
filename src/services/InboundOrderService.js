// ============= INBOUND ORDER SERVICE =============
// All inbound order business logic in one place

const { INBOUND_STATUSES } = require('../constants');

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

    await order.update({
      supplierName: data.supplierName || order.supplierName,
      purchaseOrderNumber: data.purchaseOrderNumber || order.purchaseOrderNumber,
      description: data.description || order.description,
      clientName: data.clientName || order.clientName,
      status: data.status || order.status,
      expectedDate: data.expectedDate !== undefined ? data.expectedDate : order.expectedDate,
      receivedAt: data.receivedAt !== undefined ? data.receivedAt : order.receivedAt
    });

    return this.getById(id);
  }

  // Delete inbound order
  async delete(id) {
    const { InboundOrder, WorkOrderPart, PONumber, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      const order = await InboundOrder.findByPk(id, { transaction });
      
      if (!order) {
        await transaction.rollback();
        throw new Error('Inbound order not found');
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

      await transaction.commit();
      return { success: true, message: 'Inbound order deleted successfully' };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Update status
  async updateStatus(id, status) {
    const order = await this.getById(id);
    
    if (!order) {
      throw new Error('Inbound order not found');
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
