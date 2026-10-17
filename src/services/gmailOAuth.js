/**
 * Gmail connect flow with a one-time state (round 12, audit R25 / N10).
 *
 * Before: the OAuth callback accepted any authorization code, so anyone who completed Google's consent
 * screen through our callback URL could add their mailbox to the e-mail scanner. Now /oauth/start
 * (admin only) issues a random state that is stored server-side (so any dyno can check it) for 15
 * minutes, and the callback refuses a missing, unknown or expired state, then discards it.
 */
const crypto = require('crypto');
const KEY = 'gmail_oauth_state';
const TTL_MS = 15 * 60 * 1000;

async function issueState(by) {
  const { AppSettings } = require('../models');
  const state = crypto.randomBytes(24).toString('hex');
  const row = await AppSettings.findOne({ where: { key: KEY } });
  const now = Date.now();
  const live = (row && Array.isArray(row.value?.states) ? row.value.states : []).filter(s => s && s.expires > now).slice(-9);
  live.push({ state, expires: now + TTL_MS, by: by || null });
  if (row) await row.update({ value: { states: live } });
  else await AppSettings.create({ key: KEY, value: { states: live } });
  return state;
}

/** true (and the state is used up) when it was issued here and hasn't expired */
async function consumeState(state) {
  if (!state || typeof state !== 'string') return false;
  const { AppSettings, sequelize } = require('../models');
  return sequelize.transaction(async (t) => {
    const row = await AppSettings.findOne({ where: { key: KEY }, transaction: t, lock: t.LOCK.UPDATE });
    const states = Array.isArray(row?.value?.states) ? row.value.states : [];
    const now = Date.now();
    const hit = states.find(s => s && s.state === state && s.expires > now);
    if (row) await row.update({ value: { states: states.filter(s => s && s.state !== state && s.expires > now) } }, { transaction: t });
    return !!hit;
  });
}

/** Express handler for the Google redirect */
async function handleCallback(req, res) {
  const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'http://localhost:3000';
  const back = (q) => res.redirect(`${baseUrl}/admin/shop-config?tab=emailScanner&${q}`);
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('No authorization code received');
    if (!(await consumeState(state))) {
      console.warn('[EmailScanner] OAuth callback refused: missing, unknown or expired state');
      return back('error=' + encodeURIComponent('This connect link has expired or was not started from CR Admin. Start again from Shop Config → Email Scanner.'));
    }
    const { getOAuth2Client } = require('./emailScanner');
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(String(code));
    oauth2.setCredentials(tokens);
    const { google } = require('googleapis');
    const userInfo = await google.oauth2({ version: 'v2', auth: oauth2 }).userinfo.get();
    const email = userInfo.data.email;
    const { GmailAccount } = require('../models');
    const [account, created] = await GmailAccount.findOrCreate({
      where: { email },
      defaults: {
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null, isActive: true, connectedBy: 'admin',
      },
    });
    if (!created) {
      await account.update({
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token || account.refreshToken,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null, isActive: true, lastError: null,
      });
    }
    return back('connected=' + encodeURIComponent(email));
  } catch (error) {
    console.error('[EmailScanner] OAuth callback error:', error.message);
    return back('error=' + encodeURIComponent(error.message));
  }
}

module.exports = { issueState, consumeState, handleCallback };
