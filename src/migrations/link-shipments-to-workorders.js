// Migration: Link existing shipments to work orders
// Run with: node src/migrations/link-shipments-to-workorders.js

const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: console.log,
  dialectOptions: {
    ssl: process.env.NODE_ENV === 'production' ? {
      require: true,
      rejectUnauthorized: false
    } : false
  }
});

async function linkShipmentsToWorkOrders() {
  try {
    await sequelize.authenticate();
    console.log('Connected to database');

    // Get all shipments without a workOrderId
    const [shipments] = await sequelize.query(`
      SELECT id, "clientName", "clientPurchaseOrderNumber", "jobNumber", "qrCode", "createdAt"
      FROM shipments 
      WHERE "workOrderId" IS NULL
      ORDER BY "createdAt" DESC
    `);

    console.log(`Found ${shipments.length} unlinked shipments`);

    // Get all work orders (without jobNumber since it might not exist)
    const [workOrders] = await sequelize.query(`
      SELECT id, "clientName", "clientPurchaseOrderNumber", "orderNumber", "drNumber", "createdAt"
      FROM work_orders
      ORDER BY "createdAt" DESC
    `);

    console.log(`Found ${workOrders.length} work orders`);

    let linkedCount = 0;

    for (const shipment of shipments) {
      // Try to find a matching work order
      let matchedWorkOrder = null;

      // Strategy 1: Match by client name AND PO number (most specific)
      if (shipment.clientPurchaseOrderNumber) {
        matchedWorkOrder = workOrders.find(wo => 
          wo.clientName?.toLowerCase() === shipment.clientName?.toLowerCase() &&
          wo.clientPurchaseOrderNumber?.toLowerCase() === shipment.clientPurchaseOrderNumber?.toLowerCase()
        );
      }

      // Strategy 2: Match by client name only (if only one work order for that client)
      if (!matchedWorkOrder) {
        const clientWorkOrders = workOrders.filter(wo => 
          wo.clientName?.toLowerCase() === shipment.clientName?.toLowerCase()
        );
        if (clientWorkOrders.length === 1) {
          matchedWorkOrder = clientWorkOrders[0];
        }
      }

      // Strategy 3: Match by QR code pattern in order number
      if (!matchedWorkOrder && shipment.qrCode) {
        matchedWorkOrder = workOrders.find(wo => 
          wo.orderNumber?.includes(shipment.qrCode) || 
          shipment.qrCode?.includes(wo.orderNumber?.replace('WO-', ''))
        );
      }

      if (matchedWorkOrder) {
        // Check if this work order already has a linked shipment
        const [existing] = await sequelize.query(`
          SELECT id FROM shipments WHERE "workOrderId" = '${matchedWorkOrder.id}'
        `);

        if (existing.length === 0) {
          // Link the shipment to the work order
          await sequelize.query(`
            UPDATE shipments 
            SET "workOrderId" = '${matchedWorkOrder.id}'
            WHERE id = '${shipment.id}'
          `);
          console.log(`✓ Linked shipment ${shipment.qrCode} (${shipment.clientName}) → Work Order DR-${matchedWorkOrder.drNumber || matchedWorkOrder.orderNumber}`);
          linkedCount++;
        } else {
          console.log(`⚠ Work order DR-${matchedWorkOrder.drNumber} already has a linked shipment, skipping ${shipment.qrCode}`);
        }
      } else {
        console.log(`✗ No match found for shipment ${shipment.qrCode} (${shipment.clientName})`);
      }
    }

    console.log(`\n========================================`);
    console.log(`Linked ${linkedCount} shipments to work orders`);
    console.log(`========================================`);

  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await sequelize.close();
  }
}

linkShipmentsToWorkOrders();
