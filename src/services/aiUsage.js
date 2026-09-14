/**
 * Token accounting + daily cap + per-minute rate limit for Anthropic API calls, with per-feature tracking.
 *
 * Every AI call site calls assertWithinBudget() before the request (throws if the daily token budget is spent
 * OR too many calls happened in the last minute — fails closed so a runaway STOPS) and record() after, with
 * the API usage block and a feature label. Usage is tallied per feature for the Admin panel, with a 7-day
 * history. Counters live in AppSettings so they survive restarts and are shared across dynos.
 */

const SETTING_KEY = 'ai_usage_daily';
const HISTORY_KEY = 'ai_usage_history';

// Daily token ceiling (durable). Normal baseline ~2M/day; a runaway hit ~4.3M. Override AI_DAILY_TOKEN_BUDGET.
const DEFAULT_DAILY_BUDGET = parseInt(process.env.AI_DAILY_TOKEN_BUDGET, 10) || 3000000;

// Fast tripwire: max AI calls per rolling minute. Catches a "many small calls fast" runaway that the daily
// token cap is too slow to stop. In-memory (resets on restart — fine, it's a tripwire). Override AI_MAX_CALLS_PER_MIN.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_CALLS = parseInt(process.env.AI_MAX_CALLS_PER_MIN, 10) || 20;
let callTimes = [];

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readUsage() {
  const { AppSettings } = require('../models');
  const row = await AppSettings.findOne({ where: { key: SETTING_KEY } });
  const val = (row && row.value) || {};
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
  } catch (e) { /* best-effort */ }
}

async function assertWithinBudget(label = 'ai') {
  try {
    // 1) Fast tripwire — too many calls in the last minute means something is looping.
    const now = Date.now();
    callTimes = callTimes.filter(t => now - t < RATE_WINDOW_MS);
    if (callTimes.length >= RATE_MAX_CALLS) {
      const err = new Error(
        `AI call rate limit hit (${callTimes.length} calls in the last minute, max ${RATE_MAX_CALLS}). ` +
        `Blocked: ${label}. Something is likely looping. Raise AI_MAX_CALLS_PER_MIN if this is real volume.`
      );
      err.code = 'AI_RATE_LIMITED';
      throw err;
    }
    callTimes.push(now);

    // 2) Durable daily token ceiling.
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
    if (e.code === 'AI_BUDGET_EXHAUSTED' || e.code === 'AI_RATE_LIMITED') throw e;
    console.warn('[aiUsage] budget check unavailable:', e.message);
    return null;
  }
}

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
    callsLastMinute: callTimes.length,
    features,
    history,
  };
}

module.exports = { assertWithinBudget, record, summary, SETTING_KEY, HISTORY_KEY, DEFAULT_DAILY_BUDGET };
