// Firebase Cloud Messaging (FCM) push sender.
// Uses only Node built-ins — no new npm dependencies.
// Requires env var FIREBASE_SERVICE_ACCOUNT = the full JSON of the service-account key
// (Firebase console → Project settings → Service accounts → Generate new private key).

const crypto = require('crypto');
const https = require('https');

let cachedToken = null; // { accessToken, expiresAt }

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

module.exports = { sendPush, isPushConfigured };
