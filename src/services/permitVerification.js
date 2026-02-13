const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');
const fs = require('fs');

const CDTFA_URL = 'https://onlineservices.cdtfa.ca.gov/?Link=PermitSearch';

const SELECTORS = {
  activityTypeDropdown: 'select#d-3',
  sellersPermitOptionValue: 'SITSUT',
  identificationNumberInput: 'input#d-4',
  submitButton: 'button#d-6',
  resultStatus: 'span#caption2_f-2',
};

function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    const p = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (fs.existsSync(p)) return p;
  }
  const names = ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
  for (const name of names) {
    try {
      const result = execSync(`which ${name} 2>/dev/null`).toString().trim();
      if (result) return result;
    } catch (e) { /* not found */ }
  }
  const candidates = [
    '/app/.chrome-for-testing/chrome-linux64/chrome',
    '/app/.chrome-for-testing/chrome-linux/chrome',
    '/app/.apt/usr/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try {
    const found = execSync('find /app -name "chrome" -type f 2>/dev/null | head -5').toString().trim();
    if (found) return found.split('\n')[0];
  } catch (e) { /* ignore */ }
  throw new Error('Chrome not found. Add buildpack: heroku-community/chrome-for-testing');
}

/**
 * Scrape result details from the CDTFA page after a permit lookup.
 * The page uses span#caption2_f-N for LABELS (e.g. "Owner Name")
 * and separate elements for the actual VALUES.
 */
async function scrapeResultDetails(page) {
  try {
    const allText = await page.evaluate(() => {
      const results = {};

      // 1. Grab label fields (span#caption2_f-N)
      for (let i = 1; i <= 20; i++) {
        const el = document.querySelector(`span#caption2_f-${i}`);
        if (el && el.textContent.trim()) {
          results[`label_${i}`] = el.textContent.trim();
        }
      }

      // 2. Try to get VALUE fields via multiple ID patterns
      for (let i = 1; i <= 20; i++) {
        // span#f-N (most common for read-only result values)
        let valEl = document.querySelector(`span#f-${i}`);
        if (valEl && valEl.textContent.trim()) { results[`value_${i}`] = valEl.textContent.trim(); continue; }
        // input#f-N
        valEl = document.querySelector(`input#f-${i}`);
        if (valEl && (valEl.value || '').trim()) { results[`value_${i}`] = valEl.value.trim(); continue; }
        // div#f-N
        valEl = document.querySelector(`div#f-${i}`);
        if (valEl && valEl.textContent.trim()) { results[`value_${i}`] = valEl.textContent.trim(); continue; }
      }

      // 3. d-N pattern (form inputs)
      for (let i = 1; i <= 20; i++) {
        let valEl = document.querySelector(`span#d-${i}`);
        if (valEl && valEl.textContent.trim()) { results[`d_span_${i}`] = valEl.textContent.trim(); }
        valEl = document.querySelector(`input#d-${i}`);
        if (valEl && (valEl.value || '').trim()) { results[`d_input_${i}`] = valEl.value.trim(); }
      }

      // 4. Look at parent containers of each label for adjacent value elements
      for (let i = 2; i <= 15; i++) {
        const labelEl = document.querySelector(`span#caption2_f-${i}`);
        if (!labelEl) continue;
        const parent = labelEl.closest('div') || labelEl.parentElement;
        if (!parent) continue;

        // Check siblings/children that are NOT the label
        const children = parent.querySelectorAll('span, input, div, td');
        for (const child of children) {
          if (child.id && child.id.startsWith('caption2_')) continue;
          const txt = (child.value || child.textContent || '').trim();
          if (txt && txt !== labelEl.textContent.trim() && txt.length > 1 && txt.length < 150) {
            results[`pair_${i}`] = txt;
            break;
          }
        }

        // Check grandparent for table-row style layouts (label cell → value cell)
        const grandparent = parent.parentElement;
        if (grandparent) {
          const nextSib = parent.nextElementSibling;
          if (nextSib) {
            const sibText = (nextSib.value || nextSib.textContent || '').trim();
            if (sibText && sibText.length > 1 && sibText.length < 150) {
              results[`sibling_${i}`] = sibText;
            }
          }
        }
      }

      // 5. Page text for fallback parsing
      const resultContainer = document.querySelector('#CONTROL_CONTAINER__0') || document.body;
      results.pageText = resultContainer ? resultContainer.innerText.substring(0, 4000) : '';

      return results;
    });

    console.log('[CDTFA] Raw scraped fields:', JSON.stringify(allText).substring(0, 2000));

    // Build label→value map
    const labelMap = {};
    for (const [key, val] of Object.entries(allText)) {
      if (key.startsWith('label_')) {
        const idx = key.replace('label_', '');
        // Try value_N, pair_N, sibling_N in order
        const value = allText[`value_${idx}`] || allText[`pair_${idx}`] || allText[`sibling_${idx}`] || '';
        // Only map if value is different from the label itself
        if (value && value !== val && !value.includes('Toggle Date') && !value.includes('Search')) {
          labelMap[val] = value;
        }
      }
    }

    console.log('[CDTFA] Label-value map:', JSON.stringify(labelMap));

    // Extract owner name: prefer "Owner Name" field, fallback to "DBA Name"
    let ownerName = labelMap['Owner Name'] || labelMap['DBA Name'] || '';

    // Fallback: parse pageText for label→value on next line
    if (!ownerName && allText.pageText) {
      const lines = allText.pageText.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === 'Owner Name') {
          // Scan forward for a real value (skip blanks, other labels)
          const skipLabels = ['DBA Name', 'City', 'Zip Code', 'Address', 'Suspension Begin', 'Suspension End', 'End Date', 'Start Date'];
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            const candidate = lines[j].trim();
            if (candidate && candidate.length > 2 && !skipLabels.includes(candidate) && !/^[\t\s]*$/.test(candidate)) {
              ownerName = candidate;
              break;
            }
          }
          break;
        }
      }
    }

    return { ownerName, rawFields: allText, labelMap };
  } catch (err) {
    console.error('[CDTFA] Failed to scrape result details:', err.message);
    return { ownerName: '', rawFields: {}, labelMap: {} };
  }
}

async function verifySinglePermit(permitNumber, options = {}) {
  const maxRetries = options.retries || 2;
  let lastError = null;

  let chromePath;
  try { chromePath = findChromePath(); } catch (e) {
    return { permitNumber, status: 'error', rawResponse: e.message, ownerName: '', verifiedDate: new Date().toISOString(), error: e.message };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let browser = null;
    try {
      console.log(`[CDTFA] Verifying permit ${permitNumber} (attempt ${attempt + 1}/${maxRetries + 1})`);

      browser = await puppeteer.launch({
        executablePath: chromePath, headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--single-process']
      });

      const page = await browser.newPage();
      page.setDefaultTimeout(30000);
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

      await page.goto(CDTFA_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector(SELECTORS.activityTypeDropdown, { timeout: 20000 });
      await page.select(SELECTORS.activityTypeDropdown, SELECTORS.sellersPermitOptionValue);
      await new Promise(r => setTimeout(r, 500));

      await page.waitForSelector(SELECTORS.identificationNumberInput, { timeout: 10000 });
      await page.click(SELECTORS.identificationNumberInput, { clickCount: 3 });
      await page.type(SELECTORS.identificationNumberInput, permitNumber);

      await page.click(SELECTORS.submitButton);
      await page.waitForSelector(SELECTORS.resultStatus, { timeout: 15000 });
      await new Promise(r => setTimeout(r, 2000));

      const rawResponse = await page.$eval(SELECTORS.resultStatus, el => el.textContent.trim());
      const status = parsePermitStatus(rawResponse);
      const details = await scrapeResultDetails(page);

      console.log(`[CDTFA] Permit ${permitNumber}: ${status} — "${rawResponse}" — Owner: "${details.ownerName}"`);
      await browser.close();

      return {
        permitNumber, status, rawResponse,
        ownerName: details.ownerName || '',
        rawFields: details.rawFields || {},
        labelMap: details.labelMap || {},
        verifiedDate: new Date().toISOString(), error: null
      };
    } catch (err) {
      lastError = err;
      console.error(`[CDTFA] Attempt ${attempt + 1} failed for ${permitNumber}:`, err.message);
      if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
      if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 3000)); }
    }
  }

  return {
    permitNumber, status: 'error', rawResponse: lastError ? lastError.message : 'Unknown error',
    ownerName: '', verifiedDate: new Date().toISOString(), error: lastError ? lastError.message : 'Verification failed after retries'
  };
}

function parsePermitStatus(rawText) {
  if (!rawText) return 'error';
  const lower = rawText.toLowerCase();
  if (lower.includes('valid') && lower.includes('seller')) return 'active';
  if (lower.includes('closed') || lower.includes('inactive')) return 'closed';
  if (lower.includes('not found') || lower.includes('no record') || lower.includes('invalid')) return 'not_found';
  if (lower.includes('revoked') || lower.includes('suspended')) return 'closed';
  if (rawText.length > 0) return 'unknown';
  return 'error';
}

async function verifyBatch(permits, onResult, delayMs = 60000) {
  console.log(`[CDTFA] Starting batch verification of ${permits.length} permits (${delayMs / 1000}s delay between each)`);
  for (let i = 0; i < permits.length; i++) {
    const { id, permitNumber } = permits[i];
    const result = await verifySinglePermit(permitNumber);
    result.clientId = id;
    if (onResult) { await onResult(result, i + 1, permits.length); }
    if (i < permits.length - 1) { await new Promise(r => setTimeout(r, delayMs)); }
  }
  console.log(`[CDTFA] Batch verification complete`);
}

function debugChromeInfo() {
  const info = { PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '(not set)', PATH: process.env.PATH || '(not set)', checks: [] };
  const paths = ['/app/.chrome-for-testing/chrome-linux64/chrome', '/app/.chrome-for-testing/chrome-linux/chrome', '/app/.chrome-for-testing/chrome', '/app/.apt/usr/bin/google-chrome', '/app/.apt/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const p of paths) { info.checks.push({ path: p, exists: fs.existsSync(p) }); }
  const names = ['chrome', 'google-chrome', 'chromium'];
  for (const name of names) { try { info.checks.push({ which: name, result: execSync(`which ${name} 2>/dev/null`).toString().trim() || '(not found)' }); } catch (e) { info.checks.push({ which: name, result: '(not found)' }); } }
  try { info.chromeForTestingDir = execSync('ls -laR /app/.chrome-for-testing/ 2>/dev/null').toString().substring(0, 2000); } catch (e) { info.chromeForTestingDir = '(directory not found)'; }
  try { info.findResults = execSync('find /app -name "chrome" -type f 2>/dev/null | head -10').toString().trim() || '(none found)'; } catch (e) { info.findResults = '(find failed)'; }
  return info;
}

module.exports = { verifySinglePermit, verifyBatch, parsePermitStatus, debugChromeInfo };
