/**
 * Shapes the tablet app parses strictly (Gson). One bad value — heatBreakdown "notalist", a qty of
 * "2.5", progressCount −5 — used to make the whole /workorders list fail on every tablet (audit T39).
 * Writes are checked (400 on a bad value); reads for tablets are cleaned so old bad rows can't break them.
 */
function heatBreakdownProblem(v) {
  if (v === null) return null;
  if (!Array.isArray(v)) return 'heatBreakdown must be a list of { heat, qty, country }';
  if (v.length > 500) return 'heatBreakdown has too many rows';
  for (const r of v) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'each heatBreakdown row must be { heat, qty, country }';
    if (r.heat != null && typeof r.heat !== 'string' && typeof r.heat !== 'number') return 'heatBreakdown heat must be text';
    if (r.qty != null && r.qty !== '' && !(Number.isInteger(Number(r.qty)) && Number(r.qty) >= 0)) return 'heatBreakdown qty must be a whole number, 0 or more';
    if (r.country != null && typeof r.country !== 'string') return 'heatBreakdown country must be text';
  }
  return null;
}
function normalizeHeatBreakdown(v) {
  if (v === null || v === undefined) return v;
  if (!Array.isArray(v)) return null;
  return v.filter(r => r && typeof r === 'object' && !Array.isArray(r)).map(r => {
    const q = Number(r.qty);
    const out = { ...r, heat: r.heat == null ? '' : String(r.heat), qty: Number.isInteger(q) && q >= 0 ? q : 0 };
    if (r.country != null && typeof r.country !== 'string') out.country = String(r.country);
    return out;
  });
}
function progressCountProblem(v, quantity) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return 'progressCount must be a whole number, 0 or more';
  if (n > 1000000) return 'progressCount is too large';
  return null;
}
function normalizeProgressCount(v) {
  if (v === null || v === undefined) return v;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
module.exports = { heatBreakdownProblem, normalizeHeatBreakdown, progressCountProblem, normalizeProgressCount };
