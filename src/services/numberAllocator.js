/**
 * Serialized number allocation for DR and PO sequences.
 *
 * Every allocator in this codebase used to be a bare read-max-then-write with no locking:
 *
 *     const max = await DRNumber.max('drNumber');
 *     const next = max + 1;
 *
 * Two requests landing in the same moment read the same max and both try to claim it. For
 * `drNumber` the unique index turns that into a 500 for the loser; for the `next_dr_number`
 * AppSettings row there is no constraint at all, so the same number can be handed out twice.
 *
 * Fix is a Postgres transaction-level advisory lock. Taking it serializes every caller across
 * every dyno and connection, and it releases automatically on commit OR rollback — there is no
 * leak path if a request throws partway. Deadlock is not a concern because a caller only ever
 * takes one of these locks and never holds it while waiting on another.
 *
 * All functions REQUIRE a transaction. The lock is scoped to it, so allocating outside one
 * would release the lock immediately and provide no protection.
 */

// Arbitrary but fixed keys. They only need to be stable and distinct from each other.
const LOCK_KEYS = {
  dr: 8410001,
  po: 8410002,
};

async function acquire(sequelize, key, transaction) {
  if (!transaction) {
    throw new Error('Number allocation requires a transaction — the advisory lock is scoped to it.');
  }
  await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
    replacements: { key },
    transaction,
  });
}

/**
 * Claim the next DR number. Caller must create the DRNumber row and stamp the work order
 * inside the SAME transaction, so the lock is still held when the number is written.
 */
async function allocateDRNumber(models, transaction, { startingNumber = 0 } = {}) {
  const { DRNumber, WorkOrder, AppSettings, sequelize } = models;
  await acquire(sequelize, LOCK_KEYS.dr, transaction);

  // An explicit "next number" set by an admin wins, but only if it has not already been used.
  const setting = await AppSettings.findOne({ where: { key: 'next_dr_number' }, transaction });
  const configured = setting?.value?.nextNumber;

  const maxFromTable = (await DRNumber.max('drNumber', { transaction })) || 0;
  const maxFromWorkOrders = (await WorkOrder.max('drNumber', { transaction })) || 0;
  const highWater = Math.max(maxFromTable, maxFromWorkOrders, startingNumber);

  let next;
  if (configured && configured > highWater) {
    next = configured;
  } else if (configured) {
    // The configured number is stale — something already claimed it. Skip past the high water
    // mark instead of handing out a duplicate and failing on the unique index.
    next = highWater + 1;
  } else {
    next = highWater + 1;
  }

  if (setting) {
    await setting.update({ value: { nextNumber: next + 1 } }, { transaction });
  } else {
    await AppSettings.upsert({ key: 'next_dr_number', value: { nextNumber: next + 1 } }, { transaction });
  }

  return next;
}

/**
 * Check that a manually entered DR number is free. Must run inside the same transaction that
 * will claim it, otherwise another request can take it between the check and the write.
 */
async function reserveCustomDRNumber(models, transaction, customNumber) {
  const { DRNumber, WorkOrder, sequelize } = models;
  await acquire(sequelize, LOCK_KEYS.dr, transaction);

  const drNumber = parseInt(customNumber, 10);
  if (!drNumber || isNaN(drNumber) || drNumber < 1) {
    const err = new Error('A valid DR number is required');
    err.status = 400;
    throw err;
  }

  const existingDR = await DRNumber.findOne({ where: { drNumber }, transaction });
  const existingWO = await WorkOrder.findOne({ where: { drNumber }, transaction });
  if (existingDR || existingWO) {
    const err = new Error(`DR-${drNumber} is already in use`);
    err.status = 400;
    throw err;
  }
  return drNumber;
}

/**
 * Claim the next PO number, same contract as allocateDRNumber.
 */
async function allocatePONumber(models, transaction, { startingNumber = 0 } = {}) {
  const { PONumber, AppSettings, sequelize } = models;
  await acquire(sequelize, LOCK_KEYS.po, transaction);

  const setting = await AppSettings.findOne({ where: { key: 'next_po_number' }, transaction });
  const configured = setting?.value?.nextNumber;

  const maxFromTable = (await PONumber.max('poNumber', { transaction })) || 0;
  const highWater = Math.max(maxFromTable, startingNumber);

  const next = (configured && configured > highWater) ? configured : highWater + 1;

  if (setting) {
    await setting.update({ value: { nextNumber: next + 1 } }, { transaction });
  }

  return next;
}

module.exports = {
  LOCK_KEYS,
  allocateDRNumber,
  reserveCustomDRNumber,
  allocatePONumber,
};
