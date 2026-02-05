import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, Edit, Save, X, Trash2, Plus, Package, FileText, User, 
  Calendar, Printer, Check, Upload, Eye, Tag, Truck, MapPin, Clock, File, ShoppingCart, Download, Link2, Unlink
} from 'lucide-react';
import PlateRollForm from '../components/PlateRollForm';
import { 
  getWorkOrderById, updateWorkOrder, deleteWorkOrder,
  addWorkOrderPart, updateWorkOrderPart, deleteWorkOrderPart,
  uploadPartFiles, getPartFileSignedUrl, deletePartFile,
  uploadWorkOrderDocuments, getWorkOrderDocumentSignedUrl, deleteWorkOrderDocument,
  getShipmentByWorkOrderId, getNextPONumber, orderWorkOrderMaterial,
  searchVendors, searchLinkableEstimates, linkEstimateToWorkOrder, unlinkEstimateFromWorkOrder,
  searchClients
} from '../services/api';

const PART_TYPES = {
  plate_roll: { label: 'Plate Roll', fields: ['material', 'thickness', 'width', 'length', 'rollType', 'radius', 'diameter', 'arcDegrees'] },
  section_roll: { label: 'Section Roll', fields: ['material', 'sectionSize', 'length', 'rollType', 'radius', 'diameter', 'arcDegrees', 'flangeOut'] },
  angle_roll: { label: 'Angle Roll', fields: ['material', 'sectionSize', 'length', 'rollType', 'radius', 'diameter', 'arcDegrees', 'flangeOut'] },
  beam_roll: { label: 'Beam Roll', fields: ['material', 'sectionSize', 'length', 'rollType', 'radius', 'diameter', 'arcDegrees', 'flangeOut'] },
  pipe_roll: { label: 'Pipe/Tube Roll', fields: ['material', 'outerDiameter', 'wallThickness', 'length', 'radius', 'diameter', 'arcDegrees'] },
  channel_roll: { label: 'Channel Roll', fields: ['material', 'sectionSize', 'length', 'rollType', 'radius', 'diameter', 'arcDegrees', 'flangeOut'] },
  flat_bar: { label: 'Flat Bar', fields: ['material', 'thickness', 'width', 'length', 'rollType', 'radius', 'diameter', 'arcDegrees'] },
  other: { label: 'Other', fields: ['material', 'thickness', 'width', 'length', 'sectionSize', 'outerDiameter', 'wallThickness', 'rollType', 'radius', 'diameter', 'arcDegrees'] }
};

function WorkOrderDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [shipment, setShipment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [showReceivingInfo, setShowReceivingInfo] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [showPartModal, setShowPartModal] = useState(false);
  const [editingPart, setEditingPart] = useState(null);
  const [partData, setPartData] = useState({});
  const [selectedPartType, setSelectedPartType] = useState('');
  const [uploadingFiles, setUploadingFiles] = useState(null);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [showPickupModal, setShowPickupModal] = useState(false);
  const [pickupData, setPickupData] = useState({ pickedUpBy: '' });
  const [showPrintMenu, setShowPrintMenu] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [orderPONumber, setOrderPONumber] = useState('');
  const [selectedPartIds, setSelectedPartIds] = useState([]);
  const [ordering, setOrdering] = useState(false);
  const [vendorSuggestions, setVendorSuggestions] = useState([]);
  const [showVendorSuggestions, setShowVendorSuggestions] = useState(false);
  const [showLinkEstimateModal, setShowLinkEstimateModal] = useState(false);
  const [estimateSearchQuery, setEstimateSearchQuery] = useState('');
  const [estimateSearchResults, setEstimateSearchResults] = useState([]);
  const [searchingEstimates, setSearchingEstimates] = useState(false);
  const [linkingEstimate, setLinkingEstimate] = useState(false);
  const [clientSuggestions, setClientSuggestions] = useState([]);
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const fileInputRefs = useRef({});
  const docInputRef = useRef(null);

  useEffect(() => { loadOrder(); }, [id]);

  const loadOrder = async () => {
    try {
      setLoading(true);
      const response = await getWorkOrderById(id);
      const data = response.data.data;
      setOrder(data);
      setEditData({
        clientId: data.clientId || null,
        clientName: data.clientName || '',
        clientPurchaseOrderNumber: data.clientPurchaseOrderNumber || '',
        jobNumber: data.jobNumber || '',
        contactName: data.contactName || '',
        contactPhone: data.contactPhone || '',
        contactEmail: data.contactEmail || '',
        storageLocation: data.storageLocation || '',
        notes: data.notes || '',
        receivedBy: data.receivedBy || '',
        requestedDueDate: data.requestedDueDate || '',
        promisedDate: data.promisedDate || '',
        // Pricing fields
        truckingDescription: data.truckingDescription || '',
        truckingCost: data.truckingCost || '',
        taxRate: data.taxRate || '0.0975',
      });

      // Load linked shipment
      try {
        const shipmentResponse = await getShipmentByWorkOrderId(data.id);
        setShipment(shipmentResponse.data.data);
      } catch (shipErr) {
        setShipment(null);
      }
    } catch (err) {
      setError('Failed to load work order');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveOrder = async () => {
    try {
      setSaving(true);
      setError(null);
      console.log('Saving editData:', editData);
      const response = await updateWorkOrder(id, editData);
      console.log('Save response:', response);
      await loadOrder();
      setIsEditing(false);
      showMessage('Work order updated');
    } catch (err) {
      console.error('Save error:', err);
      console.error('Response data:', err.response?.data);
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      setError('Failed to save changes: ' + errorMsg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this work order?')) return;
    try {
      await deleteWorkOrder(id);
      navigate('/inventory');
    } catch (err) {
      setError('Failed to delete');
    }
  };

  const handleStatusChange = async (newStatus) => {
    try {
      await updateWorkOrder(id, { status: newStatus });
      await loadOrder();
      showMessage(`Status: ${newStatus.replace('_', ' ')}`);
    } catch (err) {
      setError('Failed to update status');
    }
  };

  const showMessage = (msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  // Document upload for order
  const handleDocumentUpload = async (files) => {
    try {
      setUploadingDocs(true);
      await uploadWorkOrderDocuments(id, files);
      await loadOrder();
      showMessage('Documents uploaded');
    } catch (err) {
      setError('Failed to upload documents');
    } finally {
      setUploadingDocs(false);
    }
  };

  const handleViewDocument = async (documentId) => {
    try {
      const response = await getWorkOrderDocumentSignedUrl(id, documentId);
      window.open(response.data.data.url, '_blank');
    } catch (err) {
      setError('Failed to open document');
    }
  };

  const handleDeleteDocument = async (documentId) => {
    if (!window.confirm('Delete this document?')) return;
    try {
      await deleteWorkOrderDocument(id, documentId);
      await loadOrder();
      showMessage('Document deleted');
    } catch (err) {
      setError('Failed to delete document');
    }
  };

  // Part functions
  const openAddPartModal = () => {
    setEditingPart(null);
    setSelectedPartType('');
    setPartData({ clientPartNumber: '', heatNumber: '', quantity: 1, material: '', thickness: '', width: '', length: '',
      outerDiameter: '', wallThickness: '', rollType: '', radius: '', diameter: '', arcDegrees: '', sectionSize: '', flangeOut: false, specialInstructions: '',
      laborRate: '', laborHours: '', laborTotal: '', materialUnitCost: '', materialTotal: '', setupCharge: '', otherCharges: '', partTotal: '',
      materialSource: 'customer', vendorId: null, supplierName: '', materialDescription: '' });
    setShowPartModal(true);
  };

  const openEditPartModal = (part) => {
    setEditingPart(part);
    setSelectedPartType(part.partType);
    setPartData({ ...part, quantity: part.quantity || 1 });
    setShowPartModal(true);
  };

  const handleSavePart = async () => {
    if (!selectedPartType) { setError('Select a part type'); return; }
    try {
      setSaving(true);
      setError(null);
      const data = { partType: selectedPartType, ...partData, quantity: parseInt(partData.quantity) || 1 };
      console.log('Saving part data:', data);
      if (editingPart) {
        await updateWorkOrderPart(id, editingPart.id, data);
      } else {
        await addWorkOrderPart(id, data);
      }
      await loadOrder();
      setShowPartModal(false);
      showMessage(editingPart ? 'Part updated' : 'Part added');
    } catch (err) {
      console.error('Save part error:', err.response?.data || err);
      setError(err.response?.data?.error?.message || 'Failed to save part - check console');
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePart = async (partId) => {
    if (!window.confirm('Delete this part?')) return;
    try {
      await deleteWorkOrderPart(id, partId);
      await loadOrder();
      showMessage('Part deleted');
    } catch (err) {
      setError('Failed to delete part');
    }
  };

  const handlePartStatusChange = async (partId, status) => {
    try {
      await updateWorkOrderPart(id, partId, { status });
      await loadOrder();
    } catch (err) {
      setError('Failed to update part status');
    }
  };

  const handleFileUpload = async (partId, files) => {
    try {
      setUploadingFiles(partId);
      await uploadPartFiles(id, partId, files);
      await loadOrder();
      showMessage('Files uploaded');
    } catch (err) {
      setError('Failed to upload files');
    } finally {
      setUploadingFiles(null);
    }
  };

  const handleViewFile = async (partId, fileId) => {
    try {
      const response = await getPartFileSignedUrl(id, partId, fileId);
      window.open(response.url, '_blank');
    } catch (err) {
      setError('Failed to open file');
    }
  };

  const handleDeleteFile = async (partId, fileId) => {
    if (!window.confirm('Delete this file?')) return;
    try {
      await deletePartFile(id, partId, fileId);
      await loadOrder();
      showMessage('File deleted');
    } catch (err) {
      setError('Failed to delete file');
    }
  };

  const handlePickup = async () => {
    try {
      setError(null);
      const response = await updateWorkOrder(id, { 
        status: 'picked_up', 
        pickedUpBy: pickupData.pickedUpBy, 
        pickedUpAt: new Date().toISOString() 
      });
      console.log('Pickup response:', response);
      await loadOrder();
      setShowPickupModal(false);
      showMessage('Marked as picked up');
    } catch (err) {
      console.error('Pickup error:', err.response?.data || err);
      setError(err.response?.data?.error?.message || 'Failed to update - check console for details');
    }
  };

  // Comprehensive print function
  const printFullWorkOrder = async () => {
    const printWindow = window.open('', '_blank');
    const clientPO = order.clientPurchaseOrderNumber || shipment?.clientPurchaseOrderNumber;
    
    // Build parts HTML with detailed instructions
    const partsHtml = order.parts?.sort((a, b) => a.partNumber - b.partNumber).map(p => {
      const pdfFiles = p.files?.filter(f => f.mimeType === 'application/pdf' || f.originalName?.toLowerCase().endsWith('.pdf')) || [];
      
      return `
        <div style="border:2px solid #1976d2;padding:16px;margin-bottom:16px;border-radius:8px;page-break-inside:avoid">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #1976d2">
            <div style="font-size:1.2rem;font-weight:bold;color:#1976d2">Part #${p.partNumber} - ${PART_TYPES[p.partType]?.label || p.partType}</div>
            <div style="background:#e3f2fd;padding:4px 12px;border-radius:4px;font-weight:bold">Qty: ${p.quantity}</div>
          </div>
          
          ${p.clientPartNumber ? `<div style="margin-bottom:8px"><strong>Client Part#:</strong> ${p.clientPartNumber}</div>` : ''}
          ${p.heatNumber ? `<div style="margin-bottom:8px"><strong>Heat#:</strong> ${p.heatNumber}</div>` : ''}
          
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px;background:#f5f5f5;padding:12px;border-radius:4px">
            ${p.material ? `<div><strong>Material:</strong><br/>${p.material}</div>` : ''}
            ${p.thickness ? `<div><strong>Thickness:</strong><br/>${p.thickness}</div>` : ''}
            ${p.width ? `<div><strong>Width:</strong><br/>${p.width}</div>` : ''}
            ${p.length ? `<div><strong>Length:</strong><br/>${p.length}</div>` : ''}
            ${p.sectionSize ? `<div><strong>Section:</strong><br/>${p.sectionSize}</div>` : ''}
            ${p.outerDiameter ? `<div><strong>OD:</strong><br/>${p.outerDiameter}</div>` : ''}
            ${p.wallThickness ? `<div><strong>Wall:</strong><br/>${p.wallThickness}</div>` : ''}
            ${p.rollType ? `<div><strong>Roll Type:</strong><br/>${p.rollType === 'easy_way' ? 'Easy Way' : 'Hard Way'}</div>` : ''}
            ${p.radius ? `<div><strong>Radius:</strong><br/>${p.radius}</div>` : ''}
            ${p.diameter ? `<div><strong>Diameter:</strong><br/>${p.diameter}</div>` : ''}
            ${p.arcDegrees ? `<div><strong>Arc:</strong><br/>${p.arcDegrees}°</div>` : ''}
            ${p.flangeOut ? `<div><strong>Flange Out:</strong><br/>Yes</div>` : ''}
          </div>
          
          ${p.specialInstructions ? `
            <div style="background:#fff3e0;padding:12px;border-radius:4px;border-left:4px solid #ff9800">
              <strong style="color:#e65100">Special Instructions:</strong><br/>
              <div style="white-space:pre-wrap;margin-top:4px">${p.specialInstructions}</div>
            </div>
          ` : ''}
          
          ${pdfFiles.length > 0 ? `
            <div style="margin-top:12px;padding:8px;background:#e3f2fd;border-radius:4px">
              <strong>📎 Attached Documents:</strong> ${pdfFiles.map(f => f.originalName).join(', ')}
              <div style="font-size:0.8em;color:#666;margin-top:4px">See attached PDF pages for Part #${p.partNumber}</div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('') || '<p style="color:#666">No parts added yet</p>';

    // Build order documents HTML
    const orderDocsHtml = order.documents?.length > 0 ? `
      <div style="margin-top:20px;padding:12px;background:#f5f5f5;border-radius:4px">
        <strong>📁 Order Documents:</strong>
        <ul style="margin:8px 0 0 20px">
          ${order.documents.map(d => `<li>${d.originalName}</li>`).join('')}
        </ul>
      </div>
    ` : '';

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>Work Order - ${order.drNumber ? `DR-${order.drNumber}` : order.orderNumber}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
    h1 { color: #1976d2; border-bottom: 3px solid #1976d2; padding-bottom: 10px; }
    .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .header-item { padding: 10px; background: #f5f5f5; border-radius: 4px; }
    .header-item strong { color: #333; }
    @media print { 
      body { padding: 10px; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <h1>📋 Work Order: ${order.drNumber ? `DR-${order.drNumber}` : order.orderNumber}</h1>
  
  <div class="header-grid">
    <div class="header-item"><strong>Client:</strong><br/>${order.clientName}</div>
    ${clientPO ? `<div class="header-item"><strong>Client PO#:</strong><br/>${clientPO}</div>` : '<div></div>'}
    ${order.contactName ? `<div class="header-item"><strong>Contact:</strong><br/>${order.contactName}${order.contactPhone ? ` - ${order.contactPhone}` : ''}</div>` : '<div></div>'}
    ${order.promisedDate ? `<div class="header-item"><strong>Promised Date:</strong><br/>${new Date(order.promisedDate).toLocaleDateString()}</div>` : '<div></div>'}
    ${order.storageLocation ? `<div class="header-item"><strong>Storage Location:</strong><br/>${order.storageLocation}</div>` : '<div></div>'}
    <div class="header-item"><strong>Status:</strong><br/>${order.status?.replace('_', ' ').toUpperCase()}</div>
  </div>

  ${order.notes ? `
    <div style="padding:12px;background:#e3f2fd;border-radius:4px;margin-bottom:20px;border-left:4px solid #1976d2">
      <strong>Notes:</strong><br/>${order.notes}
    </div>
  ` : ''}

  ${orderDocsHtml}

  <h2 style="color:#1976d2;border-bottom:2px solid #1976d2;padding-bottom:8px;margin-top:30px">
    Parts List (${order.parts?.length || 0} parts)
  </h2>
  
  ${partsHtml}

  <div style="margin-top:40px;padding-top:20px;border-top:2px solid #ddd;color:#666;font-size:0.85em">
    Printed: ${new Date().toLocaleString()}<br/>
    Work Order: ${order.orderNumber}
  </div>
</body>
</html>`);
    
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 500);
    setShowPrintMenu(false);
  };

  const printPartLabel = (part) => {
    const printWindow = window.open('', '_blank');
    const clientPO = order.clientPurchaseOrderNumber || shipment?.clientPurchaseOrderNumber;
    printWindow.document.write(`<!DOCTYPE html><html><head><title>Label</title>
      <style>@page{size:62mm 29mm;margin:0}body{font-family:Arial;width:62mm;height:29mm;padding:2mm;margin:0;box-sizing:border-box}
      .lg{font-size:14pt;font-weight:bold}.sm{font-size:9pt;color:#333}</style></head>
      <body><div class="lg">${part.clientPartNumber || `Part ${part.partNumber}`}</div>
      <div class="sm">${order.drNumber ? `DR-${order.drNumber}` : order.orderNumber}</div>
      ${clientPO ? `<div class="sm">PO: ${clientPO}</div>` : ''}
      ${part.heatNumber ? `<div class="sm">Heat: ${part.heatNumber}</div>` : ''}
      <div class="sm">Qty: ${part.quantity}</div></body></html>`);
    printWindow.document.close();
    printWindow.print();
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A';
  const formatDateTime = (d) => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'N/A';
  // === Link Estimate Handlers ===
  const handleSearchEstimates = async (query) => {
    setEstimateSearchQuery(query);
    if (query.length < 2) {
      setEstimateSearchResults([]);
      return;
    }
    try {
      setSearchingEstimates(true);
      const response = await searchLinkableEstimates(query);
      setEstimateSearchResults(response.data.data || []);
    } catch (err) {
      console.error('Search estimates error:', err);
    } finally {
      setSearchingEstimates(false);
    }
  };

  const handleLinkEstimate = async (estimateId) => {
    if (!window.confirm('Link this estimate to the work order? This will copy all parts, pricing, and client info from the estimate.')) return;
    try {
      setLinkingEstimate(true);
      const response = await linkEstimateToWorkOrder(id, estimateId);
      showMessage(response.data.message);
      setShowLinkEstimateModal(false);
      setEstimateSearchQuery('');
      setEstimateSearchResults([]);
      await loadOrder();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to link estimate');
    } finally {
      setLinkingEstimate(false);
    }
  };

  const handleUnlinkEstimate = async () => {
    if (!window.confirm('Unlink the estimate from this work order? Parts already copied will remain.')) return;
    try {
      await unlinkEstimateFromWorkOrder(id);
      showMessage('Estimate unlinked');
      await loadOrder();
    } catch (err) {
      setError('Failed to unlink estimate');
    }
  };

  const formatCurrency = (val) => {
    const num = parseFloat(val) || 0;
    return '$' + num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  // Calculate pricing totals
  const calculateTotals = () => {
    const parts = order?.parts || [];
    const partsSubtotal = parts.reduce((sum, p) => sum + (parseFloat(p.partTotal) || 0), 0);
    const trucking = parseFloat(editData.truckingCost) || parseFloat(order?.truckingCost) || 0;
    const subtotal = partsSubtotal + trucking;
    const taxRate = parseFloat(editData.taxRate) || parseFloat(order?.taxRate) || 0.0975;
    const taxAmount = subtotal * taxRate;
    const grandTotal = subtotal + taxAmount;
    return { partsSubtotal, trucking, subtotal, taxRate, taxAmount, grandTotal };
  };
  
  // Order Material functions
  const getOrderableParts = () => {
    if (!order?.parts) return [];
    // Parts that need ordering: materialSource is 'we_order' AND not already ordered
    return order.parts.filter(p => 
      p.materialSource === 'we_order' && 
      !p.materialOrdered // false or null/undefined
    );
  };

  const getSupplierGroups = () => {
    const groups = {};
    order.parts?.filter(p => selectedPartIds.includes(p.id)).forEach(part => {
      const supplier = part.vendor?.name || part.supplierName || 'Unknown Supplier';
      if (!groups[supplier]) groups[supplier] = [];
      groups[supplier].push(part);
    });
    return groups;
  };

  const openOrderModal = async () => {
    // Debug: show all parts and their orderable status
    console.log('All parts:', order?.parts?.map(p => ({
      id: p.id,
      partNumber: p.partNumber,
      materialSource: p.materialSource,
      materialOrdered: p.materialOrdered,
      materialDescription: p.materialDescription,
      supplierName: p.supplierName
    })));
    
    const orderableParts = getOrderableParts();
    console.log('Orderable parts:', orderableParts);
    
    if (orderableParts.length === 0) {
      setError('No parts need material ordering. Parts need materialSource="we_order" and not already ordered.');
      return;
    }
    setSelectedPartIds(orderableParts.map(p => p.id));
    
    try {
      const poRes = await getNextPONumber();
      setOrderPONumber(poRes.data.data.nextNumber.toString());
    } catch (err) {
      setOrderPONumber('');
    }
    
    setShowOrderModal(true);
  };

  const handleOrderMaterial = async () => {
    if (!orderPONumber.trim()) { setError('PO number required'); return; }
    if (selectedPartIds.length === 0) { setError('Select at least one part'); return; }
    try {
      setOrdering(true);
      await orderWorkOrderMaterial(id, { purchaseOrderNumber: orderPONumber, partIds: selectedPartIds });
      await loadOrder();
      setShowOrderModal(false);
      setSuccess('Purchase orders created! Check Inbound & Purchase Orders pages.');
      setTimeout(() => setSuccess(null), 5000);
    } catch (err) { 
      setError(err.response?.data?.error?.message || 'Failed to create orders'); 
    }
    finally { setOrdering(false); }
  };

  const StatusBadge = ({ status }) => {
    const styles = {
      quoted: { background: '#f5f5f5', color: '#666' },
      work_order_generated: { background: '#f3e5f5', color: '#7b1fa2' },
      waiting_for_materials: { background: '#fff3e0', color: '#f57c00' },
      received: { background: '#e3f2fd', color: '#1565c0' },
      processing: { background: '#e1f5fe', color: '#0288d1' },
      stored: { background: '#e8f5e9', color: '#2e7d32' },
      shipped: { background: '#f3e5f5', color: '#7b1fa2' },
      archived: { background: '#eceff1', color: '#546e7a' },
      pending: { background: '#e0e0e0', color: '#555' },
      // Legacy mappings
      draft: { background: '#e3f2fd', color: '#1565c0' },
      in_progress: { background: '#e1f5fe', color: '#0288d1' },
      completed: { background: '#e8f5e9', color: '#2e7d32' },
      picked_up: { background: '#f3e5f5', color: '#7b1fa2' },
    };
    const labels = {
      quoted: 'Quoted',
      work_order_generated: 'WO Generated',
      waiting_for_materials: 'Waiting Materials',
      received: 'Received',
      processing: 'Processing',
      stored: 'Stored',
      shipped: 'Shipped',
      archived: 'Archived',
      pending: 'Pending',
      draft: 'Received',
      in_progress: 'Processing',
      completed: 'Stored',
      picked_up: 'Shipped'
    };
    return <span className="status-badge" style={styles[status] || styles.received}>{labels[status] || status?.replace('_', ' ')}</span>;
  };

  if (loading) return <div className="loading"><div className="spinner"></div></div>;
  if (!order) return <div className="empty-state"><div className="empty-state-title">Not found</div><button className="btn btn-primary" onClick={() => navigate('/inventory')}>Back</button></div>;

  const hasNoParts = !order.parts || order.parts.length === 0;
  const clientPO = order.clientPurchaseOrderNumber || shipment?.clientPurchaseOrderNumber;

  return (
    <div>
      <div className="detail-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button className="btn btn-icon btn-secondary" onClick={() => navigate('/inventory')}><ArrowLeft size={20} /></button>
          <div>
            {order.drNumber ? (
              <h1 className="detail-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontFamily: 'Courier New, monospace', background: '#e3f2fd', padding: '4px 12px', borderRadius: 6, color: '#1976d2' }}>
                  DR-{order.drNumber}
                </span>
              </h1>
            ) : (
              <h1 className="detail-title">{order.orderNumber}</h1>
            )}
            <div style={{ color: '#666', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>{order.clientName}</span>
              <StatusBadge status={hasNoParts ? 'pending' : order.status} />
              {hasNoParts && <span style={{ color: '#9c27b0', fontSize: '0.8rem' }}>(Awaiting Instructions)</span>}
            </div>
          </div>
        </div>
        <div className="actions-row">
          {order.status !== 'shipped' && order.status !== 'picked_up' && (
            <>
              <select className="form-select" value={order.status} onChange={(e) => handleStatusChange(e.target.value)} style={{ width: 'auto' }}>
                <option value="waiting_for_materials">Waiting for Materials</option>
                <option value="received">Received</option>
                <option value="processing">Processing</option>
                <option value="stored">Stored</option>
                <option value="shipped">Shipped</option>
              </select>
              {order.status === 'stored' && <button className="btn btn-success" onClick={() => setShowPickupModal(true)}><Check size={18} />Pickup/Ship</button>}
            </>
          )}
          <div style={{ position: 'relative' }}>
            <button className="btn btn-primary" onClick={() => setShowPrintMenu(!showPrintMenu)}><Printer size={18} />Print</button>
            {showPrintMenu && (
              <div style={{ position: 'absolute', top: '100%', right: 0, background: 'white', border: '1px solid #ddd', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 100, minWidth: 200 }}>
                <button onClick={printFullWorkOrder} style={{ display: 'block', width: '100%', padding: '12px 16px', border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', fontWeight: 600 }}>
                  📋 Full Work Order
                </button>
                <div style={{ borderTop: '1px solid #eee' }}></div>
                <button onClick={() => { setShowPrintMenu(false); }} style={{ display: 'block', width: '100%', padding: '10px 16px', border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', color: '#666', fontSize: '0.9rem' }}>Cancel</button>
              </div>
            )}
          </div>
          <button className="btn btn-danger" onClick={handleDelete}><Trash2 size={18} /></button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* Toggle for Receiving Info */}
      {shipment && (
        <div style={{ marginBottom: 16 }}>
          <button 
            className={`btn ${showReceivingInfo ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setShowReceivingInfo(!showReceivingInfo)}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <Truck size={18} />
            {showReceivingInfo ? 'Hide Receiving Info' : 'Show Receiving Info'}
            {shipment.photos?.length > 0 && <span style={{ background: '#4caf50', color: 'white', borderRadius: 10, padding: '2px 6px', fontSize: '0.7rem' }}>{shipment.photos.length} 📷</span>}
          </button>
        </div>
      )}

      {/* Receiving Info Panel */}
      {showReceivingInfo && shipment && (
        <div className="card" style={{ marginBottom: 20, borderLeft: '4px solid #4caf50' }}>
          <div className="card-header">
            <h3 className="card-title"><Truck size={20} style={{ marginRight: 8 }} />Receiving Info</h3>
          </div>
          
          <div className="detail-grid">
            <div className="detail-item">
              <div className="detail-item-label"><Clock size={14} /> Received</div>
              <div className="detail-item-value">{formatDateTime(shipment.receivedAt)}</div>
            </div>
            {shipment.receivedBy && (
              <div className="detail-item">
                <div className="detail-item-label"><User size={14} /> Received By</div>
                <div className="detail-item-value">{shipment.receivedBy}</div>
              </div>
            )}
            <div className="detail-item">
              <div className="detail-item-label">Quantity</div>
              <div className="detail-item-value">{shipment.quantity} piece{shipment.quantity !== 1 ? 's' : ''}</div>
            </div>
            {shipment.location && (
              <div className="detail-item">
                <div className="detail-item-label"><MapPin size={14} /> Storage Location</div>
                <div className="detail-item-value">{shipment.location}</div>
              </div>
            )}
          </div>

          {shipment.description && (
            <div style={{ marginTop: 16, padding: 16, background: '#e3f2fd', borderRadius: 8, borderLeft: '4px solid #1976d2' }}>
              <div style={{ fontWeight: 600, color: '#1565c0', marginBottom: 8 }}>Material Description</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{shipment.description}</div>
            </div>
          )}

          {shipment.notes && (
            <div style={{ marginTop: 16, padding: 16, background: '#fff3e0', borderRadius: 8, borderLeft: '4px solid #ff9800' }}>
              <div style={{ fontWeight: 600, color: '#e65100', marginBottom: 8 }}>Receiving Notes</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{shipment.notes}</div>
            </div>
          )}

          {/* Photos */}
          {shipment.photos && shipment.photos.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>📷 Photos ({shipment.photos.length})</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
                {shipment.photos.map(photo => (
                  <div key={photo.id} style={{ 
                    aspectRatio: '1', 
                    borderRadius: 8, 
                    overflow: 'hidden', 
                    cursor: 'pointer',
                    border: '2px solid #ddd'
                  }} onClick={() => window.open(photo.url, '_blank')}>
                    <img 
                      src={photo.thumbnailUrl || photo.url} 
                      alt="Shipment" 
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Order Details Card */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Order Details</h3>
          {isEditing ? (
            <div className="actions-row">
              <button className="btn btn-primary btn-sm" onClick={handleSaveOrder} disabled={saving}><Save size={16} />{saving ? 'Saving...' : 'Save'}</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setIsEditing(false)}><X size={16} />Cancel</button>
            </div>
          ) : (
            <button className="btn btn-outline btn-sm" onClick={() => setIsEditing(true)}><Edit size={16} />Edit</button>
          )}
        </div>
        {isEditing ? (
          <div className="grid grid-2">
            <div className="form-group" style={{ position: 'relative' }}>
              <label className="form-label">Client *</label>
              <input 
                className="form-input" 
                value={editData._clientSearch !== undefined ? editData._clientSearch : editData.clientName} 
                onChange={async (e) => {
                  const value = e.target.value;
                  setEditData({ ...editData, _clientSearch: value });
                  if (value.length >= 1) {
                    try {
                      const res = await searchClients(value);
                      setClientSuggestions(res.data.data || []);
                      setShowClientSuggestions(true);
                    } catch (err) { setClientSuggestions([]); }
                  } else {
                    setEditData({ ...editData, _clientSearch: value, clientId: null, clientName: '' });
                    setClientSuggestions([]);
                    setShowClientSuggestions(false);
                  }
                }}
                onFocus={async () => {
                  try {
                    const res = await searchClients('');
                    setClientSuggestions(res.data.data || []);
                    setShowClientSuggestions(true);
                  } catch (err) {}
                }}
                onBlur={() => setTimeout(() => setShowClientSuggestions(false), 200)}
                placeholder="Search or add client..."
                autoComplete="off"
              />
              {showClientSuggestions && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                  background: 'white', border: '1px solid #ddd', borderRadius: 4,
                  maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
                }}>
                  {clientSuggestions.map(client => (
                    <div key={client.id} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                      onMouseDown={() => {
                        setEditData({ ...editData, clientId: client.id, clientName: client.name, _clientSearch: undefined,
                          contactName: client.contactName || editData.contactName,
                          contactPhone: client.contactPhone || editData.contactPhone,
                          contactEmail: client.contactEmail || editData.contactEmail
                        });
                        setShowClientSuggestions(false);
                      }}>
                      <strong>{client.name}</strong>
                      {client.contactName && <span style={{ fontSize: '0.8rem', color: '#666', marginLeft: 8 }}>{client.contactName}</span>}
                    </div>
                  ))}
                  {editData._clientSearch && editData._clientSearch.length >= 2 && !clientSuggestions.some(c => c.name.toLowerCase() === (editData._clientSearch || '').toLowerCase()) && (
                    <div style={{ padding: '8px 12px', cursor: 'pointer', background: '#e8f5e9', color: '#2e7d32', fontWeight: 600, borderTop: '2px solid #c8e6c9' }}
                      onMouseDown={async () => {
                        try {
                          const res = await fetch(`${process.env.REACT_APP_API_URL || ''}/api/clients`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                            body: JSON.stringify({ name: editData._clientSearch })
                          });
                          const data = await res.json();
                          if (data.data) {
                            setEditData({ ...editData, clientId: data.data.id, clientName: data.data.name, _clientSearch: undefined });
                            showMessage(`Client "${data.data.name}" created`);
                          }
                        } catch (err) { setError('Failed to create client'); }
                        setShowClientSuggestions(false);
                      }}>
                      + Add "{editData._clientSearch}" as new client
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="form-group"><label className="form-label">Client PO#</label><input className="form-input" value={editData.clientPurchaseOrderNumber} onChange={(e) => setEditData({ ...editData, clientPurchaseOrderNumber: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Job Number</label><input className="form-input" value={editData.jobNumber} onChange={(e) => setEditData({ ...editData, jobNumber: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Storage Location</label><input className="form-input" value={editData.storageLocation} onChange={(e) => setEditData({ ...editData, storageLocation: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Contact Name</label><input className="form-input" value={editData.contactName} onChange={(e) => setEditData({ ...editData, contactName: e.target.value })} placeholder="John Smith" /></div>
            <div className="form-group"><label className="form-label">Contact Phone</label><input className="form-input" value={editData.contactPhone} onChange={(e) => setEditData({ ...editData, contactPhone: e.target.value })} placeholder="(555) 123-4567" /></div>
            <div className="form-group"><label className="form-label">Contact Email</label><input type="email" className="form-input" value={editData.contactEmail} onChange={(e) => setEditData({ ...editData, contactEmail: e.target.value })} placeholder="john@example.com" /></div>
            <div className="form-group"><label className="form-label">Requested Due Date</label><input type="date" className="form-input" value={editData.requestedDueDate} onChange={(e) => setEditData({ ...editData, requestedDueDate: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Promised Date</label><input type="date" className="form-input" value={editData.promisedDate} onChange={(e) => setEditData({ ...editData, promisedDate: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: 'span 2' }}><label className="form-label">Notes</label><textarea className="form-textarea" value={editData.notes} onChange={(e) => setEditData({ ...editData, notes: e.target.value })} /></div>
          </div>
        ) : (
          <>
            <div className="detail-grid">
              <div className="detail-item"><div className="detail-item-label"><User size={14} /> Client</div><div className="detail-item-value">{order.clientName}</div></div>
              {clientPO && <div className="detail-item"><div className="detail-item-label"><FileText size={14} /> Client PO#</div><div className="detail-item-value" style={{ color: '#1976d2', fontWeight: 600 }}>{clientPO}</div></div>}
              {order.jobNumber && <div className="detail-item"><div className="detail-item-label">Job#</div><div className="detail-item-value">{order.jobNumber}</div></div>}
              {order.storageLocation && <div className="detail-item"><div className="detail-item-label"><MapPin size={14} /> Location</div><div className="detail-item-value">{order.storageLocation}</div></div>}
              {order.contactName && <div className="detail-item"><div className="detail-item-label">Contact Name</div><div className="detail-item-value">{order.contactName}</div></div>}
              {order.contactPhone && <div className="detail-item"><div className="detail-item-label">Contact Phone</div><div className="detail-item-value">{order.contactPhone}</div></div>}
              {order.contactEmail && <div className="detail-item"><div className="detail-item-label">Contact Email</div><div className="detail-item-value">{order.contactEmail}</div></div>}
              {order.promisedDate && <div className="detail-item"><div className="detail-item-label"><Calendar size={14} /> Promised</div><div className="detail-item-value">{formatDate(order.promisedDate)}</div></div>}
              <div className="detail-item"><div className="detail-item-label"><Clock size={14} /> Created</div><div className="detail-item-value">{formatDate(order.createdAt)}</div></div>
            </div>
            {order.notes && <div style={{ marginTop: 16, padding: 12, background: '#f9f9f9', borderRadius: 8 }}><strong>Notes:</strong> {order.notes}</div>}
          </>
        )}

        {/* Purchase Orders Section */}
        {order.documents?.filter(d => d.documentType === 'purchase_order').length > 0 && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #eee' }}>
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: '#e65100' }}>
              <ShoppingCart size={18} /> Purchase Orders
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {order.documents.filter(d => d.documentType === 'purchase_order').map(doc => (
                <div key={doc.id} style={{ 
                  display: 'flex', alignItems: 'center', gap: 8, 
                  background: '#fff3e0', padding: '10px 14px', borderRadius: 8, 
                  fontSize: '0.9rem', border: '1px solid #ffcc80'
                }}>
                  <File size={18} color="#e65100" />
                  <span style={{ fontWeight: 500 }}>{doc.originalName}</span>
                  <button 
                    onClick={() => handleViewDocument(doc.id)} 
                    className="btn btn-sm"
                    style={{ background: '#1976d2', color: 'white', padding: '4px 10px', marginLeft: 8 }}
                    title="View"
                  >
                    <Eye size={14} />
                  </button>
                  <button 
                    onClick={async () => {
                      try {
                        const response = await getWorkOrderDocumentSignedUrl(id, doc.id);
                        const link = document.createElement('a');
                        link.href = response.data.data.url;
                        link.download = doc.originalName;
                        link.click();
                      } catch (err) {
                        setError('Failed to download');
                      }
                    }} 
                    className="btn btn-sm"
                    style={{ background: '#e65100', color: 'white', padding: '4px 10px' }}
                    title="Download"
                  >
                    <Download size={14} />
                  </button>
                  <button 
                    onClick={() => handleDeleteDocument(doc.id)} 
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#d32f2f' }}
                    title="Delete"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Order Documents Section */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #eee' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <File size={18} /> Documents ({order.documents?.filter(d => d.documentType !== 'purchase_order').length || 0})
            </div>
            <button className="btn btn-sm btn-outline" onClick={() => docInputRef.current?.click()} disabled={uploadingDocs}>
              <Upload size={14} />{uploadingDocs ? 'Uploading...' : 'Upload'}
            </button>
            <input type="file" multiple accept=".pdf,.doc,.docx,image/*" ref={docInputRef} style={{ display: 'none' }} 
              onChange={(e) => handleDocumentUpload(Array.from(e.target.files))} />
          </div>
          <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: 12 }}>Upload customer POs, supplier quotes, drawings, etc.</p>
          {order.documents?.filter(d => d.documentType !== 'purchase_order').length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {order.documents.filter(d => d.documentType !== 'purchase_order').map(doc => (
                <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f5f5f5', padding: '8px 12px', borderRadius: 6, fontSize: '0.85rem' }}>
                  <File size={16} color="#1976d2" />
                  <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.originalName}</span>
                  <button onClick={() => handleViewDocument(doc.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><Eye size={14} /></button>
                  <button onClick={() => handleDeleteDocument(doc.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#d32f2f' }}><X size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Parts Section */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <h3 className="card-title"><Package size={20} style={{ marginRight: 8 }} />Parts ({order.parts?.length || 0})</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {!order.estimateNumber && (
              <button className="btn btn-sm" onClick={() => setShowLinkEstimateModal(true)} style={{ background: '#7b1fa2', color: 'white' }}>
                <Link2 size={16} /> Link Estimate
              </button>
            )}
            {order.estimateNumber && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem', color: '#7b1fa2', fontWeight: 500 }}>
                <Link2 size={14} /> {order.estimateNumber}
                <button onClick={handleUnlinkEstimate} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#d32f2f' }} title="Unlink estimate">
                  <Unlink size={14} />
                </button>
              </span>
            )}
            {getOrderableParts().length > 0 && (
              <button className="btn btn-sm" onClick={openOrderModal} style={{ background: '#ff9800', color: 'white' }}>
                <ShoppingCart size={16} /> Order Material
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={openAddPartModal}><Plus size={16} />Add Part</button>
          </div>
        </div>
        {hasNoParts ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <Package size={48} color="#9c27b0" />
            <p style={{ marginTop: 12, color: '#9c27b0', fontWeight: 500 }}>Awaiting Instructions</p>
            <p style={{ color: '#666', fontSize: '0.9rem' }}>Add parts when the client calls with rolling/bending instructions, or link an existing estimate</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" onClick={openAddPartModal}><Plus size={16} />Add First Part</button>
              {!order.estimateNumber && (
                <button className="btn" onClick={() => setShowLinkEstimateModal(true)} style={{ background: '#7b1fa2', color: 'white' }}>
                  <Link2 size={16} /> Link Estimate
                </button>
              )}
            </div>
          </div>
        ) : (
          <div>
            {order.parts.sort((a, b) => a.partNumber - b.partNumber).map(part => (
              <div key={part.id} style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 16, marginBottom: 12, background: part.status === 'completed' ? '#f9fff9' : 'white' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: '1.1rem' }}>#{part.partNumber}</span>
                      <span style={{ color: '#1976d2' }}>{PART_TYPES[part.partType]?.label || part.partType}</span>
                      <StatusBadge status={part.status} />
                      {part.materialOrdered && (
                        <span style={{ background: '#e8f5e9', color: '#2e7d32', padding: '2px 8px', borderRadius: 4, fontSize: '0.7rem' }}>
                          ✓ {part.materialPurchaseOrderNumber}
                        </span>
                      )}
                    </div>
                    {part.clientPartNumber && <div style={{ color: '#666', fontSize: '0.875rem' }}>Client Part#: {part.clientPartNumber}</div>}
                    {part.heatNumber && <div style={{ color: '#666', fontSize: '0.875rem' }}>Heat#: {part.heatNumber}</div>}
                  </div>
                  <div className="actions-row">
                    <select className="form-select" value={part.status} onChange={(e) => handlePartStatusChange(part.id, e.target.value)} style={{ width: 'auto', padding: '4px 8px', fontSize: '0.8rem' }}>
                      <option value="pending">Pending</option><option value="in_progress">In Progress</option><option value="completed">Completed</option>
                    </select>
                    <button className="btn btn-sm btn-outline" onClick={() => printPartLabel(part)} title="Print Label"><Tag size={14} /></button>
                    <button className="btn btn-sm btn-outline" onClick={() => openEditPartModal(part)}><Edit size={14} /></button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDeletePart(part.id)}><Trash2 size={14} /></button>
                  </div>
                </div>

                {/* Material Source Info */}
                {(part.materialSource === 'we_order' || part.materialDescription) && (
                  <div style={{ 
                    background: part.materialOrdered ? '#e8f5e9' : part.materialSource === 'we_order' ? '#fff3e0' : '#e3f2fd', 
                    padding: 10, borderRadius: 6, marginBottom: 12 
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <span style={{ 
                          background: part.materialSource === 'we_order' ? '#ff9800' : part.materialSource === 'in_stock' ? '#4caf50' : '#2196f3',
                          color: 'white', padding: '2px 6px', borderRadius: 4, fontSize: '0.7rem', marginRight: 8
                        }}>
                          {part.materialSource === 'we_order' ? 'We Order' : part.materialSource === 'in_stock' ? 'In Stock' : 'Customer'}
                        </span>
                        {part.materialDescription && (
                          <strong style={{ color: part.materialOrdered ? '#2e7d32' : '#333' }}>📦 {part.materialDescription}</strong>
                        )}
                        {(part.vendor?.name || part.supplierName) && <span style={{ marginLeft: 8, fontSize: '0.8rem', color: '#666' }}>from {part.vendor?.name || part.supplierName}</span>}
                      </div>
                      {part.materialSource === 'we_order' && (
                        part.materialOrdered ? (
                          <span style={{ fontSize: '0.8rem', color: '#2e7d32', fontWeight: 600 }}>✓ {part.materialPurchaseOrderNumber}</span>
                        ) : (
                          <span style={{ fontSize: '0.8rem', color: '#e65100' }}>Needs ordering</span>
                        )
                      )}
                    </div>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, fontSize: '0.875rem' }}>
                  <div><strong>Qty:</strong> {part.quantity}</div>
                  {part.material && <div><strong>Material:</strong> {part.material}</div>}
                  {part.thickness && <div><strong>Thickness:</strong> {part.thickness}</div>}
                  {part.width && <div><strong>Width:</strong> {part.width}</div>}
                  {part.length && <div><strong>Length:</strong> {part.length}</div>}
                  {part.sectionSize && <div><strong>Section:</strong> {part.sectionSize}</div>}
                  {part.outerDiameter && <div><strong>OD:</strong> {part.outerDiameter}</div>}
                  {part.wallThickness && <div><strong>Wall:</strong> {part.wallThickness}</div>}
                  {part.rollType && <div><strong>Roll:</strong> {part.rollType === 'easy_way' ? 'Easy Way' : 'Hard Way'}</div>}
                  {part.radius && <div><strong>Radius:</strong> {part.radius}</div>}
                  {part.diameter && <div><strong>Diameter:</strong> {part.diameter}</div>}
                  {part.arcDegrees && <div><strong>Arc:</strong> {part.arcDegrees}°</div>}
                </div>
                {part.specialInstructions && <div style={{ marginTop: 8, padding: 8, background: '#f5f5f5', borderRadius: 4, fontSize: '0.875rem' }}><strong>Instructions:</strong> {part.specialInstructions}</div>}
                
                {/* Pricing Summary */}
                {(part.partTotal || part.laborTotal || part.materialTotal) && (
                  <div style={{ marginTop: 8, padding: 8, background: '#e3f2fd', borderRadius: 4, fontSize: '0.85rem', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {part.laborTotal && <span><strong>Labor:</strong> ${parseFloat(part.laborTotal).toFixed(2)}</span>}
                    {part.materialTotal && <span><strong>Material:</strong> ${parseFloat(part.materialTotal).toFixed(2)}</span>}
                    {part.setupCharge && <span><strong>Setup:</strong> ${parseFloat(part.setupCharge).toFixed(2)}</span>}
                    {part.partTotal && <span style={{ fontWeight: 600, color: '#1565c0' }}><strong>Total:</strong> ${parseFloat(part.partTotal).toFixed(2)}</span>}
                  </div>
                )}
                
                {/* Part Files */}
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #eee' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: '0.8rem', color: '#666' }}>Files ({part.files?.length || 0})</span>
                    <button className="btn btn-sm btn-outline" onClick={() => fileInputRefs.current[part.id]?.click()} disabled={uploadingFiles === part.id}>
                      <Upload size={12} />{uploadingFiles === part.id ? 'Uploading...' : 'Upload'}
                    </button>
                    <input type="file" multiple ref={el => fileInputRefs.current[part.id] = el} style={{ display: 'none' }} onChange={(e) => handleFileUpload(part.id, Array.from(e.target.files))} />
                  </div>
                  {part.files?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {part.files.map(file => (
                        <div key={file.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#f5f5f5', padding: '4px 8px', borderRadius: 4, fontSize: '0.75rem' }}>
                          <span style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.originalName}</span>
                          <button onClick={() => handleViewFile(part.id, file.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}><Eye size={12} /></button>
                          <button onClick={() => handleDeleteFile(part.id, file.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#d32f2f' }}><X size={12} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pricing Section */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <h3 className="card-title"><FileText size={20} style={{ marginRight: 8 }} />Pricing</h3>
        </div>
        <div style={{ padding: 16 }}>
          {/* Parts Pricing Table */}
          {order.parts?.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20, fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid #ddd' }}>#</th>
                  <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Description</th>
                  <th style={{ padding: 8, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Qty</th>
                  <th style={{ padding: 8, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Labor</th>
                  <th style={{ padding: 8, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Material</th>
                  <th style={{ padding: 8, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Setup</th>
                  <th style={{ padding: 8, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Other</th>
                  <th style={{ padding: 8, textAlign: 'right', borderBottom: '2px solid #ddd' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {order.parts.sort((a, b) => a.partNumber - b.partNumber).map(part => (
                  <tr key={part.id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: 8 }}>{part.partNumber}</td>
                    <td style={{ padding: 8 }}>
                      {PART_TYPES[part.partType]?.label || part.partType}
                      {part.materialDescription && <div style={{ fontSize: '0.8rem', color: '#666' }}>{part.materialDescription}</div>}
                    </td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{part.quantity}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{formatCurrency(part.laborTotal)}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{formatCurrency(part.materialTotal)}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{formatCurrency(part.setupCharge)}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{formatCurrency(part.otherCharges)}</td>
                    <td style={{ padding: 8, textAlign: 'right', fontWeight: 600 }}>{formatCurrency(part.partTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Totals */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ width: 300 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
                <span>Parts Subtotal:</span>
                <span>{formatCurrency(calculateTotals().partsSubtotal)}</span>
              </div>
              
              {isEditing ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #eee' }}>
                  <div style={{ flex: 1 }}>
                    <input 
                      className="form-input" 
                      placeholder="Trucking description"
                      value={editData.truckingDescription}
                      onChange={(e) => setEditData({ ...editData, truckingDescription: e.target.value })}
                      style={{ marginBottom: 4, fontSize: '0.85rem' }}
                    />
                  </div>
                  <input 
                    type="number" 
                    step="0.01"
                    className="form-input" 
                    value={editData.truckingCost}
                    onChange={(e) => setEditData({ ...editData, truckingCost: e.target.value })}
                    style={{ width: 100, textAlign: 'right', marginLeft: 8 }}
                  />
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
                  <span>{order.truckingDescription || 'Trucking'}:</span>
                  <span>{formatCurrency(order.truckingCost)}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
                <span>Subtotal:</span>
                <span>{formatCurrency(calculateTotals().subtotal)}</span>
              </div>

              {isEditing ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #eee' }}>
                  <span>Tax Rate:</span>
                  <input 
                    type="number" 
                    step="0.0001"
                    className="form-input" 
                    value={editData.taxRate}
                    onChange={(e) => setEditData({ ...editData, taxRate: e.target.value })}
                    style={{ width: 80, textAlign: 'right' }}
                  />
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
                  <span>Tax ({((parseFloat(order.taxRate) || 0.0975) * 100).toFixed(2)}%):</span>
                  <span>{formatCurrency(calculateTotals().taxAmount)}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', fontWeight: 700, fontSize: '1.1rem', background: '#e3f2fd', margin: '8px -8px -8px', padding: '12px 8px', borderRadius: '0 0 8px 8px' }}>
                <span>Grand Total:</span>
                <span>{formatCurrency(calculateTotals().grandTotal)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Part Modal */}
      {showPartModal && (
        <div className="modal-overlay" onClick={() => setShowPartModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3>{editingPart ? 'Edit Part' : 'Add Part'}</h3>
              <button className="btn btn-icon" onClick={() => setShowPartModal(false)}><X size={20} /></button>
            </div>
            <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              <div className="form-group">
                <label className="form-label">Part Type *</label>
                <select className="form-select" value={selectedPartType} onChange={(e) => setSelectedPartType(e.target.value)}>
                  <option value="">Select type...</option>
                  {Object.entries(PART_TYPES).map(([key, val]) => <option key={key} value={key}>{val.label}</option>)}
                </select>
              </div>
              {selectedPartType && (
                <div className="grid grid-2">
                  <div className="form-group"><label className="form-label">Client Part#</label><input className="form-input" value={partData.clientPartNumber} onChange={(e) => setPartData({ ...partData, clientPartNumber: e.target.value })} /></div>
                  <div className="form-group"><label className="form-label">Heat#</label><input className="form-input" value={partData.heatNumber} onChange={(e) => setPartData({ ...partData, heatNumber: e.target.value })} /></div>
                  
                  {/* Plate Roll gets custom form */}
                  {selectedPartType === 'plate_roll' ? (
                    <PlateRollForm 
                      partData={partData} 
                      setPartData={setPartData}
                      vendorSuggestions={vendorSuggestions}
                      setVendorSuggestions={setVendorSuggestions}
                      showVendorSuggestions={showVendorSuggestions}
                      setShowVendorSuggestions={setShowVendorSuggestions}
                      showMessage={showMessage}
                      setError={setError}
                    />
                  ) : (
                    <>
                      {/* Generic form for other part types */}
                      <div className="form-group"><label className="form-label">Quantity *</label><input type="number" className="form-input" value={partData.quantity} onChange={(e) => setPartData({ ...partData, quantity: e.target.value })} min="1" /></div>
                      {PART_TYPES[selectedPartType]?.fields.includes('material') && <div className="form-group"><label className="form-label">Material</label><input className="form-input" value={partData.material} onChange={(e) => setPartData({ ...partData, material: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('thickness') && <div className="form-group"><label className="form-label">Thickness</label><input className="form-input" value={partData.thickness} onChange={(e) => setPartData({ ...partData, thickness: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('width') && <div className="form-group"><label className="form-label">Width</label><input className="form-input" value={partData.width} onChange={(e) => setPartData({ ...partData, width: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('length') && <div className="form-group"><label className="form-label">Length</label><input className="form-input" value={partData.length} onChange={(e) => setPartData({ ...partData, length: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('sectionSize') && <div className="form-group"><label className="form-label">Section Size</label><input className="form-input" value={partData.sectionSize} onChange={(e) => setPartData({ ...partData, sectionSize: e.target.value })} placeholder="e.g. W8x31" /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('outerDiameter') && <div className="form-group"><label className="form-label">Outer Diameter</label><input className="form-input" value={partData.outerDiameter} onChange={(e) => setPartData({ ...partData, outerDiameter: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('wallThickness') && <div className="form-group"><label className="form-label">Wall Thickness</label><input className="form-input" value={partData.wallThickness} onChange={(e) => setPartData({ ...partData, wallThickness: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('rollType') && (
                        <div className="form-group"><label className="form-label">Roll Type</label>
                          <select className="form-select" value={partData.rollType} onChange={(e) => setPartData({ ...partData, rollType: e.target.value })}>
                            <option value="">Select...</option><option value="easy_way">Easy Way</option><option value="hard_way">Hard Way</option>
                          </select>
                        </div>
                      )}
                      {PART_TYPES[selectedPartType]?.fields.includes('radius') && <div className="form-group"><label className="form-label">Radius</label><input className="form-input" value={partData.radius} onChange={(e) => setPartData({ ...partData, radius: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('diameter') && <div className="form-group"><label className="form-label">Diameter</label><input className="form-input" value={partData.diameter} onChange={(e) => setPartData({ ...partData, diameter: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('arcDegrees') && <div className="form-group"><label className="form-label">Arc (degrees)</label><input className="form-input" value={partData.arcDegrees} onChange={(e) => setPartData({ ...partData, arcDegrees: e.target.value })} /></div>}
                      {PART_TYPES[selectedPartType]?.fields.includes('flangeOut') && (
                        <div className="form-group"><label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input type="checkbox" checked={partData.flangeOut} onChange={(e) => setPartData({ ...partData, flangeOut: e.target.checked })} /> Flange Out
                        </label></div>
                      )}
                      <div className="form-group" style={{ gridColumn: 'span 2' }}><label className="form-label">Special Instructions</label><textarea className="form-textarea" value={partData.specialInstructions} onChange={(e) => setPartData({ ...partData, specialInstructions: e.target.value })} /></div>
                      
                      {/* Material Source Section - for non-plate types */}
                      <div style={{ gridColumn: 'span 2', borderTop: '1px solid #e0e0e0', marginTop: 12, paddingTop: 12 }}>
                        <h4 style={{ marginBottom: 12, color: '#e65100' }}>📦 Material Source</h4>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          <div className="form-group">
                            <label className="form-label">Material Source</label>
                            <select className="form-select" value={partData.materialSource || 'customer'} onChange={(e) => setPartData({ ...partData, materialSource: e.target.value })}>
                              <option value="customer">Customer Supplies</option>
                              <option value="we_order">We Order</option>
                              <option value="in_stock">In Stock</option>
                            </select>
                          </div>
                          <div className="form-group" style={{ position: 'relative' }}>
                            <label className="form-label">Vendor</label>
                            <input className="form-input"
                              value={partData._vendorSearch !== undefined ? partData._vendorSearch : (partData.vendor?.name || partData.supplierName || '')}
                              onChange={async (e) => {
                                const value = e.target.value;
                                setPartData({ ...partData, _vendorSearch: value });
                                if (value.length >= 1) {
                                  try { const res = await searchVendors(value); setVendorSuggestions(res.data.data || []); setShowVendorSuggestions(true); } catch { setVendorSuggestions([]); }
                                } else {
                                  setPartData({ ...partData, _vendorSearch: value, vendorId: null, supplierName: '' }); setVendorSuggestions([]); setShowVendorSuggestions(false);
                                }
                              }}
                              onFocus={async () => { try { const res = await searchVendors(''); setVendorSuggestions(res.data.data || []); setShowVendorSuggestions(true); } catch {} }}
                              onBlur={() => setTimeout(() => setShowVendorSuggestions(false), 200)}
                              placeholder="Search or add vendor..." autoComplete="off"
                            />
                            {showVendorSuggestions && (
                              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: 'white', border: '1px solid #ddd', borderRadius: 4, maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                                {vendorSuggestions.map(v => (
                                  <div key={v.id} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                                    onMouseDown={() => { setPartData({ ...partData, vendorId: v.id, supplierName: v.name, _vendorSearch: undefined }); setShowVendorSuggestions(false); setVendorSuggestions([]); }}>
                                    <strong>{v.name}</strong>
                                    {v.contactPhone && <span style={{ fontSize: '0.8rem', color: '#666', marginLeft: 8 }}>{v.contactPhone}</span>}
                                  </div>
                                ))}
                                {partData._vendorSearch && partData._vendorSearch.length >= 2 && !vendorSuggestions.some(v => v.name.toLowerCase() === (partData._vendorSearch || '').toLowerCase()) && (
                                  <div style={{ padding: '8px 12px', cursor: 'pointer', background: '#e8f5e9', color: '#2e7d32', fontWeight: 600 }}
                                    onMouseDown={async () => {
                                      try {
                                        const res = await fetch(`${process.env.REACT_APP_API_URL || ''}/api/vendors`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ name: partData._vendorSearch }) });
                                        const data = await res.json();
                                        if (data.data) { setPartData({ ...partData, vendorId: data.data.id, supplierName: data.data.name, _vendorSearch: undefined }); showMessage(`Vendor "${data.data.name}" created`); }
                                      } catch { setError('Failed to create vendor'); }
                                      setShowVendorSuggestions(false);
                                    }}>+ Add "{partData._vendorSearch}" as new vendor</div>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="form-group" style={{ gridColumn: 'span 2' }}>
                            <label className="form-label">Material Description (for ordering)</label>
                            <input className="form-input" value={partData.materialDescription || ''} onChange={(e) => setPartData({ ...partData, materialDescription: e.target.value })} placeholder="e.g. 1/4 x 4 x 120 A36 Plate" />
                          </div>
                        </div>
                      </div>

                      {/* Pricing Section - for non-plate types */}
                      <div style={{ gridColumn: 'span 2', borderTop: '1px solid #e0e0e0', marginTop: 12, paddingTop: 12 }}>
                        <h4 style={{ marginBottom: 12, color: '#1976d2' }}>💰 Pricing</h4>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                          <div className="form-group"><label className="form-label">Labor Rate ($/hr)</label><input type="number" step="0.01" className="form-input" value={partData.laborRate || ''} onChange={(e) => setPartData({ ...partData, laborRate: e.target.value })} /></div>
                          <div className="form-group"><label className="form-label">Labor Hours</label><input type="number" step="0.25" className="form-input" value={partData.laborHours || ''} onChange={(e) => setPartData({ ...partData, laborHours: e.target.value })} /></div>
                          <div className="form-group"><label className="form-label">Labor Total</label><input type="number" step="0.01" className="form-input" value={partData.laborTotal || ''} onChange={(e) => setPartData({ ...partData, laborTotal: e.target.value })} /></div>
                          <div className="form-group"><label className="form-label">Material Unit Cost</label><input type="number" step="0.01" className="form-input" value={partData.materialUnitCost || ''} onChange={(e) => setPartData({ ...partData, materialUnitCost: e.target.value })} /></div>
                          <div className="form-group"><label className="form-label">Material Total</label><input type="number" step="0.01" className="form-input" value={partData.materialTotal || ''} onChange={(e) => setPartData({ ...partData, materialTotal: e.target.value })} /></div>
                          <div className="form-group"><label className="form-label">Setup Charge</label><input type="number" step="0.01" className="form-input" value={partData.setupCharge || ''} onChange={(e) => setPartData({ ...partData, setupCharge: e.target.value })} /></div>
                          <div className="form-group"><label className="form-label">Other Charges</label><input type="number" step="0.01" className="form-input" value={partData.otherCharges || ''} onChange={(e) => setPartData({ ...partData, otherCharges: e.target.value })} /></div>
                          <div className="form-group"><label className="form-label">Part Total</label><input type="number" step="0.01" className="form-input" value={partData.partTotal || ''} onChange={(e) => setPartData({ ...partData, partTotal: e.target.value })} style={{ fontWeight: 600 }} /></div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowPartModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSavePart} disabled={saving || !selectedPartType}>{saving ? 'Saving...' : editingPart ? 'Update Part' : 'Add Part'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Pickup Modal */}
      {showPickupModal && (
        <div className="modal-overlay" onClick={() => setShowPickupModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header"><h3>Confirm Pickup</h3><button className="btn btn-icon" onClick={() => setShowPickupModal(false)}><X size={20} /></button></div>
            <div className="modal-body">
              <div className="form-group"><label className="form-label">Picked Up By</label><input className="form-input" value={pickupData.pickedUpBy} onChange={(e) => setPickupData({ pickedUpBy: e.target.value })} placeholder="Name of person picking up" /></div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowPickupModal(false)}>Cancel</button>
              <button className="btn btn-success" onClick={handlePickup}><Check size={18} />Confirm Pickup</button>
            </div>
          </div>
        </div>
      )}

      {/* Order Material Modal */}
      {showOrderModal && (
        <div className="modal-overlay" onClick={() => setShowOrderModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ShoppingCart size={24} />
                Order Material
              </h3>
              <button className="btn btn-icon" onClick={() => setShowOrderModal(false)}><X size={20} /></button>
            </div>
            
            <div style={{ padding: 20 }}>
              <div style={{ background: '#e3f2fd', padding: 12, borderRadius: 8, marginBottom: 16 }}>
                <strong>DR-{order.drNumber}</strong> • {order.clientName}
              </div>

              <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label">Starting PO Number *</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, color: '#1976d2' }}>PO</span>
                  <input 
                    type="number" 
                    className="form-input" 
                    value={orderPONumber}
                    onChange={(e) => setOrderPONumber(e.target.value)}
                    placeholder="7765" 
                    style={{ maxWidth: 150 }} 
                  />
                </div>
                {Object.keys(getSupplierGroups()).length > 1 && (
                  <p style={{ fontSize: '0.8rem', color: '#666', marginTop: 4 }}>
                    Will create: {Object.keys(getSupplierGroups()).map((s, i) => `PO${parseInt(orderPONumber) + i}`).join(', ')}
                  </p>
                )}
              </div>

              <h4 style={{ marginBottom: 12 }}>Select Materials to Order:</h4>
              {Object.entries(getSupplierGroups()).map(([supplier, supplierParts], idx) => (
                <div key={supplier} style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 12, marginBottom: 12, background: '#f9f9f9' }}>
                  <div style={{ fontWeight: 600, marginBottom: 8, color: '#e65100' }}>🏭 {supplier}</div>
                  {supplierParts.map(part => (
                    <label key={part.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 8, cursor: 'pointer', background: 'white', borderRadius: 4, marginBottom: 4 }}>
                      <input 
                        type="checkbox" 
                        checked={selectedPartIds.includes(part.id)}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedPartIds([...selectedPartIds, part.id]);
                          else setSelectedPartIds(selectedPartIds.filter(pid => pid !== part.id));
                        }}
                        style={{ marginTop: 4 }} 
                      />
                      <div style={{ flex: 1 }}>
                        <div><strong>Part #{part.partNumber}:</strong> {part.materialDescription || part.partType}</div>
                        <div style={{ fontSize: '0.8rem', color: '#666' }}>Qty: {part.quantity}</div>
                      </div>
                    </label>
                  ))}
                  <div style={{ background: '#e3f2fd', borderRadius: 4, padding: 8, marginTop: 8 }}>
                    <strong style={{ color: '#1976d2' }}>PO{parseInt(orderPONumber) + idx}</strong>
                    <span style={{ marginLeft: 12, fontSize: '0.8rem', color: '#388e3c' }}>→ Creates Inbound + Purchase Order</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowOrderModal(false)}>Cancel</button>
              <button 
                className="btn" 
                style={{ background: '#ff9800', color: 'white' }}
                onClick={handleOrderMaterial}
                disabled={ordering || !orderPONumber || selectedPartIds.length === 0}
              >
                <ShoppingCart size={16} />
                {ordering ? 'Creating...' : `Create ${Object.keys(getSupplierGroups()).length} PO(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Link Estimate Modal */}
      {showLinkEstimateModal && (
        <div className="modal-overlay" onClick={() => setShowLinkEstimateModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Link2 size={24} />
                Link Estimate to Work Order
              </h3>
              <button className="btn-close" onClick={() => setShowLinkEstimateModal(false)}><X size={20} /></button>
            </div>
            
            <div style={{ padding: 20 }}>
              <p style={{ color: '#666', marginBottom: 16, fontSize: '0.9rem' }}>
                Search for an estimate to link. All parts, pricing, and client info will be copied to this work order.
              </p>
              
              <input
                className="form-input"
                placeholder="Search by client name, estimate number, or description..."
                value={estimateSearchQuery}
                onChange={(e) => handleSearchEstimates(e.target.value)}
                autoFocus
                style={{ marginBottom: 16 }}
              />

              {searchingEstimates && (
                <p style={{ color: '#666', textAlign: 'center', padding: 20 }}>Searching...</p>
              )}

              {!searchingEstimates && estimateSearchQuery.length >= 2 && estimateSearchResults.length === 0 && (
                <p style={{ color: '#999', textAlign: 'center', padding: 20 }}>No matching estimates found</p>
              )}

              <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                {estimateSearchResults.map(est => (
                  <div key={est.id} style={{ 
                    border: '1px solid #e0e0e0', borderRadius: 8, padding: 14, marginBottom: 8,
                    cursor: 'pointer', transition: 'background 0.2s',
                    ':hover': { background: '#f5f5f5' }
                  }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f3e5f5'}
                    onMouseLeave={e => e.currentTarget.style.background = 'white'}
                    onClick={() => handleLinkEstimate(est.id)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 600, color: '#7b1fa2' }}>{est.estimateNumber}</div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 500, marginTop: 2 }}>{est.clientName}</div>
                        {est.contactName && (
                          <div style={{ fontSize: '0.85rem', color: '#666' }}>Contact: {est.contactName}</div>
                        )}
                        {est.projectDescription && (
                          <div style={{ fontSize: '0.85rem', color: '#666', marginTop: 2 }}>{est.projectDescription}</div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 600, color: '#2e7d32' }}>
                          {est.grandTotal ? `$${parseFloat(est.grandTotal).toFixed(2)}` : '-'}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#666' }}>{est.partCount} part(s)</div>
                        <div style={{ fontSize: '0.8rem', color: '#999' }}>{new Date(est.createdAt).toLocaleDateString()}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {linkingEstimate && (
                <div style={{ textAlign: 'center', padding: 20, color: '#7b1fa2' }}>
                  Linking estimate and copying parts...
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkOrderDetailsPage;
