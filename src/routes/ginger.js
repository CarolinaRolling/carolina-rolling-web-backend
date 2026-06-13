const express = require('express');
const router = express.Router();
const { runGingerScan, getFindings, markRead } = require('../services/gingerScan');

// GET /api/ginger/findings — latest scan results + read state
router.get('/findings', async (req, res, next) => {
  try {
    const blob = await getFindings();
    // No scan has ever run yet — return an empty, "read" state so the icon stays calm
    res.json({ data: blob || { generatedAt: null, read: true, total: 0, counts: {}, findings: [] } });
  } catch (error) { next(error); }
});

// POST /api/ginger/findings/read — mark the current findings as read (calms the icon)
router.post('/findings/read', async (req, res, next) => {
  try {
    const username = req.user?.username || req.user?.name || null;
    const blob = await markRead(username);
    res.json({ data: blob });
  } catch (error) { next(error); }
});

// POST /api/ginger/scan — run the scan now (manual re-check)
router.post('/scan', async (req, res, next) => {
  try {
    const useAI = req.body?.useAI !== false;
    const blob = await runGingerScan({ useAI });
    res.json({ data: blob });
  } catch (error) { next(error); }
});

module.exports = router;
