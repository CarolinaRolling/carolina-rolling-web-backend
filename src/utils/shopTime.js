/**
 * shopTime — dates on the shop's calendar (America/Los_Angeles), not the server's (UTC) — audit M12.
 *
 * Before: due dates are DATEONLY values ("2026-10-12"). `new Date('2026-10-12')` is midnight UTC, which
 * is 5 pm Pacific the day BEFORE, so the schedule flagged jobs overdue / "due today" from 5 pm the
 * previous evening. The production report's week started at midnight UTC Monday (5 pm Sunday Pacific),
 * so late-Sunday completions landed in the next week.
 *
 * Here a due date is compared as a calendar date with the shop's "today", and a week runs from
 * midnight Monday Pacific (daylight-saving aware).
 */
const TZ = 'America/Los_Angeles';

/** 'YYYY-MM-DD' of the instant `d` on the shop's calendar */
function shopDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** A DATEONLY / date string / Date → 'YYYY-MM-DD' (strings are taken as calendar dates, not instants) */
function asYmd(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : shopDate(d);
}

const ymdToUtcNoon = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d, 12); };

/** Whole calendar days from `a` to `b` (both 'YYYY-MM-DD') */
function daysBetween(a, b) { return Math.round((ymdToUtcNoon(b) - ymdToUtcNoon(a)) / 86400000); }

function addDays(ymd, n) { return new Date(ymdToUtcNoon(ymd) + n * 86400000).toISOString().slice(0, 10); }

/** Minutes the shop's clock is ahead of UTC at instant ts (negative in California) */
function offsetMinutes(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60000);
}

/** The instant of midnight at the start of `ymd` in the shop's time zone */
function shopMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  let ts = Date.UTC(y, m - 1, d) - offsetMinutes(Date.UTC(y, m - 1, d, 12)) * 60000;
  ts = Date.UTC(y, m - 1, d) - offsetMinutes(ts) * 60000;   // correct across a DST change
  return new Date(ts);
}

/** Monday ('YYYY-MM-DD') of the shop week containing `ymd` */
function mondayOf(ymd) {
  const dow = new Date(ymdToUtcNoon(ymd)).getUTCDay();   // 0 = Sunday
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

/** overdue / today / urgent (≤3 days) / soon (≤7) / normal / none — for a due date */
function dueStatus(due, today = shopDate()) {
  const ymd = asYmd(due);
  if (!ymd) return 'none';
  const days = daysBetween(today, ymd);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 3) return 'urgent';
  if (days <= 7) return 'soon';
  return 'normal';
}

/**
 * A date typed for an invoice ('YYYY-MM-DD', no time) → the instant of NOON that day in the shop's
 * time zone, so every reader (Pacific or UTC) sees the same calendar day. Stored as-is it was
 * midnight UTC = 4–5 pm Pacific the day before, so QuickBooks and the PDF dated it a day early
 * (round 11, audit N8). Anything else (a timestamp, a Date) passes through as a Date.
 */
function calendarInstant(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    const ymd = v.trim();
    const check = new Date(ymd + 'T12:00:00Z');
    if (isNaN(check) || check.toISOString().slice(0, 10) !== ymd) return null;   // 2026-13-45, 2026-02-30
    return new Date(shopMidnight(ymd).getTime() + 12 * 3600000);
  }
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d;
}

/**
 * The shop-calendar day ('YYYY-MM-DD') of a stored invoice-style timestamp. A value at exactly
 * midnight UTC was saved from a date-only string (before round 11) — it means that calendar day,
 * not the evening before in Pacific time.
 */
function calendarDay(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) return d.toISOString().slice(0, 10);
  return shopDate(d);
}

module.exports = { calendarInstant, calendarDay, TZ, shopDate, asYmd, daysBetween, addDays, shopMidnight, mondayOf, dueStatus, offsetMinutes };
