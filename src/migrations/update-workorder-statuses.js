// Migration to update work order status enum
// Run: heroku run node src/migrations/update-workorder-statuses.js -a carolina-rolling-inventory-api

const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: process.env.NODE_ENV === 'production' ? { require: true, rejectUnauthorized: false } : false
  },
  logging: console.log
});

async function migrate() {
  try {
    console.log('Starting work order status migration...');

    // Step 1: Map old statuses to new ones
    console.log('\n1. Mapping old statuses to new statuses...');
    
    // draft -> received (or work_order_generated if from estimate)
    await sequelize.query(`
      UPDATE work_orders SET status = 'received' WHERE status = 'draft'
    `);
    console.log('   - draft -> received');
    
    // in_progress -> processing
    await sequelize.query(`
      UPDATE work_orders SET status = 'processing' WHERE status = 'in_progress'
    `);
    console.log('   - in_progress -> processing');
    
    // completed -> stored
    await sequelize.query(`
      UPDATE work_orders SET status = 'stored' WHERE status = 'completed'
    `);
    console.log('   - completed -> stored');

    // Step 2: Drop and recreate the enum
    console.log('\n2. Updating enum type...');
    
    // Create new enum
    await sequelize.query(`
      DO $$ BEGIN
        CREATE TYPE enum_work_orders_status_new AS ENUM (
          'quoted', 'work_order_generated', 'waiting_for_materials', 
          'received', 'processing', 'stored', 'shipped', 'archived'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    
    // Change column to use new enum
    await sequelize.query(`
      ALTER TABLE work_orders 
      ALTER COLUMN status TYPE enum_work_orders_status_new 
      USING status::text::enum_work_orders_status_new
    `);
    
    // Drop old enum and rename new one
    await sequelize.query(`
      DROP TYPE IF EXISTS "enum_work_orders_status";
    `);
    
    await sequelize.query(`
      ALTER TYPE enum_work_orders_status_new RENAME TO "enum_work_orders_status";
    `);
    
    console.log('   Enum updated successfully');

    // Step 3: Update WorkOrderPart statuses if needed
    console.log('\n3. Checking work order part statuses...');
    // Parts can keep their existing statuses (pending, in_progress, completed)

    console.log('\n✅ Migration completed successfully!');
    console.log('\nNew status workflow:');
    console.log('  quoted -> work_order_generated -> waiting_for_materials -> received -> processing -> stored -> shipped -> archived');
    
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
