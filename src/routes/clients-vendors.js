const express = require('express');
const router = express.Router();
const { Client, Vendor, WorkOrder, WorkOrderPart, Estimate, ClientPayment, PaymentApplication, CreditMemo, Refund, ShipmentCharge, sequelize } = require('../models');
const { Op } = require('sequelize');

// ============= CLIENTS =============

// GET /api/clients - Get all clients
router.get('/clients', async (req, res, next) => {
  try {
    const { search, active } = req.query;
    
    const where = {};
    if (active !== undefined) {
      where.isActive = active === 'true';
    }
    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
    }
    
    const clients = await Client.findAll({
      where,
      order: [['name', 'ASC']]
    });
    
    res.json({ data: clients });
  } catch (error) {
    next(error);
  }
});

// GET /api/clients/search - Search clients for autofill (Clients table only)
router.get('/clients/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    
    const whereClause = { isActive: true };
    if (q && q.length >= 1) {
      whereClause.name = { [Op.iLike]: `%${q}%` };
    }

    const clients = await Client.findAll({
      where: whereClause,
      limit: 20,
      order: [['name', 'ASC']]
    });

    res.json({ data: clients });
  } catch (error) {
    next(error);
  }
});

// GET /api/clients/check-notag?name=ClientName - Check if client has no-tag flag
router.get('/clients/check-notag', async (req, res, next) => {
  try {
    const { name } = req.query;
    if (!name) return res.json({ data: { noTag: false } });

    const client = await Client.findOne({
      where: { name: { [Op.iLike]: name.trim() }, isActive: true }
    });

    res.json({ data: { noTag: client?.noTag === true, requiresPartLabels: client?.requiresPartLabels === true } });
  } catch (error) {
    next(error);
  }
});

// GET /api/clients/:id - Get single client
router.get('/clients/:id', async (req, res, next) => {
  try {
    const client = await Client.findByPk(req.params.id);
    
    if (!client) {
      return res.status(404).json({ error: { message: 'Client not found' } });
    }
    
    res.json({ data: client });
  } catch (error) {
    next(error);
  }
});

// POST /api/clients - Create client
router.post('/clients', async (req, res, next) => {
  try {
    const {
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      taxStatus,
      resaleCertificate,
      customTaxRate,
      notes,
      noTag,
      paymentTerms, requiresPartLabels
    } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: { message: 'Client name is required' } });
    }
    
    // Check for duplicate (active)
    const existing = await Client.findOne({ where: { name: { [Op.iLike]: name.trim() } } });
    if (existing) {
      if (!existing.isActive) {
        // Reactivate the inactive client instead of blocking
        await existing.update({
          isActive: true,
          contactName: contactName || existing.contactName,
          contactPhone: contactPhone || existing.contactPhone,
          contactEmail: contactEmail || existing.contactEmail,
          address: address || existing.address,
          taxStatus: taxStatus || existing.taxStatus,
          resaleCertificate: resaleCertificate || existing.resaleCertificate,
          customTaxRate: (customTaxRate && customTaxRate !== '' && !isNaN(parseFloat(customTaxRate))) ? parseFloat(customTaxRate) : existing.customTaxRate,
          notes: notes || existing.notes,
          noTag: noTag !== undefined ? noTag : existing.noTag,
          requiresPartLabels: requiresPartLabels !== undefined ? requiresPartLabels : existing.requiresPartLabels,
          paymentTerms: paymentTerms || existing.paymentTerms
        });
        return res.status(201).json({ data: existing, message: `Client "${existing.name}" reactivated` });
      }
      return res.status(400).json({ error: { message: `A client named "${existing.name}" already exists` } });
    }
    
    const client = await Client.create({
      name: name.trim(),
      contactName: contactName || null,
      contactPhone: contactPhone || null,
      contactEmail: contactEmail || null,
      address: address || null,
      taxStatus: taxStatus || 'taxable',
      resaleCertificate: resaleCertificate || null,
      customTaxRate: (customTaxRate && customTaxRate !== '' && !isNaN(parseFloat(customTaxRate))) ? parseFloat(customTaxRate) : null,
      notes: notes || null,
      noTag: noTag || false,
      requiresPartLabels: requiresPartLabels || false,
      paymentTerms: paymentTerms || null,
      apEmail: req.body.apEmail || null,
      quickbooksName: req.body.quickbooksName || null,
      contacts: req.body.contacts || []
    });
    
    res.status(201).json({ data: client, message: 'Client created successfully' });
  } catch (error) {
    console.error('Client creation error:', error.message, error.errors?.map(e => e.message));
    next(error);
  }
});

// PUT /api/clients/:id - Update client
router.put('/clients/:id', async (req, res, next) => {
  try {
    const client = await Client.findByPk(req.params.id);
    
    if (!client) {
      return res.status(404).json({ error: { message: 'Client not found' } });
    }
    
    const {
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      taxStatus,
      resaleCertificate,
      customTaxRate,
      notes,
      isActive,
      noTag,
      paymentTerms,
      requiresPartLabels
    } = req.body;
    
    // Check for duplicate name (excluding current)
    if (name && name !== client.name) {
      const existing = await Client.findOne({ 
        where: { 
          name: { [Op.iLike]: name },
          id: { [Op.ne]: client.id }
        } 
      });
      if (existing) {
        return res.status(400).json({ error: { message: 'A client with this name already exists' } });
      }
    }
    
    const oldName = client.name;
    
    await client.update({
      name: name !== undefined ? name : client.name,
      contactName: contactName !== undefined ? contactName : client.contactName,
      contactPhone: contactPhone !== undefined ? contactPhone : client.contactPhone,
      contactEmail: contactEmail !== undefined ? contactEmail : client.contactEmail,
      address: address !== undefined ? address : client.address,
      taxStatus: taxStatus !== undefined ? taxStatus : client.taxStatus,
      resaleCertificate: resaleCertificate !== undefined ? resaleCertificate : client.resaleCertificate,
      customTaxRate: customTaxRate !== undefined ? ((customTaxRate && customTaxRate !== '' && !isNaN(parseFloat(customTaxRate))) ? parseFloat(customTaxRate) : null) : client.customTaxRate,
      notes: notes !== undefined ? (notes || null) : client.notes,
      isActive: isActive !== undefined ? isActive : client.isActive,
      noTag: noTag !== undefined ? noTag : client.noTag,
      requiresPartLabels: requiresPartLabels !== undefined ? requiresPartLabels : client.requiresPartLabels,
      requiresCoc: req.body.requiresCoc !== undefined ? !!req.body.requiresCoc : client.requiresCoc,
      paymentTerms: paymentTerms !== undefined ? (paymentTerms || null) : client.paymentTerms,
      contacts: req.body.contacts !== undefined ? req.body.contacts : client.contacts,
      quickbooksName: req.body.quickbooksName !== undefined ? (req.body.quickbooksName || null) : client.quickbooksName,
      emailScanEnabled: req.body.emailScanEnabled !== undefined ? req.body.emailScanEnabled : client.emailScanEnabled,
      emailScanAddresses: req.body.emailScanAddresses !== undefined ? req.body.emailScanAddresses : client.emailScanAddresses,
      emailScanParsingNotes: req.body.emailScanParsingNotes !== undefined ? (req.body.emailScanParsingNotes || null) : client.emailScanParsingNotes,
      accountingContactName: req.body.accountingContactName !== undefined ? (req.body.accountingContactName || null) : client.accountingContactName,
      accountingContactEmail: req.body.accountingContactEmail !== undefined ? (req.body.accountingContactEmail || null) : client.accountingContactEmail,
      accountingContactPhone: req.body.accountingContactPhone !== undefined ? (req.body.accountingContactPhone || null) : client.accountingContactPhone,
      apEmail: req.body.apEmail !== undefined ? (req.body.apEmail || null) : client.apEmail,
      autoGenerateUSMCA: req.body.autoGenerateUSMCA !== undefined ? !!req.body.autoGenerateUSMCA : client.autoGenerateUSMCA,
      usmcaFormat: req.body.usmcaFormat !== undefined ? (req.body.usmcaFormat || 'format1') : client.usmcaFormat,
      usmcaHtsCode: req.body.usmcaHtsCode !== undefined ? (req.body.usmcaHtsCode || null) : client.usmcaHtsCode,
      usmcaImporterName: req.body.usmcaImporterName !== undefined ? (req.body.usmcaImporterName || null) : client.usmcaImporterName,
      usmcaImporterAddress: req.body.usmcaImporterAddress !== undefined ? (req.body.usmcaImporterAddress || null) : client.usmcaImporterAddress,
      usmcaOriginCriteria: req.body.usmcaOriginCriteria !== undefined ? (req.body.usmcaOriginCriteria || 'A') : client.usmcaOriginCriteria
    });
    
    // Propagate name change to all work orders and estimates
    if (name && name !== oldName) {
      try {
        const [woCount] = await WorkOrder.update(
          { clientName: name },
          { where: { clientId: client.id } }
        );
        // Also update WOs matched by old name (in case clientId wasn't set)
        const [woNameCount] = await WorkOrder.update(
          { clientName: name },
          { where: { clientName: oldName, clientId: null } }
        );
        const [estCount] = await Estimate.update(
          { clientName: name },
          { where: { clientId: client.id } }
        );
        const [estNameCount] = await Estimate.update(
          { clientName: name },
          { where: { clientName: oldName, clientId: null } }
        );
        const total = woCount + woNameCount + estCount + estNameCount;
        console.log(`[Client] Name changed: "${oldName}" → "${name}" — updated ${woCount + woNameCount} WOs, ${estCount + estNameCount} estimates`);
      } catch (propErr) {
        console.error('[Client] Name propagation error:', propErr.message);
        // Don't fail the request — client was already updated
      }
    }
    
    res.json({ data: client, message: name && name !== oldName ? `Client updated — name changed across all work orders and estimates` : 'Client updated successfully' });
  } catch (error) {
    console.error('Client update error:', error.message, error.errors?.map(e => e.message));
    next(error);
  }
});

// POST /api/clients/:id/merge — Merge source client into this (target) client
// All records from sourceId are reassigned to targetId (this), source client is deleted
router.post('/clients/:id/merge', async (req, res, next) => {
  const { sourceId } = req.body;
  const targetId = req.params.id;
  if (!sourceId) return res.status(400).json({ error: { message: 'sourceId is required' } });
  if (sourceId === targetId) return res.status(400).json({ error: { message: 'Source and target cannot be the same client' } });

  const { sequelize } = require('../models');
  const t = await sequelize.transaction();
  try {
    const [target, source] = await Promise.all([
      Client.findByPk(targetId),
      Client.findByPk(sourceId)
    ]);
    if (!target) return res.status(404).json({ error: { message: 'Target client not found' } });
    if (!source) return res.status(404).json({ error: { message: 'Source client not found' } });

    const targetName = target.name;

    // Reassign all linked records
    const tables = [
      { table: 'work_orders', idCol: '"clientId"', nameCol: '"clientName"' },
      { table: 'estimates', idCol: '"clientId"', nameCol: '"clientName"' },
      { table: 'inbound_orders', idCol: '"clientId"', nameCol: '"clientName"' },
      { table: 'dr_numbers', idCol: '"clientId"', nameCol: null },
      { table: 'po_numbers', idCol: '"clientId"', nameCol: null },
      { table: 'invoice_numbers', idCol: '"clientId"', nameCol: null },
      { table: 'scanned_emails', idCol: '"clientId"', nameCol: null },
      { table: 'pending_orders', idCol: '"clientId"', nameCol: null },
    ];

    // Shipments only store clientName (no clientId FK) — update by matching source name
    try {
      await sequelize.query(
        `UPDATE shipments SET "clientName" = :targetName WHERE "clientName" = :sourceName`,
        { replacements: { targetName, sourceName: source.name }, transaction: t }
      );
    } catch (e) { /* skip */ }

    for (const { table, idCol, nameCol } of tables) {
      try {
        if (nameCol) {
          await sequelize.query(
            `UPDATE ${table} SET ${idCol} = :targetId, ${nameCol} = :targetName WHERE ${idCol} = :sourceId`,
            { replacements: { targetId, targetName, sourceId }, transaction: t }
          );
        } else {
          await sequelize.query(
            `UPDATE ${table} SET ${idCol} = :targetId WHERE ${idCol} = :sourceId`,
            { replacements: { targetId, sourceId }, transaction: t }
          );
        }
      } catch (e) { /* table may not exist — skip */ }
    }

    // Delete source client
    await source.destroy({ transaction: t });
    await t.commit();

    res.json({ data: target, message: `Merged "${source.name}" into "${targetName}" — all records transferred` });
  } catch (err) {
    await t.rollback();
    next(err);
  }
}); 

// DELETE /api/clients/:id - Delete client (soft delete - set inactive)
router.delete('/clients/:id', async (req, res, next) => {
  try {
    const client = await Client.findByPk(req.params.id);
    
    if (!client) {
      return res.status(404).json({ error: { message: 'Client not found' } });
    }
    
    await client.update({ isActive: false });
    
    res.json({ message: 'Client deactivated successfully' });
  } catch (error) {
    next(error);
  }
});

// ============= VENDORS =============

// GET /api/vendors - Get all vendors
router.get('/vendors', async (req, res, next) => {
  try {
    const { search, active } = req.query;
    
    const where = {};
    if (active !== undefined) {
      where.isActive = active === 'true';
    }
    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
    }
    
    const vendors = await Vendor.findAll({
      where,
      order: [['name', 'ASC']]
    });
    
    res.json({ data: vendors });
  } catch (error) {
    next(error);
  }
});

// GET /api/vendors/search - Search vendors for autofill
router.get('/vendors/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    
    const where = { isActive: true };
    if (q && q.length >= 1) {
      where.name = { [Op.iLike]: `%${q}%` };
    }
    
    const vendors = await Vendor.findAll({
      where,
      limit: 20,
      order: [['name', 'ASC']]
    });
    
    res.json({ data: vendors });
  } catch (error) {
    next(error);
  }
});

// GET /api/vendors/:id - Get single vendor
router.get('/vendors/:id', async (req, res, next) => {
  try {
    const vendor = await Vendor.findByPk(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({ error: { message: 'Vendor not found' } });
    }
    
    res.json({ data: vendor });
  } catch (error) {
    next(error);
  }
});

// POST /api/vendors - Create vendor
router.post('/vendors', async (req, res, next) => {
  try {
    const {
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      accountNumber,
      notes
    } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: { message: 'Vendor name is required' } });
    }
    
    // Check for duplicate
    const existing = await Vendor.findOne({ where: { name: { [Op.iLike]: name } } });
    if (existing) {
      return res.status(400).json({ error: { message: 'A vendor with this name already exists' } });
    }
    
    const vendor = await Vendor.create({
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      accountNumber,
      notes
    });
    
    res.status(201).json({ data: vendor, message: 'Vendor created successfully' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/vendors/:id - Update vendor
router.put('/vendors/:id', async (req, res, next) => {
  try {
    const vendor = await Vendor.findByPk(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({ error: { message: 'Vendor not found' } });
    }
    
    const {
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      accountNumber,
      notes,
      isActive
    } = req.body;
    
    // Check for duplicate name (excluding current)
    if (name && name !== vendor.name) {
      const existing = await Vendor.findOne({ 
        where: { 
          name: { [Op.iLike]: name },
          id: { [Op.ne]: vendor.id }
        } 
      });
      if (existing) {
        return res.status(400).json({ error: { message: 'A vendor with this name already exists' } });
      }
    }
    
    await vendor.update({
      name: name !== undefined ? name : vendor.name,
      contactName: contactName !== undefined ? contactName : vendor.contactName,
      contactPhone: contactPhone !== undefined ? contactPhone : vendor.contactPhone,
      contactEmail: contactEmail !== undefined ? contactEmail : vendor.contactEmail,
      address: address !== undefined ? address : vendor.address,
      accountNumber: accountNumber !== undefined ? accountNumber : vendor.accountNumber,
      notes: notes !== undefined ? notes : vendor.notes,
      isActive: isActive !== undefined ? isActive : vendor.isActive,
      contacts: req.body.contacts !== undefined ? req.body.contacts : vendor.contacts,
      accountingContactName: req.body.accountingContactName !== undefined ? (req.body.accountingContactName || null) : vendor.accountingContactName,
      accountingContactEmail: req.body.accountingContactEmail !== undefined ? (req.body.accountingContactEmail || null) : vendor.accountingContactEmail,
      accountingContactPhone: req.body.accountingContactPhone !== undefined ? (req.body.accountingContactPhone || null) : vendor.accountingContactPhone,
      emailScanEnabled: req.body.emailScanEnabled !== undefined ? req.body.emailScanEnabled : vendor.emailScanEnabled,
      emailScanAddresses: req.body.emailScanAddresses !== undefined ? req.body.emailScanAddresses : vendor.emailScanAddresses
    });
    
    res.json({ data: vendor, message: 'Vendor updated successfully' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/vendors/:id - Delete vendor (soft delete - set inactive)
router.delete('/vendors/:id', async (req, res, next) => {
  try {
    const vendor = await Vendor.findByPk(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({ error: { message: 'Vendor not found' } });
    }
    
    await vendor.update({ isActive: false });
    
    res.json({ message: 'Vendor deactivated successfully' });
  } catch (error) {
    next(error);
  }
});

// Helper: parse paymentTerms string into days (0 = COD/immediate)
function termsToDays(terms) {
  if (!terms) return null;
  const t = terms.toUpperCase();
  if (t === 'C.O.D.' || t === 'COD') return 0;
  const m = t.match(/NET\s*(\d+)/);
  if (m) return parseInt(m[1]);
  const m2 = t.match(/^(\d+)\s*DAYS?$/);
  if (m2) return parseInt(m2[1]);
  return null;
}

// GET /api/clients/:id/history — full client history: WOs, payments, credits, refunds
router.get('/clients/:id/history', async (req, res, next) => {
  try {
    const client = await Client.findByPk(req.params.id, { attributes: ['id','name','paymentTerms'] });
    if (!client) return res.status(404).json({ error: { message: 'Client not found' } });
    const termDays = termsToDays(client.paymentTerms);

    // Work orders
    const { Op } = require('sequelize');
    const wos = await WorkOrder.findAll({
      where: { clientId: req.params.id },
      attributes: ['id','drNumber','orderNumber','status','grandTotal','truckingCost','invoiceNumber','invoiceDate','shippedAt','createdAt','paymentDate','isVoided'],
      include: [{ model: WorkOrderPart, as: 'parts', attributes: ['partTotal'] }],
      order: [['drNumber','DESC NULLS LAST'],['createdAt','DESC']]
    });

    // Calculate balance per WO
    const woData = [];
    for (const wo of wos) {
      if (wo.isVoided) continue;
      const j = wo.toJSON();
      const partsTotal = (j.parts||[]).reduce((s,p) => s + (parseFloat(p.partTotal)||0), 0);
      const base = parseFloat(j.grandTotal) > 0 ? parseFloat(j.grandTotal) : partsTotal + (parseFloat(wo.truckingCost)||0);
      let shipping = 0;
      try {
        const charges = await ShipmentCharge.findAll({ where: { workOrderId: j.id } });
        charges.forEach(c => {
          shipping += (parseFloat(c.shippingCost)||0)*(1+(parseFloat(c.shippingMarkup)||0)/100)
                    + (parseFloat(c.materialsCost)||0)*(1+(parseFloat(c.materialsMarkup)||0)/100);
        });
      } catch(e) {}
      const total = base + shipping;

      // Payments applied
      let paid = 0;
      try {
        const apps = await PaymentApplication.findAll({ where: { workOrderId: j.id } });
        for (const app of apps) {
          const cp = await ClientPayment.findByPk(app.clientPaymentId, { attributes: ['voidedAt'] });
          if (cp && !cp.voidedAt) paid += parseFloat(app.amount)||0;
        }
        const legacyPmts = await (require('../models').WorkOrderPayment || sequelize.models.WorkOrderPayment).findAll({ where: { workOrderId: j.id, voidedAt: null } });
        paid += legacyPmts.reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
      } catch(e) {}

      const balance = Math.max(0, total - paid);

      // Due date
      let dueDate = null;
      let daysOverdue = null;
      if (j.invoiceDate && termDays !== null) {
        const inv = new Date(j.invoiceDate);
        dueDate = new Date(inv.getTime() + termDays * 86400000).toISOString().split('T')[0];
        if (balance > 0.01) {
          daysOverdue = Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000);
        }
      }

      woData.push({ ...j, total: total.toFixed(2), paid: paid.toFixed(2), balance: balance.toFixed(2), dueDate, daysOverdue });
    }

    // Client payments
    let payments = [];
    try {
      const pmts = await ClientPayment.findAll({
        where: { clientId: req.params.id, voidedAt: null },
        include: [{ model: PaymentApplication, as: 'applications' }],
        order: [['paymentDate','DESC']]
      });
      payments = pmts.map(p => p.toJSON());
    } catch(e) {}

    // Credit memos
    let creditMemos = [];
    try {
      const cms = await CreditMemo.findAll({ where: { clientId: req.params.id, voidedAt: null }, order: [['date','DESC']] });
      creditMemos = cms.map(c => c.toJSON());
    } catch(e) {}

    // Refunds
    let refunds = [];
    try {
      const refs = await Refund.findAll({ where: { clientId: req.params.id, voidedAt: null }, order: [['date','DESC']] });
      refunds = refs.map(r => r.toJSON());
    } catch(e) {}

    const openBalance = woData.filter(w => parseFloat(w.balance) > 0.01).reduce((s,w) => s + parseFloat(w.balance), 0);

    res.json({ data: { workOrders: woData, payments, creditMemos, refunds, openBalance: openBalance.toFixed(2), termDays, client: client.toJSON() } });
  } catch(error) { next(error); }
});

// GET /api/clients/:id/statement-pdf — generate account statement PDF
router.get('/clients/:id/statement-pdf', async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const client = await Client.findByPk(req.params.id);
    if (!client) return res.status(404).json({ error: { message: 'Client not found' } });

    // Reuse history endpoint logic inline
    const histRes = await new Promise((resolve, reject) => {
      const fakeReq = { params: { id: req.params.id } };
      const fakeRes = { json: (data) => resolve(data), status: () => ({ json: reject }) };
      router.handle ? router.handle(fakeReq, fakeRes, reject) : reject(new Error('not supported'));
    }).catch(() => null);

    // Fallback: just get WOs directly
    const { Op } = require('sequelize');
    const wos = await WorkOrder.findAll({
      where: { clientId: req.params.id, invoiceNumber: { [Op.ne]: null }, isVoided: { [Op.ne]: true } },
      attributes: ['id','drNumber','orderNumber','invoiceNumber','invoiceDate','grandTotal','truckingCost','shippedAt','paymentDate'],
      include: [{ model: WorkOrderPart, as: 'parts', attributes: ['partTotal'] }],
      order: [['drNumber','DESC NULLS LAST']]
    });

    const termDays = termsToDays(client.paymentTerms);
    const now = new Date();

    const doc = new PDFDocument({ margin: 50, size: 'letter' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    await new Promise(resolve => doc.on('end', resolve));

    // Header
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#1565c0').text('ACCOUNT STATEMENT', 350, 50, { width: 200, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(`Generated: ${now.toLocaleDateString()}`, 350, 78, { width: 200, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#333').text('Carolina Rolling Co. Inc.', 50, 50);
    doc.text('9152 Sonrisa St., Bellflower, CA 90706', 50, 63);
    doc.text('(562) 633-1044 | keepitrolling@carolinarolling.com', 50, 76);

    doc.moveTo(50, 100).lineTo(562, 100).lineWidth(2).strokeColor('#1565c0').stroke();

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#333').text('BILL TO:', 50, 115);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1565c0').text(client.name, 50, 130);
    if (client.address) doc.font('Helvetica').fontSize(10).fillColor('#555').text(client.address, 50, 146);
    if (client.paymentTerms) {
      doc.font('Helvetica').fontSize(10).fillColor('#333').text(`Payment Terms: ${client.paymentTerms}`, 350, 130, { width: 200, align: 'right' });
    }

    doc.moveTo(50, 175).lineTo(562, 175).lineWidth(0.5).strokeColor('#ccc').stroke();

    // Column headers
    let y = 190;
    const cols = { dr: 50, inv: 115, date: 195, due: 275, total: 360, paid: 430, balance: 500 };
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#888');
    doc.text('WORK ORDER', cols.dr, y);
    doc.text('INVOICE', cols.inv, y);
    doc.text('INV DATE', cols.date, y);
    doc.text('DUE DATE', cols.due, y);
    doc.text('TOTAL', cols.total, y, { width: 60, align: 'right' });
    doc.text('PAID', cols.paid, y, { width: 60, align: 'right' });
    doc.text('BALANCE', cols.balance, y, { width: 62, align: 'right' });

    y += 14;
    doc.moveTo(50, y).lineTo(562, y).lineWidth(1).strokeColor('#1565c0').stroke();
    y += 10;

    let grandBalance = 0;
    for (const wo of wos) {
      const j = wo.toJSON();
      const partsTotal = (j.parts||[]).reduce((s,p) => s+(parseFloat(p.partTotal)||0),0);
      const total = parseFloat(j.grandTotal)>0 ? parseFloat(j.grandTotal) : partsTotal + (parseFloat(wo.truckingCost)||0);
      const paid = j.paymentDate ? total : 0;
      const balance = Math.max(0, total - paid);
      grandBalance += balance;

      let dueDate = '';
      let isOverdue = false;
      if (j.invoiceDate && termDays !== null) {
        const dd = new Date(new Date(j.invoiceDate).getTime() + termDays * 86400000);
        dueDate = dd.toLocaleDateString();
        if (balance > 0.01 && dd < now) isOverdue = true;
      } else if (termDays === 0) {
        dueDate = 'Upon Receipt';
      }

      if (y > 700) { doc.addPage(); y = 50; }

      const rowColor = isOverdue ? '#c62828' : balance <= 0.01 ? '#2e7d32' : '#333';
      doc.font('Helvetica').fontSize(9.5).fillColor(rowColor);
      doc.text(j.drNumber ? `DR-${j.drNumber}` : j.orderNumber, cols.dr, y);
      doc.text(j.invoiceNumber || '—', cols.inv, y);
      doc.text(j.invoiceDate ? new Date(j.invoiceDate).toLocaleDateString() : '—', cols.date, y);
      doc.text(dueDate || '—', cols.due, y);
      doc.text('$' + total.toFixed(2), cols.total, y, { width: 60, align: 'right' });
      doc.text('$' + paid.toFixed(2), cols.paid, y, { width: 60, align: 'right' });
      if (isOverdue) {
        doc.font('Helvetica-Bold');
      }
      doc.text('$' + balance.toFixed(2), cols.balance, y, { width: 62, align: 'right' });
      doc.font('Helvetica');
      y += 18;
      doc.moveTo(50, y - 4).lineTo(562, y - 4).lineWidth(0.3).strokeColor('#eee').stroke();
    }

    // Total row
    y += 6;
    doc.moveTo(50, y).lineTo(562, y).lineWidth(1.5).strokeColor('#1565c0').stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1565c0');
    doc.text('TOTAL OUTSTANDING', cols.dr, y);
    doc.text('$' + grandBalance.toFixed(2), cols.balance, y, { width: 62, align: 'right' });

    doc.end();
    const buffer = Buffer.concat(chunks);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Statement-${client.name.replace(/[^a-zA-Z0-9]/g,'_')}-${now.toISOString().split('T')[0]}.pdf"`);
    res.send(buffer);
  } catch(error) { next(error); }
});

module.exports = router;
