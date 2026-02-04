// ============= WORK ORDER SERVICE =============
// All work order business logic in one place

const { Op } = require('sequelize');
const cloudinary = require('cloudinary').v2;
const { WORK_ORDER_STATUSES, DEFAULTS, cleanNumericFields, generateWorkOrderNumber } = require('../constants');

class WorkOrderService {
  constructor(models) {
    this.models = models;
  }

  // Get work order by ID with all associations
  async getById(id) {
    const { WorkOrder, WorkOrderPart, WorkOrderPartFile, WorkOrderDocument } = this.models;
    
    return WorkOrder.findByPk(id, {
      include: [
        { 
          model: WorkOrderPart, 
          as: 'parts',
          include: [{ model: WorkOrderPartFile, as: 'files' }],
          order: [['partNumber', 'ASC']]
        },
        { model: WorkOrderDocument, as: 'documents' }
      ]
    });
  }

  // Get all work orders with optional filters
  async getAll(options = {}) {
    const { WorkOrder, WorkOrderPart, WorkOrderPartFile } = this.models;
    const { archived, status, search, limit = 100, offset = 0 } = options;

    const where = {};
    
    if (archived === 'true') {
      where.status = 'archived';
    } else if (archived === 'false') {
      where.status = { [Op.ne]: 'archived' };
    }
    
    if (status && status !== 'all') {
      where.status = status;
    }

    if (search) {
      where[Op.or] = [
        { clientName: { [Op.iLike]: `%${search}%` } },
        { orderNumber: { [Op.iLike]: `%${search}%` } },
        { clientPurchaseOrderNumber: { [Op.iLike]: `%${search}%` } }
      ];
    }

    return WorkOrder.findAndCountAll({
      where,
      include: [{
        model: WorkOrderPart,
        as: 'parts',
        include: [{ model: WorkOrderPartFile, as: 'files' }]
      }],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  }

  // Create a new work order
  async create(data) {
    const { WorkOrder, DRNumber, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      // Get next DR number
      const maxDRFromTable = await DRNumber.max('drNumber', { transaction }) || 0;
      const maxDRFromWorkOrders = await WorkOrder.max('drNumber', { transaction }) || 0;
      const maxDR = Math.max(maxDRFromTable, maxDRFromWorkOrders, DEFAULTS.STARTING_DR_NUMBER);
      const nextDRNumber = maxDR + 1;

      // Create DR number record
      const drRecord = await DRNumber.create({
        drNumber: nextDRNumber,
        status: 'active'
      }, { transaction });

      // Create work order
      const orderNumber = generateWorkOrderNumber();
      const workOrder = await WorkOrder.create({
        orderNumber,
        drNumber: nextDRNumber,
        status: WORK_ORDER_STATUSES.RECEIVED,
        ...cleanNumericFields(data)
      }, { transaction });

      // Link DR to work order
      await drRecord.update({ workOrderId: workOrder.id }, { transaction });

      await transaction.commit();
      return this.getById(workOrder.id);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Update a work order
  async update(id, data) {
    const workOrder = await this.getById(id);
    if (!workOrder) {
      throw new Error('Work order not found');
    }

    await workOrder.update(cleanNumericFields(data));
    return this.getById(id);
  }

  // Delete a work order and all related data
  async delete(id) {
    const { WorkOrder, WorkOrderPart, WorkOrderPartFile, WorkOrderDocument, 
            DRNumber, PONumber, Estimate, InboundOrder, sequelize } = this.models;
    
    const transaction = await sequelize.transaction();

    try {
      const workOrder = await WorkOrder.findByPk(id, {
        include: [
          { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
          { model: WorkOrderDocument, as: 'documents' }
        ],
        transaction
      });

      if (!workOrder) {
        await transaction.rollback();
        throw new Error('Work order not found');
      }

      // Delete files from Cloudinary
      for (const part of workOrder.parts || []) {
        for (const file of part.files || []) {
          if (file.cloudinaryId) {
            try {
              await cloudinary.uploader.destroy(file.cloudinaryId, { resource_type: 'raw' });
            } catch (e) {
              console.error('Failed to delete file from Cloudinary:', e);
            }
          }
        }
      }

      // Delete documents from Cloudinary
      for (const doc of workOrder.documents || []) {
        if (doc.cloudinaryId) {
          try {
            await cloudinary.uploader.destroy(doc.cloudinaryId, { resource_type: 'raw' });
          } catch (e) {
            console.error('Failed to delete document from Cloudinary:', e);
          }
        }
      }

      // Clear foreign key references (don't delete, just unlink)
      await DRNumber.update(
        { workOrderId: null },
        { where: { workOrderId: id }, transaction }
      );
      
      await PONumber.update(
        { workOrderId: null },
        { where: { workOrderId: id }, transaction }
      );
      
      await Estimate.update(
        { workOrderId: null, status: 'accepted' },
        { where: { workOrderId: id }, transaction }
      );

      // Delete inbound orders linked to this work order's parts
      const partIds = workOrder.parts.map(p => p.id);
      if (partIds.length > 0) {
        const inboundOrderIds = workOrder.parts
          .filter(p => p.inboundOrderId)
          .map(p => p.inboundOrderId);
        
        if (inboundOrderIds.length > 0) {
          await InboundOrder.destroy({
            where: { id: inboundOrderIds },
            transaction
          });
        }
      }

      // Delete documents
      await WorkOrderDocument.destroy({
        where: { workOrderId: id },
        transaction
      });

      // Delete part files
      for (const part of workOrder.parts || []) {
        await WorkOrderPartFile.destroy({
          where: { workOrderPartId: part.id },
          transaction
        });
      }

      // Delete parts
      await WorkOrderPart.destroy({
        where: { workOrderId: id },
        transaction
      });

      // Delete work order
      await workOrder.destroy({ transaction });

      await transaction.commit();
      return { success: true, message: 'Work order deleted successfully' };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Update work order status
  async updateStatus(id, status) {
    const workOrder = await this.getById(id);
    if (!workOrder) {
      throw new Error('Work order not found');
    }

    const updates = { status };
    
    // Set timestamps based on status
    if (status === WORK_ORDER_STATUSES.SHIPPED) {
      updates.shippedAt = new Date();
    } else if (status === WORK_ORDER_STATUSES.ARCHIVED) {
      updates.archivedAt = new Date();
    }

    await workOrder.update(updates);
    return this.getById(id);
  }

  // Archive a work order (mark as shipped/picked up)
  async archive(id, data = {}) {
    const { WorkOrder, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      const workOrder = await WorkOrder.findByPk(id, { transaction });
      if (!workOrder) {
        await transaction.rollback();
        throw new Error('Work order not found');
      }

      await workOrder.update({
        status: WORK_ORDER_STATUSES.SHIPPED,
        shippedAt: new Date(),
        pickedUpBy: data.pickedUpBy || null,
        pickupNotes: data.pickupNotes || null
      }, { transaction });

      await transaction.commit();
      return this.getById(id);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}

module.exports = WorkOrderService;
