import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, DollarSign, Send, Check, X, Archive, Trash2 } from 'lucide-react';
import { getEstimates, deleteEstimate, convertEstimateToWorkOrder } from '../services/api';

function EstimatesPage() {
  const navigate = useNavigate();
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(null);
  const [convertData, setConvertData] = useState({ clientPurchaseOrderNumber: '', promisedDate: '' });
  const [converting, setConverting] = useState(false);

  useEffect(() => {
    loadEstimates();
  }, [showArchived]);

  const loadEstimates = async () => {
    try {
      setLoading(true);
      const response = await getEstimates({ archived: showArchived ? 'true' : 'false' });
      setEstimates(response.data.data || []);
    } catch (err) {
      setError('Failed to load estimates');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getFilteredEstimates = () => {
    let filtered = [...estimates];
    
    if (statusFilter !== 'all') {
      filtered = filtered.filter(e => e.status === statusFilter);
    }
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        e.clientName?.toLowerCase().includes(query) ||
        e.estimateNumber?.toLowerCase().includes(query) ||
        e.projectDescription?.toLowerCase().includes(query)
      );
    }
    
    return filtered;
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this estimate?')) return;
    try {
      await deleteEstimate(id);
      await loadEstimates();
    } catch (err) {
      setError('Failed to delete estimate');
    }
  };

  const handleConvert = async () => {
    if (!showConvertModal) return;
    try {
      setConverting(true);
      const response = await convertEstimateToWorkOrder(showConvertModal.id, convertData);
      const workOrder = response.data.data.workOrder;
      setShowConvertModal(null);
      navigate(`/workorders/${workOrder.id}`);
    } catch (err) {
      setError('Failed to convert estimate');
    } finally {
      setConverting(false);
    }
  };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getStatusBadge = (status) => {
    const styles = {
      draft: { background: '#e0e0e0', color: '#555' },
      sent: { background: '#e3f2fd', color: '#1565c0' },
      accepted: { background: '#e8f5e9', color: '#2e7d32' },
      declined: { background: '#ffebee', color: '#c62828' },
      archived: { background: '#f5f5f5', color: '#999' },
    };
    return <span className="status-badge" style={styles[status] || styles.draft}>{status}</span>;
  };

  const filteredEstimates = getFilteredEstimates();
  const activeCount = estimates.filter(e => e.status !== 'archived').length;

  if (loading) {
    return <div className="loading"><div className="spinner"></div></div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Estimates</h1>
          <p style={{ color: '#666', fontSize: '0.875rem', marginTop: 4 }}>
            {activeCount} active estimates
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/estimates/new')}>
          <Plus size={18} />
          New Estimate
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab ${!showArchived ? 'active' : ''}`} onClick={() => setShowArchived(false)}>
          Active
        </button>
        <button className={`tab ${showArchived ? 'active' : ''}`} onClick={() => setShowArchived(true)}>
          <Archive size={14} style={{ marginRight: 4 }} />
          Archived
        </button>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="search-box" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
            <Search size={18} className="search-box-icon" />
            <input
              type="text"
              placeholder="Search by client, estimate number..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          {!showArchived && (
            <div className="tabs" style={{ marginBottom: 0, borderBottom: 'none', paddingBottom: 0 }}>
              {['all', 'draft', 'sent', 'accepted', 'declined'].map(status => (
                <button
                  key={status}
                  className={`tab ${statusFilter === status ? 'active' : ''}`}
                  onClick={() => setStatusFilter(status)}
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {showArchived && (
        <div className="alert alert-warning" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Archive size={20} />
          <div>
            <strong>Archived Estimates</strong>
            <div style={{ fontSize: '0.8rem' }}>Estimates older than 1 month are automatically archived. Archived estimates are kept for 2 years.</div>
          </div>
        </div>
      )}

      {/* Estimates Table */}
      <div className="card">
        {filteredEstimates.length === 0 ? (
          <div className="empty-state">
            <DollarSign size={48} color="#ccc" />
            <div className="empty-state-title">No estimates</div>
            <p>{searchQuery || statusFilter !== 'all' ? 'No estimates match your filters' : 'Create your first estimate'}</p>
          </div>
        ) : (
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>Estimate #</th>
                <th>Client</th>
                <th>Description</th>
                <th>Total</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredEstimates.map(estimate => (
                <tr key={estimate.id} onClick={() => navigate(`/estimates/${estimate.id}`)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 600, color: '#1976d2' }}>{estimate.estimateNumber}</td>
                  <td>{estimate.clientName}</td>
                  <td style={{ maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {estimate.projectDescription || `${estimate.parts?.length || 0} parts`}
                  </td>
                  <td style={{ fontWeight: 600 }}>{formatCurrency(estimate.grandTotal)}</td>
                  <td>{getStatusBadge(estimate.status)}</td>
                  <td>{formatDate(estimate.createdAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="actions-row">
                      {(estimate.status === 'sent' || estimate.status === 'accepted') && (
                        <button
                          className="btn btn-sm btn-success"
                          title="Convert to Work Order"
                          onClick={(e) => { e.stopPropagation(); setShowConvertModal(estimate); }}
                        >
                          📋→
                        </button>
                      )}
                      {estimate.status === 'draft' && (
                        <button className="btn btn-sm btn-outline" title="Send to Client">
                          <Send size={14} />
                        </button>
                      )}
                      <button className="btn btn-sm btn-danger" onClick={(e) => handleDelete(estimate.id, e)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Convert Modal */}
      {showConvertModal && (
        <div className="modal-overlay" onClick={() => setShowConvertModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h3 className="modal-title">Convert to Work Order</h3>
              <button className="modal-close" onClick={() => setShowConvertModal(null)}>&times;</button>
            </div>
            
            <p style={{ marginBottom: 16 }}>Create a Work Order from this estimate.</p>
            
            <div style={{ background: '#e8f5e9', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <strong>Estimate:</strong> {showConvertModal.estimateNumber}<br />
              <strong>Client:</strong> {showConvertModal.clientName}<br />
              <strong>Total:</strong> {formatCurrency(showConvertModal.grandTotal)}
            </div>

            <div className="form-group">
              <label className="form-label">Client PO Number (if received)</label>
              <input
                type="text"
                className="form-input"
                value={convertData.clientPurchaseOrderNumber}
                onChange={(e) => setConvertData({ ...convertData, clientPurchaseOrderNumber: e.target.value })}
                placeholder="e.g., PO-2025-001"
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

            <div className="alert" style={{ background: '#e3f2fd', border: '1px solid #90caf9', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>ℹ️</span>
              <div style={{ fontSize: '0.875rem' }}>
                The estimate will be marked as "Accepted" and linked to the new work order.
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowConvertModal(null)}>Cancel</button>
              <button className="btn btn-success" onClick={handleConvert} disabled={converting}>
                {converting ? 'Converting...' : 'Create Work Order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default EstimatesPage;
