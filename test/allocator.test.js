// Verifies the allocator's decision logic and that it refuses to run unlocked.
const { allocateDRNumber, reserveCustomDRNumber } = require('../src/services/numberAllocator');

const calls = [];
function fakeModels({ configured, maxDR, maxWO, existing = [] }) {
  return {
    sequelize: { query: async (sql, o) => { calls.push(sql); return []; } },
    DRNumber: {
      max: async () => maxDR,
      findOne: async ({ where }) => existing.includes(where.drNumber) ? { drNumber: where.drNumber } : null,
    },
    WorkOrder: {
      max: async () => maxWO,
      findOne: async ({ where }) => existing.includes(where.drNumber) ? { drNumber: where.drNumber } : null,
    },
    AppSettings: {
      findOne: async () => configured === null ? null
        : { value: { nextNumber: configured }, update: async () => {} },
      upsert: async () => {},
    },
  };
}
const tx = {};
let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}: got ${got}, wanted ${want}`); fail++; }
};

(async () => {
  calls.length = 0;
  check('takes an advisory lock', await allocateDRNumber(fakeModels({configured:null,maxDR:2960,maxWO:2960}), tx) && calls[0].includes('pg_advisory_xact_lock'), true);

  check('no config -> high water + 1',
    await allocateDRNumber(fakeModels({configured:null,maxDR:2960,maxWO:2955}), tx), 2961);

  check('work orders ahead of dr table -> uses the higher',
    await allocateDRNumber(fakeModels({configured:null,maxDR:2950,maxWO:2999}), tx), 3000);

  check('configured number ahead -> honored',
    await allocateDRNumber(fakeModels({configured:3100,maxDR:2960,maxWO:2960}), tx), 3100);

  // The old code returned the stale configured number and died on the unique index.
  check('STALE configured number -> skips past instead of colliding',
    await allocateDRNumber(fakeModels({configured:2955,maxDR:2960,maxWO:2960}), tx), 2961);

  check('respects startingNumber floor on an empty db',
    await allocateDRNumber(fakeModels({configured:null,maxDR:0,maxWO:0}), tx, {startingNumber:2950}), 2951);

  // Must refuse to allocate without a transaction — the lock would release immediately.
  let threw = false;
  try { await allocateDRNumber(fakeModels({configured:null,maxDR:1,maxWO:1}), null); } catch (e) { threw = true; }
  check('refuses to allocate outside a transaction', threw, true);

  let rejected = false;
  try { await reserveCustomDRNumber(fakeModels({configured:null,maxDR:1,maxWO:1,existing:[2975]}), tx, 2975); }
  catch (e) { rejected = e.status === 400; }
  check('custom number already in use -> 400', rejected, true);

  check('custom number free -> returned',
    await reserveCustomDRNumber(fakeModels({configured:null,maxDR:1,maxWO:1}), tx, '2976'), 2976);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
