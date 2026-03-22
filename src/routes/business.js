const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { Liability, Employee, PayrollWeek, PayrollEntry, WorkOrder } = require('../models');

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
    await liability.destroy();
    res.json({ message: 'Deleted' });
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

    res.json({ data: { totalUnpaid, totalOverdue, totalDueThisWeek, overdueCount: overdue.length, dueThisWeekCount: dueThisWeek.length, byCategory } });
  } catch (error) { next(error); }
});

// ============= EMPLOYEES =============

// GET /api/business/employees
router.get('/employees', async (req, res, next) => {
  try {
    const { active } = req.query;
    const where = {};
    if (active !== 'all') where.isActive = true;
    const employees = await Employee.findAll({ where, order: [['name', 'ASC']] });
    res.json({ data: employees });
  } catch (error) { next(error); }
});

// POST /api/business/employees
router.post('/employees', async (req, res, next) => {
  try {
    const employee = await Employee.create(req.body);
    res.json({ data: employee, message: 'Employee added' });
  } catch (error) { next(error); }
});

// PUT /api/business/employees/:id
router.put('/employees/:id', async (req, res, next) => {
  try {
    const employee = await Employee.findByPk(req.params.id);
    if (!employee) return res.status(404).json({ error: { message: 'Not found' } });
    await employee.update(req.body);
    res.json({ data: employee, message: 'Updated' });
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
    const employees = await Employee.findAll({ where: { isActive: true } });
    for (const emp of employees) {
      await PayrollEntry.create({
        payrollWeekId: payroll.id,
        employeeId: emp.id,
        employeeName: emp.name,
        hourlyRate: emp.hourlyRate,
        regularHours: 0,
        overtimeHours: 0,
        vacationHours: 0,
        bonus: 0,
        overtimeDetails: [],
        grossPay: 0
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
    const payroll = await PayrollWeek.findByPk(req.params.id);
    if (!payroll) return res.status(404).json({ error: { message: 'Not found' } });
    await payroll.update({ status: 'submitted', submittedAt: new Date(), submittedBy: req.body.submittedBy || 'admin' });
    res.json({ data: payroll, message: 'Payroll submitted' });
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
    const { Vendor, PONumber, InboundOrder, WorkOrderPart, WorkOrder, sequelize } = require('../models');
    const { Op } = require('sequelize');
    const vendorId = req.params.vendorId;
    
    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Vendor not found' } });

    // PO Numbers for this vendor
    const poNumbers = await PONumber.findAll({
      where: { vendorId },
      order: [['poNumber', 'DESC']]
    });

    // Work order parts supplied by this vendor
    const woParts = await WorkOrderPart.findAll({
      where: { vendorId },
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
      where: { vendorId },
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

module.exports = router;
