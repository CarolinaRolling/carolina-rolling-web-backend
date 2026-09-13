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
  angle_roll:   { thickness: '3/8', width: 4, length: 188.5, diameter: 60, material: 'A36', quantity: 1 },
  // Round tube/pipe: described by OD + wall thickness, rolled to a diameter (not plate width).
  pipe_roll:    { section: 'round', outerDiameter: 6, wallThickness: '0.280', length: 188.5, diameter: 60, material: 'A36', quantity: 1 },
  tube_roll:    { section: 'square', tubeSize: '4x2', wallThickness: '1/4', length: 188.5, diameter: 60, material: 'A36', quantity: 1 },
  // Structural sections: sized by their section (e.g. C8, W8), rolled the hard/easy way to a diameter.
  channel_roll: { section: 'C8', wallThickness: '', length: 188.5, diameter: 72, material: 'A36', quantity: 1 },
  beam_roll:    { section: 'W8', wallThickness: '', length: 188.5, diameter: 96, material: 'A36', quantity: 1 },
  flat_bar:     { thickness: '1/2', width: 4, length: 188.5, diameter: 48, material: 'A36', quantity: 1 }
};

const MATERIALS_TO_CALIBRATE = ['A36', 'A516 Gr 70', 'A572 Gr 50', '304 S/S', '316 S/S', 'AR400', '6061', '5052'];

function fmt(v) { return typeof v === 'number' ? String(v) : v; }

function describe(row) {
  const bits = [];
  if (row.section === 'round') {
    // Round pipe/tube: OD × wall
    bits.push(`${fmt(row.outerDiameter)}" OD`);
    if (row.wallThickness) bits.push(`${row.wallThickness}" wall`);
  } else if (row.section === 'square') {
    // Square/rect tube: size × wall
    if (row.tubeSize) bits.push(`${row.tubeSize} tube`);
    if (row.wallThickness) bits.push(`${row.wallThickness}" wall`);
  } else if (row.section && /^[CW]\d/.test(row.section)) {
    // Structural channel/beam section
    bits.push(row.section);
  } else {
    // Plate / flat / angle style
    bits.push(`${row.thickness}"`);
    if (row.width) bits.push(`${fmt(row.width)}" wide`);
  }
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

  const isRoundOrSquare = base.section === 'round' || base.section === 'square';
  const isSection = base.section && /^[CW]\d/.test(base.section);

  if (isRoundOrSquare) {
    // Tube/pipe: wall thickness drives difficulty, not plate thickness.
    add('wall', 'How price scales with a THIN wall (springier, harder to control).', { wallThickness: base.section === 'round' ? '0.120' : '1/8' });
    add('wall', 'How price scales with a HEAVY wall.', { wallThickness: base.section === 'round' ? '0.500' : '1/2' });
  } else if (isSection) {
    // Channel/beam: the section size itself is the driver.
    add('section', 'A lighter section (easier).', { section: base.section === 'W8' ? 'W6' : 'C6' });
    add('section', 'A heavier section (harder, more passes).', { section: base.section === 'W8' ? 'W12' : 'C12' });
  } else {
    // Plate / flat / angle: thickness rows.
    add('thickness', 'How price scales with thickness (thin).', { thickness: '1/4' });
    add('thickness', 'How price scales with thickness (heavy).', { thickness: '3/4' });
  }

  // Width bands only apply to plate-style flat work (a plate roller's machine-capacity steps).
  if (!isRoundOrSquare && !isSection && partType !== 'angle_roll') {
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
 * Build a worksheet seeded from ACTUAL order history when we have it. Scans won/converted parts of this
 * type, finds the most commonly-ordered real sizes, and turns the top few into calibration rows — so the
 * owner calibrates against jobs he actually runs, not invented ones. Falls back to buildWorksheet()'s
 * sensible defaults when there's too little history.
 *
 * models: { EstimatePart, WorkOrder } from require('../models')
 */
async function buildWorksheetFromHistory(partType, models) {
  const base = BASELINE[partType] || BASELINE.plate_roll;
  try {
    const { EstimatePart, Estimate } = models;
    if (!EstimatePart) return buildWorksheet(partType);
    const { Op } = require('sequelize');

    // Pull recent parts of this type from WON estimates (accepted/converted).
    const parts = await EstimatePart.findAll({
      where: { partType },
      include: [{ model: Estimate, as: 'estimate', attributes: ['status'], where: { status: { [Op.in]: ['accepted', 'converted'] } }, required: true }],
      attributes: ['material', 'thickness', 'width', 'length', 'outerDiameter', 'wallThickness', 'sectionSize', 'diameter'],
      limit: 400, order: [['createdAt', 'DESC']]
    });
    if (!parts || parts.length < 5) return buildWorksheet(partType); // too thin — use defaults

    // Which fields identify a "size" for this part-type family?
    const sig = (p) => {
      if (base.section === 'round') return `${p.outerDiameter || ''}|${p.wallThickness || ''}`;
      if (base.section === 'square') return `${p.sectionSize || p.width || ''}|${p.wallThickness || p.thickness || ''}`;
      if (base.section && /^[CW]\d/.test(String(base.section))) return `${p.sectionSize || ''}`;
      return `${p.thickness || ''}|${p.width || ''}`; // plate/flat/angle
    };
    const counts = {};
    for (const p of parts) {
      const s = sig(p);
      if (!s.replace(/\|/g, '').trim()) continue; // skip blank sizes
      counts[s] = counts[s] || { n: 0, sample: p };
      counts[s].n++;
    }
    const top = Object.entries(counts).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
    if (top.length < 2) return buildWorksheet(partType); // not enough distinct real sizes — use defaults

    // Build rows from the real top sizes. Row 1 (most common) is the baseline anchor.
    const rows = [];
    const mkRow = (p, purpose, teaches) => {
      const row = Object.assign({}, base);
      // copy the size fields that exist on the historical part
      ['material', 'thickness', 'width', 'length', 'outerDiameter', 'wallThickness', 'sectionSize', 'diameter']
        .forEach(f => { if (p[f] !== null && p[f] !== undefined && p[f] !== '') row[f] = p[f]; });
      row.material = row.material || 'A36';
      row.quantity = 1;
      row.id = `${purpose}_${rows.length}`;
      row.purpose = purpose;
      row.teaches = teaches;
      row.description = describe(row);
      row.estWeightLbs = Math.round(billableWeightLbs(row) || 0);
      rows.push(row);
    };
    mkRow(top[0][1].sample, 'baseline', `Your most commonly ordered ${partType.replace('_', ' ')} (${top[0][1].n} recent jobs) — anchors setup + rate.`);
    top.slice(1).forEach(([, v]) => mkRow(v.sample, 'common', `Another common size (${v.n} recent jobs).`));

    // Material rows — same geometry as the baseline, different metal (teaches difficulty factors).
    const baseSample = top[0][1].sample;
    for (const m of MATERIALS_TO_CALIBRATE) {
      if (m === 'A36') continue;
      const p = {}; ['thickness', 'width', 'length', 'outerDiameter', 'wallThickness', 'sectionSize', 'diameter'].forEach(f => p[f] = baseSample[f]);
      p.material = m;
      mkRow(p, 'material', `Same as your baseline size, but in ${m} — teaches how much more/less than A36 you charge.`);
    }

    return {
      partType,
      baseline: rows[0]?.description,
      note: `Seeded from your ${parts.length} most recent won ${partType.replace('_', ' ')} jobs. Price each the way you actually would; blanks are skipped.`,
      fromHistory: true,
      rows
    };
  } catch (e) {
    return buildWorksheet(partType); // any error -> safe fallback
  }
}
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

module.exports = { buildWorksheet, buildWorksheetFromHistory, fitFromWorksheet, MATERIALS_TO_CALIBRATE, DEFAULT_MATERIAL_FACTORS };
