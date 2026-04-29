// Migration script to create app_settings table
// Run with: heroku run "node src/migrations/add-app-settings.js" -a carolina-rolling-inventory-api

const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

async function migrate() {
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

  try {
    await sequelize.authenticate();
    console.log('Connected to database');

    // Check if table exists
    const [results] = await sequelize.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'app_settings'
      );
    `);

    if (results[0].exists) {
      console.log('app_settings table already exists');
    } else {
      // Create app_settings table
      await sequelize.query(`
        CREATE TABLE app_settings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          key VARCHAR(255) UNIQUE NOT NULL,
          value JSONB NOT NULL,
          "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('Created app_settings table');

      // Insert default locations
      const defaultLocations = [
        { id: 'rack1', name: 'Rack 1', xPercent: 0.20, yPercent: 0.20, description: 'Front left storage rack' },
        { id: 'rack2', name: 'Rack 2', xPercent: 0.50, yPercent: 0.20, description: 'Front center storage rack' },
        { id: 'rack3', name: 'Rack 3', xPercent: 0.80, yPercent: 0.20, description: 'Front right storage rack' },
        { id: 'runway', name: 'RunWay', xPercent: 0.50, yPercent: 0.50, description: 'Center runway area' },
        { id: 'kaluma', name: 'Kaluma', xPercent: 0.25, yPercent: 0.80, description: 'Kaluma machine area' },
        { id: 'roundo', name: 'Roundo', xPercent: 0.75, yPercent: 0.80, description: 'Roundo machine area' }
      ];

      await sequelize.query(`
        INSERT INTO app_settings (key, value)
        VALUES ('warehouse_locations', :locations)
      `, {
        replacements: { locations: JSON.stringify(defaultLocations) }
      });
      console.log('Inserted default locations');
    }

    console.log('Migration complete!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await sequelize.close();
  }
}

migrate();
