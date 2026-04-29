/**
 * Migration: Add Work Orders tables
 * 
 * This migration adds the work_orders, work_order_parts, and work_order_part_files tables.
 * It's designed to be run after the existing database schema is in place.
 */

const { sequelize } = require('../models');

async function runMigration() {
  const queryInterface = sequelize.getQueryInterface();
  
  try {
    console.log('Starting Work Orders migration...');
    
    // Check if work_orders table exists
    const tables = await queryInterface.showAllTables();
    
    if (!tables.includes('work_orders')) {
      console.log('Creating work_orders table...');
      await queryInterface.createTable('work_orders', {
        id: {
          type: sequelize.Sequelize.DataTypes.UUID,
          defaultValue: sequelize.Sequelize.DataTypes.UUIDV4,
          primaryKey: true
        },
        orderNumber: {
          type: sequelize.Sequelize.DataTypes.STRING,
          unique: true,
          allowNull: false
        },
        clientName: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: false
        },
        clientPurchaseOrderNumber: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        contactName: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        contactPhone: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        contactEmail: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        status: {
          type: sequelize.Sequelize.DataTypes.ENUM('draft', 'received', 'in_progress', 'completed', 'picked_up'),
          defaultValue: 'draft'
        },
        notes: {
          type: sequelize.Sequelize.DataTypes.TEXT,
          allowNull: true
        },
        receivedAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: true
        },
        receivedBy: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        requestedDueDate: {
          type: sequelize.Sequelize.DataTypes.DATEONLY,
          allowNull: true
        },
        promisedDate: {
          type: sequelize.Sequelize.DataTypes.DATEONLY,
          allowNull: true
        },
        completedAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: true
        },
        pickedUpAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: true
        },
        pickedUpBy: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        signatureData: {
          type: sequelize.Sequelize.DataTypes.TEXT,
          allowNull: true
        },
        createdAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: false
        },
        updatedAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: false
        }
      });
      console.log('work_orders table created');
    } else {
      console.log('work_orders table already exists');
    }

    if (!tables.includes('work_order_parts')) {
      console.log('Creating work_order_parts table...');
      await queryInterface.createTable('work_order_parts', {
        id: {
          type: sequelize.Sequelize.DataTypes.UUID,
          defaultValue: sequelize.Sequelize.DataTypes.UUIDV4,
          primaryKey: true
        },
        workOrderId: {
          type: sequelize.Sequelize.DataTypes.UUID,
          allowNull: false,
          references: {
            model: 'work_orders',
            key: 'id'
          },
          onDelete: 'CASCADE'
        },
        partNumber: {
          type: sequelize.Sequelize.DataTypes.INTEGER,
          allowNull: false
        },
        partType: {
          type: sequelize.Sequelize.DataTypes.ENUM('plate_roll', 'section_roll', 'angle_roll', 'beam_roll', 'pipe_roll', 'channel_roll', 'flat_bar', 'other'),
          allowNull: false
        },
        clientPartNumber: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        heatNumber: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        quantity: {
          type: sequelize.Sequelize.DataTypes.INTEGER,
          defaultValue: 1
        },
        material: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        thickness: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        width: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        length: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        outerDiameter: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        innerDiameter: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        wallThickness: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        rollType: {
          type: sequelize.Sequelize.DataTypes.ENUM('easy_way', 'hard_way'),
          allowNull: true
        },
        radius: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        diameter: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        arcLength: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        arcDegrees: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        sectionSize: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        flangeOut: {
          type: sequelize.Sequelize.DataTypes.BOOLEAN,
          defaultValue: false
        },
        status: {
          type: sequelize.Sequelize.DataTypes.ENUM('pending', 'in_progress', 'completed'),
          defaultValue: 'pending'
        },
        completedAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: true
        },
        completedBy: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        specialInstructions: {
          type: sequelize.Sequelize.DataTypes.TEXT,
          allowNull: true
        },
        operatorNotes: {
          type: sequelize.Sequelize.DataTypes.TEXT,
          allowNull: true
        },
        createdAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: false
        },
        updatedAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: false
        }
      });
      console.log('work_order_parts table created');
    } else {
      console.log('work_order_parts table already exists');
    }

    if (!tables.includes('work_order_part_files')) {
      console.log('Creating work_order_part_files table...');
      await queryInterface.createTable('work_order_part_files', {
        id: {
          type: sequelize.Sequelize.DataTypes.UUID,
          defaultValue: sequelize.Sequelize.DataTypes.UUIDV4,
          primaryKey: true
        },
        workOrderPartId: {
          type: sequelize.Sequelize.DataTypes.UUID,
          allowNull: false,
          references: {
            model: 'work_order_parts',
            key: 'id'
          },
          onDelete: 'CASCADE'
        },
        fileType: {
          type: sequelize.Sequelize.DataTypes.ENUM('pdf_print', 'step_file', 'other'),
          allowNull: false
        },
        filename: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: false
        },
        originalName: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        mimeType: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        size: {
          type: sequelize.Sequelize.DataTypes.INTEGER,
          allowNull: true
        },
        url: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: false
        },
        cloudinaryId: {
          type: sequelize.Sequelize.DataTypes.STRING,
          allowNull: true
        },
        createdAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: false
        },
        updatedAt: {
          type: sequelize.Sequelize.DataTypes.DATE,
          allowNull: false
        }
      });
      console.log('work_order_part_files table created');
    } else {
      console.log('work_order_part_files table already exists');
    }

    console.log('Work Orders migration completed successfully!');
    
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runMigration };
