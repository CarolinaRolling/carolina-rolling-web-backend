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
  // Money already given back for an invoice's overpayment — refunded, or moved to client credit (T4)
  const settled = new Map();
  if (woIds && woIds.length) {
    const { sequelize } = require('../models');
    const [rows] = await sequelize.query(`
      SELECT "sourceWorkOrderId" AS id, SUM(amount)::numeric AS amt FROM refunds WHERE "voidedAt" IS NULL AND "sourceWorkOrderId" IN (:ids) GROUP BY 1
      UNION ALL
      SELECT "sourceWorkOrderId", SUM(amount)::numeric FROM credit_memos WHERE "voidedAt" IS NULL AND "sourceWorkOrderId" IN (:ids) GROUP BY 1`,
      { replacements: { ids: [...new Set(woIds)] }, transaction });
    for (const r of rows) settled.set(r.id, round2((settled.get(r.id) || 0) + (parseFloat(r.amt) || 0)));
  }
  const out = new Map();
  for (const [id, { wo, totals, amount }] of totalsMap) {
    const pay = payMap.get(id) || { recordsPaid: 0, payments: [], hasRecords: false, everHadRecords: false };
    const total = amount;
    const legacyPaid = (!pay.hasRecords && wo.paymentDate && total > 0) ? total : 0;
    const paid = round2(pay.recordsPaid + legacyPaid);
    // Money given back from this invoice (refunded, or moved to client credit) no longer pays it: if the
    // payment is later voided or the total rises again, the invoice owes that back instead of the
    // credit staying spendable on top (round 15, U3)
    const returned = settled.get(id) || 0;
    const netPaid = round2(paid - returned);
    const balance = round2(Math.max(0, total - netPaid));
    // Paid more than the invoice now comes to (the total dropped after payment) — audit T4. Not
    // clamped away: screens, the statement and the overpaid list show it as a credit owed to the client.
    const overpaid = pay.hasRecords ? round2(Math.max(0, netPaid - total)) : 0;
    out.set(id, {
      wo, totals, total, paid, balance, overpaid, returned,
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
  try { await reconcileOverpaymentCredit(woId, { transaction }); }
  catch (e) { console.warn('[ledger] overpayment credit check failed for', woId, e.message); }
  const b = await loadBalance(woId, { transaction });
  if (!b) return null;
  const { wo } = b;
  const recordsCoverTotal = b.total > 0 && (b.paid - b.legacyPaid - (b.returned || 0)) >= b.total - 0.01;
  if (recordsCoverTotal && !wo.paymentDate) {
    // Re-marked because the total changed (no payment in hand): take the details from the latest record
    const last = !paymentDate && b.payments.length ? [...b.payments].sort((x, y) => String(x.paymentDate).localeCompare(String(y.paymentDate))).pop() : null;
    await wo.update({
      paymentDate: paymentDate || (last && last.paymentDate) || new Date(),
      paymentMethod: paymentMethod || (last && last.paymentMethod) || null,
      paymentReference: paymentReference || (last && last.paymentReference) || null,
      paymentRecordedBy: recordedBy || (last && last.recordedBy) || 'admin',
    }, { transaction });
  } else if (!recordsCoverTotal && (wo.paymentDate || (wo.codPaid && b.total > 0)) && b.everHadRecords) {
    // the COD "paid" mark goes too, so pickup asks again (V3)
    await wo.update({ paymentDate: null, paymentMethod: null, paymentReference: null, paymentRecordedBy: null, codPaid: false }, { transaction });
  } else if (wo.codPaid && b.everHadRecords && (!b.hasRecords || round2(b.paid - (b.returned || 0)) <= 0.005)) {
    // Unpriced order whose payment(s) were all voided or given back: the COD-paid mark goes too (W1)
    await wo.update({ codPaid: false }, { transaction });
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
    // A legacy "marked paid" invoice (no payment record) counts as paid in full — it used to switch
    // this check off, so a $5,000 payment on a $2,190 invoice vanished (audit R14)
    const balanceUnknown = !b || (!hasPricedLines(b.totals) && !b.wo.iifExportedAt);
    // An invoice "marked paid" with the old button has no record of the money: recording the real
    // payment for it is fine (that record then replaces the mark), up to the invoice total
    const allowed = b && b.legacyPaid > 0 ? b.total : (b ? b.balance : 0);
    if (!balanceUnknown && b.total > 0 && amt > allowed + 0.005) {
      const extra = b.legacyPaid > 0
        ? `the invoice total for ${label(b.wo)} is ${fmt(b.total)}`
        : (b.balance <= 0.005 ? `${label(b.wo)} is already paid in full` : `only ${fmt(b.balance)} is still owed on ${label(b.wo)}`);
      throw new PaymentValidationError(`${fmt(amt)} is more than the invoice balance: ${extra}. To keep the extra as client credit, use Take Payment — any amount not applied to an invoice is held as credit.`);
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

/**
 * Record a refund (round 16, V1). Tied to what it pays back, so the money isn't counted twice:
 *  - creditMemoId: unused client credit is paid back — the memo shrinks by the refund (voided at 0);
 *    if the memo came from an invoice's overpayment the refund is tied to that invoice too
 *  - sourceWorkOrderId: an invoice's overpayment is paid back directly (≤ what is overpaid now)
 * Then the invoice is re-checked, so it no longer shows as overpaid.
 */
async function recordRefund({ clientId, clientName, date, amount, method, reference, reason, sourceWorkOrderId, sourceClientPaymentId, creditMemoId, recordedBy, unlinked = false } = {}) {
  const { sequelize, Refund, CreditMemo, WorkOrder } = require('../models');
  const amt = round2(parseFloat(amount));
  if (!(amt > 0)) throw new PaymentValidationError('Enter a refund amount greater than zero.');
  return sequelize.transaction(async (t) => {
    let woId = sourceWorkOrderId || null;
    let memo = null;
    if (creditMemoId) {
      memo = await CreditMemo.findByPk(creditMemoId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!memo || memo.voidedAt) throw new PaymentValidationError('That credit memo is not available.');
      const left = await refreshMemoRemaining(memo, t);
      if (amt > left + 0.005) throw new PaymentValidationError(`Only ${fmt(left)} of this credit is left to refund.`);
      woId = memo.sourceWorkOrderId || woId;
    } else if (woId) {
      await WorkOrder.findByPk(woId, { attributes: ['id'], transaction: t, lock: t.LOCK.UPDATE });
      const b = await loadBalance(woId, { transaction: t });
      if (!b) throw new PaymentValidationError('That invoice was not found.');
      if (amt > (b.overpaid || 0) + 0.005) throw new PaymentValidationError(`This invoice is overpaid by ${fmt(b.overpaid || 0)} — the refund can't be more than that.`);
    }
    // A refund tied to nothing, for a client who has open credit: that credit would stay spendable after
    // the money was paid back — ask which credit it pays back (or confirm it's separate) — review of round 16
    if (!memo && !woId && !unlinked && (clientId || clientName)) {
      const where = clientId ? { clientId } : { clientName };
      const open = await CreditMemo.findAll({ where: { ...where, voidedAt: null }, transaction: t });
      const openCredit = round2(open.reduce((sum, m) => sum + (parseFloat(m.remainingAmount) || 0), 0));
      if (openCredit > 0.005) {
        const e = new PaymentValidationError(`This client has ${fmt(openCredit)} of open credit. Refund it from the credit memo (Clients → Credits → Refund) so it isn't left to spend again — or confirm this refund is separate.`);
        e.code = 'CLIENT_HAS_CREDIT'; throw e;
      }
    }
    const wo = woId ? await WorkOrder.findByPk(woId, { attributes: ['id', 'clientId', 'clientName'], transaction: t }) : null;
    const refund = await Refund.create({
      clientId: clientId || (memo && memo.clientId) || (wo && wo.clientId) || null,
      clientName: clientName || (memo && memo.clientName) || (wo && wo.clientName),
      date: date || today(), amount: amt, method: method || 'check', reference: reference || null,
      reason: [reason, memo ? `Refund of credit memo (${fmt(amt)})` : null].filter(Boolean).join(' — ') || null,
      sourceWorkOrderId: woId, sourceClientPaymentId: sourceClientPaymentId || (memo && memo.sourceClientPaymentId) || null,
      creditMemoId: memo ? memo.id : null,
      recordedBy: recordedBy || 'admin',
    }, { transaction: t });
    if (memo) {
      const newAmount = round2((parseFloat(memo.amount) || 0) - amt);
      if (newAmount <= 0.005) await memo.update({ amount: 0, remainingAmount: 0, voidedAt: new Date(), reason: `${memo.reason || ''} — refunded` }, { transaction: t });
      else { await memo.update({ amount: newAmount }, { transaction: t }); await refreshMemoRemaining(memo, t); }
    }
    if (woId) await syncPaidFlag(woId, { transaction: t });
    return refund;
  });
}

/** Void a refund: the money wasn't paid back after all — the invoice shows the overpayment again (V1). */
async function voidRefund(refundId, { reason, user } = {}) {
  const { sequelize, Refund } = require('../models');
  return sequelize.transaction(async (t) => {
    const r = await Refund.findByPk(refundId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!r) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (r.voidedAt) return r;
    // W13: why and by whom, kept on the refund's own note (no separate column)
    const why = String(reason || '').trim().slice(0, 500);
    const stamp = `[Voided ${require('../utils/shopTime').shopDate()}${user ? ' by ' + user : ''}${why ? ': ' + why : ''}]`;
    await r.update({ voidedAt: new Date(), reason: r.reason ? `${r.reason} ${stamp}` : stamp }, { transaction: t });
    // Paid out of a credit memo: the credit goes back on it (un-voided if the refund had used it up)
    let creditRestored = null;
    if (r.creditMemoId) {
      const { CreditMemo, ClientPayment } = require('../models');
      const memo = await CreditMemo.findByPk(r.creditMemoId, { transaction: t, lock: t.LOCK.UPDATE });
      // The memo's check has since been voided (bounced), or the memo was voided for another reason:
      // that credit no longer exists, so the refund is voided but nothing is restored (W3)
      const src = memo && memo.sourceClientPaymentId ? await ClientPayment.findByPk(memo.sourceClientPaymentId, { attributes: ['id', 'voidedAt'], transaction: t }) : null;
      const refundedAway = memo && memo.voidedAt && /refunded$/.test(String(memo.reason || ''));
      if (!memo || (src && src.voidedAt) || (memo.voidedAt && !refundedAway)) {
        creditRestored = false;
      } else {
        const restoredAmt = round2((parseFloat(memo.amount) || 0) + (parseFloat(r.amount) || 0));
        await memo.update({ amount: restoredAmt, ...(refundedAway ? { voidedAt: null, reason: String(memo.reason).replace(/ — refunded$/, '') } : {}) }, { transaction: t });
        await refreshMemoRemaining(memo, t);
        creditRestored = true;
      }
    }
    if (r.sourceWorkOrderId) await syncPaidFlag(r.sourceWorkOrderId, { transaction: t });
    r.setDataValue('creditRestored', creditRestored);
    return r;
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

/**
 * Record "paid" on one invoice as a REAL payment record for what is still owed (round 10, audit R14).
 * Before: the COD pickup dialog and the one-click "record payment" only set paymentDate, so the
 * ledger treated the invoice as paid at whatever its total was, with no record of the money, and
 * the overpayment check was switched off for it.
 * amount: optional — defaults to the current balance. Refuses when nothing is owed, or when the
 * order isn't priced yet (then the amount must be given).
 */
async function recordFullPayment(woId, { amount, paymentDate, paymentMethod, paymentReference, notes, recordedBy, codPaid = false, ccProcessingType: sentCcType = null } = {}) {
  const { sequelize, WorkOrderPayment, WorkOrder } = require('../models');
  return sequelize.transaction(async (t) => {
    await WorkOrder.findByPk(woId, { transaction: t, lock: t.LOCK.UPDATE });
    const b = await loadBalance(woId, { transaction: t });
    if (!b) throw new PaymentValidationError('Work order not found.');
    // A voided order is outside receivables — money recorded on it would vanish (round 13, T5)
    if (b.wo.isVoided || b.wo.status === 'void') throw new PaymentValidationError('This order is voided, so no payment can be recorded on it. Restore it first.');
    let amt = amount != null && amount !== '' ? round2(parseFloat(amount)) : null;
    const unpriced = !hasPricedLines(b.totals) && !b.wo.iifExportedAt;
    if (amt == null) {
      // Not priced yet: the amount received must be entered. Before (round 10) the order was only
      // MARKED paid, and once priced it showed as paid in full with no money behind it (round 12, N13).
      if (unpriced) throw new PaymentValidationError('This order isn\'t priced yet, so enter the amount received.');
      amt = b.balance;
    }
    if (unpriced && amt > 0) {
      // The money is real: record it. When the order is priced, the ledger compares it with the
      // invoice (still owed, or a credit) — nothing is assumed paid in full.
      const p = await WorkOrderPayment.create({
        workOrderId: woId, paymentType: 'partial', amount: amt.toFixed(2),
        paymentDate: paymentDate || require('../utils/shopTime').shopDate(),
        paymentMethod: paymentMethod || null, paymentReference: paymentReference || null,
        notes: notes || 'Received before the order was priced', recordedBy: recordedBy || 'admin',
      }, { transaction: t });
      if (codPaid) await WorkOrder.update({ codPaid: true }, { where: { id: woId }, transaction: t });
      return p;
    }
    if (!(amt > 0)) {
      // Already paid in the ledger: the pickup just needs to know (no second payment record)
      if (codPaid && b.balance <= 0.005 && b.total > 0) {
        await WorkOrder.update({ codPaid: true }, { where: { id: woId }, transaction: t });
        return { markedOnly: true, reason: 'already_paid' };
      }
      throw new PaymentValidationError(b.balance <= 0.005 ? 'Nothing is owed on this invoice — it is already paid.' : 'Enter the amount paid.');
    }
    // A card payment of the invoice's "Total with Credit Card Fees": the extra is the surcharge (T6)
    let cardSurcharge = null, ccProcessingType = null, ccFeeAmount = null;
    if (/credit|card/i.test(String(paymentMethod || '')) && amt > b.balance + 0.005) {
      const charged = amt;
      const split = splitCardSurcharge(amt, b.balance, sentCcType);   // the card type sent wins a tie (W26)
      if (split) {
        cardSurcharge = split.surcharge; amt = split.applied;
        // the card type and Square's fee, as the ledger route stores them (U41)
        ccProcessingType = split.ccType;
        ccFeeAmount = (charged * (CARD_RATES[split.ccType] || CARD_RATES.in_person) + 0.15).toFixed(2);
      }
    }
    // W26: a card payment with no surcharge split off still keeps the card type sent and Square's fee
    if (!ccProcessingType && sentCcType && CARD_RATES[sentCcType] && /credit|card/i.test(String(paymentMethod || ''))) {
      ccProcessingType = sentCcType;
      ccFeeAmount = (amt * CARD_RATES[sentCcType] + 0.15).toFixed(2);
    }
    await validatePaymentApplications({ applications: [{ workOrderId: woId, amount: amt }], transaction: t });
    const p = await WorkOrderPayment.create({
      workOrderId: woId, paymentType: amt >= b.balance - 0.005 ? 'full' : 'partial', amount: amt.toFixed(2), cardSurcharge, ccProcessingType, ccFeeAmount,
      paymentDate: paymentDate || require('../utils/shopTime').shopDate(),
      paymentMethod: paymentMethod || null, paymentReference: paymentReference || null,
      notes: notes || null, recordedBy: recordedBy || 'admin',
    }, { transaction: t });
    const after = await syncPaidFlag(woId, { transaction: t, paymentDate: p.paymentDate, paymentMethod, paymentReference, recordedBy });
    // the pickup is released only once the order is paid in full
    if (codPaid && after && after.balance <= 0.005) await WorkOrder.update({ codPaid: true }, { where: { id: woId }, transaction: t });
    return p;
  });
}

/**
 * Overpayment moved to client credit, then the payment is voided / bounces or the total rises again:
 * the part of that credit memo not yet used is shrunk (or voided) so the client can't spend money the
 * invoice no longer has (round 15, U3). Credit already applied elsewhere can't be taken back here —
 * the invoice then shows it as owed (see `returned` in loadBalances).
 */
async function reconcileOverpaymentCredit(woId, { transaction } = {}) {
  const { CreditMemo, sequelize } = require('../models');
  // Cheap check first; the work itself always runs in a transaction with the memo rows locked
  // (a background totals refresh has none) — review of round 15
  const any = await CreditMemo.count({ where: { sourceWorkOrderId: woId, voidedAt: null }, transaction });
  if (!any) return;
  if (!transaction) return sequelize.transaction((t) => reconcileOverpaymentCredit(woId, { transaction: t }));
  // a memo being applied right now is skipped (its apply holds the lock); the next sync catches up
  const memos = await CreditMemo.findAll({ where: { sourceWorkOrderId: woId, voidedAt: null }, order: [['createdAt', 'DESC']], transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
  if (!memos.length) return;
  const b = await loadBalance(woId, { transaction });
  if (!b) return;
  // what the invoice can still give back: payments above its total, less what was refunded
  const [[r]] = await sequelize.query(`SELECT COALESCE(SUM(amount), 0)::numeric AS amt FROM refunds WHERE "voidedAt" IS NULL AND "sourceWorkOrderId" = :id`, { replacements: { id: woId }, transaction });
  const room = round2(Math.max(0, b.paid - b.total - (parseFloat(r.amt) || 0)));
  let excess = round2(memos.reduce((s, m) => s + (parseFloat(m.amount) || 0), 0) - room);
  for (const m of memos) {
    if (!(excess > 0.005)) break;
    const unused = round2(parseFloat(m.remainingAmount) || 0);
    const cut = round2(Math.min(unused, excess));
    if (!(cut > 0)) continue;
    const amount = round2((parseFloat(m.amount) || 0) - cut);
    const remaining = round2(unused - cut);
    if (amount <= 0.005) await m.update({ voidedAt: new Date(), remainingAmount: 0, reason: `${m.reason || ''} — voided: the invoice is no longer overpaid` }, { transaction });
    else await m.update({ amount, remainingAmount: remaining, reason: `${m.reason || ''} — reduced by $${cut.toFixed(2)}: the invoice is no longer overpaid by that much` }, { transaction });
    excess = round2(excess - cut);
  }
}

/**
 * Card surcharge (audit T6). The invoice PDF asks card payers for "Total with Credit Card Fees":
 * owed grossed up so the shop nets the invoice after Square's cut — (owed + $0.15) / (1 − rate), with
 * 2.6% in person and 3.5% keyed. When a card payment comes in above what is owed and matches one of
 * those figures (to the cent, ±$0.02), the excess is the surcharge — income — not an overpayment.
 * @returns {{applied:number, surcharge:number, ccType:string}|null}
 */
const CARD_RATES = { in_person: 0.026, manual: 0.035 };
function cardGrossUp(owed, ccType) {
  const pct = CARD_RATES[ccType] || CARD_RATES.in_person;
  return round2((round2(owed) + 0.15) / (1 - pct));
}
function splitCardSurcharge(amount, owed, ccType) {
  // owed: one invoice's amount, or a list (several invoices paid at once — each invoice's printed card
  // total carries its own $0.15, so the match is against the sum of the per-invoice figures)
  const list = (Array.isArray(owed) ? owed : [owed]).map(round2).filter(x => x > 0);
  const amt = round2(amount), due = round2(list.reduce((s, x) => s + x, 0));
  if (!list.length || !(amt > due + 0.005)) return null;
  const tol = 0.02 * list.length;
  const types = ccType && CARD_RATES[ccType] ? [ccType, ...Object.keys(CARD_RATES).filter(k => k !== ccType)] : Object.keys(CARD_RATES);
  for (const t of types) {
    const gross = round2(list.reduce((s, x) => s + cardGrossUp(x, t), 0));
    if (Math.abs(amt - gross) <= tol) return { applied: due, surcharge: round2(amt - due), ccType: t };
    // …or one card charge worked out on the combined amount (one $0.15) — round 15, U12
    if (list.length > 1 && Math.abs(amt - cardGrossUp(due, t)) <= 0.02) return { applied: due, surcharge: round2(amt - due), ccType: t };
  }
  return null;
}

module.exports = { recordRefund, voidRefund, reconcileOverpaymentCredit, splitCardSurcharge, cardGrossUp, recordFullPayment, loadPaymentsFor, loadBalances, loadBalance, syncPaidFlag, linkLegacyTwinPayments, validatePaymentApplications, PaymentValidationError,
  voidClientPayment, voidInvoicePayment, voidCreditMemo, applyCreditMemo };
