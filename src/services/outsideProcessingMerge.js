/**
 * Merge an outside-processing list sent by a part form with what's stored (audit H15).
 *
 * Before: the part form sent back the whole list as it was when the form was opened. If a PO was
 * generated for one of the lines meanwhile (by the office, or the bulk "send all OP POs" button), the
 * save erased that PO number, its sent date and its inbound delivery link — so the PO existed but no
 * part pointed at it, and generating again issued a second PO for the same work.
 *
 * The PO fields are only ever set by the server (generate / cancel PO), never by the form, so for
 * every line the form sends back they are taken from the stored line. A line with a live PO can't be
 * dropped by a form save — the PO has to be cancelled first.
 */
const STAMPED = ['poNumber', 'poSentAt', 'inboundOrderId', 'cancelledPONumber', 'cancelled', 'cancelledAt', 'cancelledBy', 'cancelledReason'];

function mergeOutsideProcessing(stored, incoming) {
  if (!Array.isArray(incoming)) {                             // whole list cleared
    if (incoming == null) mergeOutsideProcessing(stored, []);  // (throws if a line has a live PO)
    return incoming;
  }
  const prev = Array.isArray(stored) ? stored : [];
  const byId = new Map(prev.filter(o => o && o.id != null).map(o => [String(o.id), o]));
  const out = incoming.map(op => {
    if (!op || op.id == null) return op;
    const old = byId.get(String(op.id));
    if (!old) {                                               // a new line: PO fields only come from the server
      const fresh = { ...op };
      for (const k of STAMPED) delete fresh[k];
      return fresh;
    }
    const merged = { ...op };
    for (const k of STAMPED) {
      if (k in old) merged[k] = old[k]; else delete merged[k];
    }
    return merged;
  });
  const keptIds = new Set(out.filter(o => o && o.id != null).map(o => String(o.id)));
  const dropped = prev.filter(o => o && o.id != null && o.poNumber && !o.cancelled && !keptIds.has(String(o.id)));
  if (dropped.length) {
    const e = new Error(`This part's outside processing ${dropped.map(o => o.serviceType || 'line').join(', ')} is on ${dropped.map(o => o.poNumber).join(', ')}. ` +
      `Cancel that PO first, then remove the line.`);
    e.status = 409;
    throw e;
  }
  return out;
}

module.exports = { mergeOutsideProcessing, STAMPED };
