// Price recommendation from historical WON jobs.
//
// Design notes (important — see shop-knowledge-notes.txt):
//  * We ONLY learn from quotes that were actually WON (accepted/converted). The shop does not mark
//    losses, and jobs often come back 6-12 months later, so "no response" is NOT a loss. Any
//    win-rate / loss-based model would be built on a lie.
//  * Won jobs are real receipts: someone paid that price. That's the only ground truth we have.
//  * We lead with the PROVEN HIGH end of the range, not the median — the owner believes he is
//    underpriced, and the high end is a price he has already demonstrably won at.
//  * This is deliberately plain statistics, not an LLM. It's more accurate and it's explainable.

const { Estimate, EstimatePart, Client } = require('../models');
const { Op } = require('sequelize');

const WON_STATUSES = ['accepted', 'converted'];

// Parse "3/8", "0.375", "1-1/2", '36"' -> number
function parseNum(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return s;
  let str = String(s).replace(/["″]|in\.?|inch(es)?/gi, ' ').trim();
  let m = str.match(/(\d+)[\s-]+(\d+)\s*\/\s*(\d+)/);
  if (m) return parseInt(m[1]) + parseInt(m[2]) / parseInt(m[3]);
  m = str.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return parseInt(m[1]) / parseInt(m[2]);
  m = str.match(/(\d*\.?\d+)/);
  if (m) return parseFloat(m[1]);
  return null;
}

// Group materials so A36 and A572 (both carbon) can inform each other, but never stainless.
function materialFamily(s) {
  const v = String(s || '').toLowerCase();
  if (/s\s*\/\s*s|stainless|\b3[0-4][0-9]\b/.test(v)) return 'stainless';
  if (/alum|6061|5052|5083|3003|6063/.test(v)) return 'aluminum';
  if (/a36|a572|a516|carbon|hr|crs|\ba\d{3}\b/.test(v)) return 'carbon';
  return v ? 'other' : 'unknown';
}

// Width bands for plate rolling. Width is the DOMINANT cost driver — it's a machine-capacity
// cliff, not a smooth curve. The roller maxes at 120"; 120-124" only sometimes clears and is
// very expensive. Comparables must come from the SAME band or the price is meaningless.
const WIDTH_BANDS = [
  { max: 24, label: '0–24"' },
  { max: 60, label: '24–60"' },
  { max: 96, label: '60–96"' },
  { max: 120, label: '96–120"' },
  { max: Infinity, label: 'over 120" (needs machine clearance — special pricing)' }
];
function widthBand(w) {
  const v = parseFloat(w) || 0;
  if (!v) return null;
  for (let i = 0; i < WIDTH_BANDS.length; i++) {
    if (v <= WIDTH_BANDS[i].max) return i;
  }
  return WIDTH_BANDS.length - 1;
}

// Crane capacity — a hard physical limit. If a piece is heavier than this you can't lift it,
// so it doesn't matter what it's priced at.
const CRANE_CAPACITY_LBS = parseFloat(process.env.CRANE_CAPACITY_LBS) || 10000;

// lb per cubic inch
const DENSITY = { carbon: 0.2836, stainless: 0.289, aluminum: 0.098, other: 0.2836, unknown: 0.2836 };

// Estimated weight of ONE piece of flat plate before rolling (what the crane actually lifts).
function estimateWeightLbs({ thickness, width, length, material }) {
  const t = parseNum(thickness), w = parseNum(width), l = parseNum(length);
  if (!t || !w || !l) return null;
  const d = DENSITY[materialFamily(material)] ?? DENSITY.carbon;
  return t * w * l * d;
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const percentile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
};

/**
 * Find comparable WON parts and suggest a price.
 * target: { partType, material, thickness, diameter, quantity, clientName }
 */
async function suggestPrice(target, opts = {}) {
  const upliftPct = parseFloat(opts.newClientUpliftPct) || 0;

  const tThk = parseNum(target.thickness);
  const tDia = parseNum(target.diameter || target.innerDiameter || target.outerDiameter);
  const tFam = materialFamily(target.material);
  const tWidth = parseNum(target.width);
  const tBand = widthBand(tWidth);
  const estWeight = estimateWeightLbs(target);
  const overCrane = estWeight != null && estWeight > CRANE_CAPACITY_LBS;

  // Pull won parts of the same type
  const rows = await EstimatePart.findAll({
    where: { partType: target.partType },
    include: [{
      model: Estimate,
      as: 'estimate',
      required: true,
      where: { status: { [Op.in]: WON_STATUSES }, trashedAt: null },
      attributes: ['id', 'status', 'clientName', 'createdAt', 'acceptedAt']
    }],
    limit: 4000
  });

  const now = Date.now();
  const candidates = [];
  for (const p of rows) {
    const labor = parseFloat(p.laborTotal);
    if (!labor || labor <= 0) continue;
    const thk = parseNum(p.thickness);
    const dia = parseNum(p.diameter || p.innerDiameter);
    const fam = materialFamily(p.material);
    const band = widthBand(parseNum(p.width));

    // Score similarity. Lower = closer. Reject clearly different jobs.
    let score = 0;
    if (tFam !== 'unknown' && fam !== 'unknown') {
      if (fam !== tFam) continue;             // never mix carbon / stainless / aluminum
    }
    // HARD REQUIREMENT: same width band. A 12" ring and a 118" ring are different jobs
    // on different machines at wildly different prices — averaging them is meaningless.
    if (tBand !== null && band !== null && band !== tBand) continue;
    if (tThk && thk) {
      const rel = Math.abs(thk - tThk) / tThk;
      if (rel > 0.5) continue;                 // >50% off in thickness isn't comparable
      score += rel * 2;
    }
    if (tDia && dia) {
      const rel = Math.abs(dia - tDia) / tDia;
      if (rel > 0.6) continue;
      score += rel;
    }
    // Prefer recent work — 2022 prices are not 2026 prices
    const ageDays = (now - new Date(p.estimate.createdAt).getTime()) / 86400000;
    score += Math.min(ageDays / 365, 3) * 0.15;

    candidates.push({
      labor,
      thickness: thk,
      diameter: dia,
      width: parseNum(p.width),
      material: p.material,
      clientName: p.estimate.clientName,
      when: p.estimate.createdAt,
      ageDays: Math.floor(ageDays),
      score
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  const top = candidates.slice(0, 25);
  const prices = top.map(c => c.labor);

  if (!prices.length) {
    return {
      found: 0,
      confidence: 'none',
      widthBand: tBand !== null ? WIDTH_BANDS[tBand].label : null,
      oversize: tBand === WIDTH_BANDS.length - 1,
      estWeightLbs: estWeight != null ? Math.round(estWeight) : null,
      craneCapacityLbs: CRANE_CAPACITY_LBS,
      overCrane,
      message: tBand !== null
        ? `No comparable won jobs yet at ${WIDTH_BANDS[tBand].label} width.`
        : 'No comparable won jobs yet for this configuration.'
    };
  }

  const med = median(prices);
  const high = percentile(prices, 90);   // proven high — you have actually won at this
  const low = Math.min(...prices);
  const max = Math.max(...prices);
  const recent = top.filter(c => c.ageDays <= 365).map(c => c.labor);
  const recentMed = recent.length ? median(recent) : null;

  // Lead with the proven-high end (owner is underpriced), floored at the recent median.
  let suggested = Math.max(high || 0, recentMed || 0, med || 0);

  // New-client uplift — the one clean lever: no price anchor with a brand-new client.
  let isNewClient = false;
  if (target.clientName && upliftPct > 0) {
    const priorWins = candidates.filter(c => c.clientName === target.clientName).length;
    const client = await Client.findOne({ where: { name: target.clientName } });
    const clientAgeDays = client?.createdAt ? (now - new Date(client.createdAt).getTime()) / 86400000 : 9999;
    isNewClient = priorWins === 0 || clientAgeDays < 180;
    if (isNewClient) suggested = suggested * (1 + upliftPct / 100);
  }

  const confidence = prices.length >= 8 ? 'good' : prices.length >= 3 ? 'fair' : 'thin';

  return {
    found: prices.length,
    confidence,
    widthBand: tBand !== null ? WIDTH_BANDS[tBand].label : null,
    oversize: tBand === WIDTH_BANDS.length - 1, // over 120" — needs clearance check, prices high
    estWeightLbs: estWeight != null ? Math.round(estWeight) : null,
    craneCapacityLbs: CRANE_CAPACITY_LBS,
    overCrane, // heavier than the crane can lift — a hard physical limit
    suggested: Math.round(suggested * 100) / 100,
    median: Math.round(med * 100) / 100,
    provenHigh: Math.round(max * 100) / 100,
    low: Math.round(low * 100) / 100,
    recentMedian: recentMed ? Math.round(recentMed * 100) / 100 : null,
    isNewClient,
    upliftPct: isNewClient ? upliftPct : 0,
    samples: top.slice(0, 6).map(c => ({
      labor: c.labor,
      material: c.material,
      thickness: c.thickness,
      width: c.width,
      diameter: c.diameter,
      client: c.clientName,
      ageDays: c.ageDays
    }))
  };
}

module.exports = { suggestPrice, materialFamily, parseNum };
