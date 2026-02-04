// ============= ESTIMATE LINK SERVICE =============
// Handles linking an existing estimate to an existing work order
// This covers the case where a client gets an estimate, then drops off material
// without confirming - the shop receives it as a new shipment, and later
// the admin links the estimate to carry over pricing, parts, etc.

const { Op } = require('sequelize');
const { cleanNumericFields } = require('../constants');

class EstimateLinkService {
  constructor(models) {
    this.models = models;
  }

  // Search for linkable estimates (not yet converted, not archived)
  async searchLinkableEstimates(query) {
    const { Estimate, EstimatePart } = this.models;

    const where = {
      status: { [Op.in]: ['draft', 'sent', 'accepted'] },
      workOrderId: null // Not already linked
    };

    if (query) {
      where[Op.or] = [
        { clientName: { [Op.iLike]: `%${query}%` } },
        { estimateNumber: { [Op.iLike]: `%${query}%` } },
        { contactName: { [Op.iLike]: `%${query}%` } },
        { projectDescription: { [Op.iLike]: `%${query}%` } }
      ];
    }

    return Estimate.findAll({
      where,
      include: [{ model: EstimatePart, as: 'parts' }],
      order: [['createdAt', 'DESC']],
      limit: 20
    });
  }

  // Link an estimate to an existing work order
  // This copies all estimate data (pricing, parts, client info, notes) to the work order
  async linkEstimateToWorkOrder(workOrderId, estimateId, options = {}) {
    const { 
      WorkOrder, WorkOrderPart, WorkOrderPartFile,
      Estimate, EstimatePart, EstimatePartFile,
      sequelize 
    } = this.models;

    const transaction = await sequelize.transaction();

    try {
      // Load both records
      const workOrder = await WorkOrder.findByPk(workOrderId, {
        include: [{ model: WorkOrderPart, as: 'parts' }],
        transaction
      });

      if (!workOrder) {
        await transaction.rollback();
        throw new Error('Work order not found');
      }

      const estimate = await Estimate.findByPk(estimateId, {
        include: [{ 
          model: EstimatePart, 
          as: 'parts',
          include: [{ model: EstimatePartFile, as: 'files' }]
        }],
        transaction
      });

      if (!estimate) {
        await transaction.rollback();
        throw new Error('Estimate not found');
      }

      if (estimate.workOrderId) {
        await transaction.rollback();
        throw new Error('Estimate is already linked to a work order');
      }

      console.log(`Linking estimate ${estimate.estimateNumber} to work order ${workOrder.orderNumber}`);

      // === STEP 1: Copy estimate-level data to work order ===
      const workOrderUpdates = {
        // Client info
        clientName: estimate.clientName || workOrder.clientName,
        contactName: estimate.contactName || workOrder.contactName,
        contactEmail: estimate.contactEmail || workOrder.contactEmail,
        contactPhone: estimate.contactPhone || workOrder.contactPhone,
        // Pricing
        truckingDescription: estimate.truckingDescription || workOrder.truckingDescription,
        truckingCost: estimate.truckingCost || workOrder.truckingCost,
        taxRate: estimate.taxRate || workOrder.taxRate,
        taxExempt: estimate.taxExempt || workOrder.taxExempt,
        taxExemptReason: estimate.taxExemptReason || workOrder.taxExemptReason,
        taxExemptCertNumber: estimate.taxExemptCertNumber || workOrder.taxExemptCertNumber,
        // Notes
        notes: combineNotes(workOrder.notes, estimate.notes, estimate.internalNotes),
        // Project description
        description: estimate.projectDescription || workOrder.description,
        // Link reference
        estimateNumber: estimate.estimateNumber,
        estimateId: estimate.id
      };

      await workOrder.update(workOrderUpdates, { transaction });

      // === STEP 2: Copy estimate parts to work order ===
      const existingPartCount = workOrder.parts?.length || 0;
      const createdParts = [];

      for (let i = 0; i < (estimate.parts || []).length; i++) {
        const ep = estimate.parts[i];
        const partNumber = existingPartCount + i + 1;

        // Map estimate part fields to work order part fields
        const partData = {
          workOrderId: workOrder.id,
          partNumber,
          partType: ep.partType,
          clientPartNumber: ep.clientPartNumber,
          heatNumber: ep.heatNumber,
          quantity: ep.quantity || 1,
          // Dimensions
          material: ep.material,
          thickness: ep.thickness,
          width: ep.width,
          length: ep.length,
          outerDiameter: ep.outerDiameter,
          wallThickness: ep.wallThickness,
          sectionSize: ep.sectionSize,
          rollType: ep.rollType,
          radius: ep.radius,
          diameter: ep.diameter,
          arcDegrees: ep.arcDegrees,
          flangeOut: ep.flangeOut || false,
          specialInstructions: ep.specialInstructions,
          // Material source
          materialSource: ep.weSupplyMaterial ? 'we_order' : 'customer',
          supplierName: ep.supplierName || null,
          materialDescription: ep.materialDescription || null,
          // Pricing - map from estimate pricing fields
          materialUnitCost: ep.materialUnitCost || null,
          materialTotal: ep.materialTotal || null,
          // Map rolling cost to labor
          laborRate: ep.rollingCost || null,
          laborTotal: ep.rollingCost || null,
          // Map other services
          setupCharge: ep.otherServicesCost || null,
          otherCharges: ep.serviceDrillingCost || null,
          // Part total
          partTotal: ep.partTotal || null,
          // Status
          status: 'pending'
        };

        const newPart = await WorkOrderPart.create(partData, { transaction });
        createdParts.push(newPart);

        console.log(`  Created part ${partNumber}: ${ep.partType} from estimate part ${ep.partNumber}`);
      }

      // === STEP 3: Mark estimate as converted ===
      await estimate.update({
        status: 'converted',
        workOrderId: workOrder.id,
        drNumber: workOrder.drNumber
      }, { transaction });

      await transaction.commit();

      console.log(`Link complete: ${createdParts.length} parts copied, estimate marked as converted`);

      // Return updated work order
      const updatedWorkOrder = await WorkOrder.findByPk(workOrderId, {
        include: [
          { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }
        ]
      });

      return {
        success: true,
        message: `Linked estimate ${estimate.estimateNumber} - copied ${createdParts.length} parts with pricing`,
        workOrder: updatedWorkOrder,
        partsCopied: createdParts.length
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Unlink an estimate from a work order (undo)
  async unlinkEstimate(workOrderId) {
    const { WorkOrder, Estimate, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      const workOrder = await WorkOrder.findByPk(workOrderId, { transaction });
      if (!workOrder || !workOrder.estimateId) {
        await transaction.rollback();
        throw new Error('No estimate linked to this work order');
      }

      const estimate = await Estimate.findByPk(workOrder.estimateId, { transaction });
      
      // Revert estimate status
      if (estimate) {
        await estimate.update({
          status: 'accepted',
          workOrderId: null,
          drNumber: null
        }, { transaction });
      }

      // Clear work order estimate reference
      await workOrder.update({
        estimateId: null,
        estimateNumber: null
      }, { transaction });

      await transaction.commit();

      return {
        success: true,
        message: 'Estimate unlinked (parts remain on work order)'
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}

// Helper to combine notes without duplicating
function combineNotes(existingNotes, estimateNotes, internalNotes) {
  const parts = [];
  if (existingNotes) parts.push(existingNotes);
  if (estimateNotes) parts.push(`[From Estimate] ${estimateNotes}`);
  if (internalNotes) parts.push(`[Internal] ${internalNotes}`);
  return parts.join('\n\n') || null;
}

module.exports = EstimateLinkService;
