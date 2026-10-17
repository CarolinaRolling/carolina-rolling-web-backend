/**
 * estimateCopy — copy an estimate's parts, part files and shipping charges onto a work order
 * (round 9, audit R9). Used by BOTH "Convert to work order" and "Link estimate to an existing work
 * order", so the two can't drift apart again: Link used to copy a hand-written field list that set
 * labor from rollingCost with no markup and dropped formData (roll details), outside processing,
 * files, lot numbers and shipping charges — a linked order billed $120 where the converted one billed
 * $320.
 */
const { buildWorkOrderPartFromEstimate } = require('./pricing');
const { computeDisplayNumbers } = require('./partNumbering');
const { nextLotNumber, noteLotNumber } = require('./lotNumbers');

function woFileType(file) {
  let fileType = file.fileType || 'other';
  const ext = (file.originalName || file.filename || '').toLowerCase();
  if (ext.endsWith('.pdf') || fileType === 'drawing' || fileType === 'print') fileType = 'pdf_print';
  else if (ext.endsWith('.stp') || ext.endsWith('.step') || fileType === 'step_file') fileType = 'step_file';
  else if (fileType === 'specification') fileType = 'other';
  return fileType;
}

/**
 * @param estimate  with parts (and parts.files) loaded
 * @param workOrder the target order
 * @param opts.transaction
 * @param opts.drNumber        lot numbers become <DR>-<line>
 * @param opts.partNumberOffset added to each estimate line number (Link appends after existing lines)
 * @returns { created: [WorkOrderPart], idMap: { estimatePartId: workOrderPartId } }
 */
async function copyEstimateParts(models, estimate, workOrder, { transaction, drNumber = null, partNumberOffset = 0, log = null, extraFormData = null } = {}) {
  const { WorkOrderPart, WorkOrderPartFile } = models;
  // in line order, so lots come out in line order when one has to be skipped (V6)
  const parts = [...(estimate.parts || [])].sort((a, b) => (Number(a.partNumber) || 0) - (Number(b.partNumber) || 0));
  let display = {};
  try { display = (computeDisplayNumbers(parts) || {}).display || {}; } catch (_) { display = {}; }
  const idMap = {};
  const created = [];
  const createdFd = {};
  const lotBatch = new Set();   // V6: lots handed out in this copy, so two new parts can't share one
  for (const ep of parts) {
    try {
      const partData = buildWorkOrderPartFromEstimate(ep);
      partData.workOrderId = workOrder.id;
      if (partNumberOffset) partData.partNumber = (Number(partData.partNumber) || 0) + partNumberOffset;
      if (!partData.lotNumber || !String(partData.lotNumber).trim()) {
        // V6: never a <DR>-n already on the order (or earlier in this batch)
        if (drNumber) partData.lotNumber = await nextLotNumber(workOrder.id, drNumber, partNumberOffset ? partData.partNumber : (display[ep.id] || ep.partNumber), { transaction, reserved: lotBatch, models });
      } else {
        lotBatch.add(String(partData.lotNumber).trim());
        await noteLotNumber(workOrder.id, partData.lotNumber, { transaction, models });   // W6
      }
      if (extraFormData) partData.formData = { ...(partData.formData && typeof partData.formData === 'object' ? partData.formData : {}), ...extraFormData };
      if (log) log(`Part #${partData.partNumber} (${partData.partType}): labor=${partData.laborTotal}, material=${partData.materialTotal}, total=${partData.partTotal}`);
      const wp = await WorkOrderPart.create(partData, { transaction });
      idMap[ep.id] = wp.id;
      createdFd[ep.id] = wp.formData && typeof wp.formData === 'object' ? wp.formData : {};
      created.push(wp);
      for (const file of ep.files || []) {
        await WorkOrderPartFile.create({
          workOrderPartId: wp.id, filename: file.filename, originalName: file.originalName, mimeType: file.mimeType,
          size: file.size, url: file.url, cloudinaryId: file.cloudinaryId, fileType: woFileType(file),
        }, { transaction });
      }
    } catch (partErr) {
      if (partErr.errors) partErr.errors.forEach(e => console.error(`  Validation: ${e.path} - ${e.message}`));
      throw new Error(`Failed on part #${ep.partNumber} (${ep.partType}): ${partErr.message}`);
    }
  }
  // Service lines point at the part they serve (formData._linkedPartId): estimate ids → work-order ids
  for (const ep of parts) {
    const fd = ep.formData && typeof ep.formData === 'object' ? ep.formData : {};
    if (fd._linkedPartId && idMap[fd._linkedPartId] && idMap[ep.id]) {
      // merge into the CREATED part's formData (it may carry more than the estimate's, e.g. the link tag)
      await WorkOrderPart.update({ formData: { ...fd, ...createdFd[ep.id], _linkedPartId: idMap[fd._linkedPartId] } }, { where: { id: idMap[ep.id] }, transaction });
    }
  }
  return { created, idMap };
}

/** Copy the estimate's shipping charges onto the work order. */
async function copyEstimateCharges(models, estimate, workOrder, { transaction } = {}) {
  const { ShipmentCharge } = models;
  if (!ShipmentCharge) return 0;
  const charges = await ShipmentCharge.findAll({ where: { estimateId: estimate.id }, transaction });
  for (const sc of charges) {
    await ShipmentCharge.create({
      workOrderId: workOrder.id, sortOrder: sc.sortOrder, carrierType: sc.carrierType, vendorId: sc.vendorId,
      vendorName: sc.vendorName, pickupLocation: sc.pickupLocation, pickupIsShop: sc.pickupIsShop,
      dropoffLocation: sc.dropoffLocation, dropoffIsShop: sc.dropoffIsShop, shippingCost: sc.shippingCost,
      shippingMarkup: sc.shippingMarkup, materialsCost: sc.materialsCost, materialsMarkup: sc.materialsMarkup,
      notes: sc.notes, distanceMiles: sc.distanceMiles, durationMinutes: sc.durationMinutes,
    }, { transaction });
  }
  return charges.length;
}

module.exports = { copyEstimateParts, copyEstimateCharges, woFileType };
