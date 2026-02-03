const express = require('express');
const { AppSettings } = require('../models');

const router = express.Router();

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
  const { Shipment } = require('../models');
  
  // Get schedule email setting
  const emailSetting = await AppSettings.findOne({
    where: { key: 'schedule_email' }
  });
  
  const scheduleEmail = emailSetting?.value?.email || 'carolinarolling@gmail.com';
  
  // Check if SMTP is configured
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('SMTP not configured, skipping schedule email');
    return { success: false, message: 'SMTP not configured' };
  }
  
  // Get all active shipments (not shipped)
  const shipments = await Shipment.findAll({
    where: {
      status: {
        [require('sequelize').Op.ne]: 'shipped'
      }
    },
    order: [['promisedDate', 'ASC']]
  });
  
  // Helper to get days until date
  const getDaysUntil = (dateString) => {
    if (!dateString) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(dateString);
    target.setHours(0, 0, 0, 0);
    return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
  };
  
  // Helper to format date
  const formatDate = (dateString) => {
    if (!dateString) return 'Not set';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };
  
  // Categorize shipments
  const overduePromised = [];
  const upcomingPromised = [];
  const overdueRequested = [];
  const upcomingRequested = [];
  
  shipments.forEach(s => {
    const promisedDays = getDaysUntil(s.promisedDate);
    const requestedDays = getDaysUntil(s.requestedDueDate);
    
    if (promisedDays !== null) {
      if (promisedDays < 0) {
        overduePromised.push({ ...s.toJSON(), daysOverdue: Math.abs(promisedDays) });
      } else if (promisedDays <= 7) {
        upcomingPromised.push({ ...s.toJSON(), daysUntil: promisedDays });
      }
    }
    
    if (requestedDays !== null) {
      if (requestedDays < 0) {
        overdueRequested.push({ ...s.toJSON(), daysOverdue: Math.abs(requestedDays) });
      } else if (requestedDays <= 7) {
        upcomingRequested.push({ ...s.toJSON(), daysUntil: requestedDays });
      }
    }
  });
  
  // Build email HTML
  const buildSection = (title, items, isOverdue, dateField) => {
    if (items.length === 0) return '';
    
    const headerColor = isOverdue ? '#c62828' : '#1565c0';
    const bgColor = isOverdue ? '#ffebee' : '#e3f2fd';
    
    let html = `
      <div style="margin-bottom: 24px;">
        <h2 style="color: ${headerColor}; margin-bottom: 12px; padding: 8px 12px; background: ${bgColor}; border-radius: 4px;">
          ${title} (${items.length})
        </h2>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr style="background: #f5f5f5;">
              <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">Client</th>
              <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">Client PO#</th>
              <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">Received</th>
              <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">Promised</th>
              <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">Requested</th>
              <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">${isOverdue ? 'Days Overdue' : 'Days Until'}</th>
            </tr>
          </thead>
          <tbody>
    `;
    
    items.forEach((item, idx) => {
      const rowBg = idx % 2 === 0 ? '#fff' : '#fafafa';
      const days = isOverdue ? item.daysOverdue : item.daysUntil;
      const daysColor = isOverdue ? '#c62828' : (days <= 1 ? '#e65100' : '#666');
      
      html += `
        <tr style="background: ${rowBg};">
          <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.clientName || '—'}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.clientPurchaseOrderNumber || '—'}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">${formatDate(item.receivedAt)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">${formatDate(item.promisedDate)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">${formatDate(item.requestedDueDate)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; color: ${daysColor}; font-weight: 600;">
            ${isOverdue ? days + ' days overdue' : (days === 0 ? 'Today!' : days + ' days')}
          </td>
        </tr>
      `;
    });
    
    html += '</tbody></table></div>';
    return html;
  };
  
  const today = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  let emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
      <div style="background: #1976d2; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">📅 Daily Schedule Report</h1>
        <p style="margin: 8px 0 0 0; opacity: 0.9;">${today}</p>
      </div>
      <div style="background: #fff; padding: 20px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px;">
  `;
  
  // Summary
  const totalOverdue = overduePromised.length + overdueRequested.length;
  const totalUpcoming = upcomingPromised.length + upcomingRequested.length;
  
  emailHtml += `
    <div style="display: flex; gap: 16px; margin-bottom: 24px;">
      <div style="flex: 1; background: ${totalOverdue > 0 ? '#ffebee' : '#f5f5f5'}; padding: 16px; border-radius: 8px; text-align: center;">
        <div style="font-size: 32px; font-weight: 700; color: ${totalOverdue > 0 ? '#c62828' : '#666'};">${overduePromised.length}</div>
        <div style="font-size: 12px; color: #666;">Overdue (Promised)</div>
      </div>
      <div style="flex: 1; background: ${upcomingPromised.length > 0 ? '#e3f2fd' : '#f5f5f5'}; padding: 16px; border-radius: 8px; text-align: center;">
        <div style="font-size: 32px; font-weight: 700; color: ${upcomingPromised.length > 0 ? '#1565c0' : '#666'};">${upcomingPromised.length}</div>
        <div style="font-size: 12px; color: #666;">Due Soon (Promised)</div>
      </div>
      <div style="flex: 1; background: #f5f5f5; padding: 16px; border-radius: 8px; text-align: center;">
        <div style="font-size: 32px; font-weight: 700; color: #666;">${shipments.length}</div>
        <div style="font-size: 12px; color: #666;">Total Active</div>
      </div>
    </div>
  `;
  
  // Sections
  emailHtml += buildSection('⚠️ Overdue - Promised Date', overduePromised, true, 'promisedDate');
  emailHtml += buildSection('📅 Coming Up - Promised Date (Next 7 Days)', upcomingPromised, false, 'promisedDate');
  emailHtml += buildSection('⚠️ Overdue - Requested Date', overdueRequested, true, 'requestedDueDate');
  emailHtml += buildSection('📅 Coming Up - Requested Date (Next 7 Days)', upcomingRequested, false, 'requestedDueDate');
  
  if (overduePromised.length === 0 && upcomingPromised.length === 0 && 
      overdueRequested.length === 0 && upcomingRequested.length === 0) {
    emailHtml += `
      <div style="text-align: center; padding: 40px; color: #666;">
        <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
        <div style="font-size: 18px;">All caught up! No urgent deadlines.</div>
      </div>
    `;
  }
  
  emailHtml += `
      </div>
      <p style="text-align: center; color: #999; font-size: 12px; margin-top: 16px;">
        This is an automated email from your Shipment Tracker system.
      </p>
    </div>
  `;
  
  // Send email
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: scheduleEmail,
    subject: `📅 Daily Schedule Report - ${today}`,
    html: emailHtml
  });
  
  console.log(`Schedule email sent to ${scheduleEmail}`);
  return { success: true, message: `Schedule email sent to ${scheduleEmail}` };
}

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
