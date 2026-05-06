const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const multer = require('multer');
const path = require('path');
const { Liability, Employee, PayrollWeek, PayrollEntry, WorkOrder, WorkOrderPart, Vendor, PONumber, InboundOrder, sequelize } = require('../models');
const fileStorage = require('../utils/storage');

// Multer config for bill attachments
const billUpload = multer({
  dest: path.join(__dirname, '../../uploads/'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only PDF and images allowed'));
  }
}).single('file');

// ============= PAYMENTS =============

// GET /api/business/payments/outstanding - Invoiced but unpaid WOs
router.get('/payments/outstanding', async (req, res, next) => {
  try {
    const wos = await WorkOrder.findAll({
      where: {
        invoiceNumber: { [Op.ne]: null },
        paymentDate: null,
        isVoided: { [Op.or]: [null, false] }
      },
      attributes: ['id', 'orderNumber', 'drNumber', 'clientName', 'invoiceNumber', 'invoiceDate', 'grandTotal', 'clientPurchaseOrderNumber', 'createdAt'],
      order: [['invoiceDate', 'ASC']]
    });
    
    // Calculate aging
    const now = new Date();
    const data = wos.map(wo => {
      const inv = wo.invoiceDate ? new Date(wo.invoiceDate) : new Date(wo.createdAt);
      const daysOut = Math.floor((now - inv) / 86400000);
      return { ...wo.toJSON(), daysOutstanding: daysOut };
    });
    
    const totalOutstanding = data.reduce((s, w) => s + (parseFloat(w.grandTotal) || 0), 0);
    const over30 = data.filter(w => w.daysOutstanding > 30);
    const over60 = data.filter(w => w.daysOutstanding > 60);
    const over90 = data.filter(w => w.daysOutstanding > 90);
    
    res.json({ data: { invoices: data, totalOutstanding, count: data.length, over30: over30.length, over60: over60.length, over90: over90.length } });
  } catch (error) { next(error); }
});

// GET /api/business/payments/history - Paid WOs
router.get('/payments/history', async (req, res, next) => {
  try {
    const { limit = 100 } = req.query;
    const wos = await WorkOrder.findAll({
      where: {
        paymentDate: { [Op.ne]: null },
        isVoided: { [Op.or]: [null, false] }
      },
      attributes: ['id', 'orderNumber', 'drNumber', 'clientName', 'invoiceNumber', 'invoiceDate', 'grandTotal', 'paymentDate', 'paymentMethod', 'paymentReference', 'paymentRecordedBy', 'clientPurchaseOrderNumber'],
      order: [['paymentDate', 'DESC']],
      limit: parseInt(limit)
    });
    const totalReceived = wos.reduce((s, w) => s + (parseFloat(w.grandTotal) || 0), 0);
    res.json({ data: { payments: wos, totalReceived, count: wos.length } });
  } catch (error) { next(error); }
});

// POST /api/business/payments/:woId/record - Record payment on a WO
router.post('/payments/:woId/record', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.woId);
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });
    await wo.update({
      paymentDate: req.body.paymentDate || new Date(),
      paymentMethod: req.body.paymentMethod || '',
      paymentReference: req.body.paymentReference || '',
      paymentRecordedBy: req.body.recordedBy || 'admin'
    });
    res.json({ data: wo, message: `Payment recorded for ${wo.invoiceNumber}` });
  } catch (error) { next(error); }
});

// POST /api/business/payments/:woId/clear - Clear payment (undo)
router.post('/payments/:woId/clear', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.woId);
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });
    await wo.update({ paymentDate: null, paymentMethod: null, paymentReference: null, paymentRecordedBy: null });
    res.json({ data: wo, message: 'Payment cleared' });
  } catch (error) { next(error); }
});

// ============= LIABILITIES =============

// GET /api/business/liabilities
router.get('/liabilities', async (req, res, next) => {
  try {
    const { status, category } = req.query;
    const where = {};
    if (status && status !== 'all') where.status = status;
    if (category && category !== 'all') where.category = category;
    const liabilities = await Liability.findAll({ where, order: [['dueDate', 'ASC']] });
    res.json({ data: liabilities });
  } catch (error) { next(error); }
});

// POST /api/business/liabilities
router.post('/liabilities', async (req, res, next) => {
  try {
    const liability = await Liability.create(req.body);
    res.json({ data: liability, message: 'Bill added' });
  } catch (error) { next(error); }
});

// PUT /api/business/liabilities/:id
router.put('/liabilities/:id', async (req, res, next) => {
  try {
    const liability = await Liability.findByPk(req.params.id);
    if (!liability) return res.status(404).json({ error: { message: 'Not found' } });
    await liability.update(req.body);
    res.json({ data: liability, message: 'Updated' });
  } catch (error) { next(error); }
});

// POST /api/business/liabilities/:id/pay - Mark as paid
router.post('/liabilities/:id/pay', async (req, res, next) => {
  try {
    const liability = await Liability.findByPk(req.params.id);
    if (!liability) return res.status(404).json({ error: { message: 'Not found' } });
    await liability.update({
      status: 'paid',
      paidAt: new Date(),
      paidAmount: req.body.paidAmount || liability.amount
    });

    // If recurring, create next occurrence
    if (liability.recurring && liability.recurringInterval && liability.dueDate) {
      const nextDate = new Date(liability.dueDate);
      switch (liability.recurringInterval) {
        case 'weekly': nextDate.setDate(nextDate.getDate() + 7); break;
        case 'monthly': nextDate.setMonth(nextDate.getMonth() + 1); break;
        case 'quarterly': nextDate.setMonth(nextDate.getMonth() + 3); break;
        case 'yearly': nextDate.setFullYear(nextDate.getFullYear() + 1); break;
      }
      await Liability.create({
        name: liability.name,
        category: liability.category,
        amount: liability.amount,
        dueDate: nextDate.toISOString().split('T')[0],
        recurring: true,
        recurringInterval: liability.recurringInterval,
        vendor: liability.vendor,
        notes: liability.notes,
        referenceNumber: liability.referenceNumber,
        status: 'unpaid'
      });
    }

    res.json({ data: liability, message: 'Marked as paid' });
  } catch (error) { next(error); }
});

// DELETE /api/business/liabilities/:id
router.delete('/liabilities/:id', async (req, res, next) => {
  try {
    const liability = await Liability.findByPk(req.params.id);
    if (!liability) return res.status(404).json({ error: { message: 'Not found' } });
    // Clean up file if exists
    if (liability.invoiceFileCloudinaryId) {
      try { await fileStorage.deleteFile(liability.invoiceFileCloudinaryId); } catch {}
    }
    await liability.destroy();
    res.json({ message: 'Deleted' });
  } catch (error) { next(error); }
});

// POST /api/business/liabilities/:id/upload - Upload invoice file
router.post('/liabilities/:id/upload', (req, res, next) => {
  billUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: { message: err.message } });
    try {
      const liability = await Liability.findByPk(req.params.id);
      if (!liability) return res.status(404).json({ error: { message: 'Not found' } });
      if (!req.file) return res.status(400).json({ error: { message: 'No file' } });

      // Delete old file
      if (liability.invoiceFileCloudinaryId) {
        try { await fileStorage.deleteFile(liability.invoiceFileCloudinaryId); } catch {}
      }

      const result = await fileStorage.uploadFile(req.file.path, {
        folder: 'bill-invoices',
        resource_type: 'raw',
        public_id: `bill-${liability.id}-${Date.now()}`
      });

      await liability.update({
        invoiceFileUrl: result.url,
        invoiceFileCloudinaryId: result.storageId
      });

      // Clean up temp file
      try { require('fs').unlinkSync(req.file.path); } catch {}

      res.json({ data: liability, message: 'Invoice uploaded' });
    } catch (error) { next(error); }
  });
});

// POST /api/business/liabilities/:id/approve - Approve pending bill
router.post('/liabilities/:id/approve', async (req, res, next) => {
  try {
    const liability = await Liability.findByPk(req.params.id);
    if (!liability) return res.status(404).json({ error: { message: 'Not found' } });
    // Apply any corrections from the request body
    const updates = { status: 'unpaid' };
    ['name', 'amount', 'dueDate', 'vendor', 'category', 'poNumber', 'vendorInvoiceNumber', 'notes'].forEach(f => {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    });
    await liability.update(updates);
    res.json({ data: liability, message: 'Bill approved' });
  } catch (error) { next(error); }
});

// POST /api/business/liabilities/:id/reject - Reject pending bill
router.post('/liabilities/:id/reject', async (req, res, next) => {
  try {
    const liability = await Liability.findByPk(req.params.id);
    if (!liability) return res.status(404).json({ error: { message: 'Not found' } });
    if (liability.invoiceFileCloudinaryId) {
      try { await fileStorage.deleteFile(liability.invoiceFileCloudinaryId); } catch {}
    }
    await liability.destroy();
    res.json({ message: 'Bill rejected and deleted' });
  } catch (error) { next(error); }
});

// GET /api/business/liabilities/summary - Dashboard stats
router.get('/liabilities/summary', async (req, res, next) => {
  try {
    const unpaid = await Liability.findAll({ where: { status: 'unpaid' } });
    const overdue = unpaid.filter(l => l.dueDate && new Date(l.dueDate) < new Date());
    const dueThisWeek = unpaid.filter(l => {
      if (!l.dueDate) return false;
      const due = new Date(l.dueDate);
      const now = new Date();
      const weekEnd = new Date(now);
      weekEnd.setDate(weekEnd.getDate() + 7);
      return due >= now && due <= weekEnd;
    });

    const totalUnpaid = unpaid.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
    const totalOverdue = overdue.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
    const totalDueThisWeek = dueThisWeek.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

    // By category
    const byCategory = {};
    unpaid.forEach(l => {
      if (!byCategory[l.category]) byCategory[l.category] = 0;
      byCategory[l.category] += parseFloat(l.amount) || 0;
    });

    const pendingReview = await Liability.count({ where: { status: 'pending_review' } });

    res.json({ data: { totalUnpaid, totalOverdue, totalDueThisWeek, overdueCount: overdue.length, dueThisWeekCount: dueThisWeek.length, byCategory, pendingReview } });
  } catch (error) { next(error); }
});

// ============= EMPLOYEES =============

// GET /api/business/employees
router.get('/employees', async (req, res, next) => {
  try {
    const { active } = req.query;
    const where = {};
    if (active !== 'all') where.isActive = true;
    const employees = await Employee.findAll({ where, order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
    res.json({ data: employees });
  } catch (error) { next(error); }
});

// POST /api/business/employees
router.post('/employees', async (req, res, next) => {
  try {
    const data = { ...req.body };
    if (data.annualVacationDays === '' || data.annualVacationDays === null) data.annualVacationDays = 0;
    if (data.hourlyRate === '') data.hourlyRate = 0;
    if (data.vacationDaysUsed === '' || data.vacationDaysUsed === null) data.vacationDaysUsed = 0;
    const employee = await Employee.create(data);
    res.json({ data: employee, message: 'Employee added' });
  } catch (error) { next(error); }
});

// PUT /api/business/employees/:id
router.put('/employees/:id', async (req, res, next) => {
  try {
    const employee = await Employee.findByPk(req.params.id);
    if (!employee) return res.status(404).json({ error: { message: 'Not found' } });
    const data = { ...req.body };
    if (data.annualVacationDays === '' || data.annualVacationDays === null) data.annualVacationDays = 0;
    if (data.hourlyRate === '') data.hourlyRate = 0;
    await employee.update(data);
    res.json({ data: employee, message: 'Updated' });
  } catch (error) { next(error); }
});

// POST /api/business/employees/reorder - Save employee sort order
router.post('/employees/reorder', async (req, res, next) => {
  try {
    const { order } = req.body; // array of { id, sortOrder }
    if (!Array.isArray(order)) return res.status(400).json({ error: { message: 'order array required' } });
    for (const { id, sortOrder } of order) {
      await Employee.update({ sortOrder }, { where: { id } });
    }
    res.json({ data: null, message: 'Order saved' });
  } catch (error) { next(error); }
});

// DELETE /api/business/employees/:id
router.delete('/employees/:id', async (req, res, next) => {
  try {
    const employee = await Employee.findByPk(req.params.id);
    if (!employee) return res.status(404).json({ error: { message: 'Not found' } });
    await employee.update({ isActive: false }); // soft delete
    res.json({ message: 'Employee deactivated' });
  } catch (error) { next(error); }
});

// PUT /api/business/employees/:id/vacation-log - Update vacation log
router.put('/employees/:id/vacation-log', async (req, res, next) => {
  try {
    const employee = await Employee.findByPk(req.params.id);
    if (!employee) return res.status(404).json({ error: { message: 'Not found' } });
    const log = req.body.vacationLog || [];
    const totalHours = log.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0);
    const totalDays = totalHours / 8;
    await employee.update({ vacationLog: log, vacationDaysUsed: totalDays });
    res.json({ data: employee, message: 'Vacation log updated' });
  } catch (error) { next(error); }
});

// ============= PAYROLL =============

// GET /api/business/payroll - List payroll weeks
router.get('/payroll', async (req, res, next) => {
  try {
    const payrolls = await PayrollWeek.findAll({
      include: [{ model: PayrollEntry, as: 'entries' }],
      order: [['weekStart', 'DESC']],
      limit: 52
    });
    res.json({ data: payrolls });
  } catch (error) { next(error); }
});

// POST /api/business/payroll - Create weekly payroll
router.post('/payroll', async (req, res, next) => {
  try {
    const { weekStart, weekEnd } = req.body;

    // Check for existing
    const existing = await PayrollWeek.findOne({ where: { weekStart } });
    if (existing) return res.status(400).json({ error: { message: 'Payroll already exists for this week' } });

    const payroll = await PayrollWeek.create({ weekStart, weekEnd });

    // Auto-populate with active employees
    const employees = await Employee.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
    for (const emp of employees) {
      await PayrollEntry.create({
        payrollWeekId: payroll.id,
        employeeId: emp.id,
        employeeName: emp.name,
        hourlyRate: emp.hourlyRate,
        regularHours: 40,
        overtimeHours: 0,
        vacationHours: 0,
        bonus: 0,
        overtimeDetails: [],
        grossPay: 0,
        sortOrder: emp.sortOrder ?? 999
      });
    }

    const full = await PayrollWeek.findByPk(payroll.id, {
      include: [{ model: PayrollEntry, as: 'entries' }]
    });
    res.json({ data: full, message: 'Payroll created' });
  } catch (error) { next(error); }
});

// GET /api/business/payroll/:id
router.get('/payroll/:id', async (req, res, next) => {
  try {
    const payroll = await PayrollWeek.findByPk(req.params.id, {
      include: [{ model: PayrollEntry, as: 'entries' }]
    });
    if (!payroll) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ data: payroll });
  } catch (error) { next(error); }
});

// PUT /api/business/payroll/:id/entries/:entryId - Update entry
router.put('/payroll/:id/entries/:entryId', async (req, res, next) => {
  try {
    const entry = await PayrollEntry.findByPk(req.params.entryId);
    if (!entry) return res.status(404).json({ error: { message: 'Entry not found' } });

    const updates = { ...req.body };
    // Recalculate gross
    const rate = parseFloat(updates.hourlyRate || entry.hourlyRate) || 0;
    const reg = parseFloat(updates.regularHours ?? entry.regularHours) || 0;
    const ot = parseFloat(updates.overtimeHours ?? entry.overtimeHours) || 0;
    const vac = parseFloat(updates.vacationHours ?? entry.vacationHours) || 0;
    const bonus = parseFloat(updates.bonus ?? entry.bonus) || 0;
    updates.grossPay = (reg * rate) + (ot * rate * 1.5) + (vac * rate) + bonus;

    await entry.update(updates);

    // Update payroll week total
    const allEntries = await PayrollEntry.findAll({ where: { payrollWeekId: req.params.id } });
    const totalGross = allEntries.reduce((s, e) => s + (parseFloat(e.grossPay) || 0), 0);
    await PayrollWeek.update({ totalGross }, { where: { id: req.params.id } });

    res.json({ data: entry, message: 'Updated' });
  } catch (error) { next(error); }
});

// PUT /api/business/payroll/:id - Update payroll week (dates, notes)
router.put('/payroll/:id', async (req, res, next) => {
  try {
    const payroll = await PayrollWeek.findByPk(req.params.id);
    if (!payroll) return res.status(404).json({ error: { message: 'Not found' } });
    await payroll.update(req.body);
    const full = await PayrollWeek.findByPk(payroll.id, { include: [{ model: PayrollEntry, as: 'entries' }] });
    res.json({ data: full, message: 'Updated' });
  } catch (error) { next(error); }
});

// POST /api/business/payroll/:id/submit - Submit payroll
router.post('/payroll/:id/submit', async (req, res, next) => {
  try {
    const payroll = await PayrollWeek.findByPk(req.params.id, {
      include: [{ model: PayrollEntry, as: 'entries' }]
    });
    if (!payroll) return res.status(404).json({ error: { message: 'Not found' } });
    await payroll.update({ status: 'submitted', submittedAt: new Date(), submittedBy: req.body.submittedBy || 'admin' });
    
    // Update vacation days used for each employee
    for (const entry of (payroll.entries || [])) {
      const vacHours = parseFloat(entry.vacationHours) || 0;
      if (vacHours > 0 && entry.employeeId) {
        const emp = await Employee.findByPk(entry.employeeId);
        if (emp) {
          const vacDays = vacHours / 8;
          const currentUsed = parseFloat(emp.vacationDaysUsed) || 0;
          const log = Array.isArray(emp.vacationLog) ? [...emp.vacationLog] : [];
          // Add entries from vacation dates if available
          const dates = entry.vacationDates && entry.vacationDates.length > 0 ? entry.vacationDates : [];
          if (dates.length > 0) {
            for (const d of dates) {
              const dateStr = typeof d === 'string' ? d : d.date;
              const hrs = typeof d === 'object' && d.hours ? parseFloat(d.hours) : (vacHours / dates.length);
              log.push({ date: dateStr, hours: parseFloat(hrs.toFixed(1)), note: '', source: 'payroll', payrollWeekId: payroll.id });
            }
          } else {
            log.push({ date: payroll.weekEnd, hours: vacHours, note: `Week of ${payroll.weekStart}`, source: 'payroll', payrollWeekId: payroll.id });
          }
          await emp.update({ vacationDaysUsed: currentUsed + vacDays, vacationLog: log });
        }
      }
    }
    
    res.json({ data: payroll, message: 'Payroll submitted' });
  } catch (error) { next(error); }
});

// DELETE /api/business/payroll/:id - Delete a draft payroll
router.delete('/payroll/:id', async (req, res, next) => {
  try {
    const payroll = await PayrollWeek.findByPk(req.params.id);
    if (!payroll) return res.status(404).json({ error: { message: 'Not found' } });
    if (payroll.status === 'submitted') return res.status(400).json({ error: { message: 'Cannot delete submitted payroll' } });
    await PayrollEntry.destroy({ where: { payrollWeekId: payroll.id } });
    await payroll.destroy();
    res.json({ message: 'Payroll draft deleted' });
  } catch (error) { next(error); }
});

// ============= WELD PROCEDURES (WPS) =============

// GET /api/business/wps - Get all weld procedures
router.get('/wps', async (req, res, next) => {
  try {
    const { WeldProcedure } = require('../models');
    const wps = await WeldProcedure.findAll({ order: [['wpsNumber', 'ASC']] });
    res.json({ data: wps });
  } catch (error) { next(error); }
});

// GET /api/business/wps/:id - Get single WPS
router.get('/wps/:id', async (req, res, next) => {
  try {
    const { WeldProcedure } = require('../models');
    const wps = await WeldProcedure.findByPk(req.params.id);
    if (!wps) return res.status(404).json({ error: { message: 'WPS not found' } });
    res.json({ data: wps });
  } catch (error) { next(error); }
});

// POST /api/business/wps - Create WPS
router.post('/wps', async (req, res, next) => {
  try {
    const { WeldProcedure } = require('../models');
    const wps = await WeldProcedure.create(req.body);
    res.json({ data: wps, message: 'WPS created' });
  } catch (error) { next(error); }
});

// PUT /api/business/wps/:id - Update WPS
router.put('/wps/:id', async (req, res, next) => {
  try {
    const { WeldProcedure } = require('../models');
    const wps = await WeldProcedure.findByPk(req.params.id);
    if (!wps) return res.status(404).json({ error: { message: 'WPS not found' } });
    await wps.update(req.body);
    res.json({ data: wps, message: 'WPS updated' });
  } catch (error) { next(error); }
});

// DELETE /api/business/wps/:id - Delete WPS
router.delete('/wps/:id', async (req, res, next) => {
  try {
    const { WeldProcedure } = require('../models');
    const wps = await WeldProcedure.findByPk(req.params.id);
    if (!wps) return res.status(404).json({ error: { message: 'WPS not found' } });
    await wps.destroy();
    res.json({ message: 'WPS deleted' });
  } catch (error) { next(error); }
});

// ============= CALENDAR =============

// GET /api/business/calendar
router.get('/calendar', async (req, res, next) => {
  try {
    const { year } = req.query;
    const where = {};
    if (year) {
      where.eventDate = {
        [Op.gte]: `${year}-01-01`,
        [Op.lte]: `${year}-12-31`
      };
    }
    const events = await BusinessEvent.findAll({ where, order: [['eventDate', 'ASC']] });

    // Auto-mark overdue
    const now = new Date();
    for (const evt of events) {
      if (evt.status === 'upcoming' && evt.eventDate && new Date(evt.eventDate) < now) {
        await evt.update({ status: 'overdue' });
        evt.status = 'overdue';
      }
    }

    res.json({ data: events });
  } catch (error) { next(error); }
});

// GET /api/business/calendar/upcoming - Events due within reminderDays
router.get('/calendar/upcoming', async (req, res, next) => {
  try {
    const events = await BusinessEvent.findAll({
      where: { status: { [Op.in]: ['upcoming', 'overdue'] } },
      order: [['eventDate', 'ASC']]
    });
    const now = new Date();
    const reminders = events.filter(evt => {
      const due = new Date(evt.eventDate);
      const daysUntil = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
      return daysUntil <= (evt.reminderDays || 30);
    });
    res.json({ data: reminders });
  } catch (error) { next(error); }
});

// POST /api/business/calendar
router.post('/calendar', async (req, res, next) => {
  try {
    const event = await BusinessEvent.create(req.body);
    res.json({ data: event, message: 'Event added' });
  } catch (error) { next(error); }
});

// PUT /api/business/calendar/:id
router.put('/calendar/:id', async (req, res, next) => {
  try {
    const event = await BusinessEvent.findByPk(req.params.id);
    if (!event) return res.status(404).json({ error: { message: 'Not found' } });
    await event.update(req.body);
    res.json({ data: event, message: 'Updated' });
  } catch (error) { next(error); }
});

// POST /api/business/calendar/:id/complete - Mark completed, create next if recurring
router.post('/calendar/:id/complete', async (req, res, next) => {
  try {
    const event = await BusinessEvent.findByPk(req.params.id);
    if (!event) return res.status(404).json({ error: { message: 'Not found' } });
    await event.update({ status: 'completed', completedAt: new Date() });

    if (event.recurring && event.recurringInterval) {
      const nextDate = new Date(event.eventDate);
      switch (event.recurringInterval) {
        case 'monthly': nextDate.setMonth(nextDate.getMonth() + 1); break;
        case 'quarterly': nextDate.setMonth(nextDate.getMonth() + 3); break;
        case 'yearly': nextDate.setFullYear(nextDate.getFullYear() + 1); break;
      }
      await BusinessEvent.create({
        title: event.title,
        description: event.description,
        category: event.category,
        eventDate: nextDate.toISOString().split('T')[0],
        reminderDays: event.reminderDays,
        recurring: true,
        recurringInterval: event.recurringInterval,
        cost: event.cost,
        notes: event.notes,
        status: 'upcoming'
      });
    }

    res.json({ data: event, message: `Completed${event.recurring ? ' — next occurrence created' : ''}` });
  } catch (error) { next(error); }
});

// DELETE /api/business/calendar/:id
router.delete('/calendar/:id', async (req, res, next) => {
  try {
    const event = await BusinessEvent.findByPk(req.params.id);
    if (!event) return res.status(404).json({ error: { message: 'Not found' } });
    await event.destroy();
    res.json({ message: 'Deleted' });
  } catch (error) { next(error); }
});

// ============= VENDOR HISTORY =============

// GET /api/business/vendor-history/:vendorId
router.get('/vendor-history/:vendorId', async (req, res, next) => {
  try {
    const vendorId = req.params.vendorId;
    
    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Vendor not found' } });

    // PO Numbers for this vendor (by vendorId or supplier name)
    const poNumbers = await PONumber.findAll({
      where: {
        [Op.or]: [
          { vendorId },
          { supplier: { [Op.iLike]: `%${vendor.name}%` } }
        ]
      },
      order: [['poNumber', 'DESC']]
    });

    // Work order parts supplied by this vendor (by vendorId or supplierName)
    const woParts = await WorkOrderPart.findAll({
      where: {
        [Op.or]: [
          { vendorId },
          { supplierName: { [Op.iLike]: `%${vendor.name}%` } }
        ]
      },
      attributes: ['id', 'partNumber', 'materialDescription', 'materialTotal', 'materialPurchaseOrderNumber', 'workOrderId', 'quantity'],
      order: [['createdAt', 'DESC']]
    });

    // Get unique WO ids and load them
    const woIds = [...new Set(woParts.map(p => p.workOrderId).filter(Boolean))];
    const workOrders = woIds.length > 0 ? await WorkOrder.findAll({
      where: { id: woIds },
      attributes: ['id', 'orderNumber', 'drNumber', 'clientName', 'status', 'grandTotal', 'invoiceNumber', 'paymentDate', 'createdAt']
    }) : [];
    const woMap = {};
    workOrders.forEach(wo => { woMap[wo.id] = wo.toJSON(); });

    // Enrich parts with WO info
    const enrichedParts = woParts.map(p => ({
      ...p.toJSON(),
      workOrder: woMap[p.workOrderId] || null
    }));

    // Liabilities linked to this vendor
    const liabilities = await Liability.findAll({
      where: { vendor: { [Op.iLike]: `%${vendor.name}%` } },
      order: [['dueDate', 'DESC']],
      limit: 50
    });

    // Inbound orders from this vendor
    const inboundOrders = await InboundOrder.findAll({
      where: {
        [Op.or]: [
          { vendorId },
          { supplierName: { [Op.iLike]: `%${vendor.name}%` } },
          { supplier: { [Op.iLike]: `%${vendor.name}%` } }
        ]
      },
      order: [['createdAt', 'DESC']],
      limit: 50
    });

    res.json({
      data: {
        poNumbers: poNumbers.map(p => p.toJSON()),
        parts: enrichedParts,
        workOrders: workOrders.map(w => w.toJSON()),
        liabilities: liabilities.map(l => l.toJSON()),
        inboundOrders: inboundOrders.map(o => o.toJSON()),
        totalMaterialValue: enrichedParts.reduce((s, p) => s + (parseFloat(p.materialTotal) || 0) * (parseInt(p.quantity) || 1), 0)
      }
    });
  } catch (error) { next(error); }
});

// GET /api/business/payroll/:id/preview-pdf - Preview payroll PDF
router.get('/payroll/:id/preview-pdf', async (req, res, next) => {
  try {
    const payroll = await Payroll.findByPk(req.params.id, { include: [{ model: PayrollEntry, as: 'entries' }] });
    if (!payroll) return res.status(404).json({ error: { message: 'Not found' } });
    const employees = await Employee.findAll({ where: { isActive: true } });
    const sortedEntries = (payroll.entries || []).slice().sort((a, b) => ((a.sortOrder ?? 999) - (b.sortOrder ?? 999)) || a.employeeName.localeCompare(b.employeeName));
    const enriched = sortedEntries.map(en => {
      const emp = employees.find(e => e.id === en.employeeId) || {};
      return { ...en.toJSON(), controlNumber: emp.controlNumber || '', deductions: emp.deductions || '', description: emp.description || '' };
    });
    const sd = new Date(payroll.weekStart + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const ed = new Date(payroll.weekEnd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const path = require('path');
    const fs = require('fs');
    const logoFile = [path.join(__dirname, '../assets/logo.png'), path.join(__dirname, '../assets/logo.jpg')].find(p => fs.existsSync(p));
    const yellowcakePath = path.join(__dirname, '../assets/fonts/Yellowcake-Regular.ttf');
    const PDFDocument = require('pdfkit');
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const L = 50, W = 512;
      if (logoFile) try { doc.image(logoFile, L, 22, { width: 65 }); } catch {}
      let hasYellowcake = false;
      try { if (fs.existsSync(yellowcakePath)) { doc.registerFont('Yellowcake', yellowcakePath); hasYellowcake = true; } } catch {}
      if (hasYellowcake) doc.font('Yellowcake').fontSize(15).fillColor('#1a1a1a').text('Carolina Rolling Co. Inc.', 130, 32, { lineBreak: false });
      else doc.font('Helvetica-Bold').fontSize(15).fillColor('#1a1a1a').text('CAROLINA ROLLING CO. INC.', 130, 32, { lineBreak: false });
      doc.font('Helvetica').fontSize(8.5).fillColor('#777');
      doc.text('9152 Sonrisa St., Bellflower, CA 90706', 130, 52, { lineBreak: false });
      doc.text('Phone: (562) 633-1044  |  Email: keepitrolling@carolinarolling.com', 130, 63, { lineBreak: false });
      doc.moveTo(L, 90).lineTo(L + W, 90).lineWidth(1).strokeColor('#e0e0e0').stroke();
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#e65100').text('PAYROLL SUMMARY', L, 100);
      doc.fontSize(9).font('Helvetica').fillColor('#555').text('Payroll Period: ' + sd + ' — ' + ed, L, 116);
      const genDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: 'numeric' });
      const genTime = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT';
      doc.fontSize(8).fillColor('#888').text(genDate + '  ' + genTime, L + W - 100, 100, { width: 100, align: 'right', lineBreak: false });
      doc.moveTo(L, 130).lineTo(L + W, 130).lineWidth(0.5).strokeColor('#e0e0e0').stroke();
      let y = 140;
      const cols = [
        { label: '#', x: L, w: 44 }, { label: 'Name', x: L+44, w: 108 },
        { label: 'Deductions', x: L+152, w: 80 }, { label: 'Description', x: L+232, w: 80 },
        { label: 'Rate', x: L+312, w: 44, align: 'center' }, { label: 'Hours', x: L+356, w: 38, align: 'center' },
        { label: 'OT', x: L+394, w: 34, align: 'center' }, { label: 'Other', x: L+428, w: 56, align: 'center' },
        { label: 'Notes', x: L+484, w: 78, align: 'right' },
      ];
      doc.rect(L, y, W, 16).fill('#1a1a1a');
      cols.forEach(c => { doc.fontSize(7.5).font('Helvetica-Bold').fillColor('white').text(c.label, c.x + 2, y + 4, { width: c.w - 4, align: c.align || 'left', lineBreak: false }); });
      y += 16;
      enriched.forEach((en, idx) => {
        const rowH = 18;
        if (y + rowH > 720) { doc.addPage(); y = 50; }
        if (idx % 2 === 1) doc.rect(L, y, W, rowH).fill('#f7f7f7');
        doc.rect(L, y, W, rowH).lineWidth(0.3).strokeColor('#cccccc').stroke();
        const otherParts = [];
        if (parseFloat(en.vacationHours) > 0) otherParts.push('Vac ' + en.vacationHours + 'h');
        if (parseFloat(en.bonus) > 0) otherParts.push('$' + parseFloat(en.bonus).toFixed(2));
        const rowData = [
          { val: en.controlNumber || '', col: cols[0] }, { val: en.employeeName, col: cols[1], bold: true },
          { val: en.deductions || '', col: cols[2] }, { val: en.description || '', col: cols[3] },
          { val: '$' + parseFloat(en.hourlyRate || 0).toFixed(2), col: cols[4] },
          { val: String(en.regularHours || 0), col: cols[5], bold: true },
          { val: String(en.overtimeHours || 0), col: cols[6], bold: true, color: parseFloat(en.overtimeHours) > 0 ? '#c62828' : '#888' },
          { val: otherParts.join(' '), col: cols[7] }, { val: en.notes || '', col: cols[8] },
        ];
        rowData.forEach(({ val, col, bold, color }) => { doc.fontSize(8).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color || '#1a1a1a').text(val, col.x + 2, y + 5, { width: col.w - 4, align: col.align || 'left', lineBreak: false }); });
        y += rowH;
      });
      y += 8;
      doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#cccccc').stroke(); y += 8;
      const totalReg = enriched.reduce((s, e) => s + (parseFloat(e.regularHours) || 0), 0);
      const totalOT = enriched.reduce((s, e) => s + (parseFloat(e.overtimeHours) || 0), 0);
      doc.fontSize(9).font('Helvetica').fillColor('#888').text(enriched.length + ' employees  ·  ' + totalReg + ' reg hrs  ·  ' + totalOT + ' OT hrs', L, y);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a').text('Total: $' + parseFloat(payroll.totalGross || 0).toFixed(2), L, y, { align: 'right', width: W });
      doc.fontSize(7).font('Helvetica').fillColor('#aaa').text('Carolina Rolling Co. Inc.  |  (562) 633-1044  |  keepitrolling@carolinarolling.com', L, 748, { width: W, align: 'center', lineBreak: false });
      doc.end();
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="Payroll-Preview.pdf"');
    res.send(pdfBuffer);
  } catch (e) { next(e); }
});

// POST /api/business/payroll/:id/send-email - Send payroll sheet via connected Gmail account
router.post('/payroll/:id/send-email', async (req, res, next) => {
  try {
    const { gmailAccountId, toEmail, subject, body } = req.body;
    if (!gmailAccountId || !toEmail) {
      return res.status(400).json({ error: { message: 'gmailAccountId and toEmail are required' } });
    }

    // Load payroll with entries
    const payroll = await PayrollWeek.findByPk(req.params.id, {
      include: [{ model: PayrollEntry, as: 'entries' }]
    });
    if (!payroll) return res.status(404).json({ error: { message: 'Payroll not found' } });

    // Load Gmail account
    const { GmailAccount, Employee } = require('../models');
    const account = await GmailAccount.findByPk(gmailAccountId);
    if (!account) return res.status(404).json({ error: { message: 'Gmail account not found' } });

    // Load employees for sortOrder, controlNumber, deductions, description
    const employees = await Employee.findAll({ order: [['sortOrder', 'ASC'], ['name', 'ASC']] });

    // Build sorted entries
    const sortedEntries = (payroll.entries || [])
      .slice()
      .sort((a, b) => ((a.sortOrder ?? 999) - (b.sortOrder ?? 999)) || a.employeeName.localeCompare(b.employeeName));
    const enriched = sortedEntries.map(en => {
      const emp = employees.find(e => e.id === en.employeeId) || {};
      return { ...en.toJSON(), controlNumber: emp.controlNumber || '', deductions: emp.deductions || '', description: emp.description || '' };
    });

    const sd = new Date(payroll.weekStart + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const ed = new Date(payroll.weekEnd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    // Build payroll PDF using PDFKit — styled to match shipment receipt
    const PDFDocument = require('pdfkit');
    const logoFile = [path.join(__dirname, '../assets/logo.png'), path.join(__dirname, '../assets/logo.jpg')].find(p => fs.existsSync(p));
    const yellowcakePath = path.join(__dirname, '../assets/fonts/Yellowcake-Regular.ttf');

    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = 50, W = 512;

      // ── Logo + Header (matches shipment receipt) ──
      if (logoFile) try { doc.image(logoFile, L, 22, { width: 65 }); } catch {}
      let hasYellowcake = false;
      try { if (fs.existsSync(yellowcakePath)) { doc.registerFont('Yellowcake', yellowcakePath); hasYellowcake = true; } } catch {}
      if (hasYellowcake) doc.font('Yellowcake').fontSize(15).fillColor('#1a1a1a').text('Carolina Rolling Co. Inc.', 130, 32, { lineBreak: false });
      else doc.font('Helvetica-Bold').fontSize(15).fillColor('#1a1a1a').text('CAROLINA ROLLING CO. INC.', 130, 32, { lineBreak: false });
      doc.font('Helvetica').fontSize(8.5).fillColor('#777');
      doc.text('9152 Sonrisa St., Bellflower, CA 90706', 130, 52, { lineBreak: false });
      doc.text('Phone: (562) 633-1044  |  Email: keepitrolling@carolinarolling.com', 130, 63, { lineBreak: false });

      // ── Orange divider (matches receipt) ──
      doc.moveTo(L, 90).lineTo(L + W, 90).lineWidth(1).strokeColor('#e0e0e0').stroke();

      // ── Title row ──
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#e65100').text('PAYROLL SUMMARY', L, 100);
      doc.fontSize(9).font('Helvetica').fillColor('#555')
        .text('Payroll Period: ' + sd + ' — ' + ed, L, 116);
      const genDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: 'numeric' });
      const genTime = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT';
      doc.fontSize(8).fillColor('#888').text(genDate + '  ' + genTime, L + W - 100, 100, { width: 100, align: 'right', lineBreak: false });
      doc.moveTo(L, 130).lineTo(L + W, 130).lineWidth(0.5).strokeColor('#e0e0e0').stroke();

      // ── Table columns ──
      let y = 140;
      const cols = [
        { label: '#',           x: L,       w: 44  },
        { label: 'Name',        x: L+44,    w: 108 },
        { label: 'Deductions',  x: L+152,   w: 80  },
        { label: 'Description', x: L+232,   w: 80  },
        { label: 'Rate',        x: L+312,   w: 44, align: 'center' },
        { label: 'Hours',       x: L+356,   w: 38, align: 'center' },
        { label: 'OT',          x: L+394,   w: 34, align: 'center' },
        { label: 'Other',       x: L+428,   w: 56, align: 'center' },
        { label: 'Notes',       x: L+484,   w: 78, align: 'right'  },
      ];

      // Header row
      doc.rect(L, y, W, 16).fill('#1a1a1a');
      cols.forEach(c => {
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('white')
          .text(c.label, c.x + 2, y + 4, { width: c.w - 4, align: c.align || 'left', lineBreak: false });
      });
      y += 16;

      // Employee rows
      enriched.forEach((en, idx) => {
        const rowH = 18;
        if (y + rowH > 720) { doc.addPage(); y = 50; }
        if (idx % 2 === 1) doc.rect(L, y, W, rowH).fill('#f7f7f7');
        doc.rect(L, y, W, rowH).lineWidth(0.3).strokeColor('#cccccc').stroke();

        const otherParts = [];
        if (parseFloat(en.vacationHours) > 0) otherParts.push('Vac ' + en.vacationHours + 'h');
        if (parseFloat(en.bonus) > 0) otherParts.push('$' + parseFloat(en.bonus).toFixed(2));

        const notesParts = [];
        if (en.notes) notesParts.push(en.notes);

        const rowData = [
          { val: en.controlNumber || '', col: cols[0] },
          { val: en.employeeName,        col: cols[1], bold: true },
          { val: en.deductions || '',    col: cols[2] },
          { val: en.description || '',   col: cols[3] },
          { val: '$' + parseFloat(en.hourlyRate || 0).toFixed(2), col: cols[4] },
          { val: String(en.regularHours || 0), col: cols[5], bold: true },
          { val: String(en.overtimeHours || 0), col: cols[6], bold: true, color: parseFloat(en.overtimeHours) > 0 ? '#c62828' : '#888' },
          { val: otherParts.join(' '),    col: cols[7] },
          { val: notesParts.join(' '),    col: cols[8] },
        ];

        rowData.forEach(({ val, col, bold, color }) => {
          doc.fontSize(8).font(bold ? 'Helvetica-Bold' : 'Helvetica')
            .fillColor(color || '#1a1a1a')
            .text(val, col.x + 2, y + 5, { width: col.w - 4, align: col.align || 'left', lineBreak: false });
        });
        y += rowH;
      });

      // Totals row
      y += 8;
      doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#cccccc').stroke();
      y += 8;
      const totalReg = enriched.reduce((s, e) => s + (parseFloat(e.regularHours) || 0), 0);
      const totalOT = enriched.reduce((s, e) => s + (parseFloat(e.overtimeHours) || 0), 0);
      doc.fontSize(9).font('Helvetica').fillColor('#888')
        .text(enriched.length + ' employees  ·  ' + totalReg + ' reg hrs  ·  ' + totalOT + ' OT hrs', L, y);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a')
        .text('Total: $' + parseFloat(payroll.totalGross || 0).toFixed(2), L, y, { align: 'right', width: W });

      // Footer
      doc.fontSize(7).font('Helvetica').fillColor('#aaa')
        .text('Carolina Rolling Co. Inc.  |  (562) 633-1044  |  keepitrolling@carolinarolling.com', L, 748, { width: W, align: 'center', lineBreak: false });

      doc.end();
    });

        const filename = `Carolina_Rolling_Payroll_${payroll.weekStart}_to_${payroll.weekEnd}.pdf`;
    const attachmentBase64 = pdfBuffer.toString('base64');

    // Build RFC 2822 MIME message with attachment
    const boundary = 'payroll_boundary_' + Date.now();
    const emailSubject = subject || `Carolina Rolling Payroll ${sd} — ${ed}`;
    const emailBody = body || `Please find the attached payroll for the pay period ${sd} — ${ed}.

Total Gross: $${parseFloat(payroll.totalGross).toFixed(2)}

Please process at your earliest convenience.

Thank you,
CRAdmin
Carolina Rolling Co., Inc.`;

    const mime = [
      'From: ' + account.email,
      'To: ' + toEmail,
      'Subject: ' + emailSubject,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="' + boundary + '"',
      '',
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      emailBody,
      '',
      '--' + boundary,
      'Content-Type: application/pdf; name="' + filename + '"',
      'Content-Disposition: attachment; filename="' + filename + '"',
      'Content-Transfer-Encoding: base64',
      '',
      attachmentBase64,
      '',
      '--' + boundary + '--'
    ].join('\r\n');

    const raw = Buffer.from(mime).toString('base64url');

    // Send via Gmail API
    const { getGmailClient } = require('../services/emailScanner');
    const gmail = await getGmailClient(account);
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    res.json({ data: null, message: 'Payroll email sent successfully' });
  } catch (error) {
    console.error('[Payroll Email] Send failed:', error.message);
    next(error);
  }
});

module.exports = router;
