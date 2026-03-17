const express = require('express');
const { WorkOrder, WorkOrderPart, Client } = require('../models');

const router = express.Router();

const QB_CONFIG = {
  arAccount: 'ACCOUNTS RECEIVABLE',
  taxableIncomeAccount: 'SALES - TAXABLE',
  nontaxableIncomeAccount: 'SALES-NONTAXABLE',
  freightAccount: 'FREIGHT',
  taxAccount: 'SALES TAX PAYABLE',
  defaultTerms: 'COD'
};

function formatQBDate(dateStr) {
  if (!dateStr) return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
  const d = new Date(dateStr);
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear()}`;
}

function clean(s) {
  return (s || '')
    .replace(/[\t\r\n]/g, ' ')
    .replace(/(\d)"(\s|$|x|X|\))/g, '$1in.$2')  // 2" → 2in., 1/2" → 1/2in.
    .replace(/"/g, "'")  // any remaining quotes → single quotes
    .trim();
}

// Calculate part total from stored pricing fields (matches frontend logic)
function calcPartTotal(part) {
  const matCost = parseFloat(part.materialTotal) || 0;
  const matMarkup = parseFloat(part.materialMarkupPercent) || 0;
  const matEach = matCost * (1 + matMarkup / 100);
  const labEach = parseFloat(part.laborTotal) || 0;
  const unitPrice = matEach + labEach;
  const qty = parseInt(part.quantity) || 1;
  return Math.round(unitPrice * qty * 100) / 100;
}

function buildInvoiceIIF(wo, parts, client) {
  const lines = [];
  const SERVICE_TYPES = ['fab_service', 'shop_rate', 'rush_service'];
  
  const drLabel = wo.drNumber ? `DR-${wo.drNumber}` : (wo.orderNumber || 'UNKNOWN');
  // Use QuickBooks reference name if set, otherwise fall back to client name
  const clientName = clean(client?.quickbooksName || wo.clientName || 'Unknown');
  const invoiceDate = formatQBDate(wo.shippedAt || wo.completedAt || wo.createdAt);
  const terms = (client?.paymentTerms || QB_CONFIG.defaultTerms || 'COD').replace(/[\t\r\n"]/g, ' ').trim();
  
  // Tax exempt check: WO taxExempt flag OR client taxStatus is 'resale' or 'exempt'
  const clientTaxStatus = (client?.taxStatus || '').toLowerCase();
  const taxExempt = wo.taxExempt === true || wo.taxExempt === 'true' 
    || clientTaxStatus === 'resale' || clientTaxStatus === 'exempt';
  
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
    
    // Try _linkedPartId
    if (fd._linkedPartId) {
      const parent = regularParts.find(p => String(p.id) === String(fd._linkedPartId));
      if (parent) parentId = parent.id;
    }
    
    // Fallback: closest regular part before this service
    if (!parentId) {
      const before = regularParts
        .filter(p => (p.partNumber || 0) < (svc.partNumber || 0))
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
    const partCost = calcPartTotal(part);
    const linked = servicesByParent.get(part.id) || [];
    
    // Calculate service costs
    const svcDetails = [];
    let svcTotal = 0;
    for (const svc of linked) {
      const cost = calcPartTotal(svc);
      svcTotal += cost;
      const fd = svc.formData && typeof svc.formData === 'object' ? svc.formData : {};
      let label = fd._fabServiceType || fd._serviceType || fd.serviceType || svc.partType;
      if (label === 'fab_service') label = 'Fabrication';
      if (label === 'shop_rate') label = 'Shop Rate';
      if (label === 'rush_service') label = 'Rush';
      if (svc.specialInstructions) label += ` (${clean(svc.specialInstructions).substring(0, 50)})`;
      svcDetails.push({ label, cost });
    }
    
    const combinedTotal = Math.round((partCost + svcTotal) * 100) / 100;
    if (combinedTotal <= 0) continue;
    
    // Build description
    const fd = part.formData && typeof part.formData === 'object' ? part.formData : {};
    const matDesc = clean(fd._materialDescription || part.materialDescription || '');
    const rollDesc = fd._rollingDescription || '';
    const firstRoll = rollDesc ? clean(rollDesc.split(/\n|\\n/)[0]) : '';
    
    let desc = `Part #${part.partNumber}: ${matDesc}`;
    if (firstRoll) desc += ` | ${firstRoll}`;
    
    // Add cost breakdown in description
    const breakdownLines = [];
    breakdownLines.push(`Rolling/Labor: $${partCost.toFixed(2)}`);
    for (const s of svcDetails) {
      breakdownLines.push(`${s.label}: $${s.cost.toFixed(2)}`);
    }
    if (svcDetails.length > 0) {
      desc += ` | ${breakdownLines.join(' | ')}`;
    }
    
    desc = clean(desc).substring(0, 250);
    
    lineItems.push({
      description: desc,
      amount: combinedTotal,
      taxable: taxExempt ? 'N' : 'Y'
    });
    subtotal += combinedTotal;
  }
  
  // Unlinked services as separate lines
  for (const svc of unlinkedServices) {
    const cost = calcPartTotal(svc);
    if (cost <= 0) continue;
    const fd = svc.formData && typeof svc.formData === 'object' ? svc.formData : {};
    let label = fd._fabServiceType || fd._serviceType || svc.partType;
    let desc = `Service #${svc.partNumber}: ${label}`;
    if (svc.specialInstructions) desc += ` - ${clean(svc.specialInstructions)}`;
    
    lineItems.push({
      description: clean(desc).substring(0, 250),
      amount: cost,
      taxable: taxExempt ? 'N' : 'Y'
    });
    subtotal += cost;
  }
  
  // Trucking
  const trucking = parseFloat(wo.truckingCost) || 0;
  if (trucking > 0) {
    lineItems.push({
      description: clean(wo.truckingDescription || 'Trucking / Delivery'),
      amount: trucking,
      taxable: 'N',
      isFreight: true
    });
    subtotal += trucking;
  }
  
  if (lineItems.length === 0) return null;
  
  // Tax calculation
  const taxRate = taxExempt ? 0 : (parseFloat(wo.taxRate) || 0);
  const taxableAmount = lineItems.filter(i => i.taxable === 'Y').reduce((s, i) => s + i.amount, 0);
  const taxAmount = Math.round(taxableAmount * taxRate / 100 * 100) / 100;
  const grandTotal = Math.round((subtotal + taxAmount) * 100) / 100;
  
  const memo = clean(`${drLabel} - ${clientName}`);
  
  // TRNS: debit AR
  lines.push([
    'TRNS', '', 'INVOICE', invoiceDate, QB_CONFIG.arAccount, clientName,
    grandTotal.toFixed(2), drLabel, memo, 'N', 'Y'
  ].join('\t'));
  
  // SPL: credit income per line item — route to correct account
  for (const item of lineItems) {
    const account = item.isFreight ? QB_CONFIG.freightAccount
      : item.taxable === 'Y' ? QB_CONFIG.taxableIncomeAccount
      : QB_CONFIG.nontaxableIncomeAccount;
    lines.push([
      'SPL', '', 'INVOICE', invoiceDate, account, clientName,
      (-item.amount).toFixed(2), drLabel, item.description, 'N'
    ].join('\t'));
  }
  
  // SPL: credit tax payable
  if (taxAmount > 0) {
    lines.push([
      'SPL', '', 'INVOICE', invoiceDate, QB_CONFIG.taxAccount, clientName,
      (-taxAmount).toFixed(2), drLabel, 'Sales Tax', 'N'
    ].join('\t'));
  }
  
  lines.push('ENDTRNS');
  
  return {
    lines,
    summary: {
      drNumber: drLabel,
      clientName,
      lineItems: lineItems.length,
      subtotal: Math.round(subtotal * 100) / 100,
      taxableAmount: Math.round(taxableAmount * 100) / 100,
      taxRate,
      taxExempt,
      tax: taxAmount,
      total: grandTotal
    }
  };
}

const IIF_HEADER = [
  '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tTOPRINT',
  '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR',
  '!ENDTRNS'
];

// GET /api/quickbooks/export/:id
router.get('/export/:id', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id, {
      include: [
        { model: WorkOrderPart, as: 'parts' },
        { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms'] }
      ]
    });
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    const result = buildInvoiceIIF(wo, wo.parts || [], wo.client);
    if (!result) return res.status(400).json({ error: { message: 'No billable items found' } });
    
    const iifContent = [...IIF_HEADER, ...result.lines].join('\r\n') + '\r\n';
    const filename = `invoice-${result.summary.drNumber}-${(wo.clientName || '').replace(/[^a-zA-Z0-9]/g, '_')}.iif`;
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
        { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms'] }
      ],
      order: [['drNumber', 'ASC']]
    });
    
    const allLines = [];
    const summaries = [];
    for (const wo of workOrders) {
      const result = buildInvoiceIIF(wo, wo.parts || [], wo.client);
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
        { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms'] }
      ]
    });
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    const result = buildInvoiceIIF(wo, wo.parts || [], wo.client);
    if (!result) return res.json({ data: null, message: 'No billable items found' });
    
    res.json({ data: { summary: result.summary, config: QB_CONFIG, rawIIF: result.lines.join('\n') } });
  } catch (error) {
    next(error);
  }
});

// POST /api/quickbooks/export-customers
router.post('/export-customers', async (req, res, next) => {
  try {
    const clients = await Client.findAll({ where: { isActive: true } });
    const header = '!CUST\tNAME\tCONT1\tPHONE1\tEMAIL\tTERMS';
    const lines = [header];
    for (const client of clients) {
      lines.push(`CUST\t${clean(client.name)}\t${clean(client.contactName)}\t${clean(client.contactPhone)}\t${clean(client.contactEmail)}\t${QB_CONFIG.defaultTerms}`);
    }
    const iifContent = lines.join('\r\n') + '\r\n';
    const filename = `quickbooks-customers-${new Date().toISOString().split('T')[0]}.iif`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(iifContent);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
