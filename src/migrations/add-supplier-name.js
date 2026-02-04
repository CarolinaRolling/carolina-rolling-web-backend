// Migration to add supplierName column to work_order_parts if it doesn't exist
// Run with: heroku run node src/migrations/add-supplier-name.js

const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  },
  logging: console.log
});

async function migrate() {
  try {
    console.log('Checking work_order_parts columns...');
    
    // Check existing columns
    const [columns] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'work_order_parts'
      ORDER BY column_name
    `);
    
    const columnNames = columns.map(c => c.column_name);
    console.log('Existing columns:', columnNames.join(', '));
    
    // Add supplierName if missing
    if (!columnNames.includes('supplierName')) {
      console.log('Adding supplierName column...');
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "supplierName" VARCHAR(255)`);
      console.log('supplierName column added');
    } else {
      console.log('supplierName column already exists');
    }
    
    // Add materialDescription if missing
    if (!columnNames.includes('materialDescription')) {
      console.log('Adding materialDescription column...');
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "materialDescription" VARCHAR(255)`);
      console.log('materialDescription column added');
    } else {
      console.log('materialDescription column already exists');
    }
    
    // Add materialSource if missing
    if (!columnNames.includes('materialSource')) {
      console.log('Adding materialSource column...');
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "materialSource" VARCHAR(50) DEFAULT 'customer'`);
      console.log('materialSource column added');
    } else {
      console.log('materialSource column already exists');
    }
    
    // Add materialOrdered if missing
    if (!columnNames.includes('materialOrdered')) {
      console.log('Adding materialOrdered column...');
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "materialOrdered" BOOLEAN DEFAULT false`);
      console.log('materialOrdered column added');
    } else {
      console.log('materialOrdered column already exists');
    }
    
    // Add materialOrderedAt if missing
    if (!columnNames.includes('materialOrderedAt')) {
      console.log('Adding materialOrderedAt column...');
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "materialOrderedAt" TIMESTAMP WITH TIME ZONE`);
      console.log('materialOrderedAt column added');
    } else {
      console.log('materialOrderedAt column already exists');
    }
    
    // Add materialPurchaseOrderNumber if missing
    if (!columnNames.includes('materialPurchaseOrderNumber')) {
      console.log('Adding materialPurchaseOrderNumber column...');
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "materialPurchaseOrderNumber" VARCHAR(255)`);
      console.log('materialPurchaseOrderNumber column added');
    } else {
      console.log('materialPurchaseOrderNumber column already exists');
    }
    
    // Add inboundOrderId if missing
    if (!columnNames.includes('inboundOrderId')) {
      console.log('Adding inboundOrderId column...');
      await sequelize.query(`ALTER TABLE work_order_parts ADD COLUMN "inboundOrderId" UUID`);
      console.log('inboundOrderId column added');
    } else {
      console.log('inboundOrderId column already exists');
    }
    
    console.log('\nMigration complete!');
    
    // Verify
    const [newColumns] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'work_order_parts'
      ORDER BY column_name
    `);
    console.log('\nFinal columns:', newColumns.map(c => c.column_name).join(', '));
    
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
