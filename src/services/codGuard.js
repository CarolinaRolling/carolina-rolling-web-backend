/**
 * codGuard — COD release enforced on the server (round 15, audit U10).
 *
 * Before, only the browser checked COD: POST /workorders/:id/cod-override just answered {ok:true}, and no
 * pickup / ship / status route looked at the client's terms, so a clerk calling the API (or any tablet
 * setting "shipped") released an unpaid COD order. Now:
 *  - a COD client's order that still owes money can't be picked up, shipped or set to "shipped" unless
 *    the request carries `codOverrideToken`, which /cod-override hands out after the right password
 *    (signed, tied to that order, valid 30 minutes);
 *  - "owes money" = not marked COD-paid, and the ledger balance is above a cent, or the order isn't
 *    priced yet and has no payment recorded.
 */
const crypto = require('crypto');
const { round2 } = require('./invoiceTotals');
const TTL_MS = 30 * 60 * 1000;
const key = () => process.env.JWT_SECRET || 'insecure-development-only-secret';
const sign = (s) => crypto.createHmac('sha256', key()).update('cod-override:' + s).digest('base64url');

function issueToken(woId) {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(`${woId}.${exp}`)}`;
}
function tokenValid(token, woId) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [expStr, sig] = token.split('.', 2);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = Buffer.from(sign(`${woId}.${exp}`));
  const got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const isCodTerms = (t) => { const u = String(t || '').toUpperCase(); return u.includes('COD') || u.includes('C.O.D'); };

/** 409 problem when this release isn't allowed, else null. */
async function codProblem(wo, req, { transaction } = {}) {
  if (!wo) return null;
  const { Client, sequelize } = require('../models');
  let client = wo.clientId ? await Client.findByPk(wo.clientId, { attributes: ['id', 'paymentTerms'], transaction }) : null;
  if (!client && wo.clientName) {
    client = await Client.findOne({ where: sequelize.where(sequelize.fn('lower', sequelize.fn('trim', sequelize.col('name'))), String(wo.clientName).trim().toLowerCase()), attributes: ['id', 'paymentTerms'], transaction });
  }
  if (!client || !isCodTerms(client.paymentTerms)) return null;
  const b = await require('./paymentLedger').loadBalance(wo.id, { transaction });
  // priced lines that add up to $0 (no-charge / warranty work) owe nothing (review of round 15)
  const priced = !!b && (b.total > 0 || require('./invoiceTotals').hasPricedLines(b.totals) || !!b.wo.iifExportedAt);
  // Priced: the ledger balance decides — a "COD paid" mark from an earlier deposit, a payment voided
  // since, or a charge added since must not release it (round 16, V3). Unpriced: money recorded
  // (or the COD-paid mark the office sets with it) releases it.
  // Unpriced with payment records: only live money (not voided, net of refunds) counts — the
  // paymentDate / COD-paid marks that came with it don't outlive it (W1). Marks on an order that
  // never had a record (legacy one-click) still release it.
  const hadRecords = !!b && b.everHadRecords;
  const owes = priced ? b.balance > 0.01 : !(b && round2(b.paid - (b.returned || 0)) > 0.005) && (hadRecords || (!wo.paymentDate && !wo.codPaid));
  if (!owes) return null;
  const token = (req.body && req.body.codOverrideToken) || req.headers['x-cod-override'];
  if (tokenValid(token, wo.id)) return null;
  const label = wo.drNumber ? `DR-${wo.drNumber}` : (wo.orderNumber || 'This order');
  // Tablets see no prices (W14): the amount only goes to office users and admin keys
  const showAmount = !req.apiKey || require('./keyScope').keyKind(req.apiKey) === 'admin';
  const detail = priced ? (showAmount ? ` ($${b.balance.toFixed(2)} owed)` : '') : ' (not priced yet)';
  return { status: 409, code: 'COD_UNPAID', message: `${label} is for a COD client and isn't paid${detail}. Record the payment, or have the office enter the COD override.` };
}

module.exports = { issueToken, tokenValid, codProblem, isCodTerms };
