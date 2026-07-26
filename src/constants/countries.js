/**
 * Country of origin list — backend mirror of web-app/src/constants/countries.js.
 * Edit both. See that file for the rules on what "origin" means here.
 */

const COUNTRIES = [
  // USMCA parties first — these are the ones that matter for the certificate
  { code: 'US', name: 'United States', usmca: true },
  { code: 'CA', name: 'Canada', usmca: true },
  { code: 'MX', name: 'Mexico', usmca: true },

  // Common mill origins for steel, stainless and aluminum
  { code: 'BR', name: 'Brazil', usmca: false },
  { code: 'CN', name: 'China', usmca: false },
  { code: 'DE', name: 'Germany', usmca: false },
  { code: 'ES', name: 'Spain', usmca: false },
  { code: 'FI', name: 'Finland', usmca: false },
  { code: 'FR', name: 'France', usmca: false },
  { code: 'IN', name: 'India', usmca: false },
  { code: 'IT', name: 'Italy', usmca: false },
  { code: 'JP', name: 'Japan', usmca: false },
  { code: 'KR', name: 'South Korea', usmca: false },
  { code: 'MY', name: 'Malaysia', usmca: false },
  { code: 'NL', name: 'Netherlands', usmca: false },
  { code: 'PL', name: 'Poland', usmca: false },
  { code: 'RU', name: 'Russia', usmca: false },
  { code: 'SE', name: 'Sweden', usmca: false },
  { code: 'TH', name: 'Thailand', usmca: false },
  { code: 'TR', name: 'Turkey', usmca: false },
  { code: 'TW', name: 'Taiwan', usmca: false },
  { code: 'UA', name: 'Ukraine', usmca: false },
  { code: 'UK', name: 'United Kingdom', usmca: false },
  { code: 'VN', name: 'Vietnam', usmca: false },
  { code: 'ZA', name: 'South Africa', usmca: false },
  { code: 'OTHER', name: 'Other (see MTR)', usmca: false },
];

const USMCA_COUNTRIES = COUNTRIES.filter(c => c.usmca).map(c => c.code);

function countryName(code) {
  if (!code) return '';
  const hit = COUNTRIES.find(c => c.code === code);
  return hit ? hit.name : code;
}

function isUsmcaCountry(code) {
  return USMCA_COUNTRIES.includes(code);
}

module.exports = { COUNTRIES, USMCA_COUNTRIES, countryName, isUsmcaCountry };
