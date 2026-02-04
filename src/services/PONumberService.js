// ============= PO NUMBER SERVICE =============
// All PO number business logic in one place

const { Op } = require('sequelize');
const { DEFAULTS, PO_STATUSES } = require('../constants');

class PONumberService {
  constructor(models) {
    this.models = models;
  }

  // Get next available PO number
  async getNextNumber() {
    const { PONumber, AppSettings } = this.models;

    // Check settings for custom next number
    const setting = await AppSettings.findOne({ where: { key: 'next_po_number' } });
    
    if (setting?.value?.nextNumber) {
      return setting.value.nextNumber;
    }

    // Find the highest PO number used
    const lastPO = await PONumber.findOne({
      order: [['poNumber', 'DESC']]
    });

    return lastPO ? lastPO.poNumber + 1 : DEFAULTS.STARTING_PO_NUMBER;
  }

  // Set next PO number
  async setNextNumber(nextNumber) {
    const { PONumber, AppSettings } = this.models;

    if (!nextNumber || nextNumber < 1) {
      throw new Error('Valid next number is required');
    }

    // Check if number already exists
    const existing = await PONumber.findOne({ where: { poNumber: nextNumber } });
    if (existing) {
      throw new Error(`PO${nextNumber} already exists`);
    }

    // Save to settings
    await AppSettings.upsert({
      key: 'next_po_number',
      value: { nextNumber }
    });

    return { nextNumber };
  }

  // Assign a PO number
  async assign(data) {
    const { PONumber, AppSettings, InboundOrder, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      let poNumber;

      if (data.customNumber) {
        // Check if custom number is available
        const existing = await PONumber.findOne({ 
          where: { poNumber: data.customNumber }, 
          transaction 
        });
        if (existing) {
          await transaction.rollback();
          throw new Error(`PO${data.customNumber} already exists`);
        }
        poNumber = data.customNumber;
      } else {
        // Get next available number
        const setting = await AppSettings.findOne({ 
          where: { key: 'next_po_number' }, 
          transaction 
        });
        
        if (setting?.value?.nextNumber) {
          poNumber = setting.value.nextNumber;
          await setting.update({ value: { nextNumber: poNumber + 1 } }, { transaction });
        } else {
          const lastPO = await PONumber.findOne({
            order: [['poNumber', 'DESC']],
            transaction
          });
          poNumber = lastPO ? lastPO.poNumber + 1 : DEFAULTS.STARTING_PO_NUMBER;
          
          await AppSettings.upsert({
            key: 'next_po_number',
            value: { nextNumber: poNumber + 1 }
          }, { transaction });
        }
      }

      // Create PO number entry
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

      // Update inbound order with PO number if provided
      if (data.inboundOrderId) {
        await InboundOrder.update(
          { poNumber: `PO${poNumber}` },
          { where: { id: data.inboundOrderId }, transaction }
        );
      }

      await transaction.commit();
      return poEntry;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
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

      // Clear PO number from inbound order if linked
      if (poEntry.inboundOrderId) {
        await InboundOrder.update(
          { poNumber: null },
          { where: { id: poEntry.inboundOrderId }, transaction }
        );
      }

      await transaction.commit();
      return poEntry;
    } catch (error) {
      await transaction.rollback();
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

      // Delete associated inbound order if exists
      if (poEntry.inboundOrderId) {
        await InboundOrder.destroy({ 
          where: { id: poEntry.inboundOrderId }, 
          transaction 
        });
      }

      await poEntry.destroy({ transaction });

      await transaction.commit();
      return { success: true, message: `PO${poEntry.poNumber} deleted` };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Get all PO numbers with filters
  async getAll(options = {}) {
    const { PONumber } = this.models;
    const { status, supplier, limit = 50, offset = 0 } = options;

    const where = {};
    if (status) where.status = status;
    if (supplier) where.supplier = { [Op.iLike]: `%${supplier}%` };

    return PONumber.findAndCountAll({
      where,
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
