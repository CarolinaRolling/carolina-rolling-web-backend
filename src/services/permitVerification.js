const puppeteer = require('puppeteer');

const CDTFA_URL = 'https://onlineservices.cdtfa.ca.gov/?Link=PermitSearch';

const SELECTORS = {
  activityTypeDropdown: 'select#d-3',
  sellersPermitOptionValue: 'SITSUT',
  identificationNumberInput: 'input#d-4',
  submitButton: 'button#d-6',
  resultStatus: 'span#caption2_f-2',
};

/**
 * Verify a single seller's permit number against the CDTFA website.
 * @param {string} permitNumber - Format: 999-999999
 * @param {object} options - { retries: 2 }
 * @returns {{ permitNumber, status, rawResponse, verifiedDate, error }}
 */
async function verifySinglePermit(permitNumber, options = {}) {
  const maxRetries = options.retries || 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let browser = null;
    try {
      console.log(`[CDTFA] Verifying permit ${permitNumber} (attempt ${attempt + 1}/${maxRetries + 1})`);

      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });

      const page = await browser.newPage();
      page.setDefaultTimeout(30000);

      // Navigate to CDTFA verification page
      await page.goto(CDTFA_URL, { waitUntil: 'networkidle2', timeout: 45000 });

      // Wait for the form to render (JS-heavy page)
      await page.waitForSelector(SELECTORS.activityTypeDropdown, { timeout: 20000 });

      // Select "Sellers Permit" from dropdown
      await page.select(SELECTORS.activityTypeDropdown, SELECTORS.sellersPermitOptionValue);

      // Small delay for any dependent fields to update
      await new Promise(r => setTimeout(r, 500));

      // Wait for and clear the identification number input
      await page.waitForSelector(SELECTORS.identificationNumberInput, { timeout: 10000 });
      await page.click(SELECTORS.identificationNumberInput, { clickCount: 3 });
      await page.type(SELECTORS.identificationNumberInput, permitNumber);

      // Click search
      await page.click(SELECTORS.submitButton);

      // Wait for result to appear
      await page.waitForSelector(SELECTORS.resultStatus, { timeout: 15000 });

      // Give it a moment for the text to populate
      await new Promise(r => setTimeout(r, 1500));

      // Read the result text
      const rawResponse = await page.$eval(SELECTORS.resultStatus, el => el.textContent.trim());

      // Parse the status from the response
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
      // Wait a bit before retrying
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

/**
 * Parse the CDTFA response text into a normalized status string.
 */
function parsePermitStatus(rawText) {
  if (!rawText) return 'error';
  const lower = rawText.toLowerCase();
  if (lower.includes('valid') && lower.includes('seller')) return 'active';
  if (lower.includes('closed') || lower.includes('inactive')) return 'closed';
  if (lower.includes('not found') || lower.includes('no record') || lower.includes('invalid')) return 'not_found';
  if (lower.includes('revoked') || lower.includes('suspended')) return 'closed';
  // If we got some response but can't classify it, still mark it
  if (rawText.length > 0) return 'unknown';
  return 'error';
}

/**
 * Batch verify permits with delay between each.
 * @param {Array<{id, permitNumber}>} permits - Array of { id, permitNumber }
 * @param {function} onResult - Callback(result) called after each verification
 * @param {number} delayMs - Delay between lookups (default 60000 = 1 minute)
 */
async function verifyBatch(permits, onResult, delayMs = 60000) {
  console.log(`[CDTFA] Starting batch verification of ${permits.length} permits (${delayMs / 1000}s delay between each)`);

  for (let i = 0; i < permits.length; i++) {
    const { id, permitNumber } = permits[i];
    const result = await verifySinglePermit(permitNumber);
    result.clientId = id;

    if (onResult) {
      await onResult(result, i + 1, permits.length);
    }

    // Delay before next lookup (skip after the last one)
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
