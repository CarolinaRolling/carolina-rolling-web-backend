// Display numbering for parts + their services.
// Production parts get whole numbers (1, 2, 3...). Each linked service gets its
// parent's number with a suffix (1.1, 1.2...). Computed at render time only —
// the stored partNumber and the _linkedPartId links are never modified, so this
// is safe for existing work orders/estimates.

const SERVICE_TYPES = ['fab_service', 'shop_rate', 'rush_service', 'inspection'];

function linkOf(p) {
  return (p && (p._linkedPartId
    || (p.formData && (p.formData._linkedPartId || p.formData.linkedPartId)))) || null;
}

// Returns { display: {id -> "1"|"1.1"}, prodInt: {id -> 1,2,3 for production parts} }
function computeDisplayNumbers(parts) {
  const sorted = [...(parts || [])].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
  const display = {};
  const prodInt = {};
  let counter = 0;
  for (const p of sorted) {
    if (!SERVICE_TYPES.includes(p.partType)) {
      counter += 1;
      prodInt[p.id] = counter;
      display[p.id] = String(counter);
    }
  }
  const svcCount = {};
  for (const p of sorted) {
    if (SERVICE_TYPES.includes(p.partType)) {
      const parent = linkOf(p);
      if (parent && prodInt[parent] != null) {
        svcCount[parent] = (svcCount[parent] || 0) + 1;
        display[p.id] = `${prodInt[parent]}.${svcCount[parent]}`;
      } else {
        counter += 1;
        display[p.id] = String(counter);
      }
    }
  }
  return { display, prodInt };
}

module.exports = { computeDisplayNumbers, SERVICE_TYPES };
