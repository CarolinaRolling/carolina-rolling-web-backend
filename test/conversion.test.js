/**
 * Estimate -> Work Order conversion regression tests.
 *
 * Guards the four defects found in v295, all of which silently lost money or
 * material tracking on conversion:
 *   1. materialSource never became 'we_order' (weSupplyMaterial was ignored)
 *   2. material typed into the estimate's We Supply panel (materialUnitCost)
 *      converted as $0, because the builder only read materialTotal
 *   3. a null materialMarkupPercent silently gained 20% on the WO side
 *   4. Drilling/Cutting service costs vanished (no WorkOrderPart columns)
 *
 * Run: node backend/test/conversion.test.js
 * No test framework or DB required — this exercises the pure builder directly.
 */

const assert = require('assert');
const { buildWorkOrderPartFromEstimate } = require('../src/services/pricing');

// Sequelize returns DECIMAL columns as STRINGS. Model that faithfully or these
// tests pass against numbers the real code never sees.
const dec = (v) => (v === null || v === undefined ? null : String(Number(v).toFixed(2)));

function estPart(overrides) {
  return Object.assign({
    partNumber: 1,
    partType: 'plate_roll',
    quantity: 2,
    material: 'A36',
    thickness: '3/8"',
    weSupplyMaterial: false,
    materialSource: 'customer_supplied', // EstimatePart model defaultValue
    materialUnitCost: dec(0),
    materialMarkupPercent: dec(20),
    materialTotal: dec(0),
    laborTotal: dec(0),
    partTotal: dec(0),
    outsideProcessing: [],
    formData: {},
  }, overrides);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('we-supply part converts to materialSource we_order', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    weSupplyMaterial: true,
    materialTotal: dec(125),
    laborTotal: dec(80),
    formData: { _baseLaborTotal: '80.00' },
  }));
  assert.strictEqual(wo.materialSource, 'we_order',
    'we-supply part must convert as we_order or it drops out of Order Material');
  assert.strictEqual(parseFloat(wo.materialTotal), 125);
});

test('customer-supplied part stays customer_supplied', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({ weSupplyMaterial: false }));
  assert.strictEqual(wo.materialSource, 'customer_supplied');
});

test('an explicit in_stock source is not overwritten by the checkbox', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    materialSource: 'in_stock',
    weSupplyMaterial: false,
  }));
  assert.strictEqual(wo.materialSource, 'in_stock');
});

test('material typed as materialUnitCost still converts (not $0)', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    weSupplyMaterial: true,
    materialTotal: null,          // cleanNumericFields writes null for a blank box
    materialUnitCost: dec(125),   // ...but the We Supply panel filled this instead
    laborTotal: dec(80),
    formData: { _baseLaborTotal: '80.00' },
  }));
  assert.strictEqual(parseFloat(wo.materialTotal), 125,
    'material priced via the estimate We Supply panel must not convert as $0');
  assert.ok(parseFloat(wo.partTotal) > 0);
});

test('markup is written explicitly so both sides show one price', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    weSupplyMaterial: true,
    materialTotal: dec(125),
    materialMarkupPercent: null,
  }));
  assert.notStrictEqual(wo.materialMarkupPercent, null,
    'a null markup means +0% on the estimate but +20% on every WO display');
  assert.strictEqual(typeof wo.materialMarkupPercent, 'number');
});

test('an explicit 0% markup is preserved, not defaulted to 20%', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    weSupplyMaterial: true,
    materialTotal: dec(100),
    materialMarkupPercent: dec(0),
    quantity: 1,
  }));
  assert.strictEqual(wo.materialMarkupPercent, 0);
  assert.strictEqual(parseFloat(wo.partTotal), 100);
});

test('drilling and cutting survive conversion', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    weSupplyMaterial: true,
    materialTotal: dec(100),
    serviceDrilling: true,
    serviceDrillingCost: dec(75),
    serviceDrillingVendor: 'Acme Drill',
    serviceCutting: true,
    serviceCuttingCost: dec(40),
  }));
  assert.ok(wo.formData, 'formData must exist to carry estimate-only fields');
  assert.strictEqual(parseFloat(wo.formData.serviceDrillingCost), 75);
  assert.strictEqual(wo.formData.serviceDrillingVendor, 'Acme Drill');
  assert.strictEqual(parseFloat(wo.formData.serviceCuttingCost), 40);
});

test('cone part carries full material cost', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    partType: 'cone_roll',
    quantity: 1,
    weSupplyMaterial: true,
    materialTotal: dec(940),
    laborTotal: dec(600),
    formData: { _baseLaborTotal: '600.00' },
  }));
  assert.strictEqual(parseFloat(wo.materialTotal), 940);
  assert.strictEqual(wo.materialSource, 'we_order');
  assert.strictEqual(parseFloat(wo.partTotal), 1728); // (940*1.2) + 600
});

test('outside processing part keeps its material', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    weSupplyMaterial: true,
    materialTotal: dec(200),
    laborTotal: dec(0),
    outsideProcessing: [{ costPerPart: 50, markup: 25, expediteCost: 0 }],
  }));
  assert.strictEqual(parseFloat(wo.materialTotal), 200);
  assert.ok(parseFloat(wo.partTotal) > 0);
});

test('non-ea-priced part passes its total through untouched', () => {
  const wo = buildWorkOrderPartFromEstimate(estPart({
    partType: 'inspection',
    laborTotal: dec(150),
    partTotal: dec(150),
  }));
  assert.strictEqual(parseFloat(wo.partTotal), 150);
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
