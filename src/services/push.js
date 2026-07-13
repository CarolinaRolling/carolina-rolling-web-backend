// Firebase Cloud Messaging (FCM) push sender.
// Uses only Node built-ins — no new npm dependencies.
// Requires env var FIREBASE_SERVICE_ACCOUNT = the full JSON of the service-account key
// (Firebase console → Project settings → Service accounts → Generate new private key).

const crypto = require('crypto');
const https = require('https');

let cachedToken = null; // { accessToken, expiresAt }
const pushLog = []; // last few push attempts, for /api/debug/push
function logPush(entry) {
  pushLog.unshift({ at: new Date().toISOString(), ...entry });
  if (pushLog.length > 20) pushLog.pop();
}
function getPushLog() { return pushLog; }

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    return null;
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Exchange the service-account key for a short-lived OAuth access token
async function getAccessToken(sa) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.accessToken;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${claim}.${signature}`;

  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`;
  const resp = await new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('token request timed out')));
    r.write(body); r.end();
  });
  const parsed = JSON.parse(resp.body);
  if (!parsed.access_token) throw new Error('Could not get FCM access token: ' + (parsed.error_description || resp.body).toString().slice(0, 200));
  cachedToken = { accessToken: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in || 3600) * 1000 };
  return cachedToken.accessToken;
}

// Send one notification to one device token
async function sendPush(deviceToken, title, body, data = {}) {
  const sa = getServiceAccount();
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
  const accessToken = await getAccessToken(sa);
  const payload = JSON.stringify({
    message: {
      token: deviceToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channel_id: 'quote_reminders' } }
    }
  });
  const resp = await new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'fcm.googleapis.com',
      path: `/v1/projects/${sa.project_id}/messages:send`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('push request timed out')));
    r.write(payload); r.end();
  });
  if (resp.status !== 200) {
    const err = new Error(`FCM error ${resp.status}: ${String(resp.body).slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return JSON.parse(resp.body);
}

function isPushConfigured() {
  return !!getServiceAccount();
}

// Verify the service-account key actually works: can we authenticate with Google and get a token?
// This proves the key is valid + has permission, without needing a device to send to.
async function verifyPushCredentials() {
  const sa = getServiceAccount();
  if (!sa) return { configured: false, reason: 'FIREBASE_SERVICE_ACCOUNT is not set on this server' };
  try {
    cachedToken = null; // force a fresh check
    const token = await getAccessToken(sa);
    return {
      configured: true,
      authOk: !!token,
      projectId: sa.project_id,
      clientEmail: sa.client_email
    };
  } catch (e) {
    return { configured: true, authOk: false, projectId: sa.project_id, clientEmail: sa.client_email, error: e.message };
  }
}

// Send a notification to every registered estimator device (e.g. the owner's phone).
// Used for instant pings like "new quote request received" — separate from the 4-hourly digest.
async function notifyEstimatorDevices(title, body, data = {}) {
  if (!isPushConfigured()) {
    console.log(`[push] (not configured) would send: ${title} — ${body}`);
    logPush({ title, result: 'SKIPPED — FIREBASE_SERVICE_ACCOUNT not set' });
    return { sent: 0, skipped: true };
  }
  const devices = await getEstimatorDevices();
  if (!devices.length) {
    console.warn(`[push] "${title}" — NO estimator devices registered, nothing sent`);
    logPush({ title, result: 'NO ESTIMATOR DEVICES REGISTERED — the phone has not registered with an estimator API key' });
    return { sent: 0 };
  }
  let sent = 0;
  const errors = [];
  for (const d of devices) {
    try {
      await sendPush(d.token, title, body, data);
      sent++;
    } catch (e) {
      console.error('[push] send failed:', e.message);
      errors.push(`${d.label || 'device'}: ${e.message}`);
      if (e.status === 404 || e.status === 403) { try { await d.update({ isActive: false }); } catch {} }
    }
  }
  console.log(`[push] "${title}" sent to ${sent}/${devices.length} estimator device(s)`);
  logPush({ title, devices: devices.length, sent, errors: errors.length ? errors : undefined });
  return { sent };
}

// Which devices should receive estimator notifications?
// Read the answer LIVE from the API key the device registered with — so ticking
// "Estimator device" in admin takes effect immediately, without waiting for the app
// to re-register (and a re-registration can't silently un-flag a device either).
async function getEstimatorDevices() {
  const { DeviceToken, ApiKey } = require('../models');
  let devices;
  try {
    devices = await DeviceToken.findAll({ where: { isActive: true } });
  } catch (e) {
    // The apiKeyId column may not exist yet on an older DB — fall back to the columns we know exist.
    console.warn('[push] device query failed, retrying without apiKeyId:', e.message);
    devices = await DeviceToken.findAll({
      where: { isActive: true },
      attributes: ['id', 'token', 'label', 'platform', 'isEstimator', 'isActive']
    });
  }
  const out = [];
  for (const d of devices) {
    let qualifies = !!d.isEstimator;
    if (d.apiKeyId) {
      try {
        const k = await ApiKey.findByPk(d.apiKeyId);
        if (k) qualifies = !!(k.isEstimator || k.permissions === 'admin');
      } catch (e) { /* fall back to the stored flag */ }
    }
    if (qualifies) out.push(d);
  }
  return out;
}

module.exports = { sendPush, isPushConfigured, verifyPushCredentials, notifyEstimatorDevices, getPushLog, getEstimatorDevices };
