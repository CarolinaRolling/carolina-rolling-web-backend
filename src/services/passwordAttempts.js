/**
 * Wrong-password limiter: 5 tries per key per 10 minutes, counted synchronously; clear() on success.
 * Same semantics as the COD / delete-override limiter in routes/workorders.js. Per server process.
 * Used for the signed-in password re-checks in routes/auth.js (V21).
 */
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;
const m = new Map();   // key → { n, until }

function take(key) {
  const now = Date.now();
  let e = m.get(key);
  if (!e || e.until <= now) { e = { n: 0, until: now + WINDOW_MS }; m.set(key, e); }
  if (e.n >= LIMIT) return false;
  e.n++;
  if (m.size > 5000) for (const [k, v] of m) if (v.until <= now) m.delete(k);   // keep the map small
  return true;
}

function clear(key) { m.delete(key); }

module.exports = { take, clear };
