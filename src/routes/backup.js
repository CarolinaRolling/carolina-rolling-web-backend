const express = require('express');
const { 
  sequelize, 
  Shipment, ShipmentPhoto, ShipmentDocument,
  InboundOrder,
  WorkOrder, WorkOrderPart, WorkOrderPartFile,
  Estimate, EstimatePart, EstimateFile,
  AppSettings, User
} = require('../models');

const router = express.Router();

// GET /api/backup - Create and download full backup
router.get('/', async (req, res, next) => {
  try {
    const { 
      includeShipments = 'true',
      includeWorkOrders = 'true',
      includeEstimates = 'true',
      includeInbound = 'true',
      includeSettings = 'true'
    } = req.query;

    const backup = {
      version: '1.0',
      createdAt: new Date().toISOString(),
      data: {}
    };

    // Shipments
    if (includeShipments === 'true') {
      const shipments = await Shipment.findAll({
        include: [
          { model: ShipmentPhoto, as: 'photos' },
          { model: ShipmentDocument, as: 'documents' }
        ]
      });
      backup.data.shipments = shipments.map(s => s.toJSON());
    }

    // Inbound Orders
    if (includeInbound === 'true') {
      const inboundOrders = await InboundOrder.findAll();
      backup.data.inboundOrders = inboundOrders.map(o => o.toJSON());
    }

    // Work Orders
    if (includeWorkOrders === 'true') {
      const workOrders = await WorkOrder.findAll({
        include: [{
          model: WorkOrderPart,
          as: 'parts',
          include: [{ model: WorkOrderPartFile, as: 'files' }]
        }]
      });
      backup.data.workOrders = workOrders.map(w => w.toJSON());
    }

    // Estimates
    if (includeEstimates === 'true') {
      const estimates = await Estimate.findAll({
        include: [
          { model: EstimatePart, as: 'parts' },
          { model: EstimateFile, as: 'files' }
        ]
      });
      backup.data.estimates = estimates.map(e => e.toJSON());
    }

    // Settings
    if (includeSettings === 'true') {
      const settings = await AppSettings.findAll();
      backup.data.settings = settings.map(s => s.toJSON());
      
      // Include users (without passwords)
      const users = await User.findAll({
        attributes: ['id', 'username', 'role', 'isActive', 'createdAt']
      });
      backup.data.users = users.map(u => u.toJSON());
    }

    // Calculate counts
    backup.counts = {
      shipments: backup.data.shipments?.length || 0,
      inboundOrders: backup.data.inboundOrders?.length || 0,
      workOrders: backup.data.workOrders?.length || 0,
      estimates: backup.data.estimates?.length || 0,
      settings: backup.data.settings?.length || 0,
      users: backup.data.users?.length || 0
    };

    // Set headers for file download
    const filename = `backup-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.json(backup);
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/info - Get backup info without downloading
router.get('/info', async (req, res, next) => {
  try {
    const [
      shipmentCount,
      inboundCount,
      workOrderCount,
      estimateCount,
      settingsCount,
      userCount
    ] = await Promise.all([
      Shipment.count(),
      InboundOrder.count(),
      WorkOrder.count(),
      Estimate.count(),
      AppSettings.count(),
      User.count()
    ]);

    res.json({
      data: {
        shipments: shipmentCount,
        inboundOrders: inboundCount,
        workOrders: workOrderCount,
        estimates: estimateCount,
        settings: settingsCount,
        users: userCount,
        lastBackup: null // Could be stored in settings
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup/restore - Restore from backup
router.post('/restore', async (req, res, next) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { backup, options = {} } = req.body;
    
    if (!backup || !backup.data) {
      return res.status(400).json({ error: { message: 'Invalid backup file' } });
    }

    const {
      restoreShipments = true,
      restoreWorkOrders = true,
      restoreEstimates = true,
      restoreInbound = true,
      restoreSettings = true,
      clearExisting = false
    } = options;

    const results = {
      shipments: { restored: 0, skipped: 0 },
      inboundOrders: { restored: 0, skipped: 0 },
      workOrders: { restored: 0, skipped: 0 },
      estimates: { restored: 0, skipped: 0 },
      settings: { restored: 0, skipped: 0 }
    };

    // Restore Shipments
    if (restoreShipments && backup.data.shipments) {
      if (clearExisting) {
        await ShipmentDocument.destroy({ where: {}, transaction });
        await ShipmentPhoto.destroy({ where: {}, transaction });
        await Shipment.destroy({ where: {}, transaction });
      }

      for (const shipmentData of backup.data.shipments) {
        try {
          const { photos, documents, ...shipment } = shipmentData;
          
          const existing = await Shipment.findByPk(shipment.id, { transaction });
          if (existing && !clearExisting) {
            results.shipments.skipped++;
            continue;
          }

          const created = await Shipment.create(shipment, { transaction });

          if (photos) {
            for (const photo of photos) {
              await ShipmentPhoto.create({ ...photo, shipmentId: created.id }, { transaction });
            }
          }

          if (documents) {
            for (const doc of documents) {
              await ShipmentDocument.create({ ...doc, shipmentId: created.id }, { transaction });
            }
          }

          results.shipments.restored++;
        } catch (e) {
          console.error('Error restoring shipment:', e);
          results.shipments.skipped++;
        }
      }
    }

    // Restore Inbound Orders
    if (restoreInbound && backup.data.inboundOrders) {
      if (clearExisting) {
        await InboundOrder.destroy({ where: {}, transaction });
      }

      for (const orderData of backup.data.inboundOrders) {
        try {
          const existing = await InboundOrder.findByPk(orderData.id, { transaction });
          if (existing && !clearExisting) {
            results.inboundOrders.skipped++;
            continue;
          }

          await InboundOrder.create(orderData, { transaction });
          results.inboundOrders.restored++;
        } catch (e) {
          results.inboundOrders.skipped++;
        }
      }
    }

    // Restore Work Orders
    if (restoreWorkOrders && backup.data.workOrders) {
      if (clearExisting) {
        await WorkOrderPartFile.destroy({ where: {}, transaction });
        await WorkOrderPart.destroy({ where: {}, transaction });
        await WorkOrder.destroy({ where: {}, transaction });
      }

      for (const orderData of backup.data.workOrders) {
        try {
          const { parts, ...order } = orderData;
          
          const existing = await WorkOrder.findByPk(order.id, { transaction });
          if (existing && !clearExisting) {
            results.workOrders.skipped++;
            continue;
          }

          const created = await WorkOrder.create(order, { transaction });

          if (parts) {
            for (const partData of parts) {
              const { files, ...part } = partData;
              const createdPart = await WorkOrderPart.create(
                { ...part, workOrderId: created.id },
                { transaction }
              );

              if (files) {
                for (const file of files) {
                  await WorkOrderPartFile.create(
                    { ...file, workOrderPartId: createdPart.id },
                    { transaction }
                  );
                }
              }
            }
          }

          results.workOrders.restored++;
        } catch (e) {
          console.error('Error restoring work order:', e);
          results.workOrders.skipped++;
        }
      }
    }

    // Restore Estimates
    if (restoreEstimates && backup.data.estimates) {
      if (clearExisting) {
        await EstimateFile.destroy({ where: {}, transaction });
        await EstimatePart.destroy({ where: {}, transaction });
        await Estimate.destroy({ where: {}, transaction });
      }

      for (const estimateData of backup.data.estimates) {
        try {
          const { parts, files, ...estimate } = estimateData;
          
          const existing = await Estimate.findByPk(estimate.id, { transaction });
          if (existing && !clearExisting) {
            results.estimates.skipped++;
            continue;
          }

          const created = await Estimate.create(estimate, { transaction });

          if (parts) {
            for (const part of parts) {
              await EstimatePart.create(
                { ...part, estimateId: created.id },
                { transaction }
              );
            }
          }

          if (files) {
            for (const file of files) {
              await EstimateFile.create(
                { ...file, estimateId: created.id },
                { transaction }
              );
            }
          }

          results.estimates.restored++;
        } catch (e) {
          console.error('Error restoring estimate:', e);
          results.estimates.skipped++;
        }
      }
    }

    // Restore Settings
    if (restoreSettings && backup.data.settings) {
      for (const settingData of backup.data.settings) {
        try {
          const [setting, created] = await AppSettings.findOrCreate({
            where: { key: settingData.key },
            defaults: settingData,
            transaction
          });

          if (!created && clearExisting) {
            await setting.update({ value: settingData.value }, { transaction });
          }

          results.settings.restored++;
        } catch (e) {
          results.settings.skipped++;
        }
      }
    }

    await transaction.commit();

    res.json({
      message: 'Backup restored successfully',
      results
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
});

module.exports = router;
