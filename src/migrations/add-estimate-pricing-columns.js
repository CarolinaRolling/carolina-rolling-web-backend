const { Sequelize } = require('sequelize');

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Check existing columns
      const [columns] = await queryInterface.sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'estimate_parts'`,
        { transaction }
      );
      const columnNames = columns.map(c => c.column_name);

      if (!columnNames.includes('laborTotal')) {
        await queryInterface.addColumn('estimate_parts', 'laborTotal', {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: true
        }, { transaction });
        console.log('Added laborTotal column to estimate_parts');
      }

      if (!columnNames.includes('setupCharge')) {
        await queryInterface.addColumn('estimate_parts', 'setupCharge', {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: true
        }, { transaction });
        console.log('Added setupCharge column to estimate_parts');
      }

      if (!columnNames.includes('otherCharges')) {
        await queryInterface.addColumn('estimate_parts', 'otherCharges', {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: true
        }, { transaction });
        console.log('Added otherCharges column to estimate_parts');
      }

      await transaction.commit();
      console.log('Migration complete: estimate_parts pricing columns added');
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('estimate_parts', 'laborTotal', { transaction });
      await queryInterface.removeColumn('estimate_parts', 'setupCharge', { transaction });
      await queryInterface.removeColumn('estimate_parts', 'otherCharges', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
