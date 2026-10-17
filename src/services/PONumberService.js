// ============= PO NUMBER SERVICE =============
// All PO number business logic in one place

const { Op } = require('sequelize');
const { DEFAULTS, PO_STATUSES } = require('../constants');
// All PO numbers come from the one locked reservation service (audit H11)
const poNumbers = require('./poNumbers');

// Every place a PO number string is stored (audit H11). Reassign/release must update all of them —
// the old code only touched work-order parts and a non-existent InboundOrder.poNumber column.
async function renamePOEverywhere(fromStr, toStr, transaction) {
  const { sequelize, WorkOrderPart, InboundOrder, EstimatePart } = require('../models');
  await WorkOrderPart.update({ materialPurchaseOrderNumber: toStr }, { where: { materialPurchaseOrderNumber: fromStr }, transaction });
  await WorkOrderPart.update({ awaitingPONumber: toStr }, { where: { awaitingPONumber: fromStr }, transaction });
  // Released: the estimate's parts are no longer ordered either (U22: they kept materialOrdered, so they
  // couldn't be ordered again and the converted order waited for material forever)
  if (toStr === null) await EstimatePart.update({ materialOrdered: false, materialOrderedAt: null, inboundOrderId: null }, { where: { materialPurchaseOrderNumber: fromStr }, transaction });
  await EstimatePart.update({ materialPurchaseOrderNumber: toStr }, { where: { materialPurchaseOrderNumber: fromStr }, transaction });
  if (toStr !== null) await InboundOrder.update({ purchaseOrderNumber: toStr }, { where: { purchaseOrderNumber: fromStr }, transaction });
  // Older single outside-processing PO field on parts
  await WorkOrderPart.update({ outsideProcessingPONumber: toStr }, { where: { outsideProcessingPONumber: fromStr }, transaction });
  await EstimatePart.update({ outsideProcessingPONumber: toStr }, { where: { outsideProcessingPONumber: fromStr }, transaction });
  // Trucking (TR) POs live in the work order's opTransports list
  await sequelize.query(`
    UPDATE work_orders SET "opTransports" = (
      SELECT jsonb_agg(CASE WHEN e->>'poNumber' = :from THEN
               (CASE WHEN CAST(:to AS text) IS NULL THEN e - 'poNumber' ELSE jsonb_set(e, '{poNumber}', to_jsonb(CAST(:to AS text))) END)
             ELSE e END)
      FROM jsonb_array_elements("opTransports") e)
    WHERE jsonb_typeof("opTransports") = 'array' AND "opTransports" @> jsonb_build_array(jsonb_build_object('poNumber', CAST(:from AS text)))`,
    { replacements: { from: fromStr, to: toStr }, transaction });
  // Service / outside-processing POs stamped inside the outsideProcessing JSON list
  for (const table of ['work_order_parts', 'estimate_parts']) {
    await sequelize.query(`
      UPDATE ${table} SET "outsideProcessing" = (
        SELECT jsonb_agg(CASE WHEN e->>'poNumber' = :from THEN
                 (CASE WHEN CAST(:to AS text) IS NULL THEN e - 'poNumber' - 'poSentAt' ELSE jsonb_set(e, '{poNumber}', to_jsonb(CAST(:to AS text))) END)
               ELSE e END)
        FROM jsonb_array_elements("outsideProcessing") e)
      WHERE jsonb_typeof("outsideProcessing") = 'array' AND "outsideProcessing" @> jsonb_build_array(jsonb_build_object('poNumber', CAST(:from AS text)))`,
      { replacements: { from: fromStr, to: toStr }, transaction });
  }
}

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

      // V10: nothing will arrive on a voided PO, so (unless its material was already received) its parts
      // are no longer "ordered" — they kept "already ordered on PO…" and couldn't be ordered again.
      // Cleared wherever the number is stored, like release; the PO row itself stays, as void.
      const nums = [`PO${poEntry.poNumber}`, `OP${poEntry.poNumber}`, `TR${poEntry.poNumber}`];
      const inbounds = await InboundOrder.findAll({ where: { [Op.or]: [
        ...(poEntry.inboundOrderId ? [{ id: poEntry.inboundOrderId }] : []),
        { purchaseOrderNumber: nums },
      ] }, attributes: ['id', 'status'], transaction });
      if (!inbounds.some(i => i.status === 'received')) {
        const { WorkOrderPart, EstimatePart } = this.models;
        const cleared = { materialOrdered: false, materialOrderedAt: null, materialPurchaseOrderNumber: null, inboundOrderId: null };
        // parts whose material was received on the part itself keep their PO (traceability) — review of round 16
        await WorkOrderPart.update(cleared, { where: { materialPurchaseOrderNumber: nums, [Op.or]: [{ materialReceived: false }, { materialReceived: null }] }, transaction });
        await EstimatePart.update(cleared, { where: { materialPurchaseOrderNumber: nums, [Op.or]: [{ materialReceived: false }, { materialReceived: null }] }, transaction });
        // only the material PO fields above; outside-processing / trip stamps (OP…/TR…) record work that
        // may be done, so they are left as they are
      }

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
module.exports.renamePOEverywhere = renamePOEverywhere;
