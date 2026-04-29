const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const fileStorage = require('../utils/storage');
const { Op } = require('sequelize');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const { WorkOrder, WorkOrderPart, WorkOrderPartFile, WorkOrderDocument, DailyActivity, DRNumber, InboundOrder, PONumber, AppSettings, Estimate, EstimatePart, Vendor, Client, Shipment, ShipmentPhoto, sequelize } = require('../models');

const router = express.Router();

// Fetch a URL following redirects (up to 5 hops), returns response stream or null
function fetchWithRedirects(url, maxRedirects = 5, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && maxRedirects > 0) {
        resp.resume();
        fetchWithRedirects(resp.headers.location, maxRedirects - 1, timeoutMs).then(resolve);
      } else if (resp.statusCode === 200) {
        resolve(resp);
      } else {
        console.log(`[doc-proxy] HTTP ${resp.statusCode} for ${url.substring(0, 100)}`);
        resp.resume();
        resolve(null);
      }
    });
    req.on('error', (e) => { console.log(`[doc-proxy] fetch error: ${e.message}`); resolve(null); });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

// Helper to clean numeric fields - convert empty strings to null
function cleanNumericFields(data, fields) {
  const cleaned = { ...data };
  fields.forEach(field => {
    if (cleaned[field] === '' || cleaned[field] === undefined) {
      cleaned[field] = null;
    } else if (cleaned[field] !== null) {
      const num = parseFloat(cleaned[field]);
      cleaned[field] = isNaN(num) ? null : num;
    }
  });
  return cleaned;
}

// Extract underscore-prefixed fields from part data into formData JSONB
function extractFormData(data) {
  const formData = {};
  const cleaned = {};
  const excludeFromFormData = ['_vendorSearch', '_shapeFile'];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) {
      if (!excludeFromFormData.includes(key)) {
        formData[key] = value;
      }
    } else {
      cleaned[key] = value;
    }
  }
  if (Object.keys(formData).length > 0) {
    cleaned.formData = formData;
  }
  return cleaned;
}

// Merge formData back into part object for API response
function mergeFormData(part) {
  const obj = part.toJSON ? part.toJSON() : { ...part };
  if (obj.formData && typeof obj.formData === 'object') {
    Object.assign(obj, obj.formData);
  }
  return obj;
}

/**
 * Rebuild derived text fields from raw database columns.
 * This ensures consumers (Android, print, PDF) always get correct data
 * even if the cached _rollingDescription or _materialDescription in formData is stale.
 * Does NOT modify the database — only enriches the API response.
 */
function refreshDerivedFields(part) {
  // === Rolling Description: rebuild direction from rollType ===
  if (part._rollingDescription && part.rollType) {
    let dir = '';
    if (part.partType === 'tee_bar') {
      dir = part.rollType === 'easy_way' ? 'SO' : part.rollType === 'on_edge' ? 'SU' : 'SI';
    } else {
      dir = part.rollType === 'easy_way' ? 'EW' : part.rollType === 'on_edge' ? 'OE' : 'HW';
    }
    const allDirs = ['EW', 'HW', 'OE', 'SO', 'SI', 'SU'];
    const dirRegex = new RegExp('\\b(' + allDirs.join('|') + ')\\b', 'g');
    const matches = part._rollingDescription.match(dirRegex);
    if (matches && matches.length > 0 && !matches.includes(dir)) {
      part._rollingDescription = part._rollingDescription.replace(dirRegex, dir);
    }
  }
  
  // === Fallback: build rolling description if missing but raw fields exist ===
  if (!part._rollingDescription && !part._rollToMethod) {
    const rollVal = part.diameter || part.radius;
    if (rollVal) {
      const mp = part._rollMeasurePoint || 'inside';
      const isRad = !!part.radius && !part.diameter;
      const spec = mp === 'inside' ? (isRad ? 'ISR' : 'ID') : mp === 'outside' ? (isRad ? 'OSR' : 'OD') : (isRad ? 'CLR' : 'CLD');
      let dir = '';
      if (part.rollType) {
        if (part.partType === 'tee_bar') {
          dir = part.rollType === 'easy_way' ? ' SO' : part.rollType === 'on_edge' ? ' SU' : ' SI';
        } else {
          dir = part.rollType === 'easy_way' ? ' EW' : part.rollType === 'on_edge' ? ' OE' : ' HW';
        }
      }
      let line = `Roll to ${rollVal}" ${spec}${dir}`;
      if (part.arcDegrees) line += ` | Arc: ${part.arcDegrees}°`;
      part._rollingDescription = line;
    }
  }
  
  // === Material Description: rebuild if missing but raw fields exist ===
  if (!part._materialDescription && !part.materialDescription) {
    const specs = [];
    if (part.thickness) specs.push(part.thickness);
    if (part.width) specs.push(`x ${part.width}"`);
    if (part.length) specs.push(`x ${part.length}"`);
    if (part.sectionSize) specs.push(part.sectionSize);
    if (part.outerDiameter) specs.push(`${part.outerDiameter}" OD`);
    if (part.wallThickness && part.wallThickness !== 'SOLID') specs.push(`x ${part.wallThickness} wall`);
    if (part.material) specs.push(part.material);
    if (specs.length > 0) {
      const desc = `${part.quantity || 1}pc: ${specs.join(' ')}`;
      part._materialDescription = desc;
      part.materialDescription = desc;
    }
  }
  
  // === Promote clientPartNumber and heatNumber from formData if top-level is empty ===
  if (!part.clientPartNumber && part.formData?.clientPartNumber) {
    part.clientPartNumber = part.formData.clientPartNumber;
  }
  if (!part.heatNumber && part.formData?.heatNumber) {
    part.heatNumber = part.formData.heatNumber;
  }
  
  return part;
}

// Helper function to generate Purchase Order PDF
async function generatePurchaseOrderPDF(poNumber, supplier, parts, workOrder) {
  const PDFDocument = require('pdfkit');
  
  return new Promise((resolve, reject) => {
    try {
      const PART_LABELS = {
        plate_roll: 'Plate Roll', angle_roll: 'Angle Roll', pipe_roll: 'Pipes / Tubes / Round',
        tube_roll: 'Square & Rect Tube Roll', channel_roll: 'Channel Roll', beam_roll: 'Beam Roll',
        flat_bar: 'Flat Bar Roll', flat_stock: 'Flat Stock', cone_roll: 'Cone Roll',
        tee_bar: 'Tee Bar Roll', press_brake: 'Press Brake', fab_service: 'Fabrication Service',
        shop_rate: 'Shop Rate', shaped_plate: 'Shaped Plate', rush_service: 'Rush / Emergency Service', other: 'Other'
      };
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      const W = 512; // usable width (612 - 100 margins)
      const L = 50;  // left margin
      const R = L + W; // right edge
      
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      
      // ─── TOP BORDER ───
      doc.rect(L, 40, W, 4).fill('#1565c0');
      
      // ─── HEADER: Company + PO Title ───
      const headerY = 52;
      
      // Company name & info (left)
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1565c0').text('CAROLINA ROLLING COMPANY INC.', L, headerY);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text('9152 Sonrisa St, Bellflower, CA 90706', L, headerY + 18);
      doc.text('Phone: (562) 633-1044  •  Email: keepitrolling@carolinarolling.com', L, headerY + 28);
      
      // PO label + number (right)
      doc.fontSize(24).font('Helvetica-Bold').fillColor('#1565c0').text('PURCHASE ORDER', L, headerY, { width: W, align: 'right' });
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#333').text(poNumber, L, headerY + 28, { width: W, align: 'right' });
      
      // ─── DIVIDER ───
      doc.moveTo(L, headerY + 46).lineTo(R, headerY + 46).strokeColor('#ccc').lineWidth(1).stroke();
      
      // ─── INFO BOXES ───
      const boxY = headerY + 56;
      const boxH = 70;
      const halfW = (W - 16) / 2;
      
      // TO box (left)
      doc.rect(L, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(L, boxY, halfW, 16).fill('#f0f0f0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#666').text('VENDOR', L + 8, boxY + 4);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(supplier, L + 8, boxY + 22, { width: halfW - 16 });
      
      // SHIP TO box (right)
      const boxX2 = L + halfW + 16;
      doc.rect(boxX2, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(boxX2, boxY, halfW, 16).fill('#f0f0f0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#666').text('SHIP TO', boxX2 + 8, boxY + 4);
      doc.fontSize(9).font('Helvetica').fillColor('#000');
      doc.text('Carolina Rolling Company Inc.', boxX2 + 8, boxY + 22, { width: halfW - 16 });
      doc.text('9152 Sonrisa St', boxX2 + 8, boxY + 34);
      doc.text('Bellflower, CA 90706', boxX2 + 8, boxY + 46);
      
      // ─── PO DETAILS ROW ───
      const detY = boxY + boxH + 12;
      
      // Collect vendor estimate numbers from parts
      const vendorEstNums = [...new Set(parts.map(p => {
        const obj = p.toJSON ? p.toJSON() : { ...p };
        if (obj.formData) Object.assign(obj, obj.formData);
        return obj.vendorEstimateNumber;
      }).filter(Boolean))];
      
      const detFields = [
        ['PO DATE', new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })],
        ['WORK ORDER', workOrder.drNumber ? `DR-${workOrder.drNumber}` : (workOrder.orderNumber || '-')]
      ];
      if (vendorEstNums.length > 0) {
        detFields.push(['VENDOR QUOTE #', vendorEstNums.join(', ')]);
      }
      const colW = W / detFields.length;
      
      detFields.forEach(([label, value], i) => {
        const x = L + (i * colW);
        doc.rect(x, detY, colW, 32).lineWidth(0.5).strokeColor('#ddd').stroke();
        doc.rect(x, detY, colW, 14).fill('#f5f5f5');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#888').text(label, x + 6, detY + 3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(value, x + 6, detY + 17, { width: colW - 12 });
      });
      
      // ─── ITEMS TABLE ───
      const tableY = detY + 46;
      const cols = { item: L, qty: L + 40, desc: L + 80, cutFile: L + 360 };
      const colWidths = { item: 40, qty: 40, desc: 280, cutFile: W - 360 };
      
      // Table header
      doc.rect(L, tableY, W, 18).fill('#1565c0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
      doc.text('ITEM', cols.item + 6, tableY + 5);
      doc.text('QTY', cols.qty + 6, tableY + 5);
      doc.text('DESCRIPTION', cols.desc + 6, tableY + 5);
      doc.text('CUT FILE', cols.cutFile + 6, tableY + 5);
      
      // Table rows
      let rowY = tableY + 18;
      doc.font('Helvetica').fillColor('#000');
      
      const sortedAll = [...parts].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
      // Group services under parent parts
      const mergedAll = sortedAll.map(p => {
        const o = p.toJSON ? p.toJSON() : { ...p };
        if (o.formData && typeof o.formData === 'object') Object.assign(o, o.formData);
        return o;
      });
      const regParts = mergedAll.filter(p => !['fab_service', 'shop_rate'].includes(p.partType) || !p._linkedPartId);
      const svcParts = mergedAll.filter(p => ['fab_service', 'shop_rate'].includes(p.partType) && p._linkedPartId);
      const sortedParts = [];
      const usedSvc = new Set();
      regParts.forEach(rp => {
        sortedParts.push(rp);
        svcParts.forEach(sp => {
          if (String(sp._linkedPartId) === String(rp.id) && !usedSvc.has(sp.id)) { sortedParts.push(sp); usedSvc.add(sp.id); }
        });
      });
      svcParts.forEach(sp => { if (!usedSvc.has(sp.id)) sortedParts.push(sp); });
      
      sortedParts.forEach((partObj, index) => {
        
        let desc = partObj._materialDescription || partObj.materialDescription || '';
        // For cones, rebuild from fields to avoid stale/garbled data
        if (partObj.partType === 'cone_roll') {
          const thk = partObj.thickness || '';
          const ldType = (partObj._coneLargeDiaType || 'inside') === 'inside' ? 'ID' : (partObj._coneLargeDiaType === 'outside' ? 'OD' : 'CLD');
          const sdType = (partObj._coneSmallDiaType || 'inside') === 'inside' ? 'ID' : (partObj._coneSmallDiaType === 'outside' ? 'OD' : 'CLD');
          const ld = parseFloat(partObj._coneLargeDia) || 0;
          const sd = parseFloat(partObj._coneSmallDia) || 0;
          const vh = parseFloat(partObj._coneHeight) || 0;
          const grade = partObj.material || '';
          const origin = partObj._materialOrigin || '';
          desc = (thk ? thk + ' ' : '') + 'Cone - ';
          if (ld && sd && vh) desc += ld.toFixed(1) + '" ' + ldType + ' x ' + sd.toFixed(1) + '" ' + sdType + ' x ' + vh.toFixed(1) + '" VH';
          if (grade) desc += ' ' + grade;
          if (origin) desc += ' ' + origin;
        }
        if (!desc) {
          const pieces = [];
          if (partObj.sectionSize) {
            const sizeDisplay = partObj.partType === 'pipe_roll' && partObj._schedule ? partObj.sectionSize.replace(' Pipe', ` Sch ${partObj._schedule} Pipe`) : partObj.sectionSize;
            pieces.push(sizeDisplay);
          }
          if (partObj.thickness) pieces.push(partObj.thickness);
          if (partObj.width) pieces.push(`x ${partObj.width}"`);
          if (partObj.length) pieces.push(`x ${partObj.length}`);
          if (partObj.outerDiameter) pieces.push(`${partObj.outerDiameter}" OD`);
          if (partObj.wallThickness && partObj.wallThickness !== 'SOLID') pieces.push(`x ${partObj.wallThickness} wall`);
          if (partObj.wallThickness === 'SOLID') pieces.push('Solid');
          if (partObj.material) pieces.push(partObj.material);
          if (partObj.partType) pieces.push(PART_LABELS[partObj.partType] || partObj.partType.replace(/_/g, ' '));
          desc = pieces.join(' ') || 'N/A';
        }
        partObj._poDesc = desc;
        partObj._poQty = partObj._stockLengthsNeeded || partObj.quantity || 1;
      });

      // Merge identical materials into single PO lines
      // Build material key from description (strip qty prefix) for mergeable part types
      const MERGEABLE_TYPES = ['pipe_roll', 'tube_roll', 'flat_bar', 'channel_roll', 'beam_roll', 'tee_bar', 'angle_roll'];
      const mergedLines = [];
      const mergeMap = new Map();
      
      sortedParts.forEach(partObj => {
        if (!MERGEABLE_TYPES.includes(partObj.partType)) {
          mergedLines.push(partObj);
          return;
        }
        // Build key from material description without qty prefix
        const matKey = (partObj._poDesc || '').replace(/^\d+\s*[×x]\s*\d+['"]\s*length\(s\):\s*/i, '').replace(/^\d+pc:\s*/i, '').trim().toLowerCase();
        if (!matKey) { mergedLines.push(partObj); return; }
        
        if (mergeMap.has(matKey)) {
          const existing = mergeMap.get(matKey);
          existing._poQty += (partObj._poQty || 1);
          existing._mergedPartNumbers.push(partObj.partNumber);
          // Collect all cut files
          if (partObj.cutFileReference && !existing._mergedCutFiles.includes(partObj.cutFileReference)) {
            existing._mergedCutFiles.push(partObj.cutFileReference);
          }
        } else {
          partObj._mergedPartNumbers = [partObj.partNumber];
          partObj._mergedCutFiles = partObj.cutFileReference ? [partObj.cutFileReference] : [];
          mergeMap.set(matKey, partObj);
          mergedLines.push(partObj);
        }
      });

      mergedLines.forEach((partObj, index) => {
        const desc = partObj._poDesc || 'N/A';
        const cleanDesc = desc.replace(/^\d+\s*[×x]\s*\d+['"]\s*length\(s\):\s*/i, '').replace(/^\d+pc:\s*/i, '');
        const cutFile = partObj._mergedCutFiles ? partObj._mergedCutFiles.join(', ') : (partObj.cutFileReference || '');
        
        // Calculate row height based on description length
        const descHeight = doc.heightOfString(cleanDesc, { width: colWidths.desc - 12 });
        const rowHeight = Math.max(28, descHeight + 12);
        
        // Page break check
        if (rowY + rowHeight > 700) {
          doc.addPage();
          rowY = 50;
          // Repeat header on new page
          doc.rect(L, rowY, W, 18).fill('#1565c0');
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
          doc.text('ITEM', cols.item + 6, rowY + 5);
          doc.text('QTY', cols.qty + 6, rowY + 5);
          doc.text('DESCRIPTION', cols.desc + 6, rowY + 5);
          doc.text('CUT FILE', cols.cutFile + 6, rowY + 5);
          rowY += 18;
          doc.font('Helvetica').fillColor('#000');
        }
        
        // Alternating row background
        if (index % 2 === 0) {
          doc.rect(L, rowY, W, rowHeight).fill('#f8f9fa');
        }
        
        // Row border
        doc.moveTo(L, rowY + rowHeight).lineTo(R, rowY + rowHeight).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
        
        doc.fillColor('#000');
        // Show merged part numbers or single part number
        const itemLabel = partObj._mergedPartNumbers && partObj._mergedPartNumbers.length > 1 
          ? partObj._mergedPartNumbers.join(',') 
          : `${partObj.partNumber || index + 1}`;
        doc.fontSize(partObj._mergedPartNumbers?.length > 3 ? 7 : 9).font('Helvetica-Bold').text(itemLabel, cols.item + 4, rowY + 6, { width: colWidths.item - 8 });
        
        // Use merged qty for combined lines
        const poQty = partObj._poQty || partObj._stockLengthsNeeded || partObj.quantity || 1;
        doc.fontSize(9).font('Helvetica').text(`${poQty}`, cols.qty + 6, rowY + 6, { width: colWidths.qty - 12 });
        doc.fontSize(8.5).text(cleanDesc, cols.desc + 6, rowY + 6, { width: colWidths.desc - 12 });
        
        if (cutFile) {
          doc.fontSize(8).fillColor('#1565c0').font('Helvetica-Bold').text(cutFile, cols.cutFile + 6, rowY + 6, { width: colWidths.cutFile - 12 });
          doc.fillColor('#000').font('Helvetica');
        }
        
        rowY += rowHeight;
      });
      
      // Table bottom border
      doc.moveTo(L, rowY).lineTo(R, rowY).strokeColor('#1565c0').lineWidth(1.5).stroke();
      
      // ─── NOTES / TERMS ───
      // Check if notes section fits on current page (~140px needed)
      const notesNeeded = 130;
      if (rowY + 20 + notesNeeded > 720) {
        doc.addPage();
        rowY = 50;
      }
      
      const notesY = rowY + 20;
      
      // MTR requirement box
      doc.rect(L, notesY, W, 36).lineWidth(1.5).strokeColor('#c62828').stroke();
      doc.rect(L, notesY, W, 14).fill('#ffebee');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#c62828').text('⚠ IMPORTANT', L + 8, notesY + 3);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#c62828');
      doc.text('Material Test Reports (MTRs) are required with all shipments.', L + 8, notesY + 18);
      
      // General notes
      const notesY2 = notesY + 46;
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#333').text('TERMS & INSTRUCTIONS:', L, notesY2);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text(`• Please reference ${poNumber} on all correspondence, packing lists, and invoices.`, L + 8, notesY2 + 14);
      doc.text(`• Material is for: ${workOrder.drNumber ? 'DR-' + workOrder.drNumber : workOrder.orderNumber}`, L + 8, notesY2 + 26);
      doc.text('• Notify us immediately of any delays or backorders.', L + 8, notesY2 + 38);
      
      // Any parts with cut files — add a prominent note
      let lastNoteY = notesY2 + 38;
      const partsWithCutFiles = sortedParts.filter(p => {
        const obj = p.toJSON ? p.toJSON() : { ...p };
        if (obj.formData) Object.assign(obj, obj.formData);
        return obj.cutFileReference;
      });
      if (partsWithCutFiles.length > 0) {
        lastNoteY = notesY2 + 50;
        doc.text('• Cut files referenced above will be sent separately via email.', L + 8, lastNoteY);
      }
      
      // ─── FOOTER — positioned right after notes ───
      const footY = lastNoteY + 24;
      doc.moveTo(L, footY).lineTo(R, footY).strokeColor('#ccc').lineWidth(0.5).stroke();
      doc.fontSize(7).font('Helvetica').fillColor('#999');
      doc.text(`Carolina Rolling Company Inc.  •  ${poNumber}  •  Generated ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}`, L, footY + 6, { width: W, align: 'center' });
      
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Generate Outside Processing PO PDF
async function generateOutsideProcessingPO(poNumber, vendor, parts, workOrder, serviceType, notes, expectedReturn, transportCost, expediteCost, vendorSuppliesMaterial) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      const W = 512;
      const L = 50;
      const R = L + W;
      
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Top border (orange for outside processing)
      doc.rect(L, 40, W, 4).fill('#E65100');

      // Header
      const headerY = 52;
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#E65100').text('CAROLINA ROLLING COMPANY INC.', L, headerY);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text('9152 Sonrisa St, Bellflower, CA 90706', L, headerY + 18);
      doc.text('Phone: (562) 633-1044  •  Email: keepitrolling@carolinarolling.com', L, headerY + 28);

      doc.fontSize(20).font('Helvetica-Bold').fillColor('#E65100').text('OUTSIDE PROCESSING PO', L, headerY, { width: W, align: 'right' });
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#333').text(poNumber, L, headerY + 28, { width: W, align: 'right' });

      doc.moveTo(L, headerY + 46).lineTo(R, headerY + 46).strokeColor('#ccc').lineWidth(1).stroke();

      // Info boxes
      const boxY = headerY + 56;
      const boxH = 80;
      const halfW = (W - 16) / 2;

      // VENDOR box
      doc.rect(L, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(L, boxY, halfW, 16).fill('#FFF3E0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#E65100').text('OUTSIDE VENDOR', L + 8, boxY + 4);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(vendor.name || '', L + 8, boxY + 22, { width: halfW - 16 });
      if (vendor.contactName) doc.fontSize(8).font('Helvetica').text(`Attn: ${vendor.contactName}`, L + 8, boxY + 38);
      if (vendor.address) doc.fontSize(8).text(vendor.address, L + 8, boxY + 50, { width: halfW - 16 });

      // SERVICE box
      const boxX2 = L + halfW + 16;
      doc.rect(boxX2, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(boxX2, boxY, halfW, 16).fill('#FFF3E0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#E65100').text('SERVICE REQUESTED', boxX2 + 8, boxY + 4);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000').text(serviceType || 'Outside Processing', boxX2 + 8, boxY + 22, { width: halfW - 16 });
      if (expectedReturn) {
        doc.fontSize(8).font('Helvetica').fillColor('#666').text('EXPECTED RETURN', boxX2 + 8, boxY + 50);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(new Date(expectedReturn).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }), boxX2 + 8, boxY + 62);
      }

      // PO details row
      const detY = boxY + boxH + 12;
      const detFields = [
        ['PO DATE', new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })],
        ['WORK ORDER', workOrder.drNumber ? `DR-${workOrder.drNumber}` : (workOrder.orderNumber || '-')],
        ['CLIENT', workOrder.clientName || '-']
      ];
      const colW = W / detFields.length;
      detFields.forEach(([label, value], i) => {
        const x = L + (i * colW);
        doc.rect(x, detY, colW, 32).lineWidth(0.5).strokeColor('#ddd').stroke();
        doc.rect(x, detY, colW, 14).fill('#f5f5f5');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#888').text(label, x + 6, detY + 3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(value, x + 6, detY + 17, { width: colW - 12 });
      });

      // Items table
      const tableY = detY + 46;
      const cols = { item: L, qty: L + 50, desc: L + 95, cost: L + 380 };
      const colWidths = { item: 50, qty: 45, desc: 285, cost: W - 380 };

      doc.rect(L, tableY, W, 18).fill('#E65100');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
      doc.text('PART #', cols.item + 6, tableY + 5);
      doc.text('QTY', cols.qty + 6, tableY + 5);
      doc.text('DESCRIPTION', cols.desc + 6, tableY + 5);
      doc.text('UNIT COST', cols.cost + 6, tableY + 5);

      let rowY = tableY + 18;
      doc.font('Helvetica').fillColor('#000');
      let totalCost = 0;

      parts.forEach((p, index) => {
        const partObj = p.toJSON ? p.toJSON() : { ...p };
        if (partObj.formData && typeof partObj.formData === 'object') Object.assign(partObj, partObj.formData);
        const qty = parseInt(partObj.quantity) || 1;
        const desc = partObj._materialDescription || partObj.materialDescription || `Part #${partObj.partNumber}`;
        const cleanDesc = desc.replace(/^\d+pc:\s*/i, '');
        const unitCost = parseFloat(partObj.outsideProcessingCost) || 0;
        const lineCost = unitCost * qty;
        totalCost += lineCost;

        const descHeight = doc.heightOfString(cleanDesc, { width: colWidths.desc - 12 });
        const rowHeight = Math.max(28, descHeight + 12);

        if (rowY + rowHeight > 700) {
          doc.addPage();
          rowY = 50;
        }

        if (index % 2 === 0) doc.rect(L, rowY, W, rowHeight).fill('#FFF8E1');
        doc.moveTo(L, rowY + rowHeight).lineTo(R, rowY + rowHeight).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
        
        doc.fillColor('#000');
        doc.fontSize(9).font('Helvetica-Bold').text(`${partObj.partNumber}`, cols.item + 6, rowY + 6);
        doc.font('Helvetica').text(`${qty}`, cols.qty + 6, rowY + 6);
        doc.fontSize(8.5).text(cleanDesc, cols.desc + 6, rowY + 6, { width: colWidths.desc - 12 });
        doc.fontSize(9).text(`$${unitCost.toFixed(2)}`, cols.cost + 6, rowY + 6);
        rowY += rowHeight;
      });

      doc.moveTo(L, rowY).lineTo(R, rowY).strokeColor('#E65100').lineWidth(1.5).stroke();

      // Subtotals + Total
      rowY += 8;
      const ec = parseFloat(expediteCost) || 0;
      const grandTotal = totalCost + ec;

      const totalsX = L + W - 220;
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      doc.text(`Parts Subtotal:`, totalsX, rowY, { width: 130, align: 'right' });
      doc.text(`$${totalCost.toFixed(2)}`, totalsX + 130, rowY, { width: 80, align: 'right' });
      rowY += 14;

      if (ec > 0) {
        doc.fillColor('#c62828').font('Helvetica-Bold');
        doc.text(`🚨 EXPEDITE FEE:`, totalsX, rowY, { width: 130, align: 'right' });
        doc.text(`$${ec.toFixed(2)}`, totalsX + 130, rowY, { width: 80, align: 'right' });
        rowY += 14;
        doc.fillColor('#000').font('Helvetica');
      }

      doc.rect(totalsX, rowY, 220, 24).fill('#FFF3E0');
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#E65100');
      doc.text(`TOTAL:`, totalsX + 6, rowY + 7, { width: 124, align: 'right' });
      doc.text(`$${grandTotal.toFixed(2)}`, totalsX + 130, rowY + 7, { width: 84, align: 'right' });
      rowY += 32;

      // Notes / instructions
      if (rowY + 100 > 720) { doc.addPage(); rowY = 50; }

      // Important box
      doc.rect(L, rowY, W, 36).lineWidth(1.5).strokeColor('#c62828').stroke();
      doc.rect(L, rowY, W, 14).fill('#ffebee');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#c62828').text('⚠ IMPORTANT', L + 8, rowY + 3);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#c62828');
      doc.text(`Reference ${poNumber} on all packing slips and invoices.`, L + 8, rowY + 18);
      rowY += 46;

      doc.fontSize(8).font('Helvetica-Bold').fillColor('#333').text('TERMS & INSTRUCTIONS:', L, rowY);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text(`• Material is for: ${workOrder.drNumber ? 'DR-' + workOrder.drNumber : workOrder.orderNumber}`, L + 8, rowY + 14);
      doc.text('• Notify us immediately of any delays.', L + 8, rowY + 26);
      doc.text('• Return material with packing slip and signed copy of this PO.', L + 8, rowY + 38);
      if (notes) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#333').text('NOTES:', L, rowY + 58);
        doc.fontSize(8).font('Helvetica').fillColor('#444').text(notes, L + 8, rowY + 70, { width: W - 16 });
      }

      // Material supply banner — always show, stating who supplies material.
      // If vendorSuppliesMaterial is true, explicitly request MTRs. Always request protective film on finished parts.
      const bannerY = rowY + (notes ? 100 : 60);
      const vendorSupplies = !!vendorSuppliesMaterial;
      const bannerBg = vendorSupplies ? '#FFF3E0' : '#E3F2FD';
      const bannerStroke = vendorSupplies ? '#E65100' : '#1565C0';
      const bannerTextColor = vendorSupplies ? '#E65100' : '#0D47A1';
      const supplierName = vendorSupplies ? (vendor.name || 'Vendor') : 'Carolina Rolling';
      const headline = vendorSupplies
        ? `⚠ ${supplierName.toUpperCase()} TO SUPPLY MATERIAL`
        : `MATERIAL SUPPLIED BY: ${supplierName.toUpperCase()}`;
      const bodyLines = vendorSupplies
        ? [
            `${vendor.name || 'Vendor'} is responsible for sourcing the material for all parts on this PO.`,
            `• Please include MTRs (Material Test Reports) with shipment.`,
            `• If parts are finished, please apply protective film before return shipment.`
          ]
        : [
            `Carolina Rolling will supply the material. Parts will be delivered to ${vendor.name || 'vendor'} for processing.`,
            `• If parts are finished, please apply protective film before return shipment.`
          ];
      const bannerH = 18 + (bodyLines.length * 12) + 8;
      doc.rect(L, bannerY, W, bannerH).fill(bannerBg).strokeColor(bannerStroke).lineWidth(1.5).stroke();
      doc.fontSize(10).font('Helvetica-Bold').fillColor(bannerTextColor).text(headline, L + 8, bannerY + 6);
      doc.fontSize(8).font('Helvetica').fillColor('#333');
      bodyLines.forEach((line, i) => {
        doc.text(line, L + 8, bannerY + 22 + (i * 12), { width: W - 16 });
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Helper to log activity for daily email
async function logActivity(type, resourceType, resourceId, resourceNumber, clientName, description, details = {}) {
  try {
    await DailyActivity.create({
      activityType: type,
      resourceType,
      resourceId,
      resourceNumber,
      clientName,
      description,
      details
    });
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}

// Generate Trucking PO PDF (for outside processing transport)
async function generateTruckingPO(poNumber, vendor, trip, workOrder, allocatedParts) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      const W = 512;
      const L = 50;
      const R = L + W;

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Top border (blue for trucking)
      doc.rect(L, 40, W, 4).fill('#1565C0');

      // Header
      const headerY = 52;
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1565C0').text('CAROLINA ROLLING COMPANY INC.', L, headerY);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text('9152 Sonrisa St, Bellflower, CA 90706', L, headerY + 18);
      doc.text('Phone: (562) 633-1044  •  Email: keepitrolling@carolinarolling.com', L, headerY + 28);

      doc.fontSize(20).font('Helvetica-Bold').fillColor('#1565C0').text('TRUCKING PO', L, headerY, { width: W, align: 'right' });
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#333').text(poNumber, L, headerY + 28, { width: W, align: 'right' });

      doc.moveTo(L, headerY + 46).lineTo(R, headerY + 46).strokeColor('#ccc').lineWidth(1).stroke();

      // Info boxes
      const boxY = headerY + 56;
      const boxH = 80;
      const halfW = (W - 16) / 2;

      // TRUCKING VENDOR box
      doc.rect(L, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(L, boxY, halfW, 16).fill('#E3F2FD');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1565C0').text('TRUCKING VENDOR', L + 8, boxY + 4);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(vendor.name || '', L + 8, boxY + 22, { width: halfW - 16 });
      if (vendor.contactName) doc.fontSize(8).font('Helvetica').text(`Attn: ${vendor.contactName}`, L + 8, boxY + 38);
      if (vendor.address) doc.fontSize(8).text(vendor.address, L + 8, boxY + 50, { width: halfW - 16 });

      // SERVICE box
      const boxX2 = L + halfW + 16;
      doc.rect(boxX2, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(boxX2, boxY, halfW, 16).fill('#E3F2FD');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1565C0').text('TRANSPORT TYPE', boxX2 + 8, boxY + 4);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000').text(`${trip.leg} Trip`, boxX2 + 8, boxY + 22);
      doc.fontSize(8).font('Helvetica').fillColor('#666').text(
        trip.leg === 'Outbound' ? 'From Carolina Rolling to outside processor' : 'From outside processor back to Carolina Rolling',
        boxX2 + 8, boxY + 40, { width: halfW - 16 }
      );

      // PO details row
      const detY = boxY + boxH + 12;
      const detFields = [
        ['PO DATE', new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })],
        ['WORK ORDER', workOrder.drNumber ? `DR-${workOrder.drNumber}` : (workOrder.orderNumber || '-')],
        ['CLIENT', workOrder.clientName || '-']
      ];
      const colW = W / detFields.length;
      detFields.forEach(([label, value], i) => {
        const x = L + (i * colW);
        doc.rect(x, detY, colW, 32).lineWidth(0.5).strokeColor('#ddd').stroke();
        doc.rect(x, detY, colW, 14).fill('#f5f5f5');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#888').text(label, x + 6, detY + 3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(value, x + 6, detY + 17, { width: colW - 12 });
      });

      // Materials being transported
      let rowY = detY + 46;
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#333').text('MATERIAL BEING TRANSPORTED:', L, rowY);
      rowY += 14;

      doc.rect(L, rowY, W, 18).fill('#1565C0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
      doc.text('PART #', L + 8, rowY + 5);
      doc.text('QTY', L + 80, rowY + 5);
      doc.text('DESCRIPTION', L + 130, rowY + 5);
      rowY += 18;

      doc.font('Helvetica').fillColor('#000');
      (allocatedParts || []).forEach((p, idx) => {
        if (idx % 2 === 0) doc.rect(L, rowY, W, 22).fill('#F5F5F5');
        const partObj = p.toJSON ? p.toJSON() : { ...p };
        if (partObj.formData && typeof partObj.formData === 'object') Object.assign(partObj, partObj.formData);
        const desc = (partObj._materialDescription || partObj.materialDescription || `Part #${partObj.partNumber}`).replace(/^\d+pc:\s*/i, '');
        doc.fillColor('#000').fontSize(9).font('Helvetica-Bold').text(`#${partObj.partNumber}`, L + 8, rowY + 6);
        doc.font('Helvetica').text(`${partObj.quantity || 1}`, L + 80, rowY + 6);
        doc.fontSize(8.5).text(desc, L + 130, rowY + 6, { width: W - 138 });
        rowY += 22;
      });

      doc.moveTo(L, rowY).lineTo(R, rowY).strokeColor('#1565C0').lineWidth(1.5).stroke();

      // Total
      rowY += 12;
      const cost = parseFloat(trip.cost) || 0;
      doc.rect(L + W - 220, rowY, 220, 24).fill('#E3F2FD');
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1565C0');
      doc.text(`TOTAL:`, L + W - 214, rowY + 7, { width: 124, align: 'right' });
      doc.text(`$${cost.toFixed(2)}`, L + W - 90, rowY + 7, { width: 84, align: 'right' });
      rowY += 32;

      // Important box
      if (rowY + 80 > 720) { doc.addPage(); rowY = 50; }
      doc.rect(L, rowY, W, 36).lineWidth(1.5).strokeColor('#c62828').stroke();
      doc.rect(L, rowY, W, 14).fill('#ffebee');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#c62828').text('⚠ IMPORTANT', L + 8, rowY + 3);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#c62828');
      doc.text(`Reference ${poNumber} on all paperwork and invoices.`, L + 8, rowY + 18);
      rowY += 46;

      if (trip.notes) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#333').text('NOTES:', L, rowY);
        doc.fontSize(8).font('Helvetica').fillColor('#444').text(trip.notes, L + 8, rowY + 12, { width: W - 16 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Temp uploads directory for multer
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB for STEP files
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/stp',
      'application/step',
      'model/step',
      'application/octet-stream', // STEP files often come as this
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'application/dxf', 'image/vnd.dxf', 'image/x-dxf',
      'application/acad', 'image/vnd.dwg',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    const allowedExtensions = ['.pdf', '.stp', '.step', '.dxf', '.dwg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, STEP, DXF, DWG, images, Word docs.'));
    }
  }
});

// Clean up temp file
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error cleaning up temp file:', error);
  }
}

// Generate unique work order number
function generateOrderNumber() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `WO-${year}${month}${day}-${random}`;
}

// Auto-archive any shipments linked to a work order when it's shipped
async function archiveLinkedShipments(workOrderId) {
  try {
    const shipments = await Shipment.findAll({ where: { workOrderId } });
    for (const shipment of shipments) {
      if (shipment.status !== 'archived' && shipment.status !== 'shipped') {
        await shipment.update({ status: 'archived' });
        console.log(`[auto-archive] Shipment ${shipment.id} archived (WO ${workOrderId} shipped)`);
      }
    }
  } catch (err) {
    console.error('[auto-archive] Failed to archive shipments:', err.message);
  }
}

// GET /api/workorders - Get all work orders
router.get('/', async (req, res, next) => {
  try {
    const { status, clientName, clientId, archived, drNumber, search, limit = 50, offset = 0, view } = req.query;
    
    const where = {};
    
    // If searching, search across ALL statuses (including shipped/archived)
    if (search) {
      const searchLower = `%${search}%`;
      where[Op.or] = [
        { clientName: { [Op.iLike]: searchLower } },
        { orderNumber: { [Op.iLike]: searchLower } },
        { clientPurchaseOrderNumber: { [Op.iLike]: searchLower } },
        { contactName: { [Op.iLike]: searchLower } },
        { estimateNumber: { [Op.iLike]: searchLower } },
        { notes: { [Op.iLike]: searchLower } }
      ];
      // Also try numeric DR search
      const drParsed = parseInt(search.replace(/^dr-?/i, ''));
      if (!isNaN(drParsed)) {
        where[Op.or].push({ drNumber: drParsed });
      }
    } else {
    // By default, exclude archived/shipped/picked_up unless specifically requested
    if (archived === 'true') {
      where.status = { [Op.in]: ['archived', 'shipped'] };
    } else if (archived === 'only') {
      where.status = 'archived';
    } else if (status) {
      where.status = status;
    } else {
      where.status = { [Op.notIn]: ['archived', 'shipped'] };
    }
    
    if (clientId) where.clientId = clientId;
    else if (clientName) where.clientName = { [Op.iLike]: `%${clientName}%` };
    if (drNumber) where.drNumber = parseInt(drNumber);
    }

    // API key client scoping — force filter to the key's allowed client
    if (req.apiKey && req.apiKey.clientName) {
      where.clientName = { [Op.iLike]: `%${req.apiKey.clientName}%` };
      // Portal: if no explicit status/archived param, show all
      if (!status && !archived) {
        delete where.status;
      }
    }

    // For list views, skip file includes to speed up query significantly
    const partInclude = view === 'list' 
      ? [{ model: WorkOrderPart, as: 'parts', attributes: ['id', 'partNumber', 'partType', 'quantity', 'status', 'materialSource', 'materialOrdered', 'supplierName', 'vendorEstimateNumber', 'clientPartNumber', 'heatNumber', 'heatBreakdown', 'materialDescription', 'formData'] }]
      : [{ model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }];

    const workOrders = await WorkOrder.findAndCountAll({
      where,
      include: partInclude,
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      distinct: true
    });

    // Batch fetch shipment photos for all work orders in this page
    const workOrderIds = workOrders.rows.map(wo => wo.id);
    let shipmentPhotoMap = {};
    try {
      const shipments = await Shipment.findAll({
        where: { workOrderId: { [Op.in]: workOrderIds } },
        include: [{ model: ShipmentPhoto, as: 'photos' }]
      });
      shipments.forEach(s => {
        if (s.photos && s.photos.length > 0) {
          shipmentPhotoMap[s.workOrderId] = s.photos[0].url;
        }
      });
    } catch (e) {
      console.error('Error fetching shipment photos for thumbnails:', e);
    }

    // Generate thumbnail URLs for inventory grid
    const rowsWithThumbnails = workOrders.rows.map(wo => {
      const data = wo.toJSON();
      data.thumbnailUrl = null;

      // Enrich parts with refreshed derived fields
      if (data.parts) {
        data.parts = data.parts.map(p => {
          if (p.formData && typeof p.formData === 'object') {
            Object.assign(p, p.formData);
          }
          return refreshDerivedFields(p);
        });
      }

      // Priority 1: Shipment photos (public Cloudinary URLs — work directly)
      if (shipmentPhotoMap[data.id]) {
        data.thumbnailUrl = shipmentPhotoMap[data.id];
      }

      return data;
    });

    res.json({
      data: rowsWithThumbnails,
      total: workOrders.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/recently-completed - Orders completed from shop floor in last 48h
router.get('/recently-completed', async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const orders = await WorkOrder.findAll({
      where: {
        completedAt: { [Op.gte]: cutoff },
        status: { [Op.in]: ['stored', 'shipped', 'archived'] }
      },
      include: [{ model: WorkOrderPart, as: 'parts' }],
      order: [['completedAt', 'DESC']],
      limit: 20
    });
    res.json({ data: orders });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/lookup-dr/:drNumber - Diagnostic: find work order by DR number across all statuses
router.get('/lookup-dr/:drNumber', async (req, res, next) => {
  try {
    const drNum = parseInt(req.params.drNumber);
    if (isNaN(drNum)) {
      return res.status(400).json({ error: { message: 'Invalid DR number' } });
    }

    // Check DR numbers table
    const drRecord = await DRNumber.findOne({ where: { drNumber: drNum } });
    
    // Check work orders table directly
    const workOrder = await WorkOrder.findOne({
      where: { drNumber: drNum },
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    
    // Check shipments linked to this WO
    let shipments = [];
    if (workOrder) {
      shipments = await Shipment.findAll({
        where: { workOrderId: workOrder.id },
        attributes: ['id', 'clientName', 'location', 'status', 'workOrderId', 'createdAt']
      });
    }

    res.json({
      data: {
        drNumber: drNum,
        drRecord: drRecord ? drRecord.toJSON() : null,
        workOrder: workOrder ? {
          id: workOrder.id,
          orderNumber: workOrder.orderNumber,
          drNumber: workOrder.drNumber,
          clientName: workOrder.clientName,
          status: workOrder.status,
          priority: workOrder.priority,
          partsCount: workOrder.parts?.length || 0,
          createdAt: workOrder.createdAt,
          updatedAt: workOrder.updatedAt
        } : null,
        shipments,
        found: !!workOrder
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/invoicing/queue - WOs ready for invoicing (MUST be before /:id)
router.get('/invoicing/queue', async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    const workOrders = await WorkOrder.findAll({
      where: {
        status: { [Op.in]: ['stored', 'shipped', 'completed'] },
        [Op.or]: [
          { invoiceNumber: null },
          { invoiceNumber: '' }
        ],
        [Op.and]: [
          { [Op.or]: [{ invoiceSkipped: null }, { invoiceSkipped: false }] },
          { [Op.or]: [{ isVoided: null }, { isVoided: false }] }
        ]
      },
      include: [{ model: WorkOrderPart, as: 'parts', attributes: ['id', 'partNumber', 'partType', 'partTotal', 'quantity'] }],
      order: [['completedAt', 'ASC'], ['createdAt', 'ASC']]
    });
    res.json({ data: workOrders });
  } catch (error) { next(error); }
});

// GET /api/workorders/invoicing/history - Invoiced WOs (MUST be before /:id)
router.get('/invoicing/history', async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    const workOrders = await WorkOrder.findAll({
      where: {
        invoiceNumber: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
        [Op.or]: [{ isVoided: null }, { isVoided: false }]
      },
      include: [{ model: WorkOrderPart, as: 'parts', attributes: ['id', 'partNumber', 'partType', 'partTotal', 'quantity'] }],
      order: [['invoiceDate', 'DESC']],
      limit: 100
    });
    res.json({ data: workOrders });
  } catch (error) { next(error); }
});

// GET /api/workorders/invoicing/skipped - WOs marked as not invoiced (MUST be before /:id)
router.get('/invoicing/skipped', async (req, res, next) => {
  try {
    const workOrders = await WorkOrder.findAll({
      where: { 
        invoiceSkipped: true,
        [Op.or]: [{ isVoided: null }, { isVoided: false }]
      },
      include: [{ model: WorkOrderPart, as: 'parts', attributes: ['id', 'partNumber', 'partType', 'partTotal', 'quantity'] }],
      order: [['invoiceSkippedAt', 'DESC']]
    });
    res.json({ data: workOrders });
  } catch (error) { next(error); }
});

// GET /api/workorders/:id - Get work order by ID
router.get('/:id', async (req, res, next) => {
  try {
    // Support both UUID and orderNumber
    const idParam = req.params.id;
    let workOrder;
    
    // Check if it's a UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(idParam)) {
      workOrder = await WorkOrder.findByPk(idParam, {
        include: [
          {
            model: WorkOrderPart,
            as: 'parts',
            include: [
              { model: WorkOrderPartFile, as: 'files' },
              { model: Vendor, as: 'vendor', attributes: ['id', 'name', 'contactName', 'contactPhone', 'contactEmail'] }
            ],
            order: [['partNumber', 'ASC']]
          },
          {
            model: WorkOrderDocument,
            as: 'documents'
          }
        ]
      });
    } else {
      // Try to find by orderNumber or drNumber
      workOrder = await WorkOrder.findOne({
        where: idParam.startsWith('DR-') 
          ? { drNumber: parseInt(idParam.replace('DR-', '')) }
          : { orderNumber: idParam },
        include: [
          {
            model: WorkOrderPart,
            as: 'parts',
            include: [
              { model: WorkOrderPartFile, as: 'files' },
              { model: Vendor, as: 'vendor', attributes: ['id', 'name', 'contactName', 'contactPhone', 'contactEmail'] }
            ],
            order: [['partNumber', 'ASC']]
          },
          {
            model: WorkOrderDocument,
            as: 'documents'
          }
        ]
      });
    }

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // API key client scoping — deny access if key is scoped to a different client
    if (req.apiKey && req.apiKey.clientName) {
      if (!workOrder.clientName || !workOrder.clientName.toLowerCase().includes(req.apiKey.clientName.toLowerCase())) {
        return res.status(403).json({ error: { message: 'Access denied — API key does not have access to this work order' } });
      }
    }

    // Rewrite file URLs to use download proxy (handles resource_type mismatches transparently)
    const woJson = workOrder.toJSON();
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Attach linked shipment data (location, photos) — supports multiple shipments
    try {
      const linkedShipments = await Shipment.findAll({
        where: { workOrderId: woJson.id },
        include: [{ model: ShipmentPhoto, as: 'photos' }],
        order: [['createdAt', 'DESC']]
      });
      // Primary shipment (first one) for backwards compat
      if (linkedShipments.length > 0) {
        const primary = linkedShipments[0];
        woJson.shipment = {
          id: primary.id,
          location: primary.location,
          status: primary.status,
          description: primary.description,
          receivedAt: primary.receivedAt,
          photos: (primary.photos || []).map(p => ({
            id: p.id,
            url: p.url,
            caption: p.caption
          }))
        };
      }
      // All shipments
      woJson.shipments = linkedShipments.map(s => ({
        id: s.id,
        location: s.location,
        status: s.status,
        description: s.description,
        receivedAt: s.receivedAt,
        photos: (s.photos || []).map(p => ({ id: p.id, url: p.url, caption: p.caption }))
      }));
    } catch (e) {
      console.error('Error fetching shipments for WO detail:', e);
    }

    if (woJson.parts) {
      for (const part of woJson.parts) {
        if (part.files) {
          for (const file of part.files) {
            const isS3 = (file.cloudinaryId && file.cloudinaryId.startsWith('s3:')) || (file.url && file.url.includes('amazonaws.com'));
            if (!isS3) {
              file.url = `${baseUrl}/api/workorders/${woJson.id}/parts/${part.id}/files/${file.id}/download`;
            }
          }
        }
        // Merge formData then refresh derived text fields from raw columns
        if (part.formData && typeof part.formData === 'object') {
          Object.assign(part, part.formData);
        }
        refreshDerivedFields(part);
      }
    }
    // Rewrite document URLs to use download proxy (skip S3)
    if (woJson.documents) {
      for (const doc of woJson.documents) {
        const isS3 = (doc.cloudinaryId && doc.cloudinaryId.startsWith('s3:')) || (doc.url && doc.url.includes('amazonaws.com'));
        if (!isS3) {
          doc.url = `${baseUrl}/api/workorders/${woJson.id}/documents/${doc.id}/download`;
        }
      }
    }

    // Lookup client flags
    try {
      if (woJson.clientName) {
        const clientRecord = await Client.findOne({ where: { name: { [Op.iLike]: woJson.clientName.trim() }, isActive: true } });
        if (clientRecord) {
          woJson.requiresPartLabels = clientRecord.requiresPartLabels === true;
        }
      }
    } catch (e) { /* ignore client lookup failure */ }

    // Attach vendor issues (from vendor portal reports)
    try {
      const { VendorIssue } = require('../models');
      const issues = await VendorIssue.findAll({
        where: { workOrderId: woJson.id },
        include: [{ model: WorkOrderPart, as: 'workOrderPart', attributes: ['id', 'partNumber', 'clientPartNumber'] }],
        order: [['reportedAt', 'DESC']]
      });
      woJson.vendorIssues = issues.map(i => i.toJSON());
    } catch (e) {
      console.error('[wo GET] Failed to load vendor issues:', e.message);
      woJson.vendorIssues = [];
    }

    res.json({ data: woJson });
  } catch (error) {
    next(error);
  }
});

// POST /api/workorders - Create new work order
router.post('/', async (req, res, next) => {
  try {
    const {
      clientName,
      clientId,
      clientPO,
      clientPurchaseOrderNumber,
      jobNumber,
      contactName,
      contactPhone,
      contactEmail,
      contactExtension,
      projectDescription,
      notes,
      storageLocation,
      receivedBy,
      requestedDueDate,
      promisedDate,
      status = 'received',
      shipmentIds = [],
      assignDRNumber = false,
      customDRNumber = null
    } = req.body;

    if (!clientName && !clientId) {
      return res.status(400).json({ error: { message: 'Client is required' } });
    }

    // Resolve client name from clientId if needed
    let resolvedClientName = clientName;
    let resolvedClientId = clientId || null;
    let resolvedClient = null;
    if (resolvedClientId && !resolvedClientName) {
      resolvedClient = await Client.findByPk(resolvedClientId);
      if (resolvedClient) resolvedClientName = resolvedClient.name;
    } else if (resolvedClientId) {
      resolvedClient = await Client.findByPk(resolvedClientId);
    }

    // Determine tax rate: client-specific > admin default
    let effectiveTaxRate = null;
    if (resolvedClient?.customTaxRate) {
      effectiveTaxRate = parseFloat(resolvedClient.customTaxRate) * 100; // stored as decimal, convert to %
    }
    if (!effectiveTaxRate) {
      try {
        const taxSetting = await AppSettings.findOne({ where: { key: 'tax_settings' } });
        effectiveTaxRate = taxSetting?.value?.defaultTaxRate || 9.75;
      } catch (e) { effectiveTaxRate = 9.75; }
    }

    const orderNumber = generateOrderNumber();

    // Start transaction
    const transaction = await sequelize.transaction();
    
    try {
      // Create work order
      const workOrder = await WorkOrder.create({
        orderNumber,
        clientId: resolvedClientId,
        clientName: resolvedClientName,
        clientPurchaseOrderNumber: clientPO || clientPurchaseOrderNumber,
        jobNumber,
        contactName,
        contactPhone,
        contactEmail,
        contactExtension: contactExtension || null,
        projectDescription,
        notes,
        storageLocation,
        receivedBy,
        receivedAt: new Date(),
        requestedDueDate: requestedDueDate || null,
        promisedDate: promisedDate || null,
        status,
        taxRate: effectiveTaxRate,
        allMaterialReceived: true
      }, { transaction });

      // Assign DR number if requested
      let drNumber = null;
      if (customDRNumber) {
        // Use custom DR number — do NOT advance the sequence
        drNumber = parseInt(customDRNumber);
        // Check if custom DR is already used
        const existingDR = await DRNumber.findOne({ where: { drNumber }, transaction });
        const existingWO = await WorkOrder.findOne({ where: { drNumber, id: { [Op.ne]: workOrder.id } }, transaction });
        if (existingDR || existingWO) {
          await transaction.rollback();
          return res.status(400).json({ error: { message: `DR-${drNumber} is already in use` } });
        }
        await workOrder.update({ drNumber }, { transaction });
        await DRNumber.create({
          drNumber,
          workOrderId: workOrder.id,
          clientName: resolvedClientName,
          assignedAt: new Date(),
          assignedBy: req.user?.username || 'system'
        }, { transaction });
      } else if (assignDRNumber) {
        // Check admin setting for next DR number first
        const drSetting = await AppSettings.findOne({ where: { key: 'next_dr_number' }, transaction });
        
        if (drSetting?.value?.nextNumber) {
          drNumber = drSetting.value.nextNumber;
          await drSetting.update({ value: { nextNumber: drNumber + 1 } }, { transaction });
        } else {
          // Fallback: get max from both tables
          const maxDR = await DRNumber.findOne({
            order: [['drNumber', 'DESC']],
            transaction
          });
          drNumber = (maxDR?.drNumber || 0) + 1;
          
          const maxWODR = await WorkOrder.max('drNumber', { transaction });
          if (maxWODR && maxWODR >= drNumber) {
            drNumber = maxWODR + 1;
          }
        }

        // Update work order with DR number
        await workOrder.update({ drNumber }, { transaction });

        // Record DR number assignment
        await DRNumber.create({
          drNumber,
          workOrderId: workOrder.id,
          clientName,
          assignedAt: new Date(),
          assignedBy: req.user?.username || 'system'
        }, { transaction });

        // Log activity
        await logActivity(
          'dr_assigned',
          'work_order',
          workOrder.id,
          `DR-${drNumber}`,
          clientName,
          `DR number assigned to new work order`,
          { orderNumber }
        );
      }

      // Link shipments if provided
      if (shipmentIds && shipmentIds.length > 0) {
        const { Shipment } = require('../models');
        await Shipment.update(
          { workOrderId: workOrder.id },
          { 
            where: { id: shipmentIds },
            transaction
          }
        );
      }

      await transaction.commit();

      // Reload with associations
      const createdOrder = await WorkOrder.findByPk(workOrder.id, {
        include: [{
          model: WorkOrderPart,
          as: 'parts',
          include: [{
            model: WorkOrderPartFile,
            as: 'files'
          }]
        }]
      });

      res.status(201).json({
        data: createdOrder,
        message: drNumber 
          ? `Work order created with DR-${drNumber}`
          : 'Work order created successfully'
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/workorders/:id - Update work order
// PUT /api/workorders/:id/status - Quick status update (shop floor)
router.put('/:id/status', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: { message: 'Status is required' } });
    }
    await workOrder.update({ status });
    res.json({ data: workOrder, message: `Status updated to ${status}` });
  } catch (error) {
    next(error);
  }
});

// POST /api/workorders/:id/record-payment - Record COD payment
router.post('/:id/record-payment', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    const { paymentDate, paymentMethod, paymentReference } = req.body;
    if (!paymentMethod) return res.status(400).json({ error: { message: 'Payment method is required' } });
    
    await workOrder.update({
      codPaid: true,
      paymentDate: paymentDate || new Date(),
      paymentMethod,
      paymentReference: paymentReference || null,
      paymentRecordedBy: req.user?.username || 'Unknown'
    });
    
    res.json({ data: workOrder, message: 'Payment recorded' });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/clear-payment - Clear payment record (admin)
router.post('/:id/clear-payment', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    await workOrder.update({
      codPaid: false,
      paymentDate: null,
      paymentMethod: null,
      paymentReference: null,
      paymentRecordedBy: null
    });
    
    res.json({ data: workOrder, message: 'Payment record cleared' });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/invoice - Record invoice for a work order
router.post('/:id/invoice', upload.single('invoicePdf'), async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    const { invoiceNumber, invoiceDate } = req.body;
    if (!invoiceNumber) return res.status(400).json({ error: { message: 'Invoice number is required' } });
    
    const updates = {
      invoiceNumber,
      invoiceDate: invoiceDate || new Date(),
      invoicedBy: req.user?.username || 'Unknown'
    };

    // Upload PDF if provided
    if (req.file) {
      const fileStorage = require('../utils/storage');
      const result = await fileStorage.uploadFile(req.file.path, {
        filename: `invoice-${invoiceNumber}-${workOrder.drNumber || workOrder.id}.pdf`,
        folder: 'invoices',
        contentType: 'application/pdf'
      });
      updates.invoicePdfUrl = result.url;
      updates.invoicePdfCloudinaryId = result.publicId;
      try { require('fs').unlinkSync(req.file.path); } catch(e) {}
    }

    await workOrder.update(updates);
    
    const updated = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts', attributes: ['id', 'partNumber', 'partType', 'partTotal', 'quantity'] }]
    });
    res.json({ data: updated, message: 'Invoice recorded' });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/invoice-pdf - Upload/replace invoice PDF only
router.post('/:id/invoice-pdf', upload.single('invoicePdf'), async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    if (!req.file) return res.status(400).json({ error: { message: 'No PDF file provided' } });

    // Delete old PDF if exists
    if (workOrder.invoicePdfCloudinaryId) {
      try {
        const fileStorage = require('../utils/storage');
        await fileStorage.destroy(workOrder.invoicePdfCloudinaryId);
      } catch (e) { console.warn('Could not delete old invoice PDF:', e.message); }
    }

    const fileStorage = require('../utils/storage');
    const result = await fileStorage.uploadFile(req.file.path, {
      filename: `invoice-${workOrder.invoiceNumber || 'draft'}-${workOrder.drNumber || workOrder.id}.pdf`,
      folder: 'invoices',
      contentType: 'application/pdf'
    });
    try { require('fs').unlinkSync(req.file.path); } catch(e) {}

    await workOrder.update({ invoicePdfUrl: result.url, invoicePdfCloudinaryId: result.publicId });
    res.json({ data: workOrder, message: 'Invoice PDF uploaded' });
  } catch (error) { next(error); }
});

// DELETE /api/workorders/:id/invoice - Clear invoice from a work order
router.delete('/:id/invoice', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    // Delete PDF if exists
    if (workOrder.invoicePdfCloudinaryId) {
      try {
        const fileStorage = require('../utils/storage');
        await fileStorage.destroy(workOrder.invoicePdfCloudinaryId);
      } catch (e) { console.warn('Could not delete invoice PDF:', e.message); }
    }

    await workOrder.update({
      invoiceNumber: null, invoiceDate: null, invoicedBy: null,
      invoicePdfUrl: null, invoicePdfCloudinaryId: null
    });
    res.json({ data: workOrder, message: 'Invoice cleared' });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/skip-invoice - Mark WO as not needing an invoice
router.post('/:id/skip-invoice', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    await workOrder.update({
      invoiceSkipped: true,
      invoiceSkipReason: req.body.reason || null,
      invoiceSkippedBy: req.user?.username || 'Unknown',
      invoiceSkippedAt: new Date()
    });
    res.json({ data: workOrder, message: 'Marked as not invoiced' });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/restore-invoice - Move back to invoice queue
router.post('/:id/restore-invoice', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    await workOrder.update({
      invoiceSkipped: false,
      invoiceSkipReason: null,
      invoiceSkippedBy: null,
      invoiceSkippedAt: null
    });
    res.json({ data: workOrder, message: 'Restored to invoice queue' });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/mark-invoice-sent - Record that invoice was sent (date + PDF)
router.post('/:id/mark-invoice-sent', upload.single('invoicePdf'), async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    
    const updates = {
      invoiceDate: req.body.invoiceDate ? new Date(req.body.invoiceDate + 'T12:00:00') : new Date(),
      invoicedBy: req.user?.username || 'Unknown'
    };
    
    if (req.file) {
      const fileStorage = require('../utils/storage');
      const result = await fileStorage.uploadFile(req.file.path, {
        filename: `invoice-${workOrder.invoiceNumber || 'draft'}-${workOrder.drNumber || workOrder.id}.pdf`,
        folder: 'invoices',
        contentType: 'application/pdf'
      });
      updates.invoicePdfUrl = result.url;
      updates.invoicePdfCloudinaryId = result.publicId;
      try { require('fs').unlinkSync(req.file.path); } catch(e) {}
    }
    
    await workOrder.update(updates);
    res.json({ data: workOrder, message: 'Invoice marked as sent' });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/email-invoice - Email invoice to client's AP email
router.post('/:id/email-invoice', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });
    if (!workOrder.invoiceNumber) return res.status(400).json({ error: { message: 'No invoice recorded for this work order' } });

    // Find client AP email
    const client = workOrder.clientId ? await Client.findByPk(workOrder.clientId) : null;
    const recipientEmail = req.body.email || client?.apEmail || client?.contactEmail;
    if (!recipientEmail) {
      return res.status(400).json({ error: { message: 'No email address found. Set the client\'s AP Email in Clients & Vendors, or provide an email.' } });
    }

    const drLabel = workOrder.drNumber ? 'DR-' + workOrder.drNumber : (workOrder.orderNumber || 'N/A');
    const shopName = 'Carolina Rolling Co. Inc.';
    const invoiceDate = workOrder.invoiceDate ? new Date(workOrder.invoiceDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'N/A';
    
    // Calculate total
    const partsTotal = (workOrder.parts || []).reduce((sum, p) => sum + (parseFloat(p.partTotal) || 0), 0);
    const trucking = parseFloat(workOrder.truckingCost) || 0;
    const subtotal = partsTotal + trucking;
    const taxAmt = parseFloat(workOrder.taxAmount) || 0;
    const total = subtotal + taxAmt;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#1565C0;border-bottom:2px solid #1565C0;padding-bottom:8px">Invoice ${workOrder.invoiceNumber}</h2>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;font-weight:bold;color:#555;width:140px">From:</td><td style="padding:8px">${shopName}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;color:#555">Invoice #:</td><td style="padding:8px;font-weight:bold;font-size:1.1em">${workOrder.invoiceNumber}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;color:#555">Date:</td><td style="padding:8px">${invoiceDate}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;color:#555">Work Order:</td><td style="padding:8px">${drLabel}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;color:#555">Amount:</td><td style="padding:8px;font-weight:bold;font-size:1.1em;color:#1565C0">$${total.toFixed(2)}</td></tr>
          ${workOrder.paymentTerms ? `<tr><td style="padding:8px;font-weight:bold;color:#555">Terms:</td><td style="padding:8px">${workOrder.paymentTerms}</td></tr>` : ''}
        </table>
        ${workOrder.invoicePdfUrl ? '<p style="color:#666">Invoice PDF is attached.</p>' : '<p style="color:#999">No PDF attached. Please contact us if you need a copy.</p>'}
        <p style="color:#888;font-size:0.85em;margin-top:24px">This invoice was sent from ${shopName}. If you have questions, please reply to this email.</p>
      </div>
    `;

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipientEmail,
      subject: `Invoice ${workOrder.invoiceNumber} — ${drLabel} — ${shopName}`,
      html,
      attachments: []
    };

    // Attach PDF if available
    if (workOrder.invoicePdfUrl) {
      try {
        const pdfUrl = workOrder.invoicePdfUrl;
        const isHttps = pdfUrl.startsWith('https');
        const httpMod = isHttps ? require('https') : require('http');
        const pdfBuffer = await new Promise((resolve, reject) => {
          const fetchUrl = (url, redirects = 0) => {
            if (redirects > 5) { reject(new Error('Too many redirects')); return; }
            httpMod.get(url, (resp) => {
              if ([301, 302, 307].includes(resp.statusCode) && resp.headers.location) {
                resp.resume();
                fetchUrl(resp.headers.location, redirects + 1);
                return;
              }
              const chunks = [];
              resp.on('data', c => chunks.push(c));
              resp.on('end', () => resolve(Buffer.concat(chunks)));
              resp.on('error', reject);
            }).on('error', reject);
          };
          fetchUrl(pdfUrl);
        });
        mailOptions.attachments.push({
          filename: `Invoice-${workOrder.invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        });
      } catch (e) {
        console.warn('[email-invoice] Could not attach PDF:', e.message);
      }
    }

    await transporter.sendMail(mailOptions);
    console.log(`[email-invoice] Invoice ${workOrder.invoiceNumber} sent to ${recipientEmail}`);
    res.json({ data: { sentTo: recipientEmail }, message: `Invoice emailed to ${recipientEmail}` });
  } catch (error) {
    console.error('[email-invoice] Failed:', error.message);
    next(error);
  }
});

// POST /api/workorders/:id/mark-complete - Shop floor marks order complete
router.post('/:id/mark-complete', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }
    
    // Verify all parts are completed
    const incompleteParts = workOrder.parts.filter(p => p.status !== 'completed');
    if (incompleteParts.length > 0) {
      return res.status(400).json({ 
        error: { message: `${incompleteParts.length} part(s) not yet completed` }
      });
    }
    
    // Add completion note with timestamp
    const now = new Date();
    const completionNote = `✅ All ${workOrder.parts.length} part(s) completed from shop floor — ${now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })} ${now.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })}`;
    const updatedNotes = workOrder.notes 
      ? `${workOrder.notes}\n\n${completionNote}` 
      : completionNote;
    
    await workOrder.update({ 
      status: 'stored',
      completedAt: now,
      notes: updatedNotes
    });
    
    res.json({ data: workOrder, message: 'Order marked complete and moved to Stored' });
  } catch (error) {
    next(error);
  }
});

// POST /:id/pickup - Record a pickup (full or partial)
router.post('/:id/pickup', async (req, res, next) => {
  try {
    const { type, pickedUpBy, items } = req.body; // type: 'full' | 'partial', items: [{ partId, partNumber, description, quantity }]
    
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }]
    });
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const now = new Date().toISOString();
    const history = workOrder.pickupHistory || [];
    
    if (type === 'full') {
      // Full pickup: pick up all REMAINING parts (accounting for previous pickups)
      const totalPickedByPart = {};
      history.forEach(entry => {
        (entry.items || []).forEach(item => {
          const key = item.partId || item.partNumber;
          totalPickedByPart[key] = (totalPickedByPart[key] || 0) + (item.quantity || 0);
        });
      });

      const pickupItems = workOrder.parts
        .map(p => {
          const totalQty = p.quantity || 1;
          const alreadyPicked = (totalPickedByPart[p.id] || 0) + (totalPickedByPart[p.partNumber] || 0);
          const remaining = Math.max(0, totalQty - alreadyPicked);
          const fd = p.formData && typeof p.formData === 'object' ? p.formData : {};
          return {
            partId: p.id,
            partNumber: p.partNumber,
            partType: p.partType,
            clientPartNumber: p.clientPartNumber || '',
            description: fd._materialDescription || p.materialDescription || p.sectionSize || p.partType,
            rollingDescription: fd._rollingDescription || p.rollingDescription || '',
            quantity: remaining
          };
        })
        .filter(p => p.quantity > 0);
      
      if (pickupItems.length === 0) {
        return res.status(400).json({ error: { message: 'All items have already been picked up' } });
      }

      history.push({
        date: now,
        pickedUpBy: pickedUpBy || 'unknown',
        type: 'full',
        items: pickupItems
      });
      
      workOrder.pickupHistory = JSON.parse(JSON.stringify(history));
      workOrder.status = 'shipped';
      workOrder.pickedUpAt = now;
      workOrder.pickedUpBy = pickedUpBy || 'unknown';
      workOrder.changed('pickupHistory', true);
      await workOrder.save();
    } else {
      // Partial pickup: only selected items
      if (!items || items.length === 0) {
        return res.status(400).json({ error: { message: 'No items selected for partial pickup' } });
      }
      
      history.push({
        date: now,
        pickedUpBy: pickedUpBy || 'unknown',
        type: 'partial',
        items: items
      });

      // Calculate total picked up across all history entries for each part
      const totalPickedByPart = {};
      history.forEach(entry => {
        (entry.items || []).forEach(item => {
          const key = item.partId || item.partNumber;
          totalPickedByPart[key] = (totalPickedByPart[key] || 0) + (item.quantity || 0);
        });
      });

      // Check if everything has been picked up
      const allPickedUp = workOrder.parts.every(p => {
        const picked = (totalPickedByPart[p.id] || 0) + (totalPickedByPart[p.partNumber] || 0);
        return picked >= (p.quantity || 1);
      });

      workOrder.pickupHistory = JSON.parse(JSON.stringify(history));
      if (allPickedUp) {
        workOrder.status = 'shipped';
        workOrder.pickedUpAt = now;
        workOrder.pickedUpBy = pickedUpBy || 'unknown';
      }
      workOrder.changed('pickupHistory', true);
      await workOrder.save();
    }
    
    // Reload and return
    await workOrder.reload({ include: [{ model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }] });
    

    // Auto-archive linked shipments if order is now shipped
    if (workOrder.status === 'shipped') {
      await archiveLinkedShipments(workOrder.id);
    }
    
    res.json({ data: workOrder.toJSON(), message: type === 'full' ? 'Full pickup recorded' : 'Partial pickup recorded' });
  } catch (error) {
    next(error);
  }
});

// GET /:id/pickup/:index/receipt - Generate pickup receipt PDF on demand
router.get('/:id/pickup/:index/receipt', async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const workOrder = await WorkOrder.findByPk(req.params.id, { include: [{ model: WorkOrderPart, as: 'parts' }] });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const idx = parseInt(req.params.index);
    const history = workOrder.pickupHistory || [];
    if (idx < 0 || idx >= history.length) return res.status(400).json({ error: { message: 'Invalid pickup index' } });

    const entry = history[idx];
    const pickupNum = idx + 1;
    const pickupDate = new Date(entry.date);
    const totalItems = (entry.items || []).reduce((s, i) => s + (i.quantity || 0), 0);

    const doc = new PDFDocument({ margin: 50, size: 'letter' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));

    const logoFile = [path.join(__dirname, '../assets/logo.png'), path.join(__dirname, '../assets/logo.jpg')].find(p => fs.existsSync(p));
    const yellowcakePath = path.join(__dirname, '../assets/fonts/Yellowcake-Regular.ttf');
    let hasYellowcake = false;
    try { if (fs.existsSync(yellowcakePath)) { doc.registerFont('Yellowcake', yellowcakePath); hasYellowcake = true; } } catch {}

    // Header
    if (logoFile) try { doc.image(logoFile, 50, 20, { width: 60 }); } catch {}
    if (hasYellowcake) doc.font('Yellowcake').fontSize(14).fillColor('#333').text('Carolina Rolling Co. Inc.', 125, 28);
    else doc.font('Helvetica-Bold').fontSize(14).fillColor('#333').text('CAROLINA ROLLING CO. INC.', 125, 28);
    doc.font('Helvetica').fontSize(8).fillColor('#666');
    doc.text('9152 Sonrisa St., Bellflower, CA 90706', 125, 46);
    doc.text('Phone: (562) 633-1044  |  Email: keepitrolling@carolinarolling.com', 125, 57);
    doc.moveTo(50, 92).lineTo(562, 92).lineWidth(1).strokeColor('#e0e0e0').stroke();

    // Pacific time helper
    const fmtDatePT = (d) => d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: 'numeric' });
    const fmtTimePT = (d) => d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
    const fmtDateLongPT = (d) => d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const fmtTimeFullPT = (d) => d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit' });

    // Title
    const titleLabel = entry.type === 'full' ? 'PICKUP RECEIPT — FULL SHIPMENT' : `PICKUP RECEIPT — PARTIAL SHIPMENT #${pickupNum}`;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#e65100').text(titleLabel, 50, 102);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text('DR-' + String(workOrder.drNumber || ''), 400, 102, { width: 162, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#666');
    doc.text(fmtDatePT(pickupDate) + '  ' + fmtTimePT(pickupDate) + ' PT', 400, 116, { width: 162, align: 'right' });
    doc.moveTo(50, 128).lineTo(562, 128).lineWidth(0.5).strokeColor('#e0e0e0').stroke();

    // Customer info
    let ry = 138;
    doc.font('Helvetica').fontSize(8).fillColor('#666').text('Customer', 50, ry); ry += 12;
    doc.font('Helvetica').fontSize(10).fillColor('#333').text(workOrder.clientName || '', 50, ry); ry += 14;
    doc.font('Helvetica').fontSize(9).fillColor('#666');
    doc.text('P.O: ' + (workOrder.clientPurchaseOrderNumber || '—'), 50, ry); ry += 12;
    doc.text('Picked Up By: ' + (entry.pickedUpBy || '—'), 50, ry); ry += 12;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#333');
    doc.text('Date & Time: ' + fmtDateLongPT(pickupDate) + ' at ' + fmtTimeFullPT(pickupDate) + ' PT', 50, ry); ry += 20;

    // Items table
    doc.moveTo(50, ry).lineTo(562, ry).lineWidth(0.5).strokeColor('#e0e0e0').stroke(); ry += 8;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#666');
    doc.text('QTY', 50, ry, { width: 35 });
    doc.text('PART #', 90, ry);
    doc.text('DESCRIPTION', 200, ry);
    ry += 12;
    doc.moveTo(50, ry).lineTo(562, ry).lineWidth(0.3).strokeColor('#ddd').stroke(); ry += 7;

    (entry.items || []).forEach((item, i) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#333');
      doc.text(String(item.quantity || 0), 50, ry, { width: 35 });
      doc.font('Helvetica').fontSize(9).fillColor('#333');
      doc.text(item.clientPartNumber || item.partNumber || '', 90, ry, { width: 105 });
      let desc = (item.description || '').replace(/^\d+pc:\s*/i, '');
      doc.text(desc, 200, ry, { width: 360 });
      ry += doc.heightOfString(desc, { width: 360 }) + 1;
      if (item.rollingDescription) {
        doc.font('Helvetica').fontSize(8.5).fillColor('#666');
        doc.text(item.rollingDescription, 200, ry, { width: 360 });
        ry += doc.heightOfString(item.rollingDescription, { width: 360 }) + 1;
      }
      ry += 5;
      if (i < entry.items.length - 1) {
        doc.moveTo(90, ry).lineTo(562, ry).lineWidth(0.3).strokeColor('#eee').stroke(); ry += 4;
      }
    });

    // Total
    ry += 10;
    doc.moveTo(50, ry).lineTo(562, ry).lineWidth(0.5).strokeColor('#e0e0e0').stroke(); ry += 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333');
    doc.text('Total items shipped: ' + totalItems, 50, ry);

    // Signature lines
    ry += 40;
    doc.moveTo(50, ry).lineTo(250, ry).lineWidth(0.5).strokeColor('#999').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#666').text('Signature', 50, ry + 4);
    doc.moveTo(300, ry).lineTo(500, ry).lineWidth(0.5).strokeColor('#999').stroke();
    doc.text('Date', 300, ry + 4);

    // Footer
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#666');
    doc.text('Carolina Rolling Co. Inc. | (562) 633-1044 | keepitrolling@carolinarolling.com', 50, 755, { width: 512, align: 'center', lineBreak: false });

    doc.end();
    await new Promise(resolve => doc.on('end', resolve));
    const pdfBuffer = Buffer.concat(chunks);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `inline; filename="Pickup-${entry.type === 'full' ? 'Full' : 'Partial-' + pickupNum}-DR${workOrder.drNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('[Pickup Receipt] Error:', error);
    next(error);
  }
});

// DELETE /:id/pickup/:index - Delete a pickup history entry
router.delete('/:id/pickup/:index', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const idx = parseInt(req.params.index);
    const history = JSON.parse(JSON.stringify(workOrder.pickupHistory || []));
    if (idx < 0 || idx >= history.length) return res.status(400).json({ error: { message: 'Invalid pickup index' } });

    history.splice(idx, 1);
    workOrder.pickupHistory = history;
    workOrder.changed('pickupHistory', true);

    // Recalculate if still fully shipped
    if (history.length === 0) {
      workOrder.status = workOrder.status === 'shipped' ? 'stored' : workOrder.status;
      workOrder.pickedUpAt = null;
      workOrder.pickedUpBy = null;
    } else {
      const totalPickedByPart = {};
      history.forEach(entry => {
        (entry.items || []).forEach(item => {
          const key = item.partId || item.partNumber;
          totalPickedByPart[key] = (totalPickedByPart[key] || 0) + (item.quantity || 0);
        });
      });
      const allPickedUp = workOrder.parts.every(p => {
        const picked = (totalPickedByPart[p.id] || 0) + (totalPickedByPart[p.partNumber] || 0);
        return picked >= (p.quantity || 1);
      });
      if (!allPickedUp && workOrder.status === 'shipped') {
        workOrder.status = 'stored';
      }
    }
    await workOrder.save();
    await workOrder.reload({ include: [{ model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }] });
    res.json({ data: workOrder.toJSON(), message: 'Pickup entry deleted' });
  } catch (error) { next(error); }
});

// PUT /:id/pickup/:index - Edit a pickup history entry (update quantities)
router.put('/:id/pickup/:index', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const idx = parseInt(req.params.index);
    const history = JSON.parse(JSON.stringify(workOrder.pickupHistory || []));
    if (idx < 0 || idx >= history.length) return res.status(400).json({ error: { message: 'Invalid pickup index' } });

    const { items, pickedUpBy } = req.body;
    if (items) history[idx].items = items;
    if (pickedUpBy !== undefined) history[idx].pickedUpBy = pickedUpBy;

    workOrder.pickupHistory = history;
    workOrder.changed('pickupHistory', true);

    // Recalculate shipped status
    const totalPickedByPart = {};
    history.forEach(entry => {
      (entry.items || []).forEach(item => {
        const key = item.partId || item.partNumber;
        totalPickedByPart[key] = (totalPickedByPart[key] || 0) + (item.quantity || 0);
      });
    });
    const allPickedUp = workOrder.parts.every(p => {
      const picked = (totalPickedByPart[p.id] || 0) + (totalPickedByPart[p.partNumber] || 0);
      return picked >= (p.quantity || 1);
    });
    if (allPickedUp && workOrder.status !== 'shipped') {
      workOrder.status = 'shipped';
    } else if (!allPickedUp && workOrder.status === 'shipped') {
      workOrder.status = 'stored';
    }

    await workOrder.save();
    await workOrder.reload({ include: [{ model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }] });
    res.json({ data: workOrder.toJSON(), message: 'Pickup entry updated' });
  } catch (error) { next(error); }
});

// PUT /:id/dr-number - Change DR number (must be unique)
router.put('/:id/dr-number', async (req, res, next) => {
  try {
    const { drNumber } = req.body;
    const newDR = parseInt(drNumber);
    if (!newDR || newDR < 1) {
      return res.status(400).json({ error: { message: 'Invalid DR number' } });
    }

    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    if (workOrder.drNumber === newDR) {
      return res.json({ data: workOrder.toJSON(), message: 'No change' });
    }

    // Check uniqueness across WorkOrders and DRNumbers
    const existingWO = await WorkOrder.findOne({ where: { drNumber: newDR } });
    if (existingWO && existingWO.id !== workOrder.id) {
      return res.status(409).json({ error: { message: `DR-${newDR} is already assigned to another work order` } });
    }

    const transaction = await sequelize.transaction();
    try {
      const oldDR = workOrder.drNumber;

      // Update work order
      await workOrder.update({ drNumber: newDR }, { transaction });

      // Update or create DRNumber record
      if (oldDR) {
        const existingDRRecord = await DRNumber.findOne({ where: { drNumber: oldDR, workOrderId: workOrder.id }, transaction });
        if (existingDRRecord) {
          await existingDRRecord.update({ drNumber: newDR }, { transaction });
        }
      } else {
        await DRNumber.create({
          drNumber: newDR,
          workOrderId: workOrder.id,
          clientName: workOrder.clientName,
          assignedAt: new Date(),
          assignedBy: req.user?.username || 'system'
        }, { transaction });
      }

      await transaction.commit();

      res.json({
        data: workOrder.toJSON(),
        message: `DR number changed from ${oldDR ? 'DR-' + oldDR : 'none'} to DR-${newDR}`
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const {
      clientName,
      clientId: reqClientId,
      clientPurchaseOrderNumber,
      jobNumber,
      storageLocation,
      contactName,
      contactPhone,
      contactEmail,
      contactExtension,
      notes,
      receivedBy,
      requestedDueDate,
      promisedDate,
      status,
      pickedUpBy,
      signatureData,
      // Pricing fields
      truckingDescription,
      truckingCost,
      taxRate,
      taxExempt,
      taxExemptReason,
      taxExemptCertNumber,
      // Minimum override
      minimumOverride,
      minimumOverrideReason,
      // Priority
      priority,
      // Void
      isVoided,
      voidedAt,
      voidedBy,
      voidReason
    } = req.body;

    // Helper to check if value was provided (including empty string)
    const getValue = (newVal, oldVal) => newVal !== undefined ? newVal : oldVal;
    
    // Helper for date fields - convert empty string to null
    const getDateValue = (newVal, oldVal) => {
      if (newVal === undefined) return oldVal;
      if (newVal === '' || newVal === null) return null;
      return newVal;
    };

    // Resolve clientId to clientName if needed
    let resolvedClientName = clientName;
    if (reqClientId !== undefined) {
      if (reqClientId) {
        const client = await Client.findByPk(reqClientId);
        if (client) resolvedClientName = client.name;
      }
    }

    // Handle status transitions
    const updates = {
      clientName: getValue(resolvedClientName, workOrder.clientName),
      clientId: reqClientId !== undefined ? (reqClientId || null) : workOrder.clientId,
      clientPurchaseOrderNumber: getValue(clientPurchaseOrderNumber, workOrder.clientPurchaseOrderNumber),
      jobNumber: getValue(jobNumber, workOrder.jobNumber),
      storageLocation: getValue(storageLocation, workOrder.storageLocation),
      contactName: getValue(contactName, workOrder.contactName),
      contactPhone: getValue(contactPhone, workOrder.contactPhone),
      contactEmail: getValue(contactEmail, workOrder.contactEmail),
      contactExtension: getValue(contactExtension, workOrder.contactExtension),
      notes: getValue(notes, workOrder.notes),
      priority: getValue(priority, workOrder.priority),
      receivedBy: getValue(receivedBy, workOrder.receivedBy),
      requestedDueDate: getDateValue(requestedDueDate, workOrder.requestedDueDate),
      promisedDate: getDateValue(promisedDate, workOrder.promisedDate)
    };

    // Pricing fields
    if (truckingDescription !== undefined) updates.truckingDescription = truckingDescription || null;
    if (truckingCost !== undefined) updates.truckingCost = truckingCost || null;
    if (taxRate !== undefined) updates.taxRate = taxRate || null;
    if (taxExempt !== undefined) updates.taxExempt = taxExempt;
    if (taxExemptReason !== undefined) updates.taxExemptReason = taxExemptReason || null;
    if (taxExemptCertNumber !== undefined) updates.taxExemptCertNumber = taxExemptCertNumber || null;
    if (minimumOverride !== undefined) updates.minimumOverride = minimumOverride;
    if (minimumOverrideReason !== undefined) updates.minimumOverrideReason = minimumOverrideReason || null;

    // Order-level OP transports
    if (req.body.opTransports !== undefined) updates.opTransports = req.body.opTransports;

    // Void fields
    if (isVoided !== undefined) updates.isVoided = isVoided;
    if (voidedAt !== undefined) updates.voidedAt = voidedAt || null;
    if (voidedBy !== undefined) updates.voidedBy = voidedBy || null;
    if (voidReason !== undefined) updates.voidReason = voidReason || null;

    if (status) {
      updates.status = status;
      
      // Set timestamps based on status
      if (status === 'received' && !workOrder.receivedAt) {
        updates.receivedAt = new Date();
      }
      if (status === 'completed' && !workOrder.completedAt) {
        updates.completedAt = new Date();
      }
      if (status === 'shipped') {
        updates.pickedUpAt = new Date();
        if (pickedUpBy) updates.pickedUpBy = pickedUpBy;
        if (signatureData) updates.signatureData = signatureData;
      }
    }

    await workOrder.update(updates);

    // Auto-archive linked shipments when shipped
    if (status === 'shipped') {
      await archiveLinkedShipments(workOrder.id);
    }

    // Reload with parts
    const updatedOrder = await WorkOrder.findByPk(workOrder.id, {
      include: [{
        model: WorkOrderPart,
        as: 'parts',
        include: [{
          model: WorkOrderPartFile,
          as: 'files'
        }]
      }]
    });

    res.json({
      data: updatedOrder,
      message: 'Work order updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id - Delete work order (use void for DR-numbered orders instead)
router.delete('/:id', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const idParam = req.params.id;
    let workOrder;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(idParam)) {
      workOrder = await WorkOrder.findByPk(idParam, {
        include: [
          { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
          { model: WorkOrderDocument, as: 'documents' }
        ],
        transaction
      });
    } else {
      workOrder = await WorkOrder.findOne({
        where: idParam.startsWith('DR-') 
          ? { drNumber: parseInt(idParam.replace('DR-', '')) }
          : { orderNumber: idParam },
        include: [
          { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
          { model: WorkOrderDocument, as: 'documents' }
        ],
        transaction
      });
    }

    if (!workOrder) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Suggest void instead of delete for DR-numbered orders, unless override passcode supplied
    if (workOrder.drNumber) {
      const OVERRIDE_CODE = process.env.DELETE_OVERRIDE_CODE || 'CRC-FORCE-DELETE';
      const suppliedCode = req.body?.overrideCode || req.query?.overrideCode;
      if (suppliedCode !== OVERRIDE_CODE) {
        await transaction.rollback();
        return res.status(400).json({ error: { message: `DR-${workOrder.drNumber} should be voided instead of deleted. Use DR Numbers → Void to preserve the record for accounting.` } });
      }
      console.log(`[delete WO] Force-delete override used for DR-${workOrder.drNumber} by ${req.body?.deletedBy || 'unknown'}`);
    }

    console.log('Deleting work order:', workOrder.id);

    await DRNumber.update({ workOrderId: null }, { where: { workOrderId: workOrder.id }, transaction });
    await PONumber.update({ workOrderId: null }, { where: { workOrderId: workOrder.id }, transaction });
    await Estimate.update({ workOrderId: null, status: 'accepted' }, { where: { workOrderId: workOrder.id }, transaction });

    const inboundOrderIds = workOrder.parts.filter(p => p.inboundOrderId).map(p => p.inboundOrderId);

    // Also collect inbound order IDs stored in the outsideProcessing JSONB arrays
    for (const part of workOrder.parts || []) {
      const ops = part.outsideProcessing || [];
      for (const op of ops) {
        if (op.inboundOrderId && !inboundOrderIds.includes(op.inboundOrderId)) {
          inboundOrderIds.push(op.inboundOrderId);
        }
      }
    }

    // Also catch ANY remaining inbound orders that reference this work order by FK
    // (covers edge cases where the JSONB didn't get the ID stamped correctly)
    try {
      const orphanInbounds = await InboundOrder.findAll({
        where: { workOrderId: workOrder.id },
        attributes: ['id'],
        transaction
      });
      for (const io of orphanInbounds) {
        if (!inboundOrderIds.includes(io.id)) inboundOrderIds.push(io.id);
      }
    } catch (e) {
      console.error('[delete WO] Failed to fetch orphan inbound orders:', e.message);
    }

    // Delete any vendor issues tied to this WO (cascades from FK but be explicit)
    try {
      const { VendorIssue } = require('../models');
      await VendorIssue.destroy({ where: { workOrderId: workOrder.id }, transaction });
    } catch (e) {
      console.error('[delete WO] Failed to delete vendor issues:', e.message);
    }

    for (const part of workOrder.parts || []) {
      for (const file of part.files || []) {
        if (file.cloudinaryId) try { await fileStorage.deleteFile(file.cloudinaryId); } catch {}
      }
    }
    for (const doc of workOrder.documents || []) {
      if (doc.cloudinaryId) try { await fileStorage.deleteFile(doc.cloudinaryId); } catch {}
    }

    await WorkOrderDocument.destroy({ where: { workOrderId: workOrder.id }, transaction });
    for (const part of workOrder.parts || []) {
      await WorkOrderPartFile.destroy({ where: { workOrderPartId: part.id }, transaction });
    }
    await WorkOrderPart.destroy({ where: { workOrderId: workOrder.id }, transaction });

    if (inboundOrderIds.length > 0) {
      await PONumber.update({ inboundOrderId: null }, { where: { inboundOrderId: inboundOrderIds }, transaction });
      await InboundOrder.destroy({ where: { id: inboundOrderIds }, transaction });
    }

    await workOrder.destroy({ transaction });
    await transaction.commit();

    res.json({ message: 'Work order deleted successfully' });
  } catch (error) {
    await transaction.rollback();
    console.error('Delete work order error:', error);
    next(error);
  }
});

// ============= PARTS ROUTES =============

// POST /api/workorders/:id/parts - Add a part to work order
router.post('/:id/parts', async (req, res, next) => {
  try {
    console.log('Adding part to work order:', req.params.id, 'type:', req.body.partType);
    
    const workOrder = await WorkOrder.findByPk(req.params.id);

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Get the next part number
    const existingParts = await WorkOrderPart.count({ where: { workOrderId: workOrder.id } });
    const partNumber = existingParts + 1;

    // Clean numeric fields - convert empty strings to null
    const numericFields = ['laborRate', 'laborHours', 'laborTotal', 'materialUnitCost', 
                          'materialMarkupPercent', 'materialTotal', 'setupCharge', 'otherCharges', 'partTotal'];
    const cleanedData = cleanNumericFields(req.body, numericFields);
    
    // Extract underscore-prefixed fields into formData JSONB
    const extracted = extractFormData(req.body);
    const formDataJson = extracted.formData || null;

    const {
      partType,
      clientPartNumber,
      heatNumber,
      quantity,
      material,
      thickness,
      width,
      length,
      outerDiameter,
      innerDiameter,
      wallThickness,
      rollType,
      radius,
      diameter,
      arcLength,
      arcDegrees,
      sectionSize,
      flangeOut,
      specialInstructions,
      // Material source fields
      materialSource,
      vendorId,
      supplierName,
      vendorEstimateNumber,
      materialDescription
    } = req.body;

    if (!partType) {
      return res.status(400).json({ error: { message: 'Part type is required' } });
    }

    // Resolve vendor name from vendorId for backwards compat
    let resolvedVendorId = vendorId || null;
    let resolvedSupplierName = supplierName || null;
    if (resolvedVendorId) {
      const vendor = await Vendor.findByPk(resolvedVendorId);
      if (vendor) resolvedSupplierName = vendor.name;
    }

    const part = await WorkOrderPart.create({
      workOrderId: workOrder.id,
      partNumber,
      partType,
      clientPartNumber,
      heatNumber,
      quantity: quantity || 1,
      material,
      thickness,
      width,
      length,
      outerDiameter,
      innerDiameter,
      wallThickness,
      rollType: rollType || null,
      radius,
      diameter,
      arcLength,
      arcDegrees,
      sectionSize,
      flangeOut: flangeOut || false,
      specialInstructions,
      // Material source fields
      materialSource: materialSource || 'customer_supplied',
      vendorId: resolvedVendorId,
      supplierName: resolvedSupplierName,
      vendorEstimateNumber: vendorEstimateNumber || null,
      materialDescription: materialDescription || null,
      // Form display data
      formData: formDataJson,
      // Pricing fields - use cleaned values
      laborRate: cleanedData.laborRate,
      laborHours: cleanedData.laborHours,
      laborTotal: cleanedData.laborTotal,
      materialUnitCost: cleanedData.materialUnitCost,
      materialMarkupPercent: cleanedData.materialMarkupPercent,
      materialTotal: cleanedData.materialTotal,
      setupCharge: cleanedData.setupCharge,
      otherCharges: cleanedData.otherCharges,
      partTotal: cleanedData.partTotal,
      outsideProcessing: req.body.outsideProcessing || []
    });

    // Reload with files
    const createdPart = await WorkOrderPart.findByPk(part.id, {
      include: [{
        model: WorkOrderPartFile,
        as: 'files'
      }]
    });

    res.status(201).json({
      data: createdPart,
      message: 'Part added successfully'
    });
  } catch (error) {
    console.error('Add work order part error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to add part' } });
  }
});

// PUT /api/workorders/:id/parts/reorder - Reorder parts
router.put('/:id/parts/reorder', async (req, res, next) => {
  try {
    const { partIds } = req.body;
    if (!partIds || !Array.isArray(partIds)) return res.status(400).json({ error: { message: 'partIds array required' } });
    for (let i = 0; i < partIds.length; i++) {
      await WorkOrderPart.update({ partNumber: i + 1 }, { where: { id: partIds[i], workOrderId: req.params.id } });
    }
    const workOrder = await WorkOrder.findByPk(req.params.id, { include: [{ model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }, { model: WorkOrderDocument, as: 'documents' }] });
    res.json({ data: workOrder.toJSON() });
  } catch (error) { next(error); }
});

// PUT /api/workorders/:id/parts/:partId - Update a part
router.put('/:id/parts/:partId', async (req, res, next) => {
  try {
    const part = await WorkOrderPart.findOne({
      where: {
        id: req.params.partId,
        workOrderId: req.params.id
      }
    });

    if (!part) {
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    // Clean numeric fields - convert empty strings to null
    const numericFields = ['laborRate', 'laborHours', 'laborTotal', 'materialUnitCost', 
                          'materialMarkupPercent', 'materialTotal', 'setupCharge', 'otherCharges', 'partTotal'];
    const cleanedData = cleanNumericFields(req.body, numericFields);
    
    // Extract underscore-prefixed fields into formData JSONB
    const extractedUpdate = extractFormData(req.body);
    const formDataJson = extractedUpdate.formData || null;

    const {
      partType,
      clientPartNumber,
      heatNumber,
      quantity,
      material,
      thickness,
      width,
      length,
      outerDiameter,
      innerDiameter,
      wallThickness,
      rollType,
      radius,
      diameter,
      arcLength,
      arcDegrees,
      sectionSize,
      flangeOut,
      specialInstructions,
      operatorNotes,
      status,
      completedBy,
      // Material source fields
      materialSource,
      materialOrdered,
      materialPurchaseOrderNumber,
      vendorId,
      supplierName,
      vendorEstimateNumber,
      materialDescription,
      heatBreakdown,
      progressCount
    } = req.body;

    const updates = {};
    if (partType !== undefined) updates.partType = partType;
    if (clientPartNumber !== undefined) updates.clientPartNumber = clientPartNumber;
    if (heatNumber !== undefined) updates.heatNumber = heatNumber;
    if (heatBreakdown !== undefined) updates.heatBreakdown = heatBreakdown;
    if (quantity !== undefined) updates.quantity = quantity;
    if (material !== undefined) updates.material = material;
    if (thickness !== undefined) updates.thickness = thickness;
    if (width !== undefined) updates.width = width;
    if (length !== undefined) updates.length = length;
    if (outerDiameter !== undefined) updates.outerDiameter = outerDiameter;
    if (innerDiameter !== undefined) updates.innerDiameter = innerDiameter;
    if (wallThickness !== undefined) updates.wallThickness = wallThickness;
    if (rollType !== undefined) updates.rollType = rollType || null;
    if (radius !== undefined) updates.radius = radius;
    if (diameter !== undefined) updates.diameter = diameter;
    if (arcLength !== undefined) updates.arcLength = arcLength;
    if (arcDegrees !== undefined) updates.arcDegrees = arcDegrees;
    if (sectionSize !== undefined) updates.sectionSize = sectionSize;
    if (flangeOut !== undefined) updates.flangeOut = flangeOut;
    if (specialInstructions !== undefined) updates.specialInstructions = specialInstructions;
    if (operatorNotes !== undefined) updates.operatorNotes = operatorNotes;
    
    // Material source fields - vendorId is primary, supplierName kept in sync
    if (materialSource !== undefined) updates.materialSource = materialSource;
    if (materialOrdered !== undefined) {
      updates.materialOrdered = materialOrdered;
      if (materialOrdered && !part.materialOrderedAt) {
        updates.materialOrderedAt = new Date();
      }
    }
    if (materialPurchaseOrderNumber !== undefined) updates.materialPurchaseOrderNumber = materialPurchaseOrderNumber;
    if (vendorId !== undefined) {
      updates.vendorId = vendorId || null;
      if (vendorId) {
        const vendor = await Vendor.findByPk(vendorId);
        if (vendor) updates.supplierName = vendor.name;
      } else {
        updates.supplierName = null;
      }
    }
    if (vendorEstimateNumber !== undefined) updates.vendorEstimateNumber = vendorEstimateNumber;
    if (materialDescription !== undefined) updates.materialDescription = materialDescription;
    if (req.body.cutFileReference !== undefined) updates.cutFileReference = req.body.cutFileReference;
    if (req.body.contactExtension !== undefined) updates.contactExtension = req.body.contactExtension;
    
    // Update formData if underscore-prefixed fields were sent
    if (formDataJson) {
      updates.formData = formDataJson;
    }
    
    // Pricing fields - use cleaned values
    if (cleanedData.laborRate !== undefined) updates.laborRate = cleanedData.laborRate;
    if (cleanedData.laborHours !== undefined) updates.laborHours = cleanedData.laborHours;
    if (cleanedData.laborTotal !== undefined) updates.laborTotal = cleanedData.laborTotal;
    if (cleanedData.materialUnitCost !== undefined) updates.materialUnitCost = cleanedData.materialUnitCost;
    if (cleanedData.materialMarkupPercent !== undefined) updates.materialMarkupPercent = cleanedData.materialMarkupPercent;
    if (cleanedData.materialTotal !== undefined) updates.materialTotal = cleanedData.materialTotal;
    if (cleanedData.setupCharge !== undefined) updates.setupCharge = cleanedData.setupCharge;
    if (cleanedData.otherCharges !== undefined) updates.otherCharges = cleanedData.otherCharges;
    if (cleanedData.partTotal !== undefined) updates.partTotal = cleanedData.partTotal;

    // Outside processing JSONB array
    if (req.body.outsideProcessing !== undefined) updates.outsideProcessing = req.body.outsideProcessing;
    
    if (status !== undefined) {
      updates.status = status;
      if (status === 'completed' && !part.completedAt) {
        updates.completedAt = new Date();
        // Use explicitly sent completedBy, or fall back to API key operator/device
        if (completedBy) {
          updates.completedBy = completedBy;
        } else if (req.operatorName) {
          updates.completedBy = req.operatorName + (req.deviceName ? ` (${req.deviceName})` : '');
        }
      }
    }

    // Progress milestones
    if (progressCount !== undefined) {
      updates.progressCount = progressCount;
      updates.progressLastUpdatedAt = new Date();
      if (progressCount > 0 && part.status === 'pending') {
        updates.status = 'in_progress';
      }
      // Log who hit this milestone with timestamp
      const operatorLabel = req.operatorName
        ? req.operatorName + (req.deviceName ? ' (' + req.deviceName + ')' : '')
        : (req.user?.username ? req.user.username + ' (web)' : 'Unknown');
      const existingLog = Array.isArray(part.progressLog) ? part.progressLog : [];
      updates.progressLog = [...existingLog, {
        count: progressCount,
        timestamp: new Date().toISOString(),
        operator: operatorLabel
      }];
    }

    // Capture previous status BEFORE update for auto-advance comparison
    const previousStatus = part.status;

    await part.update(updates);

    // Auto-complete linked services when a parent part is marked complete
    // Only run for orders in processing status to avoid unnecessary queries
    if (status === 'completed') {
      try {
        const workOrder = await WorkOrder.findByPk(req.params.id, { attributes: ['id', 'status'] });
        if (workOrder && ['processing', 'in_progress', 'received'].includes(workOrder.status)) {
        const allParts = await WorkOrderPart.findAll({ where: { workOrderId: req.params.id } });
        
        // 1. Auto-complete fab_service/shop_rate parts linked to this part
        const serviceParts = allParts.filter(p => ['fab_service', 'shop_rate'].includes(p.partType));
        const regularPartIds = new Set(allParts.filter(p => !['fab_service', 'shop_rate', 'rush_service'].includes(p.partType)).map(p => p.id));
        
        const linkedServices = serviceParts.filter(p => {
          if (p.status === 'completed') return false; // already done
          const fd = p.formData && typeof p.formData === 'object' ? p.formData : {};
          
          // Match 1: Direct _linkedPartId match
          if (fd._linkedPartId && String(fd._linkedPartId) === String(part.id)) return true;
          
          // Match 2: Part number adjacency — find the closest regular part before this service
          // This handles: no _linkedPartId, stale _linkedPartId from estimate, etc.
          const regularBefore = allParts
            .filter(rp => !['fab_service', 'shop_rate', 'rush_service'].includes(rp.partType) && rp.partNumber < p.partNumber)
            .sort((a, b) => b.partNumber - a.partNumber);
          if (regularBefore.length > 0 && regularBefore[0].id === part.id) return true;
          
          return false;
        });
        
        for (const svc of linkedServices) {
          if (svc.status !== 'completed') {
            await svc.update({ status: 'completed', completedAt: new Date() });
            console.log(`[auto-complete] Service #${svc.partNumber} (${svc.partType}) auto-completed with parent #${part.partNumber}`);
          }
        }
        
        // 2. Auto-complete rush_service when all regular parts are done
        const SERVICE_TYPES = ['fab_service', 'shop_rate', 'rush_service'];
        const regularParts = allParts.filter(p => !SERVICE_TYPES.includes(p.partType));
        const allRegularDone = regularParts.length > 0 && regularParts.every(p => 
          p.id === part.id ? true : p.status === 'completed'  // include the part we just updated
        );
        if (allRegularDone) {
          const rushParts = allParts.filter(p => p.partType === 'rush_service' && p.status !== 'completed');
          for (const rush of rushParts) {
            await rush.update({ status: 'completed', completedAt: new Date() });
            console.log(`[auto-complete] Rush service #${rush.partNumber} auto-completed (all regular parts done)`);
          }

          // Auto-generate COC if client requires it and no COC exists yet
          setImmediate(async () => {
            try {
              const wo = await WorkOrder.findByPk(req.params.id, {
                include: [{ model: WorkOrderPart, as: 'parts' }]
              });
              if (!wo) return;
              // Check if COC already exists
              const existingCoc = await WorkOrderDocument.findOne({
                where: { workOrderId: wo.id, documentType: 'coc' }
              });
              if (existingCoc) return;
              // Check client requires COC
              const { Client } = require('../models');
              const client = wo.clientName ? await Client.findOne({ where: { name: wo.clientName } }) : null;
              if (!client || !client.requiresCoc) return;
              // Generate COC
              console.log(`[auto-coc] Generating COC for ${wo.drNumber ? 'DR-' + wo.drNumber : wo.orderNumber} (client: ${wo.clientName})`);
              const PDFDocument = require('pdfkit');
              const fileStorage = require('../utils/storage');
              const { WeldProcedure } = require('../models');
              const doc = new PDFDocument({ margin: 50, size: 'letter' });
              const chunks = [];
              doc.on('data', c => chunks.push(c));
              await new Promise((resolve, reject) => {
                doc.on('end', resolve);
                doc.on('error', reject);
                const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: 'numeric' });
                const drLabel = wo.drNumber ? 'DR-' + wo.drNumber : (wo.orderNumber || 'N/A');
                // Header
                doc.fontSize(18).font('Helvetica-Bold').fillColor('#1976d2').text('CERTIFICATE OF CONFORMANCE', 50, 50, { align: 'center', width: 512 });
                doc.fontSize(10).font('Helvetica').fillColor('#333').text('Carolina Rolling Co. Inc.', 50, 78, { align: 'center', width: 512 });
                doc.moveTo(50, 95).lineTo(562, 95).lineWidth(1).strokeColor('#1976d2').stroke();
                doc.fontSize(11).font('Helvetica-Bold').fillColor('#333');
                doc.text('Work Order: ' + drLabel, 50, 110);
                doc.text('Client: ' + (wo.clientName || ''), 50, 128);
                doc.text('Date: ' + dateStr, 50, 146);
                if (wo.clientPurchaseOrderNumber) doc.text('PO#: ' + wo.clientPurchaseOrderNumber, 50, 164);
                doc.moveTo(50, 185).lineTo(562, 185).lineWidth(0.5).strokeColor('#ccc').stroke();
                // Parts table
                let y = 200;
                doc.fontSize(9).font('Helvetica-Bold').fillColor('white');
                doc.rect(50, y, 512, 16).fill('#1976d2');
                doc.text('#', 55, y + 4, { width: 25, lineBreak: false });
                doc.text('Description', 80, y + 4, { width: 260, lineBreak: false });
                doc.text('Qty', 340, y + 4, { width: 40, lineBreak: false });
                doc.text('Material', 380, y + 4, { width: 90, lineBreak: false });
                doc.text('Status', 470, y + 4, { width: 80 });
                y += 16;
                const parts = (wo.parts || []).filter(p => !['rush_service'].includes(p.partType));
                parts.forEach((p, idx) => {
                  const merged = p.toJSON ? p.toJSON() : { ...p };
                  if (merged.formData) Object.assign(merged, merged.formData);
                  const desc = merged._materialDescription || merged.materialDescription || merged.partType || '';
                  if (y > 700) { doc.addPage(); y = 50; }
                  if (idx % 2 === 1) doc.rect(50, y, 512, 18).fill('#f5f5f5');
                  doc.fontSize(8).font('Helvetica').fillColor('#333');
                  doc.text(String(p.partNumber), 55, y + 4, { width: 25, lineBreak: false });
                  doc.text(desc.substring(0, 55), 80, y + 4, { width: 260, lineBreak: false });
                  doc.text(String(p.quantity || ''), 340, y + 4, { width: 40, lineBreak: false });
                  doc.text((merged.material || '').substring(0, 15), 380, y + 4, { width: 90, lineBreak: false });
                  doc.fillColor('#2e7d32').text('Conforms', 470, y + 4, { width: 80 });
                  y += 18;
                });
                // Certification statement
                y += 16;
                doc.moveTo(50, y).lineTo(562, y).lineWidth(0.5).strokeColor('#ccc').stroke();
                y += 12;
                doc.fontSize(9).font('Helvetica').fillColor('#333')
                  .text('Carolina Rolling Co. Inc. certifies that the above described material and/or parts conform to all applicable requirements specified and were produced in accordance with applicable quality standards.', 50, y, { width: 512 });
                y += 40;
                doc.text('Certified By: Jason Thornton', 50, y);
                doc.text('Date: ' + dateStr, 300, y);
                y += 20;
                doc.moveTo(50, y).lineTo(250, y).lineWidth(0.5).strokeColor('#555').stroke();
                doc.text('Authorized Signature', 50, y + 4, { fontSize: 8 });
                doc.fontSize(7).fillColor('#888').text('Carolina Rolling Co. Inc. | (562) 633-1044 | keepitrolling@carolinarolling.com', 50, 750, { width: 512, align: 'center' });
                doc.end();
              });
              const pdfBuffer = Buffer.concat(chunks);
              const cocFilename = 'COC-' + drLabel + '.pdf';
              const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
                folder: 'coc', filename: cocFilename, mimeType: 'application/pdf'
              });
              await WorkOrderDocument.create({
                workOrderId: wo.id,
                originalName: cocFilename,
                mimeType: 'application/pdf',
                size: pdfBuffer.length,
                url: uploadResult.url,
                cloudinaryId: uploadResult.storageId,
                documentType: 'coc',
                portalVisible: true
              });
              console.log(`[auto-coc] COC generated and saved for ${drLabel}`);
            } catch (cocErr) {
              console.error('[auto-coc] Failed to auto-generate COC:', cocErr.message);
            }
          });
        }
        }
      } catch (autoErr) {
        console.error('[auto-complete] Error auto-completing linked parts:', autoErr.message);
      }
    }
    
    // When undoing completion, also undo linked services (only for processing orders)
    if (status === 'pending') {
      try {
        const workOrder = await WorkOrder.findByPk(req.params.id, { attributes: ['id', 'status'] });
        if (workOrder && ['processing', 'in_progress', 'received'].includes(workOrder.status)) {
        const allParts = await WorkOrderPart.findAll({ where: { workOrderId: req.params.id } });
        const serviceParts = allParts.filter(p => ['fab_service', 'shop_rate'].includes(p.partType));
        const regularPartIds = new Set(allParts.filter(p => !['fab_service', 'shop_rate', 'rush_service'].includes(p.partType)).map(p => p.id));
        
        const linkedServices = serviceParts.filter(p => {
          const fd = p.formData && typeof p.formData === 'object' ? p.formData : {};
          if (String(fd._linkedPartId) === String(part.id)) return true;
          if (fd._linkedPartId && !regularPartIds.has(fd._linkedPartId)) {
            const regularBefore = allParts
              .filter(rp => !['fab_service', 'shop_rate', 'rush_service'].includes(rp.partType) && rp.partNumber < p.partNumber)
              .sort((a, b) => b.partNumber - a.partNumber);
            if (regularBefore.length > 0 && regularBefore[0].id === part.id) return true;
          }
          return false;
        });
        for (const svc of linkedServices) {
          if (svc.status === 'completed') {
            await svc.update({ status: 'pending', completedAt: null });
            console.log(`[auto-complete] Service #${svc.partNumber} reverted to pending with parent #${part.partNumber}`);
          }
        }
        }
      } catch (autoErr) {
        console.error('[auto-complete] Error reverting linked parts:', autoErr.message);
      }
    }

    // Auto-advance work order status to "processing" only when a part status ACTUALLY changes
    // to something meaningful (not just resaved with same value or set to pending)
    if (status !== undefined && status !== previousStatus && status !== 'pending') {
      try {
        const workOrder = await WorkOrder.findByPk(req.params.id);
        if (workOrder && ['received', 'quoted', 'work_order_generated'].includes(workOrder.status)) {
          await workOrder.update({ status: 'processing' });
          console.log(`[auto-status] WO ${workOrder.drNumber || workOrder.orderNumber} → processing (part #${part.partNumber} status: ${previousStatus} → ${status})`);
        }
      } catch (woErr) {
        console.error('[auto-status] Failed to update WO status:', woErr.message);
      }
    }

    // Reload with files
    const updatedPart = await WorkOrderPart.findByPk(part.id, {
      include: [{
        model: WorkOrderPartFile,
        as: 'files'
      }]
    });

    res.json({
      data: updatedPart,
      message: 'Part updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id/parts/:partId - Delete a part
router.delete('/:id/parts/:partId', async (req, res, next) => {
  try {
    const part = await WorkOrderPart.findOne({
      where: {
        id: req.params.partId,
        workOrderId: req.params.id
      },
      include: [{
        model: WorkOrderPartFile,
        as: 'files'
      }]
    });

    if (!part) {
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    // Delete files from Cloudinary
    for (const file of part.files) {
      if (file.cloudinaryId) {
        try {
          await fileStorage.deleteFile(file.cloudinaryId);
        } catch (e) {
          console.error('Failed to delete from Cloudinary:', e);
        }
      }
    }

    await part.destroy();

    // Renumber remaining parts
    const remainingParts = await WorkOrderPart.findAll({
      where: { workOrderId: req.params.id },
      order: [['partNumber', 'ASC']]
    });

    for (let i = 0; i < remainingParts.length; i++) {
      if (remainingParts[i].partNumber !== i + 1) {
        await remainingParts[i].update({ partNumber: i + 1 });
      }
    }

    res.json({ message: 'Part deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// ============= FILE ROUTES =============

// POST /api/workorders/:id/parts/:partId/files - Upload files to a part
router.post('/:id/parts/:partId/files', upload.array('files', 10), async (req, res, next) => {
  const tempFiles = [];
  
  try {
    const part = await WorkOrderPart.findOne({
      where: {
        id: req.params.partId,
        workOrderId: req.params.id
      }
    });

    if (!part) {
      req.files?.forEach(file => cleanupTempFile(file.path));
      return res.status(404).json({ error: { message: 'Part not found' } });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: { message: 'No files uploaded' } });
    }

    tempFiles.push(...req.files.map(f => f.path));

    const files = await Promise.all(
      req.files.map(async (file) => {
        // Determine file type
        const ext = path.extname(file.originalname).toLowerCase();
        let fileType = 'other';
        if (ext === '.pdf') fileType = 'pdf_print';
        else if (ext === '.stp' || ext === '.step') fileType = 'step_file';
        else if (ext === '.dxf') fileType = 'cut_file';
        else if (ext === '.dwg') fileType = 'drawing';
        else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) fileType = 'drawing';
        else if (ext === '.doc' || ext === '.docx') fileType = 'specification';

        // Upload file
        const uploadResult = await fileStorage.uploadFile(file.path, {
          folder: `work-orders/${req.params.id}/parts/${req.params.partId}`,
          originalName: file.originalname,
          mimeType: file.mimetype
        });

        // Create database record
        const partFile = await WorkOrderPartFile.create({
          workOrderPartId: part.id,
          fileType,
          filename: file.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: uploadResult.url,
          cloudinaryId: uploadResult.storageId
        });

        cleanupTempFile(file.path);
        return partFile;
      })
    );

    res.status(201).json({
      data: files,
      message: `${files.length} file(s) uploaded successfully`
    });
  } catch (error) {
    console.error('File upload error:', error);
    tempFiles.forEach(cleanupTempFile);
    next(error);
  }
});

// GET /api/workorders/:id/parts/:partId/files/:fileId/signed-url - Get working URL for file
router.get('/:id/parts/:partId/files/:fileId/signed-url', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // S3 files: return direct URL
    const isS3 = (file.cloudinaryId && file.cloudinaryId.startsWith('s3:')) || (file.url && file.url.includes('amazonaws.com'));
    if (isS3) {
      return res.json({ data: { url: file.url, expiresIn: null, originalName: file.originalName || file.filename } });
    }

    // Cloudinary files: return direct URL (publicly accessible)
    if (file.url && file.url.includes('cloudinary.com')) {
      return res.json({ data: { url: file.url, expiresIn: null, originalName: file.originalName || file.filename } });
    }
    // Fallback to download proxy for other cases
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/api/workorders/${req.params.id}/parts/${req.params.partId}/files/${req.params.fileId}/download`;
    res.json({ data: { url, expiresIn: null, originalName: file.originalName || file.filename } });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/workorders/:id/parts/:partId/files/:fileId - Delete a file

// GET /api/workorders/:id/parts/:partId/files/:fileId/debug - Debug file URL resolution
router.get('/:id/parts/:partId/files/:fileId/debug', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });
    if (!file) return res.status(404).json({ error: 'File not found in DB' });

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const pubId = file.cloudinaryId;
    const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';
    const versionMatch = file.url?.match(/\/v(\d+)\//);
    const version = versionMatch ? `/v${versionMatch[1]}` : '';

    const urlsToTest = [];
    
    // Signed URLs for private files
    if (pubId && cloudName) {
      try {
        const signedUrl = cloudinary.url(pubId, { resource_type: 'raw', type: 'private', sign_url: true, secure: true });
        urlsToTest.push({ label: 'signed-private', url: signedUrl });
      } catch (e) { urlsToTest.push({ label: 'signed-private', url: 'GENERATION_FAILED: ' + e.message }); }
      
      try {
        const hasExt = pubId.match(/\.\w+$/);
        const format = hasExt ? hasExt[0].replace('.', '') : ext.replace('.', '');
        const dlUrl = cloudinary.utils.private_download_url(pubId, format, { resource_type: 'raw', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        urlsToTest.push({ label: 'private-download', url: dlUrl });
      } catch (e) { urlsToTest.push({ label: 'private-download', url: 'GENERATION_FAILED: ' + e.message }); }
    }
    
    if (file.url) urlsToTest.push({ label: 'stored', url: file.url });
    if (pubId && cloudName) {
      urlsToTest.push({ label: 'raw+ver+ext', url: `https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}${ext}` });
      urlsToTest.push({ label: 'raw+ver', url: `https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}` });
      urlsToTest.push({ label: 'image+ver+ext', url: `https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}${ext}` });
      urlsToTest.push({ label: 'image+ver', url: `https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}` });
    }

    // Test each URL with HEAD request
    const results = [];
    for (const { label, url } of urlsToTest) {
      if (url.startsWith('GENERATION_FAILED')) {
        results.push({ label, url, status: 'n/a' });
        continue;
      }
      const status = await new Promise(resolve => {
        const lib = url.startsWith('https') ? https : http;
        const request = lib.request(url, { method: 'HEAD' }, resp => {
          resp.resume();
          resolve(resp.statusCode);
        });
        request.on('error', (e) => resolve('error: ' + e.message));
        request.setTimeout(5000, () => { request.destroy(); resolve('timeout'); });
        request.end();
      });
      results.push({ label, url: url.substring(0, 150), status });
    }

    res.json({
      file: { id: file.id, cloudinaryId: pubId, storedUrl: file.url, originalName: file.originalName, mimeType: file.mimeType },
      cloudName,
      ext,
      version,
      results
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/:id/parts/:partId/files/:fileId/download - Stream file from Cloudinary
router.get('/:id/parts/:partId/files/:fileId/download', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // S3 files: redirect directly — URLs are permanent and public
    if (file.cloudinaryId && file.cloudinaryId.startsWith('s3:')) {
      return res.redirect(file.url);
    }
    if (file.url && file.url.includes('.s3.') && file.url.includes('amazonaws.com')) {
      return res.redirect(file.url);
    }

    // Cloudinary files: redirect directly (publicly accessible)
    if (file.url && file.url.includes('cloudinary.com')) {
      return res.redirect(302, file.url);
    }

    // Build list of candidate URLs to try
    const urlsToTry = [];
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    
    if (file.cloudinaryId && cloudName) {
      const pubId = file.cloudinaryId;
      const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';
      
      // Work order files are uploaded as raw+private — generate signed URL
      try {
        const signedUrl = cloudinary.url(pubId, {
          resource_type: 'raw',
          type: 'private',
          sign_url: true,
          secure: true
        });
        urlsToTry.push(signedUrl);
      } catch (e) {
        console.error('[file-proxy] Failed to generate signed URL:', e.message);
      }
      
      // Also try authenticated download URL
      try {
        // For raw private, strip extension from pubId for format param
        const hasExt = pubId.match(/\.\w+$/);
        const cleanId = hasExt ? pubId : pubId;
        const format = hasExt ? hasExt[0].replace('.', '') : ext.replace('.', '');
        const signedDownload = cloudinary.utils.private_download_url(cleanId, format, {
          resource_type: 'raw',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        });
        urlsToTry.push(signedDownload);
      } catch (e) {
        console.error('[file-proxy] Failed to generate download URL:', e.message);
      }
    }
    
    // Try stored URL
    if (file.url) urlsToTry.push(file.url);
    
    // Try public URL variants as fallback (for files that were copied from estimates)
    if (file.cloudinaryId && cloudName) {
      const pubId = file.cloudinaryId;
      const ext = path.extname(file.originalName || file.filename || '').toLowerCase() || '.pdf';
      const versionMatch = file.url?.match(/\/v(\d+)\//);
      const version = versionMatch ? `/v${versionMatch[1]}` : '';
      
      urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}${ext}`);
      urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload${version}/${pubId}`);
      urlsToTry.push(`https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}${ext}`);
      urlsToTry.push(`https://res.cloudinary.com/${cloudName}/image/upload${version}/${pubId}`);
      if (version) {
        urlsToTry.push(`https://res.cloudinary.com/${cloudName}/raw/upload/${pubId}${ext}`);
        urlsToTry.push(`https://res.cloudinary.com/${cloudName}/image/upload/${pubId}${ext}`);
      }
    }
    
    // Deduplicate
    const uniqueUrls = [...new Set(urlsToTry)];
    
    console.log(`[file-proxy] Trying ${uniqueUrls.length} URLs for WO file ${file.id} (${file.originalName})`);

    // Try each URL - stream the first one that works
    for (let i = 0; i < uniqueUrls.length; i++) {
      const url = uniqueUrls[i];
      const upstream = await fetchWithRedirects(url);
      if (upstream) {
        console.log(`[file-proxy] SUCCESS on attempt ${i + 1} for WO file ${file.id}`);
        const contentType = file.mimeType || upstream.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName || file.filename || 'file')}"`);
        
        upstream.pipe(res);
        return;
      } else {
        console.log(`[file-proxy] FAIL attempt ${i + 1}: ${url.substring(0, 120)}...`);
      }
    }
    
    console.error(`[file-proxy] ALL URLS FAILED for WO file ${file.id}. cloudinaryId=${file.cloudinaryId}, storedUrl=${file.url}`);
    res.status(404).json({ error: { message: 'File not accessible on storage' } });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/parts/:partId/files/:fileId', async (req, res, next) => {
  try {
    const file = await WorkOrderPartFile.findOne({
      where: {
        id: req.params.fileId,
        workOrderPartId: req.params.partId
      }
    });

    if (!file) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    // Delete from Cloudinary
    if (file.cloudinaryId) {
      try {
        await fileStorage.deleteFile(file.cloudinaryId);
      } catch (e) {
        console.error('Failed to delete from Cloudinary:', e);
      }
    }

    await file.destroy();

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// ============= SHIP AND ARCHIVE =============

// POST /api/workorders/:id/ship - Mark work order as shipped (auto-archives)
router.post('/:id/ship', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const { shippedBy, notes } = req.body;

    await workOrder.update({
      status: 'shipped',
      shippedAt: new Date()
    });

    // Log activity
    await logActivity(
      'shipped',
      'work_order',
      workOrder.id,
      workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber,
      workOrder.clientName,
      `${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber} shipped to ${workOrder.clientName}`,
      { shippedBy, notes }
    );

    // Also log inventory change
    await logActivity(
      'shipped',
      'inventory',
      workOrder.id,
      workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber,
      workOrder.clientName,
      `${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber} shipped to customer`
    );

    // Auto-archive linked shipments
    await archiveLinkedShipments(workOrder.id);

    res.json({
      data: workOrder,
      message: `Work order ${workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber} marked as shipped`
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/workorders/:id/archive - Manually archive a work order
router.post('/:id/archive', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    await workOrder.update({
      status: 'archived',
      archivedAt: new Date()
    });

    res.json({
      data: workOrder,
      message: 'Work order archived'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/archived - Get archived/shipped work orders
router.get('/archived', async (req, res, next) => {
  try {
    const { clientName, clientId, drNumber, limit = 50, offset = 0 } = req.query;
    
    const where = { status: { [Op.in]: ['archived', 'shipped'] } };
    if (clientId) where.clientId = clientId;
    else if (clientName) where.clientName = { [Op.iLike]: `%${clientName}%` };
    if (drNumber) where.drNumber = parseInt(drNumber);

    const workOrders = await WorkOrder.findAndCountAll({
      where,
      include: [
        { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] }
      ],
      order: [['updatedAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      distinct: true
    });

    // Batch fetch shipment photos
    const workOrderIds = workOrders.rows.map(wo => wo.id);
    let shipmentPhotoMap = {};
    if (workOrderIds.length > 0) {
      try {
        const shipments = await Shipment.findAll({
          where: { workOrderId: { [Op.in]: workOrderIds } },
          include: [{ model: ShipmentPhoto, as: 'photos' }]
        });
        shipments.forEach(s => {
          if (s.photos && s.photos.length > 0) {
            shipmentPhotoMap[s.workOrderId] = s.photos[0].url;
          }
        });
      } catch (e) {
        console.error('Error fetching shipment photos for thumbnails:', e);
      }
    }

    const rowsWithThumbnails = workOrders.rows.map(wo => {
      const data = wo.toJSON();
      data.thumbnailUrl = shipmentPhotoMap[data.id] || null;
      return data;
    });

    res.json({
      data: rowsWithThumbnails,
      total: workOrders.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Archived workorders error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/duplicate-to-estimate - Create estimate from work order's original estimate (for reorders)
router.post('/:id/duplicate-to-estimate', async (req, res, next) => {
  try {
    const { Estimate, EstimatePart, EstimatePartFile } = require('../models');

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Generate estimate number
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const estimateNumber = `EST-${year}${month}${day}-${random}`;

    const drLabel = workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber;

    // Try to find the original estimate to copy from (preserves all pricing)
    let sourceEstimate = null;
    if (workOrder.estimateId) {
      sourceEstimate = await Estimate.findByPk(workOrder.estimateId, {
        include: [{ model: EstimatePart, as: 'parts', include: [{ model: EstimatePartFile, as: 'files' }] }]
      });
    }

    if (sourceEstimate) {
      // === DUPLICATE FROM ORIGINAL ESTIMATE (keeps all pricing) ===
      const newEstimate = await Estimate.create({
        estimateNumber,
        clientName: sourceEstimate.clientName,
        contactName: sourceEstimate.contactName,
        contactEmail: sourceEstimate.contactEmail,
        contactPhone: sourceEstimate.contactPhone,
        clientPurchaseOrderNumber: '',
        projectDescription: sourceEstimate.projectDescription,
        notes: sourceEstimate.notes,
        internalNotes: `Reorder from ${drLabel} (copied from ${sourceEstimate.estimateNumber})`,
        taxRate: sourceEstimate.taxRate,
        taxExempt: sourceEstimate.taxExempt,
        truckingDescription: sourceEstimate.truckingDescription,
        truckingCost: sourceEstimate.truckingCost,
        discountPercent: sourceEstimate.discountPercent,
        discountReason: sourceEstimate.discountReason,
        status: 'draft'
      });

      // Copy ALL parts with full pricing
      for (const origPart of (sourceEstimate.parts || [])) {
        const newPart = await EstimatePart.create({
          estimateId: newEstimate.id,
          partNumber: origPart.partNumber,
          partType: origPart.partType,
          clientPartNumber: origPart.clientPartNumber,
          quantity: origPart.quantity,
          materialDescription: origPart.materialDescription,
          supplierName: origPart.supplierName,
          vendorEstimateNumber: origPart.vendorEstimateNumber,
          materialUnitCost: origPart.materialUnitCost,
          materialMarkupPercent: origPart.materialMarkupPercent,
          rollingCost: origPart.rollingCost,
          otherServicesCost: origPart.otherServicesCost,
          otherServicesMarkupPercent: origPart.otherServicesMarkupPercent,
          material: origPart.material,
          thickness: origPart.thickness,
          width: origPart.width,
          length: origPart.length,
          outerDiameter: origPart.outerDiameter,
          wallThickness: origPart.wallThickness,
          sectionSize: origPart.sectionSize,
          rollType: origPart.rollType,
          radius: origPart.radius,
          diameter: origPart.diameter,
          arcDegrees: origPart.arcDegrees,
          flangeOut: origPart.flangeOut,
          specialInstructions: origPart.specialInstructions,
          materialSource: origPart.materialSource,
          materialTotal: origPart.materialTotal,
          laborTotal: origPart.laborTotal,
          partTotal: origPart.partTotal,
          formData: origPart.formData,
          cutFileReference: origPart.cutFileReference
        });
        // Copy part files (prints, STEP, DXF) — point to same Cloudinary/S3 resource
        for (const origFile of (origPart.files || [])) {
          await EstimatePartFile.create({
            partId: newPart.id,
            filename: origFile.filename,
            originalName: origFile.originalName,
            mimeType: origFile.mimeType,
            size: origFile.size,
            url: origFile.url,
            cloudinaryId: origFile.cloudinaryId,
            fileType: origFile.fileType,
            fileLastModified: origFile.fileLastModified,
            portalVisible: false
          });
        }
      }

      // Reload with parts
      const createdEstimate = await Estimate.findByPk(newEstimate.id, {
        include: [{ model: EstimatePart, as: 'parts' }]
      });

      return res.status(201).json({
        data: createdEstimate,
        message: `Estimate ${estimateNumber} created from ${drLabel} — all pricing copied from ${sourceEstimate.estimateNumber}`
      });
    } else {
      // === FALLBACK: No linked estimate, create from WO data ===
      const newEstimate = await Estimate.create({
        estimateNumber,
        clientName: workOrder.clientName,
        contactName: workOrder.contactName,
        contactEmail: workOrder.contactEmail,
        contactPhone: workOrder.contactPhone,
        clientPurchaseOrderNumber: '',
        projectDescription: workOrder.notes || '',
        internalNotes: `Reorder from ${drLabel} (no linked estimate found, created from WO)`,
        taxRate: workOrder.taxRate,
        taxExempt: workOrder.taxExempt,
        status: 'draft'
      });

      for (const origPart of (workOrder.parts || [])) {
        const partJson = origPart.toJSON();
        let formData = partJson.formData || {};
        if (typeof formData === 'string') {
          try { formData = JSON.parse(formData); } catch(e) { formData = {}; }
        }

        await EstimatePart.create({
          estimateId: newEstimate.id,
          partNumber: partJson.partNumber,
          partType: partJson.partType,
          clientPartNumber: partJson.clientPartNumber,
          quantity: partJson.quantity,
          material: partJson.material,
          thickness: partJson.thickness,
          width: partJson.width,
          length: partJson.length,
          outerDiameter: partJson.outerDiameter,
          wallThickness: partJson.wallThickness,
          sectionSize: partJson.sectionSize,
          rollType: partJson.rollType,
          radius: partJson.radius,
          diameter: partJson.diameter,
          arcDegrees: partJson.arcDegrees,
          flangeOut: partJson.flangeOut,
          specialInstructions: partJson.specialInstructions,
          materialDescription: partJson.materialDescription,
          materialSource: partJson.materialSource,
          supplierName: partJson.supplierName,
          laborTotal: partJson.laborTotal,
          rollingCost: partJson.rollingCost,
          materialUnitCost: partJson.materialUnitCost || 0,
          materialTotal: partJson.materialTotal || 0,
          materialMarkupPercent: partJson.materialMarkupPercent || 0,
          otherServicesCost: partJson.otherServicesCost || 0,
          otherServicesMarkupPercent: partJson.otherServicesMarkupPercent || 0,
          partTotal: partJson.partTotal || 0,
          formData
        });
      }

      const createdEstimate = await Estimate.findByPk(newEstimate.id, {
        include: [{ model: EstimatePart, as: 'parts' }]
      });

      return res.status(201).json({
        data: createdEstimate,
        message: `Estimate ${estimateNumber} created from ${drLabel} — pricing copied from work order`
      });
    }
  } catch (error) {
    next(error);
  }
});

// ==================== WORK ORDER DOCUMENTS ====================

// Configure multer for document uploads
const documentUpload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB for documents
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. PDF, images, and Word documents are allowed.'));
    }
  }
});

// POST /api/workorders/:id/documents - Upload documents to work order
router.post('/:id/documents', documentUpload.array('documents', 10), async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id);
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: { message: 'No files uploaded' } });
    }

    const documents = [];
    for (const file of req.files) {
      try {
        // Upload to Cloudinary (same as part files: raw + private with signed URLs)
        const result = await fileStorage.uploadFile(file.path, {
          folder: `work-orders/${workOrder.id}/documents`,
          originalName: file.originalname,
          mimeType: file.mimetype
        });

        // Create document record
        const document = await WorkOrderDocument.create({
          workOrderId: workOrder.id,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: result.url,
          cloudinaryId: result.storageId,
          documentType: req.body.documentType || null,
          portalVisible: req.body.portalVisible === 'true' || req.body.portalVisible === true || false
        });

        documents.push(document);

        // Clean up temp file
        fs.unlinkSync(file.path);
      } catch (uploadError) {
        console.error('Document upload error:', uploadError);
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      }
    }

    res.status(201).json({
      data: documents,
      message: `${documents.length} document(s) uploaded successfully`
    });
  } catch (error) {
    // Clean up any remaining temp files
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      });
    }
    next(error);
  }
});

// GET /api/workorders/:id/documents/:documentId/signed-url - Get signed URL for document
router.get('/:id/documents/:documentId/signed-url', async (req, res, next) => {
  try {
    const document = await WorkOrderDocument.findOne({
      where: { 
        id: req.params.documentId,
        workOrderId: req.params.id
      }
    });

    if (!document) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }

    // S3 files: return direct URL
    const isS3 = (document.cloudinaryId && document.cloudinaryId.startsWith('s3:')) || (document.url && document.url.includes('amazonaws.com'));
    if (isS3) {
      return res.json({ data: { url: document.url, originalName: document.originalName || document.filename } });
    }

    // Return the download proxy URL (same pattern as part files)
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/api/workorders/${req.params.id}/documents/${req.params.documentId}/download`;
    
    res.json({ data: { url, originalName: document.originalName || document.filename } });
  } catch (error) {
    next(error);
  }
});

// GET /api/workorders/:id/documents/:documentId/download - Get document URL
router.get('/:id/documents/:documentId/download', async (req, res, next) => {
  try {
    const document = await WorkOrderDocument.findOne({
      where: { 
        id: req.params.documentId,
        workOrderId: req.params.id
      }
    });

    if (!document) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }

    // API key client scoping
    if (req.apiKey && req.apiKey.clientName) {
      const wo = await WorkOrder.findByPk(req.params.id, { attributes: ['clientName'] });
      if (!wo || !wo.clientName || !wo.clientName.toLowerCase().includes(req.apiKey.clientName.toLowerCase())) {
        return res.status(403).json({ error: { message: 'Access denied' } });
      }
    }

    // S3 files: stream through backend (bucket is private, no public access)
    if ((document.cloudinaryId && document.cloudinaryId.startsWith('s3:')) || 
        (document.url && document.url.includes('.s3.') && document.url.includes('amazonaws.com'))) {
      try {
        let sid = document.cloudinaryId;
        if (!sid || !sid.startsWith('s3:')) {
          const urlObj = new URL(document.url);
          sid = 's3:' + decodeURIComponent(urlObj.pathname.slice(1));
        }
        const streamed = await fileStorage.streamToResponse(sid, res, {
          filename: document.originalName || 'document.pdf',
          contentType: document.mimeType || 'application/pdf'
        });
        if (streamed) return;
      } catch (s3Err) {
        console.error('[doc-download] S3 stream failed:', s3Err.message);
      }
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const pubId = document.cloudinaryId;

    if (!pubId || !cloudName) {
      // No Cloudinary info — try stored URL
      if (document.url) return res.redirect(document.url);
      return res.status(404).json({ error: { message: 'Document file not found' } });
    }

    const pubIdNoExt = pubId.replace(/\.[^/.]+$/, '');

    // Strategy 1: Try stored URL directly (works for public uploads)
    if (document.url) {
      try {
        const testResp = await new Promise((resolve) => {
          const mod = document.url.startsWith('https') ? require('https') : require('http');
          const req = mod.request(document.url, { method: 'HEAD', timeout: 5000 }, (res) => resolve(res));
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (testResp && testResp.statusCode >= 200 && testResp.statusCode < 400) {
          return res.redirect(document.url);
        }
      } catch {}
    }

    // Strategy 2: Generate public upload URL
    try {
      const publicUrl = cloudinary.url(pubId, { resource_type: 'raw', type: 'upload', secure: true });
      const testResp = await new Promise((resolve) => {
        const req = require('https').request(publicUrl, { method: 'HEAD', timeout: 5000 }, (res) => resolve(res));
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      });
      if (testResp && testResp.statusCode >= 200 && testResp.statusCode < 400) {
        // Update stored URL for next time
        await document.update({ url: publicUrl });
        return res.redirect(publicUrl);
      }
    } catch {}

    // Strategy 3: Signed private URL (legacy uploads)
    for (const pid of [pubId, pubIdNoExt]) {
      try {
        const signedUrl = cloudinary.url(pid, { resource_type: 'raw', type: 'private', sign_url: true, secure: true });
        const testResp = await new Promise((resolve) => {
          const req = require('https').request(signedUrl, { method: 'HEAD', timeout: 5000 }, (res) => resolve(res));
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (testResp && testResp.statusCode >= 200 && testResp.statusCode < 400) {
          return res.redirect(signedUrl);
        }
      } catch {}
    }

    // Strategy 4: Signed authenticated URL (very old uploads)
    for (const pid of [pubId, pubIdNoExt]) {
      try {
        const signedUrl = cloudinary.url(pid, { resource_type: 'raw', type: 'authenticated', sign_url: true, secure: true });
        const testResp = await new Promise((resolve) => {
          const req = require('https').request(signedUrl, { method: 'HEAD', timeout: 5000 }, (res) => resolve(res));
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (testResp && testResp.statusCode >= 200 && testResp.statusCode < 400) {
          return res.redirect(signedUrl);
        }
      } catch {}
    }

    // Strategy 5: Re-upload as public if we can find the resource
    for (const resType of ['raw', 'image']) {
      for (const pid of [pubId, pubIdNoExt]) {
        try {
          const resource = await cloudinary.api.resource(pid, { resource_type: resType });
          if (resource) {
            let sourceUrl;
            try { sourceUrl = cloudinary.url(pid, { resource_type: resType, type: 'authenticated', sign_url: true, secure: true }); }
            catch { sourceUrl = resource.secure_url; }
            
            const reuploadResult = await cloudinary.uploader.upload(sourceUrl, {
              resource_type: 'raw', public_id: pubIdNoExt, overwrite: true
            });
            await document.update({ url: reuploadResult.secure_url, cloudinaryId: reuploadResult.public_id });
            console.log(`[doc-proxy] Re-uploaded ${document.originalName} as public`);
            return res.redirect(reuploadResult.secure_url);
          }
        } catch {}
      }
    }

    // FALLBACK: If this is a purchase order, regenerate the PDF on the fly
    if (document.documentType === 'purchase_order') {
      console.log(`[doc-proxy] All URLs failed — regenerating PO PDF on the fly`);
      try {
        const workOrder = await WorkOrder.findByPk(req.params.id, {
          include: [{ model: WorkOrderPart, as: 'parts' }]
        });
        if (workOrder) {
          const poMatch = document.originalName?.match(/^(PO\d+)/);
          const poNumber = poMatch ? poMatch[1] : 'PO0000';
          const supplierMatch = document.originalName?.match(/^PO\d+\s*-\s*(.+?)\.pdf$/i);
          let supplier = supplierMatch ? supplierMatch[1].trim() : 'Unknown Supplier';
          
          const poParts = workOrder.parts.filter(p => p.materialPurchaseOrderNumber === poNumber);
          if (poParts.length > 0 && poParts[0].vendorId) {
            const vendor = await Vendor.findByPk(poParts[0].vendorId);
            if (vendor) supplier = vendor.name;
          }
          const partsForPdf = poParts.length > 0 ? poParts : workOrder.parts;
          const pdfBuffer = await generatePurchaseOrderPDF(poNumber, supplier, partsForPdf, workOrder);
          
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Length', pdfBuffer.length);
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.originalName || 'PO.pdf')}"`);
          res.send(pdfBuffer);
          
          setImmediate(async () => {
            try {
              const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
                folder: 'purchase-orders', filename: `${poNumber}-${workOrder.drNumber}.pdf`, mimeType: 'application/pdf'
              });
              await document.update({ url: uploadResult.url, cloudinaryId: uploadResult.storageId, size: pdfBuffer.length });
            } catch {}
          });
          return;
        }
      } catch (e) { console.error('[doc-proxy] PO regeneration failed:', e.message); }
    }

    console.error(`[doc-proxy] All strategies failed for document ${document.id} (${document.originalName})`);
    res.status(404).json({ error: { message: 'Could not retrieve document file. Try re-uploading.' } });
  } catch (error) {
    console.error('[doc-proxy] Error:', error.message);
    next(error);
  }
});

// DELETE /api/workorders/:id/documents/:documentId - Delete document
router.delete('/:id/documents/:documentId', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  try {
    const document = await WorkOrderDocument.findOne({
      where: { 
        id: req.params.documentId,
        workOrderId: req.params.id
      },
      transaction
    });

    if (!document) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Document not found' } });
    }

    // === SERVICE PO FULL CLEANUP ===
    // If deleting a service PO, also clear the JSONB stamps on affected parts,
    // delete the PONumber row, and cancel the InboundOrder (if pending)
    if (document.documentType === 'outside_processing_po') {
      const poMatch = document.originalName?.match(/^(PO\d+)/);
      const poNumberStr = poMatch ? poMatch[1] : null;
      const poNumberInt = poNumberStr ? parseInt(poNumberStr.replace(/\D/g, '')) : null;

      if (poNumberStr) {
        // 1. Find and clear JSONB stamps on all parts with ops matching this PO
        const wo = await WorkOrder.findByPk(req.params.id, {
          include: [{ model: WorkOrderPart, as: 'parts' }],
          transaction
        });
        if (wo && wo.parts) {
          for (const part of wo.parts) {
            if (!['fab_service', 'shop_rate'].includes(part.partType)) continue;
            const ops = part.outsideProcessing || [];
            let changed = false;
            const newOps = ops.map(op => {
              if (op.poNumber === poNumberStr) {
                changed = true;
                const { poNumber, poSentAt, inboundOrderId, ...rest } = op;
                return rest;
              }
              return op;
            });
            if (changed) {
              await part.update({ outsideProcessing: newOps }, { transaction });
              console.log(`[delete-service-po] Cleared PO stamp on part ${part.id}`);
            }
          }
        }

        // 2. Delete the InboundOrder (only if still pending — don't touch received ones)
        try {
          const inbound = await InboundOrder.findOne({
            where: { purchaseOrderNumber: poNumberStr, workOrderId: req.params.id },
            transaction
          });
          if (inbound) {
            if (inbound.status === 'pending' || inbound.status === 'ordered') {
              await inbound.destroy({ transaction });
              console.log(`[delete-service-po] Deleted pending InboundOrder ${inbound.id}`);
            } else {
              console.log(`[delete-service-po] InboundOrder ${inbound.id} has status ${inbound.status} — leaving it intact`);
            }
          }
        } catch (e) {
          console.error('[delete-service-po] InboundOrder cleanup failed:', e.message);
        }

        // 3. Delete the PONumber row from the shared tracker
        if (poNumberInt) {
          try {
            await PONumber.destroy({
              where: { poNumber: poNumberInt, workOrderId: req.params.id },
              transaction
            });
            console.log(`[delete-service-po] Deleted PONumber row ${poNumberInt}`);
          } catch (e) {
            console.error('[delete-service-po] PONumber cleanup failed:', e.message);
          }
        }
      }
    }

    // Delete from Cloudinary
    if (document.cloudinaryId) {
      try {
        await fileStorage.deleteFile(document.cloudinaryId);
      } catch (e) {
        console.error('Failed to delete from Cloudinary:', e);
      }
    }

    await document.destroy({ transaction });
    await transaction.commit();

    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

// PATCH /api/workorders/:id/documents/:documentId/portal - Toggle portal visibility
router.patch('/:id/documents/:documentId/portal', async (req, res, next) => {
  try {
    const document = await WorkOrderDocument.findOne({
      where: { id: req.params.documentId, workOrderId: req.params.id }
    });
    if (!document) return res.status(404).json({ error: { message: 'Document not found' } });
    const newVal = req.body.portalVisible !== undefined ? !!req.body.portalVisible : !document.portalVisible;
    await document.update({ portalVisible: newVal });
    res.json({ data: document.toJSON(), message: `Document ${newVal ? 'visible' : 'hidden'} on client portal` });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/documents/:documentId/regenerate - Regenerate a purchase order PDF
router.post('/:id/documents/:documentId/regenerate', async (req, res, next) => {
  try {
    const doc = await WorkOrderDocument.findOne({
      where: { id: req.params.documentId, workOrderId: req.params.id }
    });
    if (!doc) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }
    if (doc.documentType !== 'purchase_order' && doc.documentType !== 'outside_processing_po') {
      return res.status(400).json({ error: { message: 'Only purchase order PDFs can be regenerated' } });
    }

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Extract PO number from doc name (e.g. "PO7808 - Supplier Name.pdf" → "PO7808")
    const poMatch = doc.originalName?.match(/^(PO\d+)/);
    const poNumber = poMatch ? poMatch[1] : 'PO0000';

    // === SERVICE PO REGEN ===
    if (doc.documentType === 'outside_processing_po') {
      // Find Fab Service parts whose JSONB outsideProcessing[] contains this poNumber
      const servicePoParts = [];
      let serviceVendor = null;
      const serviceTypes = new Set();
      let repNotes = '';
      let repExpedite = 0;
      for (const p of workOrder.parts) {
        if (!['fab_service', 'shop_rate'].includes(p.partType)) continue;
        const ops = p.outsideProcessing || [];
        for (const op of ops) {
          if (op.poNumber === poNumber) {
            servicePoParts.push(p);
            if (!serviceVendor && op.vendorId) {
              serviceVendor = await Vendor.findByPk(op.vendorId);
            }
            if (op.serviceType) serviceTypes.add(op.serviceType);
            if (op.notes && !repNotes) repNotes = op.notes;
            const e = parseFloat(op.expediteCost) || 0;
            if (e > repExpedite) repExpedite = e;
            break; // one op per part counts — the PDF lists the part once
          }
        }
      }

      if (servicePoParts.length === 0) {
        return res.status(400).json({ error: { message: 'No parts found for this service PO. It may have been cleared.' } });
      }
      if (!serviceVendor) {
        return res.status(400).json({ error: { message: 'Vendor not found for this service PO' } });
      }

      const repServiceType = [...serviceTypes].join(' + ') || 'Subcontracted';

      console.log(`[regenerate-po] Regenerating SERVICE ${poNumber} for ${serviceVendor.name} (${servicePoParts.length} parts)`);

      const pdfBuffer = await generateOutsideProcessingPO(
        poNumber, serviceVendor, servicePoParts, workOrder, repServiceType,
        repNotes, null, 0, repExpedite
      );

      // Delete old Cloudinary file
      if (doc.cloudinaryId) {
        try {
          await fileStorage.deleteFile(doc.cloudinaryId);
        } catch (e) {
          console.error('[regenerate-po] Failed to delete old file:', e.message);
        }
      }

      const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
        folder: 'service-pos',
        filename: `${poNumber}-${workOrder.drNumber}.pdf`,
        mimeType: 'application/pdf'
      });

      await doc.update({
        url: uploadResult.url,
        cloudinaryId: uploadResult.storageId,
        size: pdfBuffer.length
      });

      return res.json({
        message: 'Service PO PDF regenerated successfully',
        data: { url: uploadResult.url, cloudinaryId: uploadResult.storageId }
      });
    }

    // === MATERIAL PO REGEN (existing logic) ===
    // Find parts linked to this PO
    const poParts = workOrder.parts.filter(p => p.materialPurchaseOrderNumber === poNumber);
    
    // Determine supplier from doc name or parts
    const supplierMatch = doc.originalName?.match(/^PO\d+\s*-\s*(.+?)\.pdf$/i);
    let supplier = supplierMatch ? supplierMatch[1].trim() : 'Unknown Supplier';
    if (poParts.length > 0 && poParts[0].vendorId) {
      const vendor = await Vendor.findByPk(poParts[0].vendorId);
      if (vendor) supplier = vendor.name;
    }

    // Use all parts if none matched the PO number (fallback)
    const partsForPdf = poParts.length > 0 ? poParts : workOrder.parts;

    console.log(`[regenerate-po] Regenerating ${poNumber} for ${supplier} (${partsForPdf.length} parts)`);

    // Generate PDF
    const pdfBuffer = await generatePurchaseOrderPDF(poNumber, supplier, partsForPdf, workOrder);

    // Delete old Cloudinary file
    if (doc.cloudinaryId) {
      try {
        await fileStorage.deleteFile(doc.cloudinaryId);
      } catch (e) {
        console.error('[regenerate-po] Failed to delete old file:', e.message);
      }
    }

    // Upload new PDF
    const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
      folder: 'purchase-orders',
      filename: `${poNumber}-${workOrder.drNumber}.pdf`,
      mimeType: 'application/pdf'
    });

    // Update document record
    await doc.update({
      url: uploadResult.url,
      cloudinaryId: uploadResult.storageId,
      size: pdfBuffer.length
    });

    console.log(`[regenerate-po] Success — new URL: ${uploadResult.url}`);

    res.json({ 
      message: 'Purchase order PDF regenerated successfully',
      data: { url: uploadResult.url, cloudinaryId: uploadResult.storageId }
    });
  } catch (error) {
    console.error('[regenerate-po] Error:', error);
    next(error);
  }
});

// Generate Trucking PO PDF (for transport-only)
async function generateTransportPO(poNumber, vendor, trip, workOrder, parts) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      const W = 512;
      const L = 50;
      const R = L + W;

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Top border (purple for trucking)
      doc.rect(L, 40, W, 4).fill('#7b1fa2');

      const headerY = 52;
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#7b1fa2').text('CAROLINA ROLLING COMPANY INC.', L, headerY);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text('9152 Sonrisa St, Bellflower, CA 90706', L, headerY + 18);
      doc.text('Phone: (562) 633-1044  •  Email: keepitrolling@carolinarolling.com', L, headerY + 28);

      doc.fontSize(20).font('Helvetica-Bold').fillColor('#7b1fa2').text('TRUCKING PO', L, headerY, { width: W, align: 'right' });
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#333').text(poNumber, L, headerY + 28, { width: W, align: 'right' });

      doc.moveTo(L, headerY + 46).lineTo(R, headerY + 46).strokeColor('#ccc').lineWidth(1).stroke();

      // Info boxes
      const boxY = headerY + 56;
      const boxH = 80;
      const halfW = (W - 16) / 2;

      // VENDOR box
      doc.rect(L, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(L, boxY, halfW, 16).fill('#F3E5F5');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#7b1fa2').text('TRUCKING VENDOR', L + 8, boxY + 4);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(vendor.name || '', L + 8, boxY + 22, { width: halfW - 16 });
      if (vendor.contactName) doc.fontSize(8).font('Helvetica').text(`Attn: ${vendor.contactName}`, L + 8, boxY + 38);
      if (vendor.address) doc.fontSize(8).text(vendor.address, L + 8, boxY + 50, { width: halfW - 16 });

      // SERVICE box
      const boxX2 = L + halfW + 16;
      doc.rect(boxX2, boxY, halfW, boxH).lineWidth(1).strokeColor('#ddd').stroke();
      doc.rect(boxX2, boxY, halfW, 16).fill('#F3E5F5');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#7b1fa2').text('TRANSPORT TYPE', boxX2 + 8, boxY + 4);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000').text(`${trip.leg} Transport`, boxX2 + 8, boxY + 22, { width: halfW - 16 });
      doc.fontSize(8).font('Helvetica').fillColor('#666').text('REFERENCE WORK ORDER', boxX2 + 8, boxY + 50);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(workOrder.drNumber ? `DR-${workOrder.drNumber}` : (workOrder.orderNumber || '-'), boxX2 + 8, boxY + 62);

      // PO details row
      const detY = boxY + boxH + 12;
      const detFields = [
        ['PO DATE', new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })],
        ['CLIENT', workOrder.clientName || '-'],
        ['LOT COST', `$${parseFloat(trip.cost || 0).toFixed(2)}`]
      ];
      const colW = W / detFields.length;
      detFields.forEach(([label, value], i) => {
        const x = L + (i * colW);
        doc.rect(x, detY, colW, 32).lineWidth(0.5).strokeColor('#ddd').stroke();
        doc.rect(x, detY, colW, 14).fill('#f5f5f5');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#888').text(label, x + 6, detY + 3);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(value, x + 6, detY + 17, { width: colW - 12 });
      });

      // Items being transported
      const tableY = detY + 46;
      doc.rect(L, tableY, W, 18).fill('#7b1fa2');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
      doc.text('PART #', L + 6, tableY + 5);
      doc.text('QTY', L + 70, tableY + 5);
      doc.text('DESCRIPTION', L + 110, tableY + 5);

      let rowY = tableY + 18;
      doc.font('Helvetica').fillColor('#000');

      parts.forEach((p, index) => {
        const partObj = p.toJSON ? p.toJSON() : { ...p };
        if (partObj.formData && typeof partObj.formData === 'object') Object.assign(partObj, partObj.formData);
        const qty = parseInt(partObj.quantity) || 1;
        const desc = partObj._materialDescription || partObj.materialDescription || `Part #${partObj.partNumber}`;
        const cleanDesc = desc.replace(/^\d+pc:\s*/i, '');

        const descHeight = doc.heightOfString(cleanDesc, { width: W - 116 });
        const rowHeight = Math.max(28, descHeight + 12);

        if (rowY + rowHeight > 700) {
          doc.addPage();
          rowY = 50;
        }

        if (index % 2 === 0) doc.rect(L, rowY, W, rowHeight).fill('#FCE4EC');
        doc.moveTo(L, rowY + rowHeight).lineTo(R, rowY + rowHeight).strokeColor('#e0e0e0').lineWidth(0.5).stroke();

        doc.fillColor('#000');
        doc.fontSize(9).font('Helvetica-Bold').text(`${partObj.partNumber}`, L + 6, rowY + 6);
        doc.font('Helvetica').text(`${qty}`, L + 70, rowY + 6);
        doc.fontSize(8.5).text(cleanDesc, L + 110, rowY + 6, { width: W - 116 });
        rowY += rowHeight;
      });

      doc.moveTo(L, rowY).lineTo(R, rowY).strokeColor('#7b1fa2').lineWidth(1.5).stroke();
      rowY += 8;

      // Total cost
      const totalsX = L + W - 220;
      doc.rect(totalsX, rowY, 220, 24).fill('#F3E5F5');
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#7b1fa2');
      doc.text(`LOT COST:`, totalsX + 6, rowY + 7, { width: 124, align: 'right' });
      doc.text(`$${parseFloat(trip.cost || 0).toFixed(2)}`, totalsX + 130, rowY + 7, { width: 84, align: 'right' });
      rowY += 32;

      if (rowY + 80 > 720) { doc.addPage(); rowY = 50; }

      doc.rect(L, rowY, W, 36).lineWidth(1.5).strokeColor('#7b1fa2').stroke();
      doc.rect(L, rowY, W, 14).fill('#F3E5F5');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#7b1fa2').text('⚠ IMPORTANT', L + 8, rowY + 3);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#7b1fa2');
      doc.text(`Reference ${poNumber} on all paperwork.`, L + 8, rowY + 18);
      rowY += 46;

      doc.fontSize(8).font('Helvetica-Bold').fillColor('#333').text('TERMS:', L, rowY);
      doc.fontSize(8).font('Helvetica').fillColor('#444');
      doc.text(`• Reference Work Order: ${workOrder.drNumber ? 'DR-' + workOrder.drNumber : workOrder.orderNumber}`, L + 8, rowY + 14);
      doc.text(`• ${trip.leg === 'Outbound' ? 'Pickup from Carolina Rolling, deliver to outside processor' : 'Pickup from outside processor, deliver to Carolina Rolling'}`, L + 8, rowY + 26);
      if (trip.notes) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#333').text('NOTES:', L, rowY + 46);
        doc.fontSize(8).font('Helvetica').fillColor('#444').text(trip.notes, L + 8, rowY + 58, { width: W - 16 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// POST /api/workorders/:id/transport-po - Generate a trucking PO for a transport trip
router.post('/:id/transport-po', async (req, res, next) => {
  try {
    const { tripId } = req.body;
    if (!tripId) return res.status(400).json({ error: { message: 'tripId required' } });

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const trips = workOrder.opTransports || [];
    const trip = trips.find(t => t.id === tripId);
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });

    if (!trip.truckingVendorId) {
      return res.status(400).json({ error: { message: 'No trucking vendor on this trip' } });
    }

    const vendor = await Vendor.findByPk(trip.truckingVendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Trucking vendor not found' } });

    // Generate PO number
    const poSetting = await AppSettings.findOne({ where: { key: 'next_op_po_number' } });
    let poNum = poSetting?.value?.nextNumber || 1001;
    const poNumber = `TR${poNum}`;
    if (poSetting) {
      await poSetting.update({ value: { nextNumber: poNum + 1 } });
    } else {
      await AppSettings.create({ key: 'next_op_po_number', value: { nextNumber: poNum + 1 } });
    }

    // Determine which parts this trip applies to
    let targetParts = [];
    if (trip.allocationMode === 'manual') {
      const ids = trip.partIds || [];
      targetParts = workOrder.parts.filter(p => ids.includes(p.id));
    } else {
      targetParts = workOrder.parts.filter(p => (p.outsideProcessing || []).length > 0);
    }

    // Generate PDF
    const pdfBuffer = await generateTransportPO(poNumber, vendor, trip, workOrder, targetParts);

    const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
      folder: 'trucking-pos',
      filename: `${poNumber}-${workOrder.drNumber}.pdf`,
      mimeType: 'application/pdf'
    });

    await WorkOrderDocument.create({
      workOrderId: workOrder.id,
      originalName: `${poNumber} - ${vendor.name} (${trip.leg} Transport).pdf`,
      mimeType: 'application/pdf',
      size: pdfBuffer.length,
      url: uploadResult.url,
      cloudinaryId: uploadResult.storageId,
      documentType: 'transport_po'
    });

    // Mark trip as having PO
    const updatedTrips = trips.map(t => t.id === tripId ? { ...t, poNumber, poSentAt: new Date() } : t);
    await workOrder.update({ opTransports: updatedTrips });

    console.log(`[TransportPO] Created ${poNumber} for ${vendor.name} (${trip.leg})`);
    res.json({
      data: { poNumber, vendorName: vendor.name },
      message: `Trucking PO ${poNumber} created for ${vendor.name}`
    });
  } catch (error) {
    console.error('[TransportPO] Error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/outside-processing/auto-bulk
// Auto-generate outside processing POs from the part.outsideProcessing JSONB array
// Groups by vendor + service type, creates one PO per group, mirrors material PO pattern
router.post('/:id/outside-processing/auto-bulk', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    // Optional: req.body.partIds to filter to specific parts (otherwise all OP parts)
    const filterPartIds = Array.isArray(req.body.partIds) ? req.body.partIds : null;

    // Build groups: { "vendorId|serviceType": { vendorId, vendorName, serviceType, parts: [{part, op}], totalCost, totalProfit } }
    const groups = {};
    for (const part of (workOrder.parts || [])) {
      if (filterPartIds && !filterPartIds.includes(part.id)) continue;
      const ops = part.outsideProcessing || [];
      for (const op of ops) {
        if (!op.vendorId || !op.serviceType) continue; // skip incomplete ops
        if (op.poNumber) continue; // skip ops that already have a PO
        const key = `${op.vendorId}|${op.serviceType}`;
        if (!groups[key]) {
          groups[key] = {
            vendorId: op.vendorId,
            vendorName: op.vendorName || '',
            serviceType: op.serviceType,
            parts: [],
            totalCost: 0,
            totalQty: 0
          };
        }
        const qty = parseInt(part.quantity) || 1;
        const cost = parseFloat(op.costPerPart) || 0;
        const expedite = parseFloat(op.expediteCost) || 0;
        groups[key].parts.push({ part, op });
        groups[key].totalCost += (cost * qty) + expedite;
        groups[key].totalQty += qty;
      }
    }

    const groupKeys = Object.keys(groups);
    if (groupKeys.length === 0) {
      return res.status(400).json({ error: { message: 'No outside processing operations available to PO. Make sure parts have a vendor and service type set, and that they don\'t already have a PO.' } });
    }

    const created = [];
    const errors = [];

    for (const key of groupKeys) {
      const group = groups[key];
      try {
        // Validate vendor exists
        const vendor = await Vendor.findByPk(group.vendorId);
        if (!vendor) {
          errors.push({ vendorName: group.vendorName, serviceType: group.serviceType, error: 'Vendor not found in database' });
          continue;
        }

        // Generate PO number
        const poSetting = await AppSettings.findOne({ where: { key: 'next_op_po_number' } });
        let poNum = poSetting?.value?.nextNumber || 1001;
        const poNumber = `OP${poNum}`;
        if (poSetting) {
          await poSetting.update({ value: { nextNumber: poNum + 1 } });
        } else {
          await AppSettings.create({ key: 'next_op_po_number', value: { nextNumber: poNum + 1 } });
        }

        // Use the first op's notes/expedite for the PO PDF (representative)
        const firstOp = group.parts[0].op;
        const repCostPerPart = parseFloat(firstOp.costPerPart) || 0;
        const repExpedite = parseFloat(firstOp.expediteCost) || 0;

        // Generate PDF (passing the actual selected parts so they appear correctly)
        const partsForPdf = group.parts.map(gp => gp.part);
        const pdfBuffer = await generateOutsideProcessingPO(
          poNumber, vendor, partsForPdf, workOrder, group.serviceType,
          firstOp.notes || '', null, 0, repExpedite
        );

        const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
          folder: 'outside-processing-pos',
          filename: `${poNumber}-${workOrder.drNumber}.pdf`,
          mimeType: 'application/pdf'
        });

        await WorkOrderDocument.create({
          workOrderId: workOrder.id,
          originalName: `${poNumber} - ${vendor.name} (${group.serviceType}).pdf`,
          mimeType: 'application/pdf',
          size: pdfBuffer.length,
          url: uploadResult.url,
          cloudinaryId: uploadResult.storageId,
          documentType: 'outside_processing_po'
        });

        // Create matching inbound order so the warehouse expects parts to come back
        let inboundOrderId = null;
        try {
          const partDescriptions = group.parts
            .map(gp => `#${gp.part.partNumber}${gp.part.clientPartNumber ? ' (' + gp.part.clientPartNumber + ')' : ''} × ${gp.part.quantity}`)
            .join(', ');
          const inbound = await InboundOrder.create({
            purchaseOrderNumber: poNumber,
            supplier: vendor.name,
            supplierName: vendor.name,
            vendorId: vendor.id,
            description: `${group.serviceType}: ${partDescriptions}`,
            clientName: workOrder.clientName,
            workOrderId: workOrder.id,
            status: 'pending',
            notes: `Outside processing return — ${group.serviceType} from ${vendor.name}\nDR-${workOrder.drNumber}`
          });
          inboundOrderId = inbound.id;
        } catch (e) {
          console.error('[OP auto-bulk] Inbound order creation failed:', e.message);
        }

        // Stamp the OP entry with the PO number on each part — preserves all other ops
        for (const gp of group.parts) {
          const ops = (gp.part.outsideProcessing || []).map(o => {
            if (o.id === gp.op.id) {
              return { ...o, poNumber, poSentAt: new Date(), inboundOrderId };
            }
            return o;
          });
          await gp.part.update({ outsideProcessing: ops });
        }

        created.push({
          poNumber,
          vendorName: vendor.name,
          serviceType: group.serviceType,
          partCount: group.parts.length,
          totalCost: group.totalCost.toFixed(2),
          inboundOrderId
        });

        console.log(`[OP auto-bulk] Created ${poNumber} for ${vendor.name} (${group.serviceType}) — ${group.parts.length} parts`);
      } catch (groupErr) {
        console.error(`[OP auto-bulk] Group failed (${group.vendorName}/${group.serviceType}):`, groupErr.message);
        errors.push({ vendorName: group.vendorName, serviceType: group.serviceType, error: groupErr.message });
      }
    }

    res.json({
      data: { created, errors },
      message: created.length === 1
        ? `Created 1 outside processing PO`
        : `Created ${created.length} outside processing POs${errors.length ? ` (${errors.length} failed)` : ''}`
    });
  } catch (error) {
    console.error('[OP auto-bulk] Error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/outside-processing - Bulk create outside processing PO for selected parts
// POST /api/workorders/:id/transport-po/:tripId — Generate trucking PO PDF for a transport trip
router.post('/:id/transport-po/:tripId', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const trips = workOrder.opTransports || [];
    const tripIdx = trips.findIndex(t => t.id === req.params.tripId);
    if (tripIdx === -1) return res.status(404).json({ error: { message: 'Trip not found' } });

    const trip = trips[tripIdx];
    if (!trip.truckingVendorId) return res.status(400).json({ error: { message: 'Trip has no trucking vendor' } });

    const vendor = await Vendor.findByPk(trip.truckingVendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Trucking vendor not found' } });

    // Determine which parts are being transported
    let allocatedParts = [];
    if (trip.allocationMode === 'manual') {
      allocatedParts = (workOrder.parts || []).filter(p => (trip.partIds || []).includes(p.id));
    } else {
      // Auto modes: any part with outside processing
      allocatedParts = (workOrder.parts || []).filter(p => (p.outsideProcessing || []).length > 0);
    }

    // Generate PO number
    const poSetting = await AppSettings.findOne({ where: { key: 'next_op_po_number' } });
    let poNum = poSetting?.value?.nextNumber || 1001;
    const poNumber = `TR${poNum}`;
    if (poSetting) {
      await poSetting.update({ value: { nextNumber: poNum + 1 } });
    } else {
      await AppSettings.create({ key: 'next_op_po_number', value: { nextNumber: poNum + 1 } });
    }

    // Generate PDF
    const pdfBuffer = await generateTruckingPO(poNumber, vendor, trip, workOrder, allocatedParts);

    // Upload PDF
    const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
      folder: 'trucking-pos',
      filename: `${poNumber}-${workOrder.drNumber}.pdf`,
      mimeType: 'application/pdf'
    });

    await WorkOrderDocument.create({
      workOrderId: workOrder.id,
      originalName: `${poNumber} - ${vendor.name} (${trip.leg} Trucking).pdf`,
      mimeType: 'application/pdf',
      size: pdfBuffer.length,
      url: uploadResult.url,
      cloudinaryId: uploadResult.storageId,
      documentType: 'trucking_po'
    });

    // Update trip with PO number
    const updatedTrips = [...trips];
    updatedTrips[tripIdx] = { ...trip, poNumber, poSentAt: new Date() };
    await workOrder.update({ opTransports: updatedTrips });

    console.log(`[TruckingPO] Created ${poNumber} for ${vendor.name} - ${trip.leg}`);

    res.json({
      data: { poNumber, vendorName: vendor.name },
      message: `Trucking PO ${poNumber} created for ${vendor.name}`
    });
  } catch (error) {
    console.error('[TruckingPO] Error:', error);
    next(error);
  }
});

// PUT /api/workorders/:id/outside-processing/:poNumber
// Edit an existing OP PO — cost per part, expedite, notes, expected return
// Recalculates labor/partTotal on affected parts and regenerates the PDF
router.put('/:id/outside-processing/:poNumber', async (req, res, next) => {
  try {
    const { poNumber } = req.params;
    const { costPerPart, expediteCost, notes, expectedReturn } = req.body;

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    // Find all parts that have an OP entry with this PO number
    const affectedParts = [];
    let vendorId = null;
    let serviceType = null;
    for (const part of (workOrder.parts || [])) {
      const ops = part.outsideProcessing || [];
      const matchingOp = ops.find(op => op.poNumber === poNumber && !op.cancelled);
      if (matchingOp) {
        affectedParts.push({ part, op: matchingOp });
        vendorId = matchingOp.vendorId;
        serviceType = matchingOp.serviceType;
      }
    }

    if (affectedParts.length === 0) {
      return res.status(404).json({ error: { message: 'PO not found or already cancelled' } });
    }

    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Vendor not found' } });

    // Update each affected part's OP entry
    const newCost = costPerPart !== undefined ? parseFloat(costPerPart) : null;
    const newExpedite = expediteCost !== undefined ? parseFloat(expediteCost) : null;
    for (const { part, op } of affectedParts) {
      const newOps = (part.outsideProcessing || []).map(o => {
        if (o.poNumber === poNumber && !o.cancelled) {
          return {
            ...o,
            ...(newCost !== null ? { costPerPart: newCost } : {}),
            ...(newExpedite !== null ? { expediteCost: newExpedite } : {}),
            ...(notes !== undefined ? { notes } : {}),
            ...(expectedReturn !== undefined ? { expectedReturn } : {}),
            editedAt: new Date()
          };
        }
        return o;
      });

      // Recalculate labor + partTotal if cost changed
      const updates = { outsideProcessing: newOps };
      if (newCost !== null) {
        const qty = parseInt(part.quantity) || 1;
        const matCost = parseFloat(part.materialTotal) || 0;
        const matMarkup = parseFloat(part.materialMarkupPercent) || 0;
        const matEachRaw = Math.round(matCost * (1 + matMarkup / 100) * 100) / 100;
        const fd = part.formData && typeof part.formData === 'object' ? part.formData : {};
        const rounding = part._materialRounding || fd._materialRounding || 'none';
        const matEach = rounding === 'dollar' && matEachRaw > 0 ? Math.ceil(matEachRaw)
          : rounding === 'five' && matEachRaw > 0 ? Math.ceil(matEachRaw / 5) * 5
          : matEachRaw;
        const baseLab = parseFloat(fd._baseLaborTotal) || parseFloat(part.laborTotal) || 0;
        // Sum profit across all OP ops on this part (some may have different markups)
        let opCostLot = 0, opProfitLot = 0;
        for (const o of newOps) {
          if (o.cancelled) continue;
          const c = parseFloat(o.costPerPart) || 0;
          const e = parseFloat(o.expediteCost) || 0;
          const m = parseFloat(o.markup) || 0;
          opCostLot += (c + e) * qty;
          opProfitLot += c * (m / 100) * qty;
        }
        const opCostPerPart = qty > 0 ? opCostLot / qty : 0;
        const opProfitPerPart = qty > 0 ? opProfitLot / qty : 0;
        // OP-disables-rolling rule: when OP enabled, base labor is 0
        const opEnabled = newOps.some(o => !o.cancelled);
        const effBase = opEnabled ? 0 : baseLab;
        updates.laborTotal = (effBase + opProfitPerPart).toFixed(2);
        updates.partTotal = ((matEach + effBase + opProfitPerPart + opCostPerPart) * qty).toFixed(2);
      }
      await part.update(updates);
    }

    // Regenerate PDF
    const partsForPdf = affectedParts.map(ap => ap.part);
    const firstOp = affectedParts[0].op;
    const useNotes = notes !== undefined ? notes : (firstOp.notes || '');
    const useExpedite = newExpedite !== null ? newExpedite : (parseFloat(firstOp.expediteCost) || 0);
    const useExpectedReturn = expectedReturn !== undefined ? expectedReturn : null;
    const pdfBuffer = await generateOutsideProcessingPO(
      poNumber, vendor, partsForPdf, workOrder, serviceType,
      useNotes, useExpectedReturn, 0, useExpedite
    );

    const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
      folder: 'outside-processing-pos',
      filename: `${poNumber}-${workOrder.drNumber}-edit.pdf`,
      mimeType: 'application/pdf'
    });

    // Replace old document — find existing one with same PO number
    const oldDocs = await WorkOrderDocument.findAll({
      where: { workOrderId: workOrder.id, documentType: 'outside_processing_po' }
    });
    for (const oldDoc of oldDocs) {
      if (oldDoc.originalName && oldDoc.originalName.includes(poNumber) && !oldDoc.originalName.includes('CANCELLED')) {
        await oldDoc.destroy();
      }
    }

    await WorkOrderDocument.create({
      workOrderId: workOrder.id,
      originalName: `${poNumber} - ${vendor.name} (${serviceType}).pdf`,
      mimeType: 'application/pdf',
      size: pdfBuffer.length,
      url: uploadResult.url,
      cloudinaryId: uploadResult.storageId,
      documentType: 'outside_processing_po'
    });

    console.log(`[OP edit] Updated ${poNumber} (${affectedParts.length} parts)`);
    res.json({
      data: { poNumber, partsCount: affectedParts.length },
      message: `${poNumber} updated and PDF regenerated`
    });
  } catch (error) {
    console.error('[OP edit] Error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/outside-processing/:poNumber/regen
// Regenerate the PDF for an existing PO without changing any data
router.post('/:id/outside-processing/:poNumber/regen', async (req, res, next) => {
  try {
    const { poNumber } = req.params;
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const affectedParts = [];
    let vendorId = null;
    let serviceType = null;
    for (const part of (workOrder.parts || [])) {
      const ops = part.outsideProcessing || [];
      const matchingOp = ops.find(op => op.poNumber === poNumber && !op.cancelled);
      if (matchingOp) {
        affectedParts.push({ part, op: matchingOp });
        vendorId = matchingOp.vendorId;
        serviceType = matchingOp.serviceType;
      }
    }
    if (affectedParts.length === 0) {
      return res.status(404).json({ error: { message: 'PO not found or already cancelled' } });
    }

    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Vendor not found' } });

    const firstOp = affectedParts[0].op;
    const partsForPdf = affectedParts.map(ap => ap.part);
    const pdfBuffer = await generateOutsideProcessingPO(
      poNumber, vendor, partsForPdf, workOrder, serviceType,
      firstOp.notes || '', firstOp.expectedReturn || null, 0, parseFloat(firstOp.expediteCost) || 0
    );

    const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
      folder: 'outside-processing-pos',
      filename: `${poNumber}-${workOrder.drNumber}-regen.pdf`,
      mimeType: 'application/pdf'
    });

    // Delete old PDF document
    const oldDocs = await WorkOrderDocument.findAll({
      where: { workOrderId: workOrder.id, documentType: 'outside_processing_po' }
    });
    for (const oldDoc of oldDocs) {
      if (oldDoc.originalName && oldDoc.originalName.includes(poNumber) && !oldDoc.originalName.includes('CANCELLED')) {
        await oldDoc.destroy();
      }
    }

    await WorkOrderDocument.create({
      workOrderId: workOrder.id,
      originalName: `${poNumber} - ${vendor.name} (${serviceType}).pdf`,
      mimeType: 'application/pdf',
      size: pdfBuffer.length,
      url: uploadResult.url,
      cloudinaryId: uploadResult.storageId,
      documentType: 'outside_processing_po'
    });

    console.log(`[OP regen] Regenerated ${poNumber}`);
    res.json({ data: { poNumber }, message: `${poNumber} PDF regenerated` });
  } catch (error) {
    console.error('[OP regen] Error:', error);
    next(error);
  }
});

// DELETE /api/workorders/:id/outside-processing/:poNumber
// Cancel an OP PO. Marks it cancelled, clears poNumber so the group can be re-issued,
// renames the PDF doc, marks the matching inbound order as cancelled.
// Body: { reason: string }
router.delete('/:id/outside-processing/:poNumber', async (req, res, next) => {
  try {
    const { poNumber } = req.params;
    const { reason } = req.body || {};
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: { message: 'Cancellation reason is required' } });
    }

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const affectedParts = [];
    let vendorName = null;
    for (const part of (workOrder.parts || [])) {
      const ops = part.outsideProcessing || [];
      const matchingOp = ops.find(op => op.poNumber === poNumber && !op.cancelled);
      if (matchingOp) {
        affectedParts.push({ part, op: matchingOp });
        vendorName = matchingOp.vendorName;
      }
    }
    if (affectedParts.length === 0) {
      return res.status(404).json({ error: { message: 'PO not found or already cancelled' } });
    }

    // Mark op cancelled and clear poNumber so the group can be re-issued
    const cancelledAt = new Date();
    const cancelledBy = req.user?.username || req.operatorName || 'Admin';
    for (const { part, op } of affectedParts) {
      const newOps = (part.outsideProcessing || []).map(o => {
        if (o.poNumber === poNumber && !o.cancelled) {
          return {
            ...o,
            cancelled: true,
            cancelledAt,
            cancelledBy,
            cancelledReason: reason.trim(),
            cancelledPONumber: poNumber, // preserve historical PO number
            poNumber: null,              // clear so user can re-generate
            poSentAt: null,
            inboundOrderId: null
          };
        }
        return o;
      });
      await part.update({ outsideProcessing: newOps });
    }

    // Rename the PDF document(s) to mark cancelled
    const oldDocs = await WorkOrderDocument.findAll({
      where: { workOrderId: workOrder.id, documentType: 'outside_processing_po' }
    });
    for (const oldDoc of oldDocs) {
      if (oldDoc.originalName && oldDoc.originalName.includes(poNumber) && !oldDoc.originalName.includes('CANCELLED')) {
        await oldDoc.update({
          originalName: `[CANCELLED] ${oldDoc.originalName}`
        });
      }
    }

    // Cancel matching inbound order(s)
    try {
      const inboundOrders = await InboundOrder.findAll({
        where: { workOrderId: workOrder.id, purchaseOrderNumber: poNumber }
      });
      for (const io of inboundOrders) {
        await io.update({
          status: 'cancelled',
          notes: (io.notes || '') + `\n\n[CANCELLED ${cancelledAt.toISOString()}] ${reason.trim()}`
        });
      }
    } catch (e) {
      console.error('[OP cancel] Inbound order cancel failed:', e.message);
    }

    console.log(`[OP cancel] Cancelled ${poNumber} (${affectedParts.length} parts) — reason: ${reason}`);
    res.json({
      data: { poNumber, vendorName, partsCount: affectedParts.length, reason: reason.trim() },
      message: `${poNumber} cancelled. Parts can be re-issued with a new PO number.`
    });
  } catch (error) {
    console.error('[OP cancel] Error:', error);
    next(error);
  }
});

router.post('/:id/outside-processing', async (req, res, next) => {
  try {
    const { partIds, vendorId, serviceType, costPerPart, totalCost, expectedReturn, notes, transportCost, expediteCost } = req.body;
    
    if (!partIds || !Array.isArray(partIds) || partIds.length === 0) {
      return res.status(400).json({ error: { message: 'No parts selected' } });
    }
    if (!vendorId) return res.status(400).json({ error: { message: 'Vendor required' } });
    if (!serviceType) return res.status(400).json({ error: { message: 'Service type required' } });

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) return res.status(404).json({ error: { message: 'Vendor not found' } });

    const selectedParts = workOrder.parts.filter(p => partIds.includes(p.id));
    if (selectedParts.length === 0) {
      return res.status(400).json({ error: { message: 'No matching parts found' } });
    }

    // Generate PO number
    const poSetting = await AppSettings.findOne({ where: { key: 'next_op_po_number' } });
    let poNum = poSetting?.value?.nextNumber || 1001;
    const poNumber = `OP${poNum}`;
    if (poSetting) {
      await poSetting.update({ value: { nextNumber: poNum + 1 } });
    } else {
      await AppSettings.create({ key: 'next_op_po_number', value: { nextNumber: poNum + 1 } });
    }

    // Determine cost per part
    let perPartCost = parseFloat(costPerPart) || 0;
    if (totalCost && !perPartCost) {
      perPartCost = parseFloat(totalCost) / selectedParts.length;
    }

    // Update each selected part with vendor, service, status, PO
    // Expedite cost goes on the first part only (it's a one-time fee for the whole shipment)
    for (let i = 0; i < selectedParts.length; i++) {
      const part = selectedParts[i];
      await part.update({
        outsideProcessingVendorId: vendor.id,
        outsideProcessingVendorName: vendor.name,
        outsideProcessingServiceType: serviceType,
        outsideProcessingDescription: serviceType,
        outsideProcessingCost: perPartCost,
        outsideProcessingTransportCost: i === 0 ? (parseFloat(transportCost) || 0) : 0,
        outsideProcessingExpediteCost: i === 0 ? (parseFloat(expediteCost) || 0) : 0,
        outsideProcessingPONumber: poNumber,
        outsideProcessingPOSentAt: new Date(),
        outsideProcessingStatus: 'sent',
        outsideProcessingExpectedReturn: expectedReturn || null
      });
    }

    // Generate PDF
    const pdfBuffer = await generateOutsideProcessingPO(poNumber, vendor, selectedParts, workOrder, serviceType, notes, expectedReturn, parseFloat(transportCost) || 0, parseFloat(expediteCost) || 0);

    // Upload as work order document
    const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
      folder: 'outside-processing-pos',
      filename: `${poNumber}-${workOrder.drNumber}.pdf`,
      mimeType: 'application/pdf'
    });

    await WorkOrderDocument.create({
      workOrderId: workOrder.id,
      originalName: `${poNumber} - ${vendor.name} (${serviceType}).pdf`,
      mimeType: 'application/pdf',
      size: pdfBuffer.length,
      url: uploadResult.url,
      cloudinaryId: uploadResult.storageId,
      documentType: 'outside_processing_po'
    });

    console.log(`[OutsideProcessing] Created ${poNumber} for ${vendor.name} - ${selectedParts.length} parts (${serviceType})`);

    res.json({
      data: { poNumber, partsCount: selectedParts.length, vendorName: vendor.name, totalCost: perPartCost * selectedParts.reduce((s, p) => s + (p.quantity || 1), 0) },
      message: `Outside processing PO ${poNumber} created for ${vendor.name}`
    });
  } catch (error) {
    console.error('[OutsideProcessing] Error:', error);
    next(error);
  }
});

// PUT /api/workorders/:id/parts/:partId/outside-processing-status - Mark part returned from outside vendor
router.put('/:id/parts/:partId/outside-processing-status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['not_sent', 'sent', 'returned'].includes(status)) {
      return res.status(400).json({ error: { message: 'Invalid status' } });
    }
    const part = await WorkOrderPart.findOne({
      where: { id: req.params.partId, workOrderId: req.params.id }
    });
    if (!part) return res.status(404).json({ error: { message: 'Part not found' } });
    
    const updates = { outsideProcessingStatus: status };
    if (status === 'returned') updates.outsideProcessingReturnedAt = new Date();
    await part.update(updates);
    
    res.json({ data: part.toJSON(), message: `Part marked as ${status}` });
  } catch (error) { next(error); }
});

// POST /api/workorders/:id/create-po-pdf - Create a PO PDF from scratch (for deleted/missing PO documents)
router.post('/:id/create-po-pdf', async (req, res, next) => {
  try {
    const { poNumber } = req.body;
    if (!poNumber) {
      return res.status(400).json({ error: { message: 'PO number is required' } });
    }

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Find parts linked to this PO
    const poParts = workOrder.parts.filter(p => p.materialPurchaseOrderNumber === poNumber);
    if (poParts.length === 0) {
      return res.status(400).json({ error: { message: `No parts found with PO ${poNumber}` } });
    }

    // Get supplier from parts
    let supplier = 'Unknown Supplier';
    if (poParts[0].vendorId) {
      const vendor = await Vendor.findByPk(poParts[0].vendorId);
      if (vendor) supplier = vendor.name;
    } else if (poParts[0].supplierName) {
      supplier = poParts[0].supplierName;
    }

    console.log(`[create-po-pdf] Creating ${poNumber} for ${supplier} (${poParts.length} parts)`);

    const pdfBuffer = await generatePurchaseOrderPDF(poNumber, supplier, poParts, workOrder);

    // Upload PDF
    const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
      folder: 'purchase-orders',
      filename: `${poNumber}-${workOrder.drNumber}.pdf`,
      mimeType: 'application/pdf'
    });

    // Create new document record
    await WorkOrderDocument.create({
      workOrderId: workOrder.id,
      originalName: `${poNumber} - ${supplier}.pdf`,
      mimeType: 'application/pdf',
      size: pdfBuffer.length,
      url: uploadResult.url,
      cloudinaryId: uploadResult.storageId,
      documentType: 'purchase_order'
    });

    console.log(`[create-po-pdf] Success — ${poNumber} for ${supplier}`);

    res.status(201).json({ 
      message: `Purchase order PDF created for ${poNumber}`,
      data: { url: uploadResult.url }
    });
  } catch (error) {
    console.error('[create-po-pdf] Error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/print-package - Render work order HTML + merge part PDFs into one complete document
// Body: { html: string, mode: 'production' | 'full' }
router.post('/:id/print-package', async (req, res, next) => {
  try {
    const puppeteer = require('puppeteer-core');
    const { execSync } = require('child_process');
    const mode = req.body.mode || 'production';
    const workOrderHtml = req.body.html;

    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [
        { model: WorkOrderPart, as: 'parts', include: [{ model: WorkOrderPartFile, as: 'files' }] },
        { model: WorkOrderDocument, as: 'documents' }
      ]
    });

    if (!workOrder) {
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    console.log(`[print-package] Building ${mode} package for WO ${workOrder.id}, HTML: ${workOrderHtml ? workOrderHtml.length + ' chars' : 'none'}`);

    // ─── Step 1: Render work order HTML to PDF via Puppeteer ───
    let woPagesPdf = null;
    if (workOrderHtml) {
      try {
        // Find Chrome
        let chromePath;
        if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
          chromePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        } else {
          const candidates = [
            '/app/.chrome-for-testing/chrome-linux64/chrome',
            '/app/.chrome-for-testing/chrome-linux/chrome',
            '/app/.apt/usr/bin/google-chrome',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
          ];
          for (const p of candidates) { if (fs.existsSync(p)) { chromePath = p; break; } }
          if (!chromePath) {
            try {
              const found = execSync('which chrome google-chrome chromium 2>/dev/null || find /app -name "chrome" -type f 2>/dev/null | head -1').toString().trim();
              if (found) chromePath = found.split('\n')[0];
            } catch (e) {}
          }
        }

        if (chromePath) {
          console.log(`[print-package] Rendering HTML with Chrome: ${chromePath}`);
          
          // Convert local image references to base64 data URIs so Puppeteer can render them
          let processedHtml = workOrderHtml;
          const imgRegex = /src="\/images\/angle-orientation\/([^"]+)"/g;
          let match;
          while ((match = imgRegex.exec(workOrderHtml)) !== null) {
            const imgFilename = match[1];
            const imgPath = path.join(__dirname, '..', 'assets', 'angle-orientation', imgFilename);
            try {
              if (fs.existsSync(imgPath)) {
                const imgData = fs.readFileSync(imgPath).toString('base64');
                const dataUri = `data:image/png;base64,${imgData}`;
                processedHtml = processedHtml.split(`/images/angle-orientation/${imgFilename}`).join(dataUri);
                console.log(`[print-package] Embedded image: ${imgFilename}`);
              }
            } catch (e) { console.warn(`[print-package] Could not embed image ${imgFilename}:`, e.message); }
          }
          
          const browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
          });
          const page = await browser.newPage();
          await page.setContent(processedHtml, { waitUntil: 'load', timeout: 15000 });
          woPagesPdf = await page.pdf({
            format: 'Letter',
            margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' },
            printBackground: true
          });
          await browser.close();
          console.log(`[print-package] Rendered work order HTML → ${woPagesPdf.length} bytes`);
        } else {
          console.warn('[print-package] Chrome not found — skipping HTML render');
        }
      } catch (renderErr) {
        console.error('[print-package] HTML render failed:', renderErr.message);
      }
    }

    // ─── Step 2: Collect attached PDFs ───
    const port = process.env.PORT || 5001;
    const baseUrl = `http://localhost:${port}/api/workorders/${workOrder.id}`;
    const pdfSources = [];

    // Part PDFs (both modes)
    const sortedParts = (workOrder.parts || []).sort((a, b) => a.partNumber - b.partNumber);
    for (const part of sortedParts) {
      const pdfFiles = (part.files || []).filter(f => 
        f.mimeType === 'application/pdf' || (f.originalName || '').toLowerCase().endsWith('.pdf')
      );
      for (const file of pdfFiles) {
        pdfSources.push({ 
          label: `Part ${part.partNumber}: ${file.originalName}`,
          proxyUrl: `${baseUrl}/parts/${part.id}/files/${file.id}/download`
        });
      }
    }

    // Order documents (both modes — drawings, specs, etc.)
    if (workOrder.documents) {
      for (const doc of workOrder.documents.filter(d => d.documentType !== 'purchase_order' && d.documentType !== 'mtr')) {
        if (doc.mimeType === 'application/pdf' || (doc.originalName || '').toLowerCase().endsWith('.pdf')) {
          pdfSources.push({
            label: `Doc: ${doc.originalName}`,
            proxyUrl: `${baseUrl}/documents/${doc.id}/download`
          });
        }
      }
      // Full mode: also include POs
      if (mode === 'full') {
        for (const doc of workOrder.documents.filter(d => d.documentType === 'purchase_order')) {
          pdfSources.push({
            label: `PO: ${doc.originalName}`,
            proxyUrl: `${baseUrl}/documents/${doc.id}/download`
          });
        }
      }
    }

    console.log(`[print-package] Fetching ${pdfSources.length} attached PDFs...`);

    // ─── Step 3: Fetch attached PDFs — follows redirects for S3 ───
    const fetchPdfBuffer = (source) => {
      return new Promise((resolve) => {
        const fetchUrl = (urlStr, redirectCount = 0) => {
          if (redirectCount > 5) { resolve(null); return; }
          
          const isHttps = urlStr.startsWith('https');
          const httpModule = isHttps ? https : http;
          const options = {};
          
          // Only add auth headers for local proxy URLs, not external S3
          if (urlStr.startsWith('http://localhost')) {
            options.headers = {};
            if (req.headers.cookie) options.headers.cookie = req.headers.cookie;
            if (req.headers.authorization) options.headers.authorization = req.headers.authorization;
          }
          
          const request = httpModule.get(urlStr, options, (resp) => {
            // Follow redirects (302, 301, 307, 308) — S3 files redirect
            if ([301, 302, 307, 308].includes(resp.statusCode) && resp.headers.location) {
              resp.resume();
              console.log(`[print-package] Following redirect for ${source.label} → ${resp.headers.location.substring(0, 80)}...`);
              fetchUrl(resp.headers.location, redirectCount + 1);
              return;
            }
            
            if (resp.statusCode !== 200) {
              resp.resume();
              console.warn(`[print-package] HTTP ${resp.statusCode} for ${source.label}`);
              resolve(null);
              return;
            }
            const chunks = [];
            resp.on('data', c => chunks.push(c));
            resp.on('end', () => {
              const buf = Buffer.concat(chunks);
              if (buf.length > 4 && buf.slice(0, 5).toString() === '%PDF-') {
                console.log(`[print-package] Fetched ${source.label} (${buf.length} bytes)`);
                resolve(buf);
              } else {
                console.warn(`[print-package] Not a valid PDF for ${source.label} (${buf.length} bytes, starts: ${buf.slice(0, 20).toString()})`);
                resolve(null);
              }
            });
            resp.on('error', () => resolve(null));
          });
          request.on('error', (err) => {
            console.error(`[print-package] Fetch error for ${source.label}: ${err.message}`);
            resolve(null);
          });
          request.setTimeout(15000, () => { request.destroy(); resolve(null); });
        };
        
        fetchUrl(source.proxyUrl);
      });
    };

    const attachedBuffers = await Promise.all(pdfSources.map(s => fetchPdfBuffer(s)));

    // ─── Step 4: Merge everything into one PDF ───
    const mergedPdf = await PDFLibDocument.create();
    let mergedCount = 0;

    // First: work order details pages
    if (woPagesPdf) {
      try {
        const woDoc = await PDFLibDocument.load(woPagesPdf, { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(woDoc, woDoc.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
        mergedCount++;
        console.log(`[print-package] Added work order details (${woDoc.getPageCount()} pages)`);
      } catch (e) {
        console.warn(`[print-package] Could not add work order pages: ${e.message}`);
      }
    }

    // Then: attached PDFs (part prints, docs, POs)
    for (let i = 0; i < attachedBuffers.length; i++) {
      if (!attachedBuffers[i]) {
        console.warn(`[print-package] Skipping ${pdfSources[i].label} — fetch failed`);
        continue;
      }
      try {
        const srcDoc = await PDFLibDocument.load(attachedBuffers[i], { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
        mergedCount++;
        console.log(`[print-package] Added ${pdfSources[i].label} (${srcDoc.getPageCount()} pages)`);
      } catch (pdfErr) {
        console.warn(`[print-package] Could not merge ${pdfSources[i].label}: ${pdfErr.message}`);
      }
    }

    if (mergedCount === 0) {
      return res.status(404).json({ error: { message: 'No content could be generated' } });
    }

    const mergedBytes = await mergedPdf.save();
    const drLabel = workOrder.drNumber ? `DR-${workOrder.drNumber}` : workOrder.orderNumber;
    const filename = mode === 'full' 
      ? `${drLabel}_Full_Package.pdf`
      : `${drLabel}_Production_Package.pdf`;

    console.log(`[print-package] Complete! ${mergedCount} docs merged → ${mergedBytes.length} bytes (${filename})`);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': mergedBytes.length
    });
    res.send(Buffer.from(mergedBytes));
  } catch (error) {
    console.error('[print-package] FATAL Error:', error.message, error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'Print package generation failed: ' + error.message } });
    }
  }
});


// POST /api/workorders/:id/order-material - Create purchase orders for work order materials
router.post('/:id/order-material', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    if (!workOrder) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const { purchaseOrderNumber, partIds } = req.body;

    if (!purchaseOrderNumber) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'Purchase order number is required' } });
    }

    if (!partIds || partIds.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'At least one part must be selected' } });
    }

    // Get selected parts
    const selectedParts = workOrder.parts.filter(p => partIds.includes(p.id));
    
    if (selectedParts.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'No valid parts selected' } });
    }

    // Group parts by vendorId (fall back to supplierName for legacy data)
    const supplierGroups = {};
    for (const part of selectedParts) {
      let groupKey, vendorName, vId;
      if (part.vendorId) {
        const vendor = await Vendor.findByPk(part.vendorId, { transaction });
        groupKey = part.vendorId;
        vendorName = vendor ? vendor.name : 'Unknown Supplier';
        vId = part.vendorId;
      } else {
        groupKey = part.supplierName || 'Unknown Supplier';
        vendorName = groupKey;
        vId = null;
      }
      if (!supplierGroups[groupKey]) {
        supplierGroups[groupKey] = { vendorName, vendorId: vId, parts: [] };
      }
      supplierGroups[groupKey].parts.push(part);
    }

    const groupKeys = Object.keys(supplierGroups).sort();
    const createdOrders = [];
    const basePONumber = parseInt(purchaseOrderNumber);

    // Create inbound order for each supplier
    for (let i = 0; i < groupKeys.length; i++) {
      const group = supplierGroups[groupKeys[i]];
      const { vendorName: supplier, vendorId: vId, parts } = group;
      
      // Generate PO number - increment for each supplier
      const poNumber = basePONumber + i;
      const poNumberFormatted = `PO${poNumber}`;

      // Build description from parts
      const materialDescriptions = parts.map(p => 
        `Part ${p.partNumber}: ${p.materialDescription || p.partType} (Qty: ${p.quantity})`
      ).join('\n');

      // Create PONumber record
      try {
        const existingPO = await PONumber.findOne({ where: { poNumber: poNumber }, transaction });
        if (!existingPO) {
          await PONumber.create({
            poNumber: poNumber,
            status: 'active',
            supplier: supplier,
            vendorId: vId,
            workOrderId: workOrder.id,
            clientName: workOrder.clientName,
            description: materialDescriptions
          }, { transaction });
        }
      } catch (poError) {
        console.error('PO creation error:', poError.message);
      }

      // Create inbound order
      const inboundOrder = await InboundOrder.create({
        purchaseOrderNumber: poNumberFormatted,
        supplier: supplier,
        supplierName: supplier,
        vendorId: vId,
        description: materialDescriptions,
        clientName: workOrder.clientName,
        workOrderId: workOrder.id,
        status: 'pending',
        notes: `Material order for DR-${workOrder.drNumber}\nClient: ${workOrder.clientName}`
      }, { transaction });

      // Update PONumber record with inbound order ID
      try {
        await PONumber.update(
          { inboundOrderId: inboundOrder.id },
          { where: { poNumber: poNumber }, transaction }
        );
      } catch (updateError) {
        console.error('PO update error:', updateError.message);
      }

      createdOrders.push({
        inboundOrder,
        supplier,
        poNumber: poNumberFormatted,
        parts: parts.map(p => ({ id: p.id, partNumber: p.partNumber, description: p.materialDescription }))
      });

      // Update parts with PO info
      for (const part of parts) {
        await part.update({
          materialOrdered: true,
          materialPurchaseOrderNumber: poNumberFormatted,
          materialOrderedAt: new Date(),
          inboundOrderId: inboundOrder.id
        }, { transaction });
      }

      // Generate and upload PO PDF
      try {
        const pdfBuffer = await generatePurchaseOrderPDF(poNumberFormatted, supplier, parts, workOrder);
        
        // Upload PDF
        const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
          folder: 'purchase-orders',
          filename: `${poNumberFormatted}-${workOrder.drNumber}.pdf`,
          mimeType: 'application/pdf'
        });

        // Save document record linked to work order
        await WorkOrderDocument.create({
          workOrderId: workOrder.id,
          originalName: `${poNumberFormatted} - ${supplier}.pdf`,
          mimeType: 'application/pdf',
          size: pdfBuffer.length,
          url: uploadResult.url,
          cloudinaryId: uploadResult.storageId,
          documentType: 'purchase_order'
        }, { transaction });

        console.log(`Generated PO PDF: ${poNumberFormatted} for ${supplier}`);
      } catch (pdfError) {
        console.error('PDF generation error:', pdfError.message);
        // Continue even if PDF fails - the PO record is still created
      }
    }

    // Update next PO number setting
    const nextPO = basePONumber + groupKeys.length;
    await AppSettings.upsert({
      key: 'next_po_number',
      value: { nextNumber: nextPO }
    }, { transaction });

    await transaction.commit();

    // Log activity
    await logActivity(
      'created',
      'purchase_order',
      workOrder.id,
      `PO${basePONumber}`,
      workOrder.clientName,
      `Created ${createdOrders.length} PO(s) for DR-${workOrder.drNumber}`,
      { suppliers: groupKeys.map(k => supplierGroups[k].vendorName), partCount: selectedParts.length }
    );

    res.status(201).json({
      data: {
        purchaseOrders: createdOrders,
        totalOrders: createdOrders.length
      },
      message: `${createdOrders.length} purchase order(s) created`
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Order material error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/services/auto-bulk
// Generate POs for Fab Service parts that have a vendor + cost set but no PO yet.
// Groups by vendor (one PO per vendor regardless of service type).
// Uses the shared PO#### counter (not the legacy OP#### counter).
router.post('/:id/services/auto-bulk', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }],
      transaction
    });
    if (!workOrder) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    // Optional: req.body.vendorIds to restrict to specific vendors (otherwise all eligible)
    const filterVendorIds = Array.isArray(req.body.vendorIds) ? req.body.vendorIds : null;

    // Build groups: { vendorId: { vendorId, vendorName, parts: [{part, op}], totalCost } }
    // Only Fab Service / Shop Rate parts. Group across all service types per vendor.
    const groups = {};
    for (const part of (workOrder.parts || [])) {
      if (!['fab_service', 'shop_rate'].includes(part.partType)) continue;
      const ops = part.outsideProcessing || [];
      for (const op of ops) {
        if (!op.vendorId) continue; // skip ops with no vendor
        if (op.poNumber) continue; // skip ops that already have a PO
        const cost = parseFloat(op.costPerPart) || 0;
        if (cost <= 0) continue; // skip ops with no cost
        if (filterVendorIds && !filterVendorIds.includes(op.vendorId)) continue;
        if (!groups[op.vendorId]) {
          groups[op.vendorId] = {
            vendorId: op.vendorId,
            vendorName: op.vendorName || '',
            parts: [],
            totalCost: 0,
            totalQty: 0
          };
        }
        const qty = parseInt(part.quantity) || 1;
        const expedite = parseFloat(op.expediteCost) || 0;
        groups[op.vendorId].parts.push({ part, op });
        groups[op.vendorId].totalCost += (cost * qty) + expedite;
        groups[op.vendorId].totalQty += qty;
      }
    }

    const groupKeys = Object.keys(groups);
    if (groupKeys.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        error: {
          message: 'No service operations available to PO. Make sure Fab Service parts have a vendor and cost set, and that they don\'t already have a PO.'
        }
      });
    }

    // Pull next PO number from the SHARED counter unless caller provided an override
    let basePONumber;
    if (req.body.startingPONumber !== undefined && req.body.startingPONumber !== null && req.body.startingPONumber !== '') {
      const override = parseInt(req.body.startingPONumber);
      if (isNaN(override) || override <= 0) {
        await transaction.rollback();
        return res.status(400).json({ error: { message: 'Invalid starting PO number' } });
      }
      basePONumber = override;
    } else {
      const poSetting = await AppSettings.findOne({ where: { key: 'next_po_number' }, transaction });
      basePONumber = poSetting?.value?.nextNumber || 1001;
    }

    const created = [];
    const errors = [];

    for (let i = 0; i < groupKeys.length; i++) {
      const group = groups[groupKeys[i]];
      try {
        // Validate vendor exists
        const vendor = await Vendor.findByPk(group.vendorId, { transaction });
        if (!vendor) {
          errors.push({ vendorName: group.vendorName, error: 'Vendor not found in database' });
          continue;
        }

        const poNumberInt = basePONumber + i;
        const poNumber = `PO${poNumberInt}`;

        // Determine a representative service description (concat of unique service types in this group)
        const uniqueServiceTypes = [...new Set(group.parts.map(gp => gp.op.serviceType).filter(Boolean))];
        const repServiceType = uniqueServiceTypes.join(' + ') || 'Subcontracted';

        // Use the first op's notes/expedite for the PO PDF (representative)
        const firstOp = group.parts[0].op;
        const repExpedite = parseFloat(firstOp.expediteCost) || 0;
        // If any op in this group has vendorSuppliesMaterial set, show the vendor-supplies banner
        const groupVendorSupplies = group.parts.some(gp => !!gp.op.vendorSuppliesMaterial);

        // Generate PDF using the existing OP PO template (option A from plan)
        const partsForPdf = group.parts.map(gp => gp.part);
        const pdfBuffer = await generateOutsideProcessingPO(
          poNumber, vendor, partsForPdf, workOrder, repServiceType,
          firstOp.notes || '', null, 0, repExpedite, groupVendorSupplies
        );

        const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
          folder: 'service-pos',
          filename: `${poNumber}-${workOrder.drNumber}.pdf`,
          mimeType: 'application/pdf'
        });

        await WorkOrderDocument.create({
          workOrderId: workOrder.id,
          originalName: `${poNumber} - ${vendor.name}.pdf`,
          mimeType: 'application/pdf',
          size: pdfBuffer.length,
          url: uploadResult.url,
          cloudinaryId: uploadResult.storageId,
          documentType: 'outside_processing_po'
        }, { transaction });

        // Create PONumber row in the shared tracker
        try {
          await PONumber.create({
            poNumber: poNumberInt,
            status: 'active',
            supplier: vendor.name,
            vendorId: vendor.id,
            workOrderId: workOrder.id,
            clientName: workOrder.clientName,
            description: `Service PO: ${repServiceType} — ${group.parts.length} part(s)`
          }, { transaction });
        } catch (poErr) {
          console.warn('[services auto-bulk] PONumber row create failed (may already exist):', poErr.message);
        }

        // Create matching inbound order
        let inboundOrderId = null;
        try {
          const partDescriptions = group.parts
            .map(gp => `#${gp.part.partNumber}${gp.part.clientPartNumber ? ' (' + gp.part.clientPartNumber + ')' : ''} × ${gp.part.quantity}`)
            .join(', ');
          const inbound = await InboundOrder.create({
            purchaseOrderNumber: poNumber,
            supplier: vendor.name,
            supplierName: vendor.name,
            vendorId: vendor.id,
            description: `${repServiceType}: ${partDescriptions}`,
            clientName: workOrder.clientName,
            workOrderId: workOrder.id,
            status: 'pending',
            notes: `Service return — ${repServiceType} from ${vendor.name}\nDR-${workOrder.drNumber}`
          }, { transaction });
          inboundOrderId = inbound.id;
        } catch (e) {
          console.error('[services auto-bulk] Inbound order creation failed:', e.message);
        }

        // Stamp the PO number onto each op in this group, preserving other ops on the same part
        for (const gp of group.parts) {
          const newOps = (gp.part.outsideProcessing || []).map(o => {
            if (o.id === gp.op.id) {
              return { ...o, poNumber, poSentAt: new Date(), inboundOrderId };
            }
            return o;
          });
          await gp.part.update({ outsideProcessing: newOps }, { transaction });
        }

        created.push({
          poNumber,
          vendorName: vendor.name,
          partCount: group.parts.length,
          totalCost: group.totalCost.toFixed(2),
          inboundOrderId
        });

        console.log(`[services auto-bulk] Created ${poNumber} for ${vendor.name} — ${group.parts.length} parts, $${group.totalCost.toFixed(2)}`);
      } catch (groupErr) {
        console.error(`[services auto-bulk] Group failed (${group.vendorName}):`, groupErr.message);
        errors.push({ vendorName: group.vendorName, error: groupErr.message });
      }
    }

    // Update next PO number setting — only advance forward, never backward
    if (created.length > 0) {
      const highestUsed = basePONumber + groupKeys.length;
      const currentSetting = await AppSettings.findOne({ where: { key: 'next_po_number' }, transaction });
      const currentNext = currentSetting?.value?.nextNumber || 1001;
      if (highestUsed > currentNext) {
        await AppSettings.upsert({
          key: 'next_po_number',
          value: { nextNumber: highestUsed }
        }, { transaction });
      }
    }

    await transaction.commit();

    res.json({
      data: { created, errors },
      message: created.length === 1
        ? `Created 1 service PO`
        : `Created ${created.length} service POs${errors.length ? ` (${errors.length} failed)` : ''}`
    });
  } catch (error) {
    await transaction.rollback();
    console.error('[services auto-bulk] Error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/services/:documentId/regen
// Regenerate a service PO PDF using current WO data.
// Finds the vendor from the document name, rebuilds the PDF, replaces the file.
router.post('/:id/services/:documentId/regen', async (req, res, next) => {
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const doc = await WorkOrderDocument.findByPk(req.params.documentId);
    if (!doc) return res.status(404).json({ error: { message: 'Document not found' } });
    if (doc.workOrderId !== workOrder.id) {
      return res.status(400).json({ error: { message: 'Document does not belong to this work order' } });
    }
    if (doc.documentType !== 'outside_processing_po') {
      return res.status(400).json({ error: { message: 'Not a service PO document' } });
    }

    // Extract PO number from document name (format: "PO#### - VendorName.pdf")
    const poMatch = (doc.originalName || '').match(/^(PO\d+)/);
    if (!poMatch) {
      return res.status(400).json({ error: { message: 'Cannot extract PO number from document name' } });
    }
    const poNumber = poMatch[1];

    // Find all parts/ops that reference this PO number
    const groupParts = [];
    let groupVendorId = null;
    for (const part of (workOrder.parts || [])) {
      if (!['fab_service', 'shop_rate'].includes(part.partType)) continue;
      const ops = part.outsideProcessing || [];
      for (const op of ops) {
        if (op.poNumber === poNumber) {
          groupParts.push({ part, op });
          if (!groupVendorId) groupVendorId = op.vendorId;
        }
      }
    }

    if (groupParts.length === 0) {
      return res.status(400).json({ error: { message: 'No parts found with this PO number — cannot regenerate' } });
    }

    const vendor = await Vendor.findByPk(groupVendorId);
    if (!vendor) return res.status(400).json({ error: { message: 'Vendor no longer exists' } });

    // Rebuild service type description + rep op
    const uniqueServiceTypes = [...new Set(groupParts.map(gp => gp.op.serviceType).filter(Boolean))];
    const repServiceType = uniqueServiceTypes.join(' + ') || 'Subcontracted';
    const firstOp = groupParts[0].op;
    const repExpedite = parseFloat(firstOp.expediteCost) || 0;
    // If any op in this group has vendorSuppliesMaterial set, show the vendor-supplies banner
    const groupVendorSupplies = groupParts.some(gp => !!gp.op.vendorSuppliesMaterial);

    // Generate the new PDF
    const partsForPdf = groupParts.map(gp => gp.part);
    const pdfBuffer = await generateOutsideProcessingPO(
      poNumber, vendor, partsForPdf, workOrder, repServiceType,
      firstOp.notes || '', null, 0, repExpedite, groupVendorSupplies
    );

    // Delete the old file from storage (best-effort)
    if (doc.cloudinaryId) {
      try { await fileStorage.deleteFile(doc.cloudinaryId); } catch (e) {
        console.warn('[services regen] Old file delete failed:', e.message);
      }
    }

    // Upload the new file
    const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, {
      folder: 'service-pos',
      filename: `${poNumber}-${workOrder.drNumber}-regen.pdf`,
      mimeType: 'application/pdf'
    });

    // Update the document record
    await doc.update({
      url: uploadResult.url,
      cloudinaryId: uploadResult.storageId,
      size: pdfBuffer.length
    });

    res.json({
      data: { poNumber, vendorName: vendor.name, partCount: groupParts.length },
      message: `Regenerated ${poNumber}`
    });
  } catch (error) {
    console.error('[services regen] Error:', error);
    next(error);
  }
});

// DELETE /api/workorders/:id/services/:documentId
// Delete a service PO: removes document + file, clears JSONB poNumber stamps on matching ops,
// deletes the PONumber row from the shared tracker, and deletes the InboundOrder (if still pending).
router.delete('/:id/services/:documentId', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  try {
    const workOrder = await WorkOrder.findByPk(req.params.id, {
      include: [{ model: WorkOrderPart, as: 'parts' }],
      transaction
    });
    if (!workOrder) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Work order not found' } });
    }

    const doc = await WorkOrderDocument.findByPk(req.params.documentId, { transaction });
    if (!doc) {
      await transaction.rollback();
      return res.status(404).json({ error: { message: 'Document not found' } });
    }
    if (doc.workOrderId !== workOrder.id) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'Document does not belong to this work order' } });
    }
    if (doc.documentType !== 'outside_processing_po') {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'Not a service PO document — use the regular delete endpoint' } });
    }

    // Extract PO number from document name
    const poMatch = (doc.originalName || '').match(/^(PO\d+)/);
    if (!poMatch) {
      await transaction.rollback();
      return res.status(400).json({ error: { message: 'Cannot extract PO number from document name' } });
    }
    const poNumber = poMatch[1];
    const poNumberInt = parseInt(poNumber.replace('PO', ''));

    // Clear poNumber stamps on all matching ops in JSONB
    let partsUpdated = 0;
    for (const part of (workOrder.parts || [])) {
      if (!['fab_service', 'shop_rate'].includes(part.partType)) continue;
      const ops = part.outsideProcessing || [];
      let modified = false;
      const newOps = ops.map(op => {
        if (op.poNumber === poNumber) {
          modified = true;
          const { poNumber: _, poSentAt: __, inboundOrderId: ___, ...rest } = op;
          return rest;
        }
        return op;
      });
      if (modified) {
        await part.update({ outsideProcessing: newOps }, { transaction });
        partsUpdated++;
      }
    }

    // Delete the PONumber row from the shared tracker
    try {
      await PONumber.destroy({ where: { poNumber: poNumberInt, workOrderId: workOrder.id }, transaction });
    } catch (e) {
      console.warn('[services delete] PONumber delete failed:', e.message);
    }

    // Delete the InboundOrder (only if still pending — don't touch received shipments)
    try {
      await InboundOrder.destroy({
        where: { purchaseOrderNumber: poNumber, workOrderId: workOrder.id, status: 'pending' },
        transaction
      });
    } catch (e) {
      console.warn('[services delete] InboundOrder delete failed:', e.message);
    }

    // Delete the file from storage (best-effort)
    if (doc.cloudinaryId) {
      try { await fileStorage.deleteFile(doc.cloudinaryId); } catch (e) {
        console.warn('[services delete] File delete failed:', e.message);
      }
    }

    // Delete the document record
    await doc.destroy({ transaction });

    await transaction.commit();

    res.json({
      data: { poNumber, partsUpdated },
      message: `Deleted ${poNumber}. ${partsUpdated} part(s) can now be re-ordered.`
    });
  } catch (error) {
    await transaction.rollback();
    console.error('[services delete] Error:', error);
    next(error);
  }
});

// ============= ESTIMATE LINKING =============

// GET /api/workorders/linkable-estimates - Search for estimates that can be linked
router.get('/linkable-estimates/search', async (req, res, next) => {
  try {
    const { EstimateLinkService } = require('../services/EstimateLinkService');
    const models = require('../models');
    const linkService = new (require('../services/EstimateLinkService'))(models);
    
    const estimates = await linkService.searchLinkableEstimates(req.query.q);
    
    res.json({
      data: estimates.map(est => ({
        id: est.id,
        estimateNumber: est.estimateNumber,
        clientName: est.clientName,
        contactName: est.contactName,
        projectDescription: est.projectDescription,
        status: est.status,
        grandTotal: est.grandTotal,
        partCount: est.parts?.length || 0,
        createdAt: est.createdAt
      }))
    });
  } catch (error) {
    console.error('Search linkable estimates error:', error);
    next(error);
  }
});

// POST /api/workorders/:id/link-estimate - Link an estimate to this work order
router.post('/:id/link-estimate', async (req, res, next) => {
  try {
    const models = require('../models');
    const linkService = new (require('../services/EstimateLinkService'))(models);
    
    const { estimateId } = req.body;
    
    if (!estimateId) {
      return res.status(400).json({ error: { message: 'estimateId is required' } });
    }

    const result = await linkService.linkEstimateToWorkOrder(req.params.id, estimateId);
    
    res.json({
      data: result.workOrder,
      message: result.message,
      partsCopied: result.partsCopied
    });
  } catch (error) {
    console.error('Link estimate error:', error);
    if (error.message.includes('not found') || error.message.includes('already linked')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    next(error);
  }
});

// POST /api/workorders/:id/unlink-estimate - Unlink an estimate from this work order
router.post('/:id/unlink-estimate', async (req, res, next) => {
  try {
    const models = require('../models');
    const linkService = new (require('../services/EstimateLinkService'))(models);
    
    const result = await linkService.unlinkEstimate(req.params.id);
    
    res.json(result);
  } catch (error) {
    console.error('Unlink estimate error:', error);
    if (error.message.includes('No estimate linked')) {
      return res.status(400).json({ error: { message: error.message } });
    }
    next(error);
  }
});

// POST /api/workorders/repair-pricing - Scan WOs for missing pricing and backfill from linked estimates
router.post('/repair-pricing', async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    const { ORDER_FIELD_MAP, PART_SHARED_FIELDS } = require('../services/pricing');
    
    // Find all WOs linked to estimates
    const workOrders = await WorkOrder.findAll({
      where: { estimateId: { [Op.ne]: null } },
      include: [{ model: WorkOrderPart, as: 'parts' }]
    });

    let orderFieldsRepaired = 0;
    let partsRepaired = 0;
    const details = [];

    for (const wo of workOrders) {
      const estimate = await Estimate.findByPk(wo.estimateId, {
        include: [{ model: EstimatePart, as: 'parts' }]
      });
      if (!estimate) continue;

      // Repair order-level fields — copy anything present on estimate but missing on WO
      const orderUpdates = {};
      for (const [estField, woField] of Object.entries(ORDER_FIELD_MAP)) {
        const estVal = estimate[estField];
        const woVal = wo[woField];
        // Only repair if estimate has a value and WO is missing it
        if (estVal !== null && estVal !== undefined && estVal !== '' && estVal !== false) {
          if (woVal === null || woVal === undefined || woVal === '') {
            orderUpdates[woField] = estVal;
          }
        }
      }
      // Also check totals
      if ((!wo.subtotal || parseFloat(wo.subtotal) === 0) && estimate.partsSubtotal) {
        orderUpdates.subtotal = estimate.partsSubtotal;
      }
      if ((!wo.grandTotal || parseFloat(wo.grandTotal) === 0) && estimate.grandTotal) {
        orderUpdates.grandTotal = estimate.grandTotal;
        orderUpdates.estimateTotal = estimate.grandTotal;
      }
      if ((!wo.taxAmount || parseFloat(wo.taxAmount) === 0) && estimate.taxAmount) {
        orderUpdates.taxAmount = estimate.taxAmount;
      }

      if (Object.keys(orderUpdates).length > 0) {
        await wo.update(orderUpdates);
        orderFieldsRepaired++;
        details.push(`DR-${wo.drNumber}: order-level fields repaired: ${Object.keys(orderUpdates).join(', ')}`);
      }

      // Repair parts by matching partNumber
      for (const woPart of wo.parts) {
        const estPart = estimate.parts.find(ep => ep.partNumber === woPart.partNumber);
        if (!estPart) continue;

        const estFd = estPart.formData && typeof estPart.formData === 'object' ? estPart.formData : {};
        const woLabor = parseFloat(woPart.laborTotal) || 0;
        const woMaterial = parseFloat(woPart.materialTotal) || 0;
        const woTotal = parseFloat(woPart.partTotal) || 0;
        const estLabor = parseFloat(estPart.laborTotal) || parseFloat(estFd.laborTotal) || 0;
        const estMaterial = parseFloat(estPart.materialTotal) || parseFloat(estFd.materialTotal) || 0;
        const estTotal = parseFloat(estPart.partTotal) || parseFloat(estFd.partTotal) || 0;

        if ((woLabor === 0 && estLabor > 0) || (woTotal === 0 && estTotal > 0) || (woMaterial === 0 && estMaterial > 0)) {
          const updates = {};
          
          // Copy all pricing fields from estimate using shared field list
          const pricingColumns = ['laborRate', 'laborHours', 'laborTotal', 'materialUnitCost', 'materialMarkupPercent', 'materialTotal', 'setupCharge', 'otherCharges', 'partTotal'];
          for (const field of pricingColumns) {
            const estVal = estPart[field] || estFd[field];
            const woVal = woPart[field];
            if (estVal && (!woVal || parseFloat(woVal) === 0)) {
              updates[field] = estVal;
            }
          }

          // Merge formData pricing fields
          const woFd = woPart.formData && typeof woPart.formData === 'object' ? { ...woPart.formData } : {};
          const pricingFdFields = ['laborRate', 'laborHours', 'laborTotal', 'materialTotal', 'materialMarkupPercent', 'materialUnitCost', 'partTotal', 'setupCharge', 'otherCharges', '_materialRounding', '_rollingDescription', '_materialDescription'];
          let fdChanged = false;
          for (const f of pricingFdFields) {
            if (estFd[f] !== undefined && (woFd[f] === undefined || woFd[f] === null || woFd[f] === '' || woFd[f] === 0)) {
              woFd[f] = estFd[f];
              fdChanged = true;
            }
          }
          if (fdChanged) updates.formData = woFd;

          if (Object.keys(updates).length > 0) {
            await woPart.update(updates);
            partsRepaired++;
            details.push(`DR-${wo.drNumber} Part #${woPart.partNumber} (${woPart.partType}): labor $${woLabor}→$${estLabor}, material $${woMaterial}→$${estMaterial}, total $${woTotal}→$${estTotal}`);
          }
        }
      }
    }

    console.log(`[repair-pricing] Scanned ${workOrders.length} WOs: ${orderFieldsRepaired} order-level, ${partsRepaired} parts`);

    res.json({
      data: {
        scanned: workOrders.length,
        orderFieldsRepaired,
        partsRepaired,
        details
      },
      message: `Scanned ${workOrders.length} work orders: ${partsRepaired} parts repaired, ${orderFieldsRepaired} orders repaired`
    });
  } catch (error) {
    console.error('[repair-pricing] Error:', error.message);
    next(error);
  }
});

// POST /api/workorders/:id/coc - Generate Certificate of Conformance PDF
router.post('/:id/coc', async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const { WeldProcedure } = require('../models');
    const workOrder = await WorkOrder.findByPk(req.params.id, { include: [{ model: WorkOrderPart, as: 'parts' }] });
    if (!workOrder) return res.status(404).json({ error: { message: 'Work order not found' } });

    const { wpsId, certifiedBy, certDate } = req.body;
    const wps = wpsId ? await WeldProcedure.findByPk(wpsId) : null;
    const dateStr = certDate ? new Date(certDate + 'T12:00:00').toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: 'numeric' }) : new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: 'numeric' });

    const doc = new PDFDocument({ margin: 50, size: 'letter' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const logoFile = [path.join(__dirname, '../assets/logo.png'), path.join(__dirname, '../assets/logo.jpg')].find(p => fs.existsSync(p));
    const primaryColor = '#1976d2', darkColor = '#333', grayColor = '#666';
    let pageNum = 1;
    const writeFooter = () => {
      const savedY = doc.y;
      doc.page.margins.bottom = 0; // temporarily remove bottom margin
      doc.font('Helvetica').fontSize(7).fillColor(grayColor);
      doc.text('Carolina Rolling Co. Inc. | (562) 633-1044 | keepitrolling@carolinarolling.com          Page ' + pageNum, 50, 755, { width: 512, align: 'center', lineBreak: false });
      doc.page.margins.bottom = 50; // restore
      doc.y = savedY; // restore cursor
    };
    const newPage = () => { writeFooter(); pageNum++; doc.addPage(); };
    const yellowcakePath = path.join(__dirname, '../assets/fonts/Yellowcake-Regular.ttf');
    let hasYellowcake = false;
    try { if (fs.existsSync(yellowcakePath)) { doc.registerFont('Yellowcake', yellowcakePath); hasYellowcake = true; } } catch {}

    const drawCompanyName = (x, yy) => {
      if (hasYellowcake) doc.font('Yellowcake').fontSize(15).fillColor(darkColor).text('Carolina Rolling Co. Inc.', x, yy);
      else doc.font('Helvetica-Bold').fontSize(15).fillColor(darkColor).text('CAROLINA ROLLING CO. INC.', x, yy);
    };

    // ===== PAGE 1 HEADER (only on first page) =====
    if (logoFile) try { doc.image(logoFile, 50, 18, { width: 58 }); } catch {}
    drawCompanyName(125, 28);
    doc.font('Helvetica').fontSize(8.5).fillColor(grayColor);
    doc.text('9152 Sonrisa St., Bellflower, CA 90706', 125, 48);
    doc.text('Phone: (562) 633-1044  |  Email: keepitrolling@carolinarolling.com', 125, 60);

    // Title block — top right
    doc.font('Helvetica-Bold').fontSize(11).fillColor(primaryColor);
    doc.text('CERTIFICATE OF CONFORMANCE', 340, 28, { width: 222, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor);
    doc.text('Job No: ' + String(workOrder.drNumber || ''), 340, 48, { width: 222, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(grayColor);
    doc.text('Date: ' + dateStr, 340, 62, { width: 222, align: 'right' });

    // Divider below header
    doc.moveTo(50, 82).lineTo(562, 82).lineWidth(1).strokeColor('#e0e0e0').stroke();

    // Customer section — left justified, not bold, proper spacing
    let y = 94;
    doc.font('Helvetica').fontSize(8).fillColor(grayColor);
    doc.text('Customer', 50, y);
    y += 14;
    doc.font('Helvetica').fontSize(10).fillColor(darkColor);
    doc.text(workOrder.clientName || '', 50, y);
    y += 14;
    const client = await Client.findOne({ where: { name: workOrder.clientName || '' } });
    if (client) {
      doc.font('Helvetica').fontSize(9).fillColor(grayColor);
      if (client.address) { doc.text(client.address, 50, y); y += 12; }
      let cl = '';
      if (client.city) cl += client.city;
      if (client.state) cl += (cl ? ', ' : '') + client.state;
      if (client.zip) cl += ' ' + client.zip;
      if (cl) { doc.text(cl, 50, y); y += 12; }
    }
    y += 6;
    doc.font('Helvetica').fontSize(9).fillColor(grayColor);
    doc.text('Customer P.O: ' + (workOrder.clientPurchaseOrderNumber || '—'), 50, y);
    y += 20;

    // Parts table
    doc.moveTo(50, y).lineTo(562, y).lineWidth(0.5).strokeColor('#e0e0e0').stroke();
    y += 8;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(grayColor);
    doc.text('QTY', 50, y, { width: 30 });
    doc.text('PART NUMBER', 85, y);
    doc.text('SIZE / MATERIAL', 200, y);
    y += 12;
    doc.moveTo(50, y).lineTo(562, y).lineWidth(0.3).strokeColor('#ddd').stroke();
    y += 7;

    const parts = (workOrder.parts || []).filter(p => !['fab_service', 'shop_rate', 'rush_service'].includes(p.partType));
    for (let i = 0; i < parts.length; i++) {
      // Page break — no header on continuation pages, just start from top margin
      if (y > 690) { newPage(); y = 50; }
      // Merge formData fields and rebuild derived fields so _rollingDescription is always populated
      const p = mergeFormData(parts[i]);
      refreshDerivedFields(p);
      const fd = p.formData && typeof p.formData === 'object' ? p.formData : {};
      let matDesc = p._materialDescription || fd._materialDescription || p.materialDescription || '';
      // Strip leading "1pc: " or "5pc: " prefix — qty is already in its own column
      matDesc = matDesc.replace(/^\d+pc:\s*/i, '');
      const rollDesc = p._rollingDescription || fd._rollingDescription || p.rollingDescription || '';

      doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor);
      doc.text(String(p.quantity || 1), 50, y, { width: 30 });
      doc.font('Helvetica').fontSize(9).fillColor(darkColor);
      doc.text(p.clientPartNumber || 'SEE DESCRIPTION', 85, y, { width: 110 });
      if (matDesc) {
        doc.font('Helvetica').fontSize(9).fillColor(darkColor);
        doc.text(matDesc, 200, y, { width: 360 });
        y += doc.heightOfString(matDesc, { width: 360 }) + 1;
      } else { y += 12; }
      if (rollDesc) {
        doc.font('Helvetica').fontSize(8.5).fillColor(grayColor);
        doc.text(rollDesc, 200, y, { width: 360 });
        y += doc.heightOfString(rollDesc, { width: 360 }) + 1;
      }
      if (p.specialInstructions) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#999');
        doc.text(p.specialInstructions, 200, y, { width: 360 });
        y += doc.heightOfString(p.specialInstructions, { width: 360 }) + 1;
      }
      y += 4;
      if (i < parts.length - 1) {
        doc.moveTo(85, y).lineTo(562, y).lineWidth(0.3).strokeColor('#eee').stroke();
        y += 4;
      }
    }

    // Certification — check if fits, else new page
    if (y > 640) { newPage(); y = 50; }
    y += 16;
    doc.moveTo(50, y).lineTo(562, y).lineWidth(0.5).strokeColor('#e0e0e0').stroke();
    y += 12;
    doc.font('Helvetica').fontSize(9).fillColor(darkColor);
    doc.text('We hereby certify that parts described above were cold formed and comply with', 50, y, { width: 512, align: 'center' });
    y += 13;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor);
    doc.text('ASME Section VIII Div.1, UG-79, UG-80, & UCS-79', 50, y, { width: 512, align: 'center' });
    y += 26;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(darkColor).text('Certified By:', 50, y); y += 13;
    doc.font('Helvetica-Bold').fontSize(11).text(certifiedBy || 'Jason Thornton', 50, y); y += 13;
    doc.font('Helvetica').fontSize(9).fillColor(grayColor).text('Carolina Rolling Co., Inc.', 50, y); y += 13;
    doc.text('Date: ' + dateStr, 50, y);

    // WPS page
    if (wps) {
      newPage();
      // WPS header — only on WPS page
      if (logoFile) try { doc.image(logoFile, 50, 18, { width: 58 }); } catch {}
      drawCompanyName(125, 28);
      doc.font('Helvetica').fontSize(8.5).fillColor(grayColor);
      doc.text('9152 Sonrisa St., Bellflower, CA 90706', 125, 48);
      doc.text('Phone: (562) 633-1044  |  Email: keepitrolling@carolinarolling.com', 125, 60);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(primaryColor);
      doc.text('WELDING PROCEDURE SPECIFICATION', 340, 28, { width: 222, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor);
      doc.text('WPS: ' + (wps.wpsNumber || ''), 340, 48, { width: 222, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(grayColor);
      doc.text('Date: ' + new Date(wps.updatedAt || wps.createdAt).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: '2-digit' }), 340, 62, { width: 222, align: 'right' });
      doc.moveTo(50, 82).lineTo(562, 82).lineWidth(1).strokeColor('#e0e0e0').stroke();

      let wy = 96;
      const wR = (l, v) => { if (!v) return; doc.font('Helvetica-Bold').fontSize(9).fillColor(grayColor).text(l, 50, wy, { width: 130 }); doc.font('Helvetica').fontSize(9).fillColor(darkColor).text(v, 185, wy, { width: 370 }); wy += 15; };
      const wH = (t) => { wy += 5; doc.font('Helvetica-Bold').fontSize(9).fillColor(primaryColor).text(t, 50, wy); wy += 12; doc.moveTo(50, wy).lineTo(562, wy).lineWidth(0.3).strokeColor('#ddd').stroke(); wy += 7; };
      wR('Process', wps.process); wR('Type', wps.processType);
      wH('Base Materials'); wR('Base Materials', wps.baseMaterials);
      wH('Filler'); wR('SFA Specification', wps.sfaSpecification); wR('AWS Classification', wps.awsClassification); wR('Size', wps.fillerSize);
      wH('Technique'); wR('Welding Position', wps.weldingPosition); wR('Bead Type', wps.beadType); wR('Joint Type', wps.jointType);
      wR('Back Gouging', wps.backGouging); wR('Pass Type', wps.passType); wR('Preheat', wps.preheat); wR('Current', wps.current); wR('Voltage', wps.voltage);
      if (wps.notes) {
        wH('Notes / Procedure');
        doc.font('Helvetica').fontSize(8.5).fillColor(darkColor);
        wps.notes.split('\n').forEach(ln => { if (ln.trim()) { doc.text(ln.trim(), 50, wy, { width: 512 }); wy += doc.heightOfString(ln.trim(), { width: 512 }) + 2; } });
      }
      wy += 14; doc.moveTo(50, wy).lineTo(562, wy).lineWidth(0.5).strokeColor('#e0e0e0').stroke(); wy += 10;
      doc.font('Helvetica').fontSize(8).fillColor(grayColor);
      doc.text('Updated by: ' + (wps.updatedBy || 'Jason Thornton'), 50, wy); wy += 11;
      doc.text('Date: ' + new Date(wps.updatedAt || wps.createdAt).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: '2-digit' }), 50, wy); wy += 11;
      doc.text('Signature: ' + (wps.updatedBy || 'Jason Thornton'), 50, wy);
    }

    // Write footer on final page
    writeFooter();

    doc.end();
    await new Promise(resolve => doc.on('end', resolve));
    const pdfBuffer = Buffer.concat(chunks);

    // Auto-save to WO documents
    try {
      const cocFilename = `COC-${workOrder.drNumber}${wps ? '-WPS-' + wps.wpsNumber : ''}.pdf`;
      const uploadResult = await fileStorage.uploadBuffer(pdfBuffer, { folder: `work-orders/${workOrder.id}/documents`, filename: cocFilename, mimeType: 'application/pdf' });
      const prevCoc = await WorkOrderDocument.findOne({ where: { workOrderId: workOrder.id, documentType: 'coc' } });
      if (prevCoc) await prevCoc.destroy();
      await WorkOrderDocument.create({ workOrderId: workOrder.id, originalName: cocFilename, mimeType: 'application/pdf', size: pdfBuffer.length, url: uploadResult.url, cloudinaryId: uploadResult.storageId, documentType: 'coc', portalVisible: true });
    } catch (saveErr) { console.error('[COC] Save error:', saveErr.message); }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `inline; filename="COC-DR${workOrder.drNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) { console.error('[COC] Error:', error); next(error); }
});

// ===== VENDOR PORTAL ADMIN ENDPOINTS =====

// PUT /api/workorders/:id/parts/:partId/files/:fileId/vendor-share
// Toggle whether a file is shared with the vendor portal
router.put('/:id/parts/:partId/files/:fileId/vendor-share', async (req, res, next) => {
  try {
    const { visible } = req.body;
    const file = await WorkOrderPartFile.findOne({
      where: { id: req.params.fileId, workOrderPartId: req.params.partId }
    });
    if (!file) return res.status(404).json({ error: { message: 'File not found' } });
    await file.update({ vendorPortalVisible: !!visible });
    res.json({
      data: { id: file.id, vendorPortalVisible: file.vendorPortalVisible },
      message: visible ? 'File shared with vendor portal' : 'File hidden from vendor portal'
    });
  } catch (error) {
    console.error('[vendor-share] Error:', error);
    next(error);
  }
});

// GET /api/workorders/:id/vendor-issues
// List all vendor-reported issues on this work order
router.get('/:id/vendor-issues', async (req, res, next) => {
  try {
    const { VendorIssue } = require('../models');
    const issues = await VendorIssue.findAll({
      where: { workOrderId: req.params.id },
      include: [{ model: WorkOrderPart, as: 'workOrderPart', attributes: ['id', 'partNumber', 'clientPartNumber'] }],
      order: [['reportedAt', 'DESC']]
    });
    res.json({ data: issues });
  } catch (error) {
    console.error('[vendor-issues] List error:', error);
    next(error);
  }
});

// PUT /api/workorders/:id/vendor-issues/:issueId/resolve
// Mark a vendor issue as resolved with resolution notes
router.put('/:id/vendor-issues/:issueId/resolve', async (req, res, next) => {
  try {
    const { VendorIssue } = require('../models');
    const { resolutionNotes, resolvedBy } = req.body;
    if (!resolutionNotes || !resolutionNotes.trim()) {
      return res.status(400).json({ error: { message: 'Resolution notes are required' } });
    }
    const issue = await VendorIssue.findOne({
      where: { id: req.params.issueId, workOrderId: req.params.id }
    });
    if (!issue) return res.status(404).json({ error: { message: 'Issue not found' } });
    await issue.update({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: resolvedBy || (req.user?.username || 'Admin'),
      resolutionNotes: resolutionNotes.trim()
    });
    res.json({ data: issue, message: 'Issue marked as resolved' });
  } catch (error) {
    console.error('[vendor-issues] Resolve error:', error);
    next(error);
  }
});

// PUT /api/workorders/:id/vendor-issues/:issueId/acknowledge
// Mark a vendor issue as acknowledged (seen but not yet resolved)
router.put('/:id/vendor-issues/:issueId/acknowledge', async (req, res, next) => {
  try {
    const { VendorIssue } = require('../models');
    const issue = await VendorIssue.findOne({
      where: { id: req.params.issueId, workOrderId: req.params.id }
    });
    if (!issue) return res.status(404).json({ error: { message: 'Issue not found' } });
    await issue.update({ status: 'acknowledged' });
    res.json({ data: issue, message: 'Issue acknowledged' });
  } catch (error) {
    console.error('[vendor-issues] Acknowledge error:', error);
    next(error);
  }
});

module.exports = router;
