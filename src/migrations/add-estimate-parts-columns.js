// Run this once to add missing columns to estimate_parts table
// Usage: node src/migrations/add-estimate-parts-columns.js

require('dotenv').config();
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
    console.log('Connecting to database...');
    await sequelize.authenticate();
    console.log('Connected!');
    
    const columns = [
      { name: 'materialPurchaseOrderNumber', type: 'VARCHAR(255)' },
      { name: 'materialOrderedAt', type: 'TIMESTAMP WITH TIME ZONE' },
      { name: 'materialReceivedAt', type: 'TIMESTAMP WITH TIME ZONE' },
      { name: 'inboundOrderId', type: 'UUID' }
    ];
    
    for (const col of columns) {
      console.log(`Adding ${col.name} column to estimate_parts...`);
      try {
        await sequelize.query(`
          ALTER TABLE estimate_parts 
          ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}
        `);
        console.log(`  ✓ ${col.name} added`);
      } catch (err) {
        if (err.message.includes('already exists')) {
          console.log(`  - ${col.name} already exists`);
        } else {
          console.log(`  ✗ ${col.name} failed: ${err.message}`);
        }
      }
    }
    
    console.log('\nSUCCESS! Migration complete.');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

migrate();
