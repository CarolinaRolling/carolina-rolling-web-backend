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
      // Lock both rows first (audit H7) so a double-click or two people linking at once can't link
      // twice, and refuse to link a second estimate onto a work order that already has one.
      const woLock = await WorkOrder.findByPk(workOrderId, { transaction, lock: transaction.LOCK.UPDATE });
      const estLock = await Estimate.findByPk(estimateId, { transaction, lock: transaction.LOCK.UPDATE });
      if (woLock && woLock.estimateId && woLock.estimateId !== estimateId) {
        const linked = await Estimate.findByPk(woLock.estimateId, { attributes: ['id', 'estimateNumber', 'workOrderId'], transaction });
        if (linked && linked.workOrderId === woLock.id) {
          await transaction.rollback();
          throw new Error(`This work order is already linked to estimate ${linked.estimateNumber}. Unlink it first.`);
        }
      }
      // V24: not a voided, archived, invoiced or exported order (exported used to fail with a 500 from the
      // price lock). W8: shipped but not yet invoiced is fine — linking for pricing at invoice time is normal.
      if (woLock) {
        const why = woLock.isVoided ? 'is voided'
          : woLock.status === 'archived' ? 'is archived'
          : woLock.iifExportedAt ? 'is already exported to QuickBooks'
          : woLock.invoiceNumber ? `already has invoice #${woLock.invoiceNumber}` : null;
        if (why) {
          await transaction.rollback();
          const e = new Error(`This work order ${why}, so an estimate can't be linked to it.${woLock.iifExportedAt || woLock.invoiceNumber ? ' Reopen or clear the invoice first.' : ''}`);
          e.status = 409; e.code = 'WORK_ORDER_LOCKED';
          throw e;
        }
      }
      if (estLock && estLock.workOrderId) {
        await transaction.rollback();
        throw new Error('Estimate is already linked to a work order');
      }
      // Only an open estimate can be linked — not one in the trash, declined, archived or already
      // converted (U47: link used to accept any estimate by id)
      if (estLock) {
        const why = estLock.trashedAt ? 'is in the trash' : ({ declined: 'was declined', archived: 'is archived', converted: 'was already converted' })[estLock.status];
        if (why) {
          await transaction.rollback();
          const e = new Error(`Estimate ${estLock.estimateNumber || ''} ${why}, so it can't be linked. Restore or reopen it first.`.replace(/\s+/g, ' '));
          e.status = 409; e.code = 'ESTIMATE_NOT_OPEN';
          throw e;
        }
      }

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
      // The order takes the estimate's client — by id too, not just the name (R9: it showed client B
      // but billed client A, since balances and payments go by clientId)
      let clientId = workOrder.clientId;
      if (estimate.clientName && String(estimate.clientName).trim().toLowerCase() !== String(workOrder.clientName || '').trim().toLowerCase()) {
        clientId = estimate.clientId || null;
        if (!clientId && this.models.Client) {
          const c = await this.models.Client.findOne({ where: sequelize.where(sequelize.fn('lower', sequelize.fn('trim', sequelize.col('name'))), String(estimate.clientName).trim().toLowerCase()), transaction });
          clientId = c ? c.id : null;
        }
      } else if (!clientId && estimate.clientId) clientId = estimate.clientId;
      const workOrderUpdates = {
        // Client info
        clientName: estimate.clientName || workOrder.clientName,
        clientId,
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
        // Notes — the estimate's internal notes go to the order's INTERNAL notes, never to the
        // shop-visible notes (round 13, T22: "[Internal] secret margin" used to land on the traveler)
        notes: combineNotes(workOrder.notes, notesBlock(estimate.notes)),
        internalNotes: combineNotes(workOrder.internalNotes, notesBlock(estimate.internalNotes)),
        // Project description
        description: estimate.projectDescription || workOrder.description,
        // Link reference
        estimateNumber: estimate.estimateNumber,
        estimateId: estimate.id
      };
      // What the estimate quoted at the order level — outside-processing trips, discount, minimum
      // override — comes over too, as Convert does (round 11, audit N4: before, a linked estimate's
      // trips and discount never reached the invoice). Trips are tagged so Unlink can take them back.
      const estTrips = Array.isArray(estimate.opTransports) ? estimate.opTransports : [];
      if (estTrips.length) {
        const own = Array.isArray(workOrder.opTransports) ? workOrder.opTransports : [];
        workOrderUpdates.opTransports = [...own, ...estTrips.map(tr => ({ ...tr, _fromEstimateId: estimate.id }))];
      }
      const hasDiscount = (x) => (parseFloat(x.discountPercent) || 0) > 0 || (parseFloat(x.discountAmount) || 0) > 0;
      if (hasDiscount(estimate) && !hasDiscount(workOrder)) {
        workOrderUpdates.discountPercent = estimate.discountPercent;
        workOrderUpdates.discountAmount = estimate.discountAmount;
        if (estimate.discountReason !== undefined) workOrderUpdates.discountReason = estimate.discountReason;
      }
      if (estimate.minimumOverride && !workOrder.minimumOverride) {
        workOrderUpdates.minimumOverride = true;
        workOrderUpdates.minimumOverrideReason = estimate.minimumOverrideReason || null;
      }

      // What the order looked like before the link, for the fields the link overwrites, so Unlink can
      // put them back (round 13, T22: before, an unlinked order stayed billed to the estimate's client
      // at its tax rate). Only fields the link actually changed are kept, with the value it set, so
      // Unlink restores a field only while it still holds what the link put there.
      const restore = { estimateId: estimate.id, before: {}, after: {}, notesAdded: notesBlock(estimate.notes), internalNotesAdded: notesBlock(estimate.internalNotes) };
      for (const f of RESTORABLE.flat()) {
        if (!(f in workOrderUpdates)) continue;
        if (same(workOrder.get(f), workOrderUpdates[f])) continue;
        restore.before[f] = workOrder.get(f) === undefined ? null : workOrder.get(f);
        restore.after[f] = workOrderUpdates[f] === undefined ? null : workOrderUpdates[f];
      }

      // kept on the order itself (round 14: a JSONB column; it used to ride on each copied line's
      // formData, where tablets could read the order's previous client and contacts)
      workOrderUpdates.estimateLinkSnapshot = restore;
      await workOrder.update(workOrderUpdates, { transaction });

      // === STEP 2: Copy estimate parts (with pricing, roll details, outside processing, files and lot
      // numbers) and shipping charges — the same copy Convert uses (R9) ===
      // after the highest existing line number, not the count (gaps would collide) — M14
      const existingPartCount = (workOrder.parts || []).reduce((m, p) => Math.max(m, p.partNumber || 0), 0);
      const { copyEstimateParts, copyEstimateCharges } = require('./estimateCopy');
      // each line remembers which estimate it came from, so Unlink can take exactly those back off
      const { created: createdParts } = await copyEstimateParts(this.models, estimate, workOrder,
        { transaction, drNumber: workOrder.drNumber, partNumberOffset: existingPartCount, extraFormData: { _fromEstimateId: estimate.id } });
      await copyEstimateCharges(this.models, estimate, workOrder, { transaction });

      // === STEP 3: Mark estimate as converted ===
      await estimate.update({
        status: 'converted',
        workOrderId: workOrder.id,
        drNumber: workOrder.drNumber
      }, { transaction });

      // The estimate's material POs and deliveries now belong to this order too (U21: the copied lines
      // had the delivery, but the delivery and PO had no order, so convert-to-shipment made an
      // unlinked shipment). Unlink clears them back.
      await attachEstimateOrders(this.models, estimate.id, workOrder.id, transaction);
      // W9: the order's DR, POs, deliveries and shipments follow it to the estimate's client
      if ('clientId' in restore.before || 'clientName' in restore.before) {
        await syncOrderClient(this.models, workOrder.id, workOrderUpdates.clientId, workOrderUpdates.clientName, transaction);
      }

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
      // Earlier checks may already have rolled back; a second rollback would throw and hide the real error
      if (!transaction.finished) await transaction.rollback();
      throw error;
    }
  }

  // Unlink an estimate from a work order (undo)
  async unlinkEstimate(workOrderId) {
    const { WorkOrder, Estimate, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      const workOrder = await WorkOrder.findByPk(workOrderId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!workOrder || !workOrder.estimateId) {
        await transaction.rollback();
        throw new Error('No estimate linked to this work order');
      }

      // An invoice already in QuickBooks keeps its lines — unlinking would remove priced lines from it
      if (workOrder.iifExportedAt) {
        await transaction.rollback();
        throw new Error('This invoice is already in QuickBooks, so the estimate can\'t be unlinked (its lines would be removed). Reopen it in the Invoice Center first.');
      }

      // Unlink undoes a LINK (estimate attached to an order that already existed). An order CREATED
      // from the estimate (Convert) can't be unlinked: its lines aren't tagged, so nothing would come
      // off, yet the estimate would reopen and could be converted again — two orders with the same
      // lines (round 11, audit N5).
      const { WorkOrderPart } = this.models;
      const linked = await WorkOrderPart.findAll({ where: { workOrderId: workOrder.id }, transaction });
      const fromThis = linked.filter(p => p.formData && p.formData._fromEstimateId === workOrder.estimateId);
      if (!fromThis.length) {
        await transaction.rollback();
        const e = new Error('None of this order\'s lines are marked as added by linking this estimate (it was created from the estimate with Convert, linked before lines were tracked, or the linked lines were removed), so it can\'t be unlinked automatically. Edit or remove its lines instead.');
        e.status = 409; e.code = 'NOT_LINKED';
        throw e;
      }
      // An invoiced or paid order keeps its lines — removing them would leave the invoice or the
      // payment pointing at a $0 order (audit N5)
      const acct = await require('./drGuard').accountingState(this.models, workOrder, { transaction });
      if (acct.invoiced || acct.payments) {
        await transaction.rollback();
        const e = new Error(acct.payments
          ? 'This order has payments recorded, so the estimate can\'t be unlinked (its lines would be removed). Void or move the payments first.'
          : 'This order already has an invoice number, so the estimate can\'t be unlinked (its lines would be removed). Clear the invoice first.');
        e.status = 409; e.code = 'INVOICE_LOCKED';
        throw e;
      }

      // Lines with material (or outside processing) already on a PO, or a linked trip with a PO, can't
      // come off — the PO and its pending delivery would point at nothing and the estimate would reopen
      // (round 13, T21). Release / reassign the PO first.
      const onOrder = fromThis.filter(lineOnOrder);
      const tripsOnPo = (Array.isArray(workOrder.opTransports) ? workOrder.opTransports : [])
        .filter(tr => tr && tr._fromEstimateId === workOrder.estimateId && tr.poNumber);
      if (onOrder.length || tripsOnPo.length) {
        await transaction.rollback();
        const bits = [];
        if (onOrder.length) bits.push(onOrder.map(p => `line #${p.partNumber}${linePo(p) ? ` (${linePo(p)})` : ''}`).join(', ') + ' already ' + (onOrder.length === 1 ? 'has' : 'have') + ' material or outside processing on order');
        if (tripsOnPo.length) bits.push(`${tripsOnPo.length === 1 ? 'a trip' : tripsOnPo.length + ' trips'} from this estimate ${tripsOnPo.length === 1 ? 'is' : 'are'} on ${tripsOnPo.map(t => t.poNumber).join(', ')}`);
        const e = new Error(`The estimate can't be unlinked: ${bits.join('; ')}. Release or reassign the PO first, or edit those lines instead.`);
        e.status = 409; e.code = 'MATERIAL_ON_ORDER';
        throw e;
      }

      const estimate = await Estimate.findByPk(workOrder.estimateId, { transaction, lock: transaction.LOCK.UPDATE });
      
      // Revert estimate status
      if (estimate) {
        await estimate.update({
          status: 'accepted',
          workOrderId: null,
          drNumber: null
        }, { transaction });
      }

      // Take back off the lines the link added (R9: they used to stay, so link → unlink → convert put
      // the same estimate on two orders). Unlink is refused while any of them is started (below).
      // A line with inspection measurements saved (or an inspection job under way) is started too (U23:
      // unlink used to delete the job and its units)
      const inspected = await inspectedPartIds(sequelize, fromThis.map(p => p.id), transaction);
      const started = fromThis.filter(p => (p.status && p.status !== 'pending') || Number(p.progressCount) > 0 || inspected.has(p.id));
      // Lines already started can't come off — and leaving them while the estimate reopens would let
      // it be converted again onto a second order (audit N5). Refuse instead.
      if (started.length) {
        await transaction.rollback();
        const e = new Error(`${started.length} line(s) from this estimate are already started in the shop, so it can't be unlinked. Edit those lines instead.`);
        e.status = 409; e.code = 'LINES_STARTED';
        throw e;
      }
      const removable = fromThis.filter(p => !started.includes(p));
      if (removable.length) {
        await WorkOrderPart.destroy({ where: { id: removable.map(p => p.id) }, transaction, archiveReason: 'estimate unlinked' });
      }
      // and the shipping charges the link copied (none carry an estimate id on the order; copied ones
      // are identified by matching the estimate's charges)
      const { ShipmentCharge } = this.models;
      if (ShipmentCharge && estimate) {
        const estCharges = await ShipmentCharge.findAll({ where: { estimateId: estimate.id }, transaction });
        const woCharges = await ShipmentCharge.findAll({ where: { workOrderId: workOrder.id }, transaction });
        const key = (c) => [c.carrierType, c.vendorName, c.pickupLocation, c.dropoffLocation, String(c.shippingCost), String(c.materialsCost)].join('|');
        const want = estCharges.map(key);
        const drop = [];
        for (const c of woCharges) { const k = want.indexOf(key(c)); if (k >= 0) { want.splice(k, 1); drop.push(c.id); } }
        if (drop.length) await ShipmentCharge.destroy({ where: { id: drop }, transaction, archiveReason: 'estimate unlinked' });
      }

      // Clear work order estimate reference, and take back the order-level items the link brought
      // (its tagged trips; the discount if it is still exactly the estimate's)
      const unlinkUpdates = { estimateId: null, estimateNumber: null };
      if (Array.isArray(workOrder.opTransports) && workOrder.opTransports.some(tr => tr && tr._fromEstimateId === workOrder.estimateId)) {
        unlinkUpdates.opTransports = workOrder.opTransports.filter(tr => !(tr && tr._fromEstimateId === workOrder.estimateId));
      }
      if (estimate && ((parseFloat(estimate.discountPercent) || 0) > 0 || (parseFloat(estimate.discountAmount) || 0) > 0)
          && String(parseFloat(workOrder.discountPercent) || 0) === String(parseFloat(estimate.discountPercent) || 0)
          && String(parseFloat(workOrder.discountAmount) || 0) === String(parseFloat(estimate.discountAmount) || 0)) {
        unlinkUpdates.discountPercent = null; unlinkUpdates.discountAmount = null;
      }
      // Put back the client, tax, contact and other order fields the link overwrote — each group only
      // while it still holds exactly what the link set (a later edit by someone wins) — and take the
      // notes the link appended back out (round 13, T22)
      const okSnap = (r) => r && r.estimateId === workOrder.estimateId && r.before && r.after;
      const snap = (okSnap(workOrder.estimateLinkSnapshot) ? workOrder.estimateLinkSnapshot : null)
        || fromThis.map(p => p.formData && p.formData._estimateLinkRestore).find(okSnap);   // links made by the first round-14 build
      unlinkUpdates.estimateLinkSnapshot = null;
      if (snap) {
        // The previous client may have been renamed or merged away since the link (U18: restoring the
        // deleted id failed the unlink for good with a foreign-key error; a rename put back the old name)
        if (snap.before.clientId) snap.before = { ...snap.before, ...(await resolveClient(this.models, snap.before, transaction)) };
        for (const group of RESTORABLE) {
          const fields = group.filter(f => f in snap.before);
          if (!fields.length) continue;
          if (fields.every(f => same(workOrder.get(f), snap.after[f]))) for (const f of fields) unlinkUpdates[f] = snap.before[f];
        }
      }
      const notesAdded = [snap && snap.notesAdded, estimate && notesBlock(estimate.notes),
        // links made before round 13 put the internal notes in the shop notes
        estimate && estimate.internalNotes ? `[Internal] ${estimate.internalNotes}` : null];
      const internalAdded = [snap && snap.internalNotesAdded, estimate && notesBlock(estimate.internalNotes)];
      const newNotes = stripBlocks(workOrder.notes, notesAdded);
      if (newNotes !== workOrder.notes) unlinkUpdates.notes = newNotes;
      const newInternal = stripBlocks(workOrder.internalNotes, internalAdded);
      if (newInternal !== workOrder.internalNotes) unlinkUpdates.internalNotes = newInternal;
      await workOrder.update(unlinkUpdates, { transaction });
      // the estimate's POs and deliveries go back to the estimate alone (U21)
      if (estimate) await detachEstimateOrders(this.models, estimate.id, workOrder.id, transaction);
      // W9: and the order's own DR, POs, deliveries and shipments go back to the client it was put back to
      if ('clientId' in unlinkUpdates || 'clientName' in unlinkUpdates) {
        await syncOrderClient(this.models, workOrder.id, workOrder.clientId, workOrder.clientName, transaction);
      }

      await transaction.commit();
      if (removable.length) {
        try { await require('./partNumbers').renumberParts(WorkOrderPart, 'workOrderId', workOrder.id); } catch (e) { console.warn('[unlink] renumber failed:', e.message); }
      }

      return {
        success: true,
        removedParts: removable.length,
        keptStartedParts: started.length,
        message: `Estimate unlinked — ${removable.length} line(s) it added were removed` +
          (started.length ? `; ${started.length} already started were kept` : '')
      };
    } catch (error) {
      // Earlier checks may already have rolled back; a second rollback would throw and hide the real error
      if (!transaction.finished) await transaction.rollback();
      throw error;
    }
  }
}

// Order fields the link may overwrite, in groups restored together on Unlink (client id + name go
// together, as do the tax fields)
const RESTORABLE = [
  ['clientId', 'clientName'],
  ['taxRate', 'taxExempt', 'taxExemptReason', 'taxExemptCertNumber'],
  ['contactName'], ['contactEmail'], ['contactPhone'],
  ['truckingDescription'], ['truckingCost'],
  ['description'],
  ['discountReason'],
  ['minimumOverride', 'minimumOverrideReason'],
];

// Equal as stored values: DECIMALs come back as strings ("8.2500" vs 8.25), blanks as null or ''
function norm(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return String(v);
  const t = String(v).trim();
  if (t !== '' && !isNaN(Number(t))) return String(Number(t));
  return t;
}
const same = (a, b) => norm(a) === norm(b);

const notesBlock = (text) => (text && String(text).trim() ? `[From Estimate] ${text}` : null);

// Helper to combine notes without duplicating
function combineNotes(existing, block) {
  const parts = [];
  if (existing) parts.push(existing);
  if (block && !(existing && String(existing).includes(block))) parts.push(block);
  return parts.join('\n\n') || null;
}

// Remove blocks combineNotes appended (if they are still there, unchanged)
function stripBlocks(text, blocks) {
  if (!text) return text;
  let t = String(text);
  for (const b of blocks) {
    if (!b) continue;
    if (t === b) { t = ''; continue; }
    if (t.includes('\n\n' + b)) t = t.replace('\n\n' + b, '');
    else if (t.startsWith(b + '\n\n')) t = t.slice(b.length + 2);
  }
  if (t === String(text)) return text;
  return t.trim() ? t : null;
}

// The PO a line's material / outside processing is on, if any
function linePo(p) {
  if (p.materialPurchaseOrderNumber) return p.materialPurchaseOrderNumber;
  if (p.awaitingPONumber) return p.awaitingPONumber;
  if (p.outsideProcessingPONumber) return p.outsideProcessingPONumber;
  const op = Array.isArray(p.outsideProcessing) ? p.outsideProcessing.find(o => o && o.poNumber) : null;
  return op ? op.poNumber : null;
}
function lineOnOrder(p) {
  return !!(p.materialOrdered || p.inboundOrderId || p.awaitingInboundId || linePo(p));
}

// U21: the estimate's material deliveries and POs follow it onto the order (convert and link), only
// where no order is set yet; and come back off on unlink
async function attachEstimateOrders(models, estimateId, workOrderId, transaction) {
  const { InboundOrder, PONumber, sequelize } = models;
  if (InboundOrder) await InboundOrder.update({ workOrderId }, { where: { estimateId, workOrderId: null }, transaction });
  if (PONumber) await PONumber.update({ workOrderId }, { where: { estimateId, workOrderId: null }, transaction });
  // V23: ones still pointing at an order the estimate is no longer on (an Undo of a PO release after an
  // unlink put them back there) move to the estimate's order too — only while not received
  if (InboundOrder && sequelize) {
    await sequelize.query(`UPDATE inbound_orders SET "workOrderId" = :wo WHERE "estimateId" = :est AND "workOrderId" IS NOT NULL
      AND "workOrderId" <> :wo AND COALESCE(status, '') NOT IN ('received', 'cancelled')`, { replacements: { wo: workOrderId, est: estimateId }, transaction });
  }
  if (PONumber && sequelize) {
    await sequelize.query(`UPDATE po_numbers p SET "workOrderId" = :wo WHERE p."estimateId" = :est AND p."workOrderId" IS NOT NULL
      AND p."workOrderId" <> :wo AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM inbound_orders i WHERE i.id = p."inboundOrderId" AND i.status = 'received')`, { replacements: { wo: workOrderId, est: estimateId }, transaction });
  }
}
async function detachEstimateOrders(models, estimateId, workOrderId, transaction) {
  const { InboundOrder, PONumber } = models;
  if (InboundOrder) await InboundOrder.update({ workOrderId: null }, { where: { estimateId, workOrderId }, transaction });
  if (PONumber) await PONumber.update({ workOrderId: null }, { where: { estimateId, workOrderId }, transaction });
}

// W9: rows that belong to the order (its DR, POs, deliveries, shipments) carry the order's client
async function syncOrderClient(models, workOrderId, clientId, clientName, transaction) {
  const { sequelize } = models;
  const rep = { wo: workOrderId, id: clientId || null, name: clientName == null ? null : String(clientName) };
  for (const t of ['dr_numbers', 'po_numbers', 'inbound_orders']) {
    await sequelize.query(`UPDATE ${t} SET "clientId" = :id, "clientName" = COALESCE(CAST(:name AS text), "clientName")
      WHERE "workOrderId" = :wo AND ("clientId" IS DISTINCT FROM :id OR "clientName" IS DISTINCT FROM COALESCE(CAST(:name AS text), "clientName"))`,
      { replacements: rep, transaction });
  }
  if (rep.name) {
    await sequelize.query(`UPDATE shipments SET "clientName" = :name WHERE "workOrderId" = :wo AND "clientName" IS DISTINCT FROM :name`,
      { replacements: rep, transaction });
  }
}

// U23: lines with an inspection job that has measurements saved or is past not_started
async function inspectedPartIds(sequelize, ids, transaction) {
  if (!ids.length) return new Set();
  const filled = (c) => `(u.${c} IS NOT NULL AND u.${c}::text NOT IN ('{}', '[]', 'null', '""'))`;
  const [rows] = await sequelize.query(`SELECT j."workOrderPartId" AS p, j."inspectionPartId" AS s FROM inspection_jobs j
    WHERE (j."workOrderPartId" IN (:ids) OR j."inspectionPartId" IN (:ids))
      AND (COALESCE(j.status, 'not_started') <> 'not_started'
        OR EXISTS (SELECT 1 FROM inspection_units u WHERE u."inspectionJobId" = j.id AND (${filled('"preRoll"')} OR ${filled('"postRoll"')})))`,
    { replacements: { ids }, transaction });
  return new Set(rows.flatMap(r => [r.p, r.s]).filter(Boolean));
}

// U18: the order's previous client as it is NOW — by id (its current name), else by name ignoring case
// and spaces (it was merged away), else just the name with no id
async function resolveClient(models, before, transaction) {
  const { Client, sequelize } = models;
  const out = {};
  if (!Client) return out;
  const byId = await Client.findByPk(before.clientId, { attributes: ['id', 'name'], transaction });
  if (byId) { if ('clientName' in before) out.clientName = byId.name; return out; }
  // W20: merged away (e.g. while the order sat in Deleted Items, whose snapshot the merge can't fix) —
  // follow the merge log
  const to = await require('./partyRefs').mergedInto(sequelize, 'clients', before.clientId, transaction);
  const merged = to ? await Client.findByPk(to, { attributes: ['id', 'name'], transaction }) : null;
  if (merged) { out.clientId = merged.id; if ('clientName' in before) out.clientName = merged.name; return out; }
  const name = before.clientName ? String(before.clientName).trim() : '';
  const byName = name ? await Client.findOne({ attributes: ['id', 'name'], transaction,
    where: sequelize.where(sequelize.fn('lower', sequelize.fn('trim', sequelize.col('name'))), name.toLowerCase()) }) : null;
  out.clientId = byName ? byName.id : null;
  if ('clientName' in before && byName) out.clientName = byName.name;
  return out;
}

module.exports = EstimateLinkService;
module.exports.attachEstimateOrders = attachEstimateOrders;
module.exports.detachEstimateOrders = detachEstimateOrders;
