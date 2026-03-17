const express = require('express');
const { WorkOrder, WorkOrderPart, Client, InvoiceNumber, AppSettings } = require('../models');

const router = express.Router();

const QB_CONFIG = {
  arAccount: 'ACCOUNTS RECEIVABLE',
  taxableIncomeAccount: 'SALES - TAXABLE',
  nontaxableIncomeAccount: 'SALES-NONTAXABLE',
  freightAccount: 'FREIGHT',
  taxAccount: 'SALES TAX PAYABLE'
};

// Map our payment terms to exact QB terms
const TERMS_MAP = {
  'COD': 'C.O.D.',
  'C.O.D.': 'C.O.D.',
  '1/2% 10 Net 30': '1/2% 10 NET 30',
  '1/2% 10 NET 30': '1/2% 10 NET 30',
  '1% 10 Net 30': '1% 10 NET 30',
  '1% 10 DAYS NET 30': '1% 10 DAYS NET 30',
  '2% 10 DAYS NET 30': '2% 10 DAYS NET 30',
  '10 DAYS': '10 DAYS',
  '15 DAYS': '15 DAYS',
  'Net 60': 'NET 60 DAYS',
  'NET 60': 'NET 60 DAYS',
  'NET 60 DAYS': 'NET 60 DAYS'
};

function formatQBDate(dateStr) {
  if (!dateStr) return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
  const d = new Date(dateStr);
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear()}`;
}

function clean(s) {
  return (s || '')
    .replace(/[\t\r\n]/g, ' ')
    .replace(/(\d)"(\s|$|x|X|\))/g, '$1in.$2')
    .replace(/"/g, "'")
    .trim();
}

function mapTerms(terms) {
  if (!terms) return 'C.O.D.';
  return TERMS_MAP[terms] || TERMS_MAP[terms.toUpperCase()] || terms.toUpperCase();
}

// Get part amount — use stored partTotal first, fall back to calculation
function getPartAmount(part) {
  const stored = parseFloat(part.partTotal);
  if (stored && stored > 0) return stored;
  const matCost = parseFloat(part.materialTotal) || 0;
  const matMarkup = parseFloat(part.materialMarkupPercent) || 0;
  const matEach = matCost * (1 + matMarkup / 100);
  const labEach = parseFloat(part.laborTotal) || 0;
  const qty = parseInt(part.quantity) || 1;
  return Math.round((matEach + labEach) * qty * 100) / 100;
}

// Look up client by ID association or name fallback
async function resolveClient(wo) {
  if (wo.client) return wo.client;
  if (wo.clientName) {
    const { Op } = require('sequelize');
    return await Client.findOne({ 
      where: { name: { [Op.iLike]: wo.clientName } },
      attributes: ['id', 'name', 'taxStatus', 'paymentTerms', 'quickbooksName']
    });
  }
  return null;
}

function buildInvoiceIIF(wo, parts, client, invoiceNum) {
  const lines = [];
  const SERVICE_TYPES = ['fab_service', 'shop_rate', 'rush_service'];
  
  const drLabel = wo.drNumber ? `DR-${wo.drNumber}` : (wo.orderNumber || '');
  const clientName = clean(client?.quickbooksName || client?.name || wo.clientName || 'Unknown');
  const invoiceDate = formatQBDate(wo.shippedAt || wo.completedAt || wo.createdAt);
  const docNum = invoiceNum || wo.invoiceNumber || drLabel;
  const terms = mapTerms(client?.paymentTerms);
  const clientPO = clean(wo.clientPurchaseOrderNumber || '');
  
  console.log(`[IIF] Building: doc=${docNum}, client="${clientName}", qbName="${client?.quickbooksName || '(none)'}", terms="${terms}", DR="${drLabel}", PO="${clientPO}"`);
  
  // Tax status from client
  const clientTaxStatus = (client?.taxStatus || '').toLowerCase();
  const isResale = clientTaxStatus === 'resale' || clientTaxStatus === 'exempt' 
    || wo.taxExempt === true || wo.taxExempt === 'true';
  
  // Sort by part number
  const sorted = [...parts].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
  const regularParts = sorted.filter(p => !SERVICE_TYPES.includes(p.partType));
  const serviceParts = sorted.filter(p => SERVICE_TYPES.includes(p.partType));
  
  // Link services to parent parts
  const servicesByParent = new Map();
  const unlinkedServices = [];
  
  for (const svc of serviceParts) {
    const fd = svc.formData && typeof svc.formData === 'object' ? svc.formData : {};
    let parentId = null;
    if (fd._linkedPartId) {
      const parent = regularParts.find(p => String(p.id) === String(fd._linkedPartId));
      if (parent) parentId = parent.id;
    }
    if (!parentId) {
      const before = regularParts.filter(p => (p.partNumber || 0) < (svc.partNumber || 0))
        .sort((a, b) => (b.partNumber || 0) - (a.partNumber || 0));
      if (before.length > 0) parentId = before[0].id;
    }
    if (parentId) {
      if (!servicesByParent.has(parentId)) servicesByParent.set(parentId, []);
      servicesByParent.get(parentId).push(svc);
    } else {
      unlinkedServices.push(svc);
    }
  }
  
  // Build line items — one per regular part with services rolled in
  const lineItems = [];
  let subtotal = 0;
  
  for (const part of regularParts) {
    const partCost = getPartAmount(part);
    const linked = servicesByParent.get(part.id) || [];
    
    let svcTotal = 0;
    const svcDetails = [];
    for (const svc of linked) {
      const cost = getPartAmount(svc);
      svcTotal += cost;
      const fd = svc.formData && typeof svc.formData === 'object' ? svc.formData : {};
      let label = fd._fabServiceType || fd._serviceType || fd.serviceType || svc.partType;
      if (label === 'fab_service') label = 'Fabrication';
      if (label === 'shop_rate') label = 'Shop Rate';
      if (label === 'rush_service') label = 'Rush';
      svcDetails.push({ label, cost });
    }
    
    const combinedTotal = Math.round((partCost + svcTotal) * 100) / 100;
    
    // Build description
    const fd = part.formData && typeof part.formData === 'object' ? part.formData : {};
    const matDesc = clean(fd._materialDescription || part.materialDescription || '');
    const rollDesc = fd._rollingDescription || '';
    const firstRoll = rollDesc ? clean(rollDesc.split(/\n|\\n/)[0]) : '';
    
    let desc = `Part #${part.partNumber}: ${matDesc}`;
    if (firstRoll) desc += ` - ${firstRoll}`;
    if (svcDetails.length > 0) {
      desc += ` - Rolling: $${partCost.toFixed(2)}`;
      for (const s of svcDetails) desc += ` - ${s.label}: $${s.cost.toFixed(2)}`;
    }
    desc = clean(desc).substring(0, 200);
    
    lineItems.push({
      description: desc,
      amount: combinedTotal,
      qty: parseInt(part.quantity) || 1
    });
    subtotal += combinedTotal;
  }
  
  // Unlinked services
  for (const svc of unlinkedServices) {
    const cost = getPartAmount(svc);
    if (cost <= 0) continue;
    const fd = svc.formData && typeof svc.formData === 'object' ? svc.formData : {};
    let label = fd._fabServiceType || fd._serviceType || svc.partType;
    let desc = `Service #${svc.partNumber}: ${label}`;
    if (svc.specialInstructions) desc += ` - ${clean(svc.specialInstructions).substring(0, 60)}`;
    lineItems.push({ description: clean(desc).substring(0, 200), amount: cost, qty: 1 });
    subtotal += cost;
  }
  
  // Trucking
  const trucking = parseFloat(wo.truckingCost) || 0;
  if (trucking > 0) {
    lineItems.push({
      description: clean(wo.truckingDescription || 'Trucking / Delivery'),
      amount: trucking,
      qty: 1,
      isFreight: true
    });
    subtotal += trucking;
  }
  
  if (lineItems.length === 0) return null;
  
  // Tax calculation
  const taxRate = isResale ? 0 : (parseFloat(wo.taxRate) || 0);
  const taxableAmount = isResale ? 0 : lineItems.filter(i => !i.isFreight).reduce((s, i) => s + i.amount, 0);
  const taxAmount = Math.round(taxableAmount * taxRate / 100 * 100) / 100;
  const grandTotal = Math.round((subtotal + taxAmount) * 100) / 100;
  
  // Build memo with DR# and PO#
  const memoParts = [drLabel, clientName];
  if (clientPO) memoParts.push(`PO#${clientPO}`);
  const memo = clean(memoParts.join(' - ')).substring(0, 200);
  
  // TRNS: debit AR
  lines.push([
    'TRNS', '', 'INVOICE', invoiceDate, QB_CONFIG.arAccount, clientName,
    grandTotal.toFixed(2), docNum, memo, 'N', 'Y', terms
  ].join('\t'));
  
  // SPL: one line per part — includes QNTY, PRICE, INVITEM, TAXABLE
  for (const item of lineItems) {
    const account = item.isFreight ? QB_CONFIG.freightAccount
      : isResale ? QB_CONFIG.nontaxableIncomeAccount
      : QB_CONFIG.taxableIncomeAccount;
    const taxable = (item.isFreight || isResale) ? 'N' : 'Y';
    lines.push([
      'SPL', '', 'INVOICE', invoiceDate, account, clientName,
      (-item.amount).toFixed(2), docNum, item.description, 'N',
      '', '', '', taxable
    ].join('\t'));
  }
  
  // SPL: tax line
  if (taxAmount > 0) {
    lines.push([
      'SPL', '', 'INVOICE', invoiceDate, QB_CONFIG.taxAccount, clientName,
      (-taxAmount).toFixed(2), docNum, 'Sales Tax', 'N',
      '', '', '', 'N'
    ].join('\t'));
  }
  
  lines.push('ENDTRNS');
  
  return {
    lines,
    summary: {
      drNumber: drLabel,
      invoiceNumber: docNum,
      clientName,
      lineItems: lineItems.length,
      subtotal: Math.round(subtotal * 100) / 100,
      taxableAmount: Math.round(taxableAmount * 100) / 100,
      taxRate,
      isResale,
      tax: taxAmount,
      total: grandTotal,
      terms,
      clientPO
    }
  };
}

const IIF_HEADER = [
  '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tTOPRINT\tTERMS',
  '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tQNTY\tPRICE\tINVITEM\tTAXABLE',
  '!ENDTRNS'
];

// ==================== INVOICE NUMBERS ====================

// GET /api/quickbooks/next-invoice-number
router.get('/next-invoice-number', async (req, res, next) => {
  try {
    const setting = await AppSettings.findOne({ where: { key: 'next_invoice_number' } });
    let nextNum = setting?.value || 1001;
    
    // Also check highest used
    const highest = await InvoiceNumber.findOne({ order: [['invoiceNumber', 'DESC']] });
    if (highest && highest.invoiceNumber >= nextNum) {
      nextNum = highest.invoiceNumber + 1;
    }
    
    res.json({ data: { nextNumber: nextNum } });
  } catch (error) { next(error); }
});

// PUT /api/quickbooks/next-invoice-number — Set next invoice number (admin)
router.put('/next-invoice-number', async (req, res, next) => {
  try {
    const { nextNumber } = req.body;
    if (!nextNumber || isNaN(parseInt(nextNumber))) {
      return res.status(400).json({ error: { message: 'Valid number required' } });
    }
    await AppSettings.upsert({ key: 'next_invoice_number', value: parseInt(nextNumber) });
    res.json({ data: { nextNumber: parseInt(nextNumber) }, message: 'Next invoice number updated' });
  } catch (error) { next(error); }
});

// POST /api/quickbooks/assign-invoice-number/:id — Assign invoice number to WO
router.post('/assign-invoice-number/:id', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id);
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    // Check if already has invoice number
    if (wo.invoiceNumber) {
      return res.json({ data: { invoiceNumber: wo.invoiceNumber }, message: 'Invoice number already assigned' });
    }
    
    const { sequelize } = require('../models');
    const result = await sequelize.transaction(async (transaction) => {
      const setting = await AppSettings.findOne({ where: { key: 'next_invoice_number' }, transaction });
      let nextNum = setting?.value || 1001;
      
      const highest = await InvoiceNumber.findOne({ order: [['invoiceNumber', 'DESC']], transaction });
      if (highest && highest.invoiceNumber >= nextNum) nextNum = highest.invoiceNumber + 1;
      
      // Create invoice number record
      await InvoiceNumber.create({
        invoiceNumber: nextNum,
        workOrderId: wo.id,
        clientId: wo.clientId,
        clientName: wo.clientName
      }, { transaction });
      
      // Update WO
      await wo.update({ invoiceNumber: String(nextNum) }, { transaction });
      
      // Increment next number
      await AppSettings.upsert({ key: 'next_invoice_number', value: nextNum + 1 }, { transaction });
      
      return nextNum;
    });
    
    res.json({ data: { invoiceNumber: String(result) }, message: `Invoice #${result} assigned` });
  } catch (error) { next(error); }
});

// ==================== IIF EXPORT ====================

// GET /api/quickbooks/export/:id
router.get('/export/:id', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id, {
      include: [
        { model: WorkOrderPart, as: 'parts' },
        { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms', 'quickbooksName'] }
      ]
    });
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    const client = await resolveClient(wo);
    const result = buildInvoiceIIF(wo, wo.parts || [], client, wo.invoiceNumber);
    if (!result) return res.status(400).json({ error: { message: 'No billable items found' } });
    
    const iifContent = [...IIF_HEADER, ...result.lines].join('\r\n') + '\r\n';
    const filename = `invoice-${result.summary.invoiceNumber || result.summary.drNumber}-${(wo.clientName || '').replace(/[^a-zA-Z0-9]/g, '_')}.iif`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(iifContent);
  } catch (error) {
    console.error('[quickbooks] Export error:', error.message);
    next(error);
  }
});

// POST /api/quickbooks/export-batch
router.post('/export-batch', async (req, res, next) => {
  try {
    const { workOrderIds } = req.body;
    if (!workOrderIds || !workOrderIds.length) {
      return res.status(400).json({ error: { message: 'No work order IDs provided' } });
    }
    const { Op } = require('sequelize');
    const workOrders = await WorkOrder.findAll({
      where: { id: { [Op.in]: workOrderIds } },
      include: [
        { model: WorkOrderPart, as: 'parts' },
        { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms', 'quickbooksName'] }
      ],
      order: [['drNumber', 'ASC']]
    });
    
    const allLines = [];
    const summaries = [];
    for (const wo of workOrders) {
      const client = await resolveClient(wo);
      const result = buildInvoiceIIF(wo, wo.parts || [], client, wo.invoiceNumber);
      if (result) { allLines.push(...result.lines); summaries.push(result.summary); }
    }
    if (allLines.length === 0) return res.status(400).json({ error: { message: 'No billable items found' } });
    
    const iifContent = [...IIF_HEADER, ...allLines].join('\r\n') + '\r\n';
    const filename = `quickbooks-invoices-${new Date().toISOString().split('T')[0]}.iif`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(iifContent);
  } catch (error) {
    console.error('[quickbooks] Batch export error:', error.message);
    next(error);
  }
});

// GET /api/quickbooks/preview/:id
router.get('/preview/:id', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id, {
      include: [
        { model: WorkOrderPart, as: 'parts' },
        { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms', 'quickbooksName'] }
      ]
    });
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    const client = await resolveClient(wo);
    const result = buildInvoiceIIF(wo, wo.parts || [], client, wo.invoiceNumber);
    if (!result) return res.json({ data: null, message: 'No billable items found' });
    
    res.json({ data: { summary: result.summary, config: QB_CONFIG, rawIIF: result.lines.join('\n') } });
  } catch (error) { next(error); }
});

// POST /api/quickbooks/export-customers
router.post('/export-customers', async (req, res, next) => {
  try {
    const clients = await Client.findAll({ where: { isActive: true } });
    const header = '!CUST\tNAME\tCONT1\tPHONE1\tEMAIL\tTERMS';
    const lines = [header];
    for (const c of clients) {
      const name = clean(c.quickbooksName || c.name);
      lines.push(`CUST\t${name}\t${clean(c.contactName)}\t${clean(c.contactPhone)}\t${clean(c.contactEmail)}\t${mapTerms(c.paymentTerms)}`);
    }
    const iifContent = lines.join('\r\n') + '\r\n';
    const filename = `quickbooks-customers-${new Date().toISOString().split('T')[0]}.iif`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(iifContent);
  } catch (error) { next(error); }
});

// ==================== INVOICE NUMBER MANAGEMENT ====================

// GET /api/quickbooks/invoice-numbers - List all invoice numbers
router.get('/invoice-numbers', async (req, res, next) => {
  try {
    const invoiceNumbers = await InvoiceNumber.findAll({
      order: [['invoiceNumber', 'DESC']],
      include: [{ model: WorkOrder, as: 'workOrder', attributes: ['id', 'drNumber', 'orderNumber', 'status'] }]
    });
    res.json({ data: invoiceNumbers });
  } catch (error) { next(error); }
});

// POST /api/quickbooks/invoice-numbers/:id/void - Void an invoice number
router.post('/invoice-numbers/:id/void', async (req, res, next) => {
  try {
    const inv = await InvoiceNumber.findByPk(req.params.id);
    if (!inv) return res.status(404).json({ error: { message: 'Invoice number not found' } });
    
    await inv.update({
      status: 'void',
      voidedAt: new Date(),
      voidedBy: req.user?.username || 'Unknown',
      voidReason: req.body.reason || null
    });
    
    // Clear invoice number from linked work order
    if (inv.workOrderId) {
      const wo = await WorkOrder.findByPk(inv.workOrderId);
      if (wo && wo.invoiceNumber === String(inv.invoiceNumber)) {
        await wo.update({ invoiceNumber: null, invoiceDate: null, invoicedBy: null });
      }
    }
    
    res.json({ data: inv, message: `Invoice #${inv.invoiceNumber} voided` });
  } catch (error) { next(error); }
});

module.exports = router;
