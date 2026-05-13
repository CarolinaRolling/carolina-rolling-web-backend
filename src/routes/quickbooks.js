const express = require('express');
const path = require('path');
const fs = require('fs');
const fileStorage = require('../utils/storage');
const { WorkOrder, WorkOrderPart, WorkOrderDocument, Client, InvoiceNumber, AppSettings, sequelize } = require('../models');

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
    .replace(/π/g, 'pi')
    .replace(/(\d)"(\s|$|x|X|\))/g, '$1in.$2')
    .replace(/"/g, "'")
    .trim();
}

function mapTerms(terms) {
  if (!terms) return 'C.O.D.';
  return TERMS_MAP[terms] || TERMS_MAP[terms.toUpperCase()] || terms.toUpperCase();
}

// Extract net days from payment terms string
function getNetDays(terms) {
  if (!terms) return null;
  const t = terms.toUpperCase();
  if (t === 'COD' || t === 'C.O.D.' || t.includes('COD')) return 0;
  // Match "NET 30", "NET 60", "NET 30 DAYS", etc.
  const netMatch = t.match(/NET\s+(\d+)/);
  if (netMatch) return parseInt(netMatch[1]);
  // Match "30 DAYS", "60 DAYS"
  const daysMatch = t.match(/^(\d+)\s+DAYS?$/);
  if (daysMatch) return parseInt(daysMatch[1]);
  return null;
}

// Get the final (full) ship date from pickup history or shippedAt
function getFinalShipDate(wo) {
  const history = Array.isArray(wo.pickupHistory) ? wo.pickupHistory : [];
  const fullShip = history.filter(e => e.type === 'full' || e.type === 'pickup').sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt))[0];
  if (fullShip?.date) return new Date(fullShip.date);
  if (wo.shippedAt) return new Date(wo.shippedAt);
  return null;
}

// Pricing utilities from shared module
const { calculatePartTotal, roundUpMaterial, loadLaborMinimums, calculateMinimumAdjustment } = require('../services/pricing');

function getPartAmount(part) {
  return calculatePartTotal(part);
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

async function buildInvoiceIIF(wo, parts, client, invoiceNum) {
  // Skip void work orders
  if (wo.isVoided || wo.status === 'void') {
    console.log(`[IIF] Skipping void WO: DR-${wo.drNumber}`);
    return null;
  }
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
  
  // Build line items — multi-line per part:
  // Line 1: material description with INVITEM (priced row)
  // Filler lines: rolling instructions, each service on own line
  // Blank line between parts
  const lineItems = [];
  let subtotal = 0;
  
  // Item type: 1 = resale (nontaxable), 2 = taxable
  const itemType = isResale ? '1' : '2';
  
  // Helper to make a filler line (no pricing)
  const filler = (desc) => ({ description: clean(desc).substring(0, 200), amount: 0, qty: 0, invItem: '', isPriced: false });
  const blank = () => ({ description: '', amount: 0, qty: 0, invItem: '', isPriced: false });
  
  // Track material sources for summary at end
  const materialSources = new Set();
  
  for (let pi = 0; pi < regularParts.length; pi++) {
    const part = regularParts[pi];
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
    
    // Build descriptions
    const fd = part.formData && typeof part.formData === 'object' ? part.formData : {};
    let matDesc = clean(fd._materialDescription || part.materialDescription || '');
    // Strip leading quantity like "(2) " or "1pc: " or "2pc: "
    matDesc = matDesc.replace(/^\(\d+\)\s*/, '').replace(/^\d+pc:?\s*/i, '');
    
    const rollDesc = fd._rollingDescription || '';
    const firstRoll = rollDesc ? clean(rollDesc.split(/\n|\\n/)[0]) : '';
    
    // Track material source
    if (part.materialSource) materialSources.add(part.materialSource);
    
    // Line 1: material description — priced row with INVITEM
    const qty = parseInt(part.quantity) || 1;
    lineItems.push({
      description: clean(matDesc).substring(0, 200),
      amount: combinedTotal,
      qty: qty,
      invItem: itemType,
      isPriced: true
    });
    subtotal += combinedTotal;
    
    // Filler: rolling instructions
    if (firstRoll) {
      lineItems.push(filler(firstRoll));
    }
    
    // Filler: each service on its own line
    if (partCost > 0) {
      lineItems.push(filler(`Rolling/Labor: $${partCost.toFixed(2)}`));
    }
    for (const s of svcDetails) {
      if (s.cost > 0) lineItems.push(filler(`${s.label}: $${s.cost.toFixed(2)}`));
    }
    
    // Outside processing filler line
    if (part.outsideProcessingVendorName) {
      const opCost = parseFloat(part.outsideProcessingCost) || 0;
      const opMarkup = parseFloat(part.outsideProcessingMarkupPercent) || 0;
      const opBilled = Math.round(opCost * (1 + opMarkup / 100) * 100) / 100;
      const opTransport = parseFloat(part.outsideProcessingTransportCost) || 0;
      const opLabel = part.outsideProcessingDescription || 'Outside Processing';
      lineItems.push(filler(`${opLabel} (${part.outsideProcessingVendorName}): $${opBilled.toFixed(2)}`));
      if (opTransport > 0) {
        const tMarkup = parseFloat(part.outsideProcessingTransportMarkupPercent) || 0;
        const tBilled = Math.round(opTransport * (1 + tMarkup / 100) * 100) / 100;
        lineItems.push(filler(`Transport: $${tBilled.toFixed(2)}`));
      }
    }
    
    // Blank line between parts (not after the last one)
    if (pi < regularParts.length - 1) {
      lineItems.push(blank());
    }
  }
  
  // Unlinked services
  for (const svc of unlinkedServices) {
    const cost = getPartAmount(svc);
    if (cost <= 0) continue;
    const fd = svc.formData && typeof svc.formData === 'object' ? svc.formData : {};
    let label = fd._fabServiceType || fd._serviceType || svc.partType;
    let desc = label;
    if (svc.specialInstructions) desc += ` - ${clean(svc.specialInstructions).substring(0, 60)}`;
    lineItems.push({ description: clean(desc).substring(0, 200), amount: cost, qty: 1, invItem: itemType, isPriced: true });
    subtotal += cost;
  }
  
  // Trucking
  const trucking = parseFloat(wo.truckingCost) || 0;
  if (trucking > 0) {
    lineItems.push({
      description: clean(wo.truckingDescription || 'Trucking / Delivery'),
      amount: trucking,
      qty: 1,
      isFreight: true,
      isPriced: true,
      invItem: ''
    });
    subtotal += trucking;
  }
  
  // Add blank lines then material supplier info
  lineItems.push(blank());
  lineItems.push(blank());
  
  // Determine material supplier
  const sourceLabels = {
    'customer_supplied': 'Customer',
    'we_order': 'Carolina Rolling Co., Inc.',
    'in_stock': 'Carolina Rolling Co., Inc. (In Stock)'
  };
  if (materialSources.size > 0) {
    const sources = [...materialSources].map(s => sourceLabels[s] || s);
    const uniqueSources = [...new Set(sources)];
    lineItems.push(filler(`Material supplied by: ${uniqueSources.join(' / ')}`));
  }
  
  if (lineItems.length === 0) return null;
  
  // Check minimum labor charge using shared utility
  let minimumAdjustment = 0;
  if (!wo.minimumOverride) {
    try {
      const minimums = await loadLaborMinimums();
      const minInfo = calculateMinimumAdjustment(sorted, wo.minimumOverride, minimums);
      if (minInfo.applies) {
        minimumAdjustment = minInfo.adjustment;
        console.log(`[IIF] Minimum labor applies: totalLabor=$${minInfo.totalLabor}, minimum=$${minInfo.minimum}, adjustment=$${minimumAdjustment}`);
        lineItems.push({
          description: `Minimum labor charge adjustment`,
          amount: minimumAdjustment,
          qty: 1,
          invItem: itemType,
          isPriced: true
        });
        subtotal += minimumAdjustment;
      }
    } catch (e) {
      console.error('[IIF] Minimum labor check error:', e.message);
    }
  }
  
  // Apply discount
  const discountPct = parseFloat(wo.discountPercent) || 0;
  const discountAmt = parseFloat(wo.discountAmount) || 0;
  let discountTotal = 0;
  if (discountPct > 0) {
    discountTotal = Math.round(subtotal * discountPct / 100 * 100) / 100;
  } else if (discountAmt > 0) {
    discountTotal = discountAmt;
  }
  if (discountTotal > 0) {
    const reason = wo.discountReason ? ` (${clean(wo.discountReason)})` : '';
    const label = discountPct > 0 ? `Discount ${discountPct}%${reason}` : `Discount${reason}`;
    lineItems.push({
      description: clean(label).substring(0, 200),
      amount: -discountTotal,
      qty: 1,
      invItem: itemType,
      isPriced: true
    });
    subtotal -= discountTotal;
    console.log(`[IIF] Discount: $${discountTotal} (${discountPct > 0 ? discountPct + '%' : 'flat'})`);
  }
  
  // Tax calculation — for summary only. QB auto-calculates tax from TAXABLE=Y lines
  const taxRate = isResale ? 0 : (parseFloat(wo.taxRate) || 0);
  const taxableAmount = isResale ? 0 : lineItems.filter(i => i.isPriced && !i.isFreight).reduce((s, i) => s + i.amount, 0);
  const taxAmount = Math.round(taxableAmount * taxRate / 100 * 100) / 100;
  // TRNS amount = subtotal only. QB adds tax automatically for taxable lines.
  const grandTotal = Math.round(subtotal * 100) / 100;
  
  // DR number for Delivery Receipt field — just the number, no prefix
  const drNum = wo.drNumber ? String(wo.drNumber) : '';
  
  const memo = clean(`${drLabel} - ${clientName}`).substring(0, 200);
  
  // TRNS: debit AR — PONUM=client PO, OTHER1=DR number (Delivery Receipt)
  lines.push([
    'TRNS', '', 'INVOICE', invoiceDate, QB_CONFIG.arAccount, clientName,
    grandTotal.toFixed(2), docNum, memo, 'N', 'Y', terms, clientPO, drNum
  ].join('\t'));
  
  // SPL: two types of lines per part
  // Priced line: has INVITEM (1 or 2), QTY, PRICE — creates a billable row
  // Filler line: no INVITEM, no amounts — just description text
  for (const item of lineItems) {
    if (item.isPriced) {
      const account = item.isFreight ? QB_CONFIG.freightAccount
        : isResale ? QB_CONFIG.nontaxableIncomeAccount
        : QB_CONFIG.taxableIncomeAccount;
      const taxable = (item.isFreight || isResale) ? 'N' : 'Y';
      const qty = item.qty || 1;
      const each = (item.amount / qty).toFixed(2);
      lines.push([
        'SPL', '', 'INVOICE', invoiceDate, account, clientName,
        (-item.amount).toFixed(2), docNum, item.description, 'N',
        (-qty).toString(), (-parseFloat(each)).toFixed(2), item.invItem || '', taxable
      ].join('\t'));
    } else {
      // Filler line — description only, no account, no amounts, no tax
      lines.push([
        'SPL', '', 'INVOICE', invoiceDate, '', '',
        '', docNum, item.description, ''
      ].join('\t'));
    }
  }
  
  // No explicit tax SPL line — QB auto-calculates tax from TAXABLE=Y lines
  
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


// ==================== INVOICE PDF GENERATOR ====================

async function generateInvoicePDFBuffer(wo, parts, client, payments = []) {
  const PDFDocument = require('pdfkit');

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const logoPath = [path.join(__dirname, '../assets/logo.png'), path.join(__dirname, '../assets/logo.jpg')].find(p => fs.existsSync(p));
      const yellowcakePath = path.join(__dirname, '../assets/fonts/Yellowcake-Regular.ttf');
      let hasYellowcake = false;
      try { if (fs.existsSync(yellowcakePath)) { doc.registerFont('Yellowcake', yellowcakePath); hasYellowcake = true; } } catch {}

      const fmtCur = (v) => '$' + (parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';

      const primaryColor = '#1976d2';
      const darkColor = '#333';
      const grayColor = '#666';
      const lightGray = '#e0e0e0';

      // ── Header ──
      if (logoPath) try { doc.image(logoPath, 50, 22, { width: 65 }); } catch {}
      if (hasYellowcake) doc.fontSize(15).fillColor(darkColor).font('Yellowcake').text('Carolina Rolling Co. Inc.', 130, 32, { lineBreak: false });
      else doc.fontSize(15).fillColor(darkColor).font('Helvetica-Bold').text('CAROLINA ROLLING CO. INC.', 130, 32, { lineBreak: false });
      doc.font('Helvetica').fontSize(10.5).fillColor(grayColor);
      doc.text('9152 Sonrisa St., Bellflower, CA 90706', 130, 52, { lineBreak: false });
      doc.text('Phone: (562) 633-1044  |  Email: keepitrolling@carolinarolling.com', 130, 63, { lineBreak: false });

      // Invoice number + date — top right
      doc.fontSize(16).fillColor(primaryColor).font('Helvetica-Bold');
      doc.text('INVOICE', 350, 32, { width: 212, align: 'right', lineBreak: false });
      const invNum = wo.invoiceNumber || (wo.drNumber ? 'DR-' + wo.drNumber : '');
      doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor);
      doc.text('#' + invNum, 350, 52, { width: 212, align: 'right', lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor(grayColor);
      doc.text('Date: ' + fmtDate(wo.invoiceDate || wo.shippedAt || wo.completedAt || new Date()), 350, 65, { width: 212, align: 'right', lineBreak: false });
      const terms = mapTerms(client?.paymentTerms);
      doc.text('Terms: ' + terms, 350, 76, { width: 212, align: 'right', lineBreak: false });

      // Due Date — based on final ship date + net days from terms
      const netDays = getNetDays(client?.paymentTerms);
      const finalShip = getFinalShipDate(wo);
      if (netDays !== null && netDays > 0 && finalShip) {
        const dueDate = new Date(finalShip);
        dueDate.setDate(dueDate.getDate() + netDays);
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#c62828');
        doc.text('Due: ' + fmtDate(dueDate), 350, 87, { width: 212, align: 'right', lineBreak: false });
      } else if (netDays === 0) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#c62828');
        doc.text('Due: Upon Receipt (COD)', 350, 87, { width: 212, align: 'right', lineBreak: false });
      }

      // Divider — pushed down to give Due Date room
      const hasTermsDue = getNetDays(client?.paymentTerms) !== null || (client?.paymentTerms || '').toUpperCase().includes('COD');
      const headerDividerY = hasTermsDue ? 102 : 92;
      doc.strokeColor(lightGray).lineWidth(1).moveTo(50, headerDividerY).lineTo(562, headerDividerY).stroke();

      // ── Bill To ──
      let yPos = headerDividerY + 12;
      doc.fontSize(10).fillColor(primaryColor).font('Helvetica-Bold').text('BILL TO:', 50, yPos, { lineBreak: false });
      doc.font('Helvetica');
      yPos += 16;
      const billName = client?.quickbooksName || client?.name || wo.clientName || '';
      doc.fontSize(12).fillColor(darkColor).font('Helvetica-Bold').text(billName, 50, yPos, { lineBreak: false });
      doc.font('Helvetica');
      yPos += 16;
      if (wo.clientPurchaseOrderNumber) {
        doc.fontSize(10).fillColor(grayColor).text('P.O.: ' + wo.clientPurchaseOrderNumber, 50, yPos, { lineBreak: false });
        yPos += 13;
      }

      // Work Order info — right side
      doc.fontSize(10).fillColor(grayColor).font('Helvetica');
      const drLabel = wo.drNumber ? 'DR-' + wo.drNumber : (wo.orderNumber || '');
      doc.text('Work Order: ' + drLabel, 350, 104, { width: 212, align: 'right', lineBreak: false });

      // ── Services & Materials table ──
      yPos = Math.max(yPos + 20, 165);
      doc.strokeColor(lightGray).lineWidth(1).moveTo(50, yPos).lineTo(562, yPos).stroke();
      yPos += 10;
      doc.fontSize(12).fillColor(primaryColor).font('Helvetica-Bold').text('SERVICES & MATERIALS', 50, yPos, { lineBreak: false });
      yPos += 22;

      // Table header row
      doc.fontSize(10).fillColor(grayColor).font('Helvetica');
      doc.text('ITEM', 50, yPos, { lineBreak: false });
      doc.text('DESCRIPTION', 85, yPos, { lineBreak: false });
      doc.text('QTY', 400, yPos, { width: 30, align: 'center', lineBreak: false });
      doc.text('UNIT', 438, yPos, { width: 52, align: 'right', lineBreak: false });
      doc.text('AMOUNT', 498, yPos, { width: 64, align: 'right', lineBreak: false });
      yPos += 12;
      doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
      yPos += 8;

      // Build part map for services
      const SERVICE_TYPES = ['fab_service', 'shop_rate', 'rush_service'];
      const sorted = [...parts].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
      const regularParts = sorted.filter(p => !SERVICE_TYPES.includes(p.partType));
      const serviceParts = sorted.filter(p => SERVICE_TYPES.includes(p.partType));
      const servicesByParent = new Map();
      for (const svc of serviceParts) {
        const fd = (svc.formData && typeof svc.formData === 'object') ? svc.formData : {};
        const parentId = fd._linkedPartId;
        if (parentId) {
          if (!servicesByParent.has(parentId)) servicesByParent.set(parentId, []);
          servicesByParent.get(parentId).push(svc);
        }
      }

      let subtotal = 0;
      const isResale = (client?.taxStatus || '').toLowerCase() === 'resale' || (client?.taxStatus || '').toLowerCase() === 'exempt';

      const PART_LABELS = {
        plate_roll: 'Plate Roll', angle_roll: 'Angle Roll', pipe_roll: 'Pipes / Tubes / Round',
        tube_roll: 'Square & Rect Tube Roll', channel_roll: 'Channel Roll', beam_roll: 'Beam Roll',
        flat_bar: 'Flat Bar Roll', flat_stock: 'Flat Stock', cone_roll: 'Cone Roll',
        tee_bar: 'Tee Bar Roll', press_brake: 'Press Brake', fab_service: 'Fabrication Service',
        shop_rate: 'Shop Rate', rush_service: 'Rush / Emergency Service', other: 'Other'
      };

      let itemNum = 1;
      for (const part of regularParts) {
        if (yPos > 700) { doc.addPage(); yPos = 50; }
        const linked = servicesByParent.get(part.id) || [];
        const partAmt = calculatePartTotal(part);
        const svcAmt = linked.reduce((s, svc) => s + calculatePartTotal(svc), 0);
        const total = partAmt + svcAmt;
        const qty = parseInt(part.quantity) || 1;
        const unitPrice = qty > 0 ? total / qty : total;
        subtotal += total;

        const fd = (part.formData && typeof part.formData === 'object') ? part.formData : {};
        let matDesc = clean(fd._materialDescription || part.materialDescription || '').replace(/^\d+pc:?\s*/i, '');
        if (!matDesc && part.specialInstructions) matDesc = '(See note below)';
        else if (!matDesc) matDesc = PART_LABELS[part.partType] || 'Service';
        const typeLabel = PART_LABELS[part.partType] || (part.partType || '').replace(/_/g, ' ');
        const rollDesc = fd._rollingDescription ? clean(fd._rollingDescription.split(/\n/)[0]) : '';
        const partLabel = wo.drNumber ? `${wo.drNumber}-${part.partNumber}` : String(part.partNumber || itemNum);

        // Row background alternate
        const rowH = rollDesc ? 34 : 20;
        if (itemNum % 2 === 0) {
          doc.rect(50, yPos - 2, 512, rowH).fill('#f8f9fa').stroke();
        }

        doc.font('Helvetica').fontSize(10).fillColor(grayColor).text(String(itemNum), 50, yPos, { width: 30, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor).text(matDesc.substring(0, 48), 85, yPos, { width: 310, lineBreak: false });
        if (rollDesc) {
          doc.font('Helvetica').fontSize(9).fillColor(grayColor).text(rollDesc.substring(0, 58), 85, yPos + 13, { width: 310, lineBreak: false });
        }
        doc.font('Helvetica').fontSize(10).fillColor(darkColor);
        doc.text(String(qty), 400, yPos, { width: 30, align: 'center', lineBreak: false });
        doc.text(fmtCur(unitPrice), 438, yPos, { width: 52, align: 'right', lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor).text(fmtCur(total), 498, yPos, { width: 64, align: 'right', lineBreak: false });
        yPos += rowH;

        // Special instructions under part
        const specialInstr = clean(part.specialInstructions || fd.specialInstructions || '');
        if (specialInstr) {
          if (yPos > 700) { doc.addPage(); yPos = 50; }
          doc.font('Helvetica').fontSize(9).fillColor(grayColor).text('  Note: ' + specialInstr, 85, yPos, { width: 420, lineBreak: false });
          yPos += 13;
        }

        // Service note under part
        for (const svc of linked) {
          if (yPos > 700) { doc.addPage(); yPos = 50; }
          const svcFd = (svc.formData && typeof svc.formData === 'object') ? svc.formData : {};
          const svcLabel = clean(svcFd._serviceNotes || svcFd._serviceType || 'Fabrication Service').substring(0, 60);
          doc.font('Helvetica').fontSize(9).fillColor(grayColor).text('  + ' + svcLabel, 85, yPos, { width: 420, lineBreak: false });
          yPos += 13;
        }

        doc.strokeColor(lightGray).lineWidth(0.3).moveTo(50, yPos).lineTo(562, yPos).stroke();
        yPos += 6;
        itemNum++;
      }

      // Unlinked services (fab, shop rate, etc.)
      for (const svc of serviceParts.filter(s => !Array.from(servicesByParent.values()).flat().includes(s))) {
        let amt = calculatePartTotal(svc);

        // Rush service — fee stored in formData, not partTotal
        if (svc.partType === 'rush_service' && amt <= 0) {
          const fd = (svc.formData && typeof svc.formData === 'object') ? svc.formData : {};
          if (fd._expediteEnabled) {
            if (fd._expediteType === 'custom_amt') {
              amt += parseFloat(fd._expediteCustomAmt) || 0;
            } else {
              let pct = parseFloat(fd._expediteType) || 0;
              if (fd._expediteType === 'custom_pct') pct = parseFloat(fd._expediteCustomPct) || 0;
              amt += subtotal * (pct / 100);
            }
          }
          if (fd._emergencyEnabled) {
            const emergOpts = { 'Saturday': 600, 'Saturday Night': 800, 'Sunday': 600, 'Sunday Night': 800 };
            amt += emergOpts[fd._emergencyDay] || 0;
          }
        }

        if (amt <= 0) continue;
        subtotal += amt;
        if (yPos > 700) { doc.addPage(); yPos = 50; }
        const fd = (svc.formData && typeof svc.formData === 'object') ? svc.formData : {};
        let label;
        if (svc.partType === 'rush_service') {
          const parts = [];
          if (fd._expediteEnabled) {
            const pct = fd._expediteType === 'custom_pct' ? fd._expediteCustomPct : fd._expediteType;
            parts.push(fd._expediteType === 'custom_amt' ? `Expedite Fee` : `Expedite Service (${pct}%)`);
          }
          if (fd._emergencyEnabled) parts.push(`Emergency Off-Hours (${fd._emergencyDay})`);
          label = parts.join(' + ') || 'Rush / Emergency Service';
        } else {
          label = clean(fd._serviceNotes || fd._serviceType || PART_LABELS[svc.partType] || 'Service');
        }
        doc.font('Helvetica').fontSize(10).fillColor(grayColor).text(String(itemNum), 50, yPos, { width: 30, lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor(darkColor).text(label.substring(0, 48), 85, yPos, { width: 310, lineBreak: false });
        doc.text('1', 400, yPos, { width: 30, align: 'center', lineBreak: false });
        doc.text(fmtCur(amt), 438, yPos, { width: 52, align: 'right', lineBreak: false });
        doc.font('Helvetica-Bold').text(fmtCur(amt), 498, yPos, { width: 64, align: 'right', lineBreak: false });
        yPos += 20;
        doc.strokeColor(lightGray).lineWidth(0.3).moveTo(50, yPos).lineTo(562, yPos).stroke();
        yPos += 6;
        itemNum++;
      }

      // Trucking
      const trucking = parseFloat(wo.truckingCost) || 0;
      if (trucking > 0) {
        subtotal += trucking;
        doc.font('Helvetica').fontSize(10).fillColor(grayColor).text(String(itemNum), 50, yPos, { width: 30, lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor(darkColor).text(clean(wo.truckingDescription || 'Trucking / Delivery'), 85, yPos, { width: 310, lineBreak: false });
        doc.text('1', 400, yPos, { width: 30, align: 'center', lineBreak: false });
        doc.text(fmtCur(trucking), 438, yPos, { width: 52, align: 'right', lineBreak: false });
        doc.font('Helvetica-Bold').text(fmtCur(trucking), 498, yPos, { width: 64, align: 'right', lineBreak: false });
        yPos += 20;
        doc.strokeColor(lightGray).lineWidth(0.3).moveTo(50, yPos).lineTo(562, yPos).stroke();
        yPos += 6;
      }

      // ── Totals ──
      yPos += 10;
      doc.strokeColor(lightGray).lineWidth(1).moveTo(50, yPos).lineTo(562, yPos).stroke();
      yPos += 12;

      const totRow = (label, value, bold = false, color = darkColor) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(grayColor).text(label, 350, yPos, { width: 140, align: 'right', lineBreak: false });
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(color).text(fmtCur(value), 498, yPos, { width: 64, align: 'right', lineBreak: false });
        yPos += 16;
      };

      // Discount
      const discountPct = parseFloat(wo.discountPercent) || 0;
      const discountAmt = parseFloat(wo.discountAmount) || 0;
      let discountTotal = discountPct > 0 ? Math.round(subtotal * discountPct / 100 * 100) / 100 : discountAmt;
      if (discountTotal > 0) {
        const label = discountPct > 0 ? `Discount (${discountPct}%)` : 'Discount';
        doc.font('Helvetica').fontSize(10).fillColor(grayColor).text(label, 350, yPos, { width: 140, align: 'right', lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor('#c62828').text('-' + fmtCur(discountTotal), 498, yPos, { width: 64, align: 'right', lineBreak: false });
        yPos += 16;
        subtotal -= discountTotal;
      }

      totRow('Subtotal', subtotal);
      const taxRate = isResale ? 0 : (parseFloat(wo.taxRate) || 0);
      const taxAmt = Math.round(subtotal * taxRate / 100 * 100) / 100;
      if (isResale) {
        doc.font('Helvetica').fontSize(9).fillColor(grayColor).text('Tax Exempt / Resale Certificate', 350, yPos, { width: 212, align: 'right', lineBreak: false });
        yPos += 14;
      } else {
        totRow(`Tax (${taxRate}%)`, taxAmt);
      }
      const grandTotal = Math.round((subtotal + taxAmt) * 100) / 100;

      // Grand total box
      yPos += 4;
      const hasPayments = payments.filter(p => !p.voidedAt).length > 0;
      doc.rect(350, yPos, 212, 26).fill(primaryColor).stroke();
      doc.font('Helvetica-Bold').fontSize(12).fillColor('white');
      doc.text(hasPayments ? 'INVOICE TOTAL' : 'TOTAL DUE', 355, yPos + 7, { width: 100, lineBreak: false });
      doc.text(fmtCur(grandTotal), 458, yPos + 7, { width: 100, align: 'right', lineBreak: false });
      yPos += 40;

      // ── Payment History ──
      const activePayments = payments.filter(p => !p.voidedAt);
      if (activePayments.length > 0) {
        if (yPos > 650) { doc.addPage(); yPos = 50; }
        yPos += 8;
        doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, yPos).lineTo(562, yPos).stroke();
        yPos += 10;
        doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text('PAYMENT HISTORY', 50, yPos, { lineBreak: false });
        yPos += 14;

        const fmtPayDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '';
        const typeLabel = { downpayment: 'Down Payment', partial: 'Partial Payment', full: 'Payment in Full' };
        const methodLabel = { check: 'Check', ach: 'ACH', wire: 'Wire Transfer', credit_card: 'Credit Card', cash: 'Cash', other: 'Other' };
        let runningBalance = grandTotal; // start from final invoice total including tax
        const grandTotal2 = runningBalance;

        for (const pmt of activePayments) {
          if (yPos > 690) { doc.addPage(); yPos = 50; }
          const pmtAmt = parseFloat(pmt.amount) || 0;
          runningBalance -= pmtAmt;
          const label = typeLabel[pmt.paymentType] || 'Payment';
          const method = methodLabel[pmt.paymentMethod] || pmt.paymentMethod || '';
          const ref = pmt.paymentReference ? ` — Ref: ${pmt.paymentReference}` : '';

          // Layout: Date(80) | Description(220) | Amount(90,right) | Balance label+value(120,right)
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#2e7d32');
          doc.text(fmtPayDate(pmt.paymentDate), 50, yPos, { width: 80, lineBreak: false });
          doc.font('Helvetica').fontSize(10).fillColor(darkColor);
          doc.text(`${label}${method ? ' (' + method + ')' : ''}${ref}`, 135, yPos, { width: 220, lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#2e7d32');
          doc.text('-' + fmtCur(pmtAmt), 358, yPos, { width: 90, align: 'right', lineBreak: false });
          doc.font('Helvetica').fontSize(9).fillColor(grayColor);
          doc.text('Bal: ' + fmtCur(Math.max(0, runningBalance)), 452, yPos, { width: 110, align: 'right', lineBreak: false });
          yPos += 18;
          doc.strokeColor('#f0f0f0').lineWidth(0.3).moveTo(50, yPos - 2).lineTo(562, yPos - 2).stroke();
        }

        // Balance due — check page room first
        yPos += 4;
        if (yPos + 26 > 720) { doc.addPage(); yPos = 50; }
        const finalBalance = Math.max(0, runningBalance);
        if (finalBalance <= 0.01) {
          doc.rect(50, yPos, 512, 22).fill('#e8f5e9');
          doc.font('Helvetica-Bold').fontSize(11).fillColor('#2e7d32');
          doc.text('✓  PAID IN FULL', 50, yPos + 5, { width: 512, align: 'center', lineBreak: false });
        } else {
          doc.rect(50, yPos, 512, 22).fill('#fff3e0');
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#e65100');
          doc.text('BALANCE DUE', 55, yPos + 6, { lineBreak: false });
          doc.text(fmtCur(finalBalance), 498, yPos + 6, { width: 64, align: 'right', lineBreak: false });
        }
        yPos += 26;
      }

      // Footer — only draw if enough room remains on this page (need ~30px)
      const pageBottom = 742; // PDFKit letter page bottom margin
      if (yPos + 30 < pageBottom) {
        const footerY = Math.max(yPos + 10, 720);
        doc.strokeColor(lightGray).lineWidth(0.5).moveTo(50, footerY).lineTo(562, footerY).stroke();
        doc.font('Helvetica').fontSize(8.5).fillColor('#aaa')
          .text('Carolina Rolling Co. Inc.  |  9152 Sonrisa St., Bellflower, CA 90706  |  (562) 633-1044  |  keepitrolling@carolinarolling.com', 50, footerY + 8, { width: 512, align: 'center', lineBreak: false });
      }

      doc.end();
    } catch (err) { reject(err); }
  });
}

// ==================== RECONCILIATION PDF GENERATOR ====================

async function generateReconciliationPDFBuffer(items, batchId, exportDate) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'letter' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const logoFile = [path.join(__dirname, '../assets/logo.png'), path.join(__dirname, '../assets/logo.jpg')].find(p => fs.existsSync(p));
    const yellowcakePath = path.join(__dirname, '../assets/fonts/Yellowcake-Regular.ttf');
    let hasYellowcake = false;
    try { if (fs.existsSync(yellowcakePath)) { doc.registerFont('Yellowcake', yellowcakePath); hasYellowcake = true; } } catch {}

    const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: 'numeric' });
    const fmtCur = (v) => '$' + (parseFloat(v) || 0).toFixed(2);

    // Header
    if (logoFile) try { doc.image(logoFile, 50, 20, { width: 60 }); } catch {}
    if (hasYellowcake) doc.font('Yellowcake').fontSize(14).fillColor('#333').text('Carolina Rolling Co. Inc.', 125, 28);
    else doc.font('Helvetica-Bold').fontSize(14).fillColor('#333').text('CAROLINA ROLLING CO. INC.', 125, 28);
    doc.font('Helvetica').fontSize(10).fillColor('#666').text('9152 Sonrisa St., Bellflower, CA 90706', 125, 46);
    doc.moveTo(50, 80).lineTo(562, 80).lineWidth(2).strokeColor('#e65100').stroke();

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#e65100').text('QUICKBOOKS EXPORT — RECONCILIATION', 50, 90);
    doc.font('Helvetica').fontSize(10).fillColor('#555');
    doc.text(`Batch ID: ${batchId}`, 50, 108);
    doc.text(`Export Date: ${fmtDate(exportDate)}`, 50, 120);
    doc.text(`${items.length} invoice(s)`, 50, 132);
    doc.moveTo(50, 148).lineTo(562, 148).lineWidth(0.5).strokeColor('#e0e0e0').stroke();

    let y = 158;

    // Table header
    doc.rect(50, y, 512, 18).fill('#333');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('white');
    doc.text('✓', 56, y + 4, { width: 20 });
    doc.text('INVOICE #', 82, y + 4, { width: 80 });
    doc.text('DR #', 167, y + 4, { width: 60 });
    doc.text('CLIENT', 232, y + 4, { width: 180 });
    doc.text('CLIENT PO', 417, y + 4, { width: 90 });
    doc.text('AMOUNT', 500, y + 4, { width: 57, align: 'right' });
    y += 22;

    let grandTotal = 0;
    items.forEach((item, i) => {
      if (y > 700) { doc.addPage(); y = 50; }
      const shade = i % 2 === 1;
      if (shade) doc.rect(50, y, 512, 18).fill('#f9f9f9');

      // Checkbox
      doc.rect(56, y + 3, 12, 12).lineWidth(1).strokeColor('#999').stroke();

      doc.font('Helvetica-Bold').fontSize(10).fillColor('#2e7d32').text(`#${item.invoiceNumber}`, 82, y + 4, { width: 80 });
      doc.font('Helvetica').fontSize(10).fillColor('#1565c0').text(item.drLabel, 167, y + 4, { width: 60 });
      doc.font('Helvetica').fontSize(10).fillColor('#333').text((item.clientName || '').substring(0, 28), 232, y + 4, { width: 180 });
      doc.font('Helvetica').fontSize(9).fillColor('#555').text((item.clientPO || '—').substring(0, 16), 417, y + 4, { width: 90 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(fmtCur(item.total), 500, y + 4, { width: 57, align: 'right' });
      grandTotal += parseFloat(item.total) || 0;
      y += 18;
      doc.moveTo(50, y).lineTo(562, y).lineWidth(0.2).strokeColor('#eee').stroke();
    });

    // Total row
    y += 6;
    doc.moveTo(50, y).lineTo(562, y).lineWidth(1).strokeColor('#333').stroke();
    y += 6;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#333');
    doc.text(`Total — ${items.length} invoices`, 50, y, { width: 400 });
    doc.text(fmtCur(grandTotal), 500, y, { width: 57, align: 'right' });
    y += 24;

    // Instructions note
    doc.moveTo(50, y).lineTo(562, y).lineWidth(0.5).strokeColor('#e0e0e0').stroke();
    y += 10;
    doc.font('Helvetica').fontSize(8.5).fillColor('#888');
    doc.text('Instructions: After importing this batch into QuickBooks, check each invoice against the QB import log. Check the box next to each confirmed entry. Keep this document for your records.', 50, y, { width: 512 });

    doc.end();
  });
}

const IIF_HEADER = [
  '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tTOPRINT\tTERMS\tPONUM\tOTHER1',
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
    const result = await buildInvoiceIIF(wo, wo.parts || [], client, wo.invoiceNumber);
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
      const result = await buildInvoiceIIF(wo, wo.parts || [], client, wo.invoiceNumber);
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
    const result = await buildInvoiceIIF(wo, wo.parts || [], client, wo.invoiceNumber);
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

// POST /api/quickbooks/invoice-numbers/manual - Manually create an invoice number entry
router.post('/invoice-numbers/manual', async (req, res, next) => {
  try {
    const { invoiceNumber, clientName, workOrderId } = req.body;
    if (!invoiceNumber) return res.status(400).json({ error: { message: 'Invoice number is required' } });
    
    const num = parseInt(invoiceNumber);
    if (isNaN(num) || num < 1) return res.status(400).json({ error: { message: 'Invoice number must be a positive number' } });
    
    // Check if already exists
    const existing = await InvoiceNumber.findOne({ where: { invoiceNumber: num } });
    if (existing) return res.status(400).json({ error: { message: `Invoice #${num} already exists` } });
    
    const entry = { invoiceNumber: num, clientName: clientName || null };
    
    // If linking to a work order
    if (workOrderId) {
      const wo = await WorkOrder.findByPk(workOrderId);
      if (wo) {
        entry.workOrderId = wo.id;
        entry.clientId = wo.clientId;
        entry.clientName = wo.clientName;
        await wo.update({ invoiceNumber: String(num) });
      }
    }
    
    const inv = await InvoiceNumber.create(entry);
    
    // Update next number if this one is >= current next
    const setting = await AppSettings.findOne({ where: { key: 'next_invoice_number' } });
    const currentNext = setting?.value || 1001;
    if (num >= currentNext) {
      await AppSettings.upsert({ key: 'next_invoice_number', value: num + 1 });
    }
    
    res.json({ data: inv, message: `Invoice #${num} created` });
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


// POST /api/quickbooks/import-invoice-numbers
// Accepts array of { drNumber, invoiceNumber } pairs parsed from a QuickBooks CSV export.
// Matches each drNumber to a work order and stamps the invoice number on it.
router.post('/import-invoice-numbers', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  try {
    const { pairs } = req.body; // [{ drNumber: '3012', invoiceNumber: '1045' }, ...]
    if (!Array.isArray(pairs) || pairs.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'No pairs provided' } });
    }

    const results = { matched: [], notFound: [], alreadySet: [], errors: [] };

    for (const { drNumber, invoiceNumber, qbName, terms } of pairs) {
      if (!drNumber || !invoiceNumber) continue;
      const drNum = parseInt(String(drNumber).replace(/[^0-9]/g, ''));
      const invNum = parseInt(String(invoiceNumber).replace(/[^0-9]/g, ''));
      if (!drNum || !invNum) continue;

      try {
        const wo = await WorkOrder.findOne({ where: { drNumber: drNum }, transaction });
        if (!wo) {
          results.notFound.push({ drNumber: drNum, invoiceNumber: invNum });
          continue;
        }

        // Skip if already has the same invoice number
        if (wo.invoiceNumber && wo.invoiceNumber === String(invNum)) {
          results.alreadySet.push({ drNumber: drNum, invoiceNumber: invNum, clientName: wo.clientName });
          continue;
        }

        // Create or update InvoiceNumber record
        const existing = await InvoiceNumber.findOne({ where: { invoiceNumber: invNum }, transaction });
        if (!existing) {
          await InvoiceNumber.create({
            invoiceNumber: invNum,
            workOrderId: wo.id,
            clientName: wo.clientName,
            status: 'active'
          }, { transaction });
        } else if (!existing.workOrderId) {
          await existing.update({ workOrderId: wo.id, clientName: wo.clientName }, { transaction });
        }

        // Stamp invoice number on the work order
        await wo.update({
          invoiceNumber: String(invNum),
          invoiceDate: wo.invoiceDate || new Date()
        }, { transaction });

        // If QB name or terms were found and the client is missing them, set them now
        let qbNameSet = null;
        let termsSet = null;
        if ((qbName && qbName.trim()) || (terms && terms.trim())) {
          const client = await Client.findOne({
            where: { name: wo.clientName },
            transaction
          });
          if (client) {
            const updates = {};
            if (qbName && qbName.trim() && !client.quickbooksName) {
              updates.quickbooksName = qbName.trim();
              qbNameSet = qbName.trim();
            }
            if (terms && terms.trim() && !client.paymentTerms) {
              updates.paymentTerms = terms.trim();
              termsSet = terms.trim();
            }
            if (Object.keys(updates).length > 0) {
              await client.update(updates, { transaction });
            }
          }
        }

        results.matched.push({ drNumber: drNum, invoiceNumber: invNum, clientName: wo.clientName, workOrderId: wo.id, qbNameSet, termsSet });
      } catch (rowErr) {
        results.errors.push({ drNumber: drNum, invoiceNumber: invNum, error: rowErr.message });
      }
    }

    await transaction.commit();
    res.json({
      data: results,
      message: `Imported ${results.matched.length} invoice number(s). ${results.notFound.length} DR number(s) not found. ${results.alreadySet.length} already set. ${results.matched.filter(r => r.qbNameSet || r.termsSet).length} client record(s) updated.`
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});


// ==================== INVOICE PDF ====================

// GET /api/quickbooks/invoice-pdf/:id — Generate + download invoice PDF
router.get('/invoice-pdf/:id', async (req, res, next) => {
  try {
    const WOPayment = sequelize.models.WorkOrderPayment;
    const paymentInclude = WOPayment ? [{ model: WOPayment, as: 'payments', where: { voidedAt: null }, required: false, order: [['paymentDate', 'ASC']] }] : [];
    const wo = await WorkOrder.findByPk(req.params.id, {
      include: [
        { model: WorkOrderPart, as: 'parts' },
        ...paymentInclude,
        { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms', 'quickbooksName'] }
      ]
    });
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });

    // Load payments separately as fallback
    let payments = wo.payments || [];
    if (!payments.length && WOPayment) {
      try {
        const pmts = await WOPayment.findAll({ where: { workOrderId: wo.id, voidedAt: null }, order: [['paymentDate','ASC']] });
        payments = pmts.map(p => p.toJSON());
      } catch (e) { console.warn('[invoice-pdf] payments fallback failed:', e.message); }
    }
    if (!wo.invoiceNumber) {
      // Auto-assign if not yet assigned
      const result = await sequelize.transaction(async (t) => {
        const setting = await AppSettings.findOne({ where: { key: 'next_invoice_number' }, transaction: t });
        let nextNum = setting?.value || 1001;
        const highest = await InvoiceNumber.findOne({ order: [['invoiceNumber', 'DESC']], transaction: t });
        if (highest && highest.invoiceNumber >= nextNum) nextNum = highest.invoiceNumber + 1;
        await InvoiceNumber.create({ invoiceNumber: nextNum, workOrderId: wo.id, clientId: wo.clientId, clientName: wo.clientName }, { transaction: t });
        await wo.update({ invoiceNumber: String(nextNum), invoiceDate: new Date() }, { transaction: t });
        await AppSettings.upsert({ key: 'next_invoice_number', value: nextNum + 1 }, { transaction: t });
        return nextNum;
      });
      wo.invoiceNumber = String(result);
      wo.invoiceDate = new Date();
    } else if (!wo.invoiceDate) {
      // Has invoice number but no date — set now
      await wo.update({ invoiceDate: new Date() });
      wo.invoiceDate = new Date();
    }
    const client = await resolveClient(wo);
    const pdfBuffer = await generateInvoicePDFBuffer(wo, wo.parts || [], client, payments);
    const filename = `Invoice-${wo.invoiceNumber}-${(wo.clientName || '').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

    // Upload to storage and save as WO document
    try {
      const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
        folder: `work-orders/${wo.id}/documents`,
        filename,
        mimeType: 'application/pdf'
      });
      console.log('[invoice-pdf] Upload result:', uploadResult?.url);

      // Remove any previous invoice documents
      await WorkOrderDocument.destroy({
        where: { workOrderId: wo.id, documentType: 'invoice' }
      });

      // Save new invoice document
      const doc = await WorkOrderDocument.create({
        workOrderId: wo.id,
        originalName: filename,
        mimeType: 'application/pdf',
        size: pdfBuffer.length,
        url: uploadResult.url,
        cloudinaryId: uploadResult.storageId,
        documentType: 'invoice',
        portalVisible: false
      });
      console.log('[invoice-pdf] Document saved:', doc.id);

      // Update invoice record with PDF url (only if column exists)
      try {
        await InvoiceNumber.update(
          { invoicePdfUrl: uploadResult.url, invoicePdfGenerated: true },
          { where: { workOrderId: wo.id } }
        );
      } catch (invErr) { console.warn('[invoice-pdf] InvoiceNumber update skipped:', invErr.message); }

    } catch (uploadErr) {
      console.error('[invoice-pdf] Upload/save failed:', uploadErr.message, uploadErr.stack);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('[invoice-pdf] Error:', error.message);
    next(error);
  }
});

// POST /api/quickbooks/export-batch-with-reconciliation
// Exports IIF + marks exported + returns reconciliation PDF
router.post('/export-batch-with-reconciliation', async (req, res, next) => {
  try {
    const { workOrderIds } = req.body;
    if (!workOrderIds?.length) return res.status(400).json({ error: { message: 'No work order IDs provided' } });

    const { Op } = require('sequelize');
    const workOrders = await WorkOrder.findAll({
      where: { id: { [Op.in]: workOrderIds } },
      include: [
        { model: WorkOrderPart, as: 'parts' },
        { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms', 'quickbooksName'] }
      ],
      order: [['drNumber', 'ASC']]
    });

    // Assign invoice numbers to any without one
    for (const wo of workOrders) {
      if (!wo.invoiceNumber) {
        const result = await sequelize.transaction(async (t) => {
          const setting = await AppSettings.findOne({ where: { key: 'next_invoice_number' }, transaction: t });
          let nextNum = setting?.value || 1001;
          const highest = await InvoiceNumber.findOne({ order: [['invoiceNumber', 'DESC']], transaction: t });
          if (highest && highest.invoiceNumber >= nextNum) nextNum = highest.invoiceNumber + 1;
          await InvoiceNumber.create({ invoiceNumber: nextNum, workOrderId: wo.id, clientId: wo.clientId, clientName: wo.clientName }, { transaction: t });
          await wo.update({ invoiceNumber: String(nextNum) }, { transaction: t });
          await AppSettings.upsert({ key: 'next_invoice_number', value: nextNum + 1 }, { transaction: t });
          return nextNum;
        });
        wo.invoiceNumber = String(result);
      }
    }

    // Build IIF
    const allLines = [];
    const summaries = [];
    const batchId = `BATCH-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).toUpperCase()}`;
    const exportDate = new Date();

    for (const wo of workOrders) {
      const client = await resolveClient(wo);
      const result = await buildInvoiceIIF(wo, wo.parts || [], client, wo.invoiceNumber);
      if (result) {
        allLines.push(...result.lines);
        summaries.push({
          invoiceNumber: result.summary.invoiceNumber,
          drLabel: result.summary.drNumber,
          clientName: result.summary.clientName,
          clientPO: result.summary.clientPO,
          total: result.summary.total
        });
      }
    }

    if (allLines.length === 0) return res.status(400).json({ error: { message: 'No billable items found' } });

    // Mark all as exported
    await InvoiceNumber.update(
      { iifExportedAt: exportDate, iifBatchId: batchId },
      { where: { workOrderId: { [Op.in]: workOrderIds }, iifExportedAt: null } }
    );

    // Generate reconciliation PDF
    const reconcPdf = await generateReconciliationPDFBuffer(summaries, batchId, exportDate);
    const iifContent = [...IIF_HEADER, ...allLines].join('\r\n') + '\r\n';

    // Return both as JSON with base64 encoded content
    res.json({
      data: {
        batchId,
        invoiceCount: summaries.length,
        iifContent: Buffer.from(iifContent).toString('base64'),
        iifFilename: `quickbooks-batch-${exportDate.toISOString().split('T')[0]}.iif`,
        reconcPdf: reconcPdf.toString('base64'),
        reconcFilename: `reconciliation-${batchId}.pdf`,
        summaries
      }
    });
  } catch (error) {
    console.error('[export-batch-with-reconciliation] Error:', error.message);
    next(error);
  }
});


// ==================== REGEN HELPER (called after payment recorded) ====================
async function regenerateInvoicePDF(workOrderId) {
  const WOPayment = sequelize.models.WorkOrderPayment;
  const wo = await WorkOrder.findByPk(workOrderId, {
    include: [
      { model: WorkOrderPart, as: 'parts' },
      { model: Client, as: 'client', attributes: ['id', 'name', 'taxStatus', 'paymentTerms', 'quickbooksName'] }
    ]
  });
  if (!wo || !wo.invoiceNumber) return;

  // Load payments separately
  let payments = [];
  if (WOPayment) {
    try {
      const pmts = await WOPayment.findAll({ where: { workOrderId, voidedAt: null }, order: [['paymentDate', 'ASC']] });
      payments = pmts.map(p => p.toJSON());
    } catch (e) { console.warn('[regen] payments load skip:', e.message); }
  }

  const client = await resolveClient(wo);
  const pdfBuffer = await generateInvoicePDFBuffer(wo, wo.parts || [], client, payments);
  const filename = `Invoice-${wo.invoiceNumber}-${(wo.clientName || '').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
  const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, { folder: `work-orders/${workOrderId}/documents`, filename, mimeType: 'application/pdf' });
  await WorkOrderDocument.destroy({ where: { workOrderId, documentType: 'invoice' } });
  await WorkOrderDocument.create({ workOrderId, originalName: filename, mimeType: 'application/pdf', size: pdfBuffer.length, url: uploadResult.url, cloudinaryId: uploadResult.storageId, documentType: 'invoice', portalVisible: false });
  await InvoiceNumber.update({ invoicePdfUrl: uploadResult.url, invoicePdfGenerated: true }, { where: { workOrderId } }).catch(() => {});
  return uploadResult.url;
}


// POST /api/quickbooks/invoice-email/:id — Create Gmail draft with invoice attached
router.post('/invoice-email/:id', async (req, res, next) => {
  try {
    const { gmailAccountId, toEmail, subject, body } = req.body;
    if (!gmailAccountId) return res.status(400).json({ error: { message: 'gmailAccountId required' } });

    const wo = await WorkOrder.findByPk(req.params.id, {
      include: [
        { model: WorkOrderPart, as: 'parts' },
        { model: Client, as: 'client', attributes: ['id','name','apEmail','contactEmail','quickbooksName'] }
      ]
    });
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });

    const { GmailAccount } = require('../models');
    const account = await GmailAccount.findByPk(gmailAccountId);
    if (!account) return res.status(400).json({ error: { message: 'Gmail account not found' } });

    const { getGmailClient } = require('../services/emailScanner');
    const gmail = await getGmailClient(account);

    const client = wo.client || {};
    const recipientEmail = toEmail || client.apEmail || client.contactEmail || '';
    if (!recipientEmail) return res.status(400).json({ error: { message: 'No recipient email. Set AP email on client profile.' } });

    const invNum = wo.invoiceNumber ? `#${wo.invoiceNumber}` : '';
    const drLabel = wo.drNumber ? `DR-${wo.drNumber}` : (wo.orderNumber || '');
    const clientPO = wo.clientPurchaseOrderNumber ? ` - PO: ${wo.clientPurchaseOrderNumber}` : '';
    const clientName = client.quickbooksName || client.name || wo.clientName || '';

    const rawSubject = subject || `Invoice ${invNum} - ${clientName}${clientPO}`;
    // RFC 2047 encode subject to handle special characters (em dashes, accents, etc.)
    const emailSubject = `=?UTF-8?B?${Buffer.from(rawSubject).toString('base64')}?=`;

    let boundary = 'crco_boundary_' + Date.now();
    let pdfBase64 = '';
    let pdfFilename = `Invoice-${wo.invoiceNumber || drLabel}-${clientName.replace(/[^a-zA-Z0-9]/g,'_')}.pdf`;

    // Generate PDF fresh in memory — avoids S3 access issues entirely
    try {
      const WOPayment = sequelize.models.WorkOrderPayment;
      let payments = [];
      if (WOPayment) {
        try {
          const pmts = await WOPayment.findAll({ where: { workOrderId: wo.id, voidedAt: null }, order: [['paymentDate','ASC']] });
          payments = pmts.map(p => p.toJSON());
        } catch {}
      }
      const pdfBuffer = await generateInvoicePDFBuffer(wo, wo.parts || [], client, payments);
      const raw = pdfBuffer.toString('base64');
      pdfBase64 = raw.match(/.{1,76}/g).join('\r\n');
      console.log('[invoice-email] PDF generated in memory, size:', pdfBuffer.length);
    } catch (e) {
      console.error('[invoice-email] PDF generation failed:', e.message);
    }

    const bodyText = body || `Dear ${clientName},

Please find attached Invoice ${invNum} for work order ${drLabel}${clientPO}.

${wo.invoiceDate ? `Invoice Date: ${new Date(wo.invoiceDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}

If you have any questions regarding this invoice, please do not hesitate to contact us.

Thank you for your business.

Carolina Rolling Co., Inc.
9152 Sonrisa St., Bellflower, CA 90706
Phone: (562) 633-1044
Email: keepitrolling@carolinarolling.com`;

    let rawMessage;
    if (pdfBase64) {
      rawMessage = [
        `MIME-Version: 1.0`,
        `To: ${recipientEmail}`,
        `Subject: ${emailSubject}`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        bodyText,
        ``,
        `--${boundary}`,
        `Content-Type: application/pdf; name="${pdfFilename}"`,
        `Content-Disposition: attachment; filename="${pdfFilename}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        pdfBase64,
        `--${boundary}--`
      ].join('\r\n');
    } else {
      rawMessage = [
        `MIME-Version: 1.0`,
        `To: ${recipientEmail}`,
        `Subject: ${emailSubject}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        bodyText + '\r\n\r\n(Note: Invoice PDF could not be attached — please attach manually)'
      ].join('\r\n');
    }

    const encodedMessage = Buffer.from(rawMessage).toString('base64url');
    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: encodedMessage } }
    });

    const draftMsgId = draft.data.message?.id || draft.data.id;
    const draftUrl = `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#drafts/${draftMsgId}`;

    // Log the send event
    try {
      const WIS = sequelize.models.WorkOrderInvoiceSend;
      if (WIS) await WIS.create({
        workOrderId: req.params.id,
        sentAt: new Date(),
        sentMethod: 'gmail_draft',
        sentTo: recipientEmail,
        sentFrom: account.email,
        gmailDraftId: draft.data.id,
        recordedBy: req.user?.username || 'admin'
      });
    } catch (e) { console.warn('[invoice-email] log send failed:', e.message); }

    res.json({ data: { draftUrl, draftId: draft.data.id, recipientEmail, subject: emailSubject }, message: 'Draft created' });
  } catch (error) {
    console.error('[invoice-email] Error:', error.message);
    next(error);
  }
});

// GET /api/quickbooks/invoice-sends/:id — Get send history for a WO
router.get('/invoice-sends/:id', async (req, res, next) => {
  try {
    const WIS = sequelize.models.WorkOrderInvoiceSend;
    if (!WIS) return res.json({ data: [] });
    const sends = await WIS.findAll({
      where: { workOrderId: req.params.id },
      order: [['sentAt', 'DESC']]
    });
    res.json({ data: sends });
  } catch (error) { next(error); }
});

// POST /api/quickbooks/invoice-sends/:id — Manually log a send event
router.post('/invoice-sends/:id', async (req, res, next) => {
  try {
    const WIS = sequelize.models.WorkOrderInvoiceSend;
    if (!WIS) return res.status(503).json({ error: { message: 'System initializing' } });
    const { sentAt, sentMethod, sentTo, sentFrom, notes } = req.body;
    const send = await WIS.create({
      workOrderId: req.params.id,
      sentAt: sentAt ? new Date(sentAt) : new Date(),
      sentMethod: sentMethod || 'manual',
      sentTo: sentTo || null,
      sentFrom: sentFrom || null,
      notes: notes || null,
      recordedBy: req.user?.username || 'admin'
    });
    res.json({ data: send, message: 'Send event logged' });
  } catch (error) { next(error); }
});


// PUT /api/quickbooks/invoice-number/:id — Update invoice number with uniqueness check
router.put('/invoice-number/:id', async (req, res, next) => {
  try {
    const { invoiceNumber } = req.body;
    const newNum = String(invoiceNumber).trim();
    if (!newNum) return res.status(400).json({ error: { message: 'Invoice number required' } });

    const wo = await WorkOrder.findByPk(req.params.id);
    if (!wo) return res.status(404).json({ error: { message: 'Work order not found' } });

    if (wo.invoiceNumber === newNum) return res.json({ data: wo.toJSON(), message: 'No change' });

    // Check uniqueness — scan both WorkOrder and InvoiceNumber tables
    const existingWO = await WorkOrder.findOne({ where: { invoiceNumber: newNum } });
    if (existingWO && existingWO.id !== wo.id) {
      const drRef = existingWO.drNumber ? `DR-${existingWO.drNumber}` : existingWO.orderNumber;
      return res.status(409).json({ error: { message: `Invoice #${newNum} is already assigned to ${drRef} (${existingWO.clientName})` } });
    }

    const existingInv = await InvoiceNumber.findOne({ where: { invoiceNumber: parseInt(newNum) || 0 } });
    if (existingInv && existingInv.workOrderId !== wo.id) {
      const refWO = await WorkOrder.findByPk(existingInv.workOrderId, { attributes: ['drNumber','orderNumber','clientName'] });
      const drRef = refWO?.drNumber ? `DR-${refWO.drNumber}` : refWO?.orderNumber;
      return res.status(409).json({ error: { message: `Invoice #${newNum} is already in use${drRef ? ` on ${drRef}` : ''}` } });
    }

    // Update WO invoice number
    const oldNum = wo.invoiceNumber;
    await wo.update({ invoiceNumber: newNum });

    // Update InvoiceNumber record if exists
    await InvoiceNumber.update(
      { invoiceNumber: parseInt(newNum) || newNum },
      { where: { workOrderId: wo.id } }
    );

    res.json({ data: wo.toJSON(), message: `Invoice number changed from #${oldNum || '?'} to #${newNum}` });
  } catch (error) { next(error); }
});

module.exports = router;
module.exports.regenerateInvoicePDF = regenerateInvoicePDF;
