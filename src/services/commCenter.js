/**
 * Communication Center — triage + quote-coverage.
 *
 * classifyEmail(): body-aware (subject + snippet) classification that also flags whether an
 *   email is a quote request and whether it needs a response. Replaces the old subject-only
 *   classifier that mixed up ads and quotes.
 *
 * runCoverageScan(): for tracked quote-request / needs-response threads, looks at the newest
 *   message in each Gmail thread and decides "responded ✅" vs "awaiting 🟡". A bare
 *   "thanks/sounds good" reply from the client keeps the thread green (no action needed).
 */

const { google } = require('googleapis');
const { Op } = require('sequelize');
const { GmailAccount, ScannedEmail } = require('../models');

const VALID_CATEGORIES = ['client_inquiry', 'vendor', 'bill', 'marketing', 'spam', 'business', 'general'];

// Bare acknowledgement / thank-you replies that should NOT re-open a thread
const ACK_RE = /^\s*(thanks?|thank you|thx|ty|got it|sounds good|looks good|great|perfect|ok|okay|received|will do|appreciate|cheers|noted|👍)\b/i;

function isAck(text) {
  if (!text) return false;
  // Strip quoted/forwarded tails so we judge only the new content
  const newContent = String(text)
    .replace(/^>.*$/gm, '')
    .replace(/On .*wrote:[\s\S]*/i, '')
    .replace(/From:.*Sent:[\s\S]*/i, '')
    .trim();
  const words = newContent.split(/\s+/).filter(Boolean);
  return ACK_RE.test(newContent) && words.length <= 8;
}

function buildGmailClient(account) {
  const oauth2 = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.tokenExpiry,
  });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function emailFromHeader(fromHeader) {
  const m = (fromHeader || '').match(/<(.+?)>/);
  return (m ? m[1] : fromHeader || '').toLowerCase().trim();
}

// --- Stage 1: body-aware triage ---
async function classifyEmail({ from, subject, snippet, knownClient }) {
  // No AI key → safe default
  if (!process.env.ANTHROPIC_API_KEY) {
    return { category: knownClient ? 'client_inquiry' : 'general', isQuoteRequest: false, needsResponse: !!knownClient };
  }
  const sys = `You triage incoming email for Carolina Rolling Company, a metal ROLLING / FORMING / FABRICATION shop. Customers send US steel to roll and form; we BUY material and services from vendors.
Reply with ONLY JSON (no markdown):
{"category":"<client_inquiry|vendor|bill|marketing|spam|business|general>","isQuoteRequest":<bool>,"needsResponse":<bool>}

Decide who the sender is RELATIVE TO US:
- client_inquiry = someone who wants US to do work FOR them: asking us to roll/form/fabricate, requesting a quote, sending drawings or specs, or asking about pricing, lead time, or the status of their job. They are BUYING from us. This holds even if the sender is itself a company, shop, or fabricator. When unsure between client_inquiry and vendor and they are asking us to DO or QUOTE work, choose client_inquiry.
  - isQuoteRequest=true when they ask us to quote/price work or send specs/drawings for a quote.
- vendor = a supplier or subcontractor WE BUY FROM: steel/material suppliers, outside processing (galvanizing, machining, heat treat), or freight/trucking. Usually order confirmations, shipping notices, material quotes WE requested, or their invoices. Only use vendor when they are clearly selling material/services we purchase to fulfill jobs.
- bill = an invoice, statement, or payment request addressed to us.
- business = taxes, government/regulatory notices, certifications, annual reports, insurance, licensing.
- marketing = UNSOLICITED sales pitches, promotions, newsletters, cold outreach, ads — INCLUDING equipment-financing offers, "lines of credit", business loans, leasing, SEO/website services, insurance sales. needsResponse=false.
- spam = junk, phishing, scams. needsResponse=false.
- general = anything else.

CRITICAL RULES:
- An unsolicited offer of financing, credit, a "line of credit", loans, leasing, or equipment sales is marketing or spam — NEVER vendor.
- Do NOT default to vendor just because an email sounds business-like. Vendor means a supplier we actually buy material or services from.
- A request to quote or perform rolling/forming/fab work is client_inquiry, not vendor.
- needsResponse=true only if a human at the shop should reply or act. marketing / spam / automated receipts = false.${knownClient ? `\nNote: the sender (${knownClient}) is a known CLIENT — treat as client_inquiry unless it is clearly a bill.` : ''}`;
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    system: sys,
    messages: [{ role: 'user', content: `From: ${from}\nSubject: ${subject}\nPreview: ${snippet || ''}` }],
  });
  try {
    const https = require('https');
    const raw = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.setTimeout(12000, () => req.destroy(new Error('classify timeout')));
      req.write(body); req.end();
    });
    const data = JSON.parse(raw);
    const text = (data.content?.[0]?.text || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(text);
    const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'general';
    return {
      category,
      isQuoteRequest: !!parsed.isQuoteRequest,
      needsResponse: parsed.needsResponse !== undefined ? !!parsed.needsResponse : !['marketing', 'spam'].includes(category),
    };
  } catch (err) {
    console.warn('[CommCenter] classify failed, default general:', err.message);
    return { category: knownClient ? 'client_inquiry' : 'general', isQuoteRequest: false, needsResponse: !!knownClient };
  }
}

// --- Coverage for one thread: is the ball in our court? ---
async function computeCoverageForThread(gmail, threadId, ownEmails) {
  try {
    const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From'] });
    const msgs = (thread.data.messages || []).slice().sort(
      (a, b) => parseInt(a.internalDate || '0') - parseInt(b.internalDate || '0')
    );
    if (!msgs.length) return null;
    const newest = msgs[msgs.length - 1];
    const newestFrom = emailFromHeader((newest.payload?.headers || []).find(h => h.name === 'From')?.value || '');
    const lastMessageAt = new Date(parseInt(newest.internalDate || Date.now()));

    const newestIsOurs = ownEmails.has(newestFrom);
    if (newestIsOurs) return { responded: true, lastMessageAt };

    // Newest is from the client. A bare ack keeps it green if we had already replied.
    const weRepliedEarlier = msgs.some(m => ownEmails.has(emailFromHeader((m.payload?.headers || []).find(h => h.name === 'From')?.value || '')));
    if (weRepliedEarlier && isAck(newest.snippet)) return { responded: true, lastMessageAt };

    return { responded: false, lastMessageAt };
  } catch (err) {
    console.warn('[CommCenter] coverage check failed for thread', threadId, err.message);
    return null;
  }
}

// --- Refresh responded/awaiting state for tracked threads ---
async function runCoverageScan() {
  const accounts = await GmailAccount.findAll({ where: { isActive: true } });
  if (!accounts.length) return { checked: 0, awaiting: 0 };
  const ownEmails = new Set(accounts.map(a => (a.email || '').toLowerCase().trim()).filter(Boolean));

  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  let checked = 0;
  let awaiting = 0;

  for (const account of accounts) {
    const tracked = await ScannedEmail.findAll({
      where: {
        gmailAccountId: account.id,
        commArchived: false,
        receivedAt: { [Op.gte]: since },
        [Op.or]: [{ commIsQuoteRequest: true }, { commNeedsResponse: true }],
        gmailThreadId: { [Op.ne]: null },
      },
      attributes: ['id', 'gmailThreadId', 'commHandledManually'],
    });
    if (!tracked.length) continue;

    // Unique threads (latest record per thread is what we display)
    const threadIds = [...new Set(tracked.map(t => t.gmailThreadId))];
    let gmail;
    try { gmail = buildGmailClient(account); } catch { continue; }

    for (const threadId of threadIds) {
      const cov = await computeCoverageForThread(gmail, threadId, ownEmails);
      if (!cov) continue;
      checked++;
      // If the user manually marked any record in the thread handled, keep it green.
      const manual = tracked.some(t => t.gmailThreadId === threadId && t.commHandledManually);
      const responded = manual || cov.responded;
      if (!responded) awaiting++;
      await ScannedEmail.update(
        { commResponded: responded, commLastMessageAt: cov.lastMessageAt, commCoverageCheckedAt: new Date() },
        { where: { gmailThreadId: threadId, gmailAccountId: account.id } }
      );
    }
  }
  console.log(`[CommCenter] Coverage scan: ${checked} thread(s) checked, ${awaiting} awaiting response`);
  return { checked, awaiting };
}

// Re-run classification on already-scanned comm emails (fixes backlog after a prompt change).
// Uses stored subject/snippet/fromEmail — no Gmail re-fetch. Runs sequentially; call in background.
async function reclassifyExisting({ limit = 400 } = {}) {
  const { Client, Vendor } = require('../models');
  const vendors = await Vendor.findAll({ where: { isActive: true }, attributes: ['name', 'emailScanAddresses', 'contactEmail'] });
  const vendorAddrs = {};
  vendors.forEach(v => {
    const a = [...(v.emailScanAddresses || [])];
    if (v.contactEmail) a.push(v.contactEmail);
    a.forEach(x => { vendorAddrs[(x || '').toLowerCase().trim()] = v.name; });
  });
  const clients = await Client.findAll({ where: { isActive: true }, attributes: ['name', 'emailScanAddresses', 'contacts', 'emailScanEnabled'] });
  const clientAddrs = {};
  clients.filter(c => !c.emailScanEnabled).forEach(c => {
    (c.emailScanAddresses || []).forEach(x => { clientAddrs[(x || '').toLowerCase().trim()] = c.name; });
    (c.contacts || []).forEach(ct => { if (ct.email) clientAddrs[ct.email.toLowerCase().trim()] = c.name; });
  });

  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const emails = await ScannedEmail.findAll({
    where: { emailType: 'comm_center', receivedAt: { [Op.gte]: since } },
    order: [['receivedAt', 'DESC']], limit,
  });
  let updated = 0;
  for (const e of emails) {
    const fromEmail = (e.fromEmail || '').toLowerCase().trim();
    let triage;
    if (vendorAddrs[fromEmail]) {
      triage = { category: 'vendor', isQuoteRequest: false, needsResponse: false };
    } else {
      triage = await classifyEmail({ from: e.fromName || e.fromEmail, subject: e.subject, snippet: e.commSnippet, knownClient: clientAddrs[fromEmail] || null });
    }
    try {
      await e.update({ commCategory: triage.category, commIsQuoteRequest: triage.isQuoteRequest, commNeedsResponse: triage.needsResponse });
      updated++;
    } catch { /* skip individual failures */ }
  }
  console.log(`[CommCenter] Reclassified ${updated} email(s)`);
  return { updated };
}

module.exports = { classifyEmail, isAck, computeCoverageForThread, runCoverageScan, reclassifyExisting, VALID_CATEGORIES };
