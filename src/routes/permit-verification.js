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
          await client.update({
            permitStatus: result.status,
            permitLastVerified: new Date(),
            permitRawResponse: result.rawResponse,
            permitOwnerName: result.ownerName || null
          });
          console.log(`[Permit] Updated client ${clientId} status: ${result.status}`);
        }
      } catch (dbErr) {
        console.error('[Permit] Failed to update client record:', dbErr.message);
      }
    }

    res.json({
      data: { ...result, rawFields: result.rawFields || {} },
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
              await client.update({
                permitStatus: result.status,
                permitLastVerified: new Date(),
                permitRawResponse: result.rawResponse,
                permitOwnerName: result.ownerName || null
              });
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

module.exports = router;
