/**
 * Migration: Convert existing Shipments to Work Orders
 * 
 * This script converts all existing shipments in the database to work orders
 * so they appear in the new Inventory page.
 */

const { Shipment, WorkOrder, WorkOrderPart, DRNumber, sequelize } = require('../models');

async function migrate() {
  console.log('Starting shipment to work order conversion...\n');
  
  try {
    // Ensure tables exist
    await sequelize.sync();
    
    // Get all shipments
    const shipments = await Shipment.findAll({
      order: [['createdAt', 'ASC']]
    });
    
    console.log(`Found ${shipments.length} shipments to convert\n`);
    
    if (shipments.length === 0) {
      console.log('No shipments to convert.');
      return;
    }
    
    // Get current max DR number
    let nextDRNumber = 1;
    const maxDR = await DRNumber.findOne({
      order: [['drNumber', 'DESC']]
    });
    if (maxDR) {
      nextDRNumber = maxDR.drNumber + 1;
    }
    
    // Also check work orders for max DR
    const maxWODR = await WorkOrder.max('drNumber');
    if (maxWODR && maxWODR >= nextDRNumber) {
      nextDRNumber = maxWODR + 1;
    }
    
    console.log(`Starting DR numbers from: ${nextDRNumber}\n`);
    
    let converted = 0;
    let skipped = 0;
    
    for (const shipment of shipments) {
      // Check if work order already exists for this shipment (by qrCode or id)
      const existingWO = await WorkOrder.findOne({
        where: { orderNumber: shipment.qrCode || shipment.id }
      });
      
      if (existingWO) {
        console.log(`  Skipping ${shipment.qrCode || shipment.id} - work order already exists`);
        skipped++;
        continue;
      }
      
      // Determine status mapping
      let woStatus = 'in_progress';
      if (shipment.status === 'completed' || shipment.status === 'shipped') {
        woStatus = 'completed';
      } else if (shipment.status === 'received') {
        woStatus = 'in_progress';
      } else if (shipment.status === 'pending') {
        woStatus = 'pending';
      }
      
      // Create work order using correct shipment fields
      const workOrder = await WorkOrder.create({
        orderNumber: shipment.qrCode || `WO-${shipment.id.substring(0, 8)}`,
        drNumber: nextDRNumber,
        clientName: shipment.clientName || 'Unknown Client',
        clientPO: shipment.clientPurchaseOrderNumber || null,
        jobNumber: shipment.jobNumber || null,
        projectDescription: shipment.description || null,
        status: woStatus,
        priority: 'normal',
        storageLocation: shipment.location || null,
        promisedDate: shipment.promisedDate || shipment.requestedDueDate || null,
        notes: shipment.notes || null,
        allMaterialReceived: true,
        createdAt: shipment.createdAt,
        updatedAt: shipment.updatedAt
      });
      
      // Record DR number assignment
      await DRNumber.create({
        drNumber: nextDRNumber,
        workOrderId: workOrder.id,
        clientName: shipment.clientName || 'Unknown Client',
        assignedAt: shipment.createdAt || new Date(),
        assignedBy: 'migration'
      });
      
      // Create a default part from shipment info
      await WorkOrderPart.create({
        workOrderId: workOrder.id,
        partNumber: 1,
        partType: 'other',
        quantity: shipment.quantity || 1,
        materialDescription: shipment.description || 'Converted from shipment',
        clientPartNumber: shipment.partNumbers || null,
        materialReceived: true,
        status: woStatus === 'completed' ? 'completed' : 'in_progress'
      });
      
      console.log(`  ✓ Converted: ${shipment.qrCode || shipment.id} → DR-${nextDRNumber} (${shipment.clientName || 'Unknown'})`);
      
      nextDRNumber++;
      converted++;
    }
    
    console.log(`\n========================================`);
    console.log(`Conversion complete!`);
    console.log(`  Converted: ${converted}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Next DR#: ${nextDRNumber}`);
    console.log(`========================================\n`);
    
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

// Run migration
migrate()
  .then(() => {
    console.log('Migration finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });

