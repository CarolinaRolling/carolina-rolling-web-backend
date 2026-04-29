/**
 * Delete all estimates where clientName = 'test' (case-insensitive)
 * 
 * Usage: node scripts/delete-test-estimates.js
 * 
 * Run from backend directory:
 *   cd backend && node scripts/delete-test-estimates.js
 */

require('dotenv').config();
const { Sequelize, Op } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: process.env.DATABASE_URL?.includes('amazonaws.com') ? {
    ssl: { require: true, rejectUnauthorized: false }
  } : {}
});

async function deleteTestEstimates() {
  try {
    await sequelize.authenticate();
    console.log('Connected to database.\n');

    // Find matching estimates
    const [estimates] = await sequelize.query(
      `SELECT id, "estimateNumber", "clientName" FROM estimates WHERE LOWER("clientName") = 'test'`
    );

    if (estimates.length === 0) {
      console.log('No estimates found with client name "test".');
      process.exit(0);
    }

    console.log(`Found ${estimates.length} estimate(s) to delete:`);
    estimates.forEach(e => console.log(`  - ${e.estimateNumber}: ${e.clientName}`));
    console.log('');

    const ids = estimates.map(e => `'${e.id}'`).join(',');

    // 1. Nullify references from work_orders
    const [, woResult] = await sequelize.query(
      `UPDATE work_orders SET "estimateId" = NULL WHERE "estimateId" IN (${ids})`
    );
    console.log(`Unlinked ${woResult?.rowCount || 0} work order(s).`);

    // 2. Nullify references from inbound_orders
    const [, ioResult] = await sequelize.query(
      `UPDATE inbound_orders SET "estimateId" = NULL WHERE "estimateId" IN (${ids})`
    );
    console.log(`Unlinked ${ioResult?.rowCount || 0} inbound order(s).`);

    // 3. Delete part files
    const [partFileResult] = await sequelize.query(
      `DELETE FROM estimate_part_files WHERE "partId" IN (SELECT id FROM estimate_parts WHERE "estimateId" IN (${ids}))`
    );
    console.log(`Deleted ${partFileResult?.length || 0} part file(s).`);

    // 4. Delete parts
    const [partResult] = await sequelize.query(
      `DELETE FROM estimate_parts WHERE "estimateId" IN (${ids})`
    );
    console.log(`Deleted ${partResult?.length || 0} part(s).`);

    // 5. Delete estimate-level files
    const [fileResult] = await sequelize.query(
      `DELETE FROM estimate_files WHERE "estimateId" IN (${ids})`
    );
    console.log(`Deleted ${fileResult?.length || 0} file(s).`);

    // 6. Delete estimates
    const [estResult] = await sequelize.query(
      `DELETE FROM estimates WHERE id IN (${ids})`
    );
    console.log(`\nDeleted ${estResult?.length || 0} estimate(s). Done!`);

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

deleteTestEstimates();
