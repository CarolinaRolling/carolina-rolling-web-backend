/**
 * staffRoles — the one list of what only an admin may do (round 12, audit N10).
 *
 * Before: admin checks were scattered through the routes, and many were missing. Any logged-in user
 * could change where the daily business e-mails go, read and edit employee pay rates and payroll,
 * enter bills, connect or retune the e-mail scanner's mailboxes, create credit memos and refunds,
 * void payments and merge clients or vendors.
 *
 * Now `authenticate` checks every request against ADMIN_ONLY below, after the API-key allowlist.
 * The web app already shows these screens only to admins (Business Center, Settings, Shop Config);
 * this makes the server agree. Ordinary shop work — recording payments, applying an existing credit,
 * work orders, estimates, receiving, invoicing — is unchanged.
 *
 * An admin is a user with role 'admin', or an API key with admin permission. A few entries also let
 * the estimator's device in (see EXCEPT).
 */
const R = (s) => new RegExp('^/api' + s + '/?$', 'i');
const ANY = 'GET|POST|PUT|PATCH|DELETE';
const WRITE = 'POST|PUT|PATCH|DELETE';

const ADMIN_ONLY = [
  // Business Center: employees, payroll, bills (AP), the general ledger
  [ANY, R('/business/(employees|payroll)(/.*)?')],
  [ANY, R('/business/liabilities(/.*)?')],
  [ANY, R('/business/general-ledger')],
  // Bills found by the Com Center scanner become Accounts Payable when approved
  ['PATCH', R('/com-center/bills/[^/]+/status')],
  ['POST', R('/com-center/bills/scan')],
  // Money corrections: credit memos, refunds, voiding payments
  ['POST|DELETE', R('/business/credit-memos(/[^/]+)?')],
  ['POST|DELETE', R('/business/refunds(/[^/]+)?')],
  ['POST', R('/business/client-payments/[^/]+/void')],
  ['DELETE', R('/business/ledger/payments/[^/]+')],
  // An invoice's overpayment moved to client credit makes a credit memo, like the memos above (U40)
  ['POST', R('/business/ledger/[^/]+/overpayment-to-credit')],
  // Releasing or deleting a PO number (its deliveries go with it) — round 13, T15
  ['DELETE', R('/po-numbers/[^/]+/release')],
  ['DELETE', R('/po-numbers/[^/]+')],
  // Where business e-mail goes
  ['PUT', R('/settings/(notification-email|schedule-email)')],
  // E-mail scanner mailboxes and their tuning
  ['GET', R('/email-scanner/oauth/start')],
  [WRITE, R('/email-scanner/accounts(/.*)?')],
  ['PUT', R('/email-scanner/general-notes')],
  // Merging clients / vendors rewrites references across the database (R20)
  ['POST', R('/(clients|vendors)/[^/]+/merge')],
];

// Applying an existing credit memo is ordinary AR work — not admin-only
const EXCEPT = [
  ['POST', R('/business/credit-memos/[^/]+/apply')],
];
// The estimator's tablet may set the new-shipment notification address (its Settings screen does)
const ESTIMATOR_DEVICE_OK = [['PUT', R('/settings/notification-email')]];

const matches = (list, m, path) => list.some(([ms, re]) => ms.split('|').includes(m) && re.test(path));

function isAdminCaller(req) {
  if (req.user && req.user.role === 'admin') return true;
  if (req.apiKey && req.apiKey.permissions === 'admin') return true;
  return false;
}

/** null when allowed, otherwise the reason (for a 403) */
function adminProblem(req) {
  const path = String(req.originalUrl || '').split('?')[0].replace(/\/{2,}/g, '/');
  let m = String(req.method || 'GET').toUpperCase();
  if (m === 'HEAD') m = 'GET';   // Express runs GET handlers for HEAD (round 15, U37)
  if (!matches(ADMIN_ONLY, m, path) || matches(EXCEPT, m, path)) return null;
  if (isAdminCaller(req)) return null;
  if (req.apiKey && req.apiKey.isEstimator && matches(ESTIMATOR_DEVICE_OK, m, path)) return null;
  return 'Only an admin can do this.';
}

module.exports = { adminProblem, isAdminCaller, ADMIN_ONLY };
