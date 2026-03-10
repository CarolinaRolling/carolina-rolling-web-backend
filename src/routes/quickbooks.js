const express = require('express');
const { WorkOrder, WorkOrderPart, Client } = require('../models');

const router = express.Router();

// QuickBooks Desktop IIF configuration
const QB_CONFIG = {
  arAccount: 'Accounts Receivable',
  incomeAccount: 'Rolling Services',
  taxAccount: 'Sales Tax Payable',
  defaultTerms: 'COD'
};

// Helper: format date as MM/DD/YYYY for QuickBooks
function formatQBDate(dateStr) {
  if (!dateStr) return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
  const d = new Date(dateStr);
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear()}`;
}

// Helper: build IIF invoice for a work order
function buildInvoiceIIF(wo, parts) {
  const lines = [];
  
  const EA_PRICED = ['plate_roll', 'angle_roll', 'flat_stock', 'pipe_roll', 'tube_roll', 
    'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'press_brake', 'cone_roll', 
    'fab_service', 'shop_rate', 'rush_service'];
  
  const drLabel = wo.drNumber ? `DR-${wo.drNumber}` : wo.orderNumber;
  const clientName = (wo.clientName || 'Unknown').replace(/\t/g, ' ');
  const invoiceDate = formatQBDate(wo.shippedAt || wo.completedAt || wo.createdAt);
  const terms = QB_CONFIG.defaultTerms;
  
  // Calculate line items
  const lineItems = [];
  let subtotalBeforeTax = 0;
  
  const SERVICE_TYPES = ['fab_service', 'shop_rate', 'rush_service'];
  
  for (const part of parts) {
    const qty = parseInt(part.quantity) || 1;
    const partTotal = parseFloat(part.partTotal) || 0;
    
    if (partTotal <= 0) continue;
    
    // Build description
    const fd = part.formData && typeof part.formData === 'object' ? part.formData : {};
    let desc = '';
    
    if (SERVICE_TYPES.includes(part.partType)) {
      const serviceType = fd._serviceType || part.partType;
      desc = `Part #${part.partNumber}: ${serviceType}`;
      if (part.specialInstructions) desc += ` - ${part.specialInstructions}`;
    } else {
      const matDesc = fd._materialDescription || part.materialDescription || '';
      const rollDesc = fd._rollingDescription || '';
      desc = `Part #${part.partNumber}: ${matDesc}`;
      if (rollDesc) {
        const firstLine = rollDesc.split(/\n|\\n/)[0].trim();
        if (firstLine) desc += ` | ${firstLine}`;
      }
    }
    
    // Clean description for IIF (no tabs, no newlines, limit length)
    desc = desc.replace(/[\t\r\n]/g, ' ').substring(0, 200);
    
    lineItems.push({
      description: desc,
      amount: partTotal,
      qty: qty
    });
    
    subtotalBeforeTax += partTotal;
  }
  
  // Add trucking if present
  const truckingCost = parseFloat(wo.truckingCost) || 0;
  if (truckingCost > 0) {
    const truckDesc = (wo.truckingDescription || 'Trucking / Delivery').replace(/[\t\r\n]/g, ' ');
    lineItems.push({
      description: truckDesc,
      amount: truckingCost,
      qty: 1
    });
    subtotalBeforeTax += truckingCost;
  }
  
  // Calculate tax
  const taxExempt = wo.taxExempt === true || wo.taxExempt === 'true';
  const taxRate = taxExempt ? 0 : (parseFloat(wo.taxRate) || 0);
  const taxAmount = taxExempt ? 0 : (parseFloat(wo.taxAmount) || Math.round(subtotalBeforeTax * taxRate / 100 * 100) / 100);
  
  const grandTotal = Math.round((subtotalBeforeTax + taxAmount) * 100) / 100;
  
  if (lineItems.length === 0) return null;
  
  // TRNS line: debit Accounts Receivable (positive amount = grand total including tax)
  const memo = `${drLabel} - ${clientName}`.replace(/[\t\r\n]/g, ' ');
  lines.push([
    'TRNS', '', 'INVOICE', invoiceDate, QB_CONFIG.arAccount, clientName,
    grandTotal.toFixed(2), drLabel, memo, terms
  ].join('\t'));
  
  // SPL lines: credit income account for each line item (negative amounts)
  for (const item of lineItems) {
    lines.push([
      'SPL', '', 'INVOICE', invoiceDate, QB_CONFIG.incomeAccount, clientName,
      (-item.amount).toFixed(2), drLabel, item.description
    ].join('\t'));
  }
  
  // SPL line: credit tax payable (if applicable)
  if (taxAmount > 0) {
    lines.push([
      'SPL', '', 'INVOICE', invoiceDate, QB_CONFIG.taxAccount, clientName,
      (-taxAmount).toFixed(2), drLabel, 'Sales Tax'
    ].join('\t'));
  }
  
  lines.push('ENDTRNS');
  
  return {
    lines,
    summary: {
      drNumber: drLabel,
      clientName,
      lineItems: lineItems.length,
      subtotal: subtotalBeforeTax,
      tax: taxAmount,
      total: grandTotal
    }
  };
}

// GET /api/quickbooks/export/:id - Export single work order as IIF
router.get('/export/:id', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    
    if (!wo) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }
    
    const result = buildInvoiceIIF(wo, wo.parts || []);
    
    if (!result) {
      return res.status(400).json({ error: { message: 'No billable items found on this work order' } });
    }
    
    // Build IIF file
    const header = [
      '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tTERMS',
      '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO',
      '!ENDTRNS'
    ];
    
    const iifContent = [...header, ...result.lines].join('\r\n') + '\r\n';
    
    const filename = `invoice-${result.summary.drNumber}-${wo.clientName?.replace(/[^a-zA-Z0-9]/g, '_')}.iif`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(iifContent);
  } catch (error) {
    next(error);
  }
});

// POST /api/quickbooks/export-batch - Export multiple work orders as single IIF
router.post('/export-batch', async (req, res, next) => {
  try {
    const { workOrderIds } = req.body;
    
    if (!workOrderIds || !workOrderIds.length) {
      return res.status(400).json({ error: { message: 'No work order IDs provided' } });
    }
    
    const { Op } = require('sequelize');
    const workOrders = await WorkOrder.findAll({
      where: { id: { [Op.in]: workOrderIds } },
      include: [{ model: WorkOrderPart, as: 'parts' }],
      order: [['drNumber', 'ASC']]
    });
    
    const header = [
      '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tTERMS',
      '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO',
      '!ENDTRNS'
    ];
    
    const allLines = [];
    const summaries = [];
    let skipped = 0;
    
    for (const wo of workOrders) {
      const result = buildInvoiceIIF(wo, wo.parts || []);
      if (result) {
        allLines.push(...result.lines);
        summaries.push(result.summary);
      } else {
        skipped++;
      }
    }
    
    if (allLines.length === 0) {
      return res.status(400).json({ error: { message: 'No billable items found in selected work orders' } });
    }
    
    const iifContent = [...header, ...allLines].join('\r\n') + '\r\n';
    
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `quickbooks-invoices-${dateStr}.iif`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(iifContent);
  } catch (error) {
    next(error);
  }
});

// GET /api/quickbooks/preview/:id - Preview what the IIF would look like (JSON)
router.get('/preview/:id', async (req, res, next) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    
    if (!wo) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }
    
    const result = buildInvoiceIIF(wo, wo.parts || []);
    
    if (!result) {
      return res.json({ data: null, message: 'No billable items found' });
    }
    
    res.json({
      data: {
        summary: result.summary,
        config: QB_CONFIG,
        rawIIF: result.lines.join('\n')
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/quickbooks/export-customers - Export clients as IIF customer list
router.post('/export-customers', async (req, res, next) => {
  try {
    const clients = await Client.findAll({ where: { isActive: true } });
    
    const header = '!CUST\tNAME\tCONT1\tPHONE1\tEMAIL\tTERMS';
    const lines = [header];
    
    for (const client of clients) {
      const name = (client.name || '').replace(/[\t\r\n]/g, ' ');
      const contact = (client.contactName || '').replace(/[\t\r\n]/g, ' ');
      const phone = (client.contactPhone || '').replace(/[\t\r\n]/g, ' ');
      const email = (client.contactEmail || '').replace(/[\t\r\n]/g, ' ');
      lines.push(`CUST\t${name}\t${contact}\t${phone}\t${email}\t${QB_CONFIG.defaultTerms}`);
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
