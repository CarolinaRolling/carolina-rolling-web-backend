/**
 * deviceView — what a shop tablet sees of a work order (round 13, audit T36).
 *
 * Round 12 blocked the tablet's invoicing and invoice-total routes, but the ordinary work-order list and
 * detail still carried every price, payment, invoice number and invoice PDF link, so any tablet (or a
 * copied tablet key) could read the shop's pricing and customers' payments. The Android app uses none
 * of it. For device keys (not admin keys) those fields are removed from work-order responses, and
 * invoice and vendor PO documents are left out (W15).
 */
const keyScope = require('./keyScope');

const MONEY_KEYS = new Set([
  'grandTotal', 'subtotal', 'partsSubtotal', 'taxAmount', 'taxRate', 'taxExempt', 'taxExemptReason', 'taxExemptCertNumber',
  'truckingCost', 'truckingDescription', 'discountPercent', 'discountAmount', 'discountReason', 'discount',
  'minimumOverride', 'minimumOverrideReason', 'totalsComputedAt',
  'paymentDate', 'paymentMethod', 'paymentReference', 'paymentRecordedBy', 'codPaid', 'payments',
  'invoiceNumber', 'invoiceDate', 'invoicedBy', 'invoicePdfUrl', 'invoiceFileUrl', 'invoicePdfCloudinaryId', 'reusedInvoiceNumber',
  'iifExportedAt', 'iifBatchId', 'opTransports', 'shipmentCharges',
  'partTotal', 'laborRate', 'laborHours', 'laborTotal', 'materialUnitCost', 'materialMarkupPercent', 'materialTotal',
  'setupCharge', 'otherCharges', 'rollingCost', 'outsideProcessingCost', 'outsideProcessingMarkupPercent',
  'outsideProcessingTransportCost', 'outsideProcessingTransportMarkupPercent', 'outsideProcessingExpediteCost',
  'costPerPart', 'markup', 'expediteCost', 'totalCost',
]);
// Not money, but not the shop floor's business either: what an estimate link replaced (client, contacts)
const PRIVATE_KEYS = new Set(['estimateLinkSnapshot', '_estimateLinkRestore']);
const pf = require('../utils/partFields');
const MONEY_FD = /(price|cost|markup|total|labor|discount|fee|amount|expedite|emergency)/i;
// …but the shop must still see THAT a job is rushed (the tablet's rush card reads these), list counts
// and inspection measurements
const KEEP_FD = new Set(['_expediteEnabled', '_emergencyEnabled', '_emergencyDay', 'total', 'totalCount', 'totalPages', 'outOfSquareAmount']);
// Invoices, and vendor PO PDFs (purchase_order, outside_processing_po, transport_po: shop costs, W15)
const HIDDEN_DOC_TYPE = /invoice|purchase_order|(^|_)po$/i;
const isHiddenDocType = (t) => HIDDEN_DOC_TYPE.test(String(t || ''));
const INVOICE_DOC = (d) => d && typeof d === 'object' && isHiddenDocType(d.documentType);

function strip(v) {
  if (Array.isArray(v)) return v.filter(x => !INVOICE_DOC(x)).map(strip);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = {};
    for (const k of Object.keys(v)) {
      if (MONEY_KEYS.has(k) || PRIVATE_KEYS.has(k)) continue;
      // a stored bad value must not break the tablet's strict parser for the whole list (T39)
      if (k === 'heatBreakdown') { o[k] = pf.normalizeHeatBreakdown(v[k]); continue; }
      if (k === 'progressCount') { o[k] = pf.normalizeProgressCount(v[k]); continue; }
      if (k === 'formData' && v[k] && typeof v[k] === 'object') {
        const fd = {};
        for (const fk of Object.keys(v[k])) if (!PRIVATE_KEYS.has(fk) && (KEEP_FD.has(fk) || !MONEY_FD.test(fk))) fd[fk] = strip(v[k][fk]);
        o[k] = fd;
        continue;
      }
      // every money-looking key, not only "_" ones: estimateTotal, otherServicesCost, serviceCuttingCost,
      // recommendedLabor, expectedCost… came through (round 15, U7)
      if (MONEY_FD.test(k) && !KEEP_FD.has(k)) continue;
      o[k] = strip(v[k]);
    }
    return o;
  }
  return v;
}

// Same view for shipments and deliveries: a shipment create / link answered with the whole priced order
// (U7) — mounted on /api/shipments and /api/inbound too
async function deviceWorkOrderView(req, res, next) {
  if (!req.apiKey || keyScope.keyKind(req.apiKey) !== 'device') return next();
  // Opening a hidden work-order document (signed-url / download) is refused here, before the route (W15)
  const open = String(req.baseUrl || '').toLowerCase() === '/api/workorders' &&   // routing ignores case (review of round 17)
    /^(GET|HEAD)$/i.test(req.method)
    && String(req.path || '').match(/^\/([^/]+)\/documents\/([^/]+)\/(signed-url|download)\/?$/i);
  if (open) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID.test(open[1]) || !UUID.test(open[2])) return res.status(404).json({ error: { message: 'Document not found' } });
    try {
      const { WorkOrderDocument } = require('../models');
      const doc = await WorkOrderDocument.findOne({ where: { id: open[2], workOrderId: open[1] }, attributes: ['documentType'] });
      if (doc && isHiddenDocType(doc.documentType)) {
        const inv = /invoice/i.test(String(doc.documentType));
        return res.status(403).json({ error: { message: inv ? 'Invoices are not available on shop devices.' : 'Purchase orders are not available on shop devices.' } });
      }
    } catch (e) {
      return next(e);   // a database error must not let the file through
    }
  }
  // every answer, not only reads: a part or status update used to echo the prices back (review of round 13)
  const original = res.json.bind(res);
  res.json = (body) => {
    let plain = body;
    try { plain = JSON.parse(JSON.stringify(body)); } catch (_) { /* send as is */ }
    return original(strip(plain));
  };
  next();
}

module.exports = { deviceWorkOrderView, strip, MONEY_KEYS, isHiddenDocType };
