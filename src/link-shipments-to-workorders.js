// Migration: Add vendorId and clientId to relevant tables
// Also backfills from existing supplierName/clientName values
// Run: heroku run node src/migrations/add-vendor-id.js

const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
  logging: console.log
});

async function migrate() {
  try {
    // ===== VENDOR ID COLUMNS =====
    const vendorTables = [
      { table: 'work_order_parts', column: 'vendorId' },
      { table: 'estimate_parts', column: 'vendorId' },
      { table: 'inbound_orders', column: 'vendorId' },
      { table: 'po_numbers', column: 'vendorId' }
    ];

    for (const { table, column } of vendorTables) {
      const [cols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`
      );
      if (cols.length === 0) {
        console.log(`Adding ${column} to ${table}...`);
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" UUID REFERENCES vendors(id)`);
      } else {
        console.log(`${column} already exists on ${table}`);
      }
    }

    // ===== CLIENT ID COLUMNS =====
    const clientTables = [
      { table: 'work_orders', column: 'clientId' },
      { table: 'estimates', column: 'clientId' },
      { table: 'inbound_orders', column: 'clientId' },
      { table: 'po_numbers', column: 'clientId' },
      { table: 'dr_numbers', column: 'clientId' }
    ];

    for (const { table, column } of clientTables) {
      const [cols] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`
      );
      if (cols.length === 0) {
        console.log(`Adding ${column} to ${table}...`);
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" UUID REFERENCES clients(id)`);
      } else {
        console.log(`${column} already exists on ${table}`);
      }
    }

    // ===== BACKFILL VENDORS =====
    console.log('\nCollecting unique supplier names...');
    const [suppliers] = await sequelize.query(`
      SELECT DISTINCT name FROM (
        SELECT "supplierName" as name FROM work_order_parts WHERE "supplierName" IS NOT NULL AND "supplierName" != ''
        UNION
        SELECT "supplierName" as name FROM estimate_parts WHERE "supplierName" IS NOT NULL AND "supplierName" != ''
        UNION
        SELECT "supplierName" as name FROM inbound_orders WHERE "supplierName" IS NOT NULL AND "supplierName" != ''
        UNION
        SELECT supplier as name FROM inbound_orders WHERE supplier IS NOT NULL AND supplier != ''
        UNION
        SELECT supplier as name FROM po_numbers WHERE supplier IS NOT NULL AND supplier != ''
      ) all_suppliers
      WHERE name IS NOT NULL AND name != '' AND LOWER(name) != 'unknown supplier'
    `);

    console.log(`Found ${suppliers.length} unique supplier names`);

    for (const { name } of suppliers) {
      const [existing] = await sequelize.query(
        `SELECT id FROM vendors WHERE LOWER(name) = LOWER($1)`, { bind: [name] }
      );
      if (existing.length === 0) {
        console.log(`  Creating vendor: ${name}`);
        await sequelize.query(
          `INSERT INTO vendors (id, name, "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, true, NOW(), NOW())`,
          { bind: [name] }
        );
      }
    }

    // Backfill vendorId
    console.log('Backfilling vendorId...');
    await sequelize.query(`UPDATE work_order_parts SET "vendorId" = v.id FROM vendors v WHERE LOWER(work_order_parts."supplierName") = LOWER(v.name) AND work_order_parts."vendorId" IS NULL AND work_order_parts."supplierName" IS NOT NULL`);
    await sequelize.query(`UPDATE estimate_parts SET "vendorId" = v.id FROM vendors v WHERE LOWER(estimate_parts."supplierName") = LOWER(v.name) AND estimate_parts."vendorId" IS NULL AND estimate_parts."supplierName" IS NOT NULL`);
    await sequelize.query(`UPDATE inbound_orders SET "vendorId" = v.id FROM vendors v WHERE (LOWER(inbound_orders."supplierName") = LOWER(v.name) OR LOWER(inbound_orders.supplier) = LOWER(v.name)) AND inbound_orders."vendorId" IS NULL`);
    await sequelize.query(`UPDATE po_numbers SET "vendorId" = v.id FROM vendors v WHERE LOWER(po_numbers.supplier) = LOWER(v.name) AND po_numbers."vendorId" IS NULL AND po_numbers.supplier IS NOT NULL`);

    // Sync supplierName on inbound_orders
    await sequelize.query(`UPDATE inbound_orders SET "supplierName" = supplier WHERE "supplierName" IS NULL AND supplier IS NOT NULL`);

    // ===== BACKFILL CLIENTS =====
    console.log('\nCollecting unique client names...');
    const [clients] = await sequelize.query(`
      SELECT DISTINCT name FROM (
        SELECT "clientName" as name FROM work_orders WHERE "clientName" IS NOT NULL AND "clientName" != ''
        UNION
        SELECT "clientName" as name FROM estimates WHERE "clientName" IS NOT NULL AND "clientName" != ''
        UNION
        SELECT "clientName" as name FROM inbound_orders WHERE "clientName" IS NOT NULL AND "clientName" != ''
        UNION
        SELECT "clientName" as name FROM po_numbers WHERE "clientName" IS NOT NULL AND "clientName" != ''
        UNION
        SELECT "clientName" as name FROM dr_numbers WHERE "clientName" IS NOT NULL AND "clientName" != ''
      ) all_clients
      WHERE name IS NOT NULL AND name != ''
    `);

    console.log(`Found ${clients.length} unique client names`);

    for (const { name } of clients) {
      const [existing] = await sequelize.query(
        `SELECT id FROM clients WHERE LOWER(name) = LOWER($1)`, { bind: [name] }
      );
      if (existing.length === 0) {
        console.log(`  Creating client: ${name}`);
        await sequelize.query(
          `INSERT INTO clients (id, name, "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, true, NOW(), NOW())`,
          { bind: [name] }
        );
      }
    }

    // Backfill clientId
    console.log('Backfilling clientId...');
    await sequelize.query(`UPDATE work_orders SET "clientId" = c.id FROM clients c WHERE LOWER(work_orders."clientName") = LOWER(c.name) AND work_orders."clientId" IS NULL AND work_orders."clientName" IS NOT NULL`);
    await sequelize.query(`UPDATE estimates SET "clientId" = c.id FROM clients c WHERE LOWER(estimates."clientName") = LOWER(c.name) AND estimates."clientId" IS NULL AND estimates."clientName" IS NOT NULL`);
    await sequelize.query(`UPDATE inbound_orders SET "clientId" = c.id FROM clients c WHERE LOWER(inbound_orders."clientName") = LOWER(c.name) AND inbound_orders."clientId" IS NULL AND inbound_orders."clientName" IS NOT NULL`);
    await sequelize.query(`UPDATE po_numbers SET "clientId" = c.id FROM clients c WHERE LOWER(po_numbers."clientName") = LOWER(c.name) AND po_numbers."clientId" IS NULL AND po_numbers."clientName" IS NOT NULL`);
    await sequelize.query(`UPDATE dr_numbers SET "clientId" = c.id FROM clients c WHERE LOWER(dr_numbers."clientName") = LOWER(c.name) AND dr_numbers."clientId" IS NULL AND dr_numbers."clientName" IS NOT NULL`);

    // ===== REPORT =====
    console.log('\n=== Migration Summary ===');
    const [vCount] = await sequelize.query(`SELECT COUNT(*) as c FROM vendors`);
    const [cCount] = await sequelize.query(`SELECT COUNT(*) as c FROM clients`);
    const [woV] = await sequelize.query(`SELECT COUNT(*) as c FROM work_order_parts WHERE "vendorId" IS NOT NULL`);
    const [woC] = await sequelize.query(`SELECT COUNT(*) as c FROM work_orders WHERE "clientId" IS NOT NULL`);
    const [estC] = await sequelize.query(`SELECT COUNT(*) as c FROM estimates WHERE "clientId" IS NOT NULL`);
    
    console.log(`Vendors: ${vCount[0].c}`);
    console.log(`Clients: ${cCount[0].c}`);
    console.log(`Work order parts with vendorId: ${woV[0].c}`);
    console.log(`Work orders with clientId: ${woC[0].c}`);
    console.log(`Estimates with clientId: ${estC[0].c}`);

    console.log('\nMigration complete!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
