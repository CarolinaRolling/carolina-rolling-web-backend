// ============= PO NUMBER SERVICE =============
// All PO number business logic in one place

const { Op } = require('sequelize');
const { DEFAULTS, PO_STATUSES } = require('../constants');
// All PO numbers come from the one locked reservation service (audit H11)
const poNumbers = require('./poNumbers');

class PONumberService {
  constructor(models) {
    this.models = models;
  }

  // Get next available PO number (read-only; never returns a number already used)
  async getNextNumber() {
    return poNumbers.previewNextPONumber();
  }

  // Set next PO number (admin) — can't be set at or below a number already used
  async setNextNumber(nextNumber) {
    if (!nextNumber || nextNumber < 1) throw new Error('Valid next number is required');
    const n = await poNumbers.setNextPONumber(nextNumber);
    return { nextNumber: n };
  }

  // Assign a PO number. A number typed or pre-filled on the screen is used if it's still free;
  // if someone took it a moment ago, the next free number is used and `adjustedFrom` says so.
  async assign(data) {
    const { PONumber, InboundOrder, sequelize } = this.models;
    return sequelize.transaction(async (transaction) => {
      const requested = data.customNumber ? parseInt(String(data.customNumber).replace(/\D/g, ''), 10) || null : null;
      const { numbers, adjustedFrom } = await poNumbers.reservePONumbers(1, { transaction, requested });
      const poNumber = numbers[0];

      const poEntry = await PONumber.create({
        poNumber,
        status: PO_STATUSES.ACTIVE,
        supplier: data.supplier,
        estimateId: data.estimateId,
        workOrderId: data.workOrderId,
        inboundOrderId: data.inboundOrderId,
        clientName: data.clientName,
        description: data.description
      }, { transaction });

      // Put the PO number on the linked inbound order (the column is purchaseOrderNumber — the old
      // code wrote a non-existent "poNumber" column, so this step always failed)
      if (data.inboundOrderId) {
        await InboundOrder.update(
          { purchaseOrderNumber: `PO${poNumber}` },
          { where: { id: data.inboundOrderId }, transaction }
        );
      }
      poEntry.setDataValue('adjustedFrom', adjustedFrom);
      return poEntry;
    });
  }

  // Void a PO number
  async void(poNumber, reason, voidedBy) {
    const { PONumber, InboundOrder, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      if (!reason) {
        throw new Error('Void reason is required');
      }

      const poEntry = await PONumber.findOne({ 
        where: { poNumber: parseInt(poNumber) }, 
        transaction 
      });
      
      if (!poEntry) {
        await transaction.rollback();
        throw new Error(`PO${poNumber} not found`);
      }

      if (poEntry.status === PO_STATUSES.VOID) {
        await transaction.rollback();
        throw new Error(`PO${poNumber} is already voided`);
      }

      await poEntry.update({
        status: PO_STATUSES.VOID,
        voidedAt: new Date(),
        voidedBy: voidedBy || 'admin',
        voidReason: reason
      }, { transaction });

      // A voided PO won't be delivered: cancel its expected delivery unless it already arrived.
      // (The old code wrote a non-existent "poNumber" column, so voiding a linked PO always failed.)
      if (poEntry.inboundOrderId) {
        await InboundOrder.update(
          { status: 'cancelled' },
          { where: { id: poEntry.inboundOrderId, status: { [Op.ne]: 'received' } }, transaction }
        );
      }

      await transaction.commit();
      return poEntry;
    } catch (error) {
      if (!transaction.finished) await transaction.rollback();   // earlier checks may have rolled back already
      throw error;
    }
  }

  // Delete a PO number
  async delete(id) {
    const { PONumber, WorkOrderPart, InboundOrder, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      const poEntry = await PONumber.findByPk(id, { transaction });
      
      if (!poEntry) {
        await transaction.rollback();
        throw new Error('PO number not found');
      }

      // Clear references in work order parts
      await WorkOrderPart.update(
        { materialPurchaseOrderNumber: null, materialOrdered: false, inboundOrderId: null },
        { where: { materialPurchaseOrderNumber: `PO${poEntry.poNumber}` }, transaction }
      );

      if (poEntry.inboundOrderId) {
        const inbound = await InboundOrder.findByPk(poEntry.inboundOrderId, { transaction });
        if (inbound && inbound.status === 'received') {
          const e = new Error(`Material on PO${poEntry.poNumber} was already received, so it can't be deleted (that would erase the delivery record). Void the PO instead.`);
          e.status = 409; throw e;
        }
      }

      // Remove the PO row first: it references the inbound order, so deleting the inbound order
      // first failed the database's foreign-key check and the whole delete was refused.
      const linkedInboundId = poEntry.inboundOrderId;
      await poEntry.destroy({ transaction });

      // Delete associated inbound order if exists
      if (linkedInboundId) {
        await InboundOrder.destroy({ 
          where: { id: linkedInboundId }, 
          transaction 
        });
      }

      await transaction.commit();
      return { success: true, message: `PO${poEntry.poNumber} deleted` };
    } catch (error) {
      if (!transaction.finished) await transaction.rollback();   // earlier checks may have rolled back already
      throw error;
    }
  }

  // Get all PO numbers with filters
  async getAll(options = {}) {
    const { PONumber, WorkOrder } = this.models;
    const { status, supplier, limit = 50, offset = 0 } = options;

    const where = {};
    if (status) where.status = status;
    if (supplier) where.supplier = { [Op.iLike]: `%${supplier}%` };

    return PONumber.findAndCountAll({
      where,
      include: [
        { model: WorkOrder, as: 'workOrder', attributes: ['id', 'drNumber', 'orderNumber', 'clientName', 'status'], required: false }
      ],
      order: [['poNumber', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  }

  // Get stats
  async getStats() {
    const { PONumber, AppSettings } = this.models;

    const lastUsed = await PONumber.findOne({
      where: { status: PO_STATUSES.ACTIVE },
      order: [['poNumber', 'DESC']]
    });

    const setting = await AppSettings.findOne({ where: { key: 'next_po_number' } });
    const nextNumber = setting?.value?.nextNumber || (lastUsed ? lastUsed.poNumber + 1 : DEFAULTS.STARTING_PO_NUMBER);

    const voidedCount = await PONumber.count({ where: { status: PO_STATUSES.VOID } });
    const activeCount = await PONumber.count({ where: { status: PO_STATUSES.ACTIVE } });

    return {
      lastUsed: lastUsed?.poNumber || DEFAULTS.STARTING_PO_NUMBER - 1,
      nextNumber,
      voidedCount,
      activeCount
    };
  }
}

module.exports = PONumberService;
