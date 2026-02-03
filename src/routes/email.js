const express = require('express');
const nodemailer = require('nodemailer');
const { Op } = require('sequelize');
const { DailyActivity, EmailLog, AppSettings } = require('../models');

const router = express.Router();

// Default email settings
const DEFAULT_EMAIL = 'jason@carolinarolling.com';
const DEFAULT_SEND_TIMES = ['05:00', '14:30']; // 5am and 2:30pm

// Get email settings
async function getEmailSettings() {
  const setting = await AppSettings.findOne({ where: { key: 'email_settings' } });
  return setting?.value || {
    recipient: DEFAULT_EMAIL,
    sendTimes: DEFAULT_SEND_TIMES,
    includeEstimates: true,
    includeWorkOrders: true,
    includeInbound: true,
    includeInventory: true,
    enabled: true
  };
}

// GET /api/email/settings - Get email settings
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await getEmailSettings();
    res.json({ data: settings });
  } catch (error) {
    next(error);
  }
});

// PUT /api/email/settings - Update email settings
router.put('/settings', async (req, res, next) => {
  try {
    const { recipient, sendTimes, includeEstimates, includeWorkOrders, includeInbound, includeInventory, enabled } = req.body;

    const settings = {
      recipient: recipient || DEFAULT_EMAIL,
      sendTimes: sendTimes || DEFAULT_SEND_TIMES,
      includeEstimates: includeEstimates !== false,
      includeWorkOrders: includeWorkOrders !== false,
      includeInbound: includeInbound !== false,
      includeInventory: includeInventory !== false,
      enabled: enabled !== false
    };

    await AppSettings.upsert({
      key: 'email_settings',
      value: settings
    });

    res.json({ data: settings, message: 'Email settings updated' });
  } catch (error) {
    next(error);
  }
});

// GET /api/email/activities - Get recent activities for email preview
router.get('/activities', async (req, res, next) => {
  try {
    const { since, includeSent } = req.query;
    
    const where = {};
    if (since) {
      where.createdAt = { [Op.gte]: new Date(since) };
    }
    if (!includeSent) {
      where.includedInEmail = false;
    }

    const activities = await DailyActivity.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 100
    });

    // Group by resource type
    const grouped = {
      estimates: activities.filter(a => a.resourceType === 'estimate'),
      workOrders: activities.filter(a => a.resourceType === 'work_order'),
      inbound: activities.filter(a => a.resourceType === 'inbound'),
      inventory: activities.filter(a => a.resourceType === 'inventory'),
      drNumbers: activities.filter(a => a.resourceType === 'dr_number')
    };

    res.json({ data: { activities, grouped } });
  } catch (error) {
    next(error);
  }
});

// POST /api/email/send-daily - Manually trigger daily email
router.post('/send-daily', async (req, res, next) => {
  try {
    const result = await sendDailyEmail();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/email/test - Send test email
router.post('/test', async (req, res, next) => {
  try {
    const settings = await getEmailSettings();
    
    // For now, just log the test (actual email sending would require SMTP config)
    await EmailLog.create({
      emailType: 'test',
      recipient: settings.recipient,
      subject: 'Test Email - Carolina Rolling Shipment Tracker',
      content: 'This is a test email from the shipment tracker system.',
      sentAt: new Date(),
      status: 'simulated'
    });

    res.json({ 
      message: `Test email would be sent to ${settings.recipient}`,
      note: 'Configure SMTP settings in environment for actual email delivery'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/email/logs - Get email logs
router.get('/logs', async (req, res, next) => {
  try {
    const logs = await EmailLog.findAll({
      order: [['sentAt', 'DESC']],
      limit: 50
    });
    res.json({ data: logs });
  } catch (error) {
    next(error);
  }
});

// Function to generate and send daily email
async function sendDailyEmail() {
  const settings = await getEmailSettings();
  
  if (!settings.enabled) {
    return { message: 'Daily emails are disabled' };
  }

  // Get activities since last email
  const lastEmail = await EmailLog.findOne({
    where: { emailType: 'daily_summary' },
    order: [['sentAt', 'DESC']]
  });

  const since = lastEmail ? lastEmail.sentAt : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const activities = await DailyActivity.findAll({
    where: {
      createdAt: { [Op.gte]: since },
      includedInEmail: false
    },
    order: [['createdAt', 'ASC']]
  });

  if (activities.length === 0) {
    return { message: 'No new activities to report' };
  }

  // Group activities
  const estimates = activities.filter(a => a.resourceType === 'estimate');
  const workOrders = activities.filter(a => a.resourceType === 'work_order');
  const inbound = activities.filter(a => a.resourceType === 'inbound');
  const inventory = activities.filter(a => a.resourceType === 'inventory');

  // Generate email content
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let content = `
Carolina Rolling Daily Update
${dateStr} (${timeStr})
================================

`;

  if (settings.includeEstimates && estimates.length > 0) {
    content += `\n💰 ESTIMATES (${estimates.length} updates)\n`;
    content += '-'.repeat(40) + '\n';
    estimates.forEach(a => {
      content += `• ${a.resourceNumber} - ${a.clientName} - ${a.description}\n`;
    });
  }

  if (settings.includeWorkOrders && workOrders.length > 0) {
    content += `\n📋 WORK ORDERS (${workOrders.length} updates)\n`;
    content += '-'.repeat(40) + '\n';
    workOrders.forEach(a => {
      content += `• ${a.resourceNumber} - ${a.clientName} - ${a.description}\n`;
    });
  }

  if (settings.includeInbound && inbound.length > 0) {
    content += `\n📥 INBOUND (${inbound.length} updates)\n`;
    content += '-'.repeat(40) + '\n';
    inbound.forEach(a => {
      content += `• ${a.resourceNumber} - ${a.description}\n`;
    });
  }

  if (settings.includeInventory && inventory.length > 0) {
    content += `\n📦 INVENTORY (${inventory.length} updates)\n`;
    content += '-'.repeat(40) + '\n';
    inventory.forEach(a => {
      content += `• ${a.resourceNumber} - ${a.description}\n`;
    });
  }

  content += `
================================
Total Activities: ${activities.length}
`;

  // Log the email (actual sending would use nodemailer with SMTP config)
  await EmailLog.create({
    emailType: 'daily_summary',
    recipient: settings.recipient,
    subject: `Carolina Rolling Daily Update - ${dateStr} (${timeStr})`,
    content,
    sentAt: now,
    status: process.env.SMTP_HOST ? 'sent' : 'simulated'
  });

  // Mark activities as included
  await DailyActivity.update(
    { includedInEmail: true, emailSentAt: now },
    { where: { id: activities.map(a => a.id) } }
  );

  // If SMTP is configured, actually send the email
  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'noreply@carolinarolling.com',
      to: settings.recipient,
      subject: `Carolina Rolling Daily Update - ${dateStr} (${timeStr})`,
      text: content
    });
  }

  return {
    message: `Daily email ${process.env.SMTP_HOST ? 'sent' : 'logged'} to ${settings.recipient}`,
    activitiesCount: activities.length
  };
}

// Export for use in scheduled jobs
module.exports = router;
module.exports.sendDailyEmail = sendDailyEmail;
module.exports.getEmailSettings = getEmailSettings;
