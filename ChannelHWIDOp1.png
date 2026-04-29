const { Sequelize } = require('sequelize');

async function up(queryInterface) {
  const transaction = await queryInterface.sequelize.transaction();
  
  try {
    // ============================================
    // DR NUMBER TRACKING TABLE
    // ============================================
    await queryInterface.createTable('dr_numbers', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      drNumber: {
        type: Sequelize.INTEGER,
        unique: true,
        allowNull: false
      },
      status: {
        type: Sequelize.ENUM('active', 'void'),
        defaultValue: 'active'
      },
      workOrderId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'work_orders', key: 'id' }
      },
      estimateId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'estimates', key: 'id' }
      },
      clientName: {
        type: Sequelize.STRING,
        allowNull: true
      },
      voidedAt: {
        type: Sequelize.DATE,
        allowNull: true
      },
      voidedBy: {
        type: Sequelize.STRING,
        allowNull: true
      },
      voidReason: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    }, { transaction });

    // ============================================
    // ADD DR NUMBER TO WORK ORDERS
    // ============================================
    await queryInterface.addColumn('work_orders', 'drNumber', {
      type: Sequelize.INTEGER,
      allowNull: true,
      unique: true
    }, { transaction });

    await queryInterface.addColumn('work_orders', 'archivedAt', {
      type: Sequelize.DATE,
      allowNull: true
    }, { transaction });

    await queryInterface.addColumn('work_orders', 'shippedAt', {
      type: Sequelize.DATE,
      allowNull: true
    }, { transaction });

    // Update status enum to include 'shipped' and 'archived'
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_work_orders_status" ADD VALUE IF NOT EXISTS 'shipped';
    `, { transaction });
    
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_work_orders_status" ADD VALUE IF NOT EXISTS 'archived';
    `, { transaction });

    // ============================================
    // ADD CUSTOMER SUPPLIED TO ESTIMATE PARTS
    // ============================================
    await queryInterface.addColumn('estimate_parts', 'materialSource', {
      type: Sequelize.ENUM('we_order', 'customer_supplied'),
      defaultValue: 'we_order'
    }, { transaction });

    await queryInterface.addColumn('estimate_parts', 'materialReceived', {
      type: Sequelize.BOOLEAN,
      defaultValue: false
    }, { transaction });

    await queryInterface.addColumn('estimate_parts', 'materialReceivedAt', {
      type: Sequelize.DATE,
      allowNull: true
    }, { transaction });

    // ============================================
    // ADD MATERIAL STATUS TO WORK ORDER PARTS
    // ============================================
    await queryInterface.addColumn('work_order_parts', 'materialSource', {
      type: Sequelize.STRING,
      defaultValue: 'we_order'
    }, { transaction });

    await queryInterface.addColumn('work_order_parts', 'materialReceived', {
      type: Sequelize.BOOLEAN,
      defaultValue: false
    }, { transaction });

    await queryInterface.addColumn('work_order_parts', 'awaitingInboundId', {
      type: Sequelize.UUID,
      allowNull: true
    }, { transaction });

    await queryInterface.addColumn('work_order_parts', 'awaitingPONumber', {
      type: Sequelize.STRING,
      allowNull: true
    }, { transaction });

    // ============================================
    // UPDATE INBOUND ORDERS
    // ============================================
    await queryInterface.addColumn('inbound_orders', 'workOrderId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'work_orders', key: 'id' }
    }, { transaction });

    await queryInterface.addColumn('inbound_orders', 'drNumber', {
      type: Sequelize.INTEGER,
      allowNull: true
    }, { transaction });

    await queryInterface.addColumn('inbound_orders', 'partIds', {
      type: Sequelize.JSONB,
      allowNull: true
    }, { transaction });

    // ============================================
    // EMAIL LOG TABLE
    // ============================================
    await queryInterface.createTable('email_logs', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      emailType: {
        type: Sequelize.STRING,
        allowNull: false
      },
      recipient: {
        type: Sequelize.STRING,
        allowNull: false
      },
      subject: {
        type: Sequelize.STRING,
        allowNull: false
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      sentAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      status: {
        type: Sequelize.STRING,
        defaultValue: 'sent'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    }, { transaction });

    // ============================================
    // ACTIVITY TRACKING FOR DAILY EMAILS
    // ============================================
    await queryInterface.createTable('daily_activities', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      activityType: {
        type: Sequelize.STRING,
        allowNull: false
      },
      resourceType: {
        type: Sequelize.STRING,
        allowNull: false
      },
      resourceId: {
        type: Sequelize.UUID,
        allowNull: true
      },
      resourceNumber: {
        type: Sequelize.STRING,
        allowNull: true
      },
      clientName: {
        type: Sequelize.STRING,
        allowNull: true
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      details: {
        type: Sequelize.JSONB,
        allowNull: true
      },
      includedInEmail: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
      emailSentAt: {
        type: Sequelize.DATE,
        allowNull: true
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    }, { transaction });

    await transaction.commit();
    console.log('Migration completed successfully');
  } catch (error) {
    await transaction.rollback();
    console.error('Migration failed:', error);
    throw error;
  }
}

async function down(queryInterface) {
  const transaction = await queryInterface.sequelize.transaction();
  
  try {
    await queryInterface.dropTable('daily_activities', { transaction });
    await queryInterface.dropTable('email_logs', { transaction });
    await queryInterface.dropTable('dr_numbers', { transaction });
    
    await queryInterface.removeColumn('work_orders', 'drNumber', { transaction });
    await queryInterface.removeColumn('work_orders', 'archivedAt', { transaction });
    await queryInterface.removeColumn('work_orders', 'shippedAt', { transaction });
    
    await queryInterface.removeColumn('estimate_parts', 'materialSource', { transaction });
    await queryInterface.removeColumn('estimate_parts', 'materialReceived', { transaction });
    await queryInterface.removeColumn('estimate_parts', 'materialReceivedAt', { transaction });
    
    await queryInterface.removeColumn('work_order_parts', 'materialSource', { transaction });
    await queryInterface.removeColumn('work_order_parts', 'materialReceived', { transaction });
    await queryInterface.removeColumn('work_order_parts', 'awaitingInboundId', { transaction });
    await queryInterface.removeColumn('work_order_parts', 'awaitingPONumber', { transaction });
    
    await queryInterface.removeColumn('inbound_orders', 'workOrderId', { transaction });
    await queryInterface.removeColumn('inbound_orders', 'drNumber', { transaction });
    await queryInterface.removeColumn('inbound_orders', 'partIds', { transaction });

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

module.exports = { up, down };
