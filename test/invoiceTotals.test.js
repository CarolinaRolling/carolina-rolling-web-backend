/**
 * Invoice totals — the single calculation used by the invoice PDF, AR ledger, balances, statements
 * and invoice email (audit C4). Rules follow the QuickBooks IIF export exactly; the integration
 * fuzz test (test/integration/totals-fuzz.int.js) checks the IIF export and PDF against this.
 *
 * Run: node backend/test/invoiceTotals.test.js
 */
const assert = require('assert');
const { computeInvoiceTotals, invoiceAmount } = require('../src/services/invoiceTotals');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const MIN = [{ partTypes: ['plate_roll'], minimum: 150 }];

const plate = (o = {}) => ({ id: 'p1', partNumber: 1, partType: 'plate_roll', quantity: 2, partTotal: 400, laborTotal: 50, ...o });

test('parts + tax, nothing else', () => {
  const t = computeInvoiceTotals({ wo: { taxRate: 10 }, parts: [plate({ laborTotal: 200 })] });
  assert.strictEqual(t.partsSubtotal, 400);
  assert.strictEqual(t.taxAmount, 40);
  assert.strictEqual(t.grandTotal, 440);
});

test('labor minimum is billed (the old PDF left it out)', () => {
  const t = computeInvoiceTotals({ wo: { taxRate: 10 }, parts: [plate()], laborMinimums: MIN });
  assert.strictEqual(t.minimumAdjustment, 100);   // 150 minimum − 50 labor
  assert.strictEqual(t.grandTotal, 550);          // (400 + 100) × 1.10
});

test('minimumOverride turns the minimum off', () => {
  const t = computeInvoiceTotals({ wo: { taxRate: 10, minimumOverride: true }, parts: [plate()], laborMinimums: MIN });
  assert.strictEqual(t.minimumAdjustment, 0);
  assert.strictEqual(t.grandTotal, 440);
});

test('shipping charges are added after tax and never taxed', () => {
  const t = computeInvoiceTotals({ wo: { taxRate: 10 }, parts: [plate({ laborTotal: 200 })],
    shipmentCharges: [{ shippingCost: 100, shippingMarkup: 10 }] });
  assert.strictEqual(t.shippingTotal, 110);
  assert.strictEqual(t.taxAmount, 40);
  assert.strictEqual(t.grandTotal, 550);
});

test('legacy truckingCost is used only when there are no shipping charges', () => {
  const a = computeInvoiceTotals({ wo: { truckingCost: 75 }, parts: [plate({ laborTotal: 200 })] });
  assert.strictEqual(a.shippingTotal, 75);
  assert.strictEqual(a.usesLegacyTrucking, true);
  const b = computeInvoiceTotals({ wo: { truckingCost: 75 }, parts: [plate({ laborTotal: 200 })], shipmentCharges: [{ shippingCost: 20 }] });
  assert.strictEqual(b.shippingTotal, 20);
});

test('tax exempt from the client OR the work order flag', () => {
  const byClient = computeInvoiceTotals({ wo: { taxRate: 10 }, client: { taxStatus: 'Resale' }, parts: [plate({ laborTotal: 200 })] });
  const byWO = computeInvoiceTotals({ wo: { taxRate: 10, taxExempt: true }, client: { taxStatus: 'taxable' }, parts: [plate({ laborTotal: 200 })] });
  assert.strictEqual(byClient.taxAmount, 0);
  assert.strictEqual(byWO.taxAmount, 0);   // the old PDF ignored this flag and charged tax
  assert.strictEqual(byWO.grandTotal, 400);
});

test('percent discount follows QuickBooks: taken on parts + minimum + shipping', () => {
  const t = computeInvoiceTotals({ wo: { taxRate: 10, discountPercent: 10 }, parts: [plate({ laborTotal: 200 })],
    shipmentCharges: [{ shippingCost: 100 }] });
  assert.strictEqual(t.discountTotal, 50);         // 10% of (400 + 100)
  assert.strictEqual(t.taxableAmount, 350);        // 400 + 100 − 50 − 100 shipping
  assert.strictEqual(t.taxAmount, 35);
  assert.strictEqual(t.grandTotal, 485);           // 450 + 35
});

test('flat discount amount', () => {
  const t = computeInvoiceTotals({ wo: { discountAmount: 25 }, parts: [plate({ laborTotal: 200 })] });
  assert.strictEqual(t.grandTotal, 375);
});

test('rush: expedite % of labor only, plus emergency fee', () => {
  const rush = { id: 'r', partNumber: 3, partType: 'rush_service', partTotal: 0,
    formData: { _expediteEnabled: true, _expediteType: '50', _emergencyEnabled: true, _emergencyDay: 'Saturday' } };
  // labor each 50 × qty 2 = 100 labor → 50% = 50; + Saturday 600
  const t = computeInvoiceTotals({ wo: {}, parts: [plate({ partTotal: 400 }), rush] });
  assert.strictEqual(t.rushAmount, 650);
  assert.strictEqual(t.rushPartId, 'r');
  assert.strictEqual(t.grandTotal, 1050);
});

test('rush counts even when it is linked to a part (the old PDF dropped it)', () => {
  const rush = { id: 'r', partNumber: 3, partType: 'rush_service', partTotal: 0,
    formData: { _linkedPartId: 'p1', _expediteEnabled: true, _expediteType: 'custom_amt', _expediteCustomAmt: 120 } };
  const t = computeInvoiceTotals({ wo: {}, parts: [plate(), rush] });
  assert.strictEqual(t.rushAmount, 120);
  assert.strictEqual(t.grandTotal, 520);
});

test('linked and unlinked services both count', () => {
  const fab = { id: 's1', partNumber: 2, partType: 'fab_service', quantity: 1, partTotal: 90, formData: { _linkedPartId: 'p1' } };
  const shop = { id: 's2', partNumber: 0, partType: 'shop_rate', quantity: 1, partTotal: 60 };
  const t = computeInvoiceTotals({ wo: {}, parts: [plate({ laborTotal: 200 }), fab, shop] });
  assert.strictEqual(t.partsSubtotal, 550);
});

test('legacy invoice without priced parts falls back to the stored total (+ shipping charges)', () => {
  const t = computeInvoiceTotals({ wo: { grandTotal: 1234.5 }, parts: [], shipmentCharges: [{ shippingCost: 50 }] });
  assert.strictEqual(invoiceAmount(t, { grandTotal: 1234.5 }), 1284.5);
  const priced = computeInvoiceTotals({ wo: { grandTotal: 999 }, parts: [plate({ laborTotal: 200 })] });
  assert.strictEqual(invoiceAmount(priced, { grandTotal: 999 }), 400);  // stale stored value ignored
});

test('a negative rush amount is ignored, as in the QuickBooks export', () => {
  const rush = { id: 'r', partNumber: 3, partType: 'rush_service', partTotal: 0,
    formData: { _expediteEnabled: true, _expediteType: 'custom_amt', _expediteCustomAmt: -50 } };
  const t = computeInvoiceTotals({ wo: {}, parts: [plate({ laborTotal: 200 }), rush] });
  assert.strictEqual(t.rushAmount, 0);
  assert.strictEqual(t.grandTotal, 400);
});

test('unpriced parts + labor minimum do not replace a stored legacy total', () => {
  const unpriced = { id: 'u', partNumber: 1, partType: 'plate_roll', quantity: 1, partTotal: 0 };
  const t = computeInvoiceTotals({ wo: { taxRate: 10 }, parts: [unpriced], laborMinimums: MIN });
  assert.strictEqual(t.minimumAdjustment, 150);                       // the minimum still computes…
  assert.strictEqual(invoiceAmount(t, { grandTotal: 4000 }), 4000);   // …but the stored total wins
});

test('exported invoices use the total frozen at export', () => {
  const t = computeInvoiceTotals({ wo: { taxRate: 10 }, parts: [plate({ partTotal: 999, laborTotal: 200 })] });
  assert.strictEqual(invoiceAmount(t, { grandTotal: 770, iifExportedAt: new Date(), totalsComputedAt: new Date() }), 770);
  // exported before this change (no totalsComputedAt): old ledger rule, stored + shipping charges
  const c = computeInvoiceTotals({ wo: {}, parts: [plate()], shipmentCharges: [{ shippingCost: 40 }] });
  assert.strictEqual(invoiceAmount(c, { grandTotal: 500, iifExportedAt: new Date() }), 540);
});

test('amounts are rounded to cents', () => {
  const t = computeInvoiceTotals({ wo: { taxRate: 9.5 }, parts: [plate({ partTotal: 333.33, laborTotal: 200 })] });
  assert.strictEqual(t.taxAmount, 31.67);
  assert.strictEqual(t.grandTotal, 365);
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; console.log('  PASS ', name); }
  catch (e) { failed++; console.log('  FAIL ', name, '\n        ', e.message); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
