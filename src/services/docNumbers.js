/**
 * docNumbers — estimate (EST-…) and work-order (WO-…) numbers from a counter, not a random suffix
 * (audit M5).
 *
 * Before: four copies of a generator built EST-YYMMDD-NNN with a RANDOM 3-digit suffix (900 values
 * a day). At 30 estimates a day the chance of two colliding that day was about 1 in 3, and a
 * collision failed the save with a database error.
 *
 * Now: one counter per prefix per shop day (Pacific), incremented atomically in Postgres, so numbers
 * run EST-261011-001, -002, … A number that already exists (e.g. one the old random generator
 * produced earlier today) is skipped. Same look as before, no collisions.
 */
const PAD = 3;
const TABLES = { EST: ['estimates', 'estimateNumber'], WO: ['work_orders', 'orderNumber'] };

let ensured = null;
async function ensureTable(sequelize) {
  if (!ensured) {
    ensured = sequelize.query(`CREATE TABLE IF NOT EXISTS doc_number_counters (
      prefix VARCHAR(10) NOT NULL, day CHAR(6) NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (prefix, day))`)
      .catch(e => { ensured = null; throw e; });
  }
  return ensured;
}

/** YYMMDD in the shop's time zone */
function shopDay(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: '2-digit', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}

/**
 * Next free number for `prefix` ('EST' or 'WO'). Always runs OUTSIDE the caller's transaction: the
 * counter update commits at once, so a long transaction can't hold the day's counter row and make
 * every other new estimate/order wait (or deadlock against the DR-number lock). If the caller's work
 * then rolls back, that number is simply skipped — a gap, never a collision.
 */
async function nextDocNumber(prefix) {
  const transaction = undefined;
  const { sequelize } = require('../models');
  const target = TABLES[prefix];
  if (!target) throw new Error(`Unknown document number prefix ${prefix}`);
  await ensureTable(sequelize);
  const day = shopDay();
  for (let guard = 0; guard < 10000; guard++) {
    const [[row]] = await sequelize.query(
      `INSERT INTO doc_number_counters (prefix, day, n) VALUES (:prefix, :day, 1)
       ON CONFLICT (prefix, day) DO UPDATE SET n = doc_number_counters.n + 1 RETURNING n`,
      { replacements: { prefix, day }, transaction });
    const candidate = `${prefix}-${day}-${String(row.n).padStart(PAD, '0')}`;
    const [[hit]] = await sequelize.query(`SELECT 1 AS x FROM "${target[0]}" WHERE "${target[1]}" = :c LIMIT 1`, { replacements: { c: candidate }, transaction });
    if (!hit) return candidate;
  }
  throw new Error(`Could not find a free ${prefix} number for ${day}`);
}

module.exports = { nextDocNumber, shopDay };
