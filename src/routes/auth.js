const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { User, ActivityLog, ApiKey } = require('../models');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'carolina-rolling-secret-key-2024';

// Middleware to verify JWT token
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: { message: 'Access token required' } });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findByPk(decoded.userId);
    
    if (!user || !user.isActive) {
      return res.status(401).json({ error: { message: 'Invalid or inactive user' } });
    }
    
    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: { message: 'Invalid token' } });
  }
};

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin' && !req.apiKey) {
    return res.status(403).json({ error: { message: 'Admin access required' } });
  }
  // API keys with admin permissions also pass
  if (req.apiKey && req.apiKey.permissions !== 'admin') {
    return res.status(403).json({ error: { message: 'Admin access required' } });
  }
  next();
};

// Unified auth middleware: accepts JWT Bearer token OR X-API-Key header OR query params
const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  // Option 1: JWT Bearer token (main app) - header or ?token= query param
  const jwtToken = (authHeader && authHeader.startsWith('Bearer ')) 
    ? authHeader.split(' ')[1] 
    : req.query.token;
  if (jwtToken) {
    try {
      const decoded = jwt.verify(jwtToken, JWT_SECRET);
      const user = await User.findByPk(decoded.userId);
      if (user && user.isActive) {
        req.user = user;
        return next();
      }
    } catch (e) {}
    return res.status(401).json({ error: { message: 'Invalid or expired token' } });
  }

  // Option 2: API Key (portal/external apps) - header or query param
  const apiKeyValue = apiKeyHeader || req.query.apikey;
  if (apiKeyValue) {
    try {
      const apiKey = await ApiKey.findOne({ where: { key: apiKeyValue } });
      if (!apiKey) {
        return res.status(401).json({ error: { message: 'Invalid API key' } });
      }
      
      // Check if revoked
      if (!apiKey.isActive) {
        const reason = apiKey.revokedReason || 'Key has been revoked';
        return res.status(401).json({ error: { message: `API key revoked: ${reason}` } });
      }
      
      // Check expiration
      if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
        return res.status(401).json({ error: { message: 'API key expired' } });
      }
      
      // === IP ALLOWLIST CHECK ===
      const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || '';
      
      // Build combined allowlist: per-key IPs + global approved IPs (for tablet keys only)
      // Keys WITHOUT a deviceName are treated as client portals — global IPs don't apply to them
      const perKeyIPs = apiKey.allowedIPs ? apiKey.allowedIPs.split(',').map(ip => ip.trim()).filter(Boolean) : [];
      const isTabletKey = !!apiKey.deviceName; // Tablet keys have a device name set
      let globalIPs = [];
      if (isTabletKey) {
        try {
          const { AppSettings } = require('../models');
          const globalSetting = await AppSettings.findOne({ where: { key: 'approved_ips' } });
          if (globalSetting?.value?.ips) {
            globalIPs = globalSetting.value.ips.map(ip => ip.trim()).filter(Boolean);
          }
        } catch (e) { /* ignore */ }
      }
      
      const allAllowed = [...perKeyIPs, ...globalIPs];
      
      if (allAllowed.length > 0) {
          const ipMatch = allAllowed.some(allowedIP => {
            // Exact match
            if (clientIP === allowedIP) return true;
            // CIDR range match (simple /24 support)
            if (allowedIP.includes('/')) {
              const [network, bits] = allowedIP.split('/');
              const mask = ~(Math.pow(2, 32 - parseInt(bits)) - 1) >>> 0;
              const ipToNum = (ip) => ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
              return (ipToNum(clientIP) & mask) === (ipToNum(network) & mask);
            }
            // Wildcard match (e.g. 192.168.1.*)
            if (allowedIP.includes('*')) {
              const regex = new RegExp('^' + allowedIP.replace(/\./g, '\\.').replace(/\*/g, '\\d+') + '$');
              return regex.test(clientIP);
            }
            return false;
          });
          
          if (!ipMatch) {
            // AUTO-REVOKE: unauthorized IP detected
            console.error(`[SECURITY] API key "${apiKey.name}" (${apiKey.deviceName || 'unknown device'}) used from unauthorized IP: ${clientIP}. Allowed: ${allAllowed.join(', ')}. KEY REVOKED.`);
            await apiKey.update({
              isActive: false,
              revokedReason: `Unauthorized IP: ${clientIP} (allowed: ${allAllowed.join(', ')})`,
              revokedAt: new Date(),
              lastIP: clientIP,
              lastIPDate: new Date()
            });
            
            // Log the security event
            try {
              const { DailyActivity } = require('../models');
              await DailyActivity.create({
                activityType: 'security',
                resourceType: 'system',
                description: `🚨 API key "${apiKey.name}" auto-revoked — unauthorized IP ${clientIP} (operator: ${apiKey.operatorName || 'unknown'}, device: ${apiKey.deviceName || 'unknown'})`
              });
            } catch (e) { /* ignore logging failure */ }
            
            return res.status(403).json({ 
              error: { 
                message: 'ACCESS REVOKED: This device is not authorized. Contact your administrator.',
                code: 'IP_REVOKED'
              } 
            });
          }
      }
      
      // Attach key info to request so routes can scope data
      req.apiKey = apiKey;
      // Attach operator info for tracking
      req.operatorName = apiKey.operatorName || null;
      req.deviceName = apiKey.deviceName || apiKey.name || null;
      
      // Update last used timestamp and IP (fire and forget)
      apiKey.update({ lastUsedAt: new Date(), lastIP: clientIP, lastIPDate: new Date() }).catch(() => {});
      
      // Enforce read-only permission — block write operations
      if (apiKey.permissions === 'read' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return res.status(403).json({ error: { message: 'API key has read-only permission' } });
      }
      
      return next();
    } catch (e) {
      return res.status(500).json({ error: { message: 'Auth error' } });
    }
  }

  return res.status(401).json({ error: { message: 'Authentication required. Provide Bearer token or X-API-Key header.' } });
};

// Helper to log activity
const logActivity = async (userId, username, action, resourceType, resourceId, details, ipAddress) => {
  try {
    await ActivityLog.create({
      userId,
      username,
      action,
      resourceType,
      resourceId,
      details,
      ipAddress
    });
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
};

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password, totpCode } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: { message: 'Username and password required' } });
    }

    const user = await User.findOne({ where: { username } });

    if (!user || !(await user.validatePassword(password))) {
      await logActivity(null, username, 'LOGIN_FAILED', 'user', null, { reason: 'Invalid credentials' }, req.ip);
      return res.status(401).json({ error: { message: 'Invalid username or password' } });
    }

    if (!user.isActive) {
      await logActivity(user.id, username, 'LOGIN_FAILED', 'user', user.id, { reason: 'Account disabled' }, req.ip);
      return res.status(401).json({ error: { message: 'Account is disabled' } });
    }

    // Check if 2FA is enabled
    if (user.totpEnabled && user.totpSecret) {
      if (!totpCode) {
        // Password correct but 2FA required — return partial response
        return res.json({
          data: {
            requires2FA: true,
            userId: user.id,
            username: user.username
          }
        });
      }

      // Verify TOTP code
      const { TOTP } = require('otpauth');
      const totp = new TOTP({
        issuer: 'Carolina Rolling',
        label: user.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: user.totpSecret
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        await logActivity(user.id, username, 'LOGIN_FAILED', 'user', user.id, { reason: 'Invalid 2FA code' }, req.ip);
        return res.status(401).json({ error: { message: 'Invalid verification code' } });
      }
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    await logActivity(user.id, username, 'LOGIN_SUCCESS', 'user', user.id, null, req.ip);

    res.json({
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/2fa/setup - Generate TOTP secret and QR code
router.post('/2fa/setup', authenticateToken, async (req, res, next) => {
  try {
    const { TOTP, Secret } = require('otpauth');
    const QRCode = require('qrcode');

    // Generate a new secret
    const secret = new Secret({ size: 20 });

    const totp = new TOTP({
      issuer: 'Carolina Rolling',
      label: req.user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: secret
    });

    const otpauthUrl = totp.toString();
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Store secret temporarily (not enabled yet until verified)
    await req.user.update({ totpSecret: secret.base32 });

    res.json({
      data: {
        secret: secret.base32,
        qrCode: qrCodeDataUrl,
        otpauthUrl
      },
      message: 'Scan the QR code with your authenticator app, then verify with a code.'
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/2fa/verify - Verify TOTP code and enable 2FA
router.post('/2fa/verify', authenticateToken, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: { message: 'Verification code is required' } });
    }

    if (!req.user.totpSecret) {
      return res.status(400).json({ error: { message: 'Run 2FA setup first' } });
    }

    const { TOTP } = require('otpauth');
    const totp = new TOTP({
      issuer: 'Carolina Rolling',
      label: req.user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: req.user.totpSecret
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      return res.status(400).json({ error: { message: 'Invalid code. Make sure you scanned the QR code and the time on your phone is correct.' } });
    }

    await req.user.update({ totpEnabled: true });
    await logActivity(req.user.id, req.user.username, '2FA_ENABLED', 'user', req.user.id, null, req.ip);

    res.json({ message: 'Two-factor authentication enabled successfully.' });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/2fa/disable - Disable 2FA
router.post('/2fa/disable', authenticateToken, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: { message: 'Password is required to disable 2FA' } });
    }

    if (!(await req.user.validatePassword(password))) {
      return res.status(401).json({ error: { message: 'Invalid password' } });
    }

    await req.user.update({ totpEnabled: false, totpSecret: null });
    await logActivity(req.user.id, req.user.username, '2FA_DISABLED', 'user', req.user.id, null, req.ip);

    res.json({ message: 'Two-factor authentication disabled.' });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/2fa/status - Check if 2FA is enabled for current user
router.get('/2fa/status', authenticateToken, async (req, res) => {
  res.json({
    data: {
      enabled: req.user.totpEnabled || false
    }
  });
});

// POST /api/auth/register (admin only - for creating new users)
router.post('/register', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: { message: 'Username and password required' } });
    }

    const existingUser = await User.findOne({ where: { username } });
    if (existingUser) {
      return res.status(400).json({ error: { message: 'Username already exists' } });
    }

    const user = await User.create({
      username,
      password,
      role: role || 'user'
    });

    await logActivity(req.user.id, req.user.username, 'USER_CREATED', 'user', user.id, { newUsername: username, role: user.role }, req.ip);

    res.status(201).json({
      data: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/me - Get current user
router.get('/me', authenticateToken, async (req, res) => {
  res.json({
    data: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      totpEnabled: req.user.totpEnabled || false
    }
  });
});

// PUT /api/auth/change-password
router.put('/change-password', authenticateToken, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: { message: 'Current and new password required' } });
    }

    if (!(await req.user.validatePassword(currentPassword))) {
      return res.status(401).json({ error: { message: 'Current password is incorrect' } });
    }

    req.user.password = newPassword;
    await req.user.save();

    await logActivity(req.user.id, req.user.username, 'PASSWORD_CHANGED', 'user', req.user.id, null, req.ip);

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/users - List all users (admin only)
router.get('/users', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'username', 'role', 'isActive', 'createdAt'],
      order: [['createdAt', 'DESC']]
    });

    res.json({ data: users });
  } catch (error) {
    next(error);
  }
});

// PUT /api/auth/users/:id - Update user (admin only)
router.put('/users/:id', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const user = await User.findByPk(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const { role, isActive, password } = req.body;

    if (role) user.role = role;
    if (typeof isActive === 'boolean') user.isActive = isActive;
    if (password) user.password = password;

    await user.save();

    await logActivity(req.user.id, req.user.username, 'USER_UPDATED', 'user', user.id, { updatedUsername: user.username }, req.ip);

    res.json({
      data: {
        id: user.id,
        username: user.username,
        role: user.role,
        isActive: user.isActive
      }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/auth/users/:id - Delete user (admin only)
router.delete('/users/:id', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const user = await User.findByPk(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    if (user.id === req.user.id) {
      return res.status(400).json({ error: { message: 'Cannot delete your own account' } });
    }

    const deletedUsername = user.username;
    await user.destroy();

    await logActivity(req.user.id, req.user.username, 'USER_DELETED', 'user', req.params.id, { deletedUsername }, req.ip);

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/logs - Get activity logs (admin only)
router.get('/logs', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { limit = 100, offset = 0 } = req.query;

    const logs = await ActivityLog.findAndCountAll({
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      data: logs.rows,
      total: logs.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    next(error);
  }
});

// Initialize default admin user
const initializeAdmin = async () => {
  try {
    const adminExists = await User.findOne({ where: { username: 'admin' } });
    if (!adminExists) {
      await User.create({
        username: 'admin',
        password: 'admin123',
        role: 'admin'
      });
      console.log('Default admin user created (username: admin, password: admin123)');
    }
  } catch (error) {
    console.error('Failed to initialize admin user:', error);
  }
};

module.exports = { router, authenticateToken, requireAdmin, logActivity, initializeAdmin, authenticate };

// ==================== API KEY MANAGEMENT ====================

// POST /api/auth/api-keys - Create new API key (admin only)
router.post('/api-keys', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { name, clientName, permissions, expiresAt, allowedIPs, operatorName, deviceName } = req.body;
    if (!name) {
      return res.status(400).json({ error: { message: 'API key name is required' } });
    }

    // Generate a secure random key: crm_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
    const rawKey = crypto.randomBytes(32).toString('hex');
    const key = `crm_${rawKey}`;

    const apiKey = await ApiKey.create({
      name,
      key,
      clientName: clientName || null,
      permissions: permissions || 'read',
      expiresAt: expiresAt || null,
      allowedIPs: allowedIPs || null,
      operatorName: operatorName || null,
      deviceName: deviceName || null,
      createdBy: req.user.username
    });

    // Return the key - this is the ONLY time the full key is shown
    res.status(201).json({
      data: {
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key, // Only shown on creation
        clientName: apiKey.clientName,
        permissions: apiKey.permissions,
        allowedIPs: apiKey.allowedIPs,
        operatorName: apiKey.operatorName,
        deviceName: apiKey.deviceName,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt
      },
      message: 'API key created. Save this key — it won\'t be shown again.'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/api-keys - List all API keys (admin only)
router.get('/api-keys', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const apiKeys = await ApiKey.findAll({
      attributes: ['id', 'name', 'clientName', 'permissions', 'isActive', 'lastUsedAt', 'lastIP', 'lastIPDate',
        'expiresAt', 'createdBy', 'createdAt', 'allowedIPs', 'operatorName', 'deviceName', 'revokedReason', 'revokedAt'],
      order: [['createdAt', 'DESC']]
    });
    const keysWithPrefix = apiKeys.map(k => {
      const data = k.toJSON();
      data.keyPrefix = 'crm_****';
      return data;
    });
    res.json({ data: keysWithPrefix });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/api-keys/:id/setup-qr - Get QR config data for tablet setup (admin only)
router.get('/api-keys/:id/setup-qr', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const apiKey = await ApiKey.findByPk(req.params.id);
    if (!apiKey) {
      return res.status(404).json({ error: { message: 'API key not found' } });
    }
    
    const baseUrl = `${req.protocol}://${req.get('host')}/api/`;
    const deviceName = apiKey.deviceName || apiKey.name;
    
    // Compact pipe-delimited format: CFG|apiKey|serverUrl|deviceName
    // Much shorter than JSON — critical for QR scannability
    res.json({
      data: {
        qrPayload: `CFG|${apiKey.key}|${baseUrl}|${deviceName}`,
        deviceName
      }
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/auth/api-keys/:id - Update API key settings (admin only)
router.put('/api-keys/:id', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const apiKey = await ApiKey.findByPk(req.params.id);
    if (!apiKey) {
      return res.status(404).json({ error: { message: 'API key not found' } });
    }
    
    const { name, clientName, permissions, allowedIPs, operatorName, deviceName, expiresAt, isActive } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (clientName !== undefined) updates.clientName = clientName || null;
    if (permissions !== undefined) updates.permissions = permissions;
    if (allowedIPs !== undefined) updates.allowedIPs = allowedIPs || null;
    if (operatorName !== undefined) updates.operatorName = operatorName || null;
    if (deviceName !== undefined) updates.deviceName = deviceName || null;
    if (expiresAt !== undefined) updates.expiresAt = expiresAt || null;
    
    // Re-activate a revoked key
    if (isActive === true && !apiKey.isActive) {
      updates.isActive = true;
      updates.revokedReason = null;
      updates.revokedAt = null;
    }
    if (isActive === false) {
      updates.isActive = false;
      updates.revokedReason = 'Manually deactivated';
      updates.revokedAt = new Date();
    }
    
    await apiKey.update(updates);
    res.json({ data: apiKey, message: 'API key updated' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/auth/api-keys/:id/permanent - Permanently delete a revoked API key (admin only)
router.delete('/api-keys/:id/permanent', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const apiKey = await ApiKey.findByPk(req.params.id);
    if (!apiKey) {
      return res.status(404).json({ error: { message: 'API key not found' } });
    }
    if (apiKey.isActive) {
      return res.status(400).json({ error: { message: 'Revoke the key before deleting it' } });
    }
    const name = apiKey.name;
    await apiKey.destroy({ force: true });
    res.json({ message: `API key "${name}" permanently deleted` });
  } catch (error) {
    console.error('[delete-api-key]', error.message);
    next(error);
  }
});

// DELETE /api/auth/api-keys/:id - Revoke an API key (admin only)
router.delete('/api-keys/:id', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const apiKey = await ApiKey.findByPk(req.params.id);
    if (!apiKey) {
      return res.status(404).json({ error: { message: 'API key not found' } });
    }
    await apiKey.update({ isActive: false });
    res.json({ message: `API key "${apiKey.name}" revoked` });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/approved-ips - Get global approved IP list
router.get('/approved-ips', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { AppSettings } = require('../models');
    const setting = await AppSettings.findOne({ where: { key: 'approved_ips' } });
    res.json({ data: setting?.value?.ips || [] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/auth/approved-ips - Update global approved IP list
router.put('/approved-ips', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { ips } = req.body;
    if (!Array.isArray(ips)) {
      return res.status(400).json({ error: { message: 'ips must be an array' } });
    }
    const { AppSettings } = require('../models');
    await AppSettings.upsert({ key: 'approved_ips', value: { ips: ips.filter(ip => ip.trim()) } });
    res.json({ data: ips.filter(ip => ip.trim()), message: 'Approved IPs updated' });
  } catch (error) {
    next(error);
  }
});
