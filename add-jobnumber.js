/**
 * Migration: Add workOrderId to shipments table
 * 
 * This allows shipments to be linked to work orders
 */

const { sequelize } = require('../models');

async function migrate() {
  console.log('Adding workOrderId column to shipments table...\n');
  
  try {
    // Check if column already exists
    const [results] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'shipments' AND column_name = 'workOrderId'
    `);
    
    if (results.length > 0) {
      console.log('Column workOrderId already exists in shipments table');
      return;
    }
    
    // Add the column
    await sequelize.query(`
      ALTER TABLE shipments 
      ADD COLUMN "workOrderId" UUID REFERENCES work_orders(id)
    `);
    
    console.log('✓ Added workOrderId column to shipments table');
    console.log('\nMigration completed successfully!');
    
  } catch (error) {
    // If error is about column already existing, that's fine
    if (error.message.includes('already exists')) {
      console.log('Column already exists, skipping...');
      return;
    }
    console.error('Migration failed:', error);
    throw error;
  }
}

migrate()
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
