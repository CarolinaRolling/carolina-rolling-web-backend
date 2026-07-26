/**
 * Token accounting and a daily cap for Anthropic API calls.
 *
 * The scanner calls the API from five places with max_tokens between 200 and 4000, retries three
 * times with long backoff, and had no accounting of any kind. A malformed inbound email that
 * kept triggering retries, or a loop that re-scanned the same thread, had no ceiling other than
 * the account limit — and nobody would notice until the bill arrived.
 *
 * This does two things:
 *   1. records tokens per call so usage is visible
 *   2. refuses new calls once the daily token budget is spent
 *
 * The counter lives in AppSettings so it survives restarts and is shared across dynos. It is
 * intentionally simple: read, add, write. A lost update under concurrency understates usage
 * slightly, which is the harmless direction — this is a safety valve, not billing.
 */

const SETTING_KEY = 'ai_usage_daily';

// Generous by default: normal scanning is a few thousand tokens per email. Override with
// AI_DAILY_TOKEN_BUDGET when you know your real volume.
const DEFAULT_DAILY_BUDGET = parseInt(process.env.AI_DAILY_TOKEN_BUDGET, 10) || 2000000;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readUsage() {
  const { AppSettings } = require('../models');
  const row = await AppSettings.findOne({ where: { key: SETTING_KEY } });
  const val = row?.value || {};
  // A new day resets the counter.
  if (val.date !== today()) {
    return { date: today(), inputTokens: 0, outputTokens: 0, calls: 0, blocked: 0, row };
  }
  return {
    date: val.date,
    inputTokens: val.inputTokens || 0,
    outputTokens: val.outputTokens || 0,
    calls: val.calls || 0,
    blocked: val.blocked || 0,
    row,
  };
}

async function writeUsage(usage) {
  const { AppSettings } = require('../models');
  const value = {
    date: usage.date,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    calls: usage.calls,
    blocked: usage.blocked,
  };
  if (usage.row) await usage.row.update({ value });
  else await AppSettings.upsert({ key: SETTING_KEY, value });
}

/**
 * Call before an API request. Throws if today's budget is already spent.
 * Failing closed is deliberate: a runaway loop should stop, not keep spending.
 */
async function assertWithinBudget(label = 'ai') {
  try {
    const usage = await readUsage();
    const total = usage.inputTokens + usage.outputTokens;
    if (total >= DEFAULT_DAILY_BUDGET) {
      usage.blocked += 1;
      await writeUsage(usage);
      const err = new Error(
        `AI daily token budget exhausted (${total.toLocaleString()} / ${DEFAULT_DAILY_BUDGET.toLocaleString()}). ` +
        `Blocked call: ${label}. Raise AI_DAILY_TOKEN_BUDGET or wait until tomorrow.`
      );
      err.code = 'AI_BUDGET_EXHAUSTED';
      throw err;
    }
    return { spent: total, budget: DEFAULT_DAILY_BUDGET };
  } catch (e) {
    if (e.code === 'AI_BUDGET_EXHAUSTED') throw e;
    // Never let an accounting problem stop real work.
    console.warn('[aiUsage] budget check unavailable:', e.message);
    return null;
  }
}

/**
 * Call after a successful API response with the `usage` block Anthropic returns.
 */
async function record(apiUsage, label = 'ai') {
  if (!apiUsage) return;
  try {
    const usage = await readUsage();
    usage.inputTokens += apiUsage.input_tokens || 0;
    usage.outputTokens += apiUsage.output_tokens || 0;
    usage.calls += 1;
    await writeUsage(usage);

    const total = usage.inputTokens + usage.outputTokens;
    const pct = Math.round((total / DEFAULT_DAILY_BUDGET) * 100);
    if (pct >= 80) {
      console.warn(`[aiUsage] ${pct}% of today's token budget used (${total.toLocaleString()}/${DEFAULT_DAILY_BUDGET.toLocaleString()}) — last call: ${label}`);
    }
  } catch (e) {
    console.warn('[aiUsage] could not record usage:', e.message);
  }
}

async function summary() {
  const usage = await readUsage();
  const total = usage.inputTokens + usage.outputTokens;
  return {
    date: usage.date,
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: total,
    budget: DEFAULT_DAILY_BUDGET,
    percentUsed: Math.round((total / DEFAULT_DAILY_BUDGET) * 100),
    blockedCalls: usage.blocked,
  };
}

module.exports = { assertWithinBudget, record, summary, SETTING_KEY, DEFAULT_DAILY_BUDGET };
