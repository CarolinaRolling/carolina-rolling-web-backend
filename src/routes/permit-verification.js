const express = require('express');
const router = express.Router();
const { Client } = require('../models');
const { verifySinglePermit, verifyBatch, debugChromeInfo } = require('../services/permitVerification');

// In-memory batch job tracking
let batchJob = null;

// GET /api/verify-permits/debug — Show Chrome detection info
router.get('/verify-permits/debug', async (req, res) => {
  try {
    const info = debugChromeInfo();
    res.json({ data: info });
  } catch (err) {
    res.json({ data: { error: err.message } });
  }
});

// POST /api/verify-permit — Verify a single permit number
router.post('/verify-permit', async (req, res, next) => {
  try {
    const { clientId, permitNumber } = req.body;

    if (!permitNumber) {
      return res.status(400).json({ error: { message: 'Permit number is required' } });
    }

    // Clean up the permit number (ensure dash format)
    let cleanPermit = permitNumber.replace(/[^0-9-]/g, '').trim();
    if (!cleanPermit) {
      return res.status(400).json({ error: { message: 'Invalid permit number format' } });
    }

    // Auto-insert dash if user entered 9 straight digits
    if (/^\d{9}$/.test(cleanPermit)) {
      cleanPermit = cleanPermit.slice(0, 3) + '-' + cleanPermit.slice(3);
    }

    // Validate format: 999-999999
    if (!/^\d{3}-\d{6}$/.test(cleanPermit)) {
      return res.status(400).json({ error: { message: 'Permit number must be 9 digits in format: 123-456789' } });
    }

    console.log(`[Permit] Single verification requested: ${cleanPermit} (client: ${clientId || 'none'})`);

    const result = await verifySinglePermit(cleanPermit);

    // If clientId provided, update the client record
    if (clientId) {
      try {
        const client = await Client.findByPk(clientId);
        if (client) {
          const updateData = {
            permitStatus: result.status,
            permitLastVerified: new Date(),
            permitRawResponse: result.rawResponse,
            permitOwnerName: result.ownerName || null,
                permitDbaName: result.dbaName || null
          };
          // Auto-set taxStatus to resale when permit is verified active
          if (result.status === 'active') {
            updateData.taxStatus = 'resale';
          }
          await client.update(updateData);
          console.log(`[Permit] Updated client ${clientId} status: ${result.status}`);
        }
      } catch (dbErr) {
        console.error('[Permit] Failed to update client record:', dbErr.message);
      }
    }

    res.json({
      data: { ...result, rawFields: result.rawFields || {}, labelMap: result.labelMap || {} },
      message: `Permit verification complete: ${result.status}`
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/verify-permits/batch — Start batch verification
router.post('/verify-permits/batch', async (req, res, next) => {
  try {
    // Check if a batch is already running
    if (batchJob && batchJob.status === 'running') {
      return res.status(409).json({
        error: { message: 'A batch verification is already in progress' },
        data: { ...batchJob, results: undefined } // Don't send full results array
      });
    }

    // Get all clients with resale certificates
    const clients = await Client.findAll({
      where: {
        isActive: true
      },
      attributes: ['id', 'name', 'resaleCertificate', 'permitStatus', 'permitLastVerified'],
      order: [['name', 'ASC']]
    });

    // Filter to only clients with resale certificates
    const clientsWithPermits = clients.filter(c => c.resaleCertificate && c.resaleCertificate.trim());

    if (clientsWithPermits.length === 0) {
      return res.json({
        data: { status: 'complete', total: 0, completed: 0, results: [] },
        message: 'No clients with resale certificates to verify'
      });
    }

    // Initialize batch job
    batchJob = {
      status: 'running',
      total: clientsWithPermits.length,
      completed: 0,
      startedAt: new Date().toISOString(),
      results: []
    };

    // Start batch in background (don't await)
    const permits = clientsWithPermits.map(c => ({
      id: c.id,
      permitNumber: c.resaleCertificate.trim(),
      clientName: c.name
    }));

    // Run in background
    (async () => {
      try {
        await verifyBatch(permits, async (result, current, total) => {
          // Update client in DB
          try {
            const client = await Client.findByPk(result.clientId);
            if (client) {
              const batchUpdateData = {
                permitStatus: result.status,
                permitLastVerified: new Date(),
                permitRawResponse: result.rawResponse,
                permitOwnerName: result.ownerName || null,
                permitDbaName: result.dbaName || null
              };
              if (result.status === 'active') {
                batchUpdateData.taxStatus = 'resale';
              }
              await client.update(batchUpdateData);
            }
          } catch (dbErr) {
            console.error(`[Batch] DB update failed for client ${result.clientId}:`, dbErr.message);
          }

          // Update batch job tracking
          const clientInfo = permits.find(p => p.id === result.clientId);
          batchJob.completed = current;
          batchJob.results.push({
            clientId: result.clientId,
            clientName: clientInfo ? clientInfo.clientName : 'Unknown',
            permitNumber: result.permitNumber,
            status: result.status,
            rawResponse: result.rawResponse,
            error: result.error
          });
        });

        batchJob.status = 'complete';
        batchJob.completedAt = new Date().toISOString();
        console.log(`[Batch] Batch verification complete: ${batchJob.completed}/${batchJob.total}`);
      } catch (err) {
        batchJob.status = 'error';
        batchJob.error = err.message;
        console.error('[Batch] Batch verification failed:', err.message);
      }
    })();

    res.json({
      data: {
        status: 'started',
        total: clientsWithPermits.length,
        estimatedMinutes: clientsWithPermits.length // ~1 min each
      },
      message: `Batch verification started for ${clientsWithPermits.length} clients. Estimated time: ~${clientsWithPermits.length} minutes.`
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/verify-permits/batch/status — Check batch progress
router.get('/verify-permits/batch/status', async (req, res) => {
  if (!batchJob) {
    return res.json({
      data: { status: 'idle', total: 0, completed: 0, results: [] },
      message: 'No batch verification has been run'
    });
  }

  res.json({
    data: {
      status: batchJob.status,
      total: batchJob.total,
      completed: batchJob.completed,
      startedAt: batchJob.startedAt,
      completedAt: batchJob.completedAt || null,
      error: batchJob.error || null,
      results: batchJob.results
    }
  });
});

// POST /api/verify-permits/batch/cancel — Cancel running batch
router.post('/verify-permits/batch/cancel', async (req, res) => {
  if (batchJob && batchJob.status === 'running') {
    batchJob.status = 'cancelled';
    batchJob.completedAt = new Date().toISOString();
    res.json({ message: 'Batch cancellation requested' });
  } else {
    res.json({ message: 'No batch running to cancel' });
  }
});

// GET /api/verify-permits/report-pdf — Generate PDF report of all client resale verification statuses
router.get('/verify-permits/report-pdf', async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const { Op } = require('sequelize');

    // Get all active clients with resale certificates
    const clients = await Client.findAll({
      where: {
        isActive: true,
        resaleCertificate: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] }
      },
      order: [['name', 'ASC']]
    });

    const doc = new PDFDocument({ margin: 50, size: 'LETTER', bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Resale_Verification_Report_${new Date().toISOString().slice(0, 10)}.pdf"`,
        'Content-Length': pdfBuffer.length
      });
      res.send(pdfBuffer);
    });

    const TZ = 'America/Los_Angeles';
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ });

    // ── HEADER ──
    doc.fontSize(18).font('Helvetica-Bold').text('Resale Certificate Verification Report', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#666').text(`Generated: ${today}`, { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Carolina Rolling Company — ${clients.length} clients with resale certificates on file`, { align: 'center' });
    doc.moveDown(0.8);

    // ── SUMMARY STATS ──
    const active = clients.filter(c => c.permitStatus === 'Active' || c.permitStatus === 'active').length;
    const closed = clients.filter(c => c.permitStatus === 'Closed' || c.permitStatus === 'closed').length;
    const neverVerified = clients.filter(c => !c.permitLastVerified).length;
    const errors = clients.filter(c => c.permitStatus && !['Active', 'active', 'Closed', 'closed'].includes(c.permitStatus) && c.permitLastVerified).length;
    const warnings = [];
    clients.forEach(c => {
      if (c.permitStatus && ['Closed', 'closed', 'not_found'].includes(c.permitStatus)) warnings.push(c);
      else if (c.permitOwnerName || c.permitDbaName) {
        const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const cName = clean(c.name);
        const oName = clean(c.permitOwnerName);
        const dName = clean(c.permitDbaName);
        if (cName && (oName || dName) && !(oName && (oName.includes(cName) || cName.includes(oName))) && !(dName && (dName.includes(cName) || cName.includes(dName)))) {
          warnings.push(c);
        }
      }
    });

    const sumY = doc.y;
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text(`Active: ${active}`, 50, sumY, { continued: true });
    doc.text(`    Closed: ${closed}`, { continued: true });
    doc.text(`    Not Verified: ${neverVerified}`, { continued: true });
    doc.text(`    Errors/Other: ${errors}`, { continued: true });
    doc.text(`    Warnings: ${warnings.length}`);
    doc.moveDown(0.6);

    // ── TABLE ──
    const startX = 50;
    const colWidths = { name: 120, permit: 78, status: 56, verified: 72, owner: 96, warnings: 90 };
    const totalW = Object.values(colWidths).reduce((a, b) => a + b, 0); // = 512
    const rowH = 20;
    const headerH = 22;

    const drawTableHeader = () => {
      const y = doc.y;
      doc.rect(startX, y, totalW, headerH).fill('#1565c0');
      doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
      let x = startX;
      const headers = [
        ['Client Name', colWidths.name],
        ['Permit #', colWidths.permit],
        ['Status', colWidths.status],
        ['Verified', colWidths.verified],
        ['CDTFA Owner', colWidths.owner],
        ['Warnings', colWidths.warnings]
      ];
      headers.forEach(([text, w]) => {
        doc.text(text, x + 4, y + 6, { width: w - 8 });
        x += w;
      });
      doc.fillColor('#000');
      doc.y = y + headerH;
    };

    drawTableHeader();

    clients.forEach((client, idx) => {
      // Check if we need a new page
      if (doc.y + rowH + 10 > doc.page.height - 60) {
        doc.addPage();
        drawTableHeader();
      }

      const y = doc.y;
      const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8f8f8';
      doc.rect(startX, y, totalW, rowH).fill(bgColor);

      doc.fillColor('#333').fontSize(7.5).font('Helvetica');
      let x = startX;

      // Name
      doc.font('Helvetica-Bold').text(client.name || '—', x + 4, y + 5, { width: colWidths.name - 8, lineBreak: false });
      x += colWidths.name;

      // Permit #
      doc.font('Helvetica').text(client.resaleCertificate || '—', x + 4, y + 5, { width: colWidths.permit - 8, lineBreak: false });
      x += colWidths.permit;

      // Status
      const status = client.permitStatus || 'Not Verified';
      const statusNorm = status.toLowerCase();
      if (statusNorm === 'active') {
        doc.fillColor('#2e7d32').font('Helvetica-Bold').text('✓ Active', x + 4, y + 5, { width: colWidths.status - 8 });
      } else if (statusNorm === 'closed') {
        doc.fillColor('#c62828').font('Helvetica-Bold').text('✗ Closed', x + 4, y + 5, { width: colWidths.status - 8 });
      } else if (statusNorm === 'not_found') {
        doc.fillColor('#c62828').font('Helvetica-Bold').text('✗ Not Found', x + 4, y + 5, { width: colWidths.status - 8 });
      } else if (client.permitLastVerified) {
        doc.fillColor('#e65100').font('Helvetica').text(status, x + 4, y + 5, { width: colWidths.status - 8, lineBreak: false });
      } else {
        doc.fillColor('#999').font('Helvetica').text('—', x + 4, y + 5, { width: colWidths.status - 8 });
      }
      x += colWidths.status;

      // Date verified
      doc.fillColor('#333').font('Helvetica');
      if (client.permitLastVerified) {
        doc.text(new Date(client.permitLastVerified).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ }), x + 4, y + 5, { width: colWidths.verified - 8, lineBreak: false });
      } else {
        doc.fillColor('#999').text('Never', x + 4, y + 5, { width: colWidths.verified - 8 });
      }
      x += colWidths.verified;

      // CDTFA Owner
      doc.fillColor('#333').font('Helvetica');
      const ownerText = client.permitOwnerName || client.permitDbaName || '—';
      doc.text(ownerText, x + 4, y + 5, { width: colWidths.owner - 8, lineBreak: false });
      x += colWidths.owner;

      // Warnings
      const warningTexts = [];
      if (statusNorm === 'closed') warningTexts.push('CLOSED PERMIT');
      if (statusNorm === 'not_found') warningTexts.push('PERMIT NOT FOUND');
      if (!client.permitLastVerified) warningTexts.push('Never verified');

      // Name mismatch check
      if (client.permitOwnerName || client.permitDbaName) {
        const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const cName = clean(client.name);
        const oName = clean(client.permitOwnerName);
        const dName = clean(client.permitDbaName);
        if (cName && (oName || dName)) {
          const matchesOwner = oName && (oName.includes(cName) || cName.includes(oName));
          const matchesDba = dName && (dName.includes(cName) || cName.includes(dName));
          if (!matchesOwner && !matchesDba) warningTexts.push('Name mismatch');
        }
      }

      // Stale verification (> 1 year)
      if (client.permitLastVerified) {
        const daysSince = (Date.now() - new Date(client.permitLastVerified).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > 365) warningTexts.push('Stale (>1yr)');
      }

      if (warningTexts.length > 0) {
        doc.fillColor('#c62828').font('Helvetica-Bold').text(warningTexts.join(', '), x + 4, y + 5, { width: colWidths.warnings - 8, lineBreak: false });
      } else {
        doc.fillColor('#2e7d32').font('Helvetica').text('OK', x + 4, y + 5, { width: colWidths.warnings - 8 });
      }

      doc.fillColor('#333');
      doc.y = y + rowH;
    });

    // Draw bottom border
    doc.moveTo(startX, doc.y).lineTo(startX + totalW, doc.y).lineWidth(0.5).strokeColor('#ccc').stroke();

    // ── FOOTER NOTE ──
    doc.moveDown(1);
    doc.fontSize(8).font('Helvetica').fillColor('#888');
    doc.text('This report reflects the most recent verification data on record. Permit status is checked against the California Department of Tax and Fee Administration (CDTFA) database.', 50, doc.y, { width: totalW, align: 'center' });
    doc.moveDown(0.3);
    doc.text('Clients with warnings should be reviewed. A "Name mismatch" warning means the CDTFA registered name does not match the client name in the system.', 50, doc.y, { width: totalW, align: 'center' });

    // Page numbers
    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor('#aaa').text(
        `Page ${i + 1} of ${pages.count}`,
        50, doc.page.height - 40, { width: totalW, align: 'center' }
      );
    }

    doc.end();
  } catch (error) {
    console.error('Resale report PDF error:', error);
    next(error);
  }
});

module.exports = router;
