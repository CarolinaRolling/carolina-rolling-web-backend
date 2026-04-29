// ============= WORK ORDER PART SERVICE =============
// All work order part business logic in one place

const cloudinary = require('cloudinary').v2;
const { cleanNumericFields, PART_STATUSES } = require('../constants');

class WorkOrderPartService {
  constructor(models) {
    this.models = models;
  }

  // Get part by ID with files
  async getById(partId, workOrderId) {
    const { WorkOrderPart, WorkOrderPartFile } = this.models;
    
    return WorkOrderPart.findOne({
      where: { id: partId, workOrderId },
      include: [{ model: WorkOrderPartFile, as: 'files' }]
    });
  }

  // Add a part to a work order
  async create(workOrderId, data) {
    const { WorkOrder, WorkOrderPart, WorkOrderPartFile } = this.models;

    const workOrder = await WorkOrder.findByPk(workOrderId);
    if (!workOrder) {
      throw new Error('Work order not found');
    }

    // Get next part number
    const existingParts = await WorkOrderPart.count({ where: { workOrderId } });
    const partNumber = existingParts + 1;

    // Clean and prepare data
    const cleanedData = cleanNumericFields(data);
    
    const part = await WorkOrderPart.create({
      workOrderId,
      partNumber,
      partType: data.partType,
      clientPartNumber: data.clientPartNumber,
      heatNumber: data.heatNumber,
      quantity: data.quantity || 1,
      material: data.material,
      thickness: data.thickness,
      width: data.width,
      length: data.length,
      outerDiameter: data.outerDiameter,
      innerDiameter: data.innerDiameter,
      wallThickness: data.wallThickness,
      rollType: data.rollType,
      radius: data.radius,
      diameter: data.diameter,
      arcLength: data.arcLength,
      arcDegrees: data.arcDegrees,
      sectionSize: data.sectionSize,
      flangeOut: data.flangeOut || false,
      specialInstructions: data.specialInstructions,
      // Material source fields
      materialSource: data.materialSource || 'customer_supplied',
      supplierName: data.supplierName || null,
      materialDescription: data.materialDescription || null,
      // Pricing fields
      laborRate: cleanedData.laborRate,
      laborHours: cleanedData.laborHours,
      laborTotal: cleanedData.laborTotal,
      materialUnitCost: cleanedData.materialUnitCost,
      materialTotal: cleanedData.materialTotal,
      setupCharge: cleanedData.setupCharge,
      otherCharges: cleanedData.otherCharges,
      partTotal: cleanedData.partTotal,
      status: PART_STATUSES.PENDING
    });

    return this.getById(part.id, workOrderId);
  }

  // Update a part
  async update(partId, workOrderId, data) {
    const { WorkOrderPart } = this.models;

    const part = await WorkOrderPart.findOne({
      where: { id: partId, workOrderId }
    });

    if (!part) {
      throw new Error('Part not found');
    }

    const cleanedData = cleanNumericFields(data);
    
    await part.update({
      ...data,
      supplierName: data.supplierName || null,
      materialDescription: data.materialDescription || null,
      laborRate: cleanedData.laborRate,
      laborHours: cleanedData.laborHours,
      laborTotal: cleanedData.laborTotal,
      materialUnitCost: cleanedData.materialUnitCost,
      materialTotal: cleanedData.materialTotal,
      setupCharge: cleanedData.setupCharge,
      otherCharges: cleanedData.otherCharges,
      partTotal: cleanedData.partTotal
    });

    return this.getById(partId, workOrderId);
  }

  // Delete a part and its files
  async delete(partId, workOrderId) {
    const { WorkOrderPart, WorkOrderPartFile, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      const part = await WorkOrderPart.findOne({
        where: { id: partId, workOrderId },
        include: [{ model: WorkOrderPartFile, as: 'files' }],
        transaction
      });

      if (!part) {
        await transaction.rollback();
        throw new Error('Part not found');
      }

      // Delete files from Cloudinary
      for (const file of part.files || []) {
        if (file.cloudinaryId) {
          try {
            await cloudinary.uploader.destroy(file.cloudinaryId, { resource_type: 'raw' });
          } catch (e) {
            console.error('Failed to delete file from Cloudinary:', e);
          }
        }
      }

      // Delete file records
      await WorkOrderPartFile.destroy({
        where: { workOrderPartId: partId },
        transaction
      });

      // Delete part
      await part.destroy({ transaction });

      // Renumber remaining parts
      const remainingParts = await WorkOrderPart.findAll({
        where: { workOrderId },
        order: [['partNumber', 'ASC']],
        transaction
      });

      for (let i = 0; i < remainingParts.length; i++) {
        await remainingParts[i].update({ partNumber: i + 1 }, { transaction });
      }

      await transaction.commit();
      return { success: true, message: 'Part deleted successfully' };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Update part status
  async updateStatus(partId, workOrderId, status) {
    const part = await this.getById(partId, workOrderId);
    if (!part) {
      throw new Error('Part not found');
    }

    await part.update({ status });
    return this.getById(partId, workOrderId);
  }

  // Get orderable parts (materialSource = 'we_order' and not yet ordered)
  async getOrderableParts(workOrderId) {
    const { WorkOrderPart } = this.models;

    return WorkOrderPart.findAll({
      where: {
        workOrderId,
        materialSource: 'we_order',
        materialOrdered: { [require('sequelize').Op.or]: [false, null] },
        materialDescription: { [require('sequelize').Op.ne]: null }
      }
    });
  }
}

module.exports = WorkOrderPartService;
