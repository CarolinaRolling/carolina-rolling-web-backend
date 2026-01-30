const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const { Shipment, ShipmentPhoto, ShipmentDocument, AppSettings } = require('../models');

const router = express.Router();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Temp uploads directory for multer (files are deleted after Cloudinary upload)
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper function to get current time in Pacific timezone
function getPacificTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

// Helper function to format date for Pacific timezone display
function formatPacificDate(date) {
  if (!date) return null;
  return new Date(date).toLocaleString('en-US', { 
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

// Configure multer for temporary file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 // 10MB default
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

// Generate unique QR code
function generateQRCode() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `SHIP-${timestamp}-${random}`;
}

// Transform shipment for response (add formatted Pacific time)
function transformShipment(shipment) {
  const data = shipment.toJSON();
  data.receivedAtFormatted = formatPacificDate(data.receivedAt);
  data.createdAtFormatted = formatPacificDate(data.createdAt);
  data.updatedAtFormatted = formatPacificDate(data.updatedAt);
  return data;
}

// Upload file to Cloudinary
async function uploadToCloudinary(filePath, shipmentId) {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: `shipment-tracker/${shipmentId}`,
      resource_type: 'image',
      transformation: [
        { quality: 'auto:good' },
        { fetch_format: 'auto' }
      ]
    });
    return result;
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    throw error;
  }
}

// Delete file from Cloudinary
async function deleteFromCloudinary(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    // Don't throw - just log the error
  }
}

// Clean up temp file
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error cleaning up temp file:', error);
  }
}

// GET /api/shipments - Get all shipments
router.get('/', async (req, res, next) => {
  try {
    const { status, clientName, limit = 50, offset = 0 } = req.query;
    
    const where = {};
    if (status) where.status = status;
    if (clientName) where.clientName = { [require('sequelize').Op.iLike]: `%${clientName}%` };

    const shipments = await Shipment.findAndCountAll({
      where,
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ],
      order: [['receivedAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      data: shipments.rows.map(transformShipment),
      total: shipments.count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/shipments/:id - Get shipment by ID
router.get('/:id', async (req, res, next) => {
  try {
    const shipment = await Shipment.findByPk(req.params.id, {
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: { message: 'Shipment not found' } });
    }

    res.json({ data: transformShipment(shipment) });
  } catch (error) {
    next(error);
  }
});

// GET /api/shipments/qr/:qrCode - Get shipment by QR code
router.get('/qr/:qrCode', async (req, res, next) => {
  try {
    const shipment = await Shipment.findOne({
      where: { qrCode: req.params.qrCode },
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: { message: 'Shipment not found for this QR code' } });
    }

    res.json({ data: transformShipment(shipment) });
  } catch (error) {
    next(error);
  }
});

// POST /api/shipments - Create new shipment
router.post('/', async (req, res, next) => {
  try {
    const {
      clientName,
      jobNumber,
      clientPurchaseOrderNumber,
      description,
      partNumbers,
      quantity,
      location,
      notes,
      receivedBy,
      requestedDueDate,
      promisedDate
    } = req.body;

    if (!clientName) {
      return res.status(400).json({ error: { message: 'Client name is required' } });
    }

    const qrCode = generateQRCode();

    const shipment = await Shipment.create({
      qrCode,
      clientName,
      jobNumber,
      clientPurchaseOrderNumber,
      description,
      partNumbers: partNumbers || [],
      quantity: quantity || 1,
      location,
      notes,
      receivedBy,
      requestedDueDate: requestedDueDate || null,
      promisedDate: promisedDate || null,
      receivedAt: new Date()
    });

    // Reload with photos association
    const createdShipment = await Shipment.findByPk(shipment.id, {
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ]
    });

    // Send email notification
    try {
      await sendNewShipmentEmail(createdShipment);
    } catch (emailError) {
      console.error('Failed to send email notification:', emailError);
      // Don't fail the request if email fails
    }

    res.status(201).json({ 
      data: transformShipment(createdShipment),
      message: 'Shipment created successfully'
    });
  } catch (error) {
    next(error);
  }
});

// Helper function to send email notification for new shipment
async function sendNewShipmentEmail(shipment) {
  // Get notification email from settings
  const emailSetting = await AppSettings.findOne({
    where: { key: 'notification_email' }
  });
  
  const notificationEmail = emailSetting?.value?.email || 'carolinarolling@gmail.com';
  
  // Check if SMTP is configured
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('SMTP not configured, skipping email notification');
    return;
  }
  
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  
  const emailHtml = `
    <h2>New Shipment Received</h2>
    <p>A new shipment has been added to the inventory system.</p>
    <table style="border-collapse: collapse; width: 100%; max-width: 500px;">
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">QR Code</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.qrCode}</td>
      </tr>
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Client</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.clientName}</td>
      </tr>
      ${shipment.jobNumber ? `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Job Number</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.jobNumber}</td>
      </tr>
      ` : ''}
      ${shipment.clientPurchaseOrderNumber ? `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Client PO#</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.clientPurchaseOrderNumber}</td>
      </tr>
      ` : ''}
      ${shipment.description ? `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Description</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.description}</td>
      </tr>
      ` : ''}
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Quantity</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.quantity}</td>
      </tr>
      ${shipment.location ? `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Location</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.location}</td>
      </tr>
      ` : ''}
      ${shipment.requestedDueDate ? `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Requested Due Date</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.requestedDueDate}</td>
      </tr>
      ` : ''}
      ${shipment.promisedDate ? `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Promised Date</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.promisedDate}</td>
      </tr>
      ` : ''}
      ${shipment.receivedBy ? `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Received By</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${shipment.receivedBy}</td>
      </tr>
      ` : ''}
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Received At</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${formatPacificDate(shipment.receivedAt)}</td>
      </tr>
    </table>
  `;
  
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: notificationEmail,
    subject: `New Shipment: ${shipment.clientName} - ${shipment.qrCode}`,
    html: emailHtml
  });
  
  console.log(`Email notification sent to ${notificationEmail}`);
}

// PUT /api/shipments/:id - Update shipment
router.put('/:id', async (req, res, next) => {
  try {
    console.log('PUT /api/shipments/:id - Request body:', JSON.stringify(req.body, null, 2));
    
    const shipment = await Shipment.findByPk(req.params.id);

    if (!shipment) {
      return res.status(404).json({ error: { message: 'Shipment not found' } });
    }

    const allowedFields = [
      'clientName', 'jobNumber', 'clientPurchaseOrderNumber', 'description', 'partNumbers', 'quantity',
      'status', 'location', 'notes', 'receivedBy', 'requestedDueDate', 'promisedDate'
    ];

    const updates = {};
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        // Convert empty strings to null for date fields and other optional fields
        if (req.body[field] === '' || req.body[field] === null) {
          updates[field] = null;
        } else {
          updates[field] = req.body[field];
        }
      }
    });
    
    console.log('Updates to apply:', JSON.stringify(updates, null, 2));
    
    // Handle shippedAt timestamp
    if (updates.status === 'shipped' && shipment.status !== 'shipped') {
      // Setting to shipped - record the timestamp
      updates.shippedAt = new Date();
    } else if (updates.status && updates.status !== 'shipped' && shipment.status === 'shipped') {
      // Changing from shipped to something else - clear the timestamp
      updates.shippedAt = null;
    }

    await shipment.update(updates);

    const updatedShipment = await Shipment.findByPk(req.params.id, {
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ]
    });

    res.json({ 
      data: transformShipment(updatedShipment),
      message: 'Shipment updated successfully'
    });
  } catch (error) {
    console.error('PUT /api/shipments/:id error:', error);
    next(error);
  }
});

// DELETE /api/shipments/:id - Delete shipment
router.delete('/:id', async (req, res, next) => {
  try {
    const shipment = await Shipment.findByPk(req.params.id, {
      include: [
        { model: ShipmentPhoto, as: 'photos' },
        { model: ShipmentDocument, as: 'documents' }
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: { message: 'Shipment not found' } });
    }

    // Delete photos from Cloudinary
    for (const photo of shipment.photos) {
      if (photo.cloudinaryId) {
        await deleteFromCloudinary(photo.cloudinaryId);
      }
    }

    await shipment.destroy();

    res.json({ message: 'Shipment deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// POST /api/shipments/:id/photos - Upload photos for a shipment (using Cloudinary)
router.post('/:id/photos', upload.array('photos', 10), async (req, res, next) => {
  const tempFiles = [];
  
  try {
    const shipment = await Shipment.findByPk(req.params.id);

    if (!shipment) {
      // Clean up uploaded files if shipment not found
      req.files?.forEach(file => cleanupTempFile(file.path));
      return res.status(404).json({ error: { message: 'Shipment not found' } });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: { message: 'No files uploaded' } });
    }

    // Track temp files for cleanup
    tempFiles.push(...req.files.map(f => f.path));

    // Upload each file to Cloudinary
    const photos = await Promise.all(
      req.files.map(async (file) => {
        // Upload to Cloudinary
        const cloudinaryResult = await uploadToCloudinary(file.path, shipment.id);
        
        // Create database record
        const photo = await ShipmentPhoto.create({
          shipmentId: shipment.id,
          filename: file.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: cloudinaryResult.secure_url,
          cloudinaryId: cloudinaryResult.public_id
        });
        
        // Clean up temp file after successful upload
        cleanupTempFile(file.path);
        
        return photo;
      })
    );

    res.status(201).json({
      data: photos,
      message: `${photos.length} photo(s) uploaded successfully`
    });
  } catch (error) {
    // Clean up all temp files on error
    tempFiles.forEach(cleanupTempFile);
    next(error);
  }
});

// DELETE /api/shipments/:id/photos/:photoId - Delete a specific photo
router.delete('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const photo = await ShipmentPhoto.findOne({
      where: {
        id: req.params.photoId,
        shipmentId: req.params.id
      }
    });

    if (!photo) {
      return res.status(404).json({ error: { message: 'Photo not found' } });
    }

    // Delete from Cloudinary
    if (photo.cloudinaryId) {
      await deleteFromCloudinary(photo.cloudinaryId);
    }

    await photo.destroy();

    res.json({ message: 'Photo deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// Configure multer for PDF uploads
const pdfUpload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB for PDFs
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF files are allowed.'));
    }
  }
});

// POST /api/shipments/:id/documents - Upload PDF documents for a shipment
router.post('/:id/documents', pdfUpload.array('documents', 10), async (req, res, next) => {
  const tempFiles = [];
  
  try {
    const shipment = await Shipment.findByPk(req.params.id);

    if (!shipment) {
      req.files?.forEach(file => cleanupTempFile(file.path));
      return res.status(404).json({ error: { message: 'Shipment not found' } });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: { message: 'No files uploaded' } });
    }

    tempFiles.push(...req.files.map(f => f.path));

    // Upload each file to Cloudinary as private (requires signed URL to access)
    const documents = await Promise.all(
      req.files.map(async (file) => {
        // Upload to Cloudinary as private file
        // 'private' type allows access via signed URLs generated with private_download_url
        const cloudinaryResult = await cloudinary.uploader.upload(file.path, {
          folder: `shipment-tracker/${shipment.id}/documents`,
          resource_type: 'raw',
          type: 'private',  // Private - requires signed URL via private_download_url
          use_filename: true,
          unique_filename: true
        });
        
        console.log('Cloudinary private upload result:', {
          public_id: cloudinaryResult.public_id,
          secure_url: cloudinaryResult.secure_url,
          type: cloudinaryResult.type
        });
        
        // Create database record - store the public_id, we'll generate signed URLs on demand
        const doc = await ShipmentDocument.create({
          shipmentId: shipment.id,
          filename: file.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: cloudinaryResult.secure_url,  // Base URL (won't work without signature)
          cloudinaryId: cloudinaryResult.public_id
        });
        
        cleanupTempFile(file.path);
        
        return doc;
      })
    );

    res.status(201).json({
      data: documents,
      message: `${documents.length} document(s) uploaded successfully`
    });
  } catch (error) {
    console.error('Document upload error:', error);
    tempFiles.forEach(cleanupTempFile);
    next(error);
  }
});

// POST /api/shipments/:id/documents/register - Register a document stored on NAS
router.post('/:id/documents/register', async (req, res, next) => {
  try {
    const shipment = await Shipment.findByPk(req.params.id);

    if (!shipment) {
      return res.status(404).json({ error: { message: 'Shipment not found' } });
    }

    const { filename, url, originalName } = req.body;

    if (!filename || !url) {
      return res.status(400).json({ error: { message: 'Filename and URL are required' } });
    }

    // Create database record for NAS-stored document
    const doc = await ShipmentDocument.create({
      shipmentId: shipment.id,
      filename: filename,
      originalName: originalName || filename,
      mimeType: 'application/pdf',
      size: 0,
      url: url,
      cloudinaryId: null
    });

    res.status(201).json({
      data: doc,
      message: 'Document registered successfully'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/shipments/:shipmentId/documents/:documentId/signed-url - Get URL for document
router.get('/:shipmentId/documents/:documentId/signed-url', async (req, res, next) => {
  try {
    const { shipmentId, documentId } = req.params;
    
    const doc = await ShipmentDocument.findOne({
      where: { id: documentId, shipmentId: shipmentId }
    });
    
    if (!doc) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }
    
    // If it's a Cloudinary document, generate signed URL
    if (doc.cloudinaryId) {
      // Use private_download_url for private/authenticated resources
      // This generates a time-limited signed URL for downloading
      // Works with both 'private' and 'authenticated' upload types
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;  // 1 hour
      
      const signedUrl = cloudinary.utils.private_download_url(
        doc.cloudinaryId,
        'raw',  // format - use 'raw' for non-image files like PDFs
        {
          resource_type: 'raw',
          expires_at: expiresAt,
          attachment: false  // false = display inline, true = force download
        }
      );
      
      console.log('Generated private_download_url for document:', {
        cloudinaryId: doc.cloudinaryId,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        signedUrl: signedUrl
      });
      
      return res.json({
        data: {
          url: signedUrl,
          expiresIn: 3600,
          originalName: doc.originalName || doc.filename
        }
      });
    }
    
    // For non-Cloudinary documents (NAS), return the direct URL
    res.json({
      data: {
        url: doc.url,
        expiresIn: null,
        originalName: doc.originalName || doc.filename
      }
    });
  } catch (error) {
    console.error('Error getting document URL:', error);
    next(error);
  }
});

// GET /api/shipments/documents/nas-urls - Get all NAS document URLs for cleanup
router.get('/documents/nas-urls', async (req, res, next) => {
  try {
    const documents = await ShipmentDocument.findAll({
      where: {
        cloudinaryId: null // NAS documents don't have cloudinaryId
      },
      attributes: ['url']
    });
    
    const urls = documents.map(doc => doc.url).filter(url => url && url.includes('192.168.1.13'));
    
    res.json({
      data: urls,
      count: urls.length
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/shipments/:id/documents/:documentId - Delete a specific document
router.delete('/:id/documents/:documentId', async (req, res, next) => {
  try {
    const doc = await ShipmentDocument.findOne({
      where: {
        id: req.params.documentId,
        shipmentId: req.params.id
      }
    });

    if (!doc) {
      return res.status(404).json({ error: { message: 'Document not found' } });
    }

    // Store NAS URL for client-side deletion
    const nasUrl = (!doc.cloudinaryId && doc.url && doc.url.includes('192.168.1.13')) ? doc.url : null;
    
    // Extract filename from URL for NAS deletion
    let nasFilename = null;
    if (nasUrl) {
      // URL format: http://192.168.1.13:5005/shipment-documents/FILENAME.pdf
      const urlParts = nasUrl.split('/');
      nasFilename = urlParts[urlParts.length - 1];
    }

    // Delete from Cloudinary if stored there
    if (doc.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(doc.cloudinaryId, { resource_type: 'raw' });
      } catch (e) {
        console.error('Failed to delete from Cloudinary:', e);
      }
    }

    await doc.destroy();

    res.json({ 
      message: 'Document deleted successfully',
      nasFile: nasFilename ? {
        url: nasUrl,
        filename: nasFilename
      } : null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
