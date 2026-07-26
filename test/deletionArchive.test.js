/**
 * Deletion archive helper.
 *
 * The contract that matters: archiving must capture the full record including children, and it
 * must NEVER prevent the delete the user asked for. Losing the safety net is bad; refusing to
 * delete because the safety net is broken would be worse.
 *
 * Run: node backend/test/deletionArchive.test.js
 */
const assert = require('assert');
const Module = require('module');

// Stub ../models so this runs without a database.
const created = [];
let shouldThrow = false;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../models') {
    return {
      DeletionArchive: {
        create: async (row) => {
          if (shouldThrow) throw new Error('archive table unavailable');
          created.push(row);
          return row;
        },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { archiveRecord, labelFor } = require('../src/services/deletionArchive');

const tests = [];
const test = (n, f) => tests.push({ n, f });

function fakeInstance(json, ctorName = 'WorkOrder') {
  return { id: json.id, constructor: { name: ctorName }, toJSON: () => json };
}

test('captures the record and its children', async () => {
  created.length = 0;
  const wo = fakeInstance({
    id: 'abc', drNumber: 2963, clientName: 'Acme',
    parts: [{ id: 'p1', partNumber: 1, files: [{ id: 'f1' }] }],
    documents: [{ id: 'd1' }],
  });
  const ok = await archiveRecord(wo, { modelName: 'WorkOrder', label: 'DR-2963', deletedBy: 'jason' });
  assert.strictEqual(ok, true);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].snapshot.parts.length, 1);
  assert.strictEqual(created[0].snapshot.parts[0].files.length, 1, 'nested part files must survive');
  assert.strictEqual(created[0].snapshot.documents.length, 1);
  assert.strictEqual(created[0].deletedBy, 'jason');
  assert.strictEqual(created[0].label, 'DR-2963');
});

test('a failure to archive does NOT block the delete', async () => {
  created.length = 0;
  shouldThrow = true;
  const ok = await archiveRecord(fakeInstance({ id: 'x' }), { modelName: 'WorkOrder' });
  shouldThrow = false;
  assert.strictEqual(ok, false, 'returns false rather than throwing');
  assert.strictEqual(created.length, 0);
});

test('a null record is a no-op, not a crash', async () => {
  const ok = await archiveRecord(null, { modelName: 'WorkOrder' });
  assert.strictEqual(ok, false);
});

test('falls back to the constructor name when modelName is omitted', async () => {
  created.length = 0;
  await archiveRecord(fakeInstance({ id: 'q' }, 'Estimate'), {});
  assert.strictEqual(created[0].modelName, 'Estimate');
});

test('labelFor prefers DR number, then estimate, then order number', () => {
  assert.strictEqual(labelFor({ drNumber: 2963, orderNumber: 'WO-1' }), 'DR-2963');
  assert.strictEqual(labelFor({ estimateNumber: 'EST-1471' }), 'EST-1471');
  assert.strictEqual(labelFor({ orderNumber: 'WO-260613' }), 'WO-260613');
  assert.strictEqual(labelFor({ poNumber: 4471 }), 'PO4471');
  assert.strictEqual(labelFor({ name: 'Acme Steel' }), 'Acme Steel');
  assert.strictEqual(labelFor(null), null);
});

test('plain objects without toJSON are archived as-is', async () => {
  created.length = 0;
  await archiveRecord({ id: 'plain', foo: 'bar' }, { modelName: 'Thing' });
  assert.strictEqual(created[0].snapshot.foo, 'bar');
});

(async () => {
  let pass = 0, fail = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log('  PASS  ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
