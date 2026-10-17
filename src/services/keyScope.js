/**
 * keyScope — what each kind of API key may reach, and which client's records a portal key owns
 * (round 9, audit R1 / R2 / R25).
 *
 * Before: most routers only checked that a key was valid. A customer-portal key could read every
 * client's ledger, payments, client list and shipments; a vendor key could write to internal routes;
 * portal document routes looked orders up by DR number without checking the key's client; and
 * client scoping matched names with "contains" (a key for "Co" saw almost everyone).
 *
 * Now API keys are denied by default. `routeAllowed` lists exactly what each key type is for:
 *   - vendor key (vendorName set):        /api/vendor-portal/* only
 *   - customer-portal key (clientName):   read-only: /api/portal/*, and its own work orders /
 *                                         estimates (list, detail, documents, files, PDF)
 *   - shop device (tablet / phone):        the endpoints the Android app calls (see ApiService.kt)
 *   - admin-permission integration key:   everything (as before)
 * A key with none of client / vendor / device / operator and no admin permission is treated as a
 * shop device. Logged-in users (JWT) are not affected.
 *
 * Ownership (`owns`, `scopeWhere`) is by the client's id when the key's client name matches a client
 * record exactly (ignoring case), else by exact name — never by partial match.
 */
const { Op, fn, col, where: sqlWhere } = require('sequelize');

const R = (s) => new RegExp('^/api' + s + '/?$');

// ── Shop devices: the Android app's endpoints ──
// Reads are the exact areas the app uses (round 12, audit N16: before, any tablet could read every
// estimate, the pricing / tax / payroll settings and the production reports).
const DEVICE_READ = [
  R('/(workorders|shipments|inbound)(/.*)?'),
  R('/operations/(my-queue|operators|workorders|assignments)'),
  R('/inspections/job/[^/]+'),
  R('/shop-supplies/qr/[^/]+'),
  R('/devices/capabilities'),
  R('/settings/(notification-email|warehouse-map|locations|printer-config)'),
  R('/clients/(search|check-notag)'),
];
// Inside those areas, the money screens are not for tablets
const DEVICE_READ_DENY = [
  R('/workorders/invoicing(/.*)?'),
  R('/workorders/[^/]+/(invoice-totals|shipment-charges)'),
  R('/workorders/linkable-estimates(/.*)?'),
];
// The Quotes tab — only on the estimator's device
const ESTIMATOR_READ = [R('/estimates/unsent-drafts')];
const DEVICE_WRITE = [
  ['POST|PUT|DELETE', R('/inbound(/[^/]+(/receive)?)?')],
  ['POST|DELETE', R('/operations/assign(/reorder|/[^/]+)?')],
  ['PATCH', R('/operations/tasks/[^/]+')],
  ['POST|PUT|DELETE', R('/settings/locations(/reset|/[^/]+)?')],
  ['POST', R('/settings/scrap-request')],
  ['PUT', R('/settings/notification-email')],
  // Exactly the shipment calls the app makes — not bulk-delete / bulk-archive / link (audit N16)
  ['POST', R('/shipments')],
  ['PUT|DELETE', R('/shipments/(?!bulk-)[^/]+')],
  ['POST', R('/shipments/[^/]+/(photos|documents|documents/register)')],
  ['DELETE', R('/shipments/[^/]+/(photos|documents)/[^/]+')],
  ['POST', R('/shop-supplies/[^/]+/consume')],
  ['POST', R('/workorders/[^/]+/(mark-complete|messages|presence)')],
  ['DELETE', R('/workorders/[^/]+/presence')],
  ['PUT', R('/workorders/[^/]+/status')],
  ['PUT', R('/workorders/[^/]+/parts/(?!reorder/?$)[^/]+')],   // one part, not /parts/reorder (V23)
  ['POST', R('/inspections/job(/[^/]+/add-unit)?')],
  ['PATCH', R('/inspections/unit/[^/]+')],
  ['POST', R('/devices/register')],
  ['POST', R('/estimates/[^/]+/reminder-(dismiss|snooze)')],   // estimator only (below)
];
// Reassigning operators' queues is the estimator's job (the app hides it from operators; now the
// server enforces it too — audit R30)
const ESTIMATOR_ONLY = [R('/operations/assign(/reorder|/[^/]+)?'), R('/estimates/[^/]+/reminder-(dismiss|snooze)')];

// ── Customer portal: read-only, its own records ──
const PORTAL_READ = [
  R('/portal/.+'),
  R('/workorders'), R('/workorders/(?<wo>[^/]+)'), R('/workorders/[^/]+/documents/[^/]+/download'),
  R('/estimates'), R('/estimates/(?<est>[^/]+)'), R('/estimates/[^/]+/files/[^/]+/(signed-url|download)'), R('/estimates/[^/]+/pdf'),
];

// Single-segment fixed routes (/workorders/archived, /estimates/trash…) would otherwise match "/:id"
// in PORTAL_READ — those are internal lists, not one record. Read from the routers themselves.
let fixedCache = null;
function fixedSegments() {
  if (fixedCache) return fixedCache;
  const words = (router) => new Set((router?.stack || [])
    .filter(l => l.route && l.route.methods?.get && /^\/[A-Za-z0-9_-]+$/.test(l.route.path))
    .map(l => l.route.path.slice(1).toLowerCase()));
  fixedCache = { wo: words(require('../routes/workorders')), est: words(require('../routes/estimates')) };
  return fixedCache;
}

// Same rule as the estimates routes: the estimator flag, or an admin-permission device key
const isEstimatorKey = (apiKey) => !!(apiKey && (apiKey.isEstimator || apiKey.permissions === 'admin'));

function keyKind(apiKey) {
  if (!apiKey) return null;
  if (apiKey.vendorName && !apiKey.deviceName) return 'vendor';
  if (apiKey.clientName && !apiKey.deviceName) return 'portal';
  if (apiKey.permissions === 'admin' && !apiKey.deviceName && !apiKey.operatorName) return 'admin';
  return 'device';
}

/** null when allowed, otherwise the reason (for a 403) */
function routeProblem(apiKey, method, originalUrl) {
  const kind = keyKind(apiKey);
  // Express matches routes ignoring case, so match the allowlists the same way (a portal key asking for
  // /workorders/Recently-Completed must not slip past the fixed-route check)
  const path = String(originalUrl || '').split('?')[0].replace(/\/{2,}/g, '/').toLowerCase();
  const m = String(method || 'GET').toUpperCase();
  const read = m === 'GET' || m === 'HEAD';
  if (kind === 'admin') return null;
  if (kind === 'vendor') {
    return /^\/api\/vendor-portal(\/|$)/.test(path) ? null : 'Vendor API keys can only use /api/vendor-portal.';
  }
  if (kind === 'portal') {
    if (!read) return 'Customer-portal API keys are read-only.';
    for (const re of PORTAL_READ) {
      const hit = path.match(re);
      if (!hit) continue;
      const g = hit.groups || {};
      if (g.wo && fixedSegments().wo.has(g.wo)) continue;
      if (g.est && fixedSegments().est.has(g.est)) continue;
      return null;
    }
    return 'This customer-portal API key can\'t use this endpoint.';
  }
  // device
  if (read) {
    if (DEVICE_READ_DENY.some(re => re.test(path))) return 'This device API key can\'t use this endpoint.';
    if (DEVICE_READ.some(re => re.test(path))) return null;
    if (ESTIMATOR_READ.some(re => re.test(path))) return isEstimatorKey(apiKey) ? null : 'Only the estimator\'s device can see quotes.';
    return 'This device API key can\'t use this endpoint.';
  }
  const ok = DEVICE_WRITE.some(([ms, re]) => ms.split('|').includes(m) && re.test(path));
  if (!ok) return 'This device API key can\'t use this endpoint.';
  if (ESTIMATOR_ONLY.some(re => re.test(path)) && !isEstimatorKey(apiKey)) return 'Only the estimator\'s device can do this (assign operators\' work, quote reminders).';
  return null;
}

// ── Portal ownership ──
async function keyClient(req) {
  if (req._keyClient) return req._keyClient;
  const name = String(req.apiKey?.clientName || '').trim().toLowerCase();
  let id = null;
  if (name) {
    const { Client } = require('../models');
    const c = await Client.findOne({ where: sqlWhere(fn('lower', fn('trim', col('name'))), name), attributes: ['id'] });
    id = c?.id || null;
  }
  req._keyClient = { name, id };
  return req._keyClient;
}

const isPortalKey = (req) => keyKind(req.apiKey) === 'portal';

/** Does the portal key on this request own `record` (has clientId / clientName)? Non-portal: true. */
async function owns(req, record) {
  if (!isPortalKey(req)) return true;
  if (!record) return false;
  const k = await keyClient(req);
  if (!k.name) return false;
  if (k.id && record.clientId && record.clientId === k.id) return true;
  return String(record.clientName || '').trim().toLowerCase() === k.name;
}

/** A where-condition limiting a list query to the portal key's client (`alias` = the model name). */
async function scopeWhere(req, alias) {
  const k = await keyClient(req);
  const byName = sqlWhere(fn('lower', fn('trim', col(`${alias}.clientName`))), k.name || '\u0000');
  return k.id ? { [Op.or]: [{ clientId: k.id }, byName] } : byName;
}

module.exports = { keyKind, routeProblem, owns, scopeWhere, isPortalKey };
