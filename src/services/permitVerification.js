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

/**
 * Find Chrome executable path.
 */
function findChromePath() {
  // 1. Environment variable
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    const p = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log('[CDTFA] PUPPETEER_EXECUTABLE_PATH is set to:', p);
    if (fs.existsSync(p)) {
      console.log('[CDTFA] Confirmed file exists at:', p);
      return p;
    }
    console.log('[CDTFA] WARNING: File does NOT exist at:', p);
  }

  // 2. Try which for PATH-based installs (chrome-for-testing buildpack puts it on PATH)
  const names = ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
  for (const name of names) {
    try {
      const result = execSync(`which ${name} 2>/dev/null`).toString().trim();
      if (result) {
        console.log('[CDTFA] Found Chrome via which:', result);
        return result;
      }
    } catch (e) { /* not found */ }
  }

  // 3. Check common filesystem paths
  const candidates = [
    // chrome-for-testing buildpack
    '/app/.chrome-for-testing/chrome-linux64/chrome',
    '/app/.chrome-for-testing/chrome-linux/chrome',
    '/app/.chrome-for-testing/chrome',
    // google-chrome buildpack
    '/app/.apt/usr/bin/google-chrome',
    '/app/.apt/usr/bin/google-chrome-stable',
    '/app/.apt/opt/google/chrome/chrome',
    // jontewks puppeteer buildpack
    '/app/node_modules/puppeteer/.local-chromium/linux-*/chrome-linux/chrome',
    // System installs
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS local dev
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log('[CDTFA] Found Chrome at:', p);
      return p;
    }
  }

  // 4. Brute force search in /app for anything named 'chrome'
  try {
    const found = execSync('find /app -name "chrome" -type f 2>/dev/null | head -5').toString().trim();
    if (found) {
      const first = found.split('\n')[0];
      console.log('[CDTFA] Found Chrome via find:', first);
      return first;
    }
  } catch (e) { /* ignore */ }

  // Build a helpful error message
  let debugInfo = 'Chrome not found.';
  debugInfo += '\nPUPPETEER_EXECUTABLE_PATH=' + (process.env.PUPPETEER_EXECUTABLE_PATH || '(not set)');
  try {
    const lsApp = execSync('ls -la /app/.chrome-for-testing/ 2>/dev/null || echo "(dir not found)"').toString().trim();
    debugInfo += '\n/app/.chrome-for-testing/: ' + lsApp;
  } catch (e) { debugInfo += '\n/app/.chrome-for-testing/: (not accessible)'; }
  try {
    const pathBins = execSync('echo $PATH && which chrome google-chrome chromium 2>/dev/null || echo "(none on PATH)"').toString().trim();
    debugInfo += '\nPATH check: ' + pathBins;
  } catch (e) { /* ignore */ }

  throw new Error(debugInfo);
}

/**
 * Debug function — returns info about Chrome availability (for diagnostic endpoint)
 */
function debugChromeInfo() {
  const info = {
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '(not set)',
    PATH: process.env.PATH || '(not set)',
    checks: []
  };

  // Check env var path
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    info.checks.push({
      path: process.env.PUPPETEER_EXECUTABLE_PATH,
      exists: fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
    });
  }

  // Check common paths
  const paths = [
    '/app/.chrome-for-testing/chrome-linux64/chrome',
    '/app/.chrome-for-testing/chrome-linux/chrome',
    '/app/.chrome-for-testing/chrome',
    '/app/.apt/usr/bin/google-chrome',
    '/app/.apt/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const p of paths) {
    info.checks.push({ path: p, exists: fs.existsSync(p) });
  }

  // which checks
  const names = ['chrome', 'google-chrome', 'chromium'];
  for (const name of names) {
    try {
      const result = execSync(`which ${name} 2>/dev/null`).toString().trim();
      info.checks.push({ which: name, result: result || '(not found)' });
    } catch (e) {
      info.checks.push({ which: name, result: '(not found)' });
    }
  }

  // List /app/.chrome-for-testing if it exists
  try {
    const ls = execSync('ls -laR /app/.chrome-for-testing/ 2>/dev/null').toString();
    info.chromeForTestingDir = ls.substring(0, 2000);
  } catch (e) {
    info.chromeForTestingDir = '(directory not found)';
  }

  // find any chrome binaries
  try {
    const found = execSync('find /app -name "chrome" -type f 2>/dev/null | head -10').toString().trim();
    info.findResults = found || '(none found)';
  } catch (e) {
    info.findResults = '(find failed)';
  }

  return info;
}

/**
 * Verify a single seller's permit number against the CDTFA website.
 */
async function verifySinglePermit(permitNumber, options = {}) {
  const maxRetries = options.retries || 2;
  let lastError = null;

  let chromePath;
  try {
    chromePath = findChromePath();
  } catch (e) {
    return {
      permitNumber,
      status: 'error',
      rawResponse: e.message,
      verifiedDate: new Date().toISOString(),
      error: e.message
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let browser = null;
    try {
      console.log(`[CDTFA] Verifying permit ${permitNumber} (attempt ${attempt + 1}/${maxRetries + 1}) using ${chromePath}`);

      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--single-process'
        ]
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
      await new Promise(r => setTimeout(r, 1500));

      const rawResponse = await page.$eval(SELECTORS.resultStatus, el => el.textContent.trim());
      const status = parsePermitStatus(rawResponse);

      console.log(`[CDTFA] Permit ${permitNumber}: ${status} — "${rawResponse}"`);
      await browser.close();

      return { permitNumber, status, rawResponse, verifiedDate: new Date().toISOString(), error: null };
    } catch (err) {
      lastError = err;
      console.error(`[CDTFA] Attempt ${attempt + 1} failed for ${permitNumber}:`, err.message);
      if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
      if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 3000)); }
    }
  }

  return {
    permitNumber,
    status: 'error',
    rawResponse: lastError ? lastError.message : 'Unknown error',
    verifiedDate: new Date().toISOString(),
    error: lastError ? lastError.message : 'Verification failed after retries'
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
    if (i < permits.length - 1) {
      console.log(`[CDTFA] Waiting ${delayMs / 1000}s before next lookup...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.log(`[CDTFA] Batch verification complete`);
}

module.exports = { verifySinglePermit, verifyBatch, parsePermitStatus, debugChromeInfo };
