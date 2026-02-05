import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, Edit, Trash2, Save, X, Upload, FileText, 
  Download, QrCode, MapPin, Calendar, User, Package,
  Clock, CheckCircle, Eye
} from 'lucide-react';
import QRCode from 'qrcode';
import { 
  getShipmentById, 
  updateShipment, 
  deleteShipment,
  uploadPhotos,
  uploadDocuments,
  deletePhoto,
  deleteDocument,
  getLocations,
  getDocumentSignedUrl
} from '../services/api';

function ShipmentDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const photoInputRef = useRef(null);
  const docInputRef = useRef(null);

  const [shipment, setShipment] = useState(null);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [pdfViewerUrl, setPdfViewerUrl] = useState(null);
  const [pdfViewerName, setPdfViewerName] = useState('');

  useEffect(() => {
    loadShipment();
    loadLocations();
  }, [id]);

  useEffect(() => {
    if (shipment?.qrCode) {
      generateQRCode(shipment.qrCode);
    }
  }, [shipment?.qrCode]);

  const loadShipment = async () => {
    try {
      setLoading(true);
      const response = await getShipmentById(id);
      const data = response.data.data;
      setShipment(data);
      setEditData({
        clientName: data.clientName || '',
        jobNumber: data.jobNumber || '',
        clientPurchaseOrderNumber: data.clientPurchaseOrderNumber || '',
        description: data.description || '',
        partNumbers: data.partNumbers?.join(', ') || '',
        quantity: data.quantity || 1,
        location: data.location || '',
        notes: data.notes || '',
        requestedDueDate: data.requestedDueDate?.split('T')[0] || '',
        promisedDate: data.promisedDate?.split('T')[0] || '',
      });
    } catch (err) {
      setError('Failed to load shipment');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadLocations = async () => {
    try {
      const response = await getLocations();
      setLocations(response.data.data || []);
    } catch (err) {
      console.error('Failed to load locations:', err);
    }
  };

  const generateQRCode = async (code) => {
    try {
      const url = await QRCode.toDataURL(code, { width: 200, margin: 2 });
      setQrCodeUrl(url);
    } catch (err) {
      console.error('QR Code generation failed:', err);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      
      const updateData = {
        clientName: editData.clientName,
        jobNumber: editData.jobNumber || null,
        clientPurchaseOrderNumber: editData.clientPurchaseOrderNumber || null,
        description: editData.description || null,
        partNumbers: editData.partNumbers 
          ? editData.partNumbers.split(',').map(p => p.trim()).filter(p => p)
          : [],
        quantity: parseInt(editData.quantity) || 1,
        location: editData.location || null,
        notes: editData.notes || null,
        requestedDueDate: editData.requestedDueDate || null,
        promisedDate: editData.promisedDate || null,
      };

      console.log('Saving shipment:', id, updateData);
      await updateShipment(id, updateData);
      await loadShipment();
      setIsEditing(false);
      setSuccess('Shipment updated successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      const errorMessage = err.response?.data?.error?.message || err.message || 'Failed to save changes';
      setError(errorMessage);
      console.error('Save error:', err.response?.data || err);
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (newStatus) => {
    try {
      setSaving(true);
      await updateShipment(id, { status: newStatus });
      await loadShipment();
      setShowStatusModal(false);
      setSuccess('Status updated successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('Failed to update status');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteShipment(id);
      navigate('/inventory');
    } catch (err) {
      setError('Failed to delete shipment');
      console.error(err);
    }
  };

  const handlePhotoUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    try {
      setSaving(true);
      await uploadPhotos(id, files);
      await loadShipment();
      setSuccess('Photos uploaded successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('Failed to upload photos');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDocUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    try {
      setSaving(true);
      setError(null);
      await uploadDocuments(id, files);
      await loadShipment();
      setSuccess('Documents uploaded successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.message || 'Failed to upload documents';
      setError(errorMsg);
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePhoto = async (photoId) => {
    if (!window.confirm('Delete this photo?')) return;
    try {
      await deletePhoto(id, photoId);
      await loadShipment();
    } catch (err) {
      setError('Failed to delete photo');
    }
  };

  const handleDeleteDocument = async (docId) => {
    if (!window.confirm('Delete this document?')) return;
    try {
      await deleteDocument(id, docId);
      await loadShipment();
    } catch (err) {
      setError('Failed to delete document');
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'received': return 'status-received';
      case 'in_progress': return 'status-in_progress';
      case 'completed': return 'status-completed';
      case 'shipped': return 'status-shipped';
      default: return 'status-received';
    }
  };

  const statuses = [
    { value: 'received', label: 'Received', color: '#1565c0' },
    { value: 'in_progress', label: 'In Progress', color: '#e65100' },
    { value: 'completed', label: 'Completed', color: '#2e7d32' },
    { value: 'shipped', label: 'Shipped', color: '#7b1fa2' },
  ];

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!shipment) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">Shipment not found</div>
        <button className="btn btn-primary" onClick={() => navigate('/inventory')}>
          Back to Inventory
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="detail-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button className="btn btn-icon btn-secondary" onClick={() => navigate('/inventory')}>
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="detail-title">{shipment.clientName}</h1>
            <div style={{ color: '#666', fontSize: '0.875rem' }}>
              {shipment.jobNumber || shipment.qrCode}
            </div>
          </div>
        </div>
        <div className="actions-row">
          <button 
            className={`status-badge ${getStatusColor(shipment.status)}`}
            style={{ cursor: 'pointer', border: 'none' }}
            onClick={() => setShowStatusModal(true)}
          >
            {shipment.status?.replace('_', ' ')} ▼
          </button>
          {isEditing ? (
            <>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                <Save size={18} />
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button className="btn btn-secondary" onClick={() => setIsEditing(false)}>
                <X size={18} />
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-outline" onClick={() => setIsEditing(true)}>
                <Edit size={18} />
                Edit
              </button>
              <button className="btn btn-danger" onClick={() => setShowDeleteModal(true)}>
                <Trash2 size={18} />
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="grid grid-2" style={{ gridTemplateColumns: '2fr 1fr' }}>
        {/* Main Content */}
        <div>
          {/* Details Card */}
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: 16 }}>Shipment Details</h3>
            
            {isEditing ? (
              <div className="grid grid-2">
                <div className="form-group">
                  <label className="form-label">Client Name *</label>
                  <input
                    type="text"
                    className="form-input"
                    value={editData.clientName}
                    onChange={(e) => setEditData({ ...editData, clientName: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Job Number</label>
                  <input
                    type="text"
                    className="form-input"
                    value={editData.jobNumber}
                    onChange={(e) => setEditData({ ...editData, jobNumber: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Client PO Number</label>
                  <input
                    type="text"
                    className="form-input"
                    value={editData.clientPurchaseOrderNumber}
                    onChange={(e) => setEditData({ ...editData, clientPurchaseOrderNumber: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Quantity</label>
                  <input
                    type="number"
                    className="form-input"
                    value={editData.quantity}
                    onChange={(e) => setEditData({ ...editData, quantity: e.target.value })}
                  />
                </div>
                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                  <label className="form-label">Description</label>
                  <textarea
                    className="form-textarea"
                    value={editData.description}
                    onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Part Numbers (comma separated)</label>
                  <input
                    type="text"
                    className="form-input"
                    value={editData.partNumbers}
                    onChange={(e) => setEditData({ ...editData, partNumbers: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Location</label>
                  <select
                    className="form-select"
                    value={editData.location}
                    onChange={(e) => setEditData({ ...editData, location: e.target.value })}
                  >
                    <option value="">Select location</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.name}>{loc.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Requested Due Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={editData.requestedDueDate}
                    onChange={(e) => setEditData({ ...editData, requestedDueDate: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Promised Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={editData.promisedDate}
                    onChange={(e) => setEditData({ ...editData, promisedDate: e.target.value })}
                  />
                </div>
                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                  <label className="form-label">Notes</label>
                  <textarea
                    className="form-textarea"
                    value={editData.notes}
                    onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <div className="detail-grid">
                <div className="detail-item">
                  <div className="detail-item-label">Client Name</div>
                  <div className="detail-item-value">{shipment.clientName}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-item-label">Job Number</div>
                  <div className="detail-item-value">{shipment.jobNumber || 'N/A'}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-item-label">Client PO</div>
                  <div className="detail-item-value">{shipment.clientPurchaseOrderNumber || 'N/A'}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-item-label">Quantity</div>
                  <div className="detail-item-value">{shipment.quantity}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-item-label">Location</div>
                  <div className="detail-item-value">{shipment.location || 'N/A'}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-item-label">Received At</div>
                  <div className="detail-item-value">{formatDate(shipment.receivedAt)}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-item-label">Requested Due</div>
                  <div className="detail-item-value">{shipment.requestedDueDate?.split('T')[0] || 'N/A'}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-item-label">Promised Date</div>
                  <div className="detail-item-value">{shipment.promisedDate?.split('T')[0] || 'N/A'}</div>
                </div>
                {shipment.description && (
                  <div className="detail-item" style={{ gridColumn: 'span 2' }}>
                    <div className="detail-item-label">Description</div>
                    <div className="detail-item-value">{shipment.description}</div>
                  </div>
                )}
                {shipment.partNumbers?.length > 0 && (
                  <div className="detail-item" style={{ gridColumn: 'span 2' }}>
                    <div className="detail-item-label">Part Numbers</div>
                    <div className="detail-item-value">{shipment.partNumbers.join(', ')}</div>
                  </div>
                )}
                {shipment.notes && (
                  <div className="detail-item" style={{ gridColumn: 'span 2' }}>
                    <div className="detail-item-label">Notes</div>
                    <div className="detail-item-value">{shipment.notes}</div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Photos Card */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Photos ({shipment.photos?.length || 0})</h3>
              <button 
                className="btn btn-outline btn-sm"
                onClick={() => photoInputRef.current?.click()}
              >
                <Upload size={16} />
                Upload Photos
              </button>
              <input
                ref={photoInputRef}
                type="file"
                multiple
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handlePhotoUpload}
              />
            </div>
            {shipment.photos?.length > 0 ? (
              <div className="photo-grid">
                {shipment.photos.map((photo) => (
                  <div key={photo.id} className="photo-item">
                    <img src={photo.url} alt={photo.originalName} />
                    <button 
                      className="photo-item-delete"
                      onClick={() => handleDeletePhoto(photo.id)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ padding: 40 }}>
                <div className="empty-state-icon">📷</div>
                <p>No photos yet</p>
              </div>
            )}
          </div>

          {/* Documents Card */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Documents ({shipment.documents?.length || 0})</h3>
              <button 
                className="btn btn-outline btn-sm"
                onClick={() => docInputRef.current?.click()}
              >
                <Upload size={16} />
                Upload PDF
              </button>
              <input
                ref={docInputRef}
                type="file"
                multiple
                accept=".pdf"
                style={{ display: 'none' }}
                onChange={handleDocUpload}
              />
            </div>
            {shipment.documents?.length > 0 ? (
              <div>
                {shipment.documents.map((doc) => (
                  <div key={doc.id} className="document-item">
                    <FileText size={24} className="document-item-icon" />
                    <span className="document-item-name">{doc.originalName || doc.filename}</span>
                    <div className="document-item-actions">
                      <button 
                        className="btn btn-sm btn-primary"
                        onClick={async () => {
                          try {
                            // Get signed URL from backend
                            const signedData = await getDocumentSignedUrl(id, doc.id);
                            setPdfViewerUrl(signedData.url);
                            setPdfViewerName(signedData.originalName || doc.filename);
                          } catch (err) {
                            setError('Failed to load document');
                            console.error(err);
                          }
                        }}
                      >
                        <Eye size={14} />
                        View
                      </button>
                      <button 
                        className="btn btn-sm btn-outline"
                        onClick={async () => {
                          try {
                            // Get signed URL for download
                            const signedData = await getDocumentSignedUrl(id, doc.id);
                            window.open(signedData.url, '_blank');
                          } catch (err) {
                            setError('Failed to download document');
                            console.error(err);
                          }
                        }}
                      >
                        <Download size={14} />
                        Download
                      </button>
                      <button 
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDeleteDocument(doc.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ padding: 40 }}>
                <div className="empty-state-icon">📄</div>
                <p>No documents yet</p>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div>
          {/* QR Code Card */}
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: 16, textAlign: 'center' }}>QR Code</h3>
            <div className="qr-container">
              {qrCodeUrl && <img src={qrCodeUrl} alt="QR Code" className="qr-code" />}
              <div className="qr-code-text">{shipment.qrCode}</div>
              <button 
                className="btn btn-outline btn-sm" 
                style={{ marginTop: 12 }}
                onClick={() => {
                  const link = document.createElement('a');
                  link.download = `${shipment.qrCode}.png`;
                  link.href = qrCodeUrl;
                  link.click();
                }}
              >
                <Download size={14} />
                Download QR
              </button>
            </div>
          </div>

          {/* Status History */}
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: 16 }}>Status</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {statuses.map((status) => (
                <div 
                  key={status.value}
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 12,
                    opacity: shipment.status === status.value ? 1 : 0.5
                  }}
                >
                  <div style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: shipment.status === status.value ? status.color : '#e0e0e0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    {shipment.status === status.value && <CheckCircle size={14} color="white" />}
                  </div>
                  <span style={{ fontWeight: shipment.status === status.value ? 600 : 400 }}>
                    {status.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Delete Modal */}
      {showDeleteModal && (
        <div className="modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Delete Shipment</h3>
              <button className="modal-close" onClick={() => setShowDeleteModal(false)}>&times;</button>
            </div>
            <p>Are you sure you want to delete this shipment? This action cannot be undone.</p>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowDeleteModal(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Status Modal */}
      {showStatusModal && (
        <div className="modal-overlay" onClick={() => setShowStatusModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Update Status</h3>
              <button className="modal-close" onClick={() => setShowStatusModal(false)}>&times;</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {statuses.map((status) => (
                <button
                  key={status.value}
                  className={`btn ${shipment.status === status.value ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ justifyContent: 'flex-start' }}
                  onClick={() => handleStatusChange(status.value)}
                  disabled={saving}
                >
                  <div style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: status.color
                  }} />
                  {status.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* PDF Viewer Modal */}
      {pdfViewerUrl && (
        <div className="modal-overlay" onClick={() => setPdfViewerUrl(null)}>
          <div 
            className="modal" 
            onClick={(e) => e.stopPropagation()}
            style={{ 
              width: '90vw', 
              maxWidth: 1200, 
              height: '90vh',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div className="modal-header">
              <h3 className="modal-title">{pdfViewerName}</h3>
              <button className="modal-close" onClick={() => setPdfViewerUrl(null)}>&times;</button>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <iframe
                src={`${pdfViewerUrl}#toolbar=1&navpanes=0`}
                style={{ 
                  width: '100%', 
                  height: '100%', 
                  border: 'none'
                }}
                title={pdfViewerName}
              />
            </div>
            <div style={{ padding: 16, borderTop: '1px solid #eee', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <a 
                href={pdfViewerUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="btn btn-outline"
                download
              >
                <Download size={16} />
                Download
              </a>
              <button className="btn btn-secondary" onClick={() => setPdfViewerUrl(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ShipmentDetailsPage;
