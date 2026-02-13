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
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const found = execSync('find /app -name "chrome" -type f 2>/dev/null | head -5').toString().trim();
    if (found) return found.split('\n')[0];
  } catch (e) { /* ignore */ }
  throw new Error('Chrome not found. Add buildpack: heroku-community/chrome-for-testing');
}

/**
 * Extract owner name from the CDTFA result page.
 * Scrapes all text content from the result area and parses out the business/owner name.
 */
async function scrapeResultDetails(page) {
  try {
    // The CDTFA result page renders results in a container after submission.
    // Try to grab all visible text from span/div elements near the result area.
    // Common CDTFA result fields follow patterns like caption2_f-N or text in the result container.
    const allText = await page.evaluate(() => {
      const results = {};
      
      // Grab all spans that look like result fields (caption2_f-N pattern)
      for (let i = 1; i <= 20; i++) {
        const el = document.querySelector(`span#caption2_f-${i}`);
        if (el && el.textContent.trim()) {
          results[`field_${i}`] = el.textContent.trim();
        }
      }
      
      // Also try other common patterns
      const patterns = ['span[id*="caption"]', 'span[id*="f-"]', 'div[id*="result"]', 'td', 'label'];
      const seen = new Set();
      for (const sel of patterns) {
        document.querySelectorAll(sel).forEach(el => {
          const text = el.textContent.trim();
          if (text && text.length > 2 && text.length < 200 && !seen.has(text)) {
            seen.add(text);
          }
        });
      }
      results.allText = Array.from(seen).join(' | ');
      
      // Try to get all text from the main content area
      const mainContent = document.querySelector('#CONTROL_CONTAINER__0') || document.body;
      results.pageText = mainContent ? mainContent.innerText.substring(0, 3000) : '';
      
      return results;
    });

    // Parse owner name from the scraped content
    let ownerName = '';
    
    // Look through numbered fields for a name-like value
    // Typically: field_2 = status, field_3 or field_4 = owner/business name
    for (let i = 3; i <= 10; i++) {
      const val = allText[`field_${i}`];
      if (val && val.length > 2 && !val.toLowerCase().includes('seller') && !val.toLowerCase().includes('valid') && 
          !val.toLowerCase().includes('permit') && !val.toLowerCase().includes('closed') &&
          !val.toLowerCase().includes('search') && !val.toLowerCase().includes('verify') &&
          !val.toLowerCase().includes('account') && !val.toLowerCase().includes('identification') &&
          !/^\d+[-\d]*$/.test(val)) {
        ownerName = val;
        break;
      }
    }

    // If we didn't find it in numbered fields, search page text for name patterns
    if (!ownerName && allText.pageText) {
      const lines = allText.pageText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        // Look for lines that follow "Owner" or "Name" or "Business" labels
        if (/^(owner|business\s*name|DBA|registered\s*owner)/i.test(line)) {
          // Next meaningful line might be the name
          const idx = lines.indexOf(line);
          if (idx >= 0 && idx + 1 < lines.length) {
            const nextLine = lines[idx + 1].trim();
            if (nextLine.length > 2 && nextLine.length < 100) {
              ownerName = nextLine;
              break;
            }
          }
        }
      }
    }
    
    // If still no luck, look for lines that look like business names in page text
    if (!ownerName && allText.pageText) {
      const lines = allText.pageText.split('\n').map(l => l.trim()).filter(Boolean);
      // Find the status line, then the next non-trivial line after it is usually the business name
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes('valid') || lines[i].toLowerCase().includes('closed') || lines[i].toLowerCase().includes('not found')) {
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            const candidate = lines[j].trim();
            if (candidate.length > 3 && candidate.length < 100 && 
                !/^\d+$/.test(candidate) && !candidate.toLowerCase().includes('search') &&
                !candidate.toLowerCase().includes('verify') && !candidate.toLowerCase().includes('note:')) {
              ownerName = candidate;
              break;
            }
          }
          if (ownerName) break;
        }
      }
    }

    console.log('[CDTFA] Scraped result details:', JSON.stringify({ ownerName, fieldCount: Object.keys(allText).length }));
    return { ownerName, rawFields: allText };
  } catch (err) {
    console.error('[CDTFA] Failed to scrape result details:', err.message);
    return { ownerName: '', rawFields: {} };
  }
}

async function verifySinglePermit(permitNumber, options = {}) {
  const maxRetries = options.retries || 2;
  let lastError = null;

  let chromePath;
  try {
    chromePath = findChromePath();
  } catch (e) {
    return { permitNumber, status: 'error', rawResponse: e.message, ownerName: '', verifiedDate: new Date().toISOString(), error: e.message };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let browser = null;
    try {
      console.log(`[CDTFA] Verifying permit ${permitNumber} (attempt ${attempt + 1}/${maxRetries + 1}) using ${chromePath}`);

      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: 'new',
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

      // Scrape owner name and other details
      const details = await scrapeResultDetails(page);

      console.log(`[CDTFA] Permit ${permitNumber}: ${status} — "${rawResponse}" — Owner: "${details.ownerName}"`);
      await browser.close();

      return {
        permitNumber,
        status,
        rawResponse,
        ownerName: details.ownerName || '',
        rawFields: details.rawFields || {},
        verifiedDate: new Date().toISOString(),
        error: null
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
