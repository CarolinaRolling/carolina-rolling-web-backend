const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { AppSettings } = require('../models');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

// Configure cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Default location positions matching warehouse_map.png
const DEFAULT_LOCATIONS = [
  { id: 'roundo', name: 'Roundo', xPercent: 0.22, yPercent: 0.18, description: 'Roundo machine area' },
  { id: 'rack3', name: 'Rack 3', xPercent: 0.88, yPercent: 0.22, description: 'Rack 3 - right side' },
  { id: 'runway', name: 'Runway', xPercent: 0.52, yPercent: 0.40, description: 'Center runway' },
  { id: 'rack2', name: 'Rack 2', xPercent: 0.08, yPercent: 0.55, description: 'Rack 2 - far left' },
  { id: 'rack1', name: 'Rack 1', xPercent: 0.22, yPercent: 0.55, description: 'Rack 1 - left center' },
  { id: 'kumla', name: 'Kumla', xPercent: 0.75, yPercent: 0.55, description: 'Kumla machine area' },
  { id: 'dock', name: 'Dock', xPercent: 0.15, yPercent: 0.88, description: 'Loading dock' },
  { id: 'office', name: 'Office', xPercent: 0.65, yPercent: 0.92, description: 'Office area' }
];

// GET /api/settings/locations - Get all location positions
router.get('/locations', async (req, res, next) => {
  try {
    const setting = await AppSettings.findOne({
      where: { key: 'warehouse_locations' }
    });

    if (!setting) {
      // Return defaults if not set
      return res.json({ data: DEFAULT_LOCATIONS });
    }

    res.json({ data: setting.value });
  } catch (error) {
    next(error);
  }
});

// PUT /api/settings/locations - Update all location positions
router.put('/locations', async (req, res, next) => {
  try {
    const { locations } = req.body;

    if (!locations || !Array.isArray(locations)) {
      return res.status(400).json({ error: { message: 'Locations array is required' } });
    }

    // Validate each location
    for (const loc of locations) {
      if (!loc.id || !loc.name || loc.xPercent === undefined || loc.yPercent === undefined) {
        return res.status(400).json({ 
          error: { message: 'Each location must have id, name, xPercent, and yPercent' } 
        });
      }
      if (loc.xPercent < 0 || loc.xPercent > 1 || loc.yPercent < 0 || loc.yPercent > 1) {
        return res.status(400).json({ 
          error: { message: 'xPercent and yPercent must be between 0 and 1' } 
        });
      }
    }

    // Upsert the setting
    const [setting, created] = await AppSettings.findOrCreate({
      where: { key: 'warehouse_locations' },
      defaults: { value: locations }
    });

    if (!created) {
      await setting.update({ value: locations });
    }

    res.json({ 
      data: locations,
      message: 'Locations updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/locations - Add a new location
router.post('/locations', async (req, res, next) => {
  try {
    const { id, name, xPercent, yPercent, description } = req.body;

    if (!id || !name || xPercent === undefined || yPercent === undefined) {
      return res.status(400).json({ 
        error: { message: 'id, name, xPercent, and yPercent are required' } 
      });
    }

    // Get current locations
    let setting = await AppSettings.findOne({
      where: { key: 'warehouse_locations' }
    });

    let locations = setting ? setting.value : [...DEFAULT_LOCATIONS];

    // Check if ID already exists
    if (locations.find(l => l.id === id)) {
      return res.status(400).json({ 
        error: { message: 'Location with this ID already exists' } 
      });
    }

    // Add new location
    locations.push({ id, name, xPercent, yPercent, description: description || '' });

    // Save
    if (setting) {
      await setting.update({ value: locations });
    } else {
      await AppSettings.create({
        key: 'warehouse_locations',
        value: locations
      });
    }

    res.status(201).json({ 
      data: locations,
      message: 'Location added successfully'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/settings/locations/:id - Delete a location
router.delete('/locations/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    let setting = await AppSettings.findOne({
      where: { key: 'warehouse_locations' }
    });

    if (!setting) {
      return res.status(404).json({ error: { message: 'No locations configured' } });
    }

    let locations = setting.value;
    const index = locations.findIndex(l => l.id === id);

    if (index === -1) {
      return res.status(404).json({ error: { message: 'Location not found' } });
    }

    locations.splice(index, 1);
    await setting.update({ value: locations });

    res.json({ 
      data: locations,
      message: 'Location deleted successfully'
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/settings/locations/:id - Update a single location
router.put('/locations/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, xPercent, yPercent, description } = req.body;

    let setting = await AppSettings.findOne({
      where: { key: 'warehouse_locations' }
    });

    let locations = setting ? setting.value : [...DEFAULT_LOCATIONS];
    const index = locations.findIndex(l => l.id === id);

    if (index === -1) {
      return res.status(404).json({ error: { message: 'Location not found' } });
    }

    // Update fields if provided
    if (name !== undefined) locations[index].name = name;
    if (xPercent !== undefined) locations[index].xPercent = xPercent;
    if (yPercent !== undefined) locations[index].yPercent = yPercent;
    if (description !== undefined) locations[index].description = description;

    // Save
    if (setting) {
      await setting.update({ value: locations });
    } else {
      await AppSettings.create({
        key: 'warehouse_locations',
        value: locations
      });
    }

    res.json({ 
      data: locations,
      message: 'Location updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/locations/reset - Reset to defaults
router.post('/locations/reset', async (req, res, next) => {
  try {
    const [setting, created] = await AppSettings.findOrCreate({
      where: { key: 'warehouse_locations' },
      defaults: { value: DEFAULT_LOCATIONS }
    });

    if (!created) {
      await setting.update({ value: DEFAULT_LOCATIONS });
    }

    res.json({ 
      data: DEFAULT_LOCATIONS,
      message: 'Locations reset to defaults'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

// Email notification settings routes are below

// GET /api/settings/notification-email - Get notification email
router.get('/notification-email', async (req, res, next) => {
  try {
    const setting = await AppSettings.findOne({
      where: { key: 'notification_email' }
    });

    if (!setting) {
      return res.json({ data: { email: 'carolinarolling@gmail.com' } });
    }

    res.json({ data: setting.value });
  } catch (error) {
    next(error);
  }
});

// PUT /api/settings/notification-email - Update notification email
router.put('/notification-email', async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: { message: 'Email is required' } });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: { message: 'Invalid email format' } });
    }

    const [setting, created] = await AppSettings.findOrCreate({
      where: { key: 'notification_email' },
      defaults: { value: { email } }
    });

    if (!created) {
      await setting.update({ value: { email } });
    }

    res.json({ 
      data: { email },
      message: 'Notification email updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/settings/schedule-email - Get schedule email settings
router.get('/schedule-email', async (req, res, next) => {
  try {
    const setting = await AppSettings.findOne({
      where: { key: 'schedule_email' }
    });

    if (!setting) {
      return res.json({ 
        data: { 
          email: 'carolinarolling@gmail.com',
          enabled: false 
        } 
      });
    }

    res.json({ data: setting.value });
  } catch (error) {
    next(error);
  }
});

// PUT /api/settings/schedule-email - Update schedule email settings
router.put('/schedule-email', async (req, res, next) => {
  try {
    const { email, enabled } = req.body;

    if (!email) {
      return res.status(400).json({ error: { message: 'Email is required' } });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: { message: 'Invalid email format' } });
    }

    const [setting, created] = await AppSettings.findOrCreate({
      where: { key: 'schedule_email' },
      defaults: { value: { email, enabled: enabled !== false } }
    });

    if (!created) {
      await setting.update({ value: { email, enabled: enabled !== false } });
    }

    res.json({ 
      data: { email, enabled: enabled !== false },
      message: 'Schedule email settings updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/schedule-email/send - Send schedule email now (for testing)
router.post('/schedule-email/send', async (req, res, next) => {
  try {
    const result = await sendScheduleEmail();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Helper function to send schedule email
async function sendScheduleEmail() {
  const nodemailer = require('nodemailer');
  const { Shipment, WorkOrder, WorkOrderPart, Estimate, DailyActivity, EmailLog } = require('../models');
  const { Op } = require('sequelize');
  
  // Get email settings
  const emailSetting = await AppSettings.findOne({ where: { key: 'schedule_email' } });
  const scheduleEmail = emailSetting?.value?.email || 'carolinarolling@gmail.com';
  
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('SMTP not configured, skipping schedule email');
    return { success: false, message: 'SMTP not configured' };
  }

  const TZ = 'America/Los_Angeles';
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const fmtDate = (d) => {
    if (!d) return 'Not set';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ });
  };
  const fmtDateTime = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });
  };
  const getDaysUntil = (dateString) => {
    if (!dateString) return null;
    const todayPacific = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
    todayPacific.setHours(0, 0, 0, 0);
    const target = new Date(dateString);
    target.setHours(0, 0, 0, 0);
    return Math.ceil((target - todayPacific) / (1000 * 60 * 60 * 24));
  };
  const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ });

  // ==================== GATHER DATA ====================

  // 1. Active shipments for schedule
  const activeShipments = await Shipment.findAll({
    where: { status: { [Op.notIn]: ['shipped', 'archived'] } },
    order: [['promisedDate', 'ASC']]
  });

  // 2. Active work orders
  const activeWOs = await WorkOrder.findAll({
    where: { status: { [Op.notIn]: ['archived', 'shipped', 'picked_up'] } },
    include: [{ model: WorkOrderPart, as: 'parts' }]
  });

  // 3. Active estimates
  const activeEstimates = await Estimate.findAll({
    where: { status: { [Op.notIn]: ['archived', 'declined'] } }
  });

  // 4. Activities in last 24 hours
  const recentActivities = await DailyActivity.findAll({
    where: { createdAt: { [Op.gte]: yesterday } },
    order: [['createdAt', 'DESC']]
  });

  // 5. New shipments in last 24h
  const newShipments = await Shipment.findAll({
    where: { createdAt: { [Op.gte]: yesterday } },
    order: [['createdAt', 'DESC']]
  });

  // 6. New estimates in last 24h
  const newEstimates = await Estimate.findAll({
    where: { createdAt: { [Op.gte]: yesterday } },
    order: [['createdAt', 'DESC']]
  });

  // 7. New work orders in last 24h
  const newWOs = await WorkOrder.findAll({
    where: { createdAt: { [Op.gte]: yesterday } },
    order: [['createdAt', 'DESC']]
  });

  // ==================== CATEGORIZE SCHEDULE ====================
  const overduePromised = [];
  const upcomingPromised = [];
  const overdueRequested = [];
  const upcomingRequested = [];
  const unlinkedShipments = activeShipments.filter(s => !s.workOrderId);

  activeShipments.forEach(s => {
    const promisedDays = getDaysUntil(s.promisedDate);
    const requestedDays = getDaysUntil(s.requestedDueDate);
    if (promisedDays !== null) {
      if (promisedDays < 0) overduePromised.push({ ...s.toJSON(), daysOverdue: Math.abs(promisedDays) });
      else if (promisedDays <= 7) upcomingPromised.push({ ...s.toJSON(), daysUntil: promisedDays });
    }
    if (requestedDays !== null) {
      if (requestedDays < 0) overdueRequested.push({ ...s.toJSON(), daysOverdue: Math.abs(requestedDays) });
      else if (requestedDays <= 7) upcomingRequested.push({ ...s.toJSON(), daysUntil: requestedDays });
    }
  });

  // Categorize activities
  const actEstimates = recentActivities.filter(a => a.resourceType === 'estimate');
  const actWorkOrders = recentActivities.filter(a => a.resourceType === 'work_order');
  const actPOs = recentActivities.filter(a => a.resourceType === 'purchase_order' || a.activityType === 'created' && a.description?.toLowerCase().includes('po'));
  const actBackground = recentActivities.filter(a => ['system', 'verification', 'cron', 'archive'].includes(a.resourceType) || a.activityType === 'verification');
  const actShipments = recentActivities.filter(a => a.resourceType === 'shipment' || a.resourceType === 'inbound');

  // WO status counts
  const woByStatus = {};
  activeWOs.forEach(wo => { woByStatus[wo.status] = (woByStatus[wo.status] || 0) + 1; });
  const woWaiting = activeWOs.filter(wo => !wo.parts || wo.parts.length === 0).length;

  // Estimate status counts
  const estByStatus = {};
  activeEstimates.forEach(e => { estByStatus[e.status] = (estByStatus[e.status] || 0) + 1; });

  // ==================== BUILD HTML ====================
  const sectionHeader = (emoji, title, color = '1565c0') => `
    <div style="margin: 24px 0 12px 0; padding: 10px 14px; background: ${color}; border-radius: 6px;">
      <h2 style="margin: 0; font-size: 16px; color: white;">${emoji} ${title}</h2>
    </div>`;

  const statBox = (value, label, color = '666', bg = 'f5f5f5') => `
    <div style="flex: 1; background: #${bg}; padding: 14px 8px; border-radius: 8px; text-align: center; min-width: 80px;">
      <div style="font-size: 28px; font-weight: 700; color: #${color};">${value}</div>
      <div style="font-size: 11px; color: #666; margin-top: 2px;">${label}</div>
    </div>`;

  const buildScheduleTable = (title, items, isOverdue) => {
    if (items.length === 0) return '';
    const hdrColor = isOverdue ? '#c62828' : '#1565c0';
    const bgColor = isOverdue ? '#ffebee' : '#e3f2fd';
    let html = `<h3 style="color: ${hdrColor}; margin: 16px 0 8px; padding: 6px 10px; background: ${bgColor}; border-radius: 4px; font-size: 14px;">${title} (${items.length})</h3>`;
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 13px;"><thead><tr style="background: #f5f5f5;">
      <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Client</th>
      <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">PO#</th>
      <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Promised</th>
      <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Requested</th>
      <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">${isOverdue ? 'Overdue' : 'Due In'}</th>
    </tr></thead><tbody>`;
    items.forEach((item, i) => {
      const days = isOverdue ? item.daysOverdue : item.daysUntil;
      const daysColor = isOverdue ? '#c62828' : (days <= 1 ? '#e65100' : '#333');
      html += `<tr style="background: ${i % 2 ? '#fafafa' : '#fff'};">
        <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: 600;">${item.clientName || '—'}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.clientPurchaseOrderNumber || '—'}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${fmtDate(item.promisedDate)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${fmtDate(item.requestedDueDate)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; color: ${daysColor}; font-weight: 600;">${isOverdue ? days + ' days' : (days === 0 ? 'TODAY' : days + ' days')}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    return html;
  };

  const activityList = (items, emptyMsg = 'None') => {
    if (items.length === 0) return `<p style="color: #999; font-size: 13px; margin: 4px 0;">${emptyMsg}</p>`;
    return '<ul style="margin: 4px 0; padding-left: 20px; font-size: 13px;">' +
      items.map(a => `<li style="margin: 3px 0; color: #333;"><strong>${a.resourceNumber || ''}</strong> ${a.clientName ? '— ' + a.clientName : ''} — ${a.description || a.activityType}</li>`).join('') +
      '</ul>';
  };

  // ==================== COMPOSE EMAIL ====================
  let html = `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 0;">`;

  // Header
  html += `
    <div style="background: linear-gradient(135deg, #1565c0, #0d47a1); color: white; padding: 24px; border-radius: 8px 8px 0 0;">
      <h1 style="margin: 0; font-size: 22px;">☀️ Good Morning — Daily Digest</h1>
      <p style="margin: 6px 0 0 0; opacity: 0.85; font-size: 14px;">${today}</p>
    </div>
    <div style="background: #fff; padding: 20px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px;">`;

  // Quick Stats Row
  const totalOverdue = overduePromised.length + overdueRequested.length;
  html += `<div style="display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap;">`;
  html += statBox(totalOverdue, 'Overdue', totalOverdue > 0 ? 'c62828' : '888', totalOverdue > 0 ? 'ffebee' : 'f5f5f5');
  html += statBox(upcomingPromised.length, 'Due This Week', upcomingPromised.length > 0 ? '1565c0' : '888', upcomingPromised.length > 0 ? 'e3f2fd' : 'f5f5f5');
  html += statBox(activeWOs.length, 'Active WOs', '2e7d32', 'e8f5e9');
  html += statBox(activeShipments.length, 'Active Shipments', 'e65100', 'fff3e0');
  html += statBox(activeEstimates.length, 'Open Estimates', '7b1fa2', 'f3e5f5');
  html += `</div>`;

  // ===== SECTION 1: SCHEDULE =====
  html += sectionHeader('📅', 'Schedule & Due Dates');

  if (totalOverdue === 0 && upcomingPromised.length === 0 && upcomingRequested.length === 0) {
    html += `<div style="text-align: center; padding: 20px; color: #888;"><span style="font-size: 32px;">✅</span><br>No urgent deadlines this week</div>`;
  } else {
    html += buildScheduleTable('⚠️ Overdue — Promised Date', overduePromised, true);
    html += buildScheduleTable('📅 Due This Week — Promised Date', upcomingPromised, false);
    html += buildScheduleTable('⚠️ Overdue — Requested Date', overdueRequested, true);
    html += buildScheduleTable('📅 Due This Week — Requested Date', upcomingRequested, false);
  }

  if (unlinkedShipments.length > 0) {
    html += `<div style="margin-top: 12px; padding: 10px; background: #fff3e0; border-left: 4px solid #ff9800; border-radius: 4px; font-size: 13px;">
      <strong style="color: #e65100;">⏳ ${unlinkedShipments.length} shipment${unlinkedShipments.length > 1 ? 's' : ''} waiting for instructions</strong> (no work order linked)
    </div>`;
  }

  // ===== SECTION 2: YESTERDAY'S ACTIVITY =====
  html += sectionHeader('📊', 'Last 24 Hours Activity Summary');

  // Shipments
  html += `<h3 style="margin: 12px 0 6px; font-size: 14px; color: #e65100;">🚚 Shipments (${newShipments.length} new)</h3>`;
  if (newShipments.length > 0) {
    html += '<ul style="margin: 4px 0; padding-left: 20px; font-size: 13px;">';
    newShipments.forEach(s => {
      html += `<li style="margin: 3px 0;"><strong>${s.clientName}</strong> — ${s.quantity || 1}pc${s.description ? ' — ' + s.description.substring(0, 80) : ''}${s.location ? ' 📍' + s.location : ''}</li>`;
    });
    html += '</ul>';
  } else {
    html += '<p style="color: #999; font-size: 13px; margin: 4px 0;">No new shipments</p>';
  }
  if (actShipments.length > 0) {
    html += `<div style="font-size: 12px; color: #888; margin-top: 4px;">${actShipments.length} shipment activity update${actShipments.length > 1 ? 's' : ''}</div>`;
  }

  // Estimates
  html += `<h3 style="margin: 16px 0 6px; font-size: 14px; color: #7b1fa2;">📝 Estimates (${newEstimates.length} new)</h3>`;
  if (newEstimates.length > 0) {
    html += '<ul style="margin: 4px 0; padding-left: 20px; font-size: 13px;">';
    newEstimates.forEach(e => {
      html += `<li style="margin: 3px 0;"><strong>${e.estimateNumber}</strong> — ${e.clientName}${e.grandTotal ? ' — $' + parseFloat(e.grandTotal).toLocaleString('en-US', { minimumFractionDigits: 2 }) : ''}</li>`;
    });
    html += '</ul>';
  }
  if (actEstimates.length > 0) {
    html += `<div style="font-size: 12px; color: #888; margin: 4px 0;">${actEstimates.length} estimate activity update${actEstimates.length > 1 ? 's' : ''}: `;
    html += actEstimates.map(a => `${a.activityType} ${a.resourceNumber || ''}`).join(', ');
    html += '</div>';
  }
  if (newEstimates.length === 0 && actEstimates.length === 0) {
    html += '<p style="color: #999; font-size: 13px; margin: 4px 0;">No estimate activity</p>';
  }

  // Work Orders
  html += `<h3 style="margin: 16px 0 6px; font-size: 14px; color: #2e7d32;">📋 Work Orders (${newWOs.length} new)</h3>`;
  if (newWOs.length > 0) {
    html += '<ul style="margin: 4px 0; padding-left: 20px; font-size: 13px;">';
    newWOs.forEach(wo => {
      html += `<li style="margin: 3px 0;"><strong>${wo.drNumber ? 'DR-' + wo.drNumber : wo.orderNumber}</strong> — ${wo.clientName}</li>`;
    });
    html += '</ul>';
  }
  if (actWorkOrders.length > 0) {
    html += `<div style="font-size: 12px; color: #888; margin: 4px 0;">${actWorkOrders.length} work order update${actWorkOrders.length > 1 ? 's' : ''}: `;
    html += actWorkOrders.map(a => `${a.activityType} ${a.resourceNumber || ''}`).join(', ');
    html += '</div>';
  }
  if (newWOs.length === 0 && actWorkOrders.length === 0) {
    html += '<p style="color: #999; font-size: 13px; margin: 4px 0;">No work order activity</p>';
  }

  // ===== SECTION 3: PURCHASE ORDERS =====
  html += sectionHeader('🛒', 'Purchase Orders', '#00695c');
  const poActivities = recentActivities.filter(a => a.activityType === 'created' && a.resourceType === 'purchase_order');
  if (poActivities.length > 0) {
    html += activityList(poActivities);
  } else {
    html += '<p style="color: #999; font-size: 13px; margin: 4px 0;">No purchase orders generated in last 24 hours</p>';
  }

  // ===== SECTION 4: ACTIVE WORK SUMMARY =====
  html += sectionHeader('📈', 'Current Workload', '#37474f');
  html += `<table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0;"><tr>`;
  
  // WO breakdown
  html += `<td style="vertical-align: top; padding-right: 16px; width: 50%;">`;
  html += `<strong style="font-size: 14px;">Work Orders (${activeWOs.length})</strong><br>`;
  const woStatuses = [
    ['waiting_for_materials', 'Waiting for Materials', '#ef6c00'],
    ['received', 'Received', '#1565c0'],
    ['processing', 'Processing', '#7b1fa2'],
    ['stored', 'Stored / Ready', '#2e7d32']
  ];
  woStatuses.forEach(([key, label, color]) => {
    const count = woByStatus[key] || 0;
    if (count > 0) html += `<div style="margin: 3px 0; font-size: 13px;"><span style="color: ${color}; font-weight: 600;">${count}</span> ${label}</div>`;
  });
  if (woWaiting > 0) html += `<div style="margin: 3px 0; font-size: 13px; color: #e65100;"><strong>${woWaiting}</strong> awaiting instructions</div>`;
  html += `</td>`;

  // Estimate breakdown
  html += `<td style="vertical-align: top; width: 50%;">`;
  html += `<strong style="font-size: 14px;">Estimates (${activeEstimates.length})</strong><br>`;
  const estStatuses = [
    ['draft', 'Draft', '#888'],
    ['sent', 'Sent / Pending', '#1565c0'],
    ['approved', 'Approved', '#2e7d32']
  ];
  estStatuses.forEach(([key, label, color]) => {
    const count = estByStatus[key] || 0;
    if (count > 0) html += `<div style="margin: 3px 0; font-size: 13px;"><span style="color: ${color}; font-weight: 600;">${count}</span> ${label}</div>`;
  });
  html += `</td></tr></table>`;

  // ===== SECTION 5: BACKGROUND TASKS =====
  html += sectionHeader('⚙️', 'System & Background Tasks', '#616161');
  if (actBackground.length > 0) {
    html += activityList(actBackground);
  } else {
    html += '<p style="color: #999; font-size: 13px; margin: 4px 0;">No background tasks ran in last 24 hours</p>';
  }

  // Footer
  html += `
    </div>
    <p style="text-align: center; color: #999; font-size: 11px; margin-top: 12px;">
      Automated daily digest from Carolina Rolling Shop Management System<br>
      Generated at ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })} Pacific
    </p>
  </div>`;

  // ==================== SEND ====================
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const subject = `${totalOverdue > 0 ? '⚠️' : '☀️'} Daily Digest — ${today}${totalOverdue > 0 ? ` (${totalOverdue} overdue)` : ''}`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: scheduleEmail,
    subject,
    html
  });

  // Mark recent activities as included in email
  if (recentActivities.length > 0) {
    await DailyActivity.update(
      { includedInEmail: true, emailSentAt: now },
      { where: { id: recentActivities.map(a => a.id) } }
    );
  }

  console.log(`Comprehensive daily digest sent to ${scheduleEmail}`);
  return { success: true, message: `Daily digest sent to ${scheduleEmail}` };
}

// GET /api/settings/warehouse-map - Get warehouse map image URL
router.get('/warehouse-map', async (req, res, next) => {
  try {
    const setting = await AppSettings.findOne({ where: { key: 'warehouse_map_url' } });
    res.json({ data: { url: setting?.value || null } });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/warehouse-map - Upload warehouse map image
router.post('/warehouse-map', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { message: 'Image file is required' } });
    }

    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'warehouse-maps', resource_type: 'image', public_id: 'warehouse_map', overwrite: true },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    const imageUrl = result.secure_url;

    // Save URL to settings
    const [setting, created] = await AppSettings.findOrCreate({
      where: { key: 'warehouse_map_url' },
      defaults: { value: imageUrl }
    });
    if (!created) {
      await setting.update({ value: imageUrl });
    }

    res.json({ data: { url: imageUrl }, message: 'Warehouse map uploaded successfully' });
  } catch (error) {
    console.error('Warehouse map upload error:', error);
    next(error);
  }
});

// Export the sendScheduleEmail function for cron job
module.exports = router;
module.exports.sendScheduleEmail = sendScheduleEmail;

// GET /api/settings/:key - Get a general setting by key
router.get('/:key', async (req, res, next) => {
  try {
    const setting = await AppSettings.findOne({
      where: { key: req.params.key }
    });

    if (!setting) {
      return res.status(404).json({ error: { message: 'Setting not found' } });
    }

    res.json({ data: setting });
  } catch (error) {
    next(error);
  }
});

// PUT /api/settings/:key - Update a general setting
router.put('/:key', async (req, res, next) => {
  try {
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: { message: 'Value is required' } });
    }

    const [setting, created] = await AppSettings.findOrCreate({
      where: { key: req.params.key },
      defaults: { value }
    });

    if (!created) {
      await setting.update({ value });
    }

    res.json({ 
      data: setting,
      message: created ? 'Setting created' : 'Setting updated'
    });
  } catch (error) {
    next(error);
  }
});
