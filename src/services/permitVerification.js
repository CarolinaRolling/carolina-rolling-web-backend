const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');

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
 * Priority: PUPPETEER_EXECUTABLE_PATH env var > common system locations > which chrome
 */
function findChromePath() {
  // 1. Environment variable (set by Heroku buildpack or manually)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log('[CDTFA] Using Chrome from PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Try common locations — Heroku buildpacks, Linux, macOS
  const candidates = [
    '/app/.apt/usr/bin/google-chrome',
    '/app/.apt/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];

  const fs = require('fs');
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log('[CDTFA] Found Chrome at:', p);
      return p;
    }
  }

  // 3. Try which for PATH-based installs (chrome-for-testing buildpack)
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

  throw new Error(
    'Chrome not found. On Heroku, add the buildpack:\n' +
    '  heroku buildpacks:add -i 1 heroku-community/chrome-for-testing\n' +
    'Or set PUPPETEER_EXECUTABLE_PATH config var to your Chrome binary path.'
  );
}

/**
 * Verify a single seller's permit number against the CDTFA website.
 */
async function verifySinglePermit(permitNumber, options = {}) {
  const maxRetries = options.retries || 2;
  let lastError = null;

  // Find Chrome once before retry loop
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
      console.log(`[CDTFA] Verifying permit ${permitNumber} (attempt ${attempt + 1}/${maxRetries + 1})`);

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

      // Navigate to CDTFA verification page
      await page.goto(CDTFA_URL, { waitUntil: 'networkidle2', timeout: 45000 });

      // Wait for the form to render (JS-heavy page)
      await page.waitForSelector(SELECTORS.activityTypeDropdown, { timeout: 20000 });

      // Select "Sellers Permit" from dropdown
      await page.select(SELECTORS.activityTypeDropdown, SELECTORS.sellersPermitOptionValue);

      await new Promise(r => setTimeout(r, 500));

      // Enter permit number
      await page.waitForSelector(SELECTORS.identificationNumberInput, { timeout: 10000 });
      await page.click(SELECTORS.identificationNumberInput, { clickCount: 3 });
      await page.type(SELECTORS.identificationNumberInput, permitNumber);

      // Click search
      await page.click(SELECTORS.submitButton);

      // Wait for result
      await page.waitForSelector(SELECTORS.resultStatus, { timeout: 15000 });
      await new Promise(r => setTimeout(r, 1500));

      // Read the result text
      const rawResponse = await page.$eval(SELECTORS.resultStatus, el => el.textContent.trim());
      const status = parsePermitStatus(rawResponse);

      console.log(`[CDTFA] Permit ${permitNumber}: ${status} — "${rawResponse}"`);

      await browser.close();

      return {
        permitNumber,
        status,
        rawResponse,
        verifiedDate: new Date().toISOString(),
        error: null
      };
    } catch (err) {
      lastError = err;
      console.error(`[CDTFA] Attempt ${attempt + 1} failed for ${permitNumber}:`, err.message);
      if (browser) {
        try { await browser.close(); } catch (e) { /* ignore */ }
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  console.error(`[CDTFA] All retries exhausted for ${permitNumber}`);
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

    if (onResult) {
      await onResult(result, i + 1, permits.length);
    }

    if (i < permits.length - 1) {
      console.log(`[CDTFA] Waiting ${delayMs / 1000}s before next lookup...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`[CDTFA] Batch verification complete`);
}

module.exports = {
  verifySinglePermit,
  verifyBatch,
  parsePermitStatus
};
