/**
 * paymentLedger — the ONE place "how much has been paid on this invoice" is calculated (audit C2).
 *
 * How payments are stored:
 *   • work_order_payments (WorkOrderPayment) — one row per payment on one invoice. This is what the
 *     AR ledger, the invoice PDF payment history and QuickBooks read.
 *   • client_payments + payment_applications — a client check split across several invoices.
 *     Recording one ALSO writes a WorkOrderPayment per invoice; that row now carries
 *     paymentApplicationId so the two are known to be the same money.
 *
 * The old balance code added BOTH tables, so every client payment counted twice. Here:
 *   paid = Σ non-voided WorkOrderPayments
 *        + Σ applications that have NO linked WorkOrderPayment (and whose client payment isn't voided)
 * An application whose linked WorkOrderPayment was voided is therefore not counted either.
 *
 * Legacy rule (kept from the original ledger): a work order with paymentDate set and no payment
 * records at all was marked paid with the old one-click "record payment" — treat it as paid in full.
 */
const { round2, loadInvoiceTotals, hasPricedLines } = require('./invoiceTotals');

async function loadPaymentsFor(woIds, { transaction } = {}) {
  const ids = [...new Set((woIds || []).filter(Boolean))];
  const out = new Map();
  // hasRecords = at least one COUNTED payment; everHadRecords = any row at all, voided included
  ids.forEach(id => out.set(id, { recordsPaid: 0, payments: [], hasRecords: false, everHadRecords: false }));
  if (!ids.length) return out;
  const { WorkOrderPayment, PaymentApplication, ClientPayment } = require('../models');

  const [woPayments, apps] = await Promise.all([
    WorkOrderPayment.findAll({ where: { workOrderId: ids }, order: [['paymentDate', 'ASC'], ['createdAt', 'ASC']], transaction }),
    PaymentApplication.findAll({ where: { workOrderId: ids }, transaction }),
  ]);
  const cpIds = [...new Set(apps.map(a => a.clientPaymentId).filter(Boolean))];
  const cps = cpIds.length ? await ClientPayment.findAll({ where: { id: cpIds }, attributes: ['id', 'voidedAt'], transaction }) : [];
  const cpById = new Map(cps.map(c => [c.id, c]));
  const linkedAppIds = new Set(woPayments.map(p => p.paymentApplicationId).filter(Boolean));

  for (const p of woPayments) {
    const e = out.get(p.workOrderId);
    e.everHadRecords = true;
    if (p.voidedAt) continue;
    e.hasRecords = true;
    e.recordsPaid += parseFloat(p.amount) || 0;
    e.payments.push(p.toJSON());
  }
  for (const a of apps) {
    const e = out.get(a.workOrderId);
    e.everHadRecords = true;
    if (linkedAppIds.has(a.id)) continue;          // already counted via its WorkOrderPayment
    const cp = cpById.get(a.clientPaymentId);
    if (!cp || cp.voidedAt) continue;
    e.hasRecords = true;
    e.recordsPaid += parseFloat(a.amount) || 0;
  }
  for (const e of out.values()) e.recordsPaid = round2(e.recordsPaid);
  return out;
}

/**
 * Total, paid and balance for each work order, using the shared invoice total.
 * @returns {Promise<Map<string, {wo, totals, total, paid, balance, isPaid, legacyPaid, payments}>>}
 */
async function loadBalances(woIds, { transaction } = {}) {
  const [totalsMap, payMap] = await Promise.all([
    loadInvoiceTotals(woIds, { transaction }),
    loadPaymentsFor(woIds, { transaction }),
  ]);
  const out = new Map();
  for (const [id, { wo, totals, amount }] of totalsMap) {
    const pay = payMap.get(id) || { recordsPaid: 0, payments: [], hasRecords: false, everHadRecords: false };
    const total = amount;
    const legacyPaid = (!pay.hasRecords && wo.paymentDate && total > 0) ? total : 0;
    const paid = round2(pay.recordsPaid + legacyPaid);
    const balance = round2(Math.max(0, total - paid));
    out.set(id, {
      wo, totals, total, paid, balance,
      isPaid: total > 0 && balance <= 0.01,
      legacyPaid,
      payments: pay.payments,
      hasRecords: pay.hasRecords,
      everHadRecords: pay.everHadRecords,
    });
  }
  return out;
}

async function loadBalance(woId, opts) {
  return (await loadBalances([woId], opts)).get(woId) || null;
}

/**
 * Keep the work order's paymentDate flag in step with its payment records (screens and the
 * COD lists filter on it). Sets it when fully paid; clears it when the order has (or had) payment
 * records that no longer cover the total. Work orders that never had a payment record (legacy
 * one-click "paid") are left alone.
 */
async function syncPaidFlag(woId, { transaction, paymentDate, paymentMethod, paymentReference, recordedBy } = {}) {
  const b = await loadBalance(woId, { transaction });
  if (!b) return null;
  const { wo } = b;
  const recordsCoverTotal = b.total > 0 && (b.paid - b.legacyPaid) >= b.total - 0.01;
  if (recordsCoverTotal && !wo.paymentDate) {
    await wo.update({
      paymentDate: paymentDate || new Date(),
      paymentMethod: paymentMethod || null,
      paymentReference: paymentReference || null,
      paymentRecordedBy: recordedBy || 'admin',
    }, { transaction });
  } else if (!recordsCoverTotal && wo.paymentDate && b.everHadRecords) {
    await wo.update({ paymentDate: null, paymentMethod: null, paymentReference: null, paymentRecordedBy: null }, { transaction });
  }
  return b;
}

/**
 * One-time (idempotent) link of existing twin rows: each client-payment application written before
 * this fix has a WorkOrderPayment created in the same transaction with the same work order and
 * amount (seconds apart; we allow 5 minutes). Link them so they are counted once. Runs at boot and
 * after a backup restore; does nothing once everything is linked.
 */
async function linkLegacyTwinPayments(sequelize) {
  const [apps] = await sequelize.query(`
    SELECT pa.id, pa."workOrderId", pa.amount, pa."createdAt"
      FROM payment_applications pa
     WHERE NOT EXISTS (SELECT 1 FROM work_order_payments w WHERE w."paymentApplicationId" = pa.id)
     ORDER BY pa."createdAt" ASC`);
  let linked = 0;
  for (const a of apps) {
    const [cand] = await sequelize.query(`
      SELECT id FROM work_order_payments
       WHERE "workOrderId" = :wo AND amount = :amt AND "paymentApplicationId" IS NULL
         AND abs(extract(epoch from ("createdAt" - CAST(:at AS timestamptz)))) < 300
       ORDER BY abs(extract(epoch from ("createdAt" - CAST(:at AS timestamptz)))) ASC
       LIMIT 1`, { replacements: { wo: a.workOrderId, amt: a.amount, at: a.createdAt } });
    if (!cand.length) continue;
    await sequelize.query(
      `UPDATE work_order_payments SET "paymentApplicationId" = :app WHERE id = :id AND "paymentApplicationId" IS NULL`,
      { replacements: { app: a.id, id: cand[0].id } });
    linked++;
  }
  return { linked, unmatched: apps.length - linked };
}

// ─────────────────────── payment validation (audit H5) ───────────────────────

class PaymentValidationError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'PAYMENT_INVALID'; }
}
const norm = (s) => String(s || '').trim().toLowerCase();
const fmt = (n) => '$' + (Math.round(n * 100) / 100).toFixed(2);
const label = (wo) => wo.invoiceNumber ? `invoice #${wo.invoiceNumber}` : (wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber);

/**
 * Lock the invoices a payment touches (row locks, consistent order so two payments can't deadlock)
 * and check every amount BEFORE anything is written. Must run inside the payment's transaction;
 * a concurrent payment on the same invoice waits for this one, then sees its effect.
 *
 * Rules:
 *   • the applications can't add up to more than the payment;
 *   • each invoice must exist, not be voided, and belong to the paying client;
 *   • an invoice can't be paid past what is still owed. Not checked (allowed) when the balance can't
 *     be known: the order isn't priced yet (a deposit), or it was marked paid with the old one-click
 *     button that kept no payment record (the real check is being entered now).
 * @returns {Map<workOrderId, amount>} the per-invoice amounts (duplicates combined)
 */
async function validatePaymentApplications({ applications, paymentAmount, clientId, clientName, transaction }) {
  if (!transaction) throw new Error('validatePaymentApplications requires a transaction');
  const { WorkOrder } = require('../models');
  const perWo = new Map();
  for (const a of applications || []) {
    const amt = round2(parseFloat(a.amount));
    if (!(amt > 0)) continue;
    if (!a.workOrderId) throw new PaymentValidationError('Each application needs an invoice.');
    perWo.set(a.workOrderId, round2((perWo.get(a.workOrderId) || 0) + amt));
  }
  if (!perWo.size) return perWo;

  const applied = round2([...perWo.values()].reduce((s, v) => s + v, 0));
  if (paymentAmount !== undefined && applied > round2(paymentAmount) + 0.005) {
    throw new PaymentValidationError(`The amounts applied to invoices add up to ${fmt(applied)}, but the payment is only ${fmt(paymentAmount)}.`);
  }

  const ids = [...perWo.keys()].sort();
  const wos = await WorkOrder.findAll({ where: { id: ids }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  if (wos.length !== ids.length) throw new PaymentValidationError('One of the invoices no longer exists. Refresh and try again.');

  for (const wo of wos) {
    if (wo.isVoided || wo.status === 'void') throw new PaymentValidationError(`${label(wo)} is voided and can't take a payment.`);
    if (clientId || clientName) {
      const sameClient = (clientId && wo.clientId) ? wo.clientId === clientId : norm(wo.clientName) === norm(clientName);
      if (!sameClient) throw new PaymentValidationError(`${label(wo)} belongs to ${wo.clientName}, not to the client making this payment.`);
    }
  }

  const balances = await loadBalances(ids, { transaction });
  for (const id of ids) {
    const b = balances.get(id);
    const amt = perWo.get(id);
    const balanceUnknown = !b || b.legacyPaid > 0 || (!hasPricedLines(b.totals) && !b.wo.iifExportedAt);
    if (!balanceUnknown && b.total > 0 && amt > b.balance + 0.005) {
      const extra = b.balance <= 0.005 ? `${label(b.wo)} is already paid in full` : `only ${fmt(b.balance)} is still owed on ${label(b.wo)}`;
      throw new PaymentValidationError(`${fmt(amt)} is more than the invoice balance: ${extra}. To keep the extra as credit, use Take Payment and tick "Create credit memo".`);
    }
  }
  return perWo;
}

module.exports = { loadPaymentsFor, loadBalances, loadBalance, syncPaidFlag, linkLegacyTwinPayments, validatePaymentApplications, PaymentValidationError };
