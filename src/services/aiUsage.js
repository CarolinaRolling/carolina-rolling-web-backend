/**
 * Token accounting + a daily cap for Anthropic API calls, with per-feature tracking.
 *
 * Every AI call site calls assertWithinBudget() before the request (throws once the daily budget is spent —
 * fails closed so a runaway loop STOPS) and record() after, with the API's usage block and a feature label.
 * Usage is tallied per feature so the Admin panel can show which feature spends what, and a 7-day rolling
 * history is kept for trend. Counters live in AppSettings so they survive restarts and are shared across dynos.
 */

const SETTING_KEY = 'ai_usage_daily';
const HISTORY_KEY = 'ai_usage_history';

// Default set to catch a runaway while allowing a busy legitimate day. Normal baseline is ~2M tokens/day;
// a stuck loop pushed it to ~4.3M. 3M trips before a runaway but clears normal use. Override with
// AI_DAILY_TOKEN_BUDGET.
const DEFAULT_DAILY_BUDGET = parseInt(process.env.AI_DAILY_TOKEN_BUDGET, 10) || 3000000;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readUsage() {
  const { AppSettings } = require('../models');
  const row = await AppSettings.findOne({ where: { key: SETTING_KEY } });
  const val = (row && row.value) || {};
  // A new day resets the counters.
  if (val.date !== today()) {
    return { date: today(), inputTokens: 0, outputTokens: 0, calls: 0, blocked: 0, byFeature: {}, row };
  }
  return {
    date: val.date,
    inputTokens: val.inputTokens || 0,
    outputTokens: val.outputTokens || 0,
    calls: val.calls || 0,
    blocked: val.blocked || 0,
    byFeature: val.byFeature || {},
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
    byFeature: usage.byFeature || {},
  };
  if (usage.row) await usage.row.update({ value });
  else await AppSettings.upsert({ key: SETTING_KEY, value });
}

// Rolling 7-day history so the panel can show a trend, not just today.
async function rollHistory(usage) {
  try {
    const { AppSettings } = require('../models');
    const row = await AppSettings.findOne({ where: { key: HISTORY_KEY } });
    let days = (row && row.value && Array.isArray(row.value.days)) ? row.value.days : [];
    days = days.filter(d => d.date !== usage.date);
    days.push({ date: usage.date, totalTokens: usage.inputTokens + usage.outputTokens, calls: usage.calls, byFeature: usage.byFeature || {} });
    days = days.slice(-7);
    if (row) await row.update({ value: { days } });
    else await AppSettings.upsert({ key: HISTORY_KEY, value: { days } });
  } catch (e) { /* history is best-effort */ }
}

/**
 * Call before an API request. Throws AI_BUDGET_EXHAUSTED if today's budget is already spent.
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
    console.warn('[aiUsage] budget check unavailable:', e.message);
    return null;
  }
}

/**
 * Call after a successful API response with the `usage` block Anthropic returns + a feature label.
 */
async function record(apiUsage, label = 'ai') {
  if (!apiUsage) return;
  try {
    const usage = await readUsage();
    const inT = apiUsage.input_tokens || 0;
    const outT = apiUsage.output_tokens || 0;
    usage.inputTokens += inT;
    usage.outputTokens += outT;
    usage.calls += 1;
    const f = usage.byFeature[label] || { inputTokens: 0, outputTokens: 0, calls: 0 };
    f.inputTokens += inT; f.outputTokens += outT; f.calls += 1;
    usage.byFeature[label] = f;
    await writeUsage(usage);
    await rollHistory(usage);

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
  const features = Object.entries(usage.byFeature || {}).map(([label, f]) => ({
    label,
    calls: f.calls || 0,
    inputTokens: f.inputTokens || 0,
    outputTokens: f.outputTokens || 0,
    totalTokens: (f.inputTokens || 0) + (f.outputTokens || 0),
    percentOfDay: total > 0 ? Math.round((((f.inputTokens || 0) + (f.outputTokens || 0)) / total) * 100) : 0,
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  let history = [];
  try {
    const { AppSettings } = require('../models');
    const row = await AppSettings.findOne({ where: { key: HISTORY_KEY } });
    if (row && row.value && Array.isArray(row.value.days)) {
      history = row.value.days.map(d => ({ date: d.date, totalTokens: d.totalTokens || 0, calls: d.calls || 0 }));
    }
  } catch {}

  return {
    date: usage.date,
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: total,
    budget: DEFAULT_DAILY_BUDGET,
    percentUsed: Math.round((total / DEFAULT_DAILY_BUDGET) * 100),
    blockedCalls: usage.blocked,
    features,
    history,
  };
}

module.exports = { assertWithinBudget, record, summary, SETTING_KEY, HISTORY_KEY, DEFAULT_DAILY_BUDGET };
