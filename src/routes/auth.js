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

// Unified auth middleware: accepts JWT Bearer token OR X-API-Key header
const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  // Option 1: JWT Bearer token (main app)
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findByPk(decoded.userId);
      if (user && user.isActive) {
        req.user = user;
        return next();
      }
    } catch (e) {}
    return res.status(401).json({ error: { message: 'Invalid or expired token' } });
  }

  // Option 2: API Key (portal/external apps)
  if (apiKeyHeader) {
    try {
      const apiKey = await ApiKey.findOne({ where: { key: apiKeyHeader, isActive: true } });
      if (!apiKey) {
        return res.status(401).json({ error: { message: 'Invalid API key' } });
      }
      // Check expiration
      if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
        return res.status(401).json({ error: { message: 'API key expired' } });
      }
      // Attach key info to request so routes can scope data
      req.apiKey = apiKey;
      // Update last used timestamp (fire and forget)
      apiKey.update({ lastUsedAt: new Date() }).catch(() => {});
      
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
    const { username, password } = req.body;

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
      role: req.user.role
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
    const { name, clientName, permissions, expiresAt } = req.body;
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
      attributes: ['id', 'name', 'clientName', 'permissions', 'isActive', 'lastUsedAt', 'expiresAt', 'createdBy', 'createdAt'],
      order: [['createdAt', 'DESC']]
    });
    // Key value is NOT returned in list — only prefix for identification
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
