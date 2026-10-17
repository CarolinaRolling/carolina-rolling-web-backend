/**
 * poNumbers — the ONE place purchase-order numbers are handed out (audit H11).
 *
 * Before: the locked allocator existed but nothing used it. Every screen asked "what's the next PO
 * number?", then sent that number back and the server trusted it — so two people ordering at the same
 * time got the same PO number, an existing PO row could be silently re-used for a different order,
 * and the counter could move backwards. Outside-processing (OP) and trucking (TR) POs used separate,
 * unlocked counters that could produce the same numbers as material POs.
 *
 * Now every PO — material, service, outside processing (OP…), trucking (TR…), or typed on the PO
 * page — is reserved here, under one database lock, from ONE number space. The prefix still says what
 * kind of PO it is, but PO7801 and OP7801 can no longer both exist.
 *
 * The number a screen suggests is honored if it's still free. If someone took it a moment earlier,
 * the next free number is used and the caller is told (`adjustedFrom`), instead of failing or
 * creating a duplicate.
 */
const { acquire, LOCK_KEYS } = require('./numberAllocator');
const { DEFAULTS } = require('../constants');

const STARTING = (DEFAULTS && DEFAULTS.STARTING_PO_NUMBER) || 7765;
const models = () => require('../models');

async function readCounter(t) {
  const { AppSettings } = models();
  const row = await AppSettings.findOne({ where: { key: 'next_po_number' }, transaction: t });
  const v = row?.value;
  const n = typeof v === 'object' && v !== null ? parseInt(v.nextNumber, 10) : parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/** The lowest number the sequence may hand out next (never below what's already used). */
async function sequenceFloor(t) {
  const { PONumber } = models();
  const maxUsed = (await PONumber.max('poNumber', { transaction: t })) || 0;
  return Math.max(await readCounter(t), maxUsed + 1, STARTING);
}

async function rangeFree(start, count, t) {
  const { PONumber, InboundOrder } = models();
  const { Op } = require('sequelize');
  const taken = await PONumber.count({ where: { poNumber: { [Op.between]: [start, start + count - 1] } }, transaction: t });
  if (taken) return false;
  // Older POs whose tracker row was never written (the old code swallowed that failure) still live on
  // their delivery record — don't hand those numbers out again.
  const strings = [];
  for (let n = start; n < start + count; n++) strings.push(`PO${n}`, `OP${n}`, `TR${n}`);
  const onDeliveries = await InboundOrder.count({ where: { purchaseOrderNumber: strings }, transaction: t });
  return onDeliveries === 0;
}

// A typed number this far past the sequence is almost certainly a typo (an extra digit)
const MAX_JUMP = 1000;

/**
 * Reserve `count` consecutive PO numbers inside `transaction` (required: the lock is held until it
 * commits, so the caller must create the PONumber rows in the same transaction).
 * @param {number} [requested] the number the screen suggested / the user typed
 * @returns {{ numbers: number[], adjustedFrom: number|null }}
 */
async function reservePONumbers(count, { transaction, requested } = {}) {
  if (!transaction) throw new Error('reservePONumbers requires a transaction');
  const n = Math.max(1, parseInt(count, 10) || 1);
  const { sequelize, AppSettings } = models();
  await acquire(sequelize, LOCK_KEYS.po, transaction);

  const floor = await sequenceFloor(transaction);
  const want = Number.isFinite(requested) && requested > 0 ? requested : null;
  if (want && want > floor + MAX_JUMP) {
    const e = new Error(`PO${want} is far past the next PO number (PO${floor}). Check the number for a typo.`);
    e.status = 400; throw e;
  }
  let start;
  if (want && await rangeFree(want, n, transaction)) {
    start = want;                                    // still free (or a deliberate gap / jump ahead)
  } else {
    start = want && want > floor ? want : floor;     // taken meanwhile → next free at or after it
    while (!(await rangeFree(start, n, transaction))) start++;
  }
  const numbers = Array.from({ length: n }, (_, i) => start + i);

  // Counter only ever moves forward
  const current = await readCounter(transaction);
  const nextNumber = Math.max(current, start + n);
  if (nextNumber !== current) {
    await AppSettings.upsert({ key: 'next_po_number', value: { nextNumber } }, { transaction });
  }
  return { numbers, adjustedFrom: want && want !== start ? want : null };
}

/** Read-only: what the next PO number will be (for the screens that pre-fill it). */
async function previewNextPONumber() {
  const { sequelize } = models();
  return sequelize.transaction(async (t) => {
    let n = await sequenceFloor(t);
    while (!(await rangeFree(n, 1, t))) n++;
    return n;
  });
}

/** Admin "set next PO number": never below a number already used. */
async function setNextPONumber(value) {
  const { sequelize, AppSettings, PONumber } = models();
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) { const e = new Error('A valid number is required'); e.status = 400; throw e; }
  return sequelize.transaction(async (t) => {
    await acquire(sequelize, LOCK_KEYS.po, t);
    const maxUsed = (await PONumber.max('poNumber', { transaction: t })) || 0;
    if (n <= maxUsed) {
      const e = new Error(`PO${n} is at or below the highest PO already issued (PO${maxUsed}). The next number must be PO${maxUsed + 1} or higher.`);
      e.status = 400; throw e;
    }
    await AppSettings.upsert({ key: 'next_po_number', value: { nextNumber: n } }, { transaction: t });
    return n;
  });
}

/**
 * Reserve ONE number in its own short transaction and record it — for the outside-processing /
 * trucking routes that don't run in a transaction. Returns the formatted number (e.g. 'OP7801').
 */
async function reserveStandalone(prefix, row = {}) {
  const { sequelize, PONumber } = models();
  return sequelize.transaction(async (t) => {
    const { numbers } = await reservePONumbers(1, { transaction: t });
    await PONumber.create({ poNumber: numbers[0], status: 'active', description: `${prefix} PO`, ...row }, { transaction: t });
    return `${prefix}${numbers[0]}`;
  });
}

/**
 * Run `fn` while holding a per-work-order claim for PO creation (round 12, audit N15). Trucking and
 * outside-processing POs reserve a number, build and upload a PDF, then write the PO back — three
 * simultaneous clicks used to make three POs. A second request while one is running gets a 409.
 * The claim is a row (works across dynos, holds no database connection while the PDF is built); a
 * claim older than 10 minutes (a crashed request) is taken over.
 */
async function withOrderPOLock(workOrderId, fn) {
  const { sequelize } = models();
  const { QueryTypes } = require('sequelize');
  const key = 'po-lock:' + String(workOrderId);
  await sequelize.query(`DELETE FROM idempotency_keys WHERE "key" = :key AND "createdAt" < now() - interval '10 minutes'`, { replacements: { key } });
  const got = await sequelize.query(`INSERT INTO idempotency_keys ("key", "method", "path") VALUES (:key, 'LOCK', 'po') ON CONFLICT ("key") DO NOTHING RETURNING "key"`,
    { replacements: { key }, type: QueryTypes.SELECT });
  if (!got.length) {
    const e = new Error('A purchase order is already being created for this work order. Wait a moment and refresh.');
    e.status = 409; throw e;
  }
  try { return await fn(); }
  finally { await sequelize.query(`DELETE FROM idempotency_keys WHERE "key" = :key`, { replacements: { key } }).catch(() => {}); }
}

module.exports = { reservePONumbers, previewNextPONumber, setNextPONumber, reserveStandalone, withOrderPOLock, STARTING };
