// ============= INBOUND ORDER SERVICE =============
// All inbound order business logic in one place

const { INBOUND_STATUSES } = require('../constants');

class InboundOrderService {
  constructor(models) {
    this.models = models;
  }

  // Get inbound order by ID
  async getById(id) {
    const { InboundOrder, Vendor } = this.models;
    return InboundOrder.findByPk(id, {
      include: [{ model: Vendor, as: 'vendor', attributes: ['id', 'name', 'contactName', 'contactPhone', 'contactEmail'] }]
    });
  }

  // Get all inbound orders
  async getAll(options = {}) {
    const { InboundOrder, Vendor } = this.models;
    const { status, limit = 100, offset = 0 } = options;

    const where = {};
    if (status) where.status = status;

    return InboundOrder.findAll({
      where,
      include: [{ model: Vendor, as: 'vendor', attributes: ['id', 'name', 'contactName', 'contactPhone', 'contactEmail'] }],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
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
    const { WorkOrderPart } = this.models;
    const order = await this.getById(id);
    
    if (!order) {
      throw new Error('Inbound order not found');
    }

    const updates = { status };
    
    if (status === INBOUND_STATUSES.RECEIVED) {
      updates.receivedAt = new Date();
      
      // Update linked work order parts
      await WorkOrderPart.update(
        { materialReceived: true, materialReceivedAt: new Date() },
        { where: { inboundOrderId: id } }
      );
    }

    await order.update(updates);
    return this.getById(id);
  }

  // Mark as received
  async markReceived(id, receivedBy) {
    const { WorkOrderPart } = this.models;
    const order = await this.getById(id);
    
    if (!order) {
      throw new Error('Inbound order not found');
    }

    await order.update({
      status: INBOUND_STATUSES.RECEIVED,
      receivedAt: new Date(),
      receivedBy: receivedBy || null
    });

    // Update linked work order parts - mark material as received
    await WorkOrderPart.update(
      { materialReceived: true, materialReceivedAt: new Date() },
      { where: { inboundOrderId: id } }
    );

    return this.getById(id);
  }
}

module.exports = InboundOrderService;
