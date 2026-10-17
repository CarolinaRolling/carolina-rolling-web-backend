/**
 * laborMinimum — the ONE labor-minimum and expedite calculation, used by the estimate, the invoice
 * (shared totals, PDF, ledger), the QuickBooks export and the order screens (round 13, audit T1/T2).
 *
 * Before there were two engines that disagreed: the estimate (and the Admin "Labor minimums" screen)
 * used rules shaped { partType, minSize, maxSize, minWidth, maxWidth, minimum } and labor × quantity,
 * while the invoice used rules shaped { partTypes: [...] }, summed labor per piece ignoring quantity,
 * applied the minimum even with no labor, and could not read rules saved by the Admin screen at all.
 * A $219 quote became a $361.35 invoice. The expedite fee was also charged on a different labor base.
 *
 * The rules (same as the estimate always used):
 *   - Only "each-priced" part types count (EA_PRICED_TYPES).
 *   - Billed labor of a part = its labor each × quantity. Labor each is the stored laborTotal (the labor
 *     actually charged — 0 when the work goes to an outside processor), falling back to
 *     formData.laborTotal, then formData._baseLaborTotal for old parts that only have that.
 *   - The rule for a part: the highest matching size/width-specific rule, else the highest general rule
 *     for its part type (a size rule that doesn't match never applies).
 *   - The minimum applies when not overridden, there is labor (> 0), and total labor is below the
 *     highest rule found. The adjustment (a separate invoice line) is minimum − total labor.
 *   - Expedite % applies to labor: billed labor of regular parts + the price of fab/shop-rate lines,
 *     plus the minimum adjustment when it applies; rounded to cents.
 */
const EA_PRICED_TYPES = ['plate_roll', 'shaped_plate', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 'flat_bar',
  'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll', 'fab_service', 'shop_rate'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fdOf = (p) => (p && p.formData && typeof p.formData === 'object') ? p.formData : {};
const raw = (p) => (p && p.dataValues) ? p.dataValues : (p || {});

const DEFAULT_RULES = [
  { partType: 'plate_roll', label: 'Plate ≤ 3/8"', sizeField: 'thickness', maxSize: 0.375, minWidth: '', maxWidth: '', minimum: 125 },
  { partType: 'plate_roll', label: 'Plate ≤ 3/8" (24-60" wide)', sizeField: 'thickness', maxSize: 0.375, minWidth: 24, maxWidth: 60, minimum: 150 },
  { partType: 'plate_roll', label: 'Plate > 3/8"', sizeField: 'thickness', minSize: 0.376, minWidth: '', maxWidth: '', minimum: 200 },
  { partType: 'angle_roll', label: 'Angle ≤ 2x2', sizeField: 'angleSize', maxSize: 2, minWidth: '', maxWidth: '', minimum: 150 },
  { partType: 'angle_roll', label: 'Angle > 2x2', sizeField: 'angleSize', minSize: 2.01, minWidth: '', maxWidth: '', minimum: 250 },
];

/** Accept the setting as an array or a JSON string; expand the old { partTypes: [...] } shape. */
function normalizeRules(value) {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r.partTypes)) { for (const t of r.partTypes) out.push({ ...r, partType: t }); }
    else out.push(r);
  }
  return out;
}

/** The labor-minimum rules from settings (defaults when none are saved). */
async function loadLaborMinimums({ transaction } = {}) {
  try {
    const { AppSettings } = require('../models');
    const setting = await AppSettings.findOne({ where: { key: 'labor_minimums' }, transaction });
    const rules = setting ? normalizeRules(setting.value) : null;
    if (rules && rules.length) return rules;
  } catch (e) { /* use defaults */ }
  return DEFAULT_RULES;
}

// "3/8"" → 0.375, "1-1/2"" → 1.5, "2.5" → 2.5, "24 ga" → 0.025
function parseDimension(val) {
  if (!val) return 0;
  const s = String(val).trim().replace(/["″]/g, '');
  if (!isNaN(s) && s !== '') return parseFloat(s);
  const gaugeMatch = s.match(/^(\d+)\s*ga/i);
  if (gaugeMatch) {
    const gaugeMap = { 24: 0.025, 22: 0.030, 20: 0.036, 18: 0.048, 16: 0.060, 14: 0.075, 12: 0.105, 11: 0.120, 10: 0.135 };
    return gaugeMap[parseInt(gaugeMatch[1])] || 0;
  }
  const mixedMatch = s.match(/^(\d+)\s*[-–]\s*(\d+)\s*\/\s*(\d+)/);
  if (mixedMatch) return parseInt(mixedMatch[1]) + parseInt(mixedMatch[2]) / parseInt(mixedMatch[3]);
  const fracMatch = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (fracMatch) return parseInt(fracMatch[1]) / parseInt(fracMatch[2]);
  const leadMatch = s.match(/^([\d.]+)/);
  if (leadMatch) return parseFloat(leadMatch[1]);
  return 0;
}

function getPartSize(part) {
  const r = raw(part);
  const merged = { ...r, ...fdOf(r) };
  switch (merged.partType) {
    case 'plate_roll': case 'flat_stock': return parseDimension(merged.thickness);
    case 'angle_roll': return parseDimension(merged._angleSize || merged.sectionSize || '');
    case 'pipe_roll': return parseDimension(merged.outerDiameter);
    case 'tube_roll': return parseDimension(merged._tubeSize || merged.sectionSize || '');
    case 'flat_bar': return parseDimension(merged._barSize || merged.sectionSize || '');
    case 'channel_roll': return parseDimension(merged._channelSize || merged.sectionSize || '');
    case 'beam_roll': return parseDimension(merged._beamSize || merged.sectionSize || '');
    case 'tee_bar': return parseDimension(merged._teeSize || merged.sectionSize || '');
    case 'cone_roll': return (parseFloat(merged._coneLargeDia) * (merged._coneLargeDiaMeasure === 'radius' ? 2 : 1)) || parseDimension(merged.sectionSize || '');
    default: return parseDimension(merged.sectionSize || merged.thickness || '');
  }
}

function getPartWidth(part) {
  const r = raw(part);
  return parseDimension(fdOf(r).width || r.width);
}

function getLaborMinimum(part, rules) {
  if (!rules || !rules.length) return null;
  const partSize = getPartSize(part);
  const partWidth = getPartWidth(part);
  const pt = raw(part).partType;
  let bestSpecific = null, bestGeneral = null;
  const has = (v) => v != null && v !== '' && parseFloat(v) > 0;
  for (const rule of rules) {
    if (rule.partType !== pt) continue;
    const sizeC = has(rule.minSize) || has(rule.maxSize);
    const widthC = has(rule.minWidth) || has(rule.maxWidth);
    if (!sizeC && !widthC) {
      if (!bestGeneral || parseFloat(rule.minimum) > parseFloat(bestGeneral.minimum)) bestGeneral = rule;
      continue;
    }
    let ok = true;
    if (sizeC) {
      if (partSize <= 0) ok = false;
      else {
        if (has(rule.minSize) && partSize < parseFloat(rule.minSize)) ok = false;
        if (has(rule.maxSize) && partSize > parseFloat(rule.maxSize)) ok = false;
      }
    }
    if (widthC) {
      if (partWidth <= 0) ok = false;
      else {
        if (has(rule.minWidth) && partWidth < parseFloat(rule.minWidth)) ok = false;
        if (has(rule.maxWidth) && partWidth > parseFloat(rule.maxWidth)) ok = false;
      }
    }
    if (ok && (!bestSpecific || parseFloat(rule.minimum) > parseFloat(bestSpecific.minimum))) bestSpecific = rule;
  }
  return bestSpecific || bestGeneral || null;
}

/** Labor actually charged for one piece of this part */
function billedLaborEach(part) {
  const r = raw(part);
  const fd = fdOf(r);
  // A fab / shop-rate line priced with no labor figure is all labor (conversion stores it that way)
  if ((r.partType === 'fab_service' || r.partType === 'shop_rate') && !(parseFloat(r.laborTotal) > 0) && !(parseFloat(fd.laborTotal) > 0)) {
    const qty = parseInt(r.quantity) || 1;
    const price = parseFloat(r.partTotal) || 0;
    if (price > 0) return price / qty;
  }
  if (r.laborTotal !== null && r.laborTotal !== undefined && r.laborTotal !== '' && !isNaN(parseFloat(r.laborTotal))) return parseFloat(r.laborTotal);
  if (fd.laborTotal !== undefined && fd.laborTotal !== '' && !isNaN(parseFloat(fd.laborTotal))) return parseFloat(fd.laborTotal);
  return parseFloat(fd._baseLaborTotal) || 0;
}

/**
 * The minimum for a set of parts.
 * @returns {{applies, adjustment, totalLabor, minimum, rule, minimumApplies, laborDifference, adjustedLabor, highestMinimum, highestMinRule}}
 */
function minimumInfo(parts, minimumOverride, rulesIn) {
  const rules = normalizeRules(rulesIn) || [];
  let totalLabor = 0, highest = 0, highestRule = null;
  for (const part of parts || []) {
    const r = raw(part);
    if (!EA_PRICED_TYPES.includes(r.partType)) continue;
    totalLabor += billedLaborEach(r) * (parseInt(r.quantity) || 1);
    const rule = getLaborMinimum(r, rules);
    if (rule && parseFloat(rule.minimum) > highest) { highest = parseFloat(rule.minimum); highestRule = rule; }
  }
  totalLabor = round2(totalLabor);
  const applies = !minimumOverride && highest > 0 && totalLabor > 0 && totalLabor < highest;
  const adjustment = applies ? round2(highest - totalLabor) : 0;
  return {
    applies, adjustment, totalLabor, minimum: highest, rule: highestRule,
    // names the estimate code uses
    minimumApplies: applies, laborDifference: adjustment, adjustedLabor: applies ? highest : totalLabor,
    highestMinimum: highest, highestMinRule: highestRule,
  };
}

/**
 * The labor an expedite percentage applies to.
 * @param priceOf  (part) => line price, for fab_service / shop_rate lines
 */
function expediteLaborBase(parts, minInfo, priceOf) {
  let base = 0;
  for (const part of parts || []) {
    const r = raw(part);
    if (r.partType === 'rush_service') continue;
    if (r.partType === 'fab_service' || r.partType === 'shop_rate') base += priceOf ? priceOf(r) : (parseFloat(r.partTotal) || 0);
    else base += billedLaborEach(r) * (parseInt(r.quantity) || 1);
  }
  if (minInfo && minInfo.applies) base += minInfo.adjustment;
  return round2(base);
}

module.exports = { EA_PRICED_TYPES, DEFAULT_RULES, normalizeRules, loadLaborMinimums, parseDimension, getPartSize, getPartWidth,
  getLaborMinimum, billedLaborEach, minimumInfo, expediteLaborBase };
