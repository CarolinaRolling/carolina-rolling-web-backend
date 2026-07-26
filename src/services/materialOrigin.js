/**
 * Resolves country of origin for work order parts, for USMCA certification.
 *
 * The rule this encodes: rolling a bar or angle into a ring is a bending operation. It does
 * not cut, weld, or otherwise substantially transform the material, and it does not shift the
 * tariff heading — a rolled angle is still an angle. So the finished ring's origin is simply
 * the origin of the material that went into it. Nothing we do on the floor can make a
 * non-originating bar into an originating ring.
 *
 * That means the certificate is only as good as the heat-level origin data, which is why this
 * module refuses to guess. A part with no recorded origin comes back as an issue, not as USA.
 *
 * Where the data lives:
 *   part.heatCountry            — single-heat parts, ISO-2 code
 *   part.heatBreakdown[].country — split parts, one country per heat
 *
 * A split part whose heats came from different countries produces MULTIPLE certificate lines,
 * one per country, with the quantity from that country. Collapsing them to a single line would
 * misstate the origin of some of the pieces.
 */

const { isUsmcaCountry, countryName } = require('../constants/countries');

/**
 * Break a part into origin groups.
 * Returns [{ country, qty, heats: [] }] — country may be '' meaning unknown.
 */
function originGroups(part) {
  const breakdown = Array.isArray(part.heatBreakdown) ? part.heatBreakdown.filter(r => r && (r.heat || r.country)) : [];
  const partQty = parseInt(part.quantity) || 1;

  if (breakdown.length === 0) {
    return [{
      country: part.heatCountry || '',
      qty: partQty,
      heats: part.heatNumber ? [part.heatNumber] : [],
    }];
  }

  const byCountry = new Map();
  let assigned = 0;
  for (const row of breakdown) {
    const country = row.country || '';
    const qty = parseInt(row.qty) || 0;
    assigned += qty;
    if (!byCountry.has(country)) byCountry.set(country, { country, qty: 0, heats: [] });
    const g = byCountry.get(country);
    g.qty += qty;
    if (row.heat) g.heats.push(row.heat);
  }

  // If the heat quantities do not add up to the part quantity, the shortfall has no known
  // origin. Surface it rather than silently attributing it to whichever mill was listed first.
  if (assigned < partQty) {
    const missing = partQty - assigned;
    if (!byCountry.has('')) byCountry.set('', { country: '', qty: 0, heats: [] });
    byCountry.get('').qty += missing;
  }

  return Array.from(byCountry.values()).filter(g => g.qty > 0);
}

/**
 * Inspect the parts destined for a certificate and report anything that blocks certification.
 * Returns { ok, issues: [{ partNumber, clientPartNumber, type, detail }] }
 */
function checkOrigin(parts) {
  const issues = [];

  for (const part of parts) {
    const label = part.clientPartNumber || ('#' + (part.partNumber || '?'));
    const groups = originGroups(part);

    for (const g of groups) {
      if (!g.country) {
        issues.push({
          partNumber: part.partNumber,
          clientPartNumber: part.clientPartNumber || null,
          type: 'missing_origin',
          detail: `${label}: ${g.qty} pc(s) have no recorded country of origin.`,
        });
      } else if (!isUsmcaCountry(g.country)) {
        issues.push({
          partNumber: part.partNumber,
          clientPartNumber: part.clientPartNumber || null,
          type: 'non_usmca_origin',
          detail: `${label}: ${g.qty} pc(s) are ${countryName(g.country)} origin. Rolling does not confer origin, so these are not USMCA originating.`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Build certificate line items from parts, one line per part per country of origin.
 */
function buildOriginLineItems(parts, { goodsDescription = '', htsCode = '', guessHts = null } = {}) {
  const lines = [];

  for (const part of parts) {
    const fd = (part.formData && typeof part.formData === 'object') ? part.formData : {};
    const mat = (part._materialDescription || fd._materialDescription || part.materialDescription || '')
      .replace(/^\d+pc:\s*/i, '');
    const groups = originGroups(part);
    const multi = groups.length > 1;

    for (const g of groups) {
      let description = goodsDescription || mat;
      // When one part splits across countries, note the heats on the line so the certificate
      // ties back to the MTRs for that specific material.
      if (multi && g.heats.length) {
        description = `${description} (Heat ${g.heats.join(', ')})`;
      }
      lines.push({
        qty: g.qty,
        partNum: part.clientPartNumber || '',
        description,
        htsCode: (guessHts ? guessHts(part) : null) || htsCode,
        originCountry: g.country || '',
        heats: g.heats,
      });
    }
  }

  return lines;
}

module.exports = { originGroups, checkOrigin, buildOriginLineItems };
