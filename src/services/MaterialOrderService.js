// ============= MATERIAL ORDER SERVICE =============
// Handles material ordering, PO creation, and PDF generation

const { Op } = require('sequelize');
const cloudinary = require('cloudinary').v2;

class MaterialOrderService {
  constructor(models) {
    this.models = models;
  }

  // Get orderable parts for a work order
  async getOrderableParts(workOrderId) {
    const { WorkOrderPart } = this.models;

    return WorkOrderPart.findAll({
      where: {
        workOrderId,
        materialSource: 'we_order',
        [Op.or]: [
          { materialOrdered: false },
          { materialOrdered: null }
        ],
        materialDescription: { [Op.ne]: null }
      },
      order: [['partNumber', 'ASC']]
    });
  }

  // Create purchase orders for selected parts
  async createPurchaseOrders(workOrderId, partIds, basePONumber) {
    const { WorkOrder, WorkOrderPart, WorkOrderDocument, PONumber, InboundOrder, AppSettings, sequelize } = this.models;
    const transaction = await sequelize.transaction();

    try {
      const workOrder = await WorkOrder.findByPk(workOrderId, {
        include: [{ model: WorkOrderPart, as: 'parts' }],
        transaction
      });

      if (!workOrder) {
        await transaction.rollback();
        throw new Error('Work order not found');
      }

      if (!basePONumber) {
        await transaction.rollback();
        throw new Error('Purchase order number is required');
      }

      if (!partIds || partIds.length === 0) {
        await transaction.rollback();
        throw new Error('At least one part must be selected');
      }

      // Get selected parts
      const selectedParts = workOrder.parts.filter(p => partIds.includes(p.id));
      
      if (selectedParts.length === 0) {
        await transaction.rollback();
        throw new Error('No valid parts selected');
      }

      // Log for debugging
      console.log('Selected parts for ordering:', selectedParts.map(p => ({
        id: p.id,
        partNumber: p.partNumber,
        supplierName: p.supplierName,
        materialSource: p.materialSource,
        materialDescription: p.materialDescription
      })));

      // Group parts by supplier
      const supplierGroups = {};
      selectedParts.forEach(part => {
        const supplier = part.supplierName || 'Unknown Supplier';
        if (!supplierGroups[supplier]) {
          supplierGroups[supplier] = [];
        }
        supplierGroups[supplier].push(part);
      });

      const suppliers = Object.keys(supplierGroups).sort();
      const createdOrders = [];
      const poNumberBase = parseInt(basePONumber);

      // Create inbound order and PO for each supplier
      for (let i = 0; i < suppliers.length; i++) {
        const supplier = suppliers[i];
        const parts = supplierGroups[supplier];
        
        const poNumber = poNumberBase + i;
        const poNumberFormatted = `PO${poNumber}`;

        // Build description from parts
        const materialDescriptions = parts.map(p => 
          `Part ${p.partNumber}: ${p.materialDescription || p.partType} (Qty: ${p.quantity})`
        ).join('\n');

        // Create PONumber record
        const existingPO = await PONumber.findOne({ where: { poNumber }, transaction });
        if (!existingPO) {
          await PONumber.create({
            poNumber,
            status: 'active',
            supplier,
            workOrderId: workOrder.id,
            clientName: workOrder.clientName,
            description: materialDescriptions
          }, { transaction });
        }

        // Create inbound order
        const inboundOrder = await InboundOrder.create({
          purchaseOrderNumber: poNumberFormatted,
          supplier,
          supplierName: supplier,
          description: materialDescriptions,
          clientName: workOrder.clientName,
          workOrderId: workOrder.id,
          status: 'pending',
          notes: `Material order for DR-${workOrder.drNumber}\nClient: ${workOrder.clientName}`
        }, { transaction });

        // Update PONumber with inbound order ID
        await PONumber.update(
          { inboundOrderId: inboundOrder.id },
          { where: { poNumber }, transaction }
        );

        // Update parts with PO number and inbound order reference
        for (const part of parts) {
          await WorkOrderPart.update({
            materialOrdered: true,
            materialOrderedAt: new Date(),
            materialPurchaseOrderNumber: poNumberFormatted,
            inboundOrderId: inboundOrder.id
          }, { where: { id: part.id }, transaction });
        }

        // Generate and upload PDF
        try {
          const pdfBuffer = await this.generatePurchaseOrderPDF(
            poNumberFormatted, supplier, parts, workOrder
          );

          const uploadResult = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
              {
                resource_type: 'raw',
                folder: `work-orders/${workOrder.id}/purchase-orders`,
                public_id: `${poNumberFormatted}`,
                format: 'pdf'
              },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            );
            uploadStream.end(pdfBuffer);
          });

          // Save document reference
          await WorkOrderDocument.create({
            workOrderId: workOrder.id,
            filename: `${poNumberFormatted}.pdf`,
            originalName: `${poNumberFormatted}.pdf`,
            mimeType: 'application/pdf',
            size: pdfBuffer.length,
            url: uploadResult.secure_url,
            cloudinaryId: uploadResult.public_id,
            documentType: 'purchase_order'
          }, { transaction });

        } catch (pdfError) {
          console.error('PDF generation error:', pdfError);
          // Continue even if PDF fails
        }

        createdOrders.push({
          poNumber: poNumberFormatted,
          supplier,
          inboundOrderId: inboundOrder.id,
          partCount: parts.length
        });
      }

      // Update next PO number setting
      const nextPONumber = poNumberBase + suppliers.length;
      await AppSettings.upsert({
        key: 'next_po_number',
        value: { nextNumber: nextPONumber }
      }, { transaction });

      await transaction.commit();

      return {
        success: true,
        orders: createdOrders,
        message: `Created ${createdOrders.length} purchase order(s)`
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Generate Purchase Order PDF
  async generatePurchaseOrderPDF(poNumber, supplier, parts, workOrder) {
    const PDFDocument = require('pdfkit');
    
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const chunks = [];
        
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        
        // Header
        doc.fontSize(24).font('Helvetica-Bold').text('PURCHASE ORDER', { align: 'center' });
        doc.moveDown(0.5);
        
        // PO Number
        doc.fontSize(16).fillColor('#1976d2').text(poNumber, { align: 'center' });
        doc.fillColor('black');
        doc.moveDown(1);
        
        // Company Info
        const startY = doc.y;
        doc.fontSize(10).font('Helvetica-Bold').text('FROM:');
        doc.font('Helvetica');
        doc.text('Carolina Rolling');
        doc.text('2657 Regional Rd S');
        doc.text('Greensboro, NC 27409');
        doc.text('Phone: (336) 668-4430');
        
        // Supplier Info
        doc.y = startY;
        doc.x = 300;
        doc.font('Helvetica-Bold').text('TO:');
        doc.font('Helvetica');
        doc.text(supplier);
        
        doc.x = 50;
        doc.moveDown(2);
        
        // Order Info
        doc.font('Helvetica-Bold').text(`Date: `, { continued: true });
        doc.font('Helvetica').text(new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }));
        
        if (workOrder.drNumber) {
          doc.font('Helvetica-Bold').text(`DR Number: `, { continued: true });
          doc.font('Helvetica').text(`DR-${workOrder.drNumber}`);
        }
        
        if (workOrder.clientName) {
          doc.font('Helvetica-Bold').text(`Client: `, { continued: true });
          doc.font('Helvetica').text(workOrder.clientName);
        }
        
        doc.moveDown(1);
        
        // Parts Table Header
        doc.font('Helvetica-Bold');
        const tableTop = doc.y;
        doc.text('Part #', 50, tableTop, { width: 50 });
        doc.text('Description', 100, tableTop, { width: 250 });
        doc.text('Qty', 350, tableTop, { width: 50 });
        doc.text('Notes', 400, tableTop, { width: 150 });
        
        doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
        
        // Parts Table Body
        doc.font('Helvetica');
        let y = tableTop + 25;
        
        for (const part of parts) {
          if (y > 700) {
            doc.addPage();
            y = 50;
          }
          
          doc.text(part.partNumber.toString(), 50, y, { width: 50 });
          doc.text(part.materialDescription || part.partType || '-', 100, y, { width: 250 });
          doc.text((part.quantity || 1).toString(), 350, y, { width: 50 });
          doc.text(part.specialInstructions || '-', 400, y, { width: 150 });
          
          y += 20;
        }
        
        // Footer
        doc.moveDown(3);
        doc.fontSize(10).text('Please confirm receipt of this order.', { align: 'center' });
        doc.text('Thank you for your business!', { align: 'center' });
        
        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}

module.exports = MaterialOrderService;
