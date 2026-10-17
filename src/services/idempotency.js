/**
 * Idempotency-Key support (round 12, audits N19 / N23 / R30).
 *
 * A POST that carries an `Idempotency-Key` header is done once. A retry with the same key (same caller)
 * gets the first answer replayed; a retry while the first is still running gets 409. The key is stored
 * per caller (user or API key), so two people can't collide. Works across dynos (Postgres table from
 * migration 0004). Requests without the header behave exactly as before.
 */
const { QueryTypes } = require('sequelize');

function callerOf(req) {
  if (req.user) return 'u:' + req.user.id;
  if (req.apiKey) return 'k:' + req.apiKey.id;
  return null;
}

function idempotency(req, res, next) {
  if (req._idempotencyChecked) return next();   // authenticate can run more than once per request
  req._idempotencyChecked = true;
  const raw = req.headers['idempotency-key'];
  if (req.method !== 'POST' || !raw) return next();
  const caller = callerOf(req);
  if (!caller) return next();
  const key = (caller + ':' + String(raw)).slice(0, 200);
  const path = String(req.originalUrl || '').split('?')[0].slice(0, 500);
  const { sequelize } = require('../models');
  (async () => {
    // A key whose request died (deploy / restart mid-request) is taken over after two minutes, instead
    // of answering "in progress" until the daily clean-up (round 13, T29)
    await sequelize.query(`DELETE FROM idempotency_keys WHERE "key" = :key AND "status" IS NULL AND "createdAt" < now() - interval '2 minutes'`, { replacements: { key } });
    const inserted = await sequelize.query(
      `INSERT INTO idempotency_keys ("key", "method", "path") VALUES (:key, 'POST', :path) ON CONFLICT ("key") DO NOTHING RETURNING "key"`,
      { replacements: { key, path }, type: QueryTypes.SELECT });
    if (!inserted.length) {
      const [row] = await sequelize.query(`SELECT "path", "status", "body" FROM idempotency_keys WHERE "key" = :key`, { replacements: { key }, type: QueryTypes.SELECT });
      if (row && row.path !== path) return res.status(422).json({ error: { message: 'This Idempotency-Key was already used for a different request.' } });
      if (row && row.status) { res.set('Idempotent-Replay', 'true'); return res.status(row.status).json(row.body); }
      return res.status(409).json({ error: { code: 'IN_PROGRESS', message: 'This request is already being processed. Wait a moment and refresh.' } });
    }
    // Record the answer (only successful ones — a failed attempt may be retried with the same key)
    const original = res.json.bind(res);
    let recorded = false;
    res.json = (body) => {
      recorded = true;
      const status = res.statusCode || 200;
      const done = status < 400
        ? sequelize.query(`UPDATE idempotency_keys SET "status" = :status, "body" = CAST(:body AS jsonb) WHERE "key" = :key`,
            { replacements: { key, status, body: JSON.stringify(body === undefined ? null : body) } })
        : sequelize.query(`DELETE FROM idempotency_keys WHERE "key" = :key`, { replacements: { key } });
      done.catch(e => {
        console.warn('[idempotency] could not record result:', e.message);
        sequelize.query(`DELETE FROM idempotency_keys WHERE "key" = :key AND "status" IS NULL`, { replacements: { key } }).catch(() => {});
      });
      return original(body);
    };
    // Answered without JSON (a file, a redirect) or the request died: free the key so a retry can run
    // instead of getting "in progress" until the row expires
    const release = () => { if (!recorded) sequelize.query(`DELETE FROM idempotency_keys WHERE "key" = :key AND "status" IS NULL`, { replacements: { key } }).catch(() => {}); };
    res.on('finish', release);
    res.on('close', release);
    next();
  })().catch((e) => { console.warn('[idempotency] check failed, continuing without it:', e.message); next(); });
}

async function prune() {
  try { const { sequelize } = require('../models'); await sequelize.query(`DELETE FROM idempotency_keys WHERE "createdAt" < now() - interval '1 day'`); }
  catch (e) { /* table may not exist yet */ }
}

module.exports = { idempotency, prune };
