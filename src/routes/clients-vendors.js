const express = require('express');
const router = express.Router();
const { Client, Vendor, Estimate, WorkOrder, Shipment, sequelize } = require('../models');
const { Op } = require('sequelize');

// ============= CLIENTS =============

// GET /api/clients - Get all clients
router.get('/clients', async (req, res, next) => {
  try {
    const { search, active } = req.query;
    
    const where = {};
    if (active !== undefined) {
      where.isActive = active === 'true';
    }
    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
    }
    
    const clients = await Client.findAll({
      where,
      order: [['name', 'ASC']]
    });
    
    res.json({ data: clients });
  } catch (error) {
    next(error);
  }
});

// GET /api/clients/search - Search clients for autofill (searches Clients table + distinct names from estimates/WOs/shipments)
router.get('/clients/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) {
      return res.json({ data: [] });
    }

    // 1. Search the Clients table
    const clients = await Client.findAll({
      where: { isActive: true, name: { [Op.iLike]: `%${q}%` } },
      limit: 10,
      order: [['name', 'ASC']]
    });

    const results = clients.map(c => ({
      id: c.id,
      name: c.name,
      contactName: c.contactName,
      contactPhone: c.contactPhone,
      contactEmail: c.contactEmail
    }));
    const seenNames = new Set(results.map(r => r.name.toLowerCase()));

    // 2. Also search distinct clientName from estimates, work orders, shipments
    const likePattern = `%${q}%`;
    const [extraNames] = await sequelize.query(`
      SELECT DISTINCT name FROM (
        SELECT DISTINCT "clientName" AS name FROM estimates WHERE "clientName" ILIKE :pattern
        UNION
        SELECT DISTINCT "clientName" AS name FROM work_orders WHERE "clientName" ILIKE :pattern
        UNION
        SELECT DISTINCT "clientName" AS name FROM shipments WHERE "clientName" ILIKE :pattern
      ) AS all_names
      ORDER BY name ASC
      LIMIT 20
    `, { replacements: { pattern: likePattern } });

    for (const row of extraNames) {
      if (!seenNames.has(row.name.toLowerCase())) {
        results.push({ id: `name:${row.name}`, name: row.name });
        seenNames.add(row.name.toLowerCase());
      }
    }

    // Sort all results alphabetically, limit to 20
    results.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ data: results.slice(0, 20) });
  } catch (error) {
    next(error);
  }
});

// GET /api/clients/:id - Get single client
router.get('/clients/:id', async (req, res, next) => {
  try {
    const client = await Client.findByPk(req.params.id);
    
    if (!client) {
      return res.status(404).json({ error: { message: 'Client not found' } });
    }
    
    res.json({ data: client });
  } catch (error) {
    next(error);
  }
});

// POST /api/clients - Create client
router.post('/clients', async (req, res, next) => {
  try {
    const {
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      taxStatus,
      resaleCertificate,
      customTaxRate,
      notes
    } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: { message: 'Client name is required' } });
    }
    
    // Check for duplicate
    const existing = await Client.findOne({ where: { name: { [Op.iLike]: name } } });
    if (existing) {
      return res.status(400).json({ error: { message: 'A client with this name already exists' } });
    }
    
    const client = await Client.create({
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      taxStatus: taxStatus || 'taxable',
      resaleCertificate,
      customTaxRate: customTaxRate ? parseFloat(customTaxRate) : null,
      notes
    });
    
    res.status(201).json({ data: client, message: 'Client created successfully' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/clients/:id - Update client
router.put('/clients/:id', async (req, res, next) => {
  try {
    const client = await Client.findByPk(req.params.id);
    
    if (!client) {
      return res.status(404).json({ error: { message: 'Client not found' } });
    }
    
    const {
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      taxStatus,
      resaleCertificate,
      customTaxRate,
      notes,
      isActive
    } = req.body;
    
    // Check for duplicate name (excluding current)
    if (name && name !== client.name) {
      const existing = await Client.findOne({ 
        where: { 
          name: { [Op.iLike]: name },
          id: { [Op.ne]: client.id }
        } 
      });
      if (existing) {
        return res.status(400).json({ error: { message: 'A client with this name already exists' } });
      }
    }
    
    await client.update({
      name: name !== undefined ? name : client.name,
      contactName: contactName !== undefined ? contactName : client.contactName,
      contactPhone: contactPhone !== undefined ? contactPhone : client.contactPhone,
      contactEmail: contactEmail !== undefined ? contactEmail : client.contactEmail,
      address: address !== undefined ? address : client.address,
      taxStatus: taxStatus !== undefined ? taxStatus : client.taxStatus,
      resaleCertificate: resaleCertificate !== undefined ? resaleCertificate : client.resaleCertificate,
      customTaxRate: customTaxRate !== undefined ? (customTaxRate ? parseFloat(customTaxRate) : null) : client.customTaxRate,
      notes: notes !== undefined ? notes : client.notes,
      isActive: isActive !== undefined ? isActive : client.isActive
    });
    
    res.json({ data: client, message: 'Client updated successfully' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/clients/:id - Delete client (soft delete - set inactive)
router.delete('/clients/:id', async (req, res, next) => {
  try {
    const client = await Client.findByPk(req.params.id);
    
    if (!client) {
      return res.status(404).json({ error: { message: 'Client not found' } });
    }
    
    await client.update({ isActive: false });
    
    res.json({ message: 'Client deactivated successfully' });
  } catch (error) {
    next(error);
  }
});

// ============= VENDORS =============

// GET /api/vendors - Get all vendors
router.get('/vendors', async (req, res, next) => {
  try {
    const { search, active } = req.query;
    
    const where = {};
    if (active !== undefined) {
      where.isActive = active === 'true';
    }
    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
    }
    
    const vendors = await Vendor.findAll({
      where,
      order: [['name', 'ASC']]
    });
    
    res.json({ data: vendors });
  } catch (error) {
    next(error);
  }
});

// GET /api/vendors/search - Search vendors for autofill
router.get('/vendors/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    
    const where = { isActive: true };
    if (q && q.length >= 1) {
      where.name = { [Op.iLike]: `%${q}%` };
    }
    
    const vendors = await Vendor.findAll({
      where,
      limit: 20,
      order: [['name', 'ASC']]
    });
    
    res.json({ data: vendors });
  } catch (error) {
    next(error);
  }
});

// GET /api/vendors/:id - Get single vendor
router.get('/vendors/:id', async (req, res, next) => {
  try {
    const vendor = await Vendor.findByPk(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({ error: { message: 'Vendor not found' } });
    }
    
    res.json({ data: vendor });
  } catch (error) {
    next(error);
  }
});

// POST /api/vendors - Create vendor
router.post('/vendors', async (req, res, next) => {
  try {
    const {
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      accountNumber,
      notes
    } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: { message: 'Vendor name is required' } });
    }
    
    // Check for duplicate
    const existing = await Vendor.findOne({ where: { name: { [Op.iLike]: name } } });
    if (existing) {
      return res.status(400).json({ error: { message: 'A vendor with this name already exists' } });
    }
    
    const vendor = await Vendor.create({
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      accountNumber,
      notes
    });
    
    res.status(201).json({ data: vendor, message: 'Vendor created successfully' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/vendors/:id - Update vendor
router.put('/vendors/:id', async (req, res, next) => {
  try {
    const vendor = await Vendor.findByPk(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({ error: { message: 'Vendor not found' } });
    }
    
    const {
      name,
      contactName,
      contactPhone,
      contactEmail,
      address,
      accountNumber,
      notes,
      isActive
    } = req.body;
    
    // Check for duplicate name (excluding current)
    if (name && name !== vendor.name) {
      const existing = await Vendor.findOne({ 
        where: { 
          name: { [Op.iLike]: name },
          id: { [Op.ne]: vendor.id }
        } 
      });
      if (existing) {
        return res.status(400).json({ error: { message: 'A vendor with this name already exists' } });
      }
    }
    
    await vendor.update({
      name: name !== undefined ? name : vendor.name,
      contactName: contactName !== undefined ? contactName : vendor.contactName,
      contactPhone: contactPhone !== undefined ? contactPhone : vendor.contactPhone,
      contactEmail: contactEmail !== undefined ? contactEmail : vendor.contactEmail,
      address: address !== undefined ? address : vendor.address,
      accountNumber: accountNumber !== undefined ? accountNumber : vendor.accountNumber,
      notes: notes !== undefined ? notes : vendor.notes,
      isActive: isActive !== undefined ? isActive : vendor.isActive
    });
    
    res.json({ data: vendor, message: 'Vendor updated successfully' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/vendors/:id - Delete vendor (soft delete - set inactive)
router.delete('/vendors/:id', async (req, res, next) => {
  try {
    const vendor = await Vendor.findByPk(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({ error: { message: 'Vendor not found' } });
    }
    
    await vendor.update({ isActive: false });
    
    res.json({ message: 'Vendor deactivated successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
