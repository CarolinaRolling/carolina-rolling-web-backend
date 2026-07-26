/**
 * Material country of origin -> USMCA certificate line items.
 *
 * The rule under test: rolling does not confer origin, so a ring's origin is its material's
 * origin. Nothing may default to USA, split heats must not be collapsed, and quantities that
 * are not covered by a heat record must be reported as unknown rather than absorbed.
 *
 * Run: node backend/test/origin.test.js
 */
const assert = require('assert');
const { originGroups, checkOrigin, buildOriginLineItems } = require('../src/services/materialOrigin');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('single heat with a country produces one group', () => {
  const g = originGroups({ quantity: 10, heatNumber: 'ER34', heatCountry: 'US' });
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].country, 'US');
  assert.strictEqual(g[0].qty, 10);
});

test('no origin recorded is reported as unknown, never assumed USA', () => {
  const g = originGroups({ quantity: 4, heatNumber: 'X1' });
  assert.strictEqual(g[0].country, '');
  const { ok, issues } = checkOrigin([{ partNumber: 3, quantity: 4, heatNumber: 'X1' }]);
  assert.strictEqual(ok, false);
  assert.strictEqual(issues[0].type, 'missing_origin');
});

test('split heats from two countries stay separate', () => {
  const g = originGroups({
    quantity: 8,
    heatBreakdown: [{ heat: 'H1', qty: 5, country: 'US' }, { heat: 'H2', qty: 3, country: 'TR' }],
  });
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g.find(x => x.country === 'US').qty, 5);
  assert.strictEqual(g.find(x => x.country === 'TR').qty, 3);
});

test('same country across two heats collapses to one group', () => {
  const g = originGroups({
    quantity: 8,
    heatBreakdown: [{ heat: 'H1', qty: 5, country: 'US' }, { heat: 'H2', qty: 3, country: 'US' }],
  });
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].qty, 8);
  assert.deepStrictEqual(g[0].heats, ['H1', 'H2']);
});

test('quantity not covered by any heat becomes unknown origin, not absorbed', () => {
  const g = originGroups({ quantity: 10, heatBreakdown: [{ heat: 'H9', qty: 6, country: 'CA' }] });
  const unknown = g.find(x => x.country === '');
  assert.ok(unknown, 'the 4 unaccounted pieces must surface');
  assert.strictEqual(unknown.qty, 4);
  assert.strictEqual(g.find(x => x.country === 'CA').qty, 6);
});

test('non-USMCA origin is flagged as not certifiable', () => {
  const { ok, issues } = checkOrigin([{ partNumber: 1, quantity: 5, heatCountry: 'TR', heatNumber: 'T1' }]);
  assert.strictEqual(ok, false);
  assert.strictEqual(issues[0].type, 'non_usmca_origin');
});

test('all three USMCA countries pass', () => {
  for (const c of ['US', 'CA', 'MX']) {
    const { ok } = checkOrigin([{ partNumber: 1, quantity: 5, heatCountry: c, heatNumber: 'H' }]);
    assert.strictEqual(ok, true, c + ' should be certifiable');
  }
});

test('certificate lines carry origin per line and never default to USA', () => {
  const lines = buildOriginLineItems([
    { partNumber: 1, clientPartNumber: 'A-1', quantity: 8, materialDescription: '3/8x2 A36 Flat Bar',
      heatBreakdown: [{ heat: 'H1', qty: 5, country: 'US' }, { heat: 'H2', qty: 3, country: 'CA' }] },
  ], { htsCode: '7215.50' });

  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].originCountry, 'US');
  assert.strictEqual(lines[1].originCountry, 'CA');
  assert.strictEqual(lines[0].qty + lines[1].qty, 8, 'quantities must total the part quantity');
  // Split lines cite their heats so the cert ties back to the right MTR
  assert.ok(lines[0].description.includes('H1'));
  assert.ok(lines[1].description.includes('H2'));
});

test('single-origin part does not get heat noise appended', () => {
  const lines = buildOriginLineItems([
    { partNumber: 1, clientPartNumber: 'A-2', quantity: 5, materialDescription: '2x2x1/4 Angle',
      heatNumber: 'ER34', heatCountry: 'US' },
  ], { htsCode: '7216.91' });
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].description, '2x2x1/4 Angle');
});

test('empty heat rows are ignored rather than creating phantom groups', () => {
  const g = originGroups({ quantity: 5, heatBreakdown: [{ heat: '', qty: '', country: '' }, { heat: 'H1', qty: 5, country: 'US' }] });
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].country, 'US');
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log('  PASS  ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); failed++; }
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
