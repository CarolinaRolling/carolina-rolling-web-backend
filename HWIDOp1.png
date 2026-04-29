// Migration to sync supplierName field in inbound_orders
// Run with: heroku run node src/migrations/fix-inbound-supplier.js

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
    console.log('Fixing inbound orders supplier names...');
    
    // Update supplierName from supplier where supplierName is null
    const [result] = await sequelize.query(`
      UPDATE inbound_orders 
      SET "supplierName" = supplier 
      WHERE "supplierName" IS NULL AND supplier IS NOT NULL
    `);
    
    console.log('Updated rows:', result);
    
    // Check results
    const [orders] = await sequelize.query(`
      SELECT id, supplier, "supplierName", "purchaseOrderNumber" 
      FROM inbound_orders 
      ORDER BY "createdAt" DESC 
      LIMIT 10
    `);
    
    console.log('\nRecent inbound orders:');
    orders.forEach(o => {
      console.log(`  PO: ${o.purchaseOrderNumber}, supplier: ${o.supplier}, supplierName: ${o.supplierName}`);
    });
    
    console.log('\nMigration complete!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
