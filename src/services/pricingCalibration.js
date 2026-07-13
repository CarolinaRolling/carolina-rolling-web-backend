// PRICING CALIBRATION WORKSHEET
//
// Purpose: when there's little or no won-job history for a part type (or a material like AR400 that
// he's never quoted), the recommender has nothing to learn from. This generates a short list of
// representative jobs for the owner to price by hand, then FITS the model from his answers.
//
// Design principle: every row isolates ONE variable against a fixed baseline, so each answer teaches
// the system exactly one thing and the fit is unambiguous:
//   * BASELINE            -> anchors setup + rate
//   * thickness rows      -> how price scales with thickness
//   * width-band rows     -> the machine-capacity steps
//   * quantity rows       -> how much setup amortises across a run
//   * material rows       -> the difficulty factor for each metal (price / baseline price)
//
// The material rows are the important ones for "A36 vs AR400": identical geometry, different metal.
// The ratio of his two answers IS the difficulty factor — derived from his judgement, not guessed.

const { DEFAULT_MATERIAL_FACTORS, billableWeightLbs, materialFactor } = require('./pricingSuggest');

const BASELINE = {
  plate_roll:   { thickness: '3/8', width: 96, length: 188.5, diameter: 60, material: 'A36', quantity: 1 },
  shaped_plate: { thickness: '3/8', width: 96, length: 188.5, diameter: 60, material: 'A36', quantity: 1 },
  cone_roll:    { thickness: '1/4', width: 48, length: 150, diameter: 48, material: 'A36', quantity: 1 },
  press_brake:  { thickness: '1/4', width: 48, length: 120, material: 'A36', quantity: 1 },
  flat_stock:   { thickness: '1/4', width: 48, length: 120, material: 'A36', quantity: 1 },
  angle_roll:   { thickness: '3/8', width: 4, length: 188.5, diameter: 60, material: 'A36', quantity: 1 }
};

const MATERIALS_TO_CALIBRATE = ['A36', 'A516 Gr 70', 'A572 Gr 50', '304 S/S', '316 S/S', 'AR400', '6061', '5052'];

function fmt(v) { return typeof v === 'number' ? String(v) : v; }

function describe(row) {
  const bits = [];
  bits.push(`${row.thickness}"`);
  if (row.width) bits.push(`${fmt(row.width)}" wide`);
  if (row.length) bits.push(`${fmt(row.length)}" long`);
  if (row.diameter) bits.push(`rolled to ${fmt(row.diameter)}" dia`);
  bits.push(row.material);
  return `${bits.join(' × ')} — qty ${row.quantity}`;
}

/**
 * Build the worksheet for a part type. Each row is a job to price by hand.
 */
function buildWorksheet(partType) {
  const base = BASELINE[partType] || BASELINE.plate_roll;
  const rows = [];
  const add = (purpose, teaches, over) => {
    const row = Object.assign({}, base, over || {});
    row.id = `${purpose}_${rows.length}`;
    row.purpose = purpose;
    row.teaches = teaches;
    row.description = describe(row);
    row.estWeightLbs = Math.round(billableWeightLbs(row) || 0);
    rows.push(row);
  };

  add('baseline', 'Anchors your setup cost and base rate — everything else is measured against this.', {});

  // Thickness — how much harder does thicker steel get?
  add('thickness', 'How price scales with thickness (thin).', { thickness: '1/4' });
  add('thickness', 'How price scales with thickness (heavy).', { thickness: '3/4' });

  // Width bands — the machine-capacity steps
  if (partType !== 'angle_roll') {
    add('width', 'Narrow work (0–24" band).', { width: 24 });
    add('width', 'Mid work (24–60" band).', { width: 60 });
    add('width', 'Full-width work (96–120" band).', { width: 120 });
  }

  // Diameter — tight rolls cost more passes
  if (base.diameter) {
    add('diameter', 'A tight roll (more passes, harder).', { diameter: 24, length: Math.round(Math.PI * 24 * 10) / 10 });
    add('diameter', 'A large, easy roll.', { diameter: 120, length: Math.round(Math.PI * 120 * 10) / 10 });
  }

  // Quantity — how much does setup amortise?
  add('quantity', 'How much you discount a run of 5 (setup spread over the job).', { quantity: 5 });
  add('quantity', 'How much you discount a run of 25.', { quantity: 25 });

  // MATERIALS — identical geometry, different metal. The ratio to the A36 baseline IS the
  // difficulty factor. This is what teaches the system that AR400 ≠ A36.
  for (const m of MATERIALS_TO_CALIBRATE) {
    if (m === 'A36') continue; // that's the baseline row
    add('material', `How much more (or less) than A36 you'd charge for the SAME cylinder in ${m}.`, { material: m });
  }

  return {
    partType,
    baseline: describe(base),
    note: 'Price each row the way you actually would for a client. Leave any row blank if you never do that work — blanks are skipped.',
    rows
  };
}

/**
 * Fit setup, rate and material factors from the owner's filled-in prices.
 * answers: { [rowId]: priceEach }
 */
function fitFromWorksheet(partType, rows, answers) {
  const filled = rows
    .map(r => ({ ...r, price: parseFloat(answers[r.id]) }))
    .filter(r => r.price && r.price > 0 && r.estWeightLbs > 0);

  if (filled.length < 3) {
    return { ok: false, message: 'Fill in at least 3 rows (including the baseline) so the numbers can be fitted.' };
  }

  const baselineRow = filled.find(r => r.purpose === 'baseline');

  // 1) MATERIAL FACTORS — the ratio of each material row to the A36 baseline, at identical geometry.
  const materialFactors = {};
  if (baselineRow) {
    for (const r of filled.filter(r => r.purpose === 'material')) {
      const factor = r.price / baselineRow.price;
      if (isFinite(factor) && factor > 0) {
        const key = String(r.material).toLowerCase().replace(/[\s\-_/]/g, '');
        materialFactors[key] = Math.round(factor * 100) / 100;
      }
    }
    materialFactors['a36'] = 1.0;
  }

  // 2) SETUP + RATE — fit on job totals using A36-equivalent weight (so material rows can join in).
  const pts = filled.map(r => {
    const f = materialFactor(r.material, materialFactors);
    return { x: r.quantity * r.estWeightLbs * f, y: r.price * r.quantity };
  });
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let Sxy = 0, Sxx = 0;
  for (const p of pts) { Sxy += (p.x - mx) * (p.y - my); Sxx += (p.x - mx) * (p.x - mx); }

  let setup = 0, ratePerLb = null;
  if (Sxx > 0) {
    const slope = Sxy / Sxx;
    if (slope > 0) {
      ratePerLb = Math.round(slope * 10000) / 10000;
      setup = Math.max(0, Math.round((my - slope * mx) * 100) / 100);
    }
  }
  if (!ratePerLb) {
    // Degenerate (e.g. only one distinct size) — fall back to a flat rate with no setup.
    const totalY = pts.reduce((s, p) => s + p.y, 0);
    const totalX = pts.reduce((s, p) => s + p.x, 0);
    ratePerLb = totalX > 0 ? Math.round((totalY / totalX) * 10000) / 10000 : null;
    setup = 0;
  }

  const minCharge = Math.min(...filled.map(r => r.price));

  return {
    ok: true,
    partType,
    setupCost: setup,
    ratePerLb,
    minCharge: Math.round(minCharge * 100) / 100,
    materialFactors,
    rowsUsed: filled.length,
    message: `Fitted from ${filled.length} priced rows: $${setup.toFixed(2)} setup + $${ratePerLb}/lb (A36-equivalent).`
  };
}

module.exports = { buildWorksheet, fitFromWorksheet, MATERIALS_TO_CALIBRATE, DEFAULT_MATERIAL_FACTORS };
