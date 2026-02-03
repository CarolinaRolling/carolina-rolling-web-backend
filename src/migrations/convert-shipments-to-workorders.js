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
      // Check if work order already exists for this shipment
      const existingWO = await WorkOrder.findOne({
        where: { orderNumber: shipment.orderNumber }
      });
      
      if (existingWO) {
        console.log(`  Skipping ${shipment.orderNumber} - work order already exists`);
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
      
      // Create work order
      const workOrder = await WorkOrder.create({
        orderNumber: shipment.orderNumber,
        drNumber: nextDRNumber,
        clientName: shipment.clientName,
        clientPO: shipment.poNumber || null,
        contactName: shipment.contactName || null,
        contactEmail: shipment.contactEmail || null,
        contactPhone: shipment.contactPhone || null,
        projectDescription: shipment.description || null,
        status: woStatus,
        priority: shipment.priority || 'normal',
        storageLocation: shipment.storageLocation || null,
        promisedDate: shipment.promisedDate || null,
        notes: shipment.notes || null,
        internalNotes: shipment.internalNotes || null,
        allMaterialReceived: true, // Assume material is received for existing shipments
        createdAt: shipment.createdAt,
        updatedAt: shipment.updatedAt
      });
      
      // Record DR number assignment
      await DRNumber.create({
        drNumber: nextDRNumber,
        workOrderId: workOrder.id,
        clientName: shipment.clientName,
        assignedAt: shipment.createdAt,
        assignedBy: 'migration'
      });
      
      // Create a default part from shipment info
      if (shipment.description || shipment.material) {
        await WorkOrderPart.create({
          workOrderId: workOrder.id,
          partNumber: 1,
          partType: 'other',
          quantity: shipment.quantity || 1,
          materialDescription: shipment.material || shipment.description || 'Converted from shipment',
          materialReceived: true,
          status: woStatus === 'completed' ? 'completed' : 'in_progress'
        });
      }
      
      console.log(`  ✓ Converted: ${shipment.orderNumber} → DR-${nextDRNumber} (${shipment.clientName})`);
      
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
