/**
 * partNumbers — line numbers for work-order and estimate parts (audit M14).
 *
 * Before: a new part got "how many parts are there + 1". Two parts added at the same moment got the
 * same number, and after a delete that left a gap the next part repeated an existing number. The
 * reorder screen renumbered parts one at a time with no transaction.
 *
 * Now:
 *  - a new part gets MAX(partNumber) + 1, and if another add took that number a moment earlier the
 *    database's unique rule (one number per order / estimate, added at boot) rejects it and the add is
 *    retried with the next number;
 *  - reordering runs in one transaction (the unique rule is checked at commit, so swaps work).
 */
const UNIQUE_VIOLATION = '23505';

async function maxPartNumber(Model, fk, parentId, transaction) {
  return (await Model.max('partNumber', { where: { [fk]: parentId }, transaction })) || 0;
}

const isNumberClash = (e) => {
  const code = e && (e.parent?.code || e.original?.code);
  const c = e && (e.parent?.constraint || e.original?.constraint || '');
  return code === UNIQUE_VIOLATION && /part_?number|_number$|uq_(wop|ep)_/i.test(c);
};

/**
 * Create a part with the next free line number. `data` must contain the parent id under `fk`.
 * Inside a caller's transaction a clash can't be retried (Postgres aborts the transaction), so
 * callers holding a transaction should lock the parent row first.
 */
async function createWithNextPartNumber(Model, fk, data, options = {}) {
  const parentId = data[fk];
  for (let attempt = 0; ; attempt++) {
    const partNumber = (await maxPartNumber(Model, fk, parentId, options.transaction)) + 1;
    try {
      return await Model.create({ ...data, partNumber }, options);
    } catch (e) {
      if (!options.transaction && attempt < 25 && isNumberClash(e)) {
        await new Promise(r => setTimeout(r, 5 + Math.floor(Math.random() * 25 * (attempt + 1))));   // spread out simultaneous adds
        continue;
      }
      throw e;
    }
  }
}

/** Set part numbers 1..n in the given order, atomically. Ids not on this parent are ignored. */
async function reorderParts(Model, fk, parentId, partIds) {
  const { sequelize } = require('../models');
  return sequelize.transaction(async (transaction) => {
    const parts = await Model.findAll({ where: { [fk]: parentId }, attributes: ['id', 'partNumber'], order: [['partNumber', 'ASC']], transaction });
    const known = new Set(parts.map(p => p.id));
    const ordered = [...new Set(partIds)].filter(id => known.has(id));
    // anything the screen didn't send keeps its relative place after the listed ones
    for (const p of parts) if (!ordered.includes(p.id)) ordered.push(p.id);
    for (let i = 0; i < ordered.length; i++) {
      await Model.update({ partNumber: i + 1 }, { where: { id: ordered[i] }, transaction, hooks: false });
    }
  });
}

/** Close gaps after a delete (1..n by current order), atomically. */
async function renumberParts(Model, fk, parentId, { transaction } = {}) {
  const { sequelize } = require('../models');
  const run = async (t) => {
    const parts = await Model.findAll({ where: { [fk]: parentId }, attributes: ['id', 'partNumber'], order: [['partNumber', 'ASC'], ['createdAt', 'ASC']], transaction: t });
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].partNumber !== i + 1) await Model.update({ partNumber: i + 1 }, { where: { id: parts[i].id }, transaction: t, hooks: false });
    }
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

module.exports = { maxPartNumber, createWithNextPartNumber, reorderParts, renumberParts, isNumberClash };
