/**
 * lotNumbers — automatic lot numbers <DR>-<n> that never repeat within one order (round 16, audit V6).
 *
 * Lots used to be <DR>-<line number on screen>. Lines are renumbered (delete a part, add a standalone
 * service line), so a new part could get a lot another part on the order already carries — certs then
 * showed one lot on two parts. Stored lots are never changed; only the NEW lot is chosen here.
 *
 * Round 17:
 *  - W6: work_orders.lotSuffixHighWater remembers the highest suffix ever handed out on the order, so a
 *    deleted part's lot is never issued again (and Undo of that delete can't make a live duplicate).
 *    Only "<current DR>-n" lots with n of 1-9 digits count (a DR change renames the order's lots, and the
 *    mark itself carries over).
 *  - W17: the choice runs under a row lock on the work order, so parallel adds can't share a lot.
 *  - W18: fillMissingLots() gives parts without a lot one when the order first gets a DR.
 */
const { Op } = require('sequelize');

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Highest numeric suffix n among lots "<dr>-n" in the list, 0 if none.
 */
function highestSuffix(lots, drNumber) {
  // at most 9 digits: a longer suffix (a customer's "77-20241015001") is not ours and won't fit an INTEGER
  const re = new RegExp(`^${escapeRe(String(drNumber).trim())}-(\\d{1,9})$`);
  let max = 0;
  for (const l of lots) {
    const m = re.exec(String(l || '').trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}


async function withTx(sequelize, transaction, fn) {
  return transaction ? fn(transaction) : sequelize.transaction(fn);
}

/**
 * Pick the lot for a new/blank part: `${dr}-${preferredSuffix}` if that lot was never handed out on the
 * order (numeric suffix above the order's high-water mark, or a dotted service suffix no live part has),
 * else `${dr}-${high-water + 1}`. Raises the order's high-water mark (W6) under a row lock on the order
 * (W17); without opts.transaction it runs in (and commits) its own short transaction.
 * @param opts.transaction
 * @param opts.excludePartId the part being updated (its own blank lot doesn't count)
 * @param opts.reserved      extra lots already handed out in this batch (not yet saved) — mutated: the
 *                           chosen lot is added, so a loop over several new parts gets distinct lots
 * @param opts.models        defaults to require('../models')
 */
async function nextLotNumber(workOrderId, drNumber, preferredSuffix, { transaction, excludePartId = null, reserved = null, models = null } = {}) {
  if (!drNumber) return null;
  const { WorkOrderPart } = models || require('../models');
  const sequelize = WorkOrderPart.sequelize;
  const lot = await withTx(sequelize, transaction, async (t) => {
    // W17: one lot chooser per order at a time
    const [[wo]] = await sequelize.query(`SELECT "lotSuffixHighWater" AS hw FROM work_orders WHERE id = :id FOR UPDATE`,
      { replacements: { id: workOrderId }, transaction: t });
    const where = { workOrderId, lotNumber: { [Op.ne]: null } };
    if (excludePartId) where.id = { [Op.ne]: excludePartId };
    const rows = await WorkOrderPart.findAll({ where, attributes: ['lotNumber'], transaction: t });
    const used = rows.map(r => String(r.lotNumber || '').trim()).filter(Boolean);
    if (reserved) for (const l of reserved) used.push(String(l).trim());
    const usedSet = new Set(used);
    const dr = String(drNumber).trim();
    // only this order's DR prefix counts — a customer lot "4471-22" must not move the mark (W6 review)
    const hw = Math.max(Number(wo && wo.hw) || 0, highestSuffix(used, dr));
    const pref = preferredSuffix != null ? String(preferredSuffix).trim() : '';
    let chosen = null, n = null;
    if (/^\d{1,9}$/.test(pref)) {
      // W6: a whole-number suffix at or below the high-water mark was issued before (maybe to a deleted part)
      if (parseInt(pref, 10) > hw && !usedSet.has(`${dr}-${pref}`)) { n = parseInt(pref, 10); chosen = `${dr}-${n}`; }
    } else if (pref && !usedSet.has(`${dr}-${pref}`)) chosen = `${dr}-${pref}`;   // service line "1.1"
    if (!chosen) { n = hw + 1; chosen = `${dr}-${n}`; }
    const newHw = Math.max(hw, n || 0);
    if (wo && newHw !== (Number(wo.hw) || 0)) {
      await sequelize.query(`UPDATE work_orders SET "lotSuffixHighWater" = :n WHERE id = :id`,
        { replacements: { n: newHw, id: workOrderId }, transaction: t });
    }
    return chosen;
  });
  if (reserved && typeof reserved.add === 'function') reserved.add(lot);
  else if (Array.isArray(reserved)) reserved.push(lot);
  return lot;
}

/**
 * W6: a lot set by hand / copied from an estimate ("<dr>-n") raises the order's high-water mark, so that
 * suffix is not handed out again after the part is deleted. No-op for other formats.
 */
async function noteLotNumber(workOrderId, lotNumber, { transaction, models = null } = {}) {
  // "<this order's DR>-n" with n of at most 9 digits; anything else (customer lots) is ignored
  const m = /^(\d+)-(\d{1,9})$/.exec(String(lotNumber || '').trim());
  if (!m || !workOrderId) return;
  const { WorkOrderPart } = models || require('../models');
  await WorkOrderPart.sequelize.query(`UPDATE work_orders SET "lotSuffixHighWater" = :n
    WHERE id = :id AND "drNumber"::text = :dr AND COALESCE("lotSuffixHighWater", 0) < :n`,
    { replacements: { n: parseInt(m[2], 10), dr: String(parseInt(m[1], 10)), id: workOrderId }, transaction });
}

/**
 * W18: give every part on the order that has no lot one (<DR>-<line>, same rules as nextLotNumber), in
 * line order. Used when the order gets its DR after parts were added. Returns how many were filled.
 */
async function fillMissingLots(workOrderId, drNumber, { transaction, models = null } = {}) {
  if (!drNumber || !workOrderId) return 0;
  const mdl = models || require('../models');
  const { WorkOrderPart } = mdl;
  const { computeDisplayNumbers } = require('./partNumbering');
  return withTx(WorkOrderPart.sequelize, transaction, async (t) => {
    const parts = await WorkOrderPart.findAll({ where: { workOrderId }, attributes: ['id', 'partNumber', 'partType', 'formData', 'lotNumber'], order: [['partNumber', 'ASC']], transaction: t });
    const blank = parts.filter(p => !p.lotNumber || !String(p.lotNumber).trim());
    if (!blank.length) return 0;
    let display = {};
    try { display = computeDisplayNumbers(parts.map(p => ({ id: p.id, partNumber: p.partNumber, partType: p.partType, formData: p.formData }))).display || {}; } catch (_) { display = {}; }
    const batch = new Set();
    for (const p of blank) {
      const lot = await nextLotNumber(workOrderId, drNumber, display[p.id] || p.partNumber, { transaction: t, reserved: batch, models: mdl });
      await WorkOrderPart.update({ lotNumber: lot }, { where: { id: p.id }, transaction: t, hooks: false });
    }
    return blank.length;
  });
}

module.exports = { nextLotNumber, highestSuffix, noteLotNumber, fillMissingLots };
