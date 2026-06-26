const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { Op } = require('sequelize');
const PDFDocument = require('pdfkit');
const {
  InspectionJob, InspectionUnit, WorkOrder, WorkOrderPart, sequelize
} = require('../models');

// Helper: generate unit ID from WO context
// e.g. drNumber=58747, partLine=2, sequence=2 → "58747-2-3" (DR - line - piece index)
function makeUnitId(drNumber, partLine, sequence) {
  return `${drNumber}-${partLine}-${sequence + 1}`;
}

// Helper: calculate out-of-square (returns inches difference)
function calcOutOfSquare(diagA, diagB) {
  return Math.abs((parseFloat(diagA) || 0) - (parseFloat(diagB) || 0));
}

// Helper: calculate max diameter variance
function calcDiamVariance(seam, d45, dNeg45) {
  const vals = [parseFloat(seam)||0, parseFloat(d45)||0, parseFloat(dNeg45)||0].filter(v => v > 0);
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}

// GET /api/inspections/job/:workOrderId — get all inspection jobs for a WO
router.get('/job/:workOrderId', async (req, res, next) => {
  try {
    const jobs = await InspectionJob.findAll({
      where: { workOrderId: req.params.workOrderId },
      include: [{ model: InspectionUnit, as: 'units', order: [['sequence', 'ASC']] }],
      order: [['createdAt', 'ASC']]
    });
    res.json({ data: jobs });
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
        unitId: makeUnitId(drNum, part.partNumber, i),
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
      // Auto-calculate diameter tolerance
      const variance = calcDiamVariance(po.diamSeam, po.diam45, po.diamNeg45);
      po.outOfTolerance = variance > 0.125;
      po.diamVariance = Math.round(variance * 10000) / 10000;
      updates.postRoll = po;
      updates.postRollComplete = !!(
        po.circumEnd1 && po.circumEnd2 &&
        po.diamSeam && po.diam45 && po.diamNeg45
      );
    }

    if (req.body.clientNotes !== undefined) updates.clientNotes = req.body.clientNotes;
    if (req.body.labelPrinted !== undefined) updates.labelPrinted = req.body.labelPrinted;

    await unit.update(updates);

    // Update parent job status
    const job = await InspectionJob.findByPk(unit.inspectionJobId, {
      include: [{ model: InspectionUnit, as: 'units' }]
    });
    if (job) {
      const allUnits = job.units || [];
      const allComplete = allUnits.length > 0 && allUnits.every(u => (job.skipPreRoll || u.preRollComplete) && u.postRollComplete);
      const anyStarted = allUnits.some(u => u.preRollComplete || u.postRollComplete ||
        Object.keys(u.preRoll || {}).length > 0 || Object.keys(u.postRoll || {}).length > 0);
      const newStatus = allComplete ? 'complete' : anyStarted ? 'in_progress' : 'not_started';
      await job.update({
        status: newStatus,
        completedAt: allComplete ? new Date() : null
      });
    }

    const updated = await InspectionUnit.findByPk(unit.id);
    res.json({ data: updated });
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
    const sequence = (job.units?.length) || 0;

    const unit = await InspectionUnit.create({
      inspectionJobId: job.id,
      unitId: makeUnitId(drNum, part?.partNumber || 1, sequence),
      sequence,
    });

    await job.update({ unitCount: sequence + 1 });
    res.json({ data: unit });
  } catch(error) { next(error); }
});

// GET /api/inspections/job/:id/report-pdf — generate inspection report PDF
router.get('/job/:id/report-pdf', async (req, res, next) => {
  try {
    const job = await InspectionJob.findByPk(req.params.id, {
      include: [{ model: InspectionUnit, as: 'units', order: [['sequence', 'ASC']] }]
    });
    if (!job) return res.status(404).json({ error: { message: 'Job not found' } });

    const wo = await WorkOrder.findByPk(job.workOrderId, {
      attributes: ['id','drNumber','orderNumber','clientName','clientPurchaseOrderNumber','invoiceDate']
    });
    const part = await WorkOrderPart.findByPk(job.workOrderPartId, {
      attributes: ['id','partNumber','clientPartNumber','heatNumber','materialDescription','formData','quantity']
    });

    const doc = new PDFDocument({ margin: 50, size: 'letter' });
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
    const irNumber = `IR-${wo?.drNumber || wo?.orderNumber || ''}-${part?.partNumber ?? ''}`;
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
    doc.font('Helvetica-Bold').fontSize(10).text('PART #:', 300, y);
    doc.font('Helvetica').fontSize(10).text(part?.clientPartNumber || part?.partNumber || '—', 390, y);
    y += 16;
    const matDesc = part?.materialDescription || (part?.formData?._materialDescription) || '—';
    doc.font('Helvetica-Bold').fontSize(10).text('DESCRIPTION:', 50, y);
    doc.font('Helvetica').fontSize(10).text(matDesc, 140, y, { width:370 });
    y += 16;
    doc.font('Helvetica-Bold').fontSize(10).text('HEAT #:', 50, y);
    doc.font('Helvetica').fontSize(10).text(part?.heatNumber || '—', 120, y);
    doc.font('Helvetica-Bold').fontSize(10).text('OPERATOR:', 300, y);
    doc.font('Helvetica').fontSize(10).text(job.operatorName || '—', 390, y);
    y += 16;
    doc.font('Helvetica-Bold').fontSize(10).text('TOTAL UNITS:', 50, y);
    doc.font('Helvetica').fontSize(10).text(`${job.units?.length || 0} cylinders`, 140, y);

    doc.moveTo(50, y + 18).lineTo(562, y + 18).lineWidth(0.5).strokeColor(lightGray).stroke();
    y += 30;

    // ── UNITS ──
    for (const unit of (job.units || [])) {
      if (y > 660) { doc.addPage(); y = 50; }

      const pr = unit.preRoll || {};
      const po = unit.postRoll || {};

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
      if (y > 660) { doc.addPage(); y = 50; }
      doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text('POST-ROLL MEASUREMENTS', 50, y);
      y += 14;

      const postRows = [
        ['Circumference — End 1', fmtMeas(po.circumEnd1), null],
        ['Circumference — End 2', fmtMeas(po.circumEnd2), null],
        ['Diameter at Seam (0°)', fmtMeas(po.diamSeam), null],
        ['Diameter at 45°', fmtMeas(po.diam45), null],
        ['Diameter at -45°', fmtMeas(po.diamNeg45), null],
        ['Diameter Variance', po.diamVariance !== undefined ? fmtMeas(po.diamVariance) + (po.outOfTolerance ? ' ⚠ EXCEEDS ±1/8"' : ' ✓ PASS') : '—', po.outOfTolerance ? 'FAIL' : null],
      ];

      postRows.forEach(([label, value, flag], idx) => {
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
      .text('This inspection report certifies that the measurements recorded above were taken by Carolina Rolling Co. Inc. personnel. All measurements are in inches. Tolerances applied: Out-of-Square ≤ 3/16", Diameter variance ≤ ±1/8".', 50, y, { width: 512 });
    y += 32;
    doc.font('Helvetica').fontSize(9).fillColor(darkColor).text('Operator Signature: ___________________________', 50, y);
    doc.text(`Date: ${fmtDate(new Date())}`, 350, y);

    doc.end();
    await endPromise;
    const buffer = Buffer.concat(chunks);
    const drLabel = wo?.drNumber ? 'DR-' + wo.drNumber : wo?.orderNumber || job.id.slice(0,8);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Inspection-Report-${drLabel}.pdf"`);
    res.send(buffer);
  } catch(error) { next(error); }
});

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
