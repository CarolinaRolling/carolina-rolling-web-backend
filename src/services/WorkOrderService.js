// ============= WORK ORDER SERVICE =============
// All work order business logic in one place

const { Op } = require('sequelize');
const cloudinary = require('cloudinary').v2;
const { WORK_ORDER_STATUSES, DEFAULTS, cleanNumericFields, generateWorkOrderNumber } = require('../constants');
const { allocateDRNumber } = require('./numberAllocator');

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
      // Get next DR number under an advisory lock so two simultaneous creates cannot both
      // claim it. See services/numberAllocator.js.
      const nextDRNumber = await allocateDRNumber(this.models, transaction, {
        startingNumber: DEFAULTS.STARTING_DR_NUMBER
      });

      // Create DR number record
      const drRecord = await DRNumber.create({
        drNumber: nextDRNumber,
        status: 'active'
      }, { transaction });

      // Create work order
      const orderNumber = generateWorkOrderNumber();
      // Caller data is spread FIRST so it can never clobber the identifiers we just
      // allocated. drNumber is not in NUMERIC_FIELDS, so a drNumber of null or a stray
      // string in the request body used to overwrite nextDRNumber and produce a work order
      // with no DR number while still burning one from the sequence.
      const { drNumber: _ignoredDr, orderNumber: _ignoredOrder, ...safeData } = cleanNumericFields(data);
      const workOrder = await WorkOrder.create({
        status: WORK_ORDER_STATUSES.RECEIVED,
        ...safeData,
        orderNumber,
        drNumber: nextDRNumber
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
  async delete(id, options = {}) {
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

      // Snapshot before anything is destroyed. The work order was loaded with parts, files and
      // documents, so the archived JSON is a complete record — enough to reconstruct the order
      // if this delete turns out to have been a mistake.
      const { archiveRecord, labelFor } = require('./deletionArchive');
      await archiveRecord(workOrder, {
        modelName: 'WorkOrder',
        label: labelFor(workOrder),
        deletedBy: options.deletedBy || null,
        reason: options.reason || null,
        transaction,
      });

      // Collect remote asset ids now, but do NOT delete them yet. Cloudinary deletes cannot be
      // rolled back — if the transaction below fails, the work order comes back but its prints,
      // STEP files and DXFs would already be gone. Deletion happens after a successful commit.
      const cloudinaryIdsToDelete = [];
      for (const part of workOrder.parts || []) {
        for (const file of part.files || []) {
          if (file.cloudinaryId) cloudinaryIdsToDelete.push(file.cloudinaryId);
        }
      }
      for (const doc of workOrder.documents || []) {
        if (doc.cloudinaryId) cloudinaryIdsToDelete.push(doc.cloudinaryId);
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

      // Committed — the database no longer references these assets, so it is now safe to
      // remove them. Failures here leave orphaned files in Cloudinary, which is recoverable;
      // deleting before the commit would not have been.
      for (const cloudinaryId of cloudinaryIdsToDelete) {
        try {
          await cloudinary.uploader.destroy(cloudinaryId, { resource_type: 'raw' });
        } catch (e) {
          console.error('Failed to delete asset from Cloudinary (orphaned):', cloudinaryId, e.message);
        }
      }

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
