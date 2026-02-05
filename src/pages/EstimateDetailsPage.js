import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, Send, Upload, Eye, X, Printer, Check, FileDown, Package, FileText } from 'lucide-react';
import {
  getEstimateById, createEstimate, updateEstimate,
  addEstimatePart, updateEstimatePart, deleteEstimatePart,
  uploadEstimateFiles, getEstimateFileSignedUrl, deleteEstimateFile,
  downloadEstimatePDF, convertEstimateToWorkOrder,
  uploadEstimatePartFile, deleteEstimatePartFile,
  searchClients, searchVendors, getSettings, resetEstimateConversion
} from '../services/api';

const PART_TYPES = {
  plate_roll: { label: 'Plate Roll' },
  pipe_roll: { label: 'Pipe/Tube Roll' },
  angle_roll: { label: 'Angle Roll' },
  beam_roll: { label: 'Beam Roll' },
  section_roll: { label: 'Section Roll' },
  channel_roll: { label: 'Channel Roll' },
  flat_bar: { label: 'Flat Bar' },
  other: { label: 'Other' }
};

function EstimateDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const isNew = id === 'new';

  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [downloadingPDF, setDownloadingPDF] = useState(false);

  const [formData, setFormData] = useState({
    clientName: '', contactName: '', contactEmail: '', contactPhone: '',
    projectDescription: '', notes: '', internalNotes: '', validUntil: '',
    taxRate: 7.0, useCustomTax: false, customTaxReason: '',
    taxExempt: false, taxExemptReason: '', taxExemptCertNumber: '',
    truckingDescription: '', truckingCost: 0
  });

  const [parts, setParts] = useState([]);
  const [files, setFiles] = useState([]);
  const [showPartModal, setShowPartModal] = useState(false);
  const [editingPart, setEditingPart] = useState(null);
  const [partData, setPartData] = useState({});
  
  // Convert to Work Order state
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertData, setConvertData] = useState({
    clientPurchaseOrderNumber: '',
    requestedDueDate: '',
    promisedDate: '',
    notes: ''
  });
  
  // Part file upload state
  const [uploadingPartFile, setUploadingPartFile] = useState(null);
  const partFileInputRef = useRef(null);
  
  // Client autofill state
  const [clientSuggestions, setClientSuggestions] = useState([]);
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const clientInputRef = useRef(null);
  
  // Vendor autofill state (for parts)
  const [vendorSuggestions, setVendorSuggestions] = useState([]);
  const [showVendorSuggestions, setShowVendorSuggestions] = useState(false);
  
  // Default settings
  const [defaultSettings, setDefaultSettings] = useState({
    defaultTaxRate: 9.75,
    defaultLaborRate: 125,
    defaultMaterialMarkup: 20
  });

  useEffect(() => { 
    loadDefaultSettings();
    if (!isNew) loadEstimate(); 
  }, [id]);

  const loadDefaultSettings = async () => {
    try {
      const response = await getSettings('tax_settings');
      if (response.data.data?.value) {
        const settings = response.data.data.value;
        setDefaultSettings(settings);
        // Apply defaults to new estimate
        if (isNew) {
          setFormData(prev => ({
            ...prev,
            taxRate: settings.defaultTaxRate || 9.75
          }));
        }
      }
    } catch (err) {
      // Use built-in defaults
    }
  };

  const loadEstimate = async () => {
    try {
      setLoading(true);
      const response = await getEstimateById(id);
      const data = response.data.data;
      setEstimate(data);
      setFormData({
        clientName: data.clientName || '', contactName: data.contactName || '',
        contactEmail: data.contactEmail || '', contactPhone: data.contactPhone || '',
        projectDescription: data.projectDescription || '', notes: data.notes || '',
        internalNotes: data.internalNotes || '', validUntil: data.validUntil || '',
        taxRate: parseFloat(data.taxRate) || 7.0, useCustomTax: data.useCustomTax || false,
        customTaxReason: data.customTaxReason || '',
        taxExempt: data.taxExempt || false, 
        taxExemptReason: data.taxExemptReason || '',
        taxExemptCertNumber: data.taxExemptCertNumber || '',
        truckingDescription: data.truckingDescription || '',
        truckingCost: parseFloat(data.truckingCost) || 0
      });
      setParts((data.parts || []).sort((a, b) => a.partNumber - b.partNumber));
      setFiles(data.files || []);
    } catch (err) {
      setError('Failed to load estimate');
    } finally {
      setLoading(false);
    }
  };

  const calculatePartTotal = (part) => {
    const qty = parseInt(part.quantity) || 1;
    
    // Material - only if we supply it
    const weSupply = part.weSupplyMaterial;
    const materialCost = weSupply ? (parseFloat(part.materialUnitCost) || 0) * qty : 0;
    const materialMarkup = weSupply ? (parseFloat(part.materialMarkupPercent) || 0) : 0;
    const materialTotal = materialCost * (1 + materialMarkup / 100);
    
    // Rolling
    const rolling = parseFloat(part.rollingCost) || 0;
    
    // Additional Services
    const drillingCost = part.serviceDrilling ? (parseFloat(part.serviceDrillingCost) || 0) : 0;
    const cuttingCost = part.serviceCutting ? (parseFloat(part.serviceCuttingCost) || 0) : 0;
    const fittingCost = part.serviceFitting ? (parseFloat(part.serviceFittingCost) || 0) : 0;
    const weldingCost = part.serviceWelding ? (parseFloat(part.serviceWeldingCost) || 0) : 0;
    const additionalServices = drillingCost + cuttingCost + fittingCost + weldingCost;
    
    // Legacy other services
    const otherCost = parseFloat(part.otherServicesCost) || 0;
    const otherMarkup = parseFloat(part.otherServicesMarkupPercent) || 15;
    const otherTotal = otherCost * (1 + otherMarkup / 100);
    
    return { 
      materialCost, 
      materialTotal, 
      otherTotal, 
      additionalServices,
      partTotal: materialTotal + rolling + otherTotal + additionalServices 
    };
  };

  const calculateTotals = () => {
    let partsSubtotal = 0;
    parts.forEach(part => {
      const { partTotal } = calculatePartTotal(part);
      partsSubtotal += partTotal;
    });
    const trucking = parseFloat(formData.truckingCost) || 0;
    const taxAmount = formData.taxExempt ? 0 : partsSubtotal * (parseFloat(formData.taxRate) / 100);
    const grandTotal = partsSubtotal + taxAmount + trucking;
    
    // Calculate credit card total (Square: 2.9% + $0.30)
    const ccFeeRate = 2.9;
    const ccFeeFixed = 0.30;
    const ccFee = (grandTotal * ccFeeRate / 100) + ccFeeFixed;
    const ccTotal = grandTotal + ccFee;
    
    return { partsSubtotal, trucking, taxAmount, grandTotal, ccFee, ccTotal };
  };

  const handleDownloadPDF = async () => {
    try {
      setDownloadingPDF(true);
      const response = await downloadEstimatePDF(id);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Estimate-${estimate?.estimateNumber || id}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      showMessage('PDF downloaded');
    } catch (err) {
      setError('Failed to download PDF');
      console.error(err);
    } finally {
      setDownloadingPDF(false);
    }
  };

  const handleSave = async (sendToClient = false) => {
    if (!formData.clientName.trim()) { setError('Client name is required'); return; }
    try {
      setSaving(true); setError(null);
      const payload = { ...formData, status: sendToClient ? 'sent' : (estimate?.status || 'draft') };
      if (isNew) {
        const response = await createEstimate(payload);
        navigate(`/estimates/${response.data.data.id}`, { replace: true });
      } else {
        await updateEstimate(id, payload);
        await loadEstimate();
      }
      showMessage(sendToClient ? 'Estimate sent' : 'Estimate saved');
    } catch (err) { setError('Failed to save'); }
    finally { setSaving(false); }
  };

  const showMessage = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000); };

  const openAddPartModal = () => {
    setEditingPart(null);
    setPartData({
      partType: '', clientPartNumber: '', heatNumber: '', quantity: 1,
      // Material - controlled by weSupplyMaterial checkbox
      weSupplyMaterial: false,
      materialDescription: '', supplierName: '', materialUnitCost: '', 
      materialMarkupPercent: defaultSettings.defaultMaterialMarkup || 20,
      // Rolling cost
      rollingCost: '',
      // Additional Services
      serviceDrilling: false, serviceDrillingCost: '', serviceDrillingVendor: '',
      serviceCutting: false, serviceCuttingCost: '', serviceCuttingVendor: '',
      serviceFitting: false, serviceFittingCost: '', serviceFittingVendor: '',
      serviceWelding: false, serviceWeldingCost: '', serviceWeldingVendor: '', serviceWeldingPercent: 100,
      // Legacy other services
      otherServicesCost: '', otherServicesMarkupPercent: 15,
      // Specs
      material: '', thickness: '', width: '', length: '', sectionSize: '',
      outerDiameter: '', wallThickness: '', rollType: '', radius: '', diameter: '',
      arcDegrees: '', flangeOut: false, specialInstructions: ''
    });
    setShowPartModal(true);
  };

  const openEditPartModal = (part) => {
    setEditingPart(part);
    setPartData({
      ...part,
      weSupplyMaterial: part.weSupplyMaterial || false,
      materialUnitCost: part.materialUnitCost || '',
      materialMarkupPercent: part.materialMarkupPercent ?? defaultSettings.defaultMaterialMarkup ?? 20,
      rollingCost: part.rollingCost || '',
      serviceDrilling: part.serviceDrilling || false,
      serviceDrillingCost: part.serviceDrillingCost || '',
      serviceDrillingVendor: part.serviceDrillingVendor || '',
      serviceCutting: part.serviceCutting || false,
      serviceCuttingCost: part.serviceCuttingCost || '',
      serviceCuttingVendor: part.serviceCuttingVendor || '',
      serviceFitting: part.serviceFitting || false,
      serviceFittingCost: part.serviceFittingCost || '',
      serviceFittingVendor: part.serviceFittingVendor || '',
      serviceWelding: part.serviceWelding || false,
      serviceWeldingCost: part.serviceWeldingCost || '',
      serviceWeldingVendor: part.serviceWeldingVendor || '',
      serviceWeldingPercent: part.serviceWeldingPercent || 100,
      otherServicesCost: part.otherServicesCost || '',
      otherServicesMarkupPercent: part.otherServicesMarkupPercent || 15
    });
    setShowPartModal(true);
  };

  const handleSavePart = async () => {
    if (!partData.partType) { setError('Part type is required'); return; }
    if (isNew) { setError('Save the estimate first'); return; }
    try {
      setSaving(true);
      setError(null);
      if (editingPart && editingPart.id) {
        await updateEstimatePart(id, editingPart.id, partData);
      } else {
        await addEstimatePart(id, partData);
      }
      await loadEstimate();
      setShowPartModal(false);
      showMessage(editingPart ? 'Part updated' : 'Part added');
    } catch (err) { 
      console.error('Save part error:', err);
      setError(err.response?.data?.error?.message || 'Failed to save part'); 
    }
    finally { setSaving(false); }
  };

  const handleDeletePart = async (partId) => {
    if (!window.confirm('Delete this part?')) return;
    try {
      await deleteEstimatePart(id, partId);
      await loadEstimate();
      showMessage('Part deleted');
    } catch (err) { setError('Failed to delete part'); }
  };

  const handleFileUpload = async (uploadedFiles) => {
    if (isNew) { setError('Save first'); return; }
    try {
      setSaving(true);
      await uploadEstimateFiles(id, Array.from(uploadedFiles));
      await loadEstimate();
      showMessage('Files uploaded');
    } catch (err) { setError('Upload failed'); }
    finally { setSaving(false); }
  };

  const handleViewFile = async (file) => {
    try {
      const data = await getEstimateFileSignedUrl(id, file.id);
      window.open(data.url, '_blank');
    } catch (err) { setError('Failed to open'); }
  };

  const handleDeleteFile = async (file) => {
    if (!window.confirm('Delete?')) return;
    try {
      await deleteEstimateFile(id, file.id);
      await loadEstimate();
    } catch (err) { setError('Delete failed'); }
  };

  // Part File Upload Handlers
  const handlePartFileUpload = async (partId, file) => {
    if (!file) return;
    try {
      setUploadingPartFile(partId);
      await uploadEstimatePartFile(id, partId, file, 'drawing');
      await loadEstimate();
      showMessage('File uploaded to part');
    } catch (err) { setError('Failed to upload file'); }
    finally { setUploadingPartFile(null); }
  };

  const handleDeletePartFile = async (partId, fileId) => {
    if (!window.confirm('Delete this file?')) return;
    try {
      await deleteEstimatePartFile(id, partId, fileId);
      await loadEstimate();
      showMessage('File deleted');
    } catch (err) { setError('Failed to delete file'); }
  };

  // Convert to Work Order Handlers
  const openConvertModal = async () => {
    if (parts.length === 0) {
      setError('Add at least one part before converting to work order');
      return;
    }
    
    setConvertData({
      clientPurchaseOrderNumber: '',
      requestedDueDate: '',
      promisedDate: '',
      notes: formData.notes
    });
    
    setShowConvertModal(true);
  };

  const handleConvertToWorkOrder = async () => {
    try {
      setConverting(true);
      const response = await convertEstimateToWorkOrder(id, convertData);
      const workOrder = response.data.data.workOrder;
      setShowConvertModal(false);
      
      const message = `Work order DR-${workOrder.drNumber} created!`;
      showMessage(message);
      
      // Reload estimate to update workOrderId status
      await loadEstimate();
      
      // Navigate to the new work order
      setTimeout(() => navigate(`/workorders/${workOrder.id}`), 1500);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to convert to work order');
    } finally {
      setConverting(false);
    }
  };

  const formatCurrency = (amt) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amt || 0);
  
  const printEstimate = () => {
    const totals = calculateTotals();
    const partsHtml = parts.map(part => {
      const calc = calculatePartTotal(part);
      return `<div style="border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:12px;">
        <h4 style="margin:0 0 8px;color:#1976d2;">Part #${part.partNumber} - ${PART_TYPES[part.partType]?.label || part.partType}</h4>
        <p style="margin:0 0 8px;color:#666;">${part.clientPartNumber ? `Client Part#: ${part.clientPartNumber}` : ''} ${part.heatNumber ? `Heat#: ${part.heatNumber}` : ''}</p>
        <p><strong>Qty:</strong> ${part.quantity} | <strong>Material:</strong> ${part.materialDescription || 'N/A'}</p>
        ${part.supplierName ? `<p style="color:#388e3c;">Supplier: ${part.supplierName}</p>` : ''}
        <table style="width:100%;margin-top:8px;"><tr><td>Material:</td><td style="text-align:right;">${formatCurrency(calc.materialTotal)}</td></tr>
        <tr><td>Rolling:</td><td style="text-align:right;">${formatCurrency(part.rollingCost)}</td></tr>
        <tr><td>Other Services:</td><td style="text-align:right;">${formatCurrency(calc.otherTotal)}</td></tr>
        <tr style="font-weight:bold;border-top:1px solid #ddd;"><td>Part Total:</td><td style="text-align:right;">${formatCurrency(calc.partTotal)}</td></tr></table>
      </div>`;
    }).join('');
    
    const taxLine = formData.taxExempt 
      ? `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #ddd;"><span>Tax</span><span style="color:#c62828;font-weight:bold;">EXEMPT${formData.taxExemptCertNumber ? ` (Cert#: ${formData.taxExemptCertNumber})` : ''}</span></div>`
      : `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #ddd;"><span>Tax (${formData.taxRate}%)</span><span>${formatCurrency(totals.taxAmount)}</span></div>`;
    
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Estimate ${estimate?.estimateNumber}</title>
      <style>body{font-family:Arial,sans-serif;padding:40px;max-width:800px;margin:0 auto}</style></head><body>
      <h1 style="color:#1976d2;">Carolina Rolling</h1><p>Estimate: <strong>${estimate?.estimateNumber}</strong></p>
      <h2>Client: ${formData.clientName}</h2>
      ${formData.contactName ? `<p>Contact: ${formData.contactName}</p>` : ''}
      ${formData.projectDescription ? `<p>Project: ${formData.projectDescription}</p>` : ''}
      <h3>Parts</h3>${partsHtml}
      ${formData.truckingCost > 0 ? `<div style="background:#fff3e0;padding:12px;border-radius:8px;margin:12px 0;"><strong>🚚 Trucking:</strong> ${formData.truckingDescription || ''} - ${formatCurrency(formData.truckingCost)} (Not Taxed)</div>` : ''}
      <div style="background:#f0f7ff;padding:16px;border-radius:8px;margin-top:20px;">
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #ddd;"><span>Parts Subtotal</span><span>${formatCurrency(totals.partsSubtotal)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #ddd;"><span>Trucking</span><span>${formatCurrency(totals.trucking)}</span></div>
        ${taxLine}
        <div style="display:flex;justify-content:space-between;padding:12px 0;font-size:1.3em;font-weight:bold;color:#1976d2;"><span>Grand Total</span><span>${formatCurrency(totals.grandTotal)}</span></div>
      </div>
      <div style="background:#e8f5e9;padding:12px;border-radius:8px;margin-top:12px;">
        <div style="font-size:0.85em;color:#666;margin-bottom:4px;">Payment by Credit Card (Square 2.9% + $0.30)</div>
        <div style="display:flex;justify-content:space-between;"><span>Processing Fee:</span><span>${formatCurrency(totals.ccFee)}</span></div>
        <div style="display:flex;justify-content:space-between;font-weight:bold;color:#388e3c;"><span>Credit Card Total:</span><span>${formatCurrency(totals.ccTotal)}</span></div>
      </div>
      ${formData.notes ? `<div style="margin-top:20px;padding:12px;background:#f9f9f9;border-radius:8px;"><strong>Terms:</strong> ${formData.notes}</div>` : ''}
      </body></html>`);
    w.document.close();
    w.print();
  };

  const totals = calculateTotals();

  if (loading) return <div className="loading"><div className="spinner"></div></div>;

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button className="btn btn-secondary" onClick={() => navigate('/estimates')} style={{ borderRadius: '50%', padding: 8 }}>
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="page-title">{isNew ? 'New Estimate' : estimate?.estimateNumber}</h1>
            {!isNew && <div style={{ color: '#666', fontSize: '0.875rem' }}>{formData.clientName}</div>}
          </div>
        </div>
        <div className="actions-row">
          {!isNew && (
            <button className="btn btn-outline" onClick={handleDownloadPDF} disabled={downloadingPDF}>
              <FileDown size={18} /> {downloadingPDF ? 'Generating...' : 'Download PDF'}
            </button>
          )}
          {!isNew && <button className="btn btn-outline" onClick={printEstimate}><Printer size={18} /> Print</button>}
          <button className="btn btn-secondary" onClick={() => handleSave(false)} disabled={saving}>
            <Save size={18} /> {saving ? 'Saving...' : 'Save'}
          </button>
          {(isNew || estimate?.status === 'draft') && (
            <button className="btn btn-primary" onClick={() => handleSave(true)} disabled={saving}>
              <Send size={18} /> Send
            </button>
          )}
          {!isNew && !estimate?.workOrderId && (
            <button className="btn" onClick={openConvertModal} disabled={converting}
              style={{ background: '#2e7d32', color: 'white' }}>
              <Package size={18} /> Convert to Work Order
            </button>
          )}
          {estimate?.workOrderId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button 
                className="btn"
                onClick={() => navigate(`/workorders/${estimate.workOrderId}`)}
                style={{ background: '#e8f5e9', color: '#2e7d32' }}
              >
                ✓ View Work Order
              </button>
              <button 
                className="btn btn-sm"
                onClick={async () => {
                  if (!window.confirm('Reset conversion? This will allow you to convert again. Use only if the work order is missing.')) return;
                  try {
                    await resetEstimateConversion(id);
                    await loadEstimate();
                    showMessage('Conversion reset. You can convert again.');
                  } catch (err) {
                    setError(err.response?.data?.error?.message || 'Cannot reset - work order exists');
                  }
                }}
                style={{ background: '#fff3e0', color: '#e65100' }}
                title="Reset if work order is missing"
              >
                Reset
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div>
          {/* Client Info */}
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: 16 }}>Client Information</h3>
            <div className="grid grid-2">
              <div className="form-group" style={{ position: 'relative' }}>
                <label className="form-label">Client Name *</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={formData.clientName}
                  ref={clientInputRef}
                  onChange={async (e) => {
                    const value = e.target.value;
                    setFormData({ ...formData, clientName: value });
                    if (value.length >= 2) {
                      try {
                        const res = await searchClients(value);
                        setClientSuggestions(res.data.data || []);
                        setShowClientSuggestions(true);
                      } catch (err) {
                        setClientSuggestions([]);
                      }
                    } else {
                      setClientSuggestions([]);
                      setShowClientSuggestions(false);
                    }
                  }}
                  onFocus={() => clientSuggestions.length > 0 && setShowClientSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowClientSuggestions(false), 200)}
                  autoComplete="off"
                />
                {showClientSuggestions && clientSuggestions.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                    background: 'white', border: '1px solid #ddd', borderRadius: 4,
                    maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
                  }}>
                    {clientSuggestions.map(client => (
                      <div 
                        key={client.id}
                        style={{ 
                          padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #eee',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                        }}
                        onMouseDown={() => {
                          // Apply client data
                          setFormData({
                            ...formData,
                            clientName: client.name,
                            contactName: client.contactName || formData.contactName,
                            contactEmail: client.contactEmail || formData.contactEmail,
                            contactPhone: client.contactPhone || formData.contactPhone,
                            // Apply tax settings
                            taxExempt: client.taxStatus === 'resale' || client.taxStatus === 'exempt',
                            taxExemptReason: client.taxStatus === 'resale' ? 'Resale' : (client.taxStatus === 'exempt' ? 'Tax Exempt' : ''),
                            taxExemptCertNumber: client.resaleCertificate || '',
                            useCustomTax: !!client.customTaxRate,
                            taxRate: client.customTaxRate ? parseFloat(client.customTaxRate) * 100 : formData.taxRate
                          });
                          setShowClientSuggestions(false);
                          showMessage(`Applied ${client.name}'s info`);
                        }}
                      >
                        <div>
                          <strong>{client.name}</strong>
                          {client.contactName && <div style={{ fontSize: '0.8rem', color: '#666' }}>{client.contactName}</div>}
                        </div>
                        <span style={{ 
                          fontSize: '0.7rem', padding: '2px 6px', borderRadius: 4,
                          background: client.taxStatus === 'resale' ? '#fff3e0' : client.taxStatus === 'exempt' ? '#e8f5e9' : '#e3f2fd',
                          color: client.taxStatus === 'resale' ? '#e65100' : client.taxStatus === 'exempt' ? '#2e7d32' : '#1565c0'
                        }}>
                          {client.taxStatus === 'resale' ? 'Resale' : client.taxStatus === 'exempt' ? 'Exempt' : 'Taxable'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Contact Name</label>
                <input type="text" className="form-input" value={formData.contactName}
                  onChange={(e) => setFormData({ ...formData, contactName: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input type="email" className="form-input" value={formData.contactEmail}
                  onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input type="tel" className="form-input" value={formData.contactPhone}
                  onChange={(e) => setFormData({ ...formData, contactPhone: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Project Description</label>
                <textarea className="form-textarea" value={formData.projectDescription}
                  onChange={(e) => setFormData({ ...formData, projectDescription: e.target.value })} />
              </div>
            </div>
          </div>

          {/* Parts */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">📦 Parts ({parts.length})</h3>
              <button className="btn btn-primary btn-sm" onClick={openAddPartModal} disabled={isNew}>
                <Plus size={16} /> Add Part
              </button>
            </div>

            {isNew && <p style={{ color: '#666', padding: 20, textAlign: 'center' }}>Save the estimate first to add parts</p>}

            {parts.map(part => {
              const calc = calculatePartTotal(part);
              return (
                <div key={part.id} style={{ border: '2px solid #e0e0e0', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #eee' }}>
                    <div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1976d2' }}>
                        Part #{part.partNumber} - {PART_TYPES[part.partType]?.label || part.partType}
                      </div>
                      <div style={{ color: '#666', fontSize: '0.85rem' }}>
                        {part.clientPartNumber && `Client Part#: ${part.clientPartNumber}`}
                        {part.heatNumber && ` • Heat#: ${part.heatNumber}`}
                      </div>
                    </div>
                    <div className="actions-row">
                      {part.materialOrdered && (
                        <span style={{ background: '#e8f5e9', color: '#2e7d32', padding: '4px 8px', borderRadius: 4, fontSize: '0.75rem' }}>
                          <Check size={12} /> PO: {part.materialPurchaseOrderNumber}
                        </span>
                      )}
                      <button className="btn btn-sm btn-outline" onClick={() => openEditPartModal(part)}>✏️</button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDeletePart(part.id)}><Trash2 size={14} /></button>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: '0.875rem', marginBottom: 12 }}>
                    <div><strong>Qty:</strong> {part.quantity}</div>
                    {part.material && <div><strong>Material:</strong> {part.material}</div>}
                    {part.diameter && <div><strong>Diameter:</strong> {part.diameter}"</div>}
                    {part.radius && <div><strong>Radius:</strong> {part.radius}"</div>}
                    {part.arcDegrees && <div><strong>Arc:</strong> {part.arcDegrees}°</div>}
                  </div>

                  {/* Material Section - only show if we supply material */}
                  {part.weSupplyMaterial && part.materialDescription && (
                    <div style={{ background: '#fff3e0', borderRadius: 8, padding: 12, marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <strong>📦 We Supply Material</strong>
                        {part.supplierName && (
                          <span style={{ background: '#ffe0b2', padding: '2px 8px', borderRadius: 4, fontSize: '0.75rem', color: '#e65100' }}>
                            🏭 {part.supplierName}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.875rem' }}>{part.materialDescription} (Qty: {part.quantity})</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: '0.85rem' }}>
                        <span>Cost: {formatCurrency(calc.materialCost)} + {part.materialMarkupPercent}% markup</span>
                        <strong style={{ color: '#e65100' }}>{formatCurrency(calc.materialTotal)}</strong>
                      </div>
                    </div>
                  )}

                  {/* Costs Section */}
                  <div style={{ background: '#f9f9f9', borderRadius: 8, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                      <span>🔄 Rolling Cost</span>
                      <strong>{formatCurrency(part.rollingCost)}</strong>
                    </div>
                    {/* Additional Services */}
                    {part.serviceDrilling && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                        <span>🔩 Drilling {part.serviceDrillingVendor && <span style={{ fontSize: '0.75rem', color: '#666' }}>({part.serviceDrillingVendor})</span>}</span>
                        <strong>{formatCurrency(part.serviceDrillingCost)}</strong>
                      </div>
                    )}
                    {part.serviceCutting && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                        <span>✂️ Cutting {part.serviceCuttingVendor && <span style={{ fontSize: '0.75rem', color: '#666' }}>({part.serviceCuttingVendor})</span>}</span>
                        <strong>{formatCurrency(part.serviceCuttingCost)}</strong>
                      </div>
                    )}
                    {part.serviceFitting && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                        <span>🔧 Fitting {part.serviceFittingVendor && <span style={{ fontSize: '0.75rem', color: '#666' }}>({part.serviceFittingVendor})</span>}</span>
                        <strong>{formatCurrency(part.serviceFittingCost)}</strong>
                      </div>
                    )}
                    {part.serviceWelding && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                        <span>🔥 Welding {part.serviceWeldingPercent}% {part.serviceWeldingVendor && <span style={{ fontSize: '0.75rem', color: '#666' }}>({part.serviceWeldingVendor})</span>}</span>
                        <strong>{formatCurrency(part.serviceWeldingCost)}</strong>
                      </div>
                    )}
                    {(parseFloat(part.otherServicesCost) > 0) && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                        <span>Other Services (+{part.otherServicesMarkupPercent}%)</span>
                        <strong>{formatCurrency(calc.otherTotal)}</strong>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: '1.05rem' }}>
                      <strong>Part Total</strong>
                      <strong style={{ color: '#1976d2' }}>{formatCurrency(calc.partTotal)}</strong>
                    </div>
                  </div>

                  {/* Part Files Section */}
                  <div style={{ marginTop: 12, padding: 12, background: '#f5f5f5', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <strong style={{ fontSize: '0.9rem' }}>📄 Part Documents</strong>
                      <label style={{ cursor: 'pointer' }}>
                        <input
                          type="file"
                          accept=".pdf,.png,.jpg,.jpeg,.gif,.dxf,.dwg"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            if (e.target.files[0]) {
                              handlePartFileUpload(part.id, e.target.files[0]);
                              e.target.value = '';
                            }
                          }}
                          disabled={uploadingPartFile === part.id}
                        />
                        <span className="btn btn-sm btn-outline" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Upload size={14} />
                          {uploadingPartFile === part.id ? 'Uploading...' : 'Upload'}
                        </span>
                      </label>
                    </div>
                    {part.files && part.files.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {part.files.map(file => (
                          <div key={file.id} style={{
                            display: 'flex', alignItems: 'center', gap: 8, background: 'white',
                            padding: '6px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: '0.8rem'
                          }}>
                            <FileText size={14} style={{ color: '#1976d2' }} />
                            <a href={file.url} target="_blank" rel="noopener noreferrer"
                              style={{ color: '#1976d2', textDecoration: 'none', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {file.originalName || file.filename}
                            </a>
                            <button onClick={() => handleDeletePartFile(part.id, file.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d32f2f', padding: 2 }}>
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ color: '#999', fontSize: '0.8rem', textAlign: 'center', padding: 8 }}>
                        No documents attached. Upload drawings, prints, or specs.
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Trucking */}
            <div style={{ background: '#fff3e0', border: '1px solid #ffb74d', borderRadius: 8, padding: 16, marginTop: 16 }}>
              <h4 style={{ margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                🚚 Trucking <span style={{ fontSize: '0.75rem', color: '#e65100' }}>(Not Taxed)</span>
              </h4>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <input type="text" className="form-input" placeholder="Description..."
                  value={formData.truckingDescription}
                  onChange={(e) => setFormData({ ...formData, truckingDescription: e.target.value })}
                  style={{ flex: 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>$</span>
                  <input type="number" className="form-input" value={formData.truckingCost}
                    onChange={(e) => setFormData({ ...formData, truckingCost: parseFloat(e.target.value) || 0 })}
                    style={{ width: 100 }} step="0.01" />
                </div>
              </div>
            </div>

            {/* Files */}
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #eee' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <strong>📎 Files (DXF, STEP, PDF)</strong>
                <input type="file" multiple accept=".pdf,.dxf,.step,.stp" style={{ display: 'none' }}
                  ref={fileInputRef} onChange={(e) => handleFileUpload(e.target.files)} />
                <button className="btn btn-sm btn-outline" onClick={() => fileInputRef.current?.click()} disabled={isNew}>
                  <Upload size={14} /> Upload
                </button>
              </div>
              {files.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {files.map(file => (
                    <div key={file.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#e3f2fd', borderRadius: 4, fontSize: '0.85rem' }}>
                      <span>{file.originalName || file.filename}</span>
                      <button onClick={() => handleViewFile(file)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><Eye size={14} /></button>
                      <button onClick={() => handleDeleteFile(file)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d32f2f' }}><X size={14} /></button>
                    </div>
                  ))}
                </div>
              ) : <div style={{ color: '#999', fontSize: '0.85rem' }}>{isNew ? 'Save first to upload' : 'No files'}</div>}
            </div>
          </div>

          {/* Notes */}
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: 16 }}>Notes & Terms</h3>
            <div className="form-group">
              <label className="form-label">Estimate Notes (visible to customer)</label>
              <textarea className="form-textarea" value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Internal Notes (not visible)</label>
              <textarea className="form-textarea" value={formData.internalNotes}
                onChange={(e) => setFormData({ ...formData, internalNotes: e.target.value })} />
            </div>
          </div>
        </div>

        {/* Summary Sidebar */}
        <div>
          <div className="card" style={{ position: 'sticky', top: 24 }}>
            <h3 className="card-title" style={{ marginBottom: 16 }}>Estimate Summary</h3>

            {parts.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '0.875rem', color: '#666', marginBottom: 8 }}>Parts Breakdown</div>
                <div style={{ fontSize: '0.8rem', padding: 8, background: '#f9f9f9', borderRadius: 8 }}>
                  {parts.map(part => {
                    const calc = calculatePartTotal(part);
                    return (
                      <div key={part.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                        <span>Part #{part.partNumber}</span>
                        <span>{formatCurrency(calc.partTotal)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div style={{ background: '#f0f7ff', borderRadius: 8, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #ddd' }}>
                <span>Parts Subtotal</span><span>{formatCurrency(totals.partsSubtotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #ddd' }}>
                <span>Trucking</span><span>{formatCurrency(totals.trucking)}</span>
              </div>
              
              {/* Tax Section */}
              <div style={{ padding: '8px 0', borderBottom: '1px solid #ddd' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={formData.taxExempt}
                      onChange={(e) => setFormData({ ...formData, taxExempt: e.target.checked })} />
                    <span style={{ fontWeight: formData.taxExempt ? 600 : 400, color: formData.taxExempt ? '#c62828' : 'inherit' }}>
                      Tax Exempt
                    </span>
                  </label>
                  {!formData.taxExempt ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="number" className="form-input" value={formData.taxRate}
                        onChange={(e) => setFormData({ ...formData, taxRate: parseFloat(e.target.value) || 0 })}
                        style={{ width: 50, textAlign: 'center', padding: '4px' }} step="0.1" />%
                      <span style={{ marginLeft: 8 }}>{formatCurrency(totals.taxAmount)}</span>
                    </div>
                  ) : (
                    <span style={{ color: '#c62828', fontWeight: 600 }}>$0.00</span>
                  )}
                </div>
                
                {/* Tax Exempt Details */}
                {formData.taxExempt && (
                  <div style={{ marginTop: 8, padding: 8, background: '#fff3e0', borderRadius: 4, fontSize: '0.8rem' }}>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <input type="text" className="form-input" placeholder="Resale Certificate #" 
                        value={formData.taxExemptCertNumber}
                        onChange={(e) => setFormData({ ...formData, taxExemptCertNumber: e.target.value })}
                        style={{ fontSize: '0.8rem', padding: '4px 8px' }} />
                    </div>
                    <input type="text" className="form-input" placeholder="Reason (e.g., Resale, Non-profit)" 
                      value={formData.taxExemptReason}
                      onChange={(e) => setFormData({ ...formData, taxExemptReason: e.target.value })}
                      style={{ fontSize: '0.8rem', padding: '4px 8px' }} />
                  </div>
                )}
              </div>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', fontSize: '1.25rem', fontWeight: 700, color: '#1976d2' }}>
                <span>Grand Total</span><span>{formatCurrency(totals.grandTotal)}</span>
              </div>
              
              {/* Credit Card Total */}
              <div style={{ background: '#e8f5e9', borderRadius: 6, padding: 10, marginTop: 8 }}>
                <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: 4 }}>
                  Credit Card (Square 2.9% + $0.30)
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.85rem', color: '#388e3c' }}>CC Total</span>
                  <span style={{ fontSize: '1rem', fontWeight: 600, color: '#388e3c' }}>{formatCurrency(totals.ccTotal)}</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: '#999', marginTop: 2 }}>
                  Fee: {formatCurrency(totals.ccFee)}
                </div>
              </div>
            </div>

            {/* Material by Supplier */}
            {parts.some(p => p.supplierName) && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #eee' }}>
                <div style={{ fontSize: '0.875rem', color: '#666', marginBottom: 8 }}>Material by Supplier</div>
                <div style={{ fontSize: '0.8rem' }}>
                  {Object.entries(parts.reduce((acc, p) => {
                    if (p.supplierName) {
                      const calc = calculatePartTotal(p);
                      acc[p.supplierName] = (acc[p.supplierName] || 0) + calc.materialTotal;
                    }
                    return acc;
                  }, {})).map(([supplier, total]) => (
                    <div key={supplier} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <span>{supplier}</span><span>{formatCurrency(total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Add/Edit Part Modal */}
      {showPartModal && (
        <div className="modal-overlay" onClick={() => setShowPartModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 800 }}>
            <div className="modal-header">
              <h3 className="modal-title">{editingPart ? 'Edit Part' : 'Add Part'}</h3>
              <button className="modal-close" onClick={() => setShowPartModal(false)}>&times;</button>
            </div>

            <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            <div className="grid grid-2">
              <div className="form-group">
                <label className="form-label">Part Type *</label>
                <select className="form-select" value={partData.partType}
                  onChange={(e) => setPartData({ ...partData, partType: e.target.value })}>
                  <option value="">Select...</option>
                  {Object.entries(PART_TYPES).map(([val, { label }]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Quantity *</label>
                <input type="number" className="form-input" value={partData.quantity}
                  onChange={(e) => setPartData({ ...partData, quantity: parseInt(e.target.value) || 1 })} min="1" />
              </div>
              <div className="form-group">
                <label className="form-label">Client Part Number</label>
                <input type="text" className="form-input" value={partData.clientPartNumber || ''}
                  onChange={(e) => setPartData({ ...partData, clientPartNumber: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Heat Number</label>
                <input type="text" className="form-input" value={partData.heatNumber || ''}
                  onChange={(e) => setPartData({ ...partData, heatNumber: e.target.value })} />
              </div>
            </div>

            <h4 style={{ margin: '20px 0 12px', borderBottom: '1px solid #eee', paddingBottom: 8 }}>📦 Material</h4>
            
            {/* We Supply Material Checkbox Section */}
            <div style={{ 
              padding: 16, borderRadius: 8, marginBottom: 16,
              background: partData.weSupplyMaterial ? '#fff3e0' : '#f5f5f5',
              border: `2px solid ${partData.weSupplyMaterial ? '#ff9800' : '#e0e0e0'}`
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 600 }}>
                <input 
                  type="checkbox" 
                  checked={partData.weSupplyMaterial || false}
                  onChange={(e) => setPartData({ ...partData, weSupplyMaterial: e.target.checked })}
                  style={{ width: 20, height: 20 }}
                />
                <span style={{ fontSize: '1.1rem' }}>We Supply Material</span>
              </label>
              
              {partData.weSupplyMaterial && (
                <div style={{ marginTop: 16 }}>
                  <div className="grid grid-2" style={{ gap: 12 }}>
                    <div className="form-group" style={{ gridColumn: 'span 2', margin: 0 }}>
                      <label className="form-label">Material Description</label>
                      <input type="text" className="form-input" value={partData.materialDescription || ''}
                        onChange={(e) => setPartData({ ...partData, materialDescription: e.target.value })}
                        placeholder='e.g., A36 Plate 1/2" x 48" x 96"' />
                    </div>
                    <div className="form-group" style={{ position: 'relative', margin: 0 }}>
                      <label className="form-label">Supplier</label>
                      <input 
                        type="text" 
                        className="form-input" 
                        value={partData.supplierName || ''}
                        onChange={async (e) => {
                          const value = e.target.value;
                          setPartData({ ...partData, supplierName: value });
                          if (value.length >= 2) {
                            try {
                              const res = await searchVendors(value);
                              setVendorSuggestions(res.data.data || []);
                              setShowVendorSuggestions(true);
                            } catch (err) { setVendorSuggestions([]); }
                          } else {
                            setVendorSuggestions([]);
                            setShowVendorSuggestions(false);
                          }
                        }}
                        onFocus={() => vendorSuggestions.length > 0 && setShowVendorSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowVendorSuggestions(false), 200)}
                        placeholder="e.g., Metro Steel Supply"
                        autoComplete="off"
                      />
                      {showVendorSuggestions && vendorSuggestions.length > 0 && (
                        <div style={{
                          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                          background: 'white', border: '1px solid #ddd', borderRadius: 4,
                          maxHeight: 150, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
                        }}>
                          {vendorSuggestions.map(vendor => (
                            <div key={vendor.id} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                              onMouseDown={() => { setPartData({ ...partData, supplierName: vendor.name }); setShowVendorSuggestions(false); }}>
                              <strong>{vendor.name}</strong>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Unit Cost ($)</label>
                      <input type="number" className="form-input" value={partData.materialUnitCost || ''}
                        onChange={(e) => setPartData({ ...partData, materialUnitCost: e.target.value })}
                        step="0.01" placeholder="0.00" />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Markup (%)</label>
                      <input type="number" className="form-input" value={partData.materialMarkupPercent || 20}
                        onChange={(e) => setPartData({ ...partData, materialMarkupPercent: parseFloat(e.target.value) || 0 })} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <h4 style={{ margin: '20px 0 12px', borderBottom: '1px solid #eee', paddingBottom: 8 }}>🔄 Rolling</h4>
            <div className="grid grid-2">
              <div className="form-group">
                <label className="form-label">Rolling Cost *</label>
                <input type="number" className="form-input" value={partData.rollingCost || ''}
                  onChange={(e) => setPartData({ ...partData, rollingCost: e.target.value })}
                  step="0.01" placeholder="0.00" />
              </div>
            </div>

            <h4 style={{ margin: '20px 0 12px', borderBottom: '1px solid #eee', paddingBottom: 8 }}>🔧 Additional Services</h4>
            <div style={{ display: 'grid', gap: 8 }}>
              {/* Drilling */}
              <div style={{ padding: 12, borderRadius: 8, background: partData.serviceDrilling ? '#e3f2fd' : '#fafafa', border: `1px solid ${partData.serviceDrilling ? '#2196f3' : '#e0e0e0'}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={partData.serviceDrilling || false}
                    onChange={(e) => setPartData({ ...partData, serviceDrilling: e.target.checked })} />
                  <strong>🔩 Drilling</strong>
                </label>
                {partData.serviceDrilling && (
                  <div className="grid grid-2" style={{ marginTop: 8, gap: 8 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Cost ($)</label>
                      <input type="number" className="form-input" value={partData.serviceDrillingCost || ''}
                        onChange={(e) => setPartData({ ...partData, serviceDrillingCost: e.target.value })} step="0.01" placeholder="0.00" />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Vendor (if outsourced)</label>
                      <input type="text" className="form-input" value={partData.serviceDrillingVendor || ''}
                        onChange={(e) => setPartData({ ...partData, serviceDrillingVendor: e.target.value })} placeholder="In-house" />
                    </div>
                  </div>
                )}
              </div>

              {/* Cutting */}
              <div style={{ padding: 12, borderRadius: 8, background: partData.serviceCutting ? '#e3f2fd' : '#fafafa', border: `1px solid ${partData.serviceCutting ? '#2196f3' : '#e0e0e0'}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={partData.serviceCutting || false}
                    onChange={(e) => setPartData({ ...partData, serviceCutting: e.target.checked })} />
                  <strong>✂️ Cutting</strong>
                </label>
                {partData.serviceCutting && (
                  <div className="grid grid-2" style={{ marginTop: 8, gap: 8 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Cost ($)</label>
                      <input type="number" className="form-input" value={partData.serviceCuttingCost || ''}
                        onChange={(e) => setPartData({ ...partData, serviceCuttingCost: e.target.value })} step="0.01" placeholder="0.00" />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Vendor (if outsourced)</label>
                      <input type="text" className="form-input" value={partData.serviceCuttingVendor || ''}
                        onChange={(e) => setPartData({ ...partData, serviceCuttingVendor: e.target.value })} placeholder="In-house" />
                    </div>
                  </div>
                )}
              </div>

              {/* Fitting */}
              <div style={{ padding: 12, borderRadius: 8, background: partData.serviceFitting ? '#e3f2fd' : '#fafafa', border: `1px solid ${partData.serviceFitting ? '#2196f3' : '#e0e0e0'}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={partData.serviceFitting || false}
                    onChange={(e) => setPartData({ ...partData, serviceFitting: e.target.checked })} />
                  <strong>🔧 Fitting</strong>
                </label>
                {partData.serviceFitting && (
                  <div className="grid grid-2" style={{ marginTop: 8, gap: 8 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Cost ($)</label>
                      <input type="number" className="form-input" value={partData.serviceFittingCost || ''}
                        onChange={(e) => setPartData({ ...partData, serviceFittingCost: e.target.value })} step="0.01" placeholder="0.00" />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Vendor (if outsourced)</label>
                      <input type="text" className="form-input" value={partData.serviceFittingVendor || ''}
                        onChange={(e) => setPartData({ ...partData, serviceFittingVendor: e.target.value })} placeholder="In-house" />
                    </div>
                  </div>
                )}
              </div>

              {/* Welding */}
              <div style={{ padding: 12, borderRadius: 8, background: partData.serviceWelding ? '#fff3e0' : '#fafafa', border: `1px solid ${partData.serviceWelding ? '#ff9800' : '#e0e0e0'}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={partData.serviceWelding || false}
                    onChange={(e) => setPartData({ ...partData, serviceWelding: e.target.checked })} />
                  <strong>🔥 Welding</strong>
                </label>
                {partData.serviceWelding && (
                  <div className="grid grid-3" style={{ marginTop: 8, gap: 8 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Cost ($)</label>
                      <input type="number" className="form-input" value={partData.serviceWeldingCost || ''}
                        onChange={(e) => setPartData({ ...partData, serviceWeldingCost: e.target.value })} step="0.01" placeholder="0.00" />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Welding %</label>
                      <select className="form-select" value={partData.serviceWeldingPercent || 100}
                        onChange={(e) => setPartData({ ...partData, serviceWeldingPercent: parseInt(e.target.value) })}>
                        <option value={25}>25%</option>
                        <option value={50}>50%</option>
                        <option value={75}>75%</option>
                        <option value={100}>100%</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>Vendor</label>
                      <input type="text" className="form-input" value={partData.serviceWeldingVendor || ''}
                        onChange={(e) => setPartData({ ...partData, serviceWeldingVendor: e.target.value })} placeholder="In-house" />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <h4 style={{ margin: '20px 0 12px', borderBottom: '1px solid #eee', paddingBottom: 8 }}>📐 Specifications</h4>
            <div className="grid grid-3">
              <div className="form-group">
                <label className="form-label">Material Type</label>
                <input type="text" className="form-input" value={partData.material || ''}
                  onChange={(e) => setPartData({ ...partData, material: e.target.value })}
                  placeholder="e.g., A36, 304 SS" />
              </div>
              <div className="form-group">
                <label className="form-label">Diameter</label>
                <input type="text" className="form-input" value={partData.diameter || ''}
                  onChange={(e) => setPartData({ ...partData, diameter: e.target.value })}
                  placeholder='e.g., 72"' />
              </div>
              <div className="form-group">
                <label className="form-label">Radius</label>
                <input type="text" className="form-input" value={partData.radius || ''}
                  onChange={(e) => setPartData({ ...partData, radius: e.target.value })}
                  placeholder='e.g., 36"' />
              </div>
              <div className="form-group">
                <label className="form-label">Arc Degrees</label>
                <input type="text" className="form-input" value={partData.arcDegrees || ''}
                  onChange={(e) => setPartData({ ...partData, arcDegrees: e.target.value })}
                  placeholder="e.g., 90, 180, 360" />
              </div>
              <div className="form-group">
                <label className="form-label">Roll Direction</label>
                <select className="form-select" value={partData.rollType || ''}
                  onChange={(e) => setPartData({ ...partData, rollType: e.target.value })}>
                  <option value="">Select...</option>
                  <option value="easy_way">Easy Way</option>
                  <option value="hard_way">Hard Way</option>
                </select>
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'center', paddingTop: 24 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={partData.flangeOut || false}
                    onChange={(e) => setPartData({ ...partData, flangeOut: e.target.checked })} />
                  Flange Out
                </label>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Special Instructions</label>
              <textarea className="form-textarea" value={partData.specialInstructions || ''} rows={2}
                onChange={(e) => setPartData({ ...partData, specialInstructions: e.target.value })} />
            </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowPartModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSavePart} disabled={!partData.partType || saving}>
                {saving ? 'Saving...' : editingPart ? 'Update Part' : 'Add Part'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Convert to Work Order Modal */}
      {showConvertModal && (
        <div className="modal-overlay" onClick={() => setShowConvertModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h3>Convert to Work Order</h3>
              <button className="btn btn-icon" onClick={() => setShowConvertModal(false)}><X size={20} /></button>
            </div>

            <div style={{ padding: 20 }}>
              <div style={{ background: '#e3f2fd', padding: 16, borderRadius: 8, marginBottom: 20 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>📋 {estimate?.estimateNumber}</p>
                <p style={{ margin: '8px 0 0', color: '#666' }}>
                  Client: {formData.clientName} • {parts.length} part(s)
                </p>
                <p style={{ margin: '4px 0 0', fontWeight: 700, color: '#1976d2' }}>
                  Total: {formatCurrency(calculateTotals().grandTotal)}
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Client Purchase Order Number</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Enter client's PO number..."
                  value={convertData.clientPurchaseOrderNumber}
                  onChange={(e) => setConvertData({ ...convertData, clientPurchaseOrderNumber: e.target.value })}
                />
              </div>

              <div className="grid grid-2" style={{ gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Requested Due Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={convertData.requestedDueDate}
                    onChange={(e) => setConvertData({ ...convertData, requestedDueDate: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Promised Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={convertData.promisedDate}
                    onChange={(e) => setConvertData({ ...convertData, promisedDate: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea
                  className="form-textarea"
                  value={convertData.notes}
                  onChange={(e) => setConvertData({ ...convertData, notes: e.target.value })}
                  rows={3}
                />
              </div>

              {/* Note about material ordering */}
              {parts.some(p => p.materialSource === 'we_order') && (
                <div style={{ background: '#e3f2fd', padding: 12, borderRadius: 8, marginTop: 16 }}>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: '#1565c0' }}>
                    💡 <strong>Material Ordering:</strong> After converting, you can order material from the Work Order page using the "Order Material" button.
                  </p>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowConvertModal(false)}>Cancel</button>
              <button
                className="btn"
                onClick={handleConvertToWorkOrder}
                disabled={converting}
                style={{ background: '#2e7d32', color: 'white' }}
              >
                <Package size={18} />
                {converting ? 'Converting...' : 'Create Work Order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default EstimateDetailsPage;
