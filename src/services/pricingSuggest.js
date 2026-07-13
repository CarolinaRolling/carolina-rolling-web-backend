// Price recommendation from historical WON jobs.
//
// Design notes (see shop-knowledge-notes.txt):
//  * ONLY learn from jobs actually WON (accepted/converted). The shop doesn't mark losses and jobs
//    come back 6-12 months later, so "no response" is NOT a loss.
//  * Lead with the PROVEN HIGH end — the owner is underpriced, and the high end is a real receipt.
//  * Plain statistics, not an LLM. More accurate and explainable.
//
// v278 REWRITE — the old version compared RAW PRICES and HARD-FILTERED by width band. That threw
// away the best evidence: a won 5/8" x 120"w job ($750) was excluded from a 5/8" x 74"w quote purely
// because the widths fell in different bands, leaving junk behind and suggesting $100.
// Now we compare RATES and SCALE BY SIZE — a job with twice the steel costs roughly twice as much,
// so a bigger or smaller comparable still informs the price instead of being discarded.

const { Estimate, EstimatePart, Client } = require('../models');
const { Op } = require('sequelize');

const WON_STATUSES = ['accepted', 'converted'];

const CRANE_CAPACITY_LBS = parseFloat(process.env.CRANE_CAPACITY_LBS) || 10000;
const DENSITY = { carbon: 0.2836, stainless: 0.289, aluminum: 0.098, other: 0.2836, unknown: 0.2836 };

// Machine capacity bands (width). Still meaningful — but a SOFT factor now, not a wall.
const WIDTH_BANDS = [
  { max: 24, label: '0-24"' },
  { max: 60, label: '24-60"' },
  { max: 96, label: '60-96"' },
  { max: 120, label: '96-120"' },
  { max: Infinity, label: 'over 120" (needs machine clearance - special pricing)' }
];
function widthBand(w) {
  const v = parseFloat(w) || 0;
  if (!v) return null;
  for (let i = 0; i < WIDTH_BANDS.length; i++) if (v <= WIDTH_BANDS[i].max) return i;
  return WIDTH_BANDS.length - 1;
}

function parseNum(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return s;
  let str = String(s).replace(/["\u2033]|in\.?|inch(es)?/gi, ' ').trim();
  let m = str.match(/(\d+)[\s-]+(\d+)\s*\/\s*(\d+)/);
  if (m) return parseInt(m[1]) + parseInt(m[2]) / parseInt(m[3]);
  m = str.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return parseInt(m[1]) / parseInt(m[2]);
  m = str.match(/(\d*\.?\d+)/);
  if (m) return parseFloat(m[1]);
  return null;
}

function materialFamily(s) {
  const v = String(s || '').toLowerCase();
  if (/s\s*\/\s*s|stainless|\b3[0-4][0-9]\b/.test(v)) return 'stainless';
  if (/alum|6061|5052|5083|3003|6063/.test(v)) return 'aluminum';
  if (/a36|a572|a516|carbon|hr|crs|\ba\d{3}\b/.test(v)) return 'carbon';
  return v ? 'other' : 'unknown';
}

// The flat plate that gets rolled. If length isn't given, derive it from the rolled diameter
// (developed length = pi x diameter) - that's the plate actually fed through the roller.
function plateDims(part) {
  const t = parseNum(part.thickness);
  const w = parseNum(part.width);
  let l = parseNum(part.length);
  if (!l) {
    const d = parseNum(part.diameter) || parseNum(part.innerDiameter) || parseNum(part.outerDiameter);
    if (d) l = Math.PI * d;
  }
  return { t, w, l };
}

function weightLbs(part) {
  const { t, w, l } = plateDims(part);
  if (!t || !w || !l) return null;
  const d = DENSITY[materialFamily(part.material)] !== undefined ? DENSITY[materialFamily(part.material)] : DENSITY.carbon;
  return t * w * l * d;
}

// BILLABLE width = the top of the width band.
// The roller doesn't care whether the plate is 74" or 96" wide — same setup, same machine tied up,
// same handling. You're selling BAND CAPACITY, not inches. Calibrated against a real job: a won
// 5/8" x 120"w job ($750) implies $0.0779/lb; pricing a 5/8" x 74.25"w job at its band max (96")
// gives $440 — the owner actually bid $450. Scaling by the literal width gave $340 (too light).
function billableWidth(w) {
  const b = widthBand(w);
  if (b === null) return null;
  const max = WIDTH_BANDS[b].max;
  return isFinite(max) ? max : parseFloat(w); // over 120": no band ceiling, use the real width
}

// Weight used for PRICING (band-max width). Physical weight (for the crane check) uses real width.
function billableWeightLbs(part) {
  const { t, w, l } = plateDims(part);
  if (!t || !w || !l) return null;
  const bw = billableWidth(w);
  if (!bw) return null;
  const d = DENSITY[materialFamily(part.material)] !== undefined ? DENSITY[materialFamily(part.material)] : DENSITY.carbon;
  return t * bw * l * d;
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
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

async function suggestPrice(target, opts = {}) {
  const upliftPct = parseFloat(opts.newClientUpliftPct) || 0;
  const minCharge = parseFloat(opts.minLaborCharge) || 150;

  const tFam = materialFamily(target.material);
  const tDims = plateDims(target);
  const tWeight = weightLbs(target);              // real weight — what the crane lifts
  const tBillable = billableWeightLbs(target);    // band-max weight — what you charge for
  const tBand = widthBand(tDims.w);
  const tThk = tDims.t;
  const tDia = parseNum(target.diameter || target.innerDiameter || target.outerDiameter);
  const overCrane = tWeight != null && tWeight > CRANE_CAPACITY_LBS;

  const base = {
    widthBand: tBand !== null ? WIDTH_BANDS[tBand].label : null,
    oversize: tBand === WIDTH_BANDS.length - 1,
    estWeightLbs: tWeight != null ? Math.round(tWeight) : null,
    craneCapacityLbs: CRANE_CAPACITY_LBS,
    overCrane
  };

  const rows = await EstimatePart.findAll({
    where: { partType: target.partType },
    include: [{
      model: Estimate, as: 'estimate', required: true,
      where: { status: { [Op.in]: WON_STATUSES }, trashedAt: null },
      attributes: ['id', 'status', 'clientName', 'createdAt']
    }],
    limit: 4000
  });

  const now = Date.now();
  const comps = [];
  for (const p of rows) {
    const labor = parseFloat(p.laborTotal);
    if (!labor || labor <= 0) continue;
    const fam = materialFamily(p.material);
    if (tFam !== 'unknown' && fam !== 'unknown' && fam !== tFam) continue; // never mix metals

    const w = billableWeightLbs(p);          // rate is computed on BILLABLE weight, consistently
    if (!w || w <= 0) continue;              // need size to compute a rate
    const dims = plateDims(p);
    const rate = labor / w;                  // $ per billable lb - the scale-free comparison
    if (!isFinite(rate) || rate <= 0) continue;

    // Similarity: thickness matters most, then width band, then diameter, then age.
    let score = 0;
    if (tThk && dims.t) score += Math.abs(dims.t - tThk) / tThk * 3;
    const band = widthBand(dims.w);
    if (tBand !== null && band !== null) score += Math.abs(band - tBand) * 0.6; // SOFT, not a wall
    const dia = parseNum(p.diameter) || parseNum(p.innerDiameter);
    if (tDia && dia) score += Math.abs(dia - tDia) / tDia * 0.5;
    const ageDays = (now - new Date(p.estimate.createdAt).getTime()) / 86400000;
    score += Math.min(ageDays / 365, 3) * 0.3;

    comps.push({
      labor, weight: w, rate,
      thickness: dims.t, width: dims.w, length: dims.l, diameter: dia,
      material: p.material, clientName: p.estimate.clientName,
      ageDays: Math.floor(ageDays), score
    });
  }

  if (!comps.length || !tBillable) {
    return Object.assign({}, base, {
      found: 0,
      confidence: 'none',
      message: tWeight
        ? 'No comparable won jobs with size data yet.'
        : 'Enter thickness, width and length (or diameter) to get a recommendation.'
    });
  }

  comps.sort((a, b) => a.score - b.score);
  const top = comps.slice(0, 25);
  const rates = top.map(c => c.rate);

  // ---- SETUP + RATE MODEL -------------------------------------------------------------
  // Price is NOT proportional to size. Every job carries fixed setup hours, so $/lb is HIGH on
  // small jobs and LOW on big ones. The old model took the highest $/lb (which comes from the
  // SMALLEST jobs) and multiplied it across a big job -> absurd numbers ($997 for a $375-ish job).
  // Fit price = setup + rate x weight by least squares on the comparables instead.
  let setup = 0, rate = null, fitted = false;
  if (top.length >= 4) {
    const n = top.length;
    const mw = top.reduce((s, c) => s + c.weight, 0) / n;
    const mp = top.reduce((s, c) => s + c.labor, 0) / n;
    let Sxy = 0, Sxx = 0;
    for (const c of top) { Sxy += (c.weight - mw) * (c.labor - mp); Sxx += (c.weight - mw) * (c.weight - mw); }
    if (Sxx > 0) {
      const slope = Sxy / Sxx;
      const intercept = mp - slope * mw;
      if (slope > 0) {                      // a negative slope means the data is noise; fall back
        rate = slope;
        setup = Math.max(0, intercept);     // never a negative setup cost
        fitted = true;
      }
    }
  }
  if (!fitted) {
    // Not enough data to fit — fall back to the MEDIAN rate (never the max, that's the trap above)
    rate = median(rates);
    setup = 0;
  }

  const predicted = setup + rate * tBillable;

  // How much ABOVE the fitted line has he actually WON? Lean toward the upper end of that,
  // rather than inventing a price from an unrelated small job's $/lb.
  const ratios = top.map(c => c.labor / Math.max(1, setup + rate * c.weight)).sort((a, b) => a - b);
  const leanRaw = percentile(ratios, 75) || 1;
  const lean = Math.min(Math.max(leanRaw, 1), 1.25);   // never lean more than +25%
  const bestEver = Math.min(ratios[ratios.length - 1] || 1, 1.6);

  const typical = predicted;
  const provenHigh = predicted * bestEver;
  const recentComps = top.filter(c => c.ageDays <= 365);
  const recentTypical = recentComps.length
    ? median(recentComps.map(c => c.labor / Math.max(1, setup + rate * c.weight))) * predicted
    : null;

  let suggested = Math.max(predicted * lean, minCharge);

  let isNewClient = false;
  if (target.clientName && upliftPct > 0) {
    const priorWins = comps.filter(c => c.clientName === target.clientName).length;
    const client = await Client.findOne({ where: { name: target.clientName } });
    const clientAgeDays = client && client.createdAt ? (now - new Date(client.createdAt).getTime()) / 86400000 : 9999;
    isNewClient = priorWins === 0 || clientAgeDays < 180;
    if (isNewClient) suggested *= (1 + upliftPct / 100);
  }

  const confidence = rates.length >= 8 ? 'good' : rates.length >= 3 ? 'fair' : 'thin';

  return Object.assign({}, base, {
    found: rates.length,
    confidence,
    suggested: Math.round(suggested * 100) / 100,
    median: Math.round(typical * 100) / 100,
    provenHigh: Math.round(provenHigh * 100) / 100,
    low: Math.round(Math.min.apply(null, rates) * tBillable * 100) / 100,
    recentMedian: recentTypical ? Math.round(recentTypical * 100) / 100 : null,
    ratePerLb: Math.round(rate * 10000) / 10000,
    setupCost: Math.round(setup * 100) / 100,
    fitted,
    billableWeightLbs: Math.round(tBillable),
    billableWidth: billableWidth(tDims.w),
    minCharge,
    isNewClient,
    upliftPct: isNewClient ? upliftPct : 0,
    samples: top.slice(0, 6).map(c => ({
      labor: c.labor,
      weight: Math.round(c.weight),
      rate: Math.round(c.rate * 1000) / 1000,
      material: c.material,
      thickness: c.thickness,
      width: c.width,
      diameter: c.diameter,
      client: c.clientName,
      ageDays: c.ageDays
    }))
  });
}

module.exports = { suggestPrice, materialFamily, parseNum, weightLbs, widthBand };
