/**
 * drGuard — rules for the manual DR-number tools (round 10, audit R17).
 *
 * Before: any logged-in user could release, void, change or jump a DR number, including on orders
 * already invoiced, in QuickBooks or paid. A released DR could be put on another job (invoice, lot
 * numbers and paperwork then pointed at the wrong order), a voided invoice kept counting as owed, and
 * one typo (+500) permanently moved the next automatic DR number.
 */
const LOCK_DR = 8410001;          // same key as services/numberAllocator (one DR writer at a time)
const MAX_DR_JUMP = 1000;         // like PO numbers: a manual DR more than this past the highest is refused

/** What ties this order to accounting: { invoiced, exported, payments } */
async function accountingState(models, wo, { transaction } = {}) {
  const { WorkOrderPayment, PaymentApplication, CreditMemoApplication } = models;
  const count = async (M, where) => (M ? M.count({ where, transaction }).catch(() => 0) : 0);
  const payments = (await count(WorkOrderPayment, { workOrderId: wo.id, voidedAt: null }))
    + (await count(PaymentApplication, { workOrderId: wo.id }))
    + (await count(CreditMemoApplication, { workOrderId: wo.id }));
  return { invoiced: !!wo.invoiceNumber, exported: !!wo.iifExportedAt, payments };
}

const isAdmin = (req) => req.user?.role === 'admin';

/** Anything left the shop: shipped/picked-up stamps or status, or ANY pickup (a partial pickup sets
 *  neither — its paperwork still carries this DR and its lots) (V7) */
function hasShipped(wo) {
  if (!wo) return false;
  if (wo.shippedAt || wo.pickedUpAt || ['shipped', 'archived', 'picked_up', 'delivered'].includes(wo.status)) return true;
  let ph = wo.pickupHistory;
  if (typeof ph === 'string') { try { ph = JSON.parse(ph); } catch (_) { ph = null; } }
  return Array.isArray(ph) && ph.length > 0;
}
const label = (wo) => (wo.drNumber ? `DR-${wo.drNumber}` : (wo.orderNumber || 'This order'));

/**
 * null if allowed, else { status, message }.
 * action: 'release' | 'void' | 'change'
 */
async function drActionProblem(models, req, wo, action, { transaction } = {}) {
  if (!wo) return null;
  const s = await accountingState(models, wo, { transaction });
  if (action === 'release') {
    if (!isAdmin(req)) return { status: 403, message: 'Only an admin can release a DR number.' };
    if (s.invoiced || s.exported || s.payments) return { status: 409, message: `${label(wo)} has an invoice or payments — its DR number can't be released for reuse. Void it instead.` };
    return null;
  }
  if (action === 'void') {
    if (s.payments) return { status: 409, message: `${label(wo)} has payment records. Void or move those payments first (Business → ledger), then void the order.` };
    if ((s.invoiced || s.exported) && !isAdmin(req)) return { status: 403, message: `${label(wo)} is invoiced${s.exported ? ' and in QuickBooks' : ''} — only an admin can void it.` };
    return null;
  }
  if (action === 'change') {
    // Shipped: its <DR>-n lot numbers are on the customer's certs — same rule as release (round 15, U15)
    if (hasShipped(wo)) {   // V7: a partial pickup counts too
      return { status: 409, message: `${label(wo)} has shipped (in full or in part) — its lot numbers are on the customer's paperwork, so its DR number can't be changed.` };
    }
    if (s.exported || s.payments) return { status: 409, message: `${label(wo)} is ${s.exported ? 'in QuickBooks' : 'paid or part-paid'} — its DR number can't be changed.` };
    if (s.invoiced && !isAdmin(req)) return { status: 403, message: `${label(wo)} is invoiced — only an admin can change its DR number.` };
    return null;
  }
  return null;
}

/** Refuse a manual DR far past the highest in use (a typo would move the automatic sequence forever) */
async function jumpProblem(models, newDR, { transaction } = {}) {
  const { DRNumber, WorkOrder } = models;
  const high = Math.max((await DRNumber.max('drNumber', { transaction })) || 0, (await WorkOrder.max('drNumber', { transaction })) || 0);
  if (high && newDR > high + MAX_DR_JUMP) {
    return { status: 400, message: `DR-${newDR} is more than ${MAX_DR_JUMP} past the highest DR in use (DR-${high}). Check for a typo — the next automatic DR number would jump there too.` };
  }
  return null;
}

async function lockDR(sequelize, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(:k)', { replacements: { k: LOCK_DR }, transaction });
}

module.exports = { drActionProblem, jumpProblem, lockDR, accountingState, hasShipped, MAX_DR_JUMP };
