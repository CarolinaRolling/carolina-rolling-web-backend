const { getParsingModel } = require('./aiConfig');
/**
 * Ginger — daily scheduling / priority scan.
 *
 * Looks across active work orders and flags what's at risk of missing its promised
 * date (overdue, due soon, not enough shop time left for the remaining labor, or
 * material still not in). Produces a ranked list of findings, optionally re-voiced
 * by the AI in Ginger's no-nonsense tone, and stores them in AppSettings under
 * the key `ginger_findings` for the floating Ginger icon to read.
 *
 * The risk detection is fully deterministic (math) so it works with or without the
 * AI. The AI layer only rewrites the wording; if it's unavailable we fall back to
 * built-in lines.
 */

const { Op } = require('sequelize');
const { WorkOrder, WorkOrderPart, AppSettings } = require('../models');

// --- Tunables (could be moved to AppSettings later) ---
const DUE_SOON_DAYS = 3;          // promised within this many days = "due soon"
const MATERIAL_WARN_DAYS = 7;     // warn about missing material when due within this window
const DAILY_LABOR_CAPACITY = 16;  // rough shop labor-hours available per working day
const FINDINGS_KEY = 'ginger_findings';

// Statuses we consider "done" and therefore don't nag about
const DONE_STATUSES = ['completed', 'stored', 'shipped', 'archived'];

const SEVERITY_RANK = { overdue: 3, capacity: 2, material: 2, due_soon: 1 };

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(fromDate, toDate) {
  const ms = toDate.getTime() - fromDate.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Rough count of working days (Mon–Fri) between today and a target date
function workingDaysUntil(target) {
  const today = startOfToday();
  let count = 0;
  const cursor = new Date(today);
  while (cursor < target) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function dr(wo) {
  return wo.drNumber || wo.orderNumber || (wo.id ? wo.id.slice(0, 8) : '???');
}

// Build a single consolidated finding per work order (or null if nothing's wrong)
function evaluateWorkOrder(wo) {
  const reasons = [];
  let severity = null;
  const bump = (s) => {
    if (!severity || SEVERITY_RANK[s] > SEVERITY_RANK[severity]) severity = s;
  };

  const today = startOfToday();
  const promised = wo.promisedDate ? new Date(wo.promisedDate) : null;
  if (promised) promised.setHours(0, 0, 0, 0);
  const daysUntil = promised ? daysBetween(today, promised) : null;

  // Remaining labor on parts not yet completed
  const parts = wo.parts || [];
  let remainingHours = 0;
  let haveHours = false;
  for (const p of parts) {
    if (p.status !== 'completed') {
      const h = parseFloat(p.laborHours);
      if (!isNaN(h)) { remainingHours += h; haveHours = true; }
    }
  }

  // Material is "in" once the order is marked all-received OR has advanced past
  // waiting-for-materials in its lifecycle. The per-part materialReceived flags were
  // noisy — customer-supplied / shop-stock parts stay false even when nothing is on
  // order — so we trust the order-level state and the receiving status instead.
  let materialOutstanding;
  if (wo.allMaterialReceived === true) {
    materialOutstanding = false;
  } else if (wo.status === 'waiting_for_materials') {
    materialOutstanding = true;
  } else if (wo.status && wo.status !== 'waiting_for_materials') {
    materialOutstanding = false; // received / processing / etc. — material is in
  } else {
    materialOutstanding = wo.allMaterialReceived === false;
  }

  // 1) Overdue
  if (daysUntil !== null && daysUntil < 0) {
    bump('overdue');
    reasons.push({ kind: 'overdue', daysUntil });
  } else if (daysUntil !== null && daysUntil <= DUE_SOON_DAYS) {
    // 2) Due soon
    bump('due_soon');
    reasons.push({ kind: 'due_soon', daysUntil });
  }

  // 3) Capacity — can the remaining work physically fit before it's due?
  if (haveHours && remainingHours > 0 && daysUntil !== null && daysUntil >= 0) {
    const wd = Math.max(workingDaysUntil(promised), 0);
    const capacityHours = wd * DAILY_LABOR_CAPACITY;
    if (remainingHours > capacityHours) {
      bump('capacity');
      reasons.push({ kind: 'capacity', remainingHours: Math.round(remainingHours), capacityHours, workingDays: wd });
    }
  }

  // 4) Material not in while the clock is running
  if (materialOutstanding && daysUntil !== null && daysUntil <= MATERIAL_WARN_DAYS) {
    bump('material');
    reasons.push({ kind: 'material', daysUntil });
  }

  if (!severity) return null;

  return {
    workOrderId: wo.id,
    drNumber: dr(wo),
    clientName: wo.clientName || 'Unknown client',
    status: wo.status,
    promisedDate: wo.promisedDate || null,
    daysUntil,
    severity,
    reasons,
    gingerSays: defaultLine(wo, severity, reasons, daysUntil),
  };
}

// Built-in Ginger voice (fallback when AI is unavailable)
function defaultLine(wo, severity, reasons, daysUntil) {
  const id = `DR ${dr(wo)} (${wo.clientName || 'client'})`;
  if (severity === 'overdue') {
    const late = Math.abs(daysUntil);
    return `${id} is PAST DUE — it should've shipped ${late} day${late === 1 ? '' : 's'} ago. Deal with it before I do.`;
  }
  if (severity === 'capacity') {
    const r = reasons.find(x => x.kind === 'capacity');
    return `${id}: ${r.remainingHours}h of work left and only about ${r.capacityHours}h of shop time before it's due. Start it now or it slips.`;
  }
  if (severity === 'material') {
    return `${id} is due soon and the material still isn't all in. Chase it today, not tomorrow.`;
  }
  // due_soon
  return `${id} is due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}. Don't let it sneak up on you.`;
}

// Optional: re-voice the findings through the AI in Ginger's tone.
async function enhanceWithAI(findings) {
  if (!process.env.ANTHROPIC_API_KEY || findings.length === 0) return findings;
  try {
    const compact = findings.map((f, i) => ({
      i,
      dr: f.drNumber,
      client: f.clientName,
      severity: f.severity,
      daysUntil: f.daysUntil,
      reasons: f.reasons.map(r => r.kind),
    }));
    const body = JSON.stringify({
      model: getParsingModel(),
      max_tokens: 1200,
      system: `You are "Ginger", the no-nonsense office manager of Carolina Rolling Company — a bossy but caring golden retriever who makes sure deadlines don't get missed. You are blunt, a little sassy, and protective of the shop. Given a JSON array of at-risk work orders, write ONE short punchy line for each (max ~22 words) telling the boss what to do about it. Reference the DR number and client. Reply with ONLY a JSON array of objects: [{"i": <index>, "line": "<your line>"}]. No markdown, no extra text.`,
      messages: [{ role: 'user', content: JSON.stringify(compact) }],
    });
    const https = require('https');
    const responseText = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => res.statusCode === 200 ? resolve(data) : reject(new Error(`API ${res.statusCode}`)));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('timeout')));
      req.write(body);
      req.end();
    });
    const data = JSON.parse(responseText);
    const text = (data.content?.[0]?.text || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const lines = JSON.parse(text);
    for (const item of lines) {
      if (findings[item.i] && item.line) findings[item.i].gingerSays = item.line;
    }
  } catch (err) {
    console.warn('[Ginger] AI voicing failed, using default lines:', err.message);
  }
  return findings;
}

// Main entry — run the scan and persist findings. Returns the stored blob.
async function runGingerScan({ useAI = true } = {}) {
  const workOrders = await WorkOrder.findAll({
    where: {
      status: { [Op.notIn]: DONE_STATUSES },
      isVoided: { [Op.not]: true },
    },
    include: [{ model: WorkOrderPart, as: 'parts', attributes: ['laborHours', 'status', 'materialReceived', 'quantity'] }],
  });

  let findings = [];
  for (const wo of workOrders) {
    const f = evaluateWorkOrder(wo);
    if (f) findings.push(f);
  }

  // Rank: severity desc, then soonest promised date first
  findings.sort((a, b) => {
    const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (s !== 0) return s;
    const ad = a.daysUntil === null ? Infinity : a.daysUntil;
    const bd = b.daysUntil === null ? Infinity : b.daysUntil;
    return ad - bd;
  });

  if (useAI) findings = await enhanceWithAI(findings);

  const counts = {
    overdue: findings.filter(f => f.severity === 'overdue').length,
    capacity: findings.filter(f => f.severity === 'capacity').length,
    material: findings.filter(f => f.severity === 'material').length,
    due_soon: findings.filter(f => f.severity === 'due_soon').length,
  };

  const blob = {
    generatedAt: new Date().toISOString(),
    // A fresh scan with findings is unread (alert icon). No findings = nothing to read.
    read: findings.length === 0,
    readAt: null,
    readBy: null,
    counts,
    total: findings.length,
    findings,
  };

  await AppSettings.upsert({ key: FINDINGS_KEY, value: blob });
  console.log(`[Ginger] Scan complete: ${findings.length} finding(s) — overdue:${counts.overdue} capacity:${counts.capacity} material:${counts.material} dueSoon:${counts.due_soon}`);
  return blob;
}

async function getFindings() {
  const row = await AppSettings.findOne({ where: { key: FINDINGS_KEY } });
  return row ? row.value : null;
}

async function markRead(username) {
  const row = await AppSettings.findOne({ where: { key: FINDINGS_KEY } });
  if (!row) return null;
  const blob = { ...row.value, read: true, readAt: new Date().toISOString(), readBy: username || null };
  await AppSettings.upsert({ key: FINDINGS_KEY, value: blob });
  return blob;
}

module.exports = { runGingerScan, getFindings, markRead, FINDINGS_KEY };
