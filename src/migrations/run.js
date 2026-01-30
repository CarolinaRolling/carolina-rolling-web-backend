require('dotenv').config();
const { sequelize } = require('../models');

async function runMigrations() {
  try {
    console.log('Running database migrations...');
    
    // Force sync in development, alter in production
    const options = process.env.NODE_ENV === 'production' 
      ? { alter: true } 
      : { force: false, alter: true };
    
    await sequelize.sync(options);
    
    console.log('Migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
