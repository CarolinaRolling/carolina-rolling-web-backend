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
  const { WorkOrderPayment, PaymentApplication, ClientPayment, CreditMemoApplication, CreditMemo } = require('../models');

  const [woPayments, apps, creditApps] = await Promise.all([
    WorkOrderPayment.findAll({ where: { workOrderId: ids }, order: [['paymentDate', 'ASC'], ['createdAt', 'ASC']], transaction }),
    PaymentApplication.findAll({ where: { workOrderId: ids }, transaction }),
    CreditMemoApplication.findAll({ where: { workOrderId: ids }, transaction }),
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
  // Credit memos applied to invoices: counted through their WorkOrderPayment row; an application
  // without one (shouldn't happen) still counts, unless it or its memo was voided.
  const linkedCreditIds = new Set(woPayments.map(p => p.creditMemoApplicationId).filter(Boolean));
  const memoIds = [...new Set(creditApps.map(c => c.creditMemoId))];
  const memos = memoIds.length ? await CreditMemo.findAll({ where: { id: memoIds }, attributes: ['id', 'voidedAt'], transaction }) : [];
  const memoById = new Map(memos.map(m => [m.id, m]));
  for (const c of creditApps) {
    const e = out.get(c.workOrderId);
    if (!e) continue;
    e.everHadRecords = true;
    if (linkedCreditIds.has(c.id) || c.voidedAt) continue;
    const m = memoById.get(c.creditMemoId);
    if (!m || m.voidedAt) continue;
    e.hasRecords = true;
    e.recordsPaid += parseFloat(c.amount) || 0;
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
       WHERE "workOrderId" = :wo AND amount = :amt AND "paymentApplicationId" IS NULL AND "creditMemoApplicationId" IS NULL
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

// ─────────────────── voids, unapply and credit memos (audit H6) ───────────────────
//
// Money in = client payments (checks) and per-invoice payments. A check that was split across
// invoices must stay fully accounted for: every dollar is either applied to an invoice or held as
// client credit (a credit memo). So:
//   • Voiding ONE invoice's share of a check (the Void button on the invoice) moves that amount to a
//     credit memo for the client — the check itself still exists.
//   • Voiding the WHOLE check (bounced, entered twice) voids every invoice share and any credit memo
//     it created.
//   • A credit memo can be applied to invoices; what's left is always amount − active applications.

// The shop's calendar date (Pacific), not UTC — an evening entry must not be dated tomorrow
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function lockOrdersFor(woIds, t) {
  const { WorkOrder } = require('../models');
  const ids = [...new Set(woIds.filter(Boolean))].sort();
  if (ids.length) await WorkOrder.findAll({ where: { id: ids }, order: [['id', 'ASC']], transaction: t, lock: t.LOCK.UPDATE });
  return ids;
}

async function refreshMemoRemaining(memo, t) {
  const { CreditMemoApplication } = require('../models');
  const apps = await CreditMemoApplication.findAll({ where: { creditMemoId: memo.id, voidedAt: null }, transaction: t });
  const used = apps.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  const remaining = round2(Math.max(0, (parseFloat(memo.amount) || 0) - used));
  await memo.update({ remainingAmount: remaining }, { transaction: t });
  return remaining;
}

/** Void a credit memo and everything applied from it. Invoices it paid go back to owing that amount. */
async function voidCreditMemoTx(memo, t, { reason } = {}) {
  const { CreditMemoApplication, WorkOrderPayment } = require('../models');
  const apps = await CreditMemoApplication.findAll({ where: { creditMemoId: memo.id, voidedAt: null }, transaction: t });
  const woIds = await lockOrdersFor(apps.map(a => a.workOrderId), t);
  const now = new Date();
  if (apps.length) {
    await CreditMemoApplication.update({ voidedAt: now }, { where: { id: apps.map(a => a.id) }, transaction: t });
    await WorkOrderPayment.update({ voidedAt: now }, { where: { creditMemoApplicationId: apps.map(a => a.id), voidedAt: null }, transaction: t });
  }
  await memo.update({ voidedAt: now, remainingAmount: 0, reason: reason ? `${memo.reason ? memo.reason + ' — ' : ''}VOIDED: ${reason}` : memo.reason }, { transaction: t });
  for (const id of woIds) await syncPaidFlag(id, { transaction: t });
  return { invoicesAffected: woIds.length, workOrderIds: woIds };
}

async function voidCreditMemo(memoId, { reason } = {}) {
  const { sequelize, CreditMemo } = require('../models');
  return sequelize.transaction(async (t) => {
    const memo = await CreditMemo.findByPk(memoId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!memo) { const e = new Error('Credit memo not found'); e.status = 404; throw e; }
    if (memo.voidedAt) throw new PaymentValidationError('This credit memo is already voided.');
    const r = await voidCreditMemoTx(memo, t, { reason });
    return { memo, ...r };
  });
}

/** Void a whole client payment (check): every invoice share, and any credit memo it created. */
async function voidClientPayment(clientPaymentId, { reason, user } = {}) {
  const { sequelize, ClientPayment, PaymentApplication, WorkOrderPayment, CreditMemo } = require('../models');
  return sequelize.transaction(async (t) => {
    const cp = await ClientPayment.findByPk(clientPaymentId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!cp) { const e = new Error('Payment not found'); e.status = 404; throw e; }
    if (cp.voidedAt) throw new PaymentValidationError('This payment is already voided.');
    const apps = await PaymentApplication.findAll({ where: { clientPaymentId: cp.id }, transaction: t });
    // Credit memos this check created (overpayment remainder or unapplied shares) go with it.
    // Locked before the work orders — same order as applyCreditMemo.
    const memos = await CreditMemo.findAll({ where: { sourceClientPaymentId: cp.id, voidedAt: null }, order: [['id', 'ASC']], transaction: t, lock: t.LOCK.UPDATE });
    const woIds = await lockOrdersFor(apps.map(a => a.workOrderId), t);
    const now = new Date();
    if (apps.length) {
      await WorkOrderPayment.update({ voidedAt: now }, { where: { paymentApplicationId: apps.map(a => a.id), voidedAt: null }, transaction: t });
    }
    for (const m of memos) await voidCreditMemoTx(m, t, { reason: 'source payment voided' });
    const note = `VOIDED ${today()}${user ? ' by ' + user : ''}${reason ? ': ' + reason : ''}`;
    await cp.update({ voidedAt: now, notes: cp.notes ? `${cp.notes}\n${note}` : note }, { transaction: t });
    for (const id of woIds) await syncPaidFlag(id, { transaction: t });
    return { payment: cp, invoicesAffected: woIds, creditMemosVoided: memos.length };
  });
}

/**
 * The Void button on one invoice payment.
 *   • a plain payment → voided
 *   • an invoice's share of a client check → voided, and the amount becomes client credit
 *   • a credit memo applied to the invoice → un-applied; the credit is available again
 */
async function voidInvoicePayment(workOrderPaymentId, { user } = {}) {
  const { sequelize, WorkOrderPayment, PaymentApplication, ClientPayment, CreditMemo, CreditMemoApplication, WorkOrder } = require('../models');
  return sequelize.transaction(async (t) => {
    // Find what this row belongs to without locking, then lock in the one order every payment path
    // uses — client payment → credit memo → work order → payment row — and re-check after locking.
    // (Locking the payment row first could deadlock with "void whole check" / "void credit memo",
    // and checking the check's status without a lock could create credit from a check being voided.)
    const peek = await WorkOrderPayment.findByPk(workOrderPaymentId, { transaction: t });
    if (!peek) { const e = new Error('Payment not found'); e.status = 404; throw e; }
    const app = peek.paymentApplicationId ? await PaymentApplication.findByPk(peek.paymentApplicationId, { transaction: t }) : null;
    const cp = app ? await ClientPayment.findByPk(app.clientPaymentId, { transaction: t, lock: t.LOCK.UPDATE }) : null;
    const ca = peek.creditMemoApplicationId ? await CreditMemoApplication.findByPk(peek.creditMemoApplicationId, { transaction: t }) : null;
    const memo = ca ? await CreditMemo.findByPk(ca.creditMemoId, { transaction: t, lock: t.LOCK.UPDATE }) : null;
    await lockOrdersFor([peek.workOrderId], t);
    const pmt = await WorkOrderPayment.findByPk(workOrderPaymentId, { transaction: t, lock: t.LOCK.UPDATE });
    if (pmt.voidedAt) throw new PaymentValidationError('This payment is already voided.');
    await pmt.update({ voidedAt: new Date() }, { transaction: t });
    let outcome = 'voided', creditMemo = null;

    if (cp && !cp.voidedAt) {
      // An invoice's share of a client check: the check still exists, so keep the money as credit
      const wo = await WorkOrder.findByPk(pmt.workOrderId, { attributes: ['invoiceNumber', 'drNumber'], transaction: t });
      const amount = round2(parseFloat(pmt.amount));
      creditMemo = await CreditMemo.create({
        clientId: cp.clientId, clientName: cp.clientName, date: today(), amount, remainingAmount: amount,
        reason: `Removed from ${wo?.invoiceNumber ? 'invoice #' + wo.invoiceNumber : 'DR-' + (wo?.drNumber || '?')} — ${cp.method || 'payment'}${cp.reference ? ' #' + cp.reference : ''}${user ? ' (by ' + user + ')' : ''}`,
        sourceClientPaymentId: cp.id,
      }, { transaction: t });
      outcome = 'moved_to_credit';
    } else if (ca && !ca.voidedAt) {
      // A credit memo applied to the invoice: un-apply it, the credit is available again
      await ca.update({ voidedAt: new Date() }, { transaction: t });
      if (memo && !memo.voidedAt) await refreshMemoRemaining(memo, t);
      creditMemo = memo;
      outcome = 'credit_unapplied';
    }
    await syncPaidFlag(pmt.workOrderId, { transaction: t });
    return { payment: pmt, outcome, creditMemo };
  });
}

/** Apply (part of) a credit memo to an invoice. */
async function applyCreditMemo(memoId, { workOrderId, amount, user } = {}) {
  const { sequelize, CreditMemo, CreditMemoApplication, WorkOrderPayment } = require('../models');
  return sequelize.transaction(async (t) => {
    const memo = await CreditMemo.findByPk(memoId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!memo) { const e = new Error('Credit memo not found'); e.status = 404; throw e; }
    if (memo.voidedAt) throw new PaymentValidationError('This credit memo is voided.');
    const remaining = await refreshMemoRemaining(memo, t);
    const amt = round2(parseFloat(amount));
    if (!(amt > 0)) throw new PaymentValidationError('Enter an amount greater than zero.');
    if (amt > remaining + 0.005) throw new PaymentValidationError(`Only ${fmt(remaining)} of this credit is left.`);
    await validatePaymentApplications({ applications: [{ workOrderId, amount: amt }], paymentAmount: remaining,
      clientId: memo.clientId, clientName: memo.clientName, transaction: t });
    const ca = await CreditMemoApplication.create({ creditMemoId: memo.id, workOrderId, amount: amt, appliedAt: today() }, { transaction: t });
    await WorkOrderPayment.create({
      workOrderId, amount: amt, paymentDate: today(), paymentMethod: 'credit_memo', paymentType: 'partial',
      paymentReference: 'Credit memo', notes: memo.reason || null, recordedBy: user || 'admin', creditMemoApplicationId: ca.id,
    }, { transaction: t });
    const left = await refreshMemoRemaining(memo, t);
    await syncPaidFlag(workOrderId, { transaction: t, paymentDate: today(), paymentMethod: 'credit_memo', recordedBy: user || 'admin' });
    return { application: ca, remaining: left };
  });
}

module.exports = { loadPaymentsFor, loadBalances, loadBalance, syncPaidFlag, linkLegacyTwinPayments, validatePaymentApplications, PaymentValidationError,
  voidClientPayment, voidInvoicePayment, voidCreditMemo, applyCreditMemo };
