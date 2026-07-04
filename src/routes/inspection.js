const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { Op } = require('sequelize');
const PDFDocument = require('pdfkit');
const { computeDisplayNumbers } = require('../services/partNumbering');
const {
  InspectionJob, InspectionUnit, InspectionTool, WorkOrder, WorkOrderPart, WorkOrderDocument, sequelize
} = require('../models');

// Helper: generate unit ID from WO context
// e.g. drNumber=58747, partLine=2, sequence=2 → "58747-2-3" (DR - line - piece index)
function makeUnitId(drNumber, partLine, sequence) {
  return `${drNumber}-${partLine}-${sequence + 1}`;
}

// Next free sequence in a job (max+1, so it never collides after a move/delete leaves a gap)
function nextSequence(units) {
  if (!units || !units.length) return 0;
  return Math.max(...units.map(u => u.sequence || 0)) + 1;
}

// Clean production line number for a part (1, 2, 3 — ignoring service line-items),
// used so cylinder IDs / IR numbers read DR-1-1 instead of DR-3-1. Falls back to the
// stored partNumber on any error.
async function cleanLineNumber(workOrderId, partId, fallback) {
  try {
    const parts = await WorkOrderPart.findAll({
      where: { workOrderId },
      attributes: ['id', 'partNumber', 'partType', 'formData']
    });
    const { display } = computeDisplayNumbers(parts.map(p => ({
      id: p.id, partNumber: p.partNumber, partType: p.partType, formData: p.formData
    })));
    return display[partId] || fallback;
  } catch (e) { return fallback; }
}

// Helper: calculate out-of-square (returns inches difference)
function calcOutOfSquare(diagA, diagB) {
  return Math.abs((parseFloat(diagA) || 0) - (parseFloat(diagB) || 0));
}

// Helper: calculate max diameter variance
function calcDiamVariance(seam, d90, d45, dNeg45) {
  const vals = [parseFloat(seam)||0, parseFloat(d90)||0, parseFloat(d45)||0, parseFloat(dNeg45)||0].filter(v => v > 0);
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}

// Parse a spec dimension that may be a fraction ("36 1/4"), decimal, or have units
function parseSpec(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const s = String(v).trim();
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)/);
  if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)/);
  if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
  const dec = parseFloat(s);
  return isNaN(dec) ? null : dec;
}

// Nominal ordered diameter for a part (for ASME UG-80 out-of-round %)
function specDiameter(part) {
  if (!part) return null;
  const fd = part.formData || {};
  const d = parseSpec(part.diameter) ?? parseSpec(part.outerDiameter) ?? parseSpec(fd.diameter) ?? parseSpec(fd.outerDiameter);
  if (d != null) return d;
  // Parts rolled to a radius store `radius` instead of a diameter — convert it
  const r = parseSpec(part.radius) ?? parseSpec(fd.radius);
  return r != null ? r * 2 : null;
}

// ASME UG-80(a)(1) out-of-roundness: (Dmax − Dmin) must be ≤ 1% of nominal diameter (internal pressure).
// Returns { variance, ratioPct (or null), fail }. Falls back to a fixed 1/4" spread when no nominal Ø is known.
const ASME_OOR_LIMIT = 0.01; // 1%
const OOR_FALLBACK_SPREAD = 0.25; // 1/4" when nominal diameter unavailable
function evalOutOfRound(po, nominalD) {
  const variance = calcDiamVariance(po.diamSeam, po.diam90, po.diam45, po.diamNeg45);
  if (nominalD && nominalD > 0) {
    const ratio = variance / nominalD;
    return { variance, ratioPct: Math.round(ratio * 100 * 100) / 100, fail: ratio > ASME_OOR_LIMIT + 1e-6 };
  }
  return { variance, ratioPct: null, fail: variance > OOR_FALLBACK_SPREAD + 0.001 };
}

// ── Inspection tools registry ──
// GET /api/inspections/tools — list tools (active only unless ?all=true)
router.get('/tools', async (req, res, next) => {
  try {
    const where = req.query.all === 'true' ? {} : { isActive: true };
    const tools = await InspectionTool.findAll({ where, order: [['name', 'ASC']] });
    res.json({ data: tools });
  } catch(error) { next(error); }
});

// POST /api/inspections/tools — register a tool
router.post('/tools', async (req, res, next) => {
  try {
    const { name, toolType, serialNumber, calibrationDate, calibrationDueDate, notes } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: { message: 'Tool name required' } });
    const tool = await InspectionTool.create({
      name: String(name).trim(), toolType: toolType || null, serialNumber: serialNumber || null,
      calibrationDate: calibrationDate || null, calibrationDueDate: calibrationDueDate || null, notes: notes || null,
    });
    res.json({ data: tool });
  } catch(error) { next(error); }
});

// PATCH /api/inspections/tools/:id — edit a tool
router.patch('/tools/:id', async (req, res, next) => {
  try {
    const tool = await InspectionTool.findByPk(req.params.id);
    if (!tool) return res.status(404).json({ error: { message: 'Tool not found' } });
    const updates = {};
    ['name','toolType','serialNumber','calibrationDate','calibrationDueDate','notes','isActive']
      .forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    await tool.update(updates);
    res.json({ data: tool });
  } catch(error) { next(error); }
});

// DELETE /api/inspections/tools/:id — deactivate (kept for historical reports)
router.delete('/tools/:id', async (req, res, next) => {
  try {
    const tool = await InspectionTool.findByPk(req.params.id);
    if (!tool) return res.status(404).json({ error: { message: 'Tool not found' } });
    await tool.update({ isActive: false });
    res.json({ data: { id: tool.id, deactivated: true } });
  } catch(error) { next(error); }
});

// GET /api/inspections/job/:workOrderId — get all inspection jobs for a WO
router.get('/job/:workOrderId', async (req, res, next) => {
  try {
    const jobs = await InspectionJob.findAll({
      where: { workOrderId: req.params.workOrderId },
      include: [{ model: InspectionUnit, as: 'units', order: [['sequence', 'ASC']] }],
      order: [['createdAt', 'ASC']]
    });
    // Attach nominal diameter (for ASME UG-80 out-of-round %) so clients can flag live
    const out = [];
    for (const j of jobs) {
      const jj = j.toJSON();
      const part = await WorkOrderPart.findByPk(j.workOrderPartId, { attributes: ['diameter','outerDiameter','radius','formData'] });
      jj.nominalDiameter = specDiameter(part);
      out.push(jj);
    }
    res.json({ data: out });
  } catch(error) { next(error); }
});

// POST /api/inspections/job — create inspection job when inspection part is added
router.post('/job', async (req, res, next) => {
  try {
    const { workOrderId, workOrderPartId, inspectionPartId, inspectionType, unitCount, operatorName, skipPreRoll } = req.body;
    if (!workOrderId || !workOrderPartId) {
      return res.status(400).json({ error: { message: 'workOrderId and workOrderPartId required' } });
    }

    // Get WO and part info to generate unit IDs
    const wo = await WorkOrder.findByPk(workOrderId, { attributes: ['id','drNumber','orderNumber'] });
    const part = await WorkOrderPart.findByPk(workOrderPartId, { attributes: ['id','partNumber','quantity'] });
    if (!wo || !part) return res.status(404).json({ error: { message: 'Work order or part not found' } });

    const count = parseInt(unitCount) || parseInt(part.quantity) || 1;
    const drNum = wo.drNumber || wo.orderNumber || workOrderId.slice(0,8);
    const lineNum = await cleanLineNumber(workOrderId, part.id, part.partNumber);

    const job = await InspectionJob.create({
      workOrderId, workOrderPartId, inspectionPartId: inspectionPartId || null,
      inspectionType: inspectionType || 'cylinder',
      unitCount: count, operatorName: operatorName || null,
      skipPreRoll: !!skipPreRoll,
    });

    // Create unit records
    const units = [];
    for (let i = 0; i < count; i++) {
      units.push(await InspectionUnit.create({
        inspectionJobId: job.id,
        unitId: makeUnitId(drNum, lineNum, i),
        sequence: i,
      }));
    }

    const result = await InspectionJob.findByPk(job.id, {
      include: [{ model: InspectionUnit, as: 'units', order: [['sequence', 'ASC']] }]
    });
    res.json({ data: result });
  } catch(error) { next(error); }
});

// PATCH /api/inspections/job/:id — update job settings (skipPreRoll, operator, notes)
router.patch('/job/:id', async (req, res, next) => {
  try {
    const job = await InspectionJob.findByPk(req.params.id, {
      include: [{ model: InspectionUnit, as: 'units' }]
    });
    if (!job) return res.status(404).json({ error: { message: 'Job not found' } });

    const updates = {};
    if (req.body.skipPreRoll !== undefined) updates.skipPreRoll = !!req.body.skipPreRoll;
    if (req.body.operatorName !== undefined) updates.operatorName = req.body.operatorName;
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.toolsUsed !== undefined) updates.toolsUsed = Array.isArray(req.body.toolsUsed) ? req.body.toolsUsed : [];
    await job.update(updates);

    // Recompute job status with the (possibly new) skip flag
    const skip = updates.skipPreRoll !== undefined ? updates.skipPreRoll : job.skipPreRoll;
    const allUnits = job.units || [];
    const allComplete = allUnits.length > 0 && allUnits.every(u => (skip || u.preRollComplete) && u.postRollComplete);
    const anyStarted = allUnits.some(u => u.preRollComplete || u.postRollComplete ||
      Object.keys(u.preRoll || {}).length > 0 || Object.keys(u.postRoll || {}).length > 0);
    await job.update({ status: allComplete ? 'complete' : anyStarted ? 'in_progress' : 'not_started', completedAt: allComplete ? new Date() : null });

    const result = await InspectionJob.findByPk(job.id, {
      include: [{ model: InspectionUnit, as: 'units', order: [['sequence', 'ASC']] }]
    });
    res.json({ data: result });
  } catch(error) { next(error); }
});

// PATCH /api/inspections/unit/:id — save measurements for a single unit
router.patch('/unit/:id', async (req, res, next) => {
  try {
    const unit = await InspectionUnit.findByPk(req.params.id);
    if (!unit) return res.status(404).json({ error: { message: 'Unit not found' } });

    const updates = {};

    if (req.body.preRoll !== undefined) {
      const pr = req.body.preRoll;
      // Auto-calculate out-of-square
      const oos = calcOutOfSquare(pr.diagA, pr.diagB);
      pr.outOfSquare = oos > 0.1875;
      pr.outOfSquareAmount = Math.round(oos * 10000) / 10000;
      updates.preRoll = pr;
      // Mark complete if all required fields present
      updates.preRollComplete = !!(
        pr.thickness && pr.gradeConfirmed && pr.heatNumberConfirmed &&
        pr.widthEnd1 && pr.widthEnd2 && pr.lengthEnd1 && pr.lengthEnd2 &&
        pr.diagA && pr.diagB
      );
    }

    if (req.body.postRoll !== undefined) {
      const po = req.body.postRoll;
      // ASME UG-80 out-of-roundness: (Dmax−Dmin) ≤ 1% of nominal diameter
      let nominalD = null;
      const jobForSpec = await InspectionJob.findByPk(unit.inspectionJobId, { attributes: ['workOrderPartId'] });
      if (jobForSpec) {
        const partForSpec = await WorkOrderPart.findByPk(jobForSpec.workOrderPartId, { attributes: ['diameter','outerDiameter','radius','formData'] });
        nominalD = specDiameter(partForSpec);
      }
      const oor = evalOutOfRound(po, nominalD);
      po.diamVariance = Math.round(oor.variance * 10000) / 10000;
      po.diamRatio = oor.ratioPct;            // % of nominal diameter (null if no nominal Ø)
      po.nominalDiameter = nominalD || null;  // snapshot for the report
      po.outOfTolerance = oor.fail;
      updates.postRoll = po;
      updates.postRollComplete = !!(
        po.circumEnd1 && po.circumEnd2 &&
        po.diamSeam && po.diam90 && po.diam45 && po.diamNeg45
      );
    }

    if (req.body.clientNotes !== undefined) updates.clientNotes = req.body.clientNotes;
    if (req.body.labelPrinted !== undefined) updates.labelPrinted = req.body.labelPrinted;

    await unit.update(updates);

    // Update parent job status
    let justCompletedJobId = null;
    const job = await InspectionJob.findByPk(unit.inspectionJobId, {
      include: [{ model: InspectionUnit, as: 'units' }]
    });
    if (job) {
      const wasComplete = job.status === 'complete';
      const allUnits = job.units || [];
      const allComplete = allUnits.length > 0 && allUnits.every(u => (job.skipPreRoll || u.preRollComplete) && u.postRollComplete);
      const anyStarted = allUnits.some(u => u.preRollComplete || u.postRollComplete ||
        Object.keys(u.preRoll || {}).length > 0 || Object.keys(u.postRoll || {}).length > 0);
      const newStatus = allComplete ? 'complete' : anyStarted ? 'in_progress' : 'not_started';
      // Auto-fill the operator from the tablet's API key identity if not already set
      const tabletOperator = req.apiKey ? (req.apiKey.operatorName || req.apiKey.name) : null;
      const jobUpdate = {
        status: newStatus,
        completedAt: allComplete ? new Date() : null
      };
      if (!job.operatorName && tabletOperator) jobUpdate.operatorName = tabletOperator;
      await job.update(jobUpdate);
      if (newStatus === 'complete' && !wasComplete) justCompletedJobId = job.id;
    }

    const updated = await InspectionUnit.findByPk(unit.id);
    res.json({ data: updated });

    // After responding: when the inspection just reached complete, auto-generate the report
    // PDF and file it under the work order's documents (named the IR number).
    if (justCompletedJobId) {
      saveInspectionReportDocument(justCompletedJobId)
        .catch(e => console.error('[InspectionReport] auto-save failed:', e.message));
    }
  } catch(error) { next(error); }
});

// DELETE /api/inspections/job/:id — remove inspection job
router.delete('/job/:id', async (req, res, next) => {
  try {
    const job = await InspectionJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ error: { message: 'Not found' } });
    await job.destroy();
    res.json({ data: { deleted: true } });
  } catch(error) { next(error); }
});

// POST /api/inspections/job/:id/add-unit — add a cylinder to an existing job
router.post('/job/:id/add-unit', async (req, res, next) => {
  try {
    const job = await InspectionJob.findByPk(req.params.id, {
      include: [{ model: InspectionUnit, as: 'units' }]
    });
    if (!job) return res.status(404).json({ error: { message: 'Job not found' } });

    const wo = await WorkOrder.findByPk(job.workOrderId, { attributes: ['id','drNumber','orderNumber'] });
    const part = await WorkOrderPart.findByPk(job.workOrderPartId, { attributes: ['id','partNumber'] });
    const drNum = wo?.drNumber || wo?.orderNumber || job.workOrderId.slice(0,8);
    const sequence = nextSequence(job.units);
    const lineNum = await cleanLineNumber(job.workOrderId, job.workOrderPartId, part?.partNumber || 1);

    const unit = await InspectionUnit.create({
      inspectionJobId: job.id,
      unitId: makeUnitId(drNum, lineNum, sequence),
      sequence,
    });

    await job.update({ unitCount: (job.units?.length || 0) + 1 });
    res.json({ data: unit });
  } catch(error) { next(error); }
});

// Helper: recompute a job's unitCount + status from its units
async function recomputeJob(jobId) {
  const j = await InspectionJob.findByPk(jobId, { include: [{ model: InspectionUnit, as: 'units' }] });
  if (!j) return;
  const us = j.units || [];
  const allComplete = us.length > 0 && us.every(u => (j.skipPreRoll || u.preRollComplete) && u.postRollComplete);
  const anyStarted = us.some(u => u.preRollComplete || u.postRollComplete ||
    Object.keys(u.preRoll || {}).length > 0 || Object.keys(u.postRoll || {}).length > 0);
  await j.update({
    unitCount: us.length,
    status: allComplete ? 'complete' : anyStarted ? 'in_progress' : 'not_started',
    completedAt: allComplete ? new Date() : null,
  });
}

// PATCH /api/inspections/unit/:id/move — move a cylinder (data intact) to another line's inspection
router.patch('/unit/:id/move', async (req, res, next) => {
  try {
    const { targetWorkOrderPartId } = req.body;
    if (!targetWorkOrderPartId) return res.status(400).json({ error: { message: 'targetWorkOrderPartId required' } });

    const unit = await InspectionUnit.findByPk(req.params.id);
    if (!unit) return res.status(404).json({ error: { message: 'Cylinder not found' } });

    const sourceJob = await InspectionJob.findByPk(unit.inspectionJobId);
    if (!sourceJob) return res.status(404).json({ error: { message: 'Source inspection not found' } });
    if (sourceJob.workOrderPartId === targetWorkOrderPartId) {
      return res.status(400).json({ error: { message: 'Cylinder is already on that line' } });
    }

    const wo = await WorkOrder.findByPk(sourceJob.workOrderId, { attributes: ['id','drNumber','orderNumber'] });
    const targetPart = await WorkOrderPart.findByPk(targetWorkOrderPartId, { attributes: ['id','partNumber','workOrderId'] });
    if (!targetPart || targetPart.workOrderId !== sourceJob.workOrderId) {
      return res.status(400).json({ error: { message: 'Target line not found on this work order' } });
    }
    const drNum = wo?.drNumber || wo?.orderNumber || sourceJob.workOrderId.slice(0,8);

    // Find or create the target inspection job (no auto-created blank cylinders)
    let targetJob = await InspectionJob.findOne({
      where: { workOrderId: sourceJob.workOrderId, workOrderPartId: targetWorkOrderPartId },
      include: [{ model: InspectionUnit, as: 'units' }]
    });
    if (!targetJob) {
      targetJob = await InspectionJob.create({
        workOrderId: sourceJob.workOrderId,
        workOrderPartId: targetWorkOrderPartId,
        inspectionType: sourceJob.inspectionType || 'cylinder',
        unitCount: 0,
        skipPreRoll: sourceJob.skipPreRoll,
      });
      targetJob.units = [];
    }

    // Reassign + renumber to the target line; force a label reprint
    const newSeq = nextSequence(targetJob.units);
    const lineNum = await cleanLineNumber(sourceJob.workOrderId, targetWorkOrderPartId, targetPart.partNumber);
    await unit.update({
      inspectionJobId: targetJob.id,
      sequence: newSeq,
      unitId: makeUnitId(drNum, lineNum, newSeq),
      labelPrinted: false,
    });

    await recomputeJob(sourceJob.id);
    await recomputeJob(targetJob.id);

    res.json({ data: { id: unit.id, unitId: unit.unitId, targetJobId: targetJob.id } });
  } catch(error) { next(error); }
});

// DELETE /api/inspections/unit/:id — remove a single cylinder
router.delete('/unit/:id', async (req, res, next) => {
  try {
    const unit = await InspectionUnit.findByPk(req.params.id);
    if (!unit) return res.status(404).json({ error: { message: 'Cylinder not found' } });
    const jobId = unit.inspectionJobId;
    await unit.destroy();
    await recomputeJob(jobId);
    res.json({ data: { id: req.params.id, deleted: true } });
  } catch(error) { next(error); }
});

// Build the inspection report PDF for a job; returns { buffer, drLabel, irNumber }
async function generateInspectionReportBuffer(jobId) {
    const job = await InspectionJob.findByPk(jobId, {
      include: [{ model: InspectionUnit, as: 'units', order: [['sequence', 'ASC']] }]
    });
    if (!job) throw new Error('Inspection job not found');

    const wo = await WorkOrder.findByPk(job.workOrderId, {
      attributes: ['id','drNumber','orderNumber','clientName','clientPurchaseOrderNumber','invoiceDate']
    });
    const part = await WorkOrderPart.findByPk(job.workOrderPartId, {
      attributes: ['id','partNumber','clientPartNumber','heatNumber','materialDescription','formData','quantity','rev','lotNumber','diameter','outerDiameter','radius']
    });
    const reportLineNum = await cleanLineNumber(job.workOrderId, part?.id, part?.partNumber ?? '');

    // Operator's stored signature (set once per operator in CRAdmin) — auto-applied below
    let operatorSig = null;
    try {
      if (job.operatorName) {
        const { OperatorSignature } = require('../models');
        const sigRow = await OperatorSignature.findOne({ where: { operatorName: job.operatorName } });
        if (sigRow?.signatureData && String(sigRow.signatureData).startsWith('data:image')) operatorSig = sigRow.signatureData;
      }
    } catch (e) {}

    let toolsUsed = [];
    if (Array.isArray(job.toolsUsed) && job.toolsUsed.length) {
      toolsUsed = await InspectionTool.findAll({ where: { id: { [Op.in]: job.toolsUsed } }, order: [['name', 'ASC']] });
    }

    const doc = new PDFDocument({ margin: 50, size: 'letter', bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const endPromise = new Promise(r => doc.on('end', r));

    const primaryColor = '#1565c0';
    const darkColor = '#1a1a1a';
    const grayColor = '#555555';
    const lightGray = '#e0e0e0';
    const passColor = '#2e7d32';
    const failColor = '#c62828';
    const warnColor = '#e65100';

    const fmtMeas = v => v ? parseFloat(v).toFixed(4) + '"' : '—';
    const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '—';

    // ── HEADER ──
    const irNumber = `IR-${wo?.drNumber || wo?.orderNumber || ''}-${reportLineNum}`;
    const logoPath = [path.join(__dirname, '../assets/logo.png'), path.join(__dirname, '../assets/logo.jpg')].find(p => fs.existsSync(p));
    try { if (logoPath && fs.existsSync(logoPath)) doc.image(logoPath, 50, 28, { width: 60 }); } catch (e) { /* no logo */ }
    doc.font('Helvetica-Bold').fontSize(22).fillColor(primaryColor).text('INSPECTION REPORT', 300, 50, { width:262, align:'right' });
    doc.font('Helvetica').fontSize(10).fillColor(grayColor).text(`Date: ${fmtDate(new Date())}`, 300, 76, { width:262, align:'right' });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text(`Report #: ${irNumber}`, 300, 88, { width:262, align:'right' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(darkColor).text('Carolina Rolling Co. Inc.', 120, 50);
    doc.font('Helvetica').fontSize(9).fillColor(grayColor)
      .text('9152 Sonrisa St., Bellflower, CA 90706', 120, 63)
      .text('(562) 633-1044 | keepitrolling@carolinarolling.com', 120, 74);

    doc.moveTo(50, 100).lineTo(562, 100).lineWidth(2).strokeColor(primaryColor).stroke();

    // ── JOB INFO ──
    let y = 108;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor);
    doc.text('CLIENT:', 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(darkColor).text(wo?.clientName || '—', 120, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor).text('WORK ORDER:', 300, y);
    doc.font('Helvetica').fontSize(10).text(wo?.drNumber ? 'DR-' + wo.drNumber : wo?.orderNumber || '—', 390, y);
    y += 16;
    doc.font('Helvetica-Bold').fontSize(10).text('CLIENT PO:', 50, y);
    doc.font('Helvetica').fontSize(10).text(wo?.clientPurchaseOrderNumber || '—', 120, y);
    doc.font('Helvetica-Bold').fontSize(10).text('LOT #:', 300, y);
    const drForLot = wo?.drNumber || wo?.orderNumber || '';
    const lotNumber = part?.lotNumber || (drForLot ? `${drForLot}-${reportLineNum}` : (reportLineNum || '—'));
    doc.font('Helvetica').fontSize(10).text(String(lotNumber || '—'), 390, y);
    y += 16;
    doc.font('Helvetica-Bold').fontSize(10).text('HEAT #:', 50, y);
    doc.font('Helvetica').fontSize(10).text(part?.heatNumber || '—', 120, y);
    doc.font('Helvetica-Bold').fontSize(10).text('OPERATOR:', 300, y);
    doc.font('Helvetica').fontSize(10).text(job.operatorName || '—', 390, y);
    if (part?.rev) {
      y += 16;
      doc.font('Helvetica-Bold').fontSize(10).text('REV:', 50, y);
      doc.font('Helvetica').fontSize(10).text(String(part.rev), 120, y);
    }
    y += 16;
    doc.font('Helvetica-Bold').fontSize(10).text('TOTAL UNITS:', 50, y);
    doc.font('Helvetica').fontSize(10).text(`${job.units?.length || 0} cylinders`, 140, y);
    y += 16;
    // Description = size + roll instructions strung together, as a quick reference
    const matDesc = part?.materialDescription || (part?.formData?._materialDescription) || '';
    let rollDesc = part?.formData?._rollingDescription || '';
    if (rollDesc) rollDesc = rollDesc.replace(/\\n/g, ' · ').replace(/\n/g, ' · ').replace(/\s*·\s*/g, ' · ').trim();
    const fullDesc = [matDesc, rollDesc].filter(Boolean).join(' — ') || '—';
    doc.font('Helvetica-Bold').fontSize(10).text('DESCRIPTION:', 50, y);
    doc.font('Helvetica').fontSize(9).text(fullDesc, 140, y, { width: 400 });
    const descH = doc.heightOfString(fullDesc, { width: 400 });
    y += Math.max(16, descH);

    doc.moveTo(50, y + 6).lineTo(562, y + 6).lineWidth(0.5).strokeColor(lightGray).stroke();
    y += 20;

    // ── INSPECTION TOOLS USED ──
    if (toolsUsed.length) {
      if (y > 640) { doc.addPage(); y = 50; }
      doc.font('Helvetica-Bold').fontSize(11).fillColor(primaryColor).text('INSPECTION TOOLS USED', 50, y);
      y += 16;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(grayColor);
      doc.text('Tool', 56, y, { width: 200, lineBreak: false });
      doc.text('Serial / ID', 260, y, { width: 130, lineBreak: false });
      doc.text('Cal. Due', 400, y, { width: 150, lineBreak: false });
      y += 14;
      toolsUsed.forEach((t, idx) => {
        if (y > 700) { doc.addPage(); y = 50; }
        const rowBg = idx % 2 === 0 ? '#f8f9fa' : 'white';
        doc.rect(50, y, 512, 16).fill(rowBg).stroke();
        const label = t.toolType ? `${t.name} (${t.toolType})` : t.name;
        doc.font('Helvetica').fontSize(9).fillColor(darkColor).text(label, 56, y + 4, { width: 200, lineBreak: false });
        doc.fillColor(grayColor).text(t.serialNumber || '—', 260, y + 4, { width: 130, lineBreak: false });
        doc.text(fmtDate(t.calibrationDueDate), 400, y + 4, { width: 150, lineBreak: false });
        y += 16;
      });
      y += 14;
      doc.moveTo(50, y - 8).lineTo(562, y - 8).lineWidth(0.5).strokeColor(lightGray).stroke();
    }

    // ── UNITS ──
    for (const unit of (job.units || [])) {
      const pr = unit.preRoll || {};
      const po = unit.postRoll || {};

      // Measure this cylinder's whole block so it never splits across a page —
      // but only break when it genuinely won't fit, so pages stay packed (no big gaps).
      let unitH = 28 + 8 + 14 + 7 * 16 + 20; // header bar + gap + post-roll header + 7 rows + trailer
      if (!job.skipPreRoll) {
        unitH += 14 + 10 * 16; // pre-roll header + 10 rows
        if (pr.outOfSquare && unit.clientNotes) unitH += 16;
      }
      if (y > 60 && y + unitH > 742) { doc.addPage(); y = 50; }

      // Unit header bar
      doc.rect(50, y, 512, 22).fill(primaryColor).stroke();
      doc.font('Helvetica-Bold').fontSize(12).fillColor('white')
        .text(`Cylinder ID: ${unit.unitId}`, 58, y + 5, { lineBreak: false });
      const unitDone = (job.skipPreRoll || unit.preRollComplete) && unit.postRollComplete;
      const unitStatus = unitDone ? '✓ COMPLETE' : 'IN PROGRESS';
      const unitStatusColor = unitDone ? '#a5d6a7' : '#ffe082';
      doc.font('Helvetica-Bold').fontSize(10).fillColor(unitStatusColor)
        .text(unitStatus, 400, y + 7, { width: 154, align: 'right', lineBreak: false });
      y += 28;

      if (!job.skipPreRoll) {
      // PRE-ROLL section
      doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text('PRE-ROLL MEASUREMENTS', 50, y);
      y += 14;

      const preRows = [
        ['Thickness', fmtMeas(pr.thickness), null],
        ['Grade Confirmed', pr.gradeConfirmed ? '✓ YES' : (pr.gradeConfirmed===false?'✗ NO':'—'), pr.gradeConfirmed===false?'FAIL':null],
        ['Heat Number Confirmed', pr.heatNumberConfirmed ? '✓ YES' : (pr.heatNumberConfirmed===false?'✗ NO':'—'), pr.heatNumberConfirmed===false?'FAIL':null],
        ['Width — End 1', fmtMeas(pr.widthEnd1), null],
        ['Width — End 2', fmtMeas(pr.widthEnd2), null],
        ['Length — End 1', fmtMeas(pr.lengthEnd1), null],
        ['Length — End 2', fmtMeas(pr.lengthEnd2), null],
        ['Diagonal A', fmtMeas(pr.diagA), null],
        ['Diagonal B', fmtMeas(pr.diagB), null],
        ['Out of Square', pr.outOfSquare ? `⚠ YES — ${fmtMeas(pr.outOfSquareAmount)} (limit: 3/16")` : (pr.diagA && pr.diagB ? '✓ PASS' : '—'), pr.outOfSquare ? 'WARN' : null],
      ];

      preRows.forEach(([label, value, flag], idx) => {
        if (y > 700) { doc.addPage(); y = 50; }
        const rowBg = idx % 2 === 0 ? '#f8f9fa' : 'white';
        doc.rect(50, y, 512, 16).fill(rowBg).stroke();
        doc.font('Helvetica').fontSize(9).fillColor(grayColor).text(label, 56, y + 4, { width: 200, lineBreak: false });
        const valColor = flag === 'FAIL' ? failColor : flag === 'WARN' ? warnColor : darkColor;
        doc.font(flag ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(valColor).text(value, 260, y + 4, { width: 296, lineBreak: false });
        y += 16;
      });

      if (pr.outOfSquare && unit.clientNotes) {
        doc.rect(50, y, 512, 16).fill('#fff8e1').stroke();
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(warnColor)
          .text(`Client note: ${unit.clientNotes}`, 56, y + 4, { width: 500, lineBreak: false });
        y += 16;
      }
      } // end skipPreRoll guard

      y += 8;

      // POST-ROLL section
      doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text('POST-ROLL MEASUREMENTS', 50, y);
      y += 14;

      // Out-of-round per ASME UG-80 (recomputed live for consistency with current rule)
      const nominalD = po.nominalDiameter || specDiameter(part);
      const oor = evalOutOfRound(po, nominalD);
      const hasDiam = !!(po.diamSeam || po.diam90 || po.diam45 || po.diamNeg45);
      const nomStr = nominalD ? (Math.round(nominalD * 1000) / 1000) + '"' : null;
      const oorValue = !hasDiam ? '—'
        : oor.ratioPct != null
          ? `${oor.ratioPct.toFixed(2)}% of ${nomStr} Ø — ASME UG-80 limit 1.00%` + (oor.fail ? '  ⚠ EXCEEDS' : '  ✓ PASS')
          : `${oor.variance.toFixed(4)}" spread — no nominal Ø on file (limit 1/4")` + (oor.fail ? '  ⚠ EXCEEDS' : '  ✓ PASS');

      const postRows = [
        ['Circumference — End 1', fmtMeas(po.circumEnd1), null],
        ['Circumference — End 2', fmtMeas(po.circumEnd2), null],
        ['Diameter at Seam (0°)', fmtMeas(po.diamSeam), null],
        ['Diameter at 90°', fmtMeas(po.diam90), null],
        ['Diameter at 45°', fmtMeas(po.diam45), null],
        ['Diameter at -45°', fmtMeas(po.diamNeg45), null],
        ['Diameter Variance (max−min)', hasDiam ? oor.variance.toFixed(4) + '"' : '—', null],
        ['Out-of-Round (ASME UG-80)', oorValue, oor.fail ? 'FAIL' : null],
      ];

      postRows.forEach(([label, value, flag], idx) => {
        if (y > 700) { doc.addPage(); y = 50; }
        const rowBg = idx % 2 === 0 ? '#f8f9fa' : 'white';
        doc.rect(50, y, 512, 16).fill(rowBg).stroke();
        doc.font('Helvetica').fontSize(9).fillColor(grayColor).text(label, 56, y + 4, { width: 200, lineBreak: false });
        const valColor = flag === 'FAIL' ? failColor : flag === 'WARN' ? warnColor : darkColor;
        doc.font(flag ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(valColor).text(value, 260, y + 4, { width: 296, lineBreak: false });
        y += 16;
      });

      y += 20;
      doc.moveTo(50, y - 8).lineTo(562, y - 8).lineWidth(0.3).strokeColor(lightGray).stroke();
    }

    // ── CERTIFICATION FOOTER on last page ──
    y += 10;
    if (y > 680) { doc.addPage(); y = 50; }
    doc.moveTo(50, y).lineTo(562, y).lineWidth(1).strokeColor(primaryColor).stroke();
    y += 12;
    doc.font('Helvetica').fontSize(9).fillColor(grayColor)
      .text('This inspection report certifies that the measurements recorded above were taken by Carolina Rolling Co. Inc. personnel. All measurements are in inches. Tolerances applied: Out-of-Square ≤ 3/16"; Out-of-Round per ASME Section VIII Div. 1, UG-80(a)(1) — the difference between maximum and minimum diameters ≤ 1% of nominal diameter.', 50, y, { width: 512 });
    y += 32;
    doc.font('Helvetica').fontSize(9).fillColor(darkColor).text('Operator Signature: ___________________________', 50, y);
    doc.text(`Date: ${fmtDate(new Date())}`, 350, y);
    if (operatorSig) {
      try {
        const sigBuf = Buffer.from(operatorSig.split(',')[1], 'base64');
        doc.image(sigBuf, 158, y - 26, { fit: [168, 26] });
      } catch (e) {}
    }

    // Footer on every page: IR number (left) + page number (right).
    // margins.bottom=0 while stamping prevents PDFKit from auto-inserting a blank page.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const footerY = doc.page.height - 35;
      doc.font('Helvetica').fontSize(8).fillColor('#999');
      doc.text(irNumber, 50, footerY, { lineBreak: false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, 50, footerY, { width: 512, align: 'right', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }

    doc.end();
    await endPromise;
    const buffer = Buffer.concat(chunks);
    const drLabel = wo?.drNumber ? 'DR-' + wo.drNumber : wo?.orderNumber || job.id.slice(0,8);
    return { buffer, drLabel, irNumber };
}

// GET /api/inspections/job/:id/report-pdf — generate inspection report PDF
router.get('/job/:id/report-pdf', async (req, res, next) => {
  try {
    const { buffer, drLabel, irNumber } = await generateInspectionReportBuffer(req.params.id);
    // Also file it under the work order's documents (best-effort — never blocks the view)
    try { await saveInspectionReportDocument(req.params.id, { buffer, irNumber }); }
    catch (e) { console.error('[InspectionReport] save-on-view failed:', e.message); }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Inspection-Report-${drLabel}.pdf"`);
    res.send(buffer);
  } catch(error) { next(error); }
});

// Generate the inspection report and save it to the work order's documents, named the IR number.
// Replaces any prior copy with the same IR name so re-completion refreshes it.
async function saveInspectionReportDocument(jobId, pre) {
  const fileStorage = require('../utils/storage');
  const job = await InspectionJob.findByPk(jobId, { attributes: ['id', 'workOrderId'] });
  if (!job) return;
  const { buffer, irNumber } = pre || await generateInspectionReportBuffer(jobId);
  const filename = `${irNumber || 'Inspection-Report'}.pdf`.replace(/[\/\\:]/g, '-');
  const existing = await WorkOrderDocument.findOne({ where: { workOrderId: job.workOrderId, originalName: filename } });
  if (existing) {
    if (existing.cloudinaryId) { try { await fileStorage.deleteFile(existing.cloudinaryId); } catch (e) {} }
    await existing.destroy();
  }
  const uploadResult = await fileStorage.uploadBuffer(buffer, { folder: 'work-orders/' + job.workOrderId + '/documents', filename, mimeType: 'application/pdf' });
  await WorkOrderDocument.create({
    workOrderId: job.workOrderId, originalName: filename, mimeType: 'application/pdf',
    size: buffer.length, url: uploadResult.url, cloudinaryId: uploadResult.storageId,
    documentType: 'inspection_report', portalVisible: true
  });
  console.log('[InspectionReport] Saved ' + filename);
}

// GET /api/inspections/unit/:id/label-pdf — print label for one cylinder
router.get('/unit/:id/label-pdf', async (req, res, next) => {
  try {
    const unit = await InspectionUnit.findByPk(req.params.id, {
      include: [{ model: InspectionJob, as: undefined,
        include: [
          { model: WorkOrder, foreignKey: 'workOrderId', attributes: ['drNumber','orderNumber','clientPurchaseOrderNumber'] },
          { model: WorkOrderPart, foreignKey: 'workOrderPartId', attributes: ['clientPartNumber','heatNumber','materialDescription','formData'] }
        ]
      }]
    });
    if (!unit) return res.status(404).json({ error: { message: 'Unit not found' } });

    // Fetch job and related data separately (simpler)
    const job = await InspectionJob.findByPk(unit.inspectionJobId);
    const wo = await WorkOrder.findByPk(job.workOrderId, { attributes: ['drNumber','orderNumber','clientPurchaseOrderNumber'] });
    const part = await WorkOrderPart.findByPk(job.workOrderPartId, { attributes: ['clientPartNumber','heatNumber','materialDescription','formData'] });

    const pr = unit.preRoll || {};
    const grade = pr.grade || (part?.formData?._grade) || '—';
    const heatNum = part?.heatNumber || pr.heatNumber || '—';
    const clientPO = wo?.clientPurchaseOrderNumber || '—';
    const clientPartNum = part?.clientPartNumber || '—';

    // 4" x 2" label (288 x 144 points)
    const doc = new PDFDocument({ size: [288, 144], margin: 8 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const endPromise = new Promise(r => doc.on('end', r));

    // Company name bar
    doc.rect(0, 0, 288, 18).fill('#1565c0').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('white')
      .text('CAROLINA ROLLING CO. INC.', 0, 4, { width: 288, align: 'center', lineBreak: false });

    // Cylinder ID — large and prominent
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#1a1a1a')
      .text(unit.unitId, 8, 22, { lineBreak: false });

    // Details grid
    const rows = [
      ['PO:', clientPO],
      ['Part:', clientPartNum],
      ['Grade:', grade],
      ['Heat #:', heatNum],
    ];
    let ly = 52;
    rows.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#555').text(label, 8, ly, { width: 36, lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor('#1a1a1a').text(value, 46, ly, { width: 234, lineBreak: false });
      ly += 10;
    });

    // Bottom border line
    doc.moveTo(8, 136).lineTo(280, 136).lineWidth(0.5).strokeColor('#ccc').stroke();
    doc.font('Helvetica').fontSize(6).fillColor('#999')
      .text('carolinarolling.com', 8, 138, { lineBreak: false });

    doc.end();
    await endPromise;
    const buffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Label-${unit.unitId}.pdf"`);
    res.send(buffer);
  } catch(error) { next(error); }
});

module.exports = router;
