// Run this once to add jobNumber column
// Usage: node src/migrations/add-jobnumber.js

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
    
    console.log('Adding jobNumber column...');
    await sequelize.query(`
      ALTER TABLE shipments 
      ADD COLUMN IF NOT EXISTS "jobNumber" VARCHAR(255)
    `);
    
    console.log('SUCCESS! jobNumber column added.');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

migrate();
