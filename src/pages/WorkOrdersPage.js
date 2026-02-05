import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Calendar, Package, MapPin } from 'lucide-react';
import { getWorkOrders, createWorkOrder } from '../services/api';

function WorkOrdersPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(() => {
    return localStorage.getItem('workorders_statusFilter') || 'all';
  });
  const [sortBy, setSortBy] = useState(() => {
    return localStorage.getItem('workorders_sortBy') || 'dr_desc';
  });
  const [newOrder, setNewOrder] = useState({
    clientName: '',
    clientPurchaseOrderNumber: '',
    contactName: '',
    contactPhone: '',
    contactEmail: '',
    notes: '',
    receivedBy: '',
    requestedDueDate: '',
    promisedDate: '',
  });

  useEffect(() => {
    localStorage.setItem('workorders_statusFilter', statusFilter);
  }, [statusFilter]);

  useEffect(() => {
    localStorage.setItem('workorders_sortBy', sortBy);
  }, [sortBy]);

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = async () => {
    try {
      setLoading(true);
      const response = await getWorkOrders();
      setOrders(response.data.data || []);
    } catch (err) {
      setError('Failed to load work orders');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getFilteredOrders = () => {
    let filtered = [...orders];

    // Filter by status
    if (statusFilter !== 'all') {
      filtered = filtered.filter(o => o.status === statusFilter);
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(o =>
        o.clientName?.toLowerCase().includes(query) ||
        o.orderNumber?.toLowerCase().includes(query) ||
        o.clientPurchaseOrderNumber?.toLowerCase().includes(query) ||
        o.drNumber?.toString().includes(query) ||
        o.contactName?.toLowerCase().includes(query)
      );
    }

    // Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'dr_desc':
          return (b.drNumber || 0) - (a.drNumber || 0);
        case 'dr_asc':
          return (a.drNumber || 0) - (b.drNumber || 0);
        case 'client':
          return (a.clientName || '').localeCompare(b.clientName || '');
        case 'date_desc':
          return new Date(b.createdAt) - new Date(a.createdAt);
        case 'date_asc':
          return new Date(a.createdAt) - new Date(b.createdAt);
        case 'due_date':
          if (!a.promisedDate && !b.promisedDate) return 0;
          if (!a.promisedDate) return 1;
          if (!b.promisedDate) return -1;
          return new Date(a.promisedDate) - new Date(b.promisedDate);
        default:
          return (b.drNumber || 0) - (a.drNumber || 0);
      }
    });

    return filtered;
  };

  const handleCreateOrder = async (e) => {
    e.preventDefault();
    if (!newOrder.clientName.trim()) {
      setError('Client name is required');
      return;
    }
    try {
      setSaving(true);
      const response = await createWorkOrder(newOrder);
      setShowNewModal(false);
      setNewOrder({
        clientName: '', clientPurchaseOrderNumber: '', contactName: '',
        contactPhone: '', contactEmail: '', notes: '', receivedBy: '',
        requestedDueDate: '', promisedDate: ''
      });
      navigate(`/workorders/${response.data.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create work order');
    } finally {
      setSaving(false);
    }
  };

  const getStatusBadge = (status) => {
    const colors = {
      quoted: { bg: '#f5f5f5', text: '#666', label: 'Quoted' },
      work_order_generated: { bg: '#f3e5f5', text: '#7b1fa2', label: 'WO Generated' },
      waiting_for_materials: { bg: '#fff3e0', text: '#f57c00', label: 'Waiting Materials' },
      received: { bg: '#e3f2fd', text: '#1565c0', label: 'Received' },
      processing: { bg: '#e1f5fe', text: '#0288d1', label: 'Processing' },
      stored: { bg: '#e8f5e9', text: '#2e7d32', label: 'Stored' },
      shipped: { bg: '#f3e5f5', text: '#7b1fa2', label: 'Shipped' },
      archived: { bg: '#eceff1', text: '#546e7a', label: 'Archived' },
      // Legacy mappings
      draft: { bg: '#e3f2fd', text: '#1565c0', label: 'Received' },
      in_progress: { bg: '#e1f5fe', text: '#0288d1', label: 'Processing' },
      completed: { bg: '#e8f5e9', text: '#2e7d32', label: 'Stored' },
      picked_up: { bg: '#f3e5f5', text: '#7b1fa2', label: 'Shipped' }
    };
    const style = colors[status] || colors.received;
    return (
      <span style={{
        background: style.bg,
        color: style.text,
        padding: '4px 10px',
        borderRadius: 12,
        fontSize: '0.75rem',
        fontWeight: 600
      }}>
        {style.label}
      </span>
    );
  };

  const getStatusColor = (order) => {
    if (!order.parts || order.parts.length === 0) return '#9c27b0'; // Purple - no parts
    switch (order.status) {
      case 'stored':
      case 'completed': return '#388e3c';
      case 'shipped':
      case 'picked_up': return '#7b1fa2';
      case 'processing':
      case 'in_progress': return '#0288d1';
      case 'waiting_for_materials': return '#f57c00';
      default: return '#1976d2';
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const filteredOrders = getFilteredOrders();

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Work Orders</h1>
          <p style={{ color: '#666' }}>{orders.length} total orders</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNewModal(true)}>
          <Plus size={20} /> New Work Order
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#666' }} />
              <input
                type="text"
                className="form-input"
                placeholder="Search by client, DR#, PO#..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ paddingLeft: 40 }}
              />
            </div>
          </div>
          <select 
            className="form-select" 
            value={sortBy} 
            onChange={(e) => setSortBy(e.target.value)}
            style={{ width: 180 }}
          >
            <option value="dr_desc">DR# (Newest)</option>
            <option value="dr_asc">DR# (Oldest)</option>
            <option value="client">Client Name</option>
            <option value="date_desc">Created (Newest)</option>
            <option value="date_asc">Created (Oldest)</option>
            <option value="due_date">Due Date</option>
          </select>
        </div>

        {/* Status Tabs */}
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { value: 'all', label: 'All' },
            { value: 'waiting_for_materials', label: 'Waiting Materials' },
            { value: 'received', label: 'Received' },
            { value: 'processing', label: 'Processing' },
            { value: 'stored', label: 'Stored' },
            { value: 'shipped', label: 'Shipped' }
          ].map(status => (
            <button
              key={status.value}
              className={`tab ${statusFilter === status.value ? 'active' : ''}`}
              onClick={() => setStatusFilter(status.value)}
            >
              {status.label}
            </button>
          ))}
        </div>
      </div>

      {/* Work Orders Grid */}
      {filteredOrders.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📋</div>
          <div className="empty-state-title">No work orders found</div>
          <p>{searchQuery || statusFilter !== 'all' ? 'Try adjusting your filters' : 'Create a work order to get started'}</p>
        </div>
      ) : (
        <div className="grid grid-3">
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              className="card"
              onClick={() => navigate(`/workorders/${order.id}`)}
              style={{
                cursor: 'pointer',
                borderLeft: `4px solid ${getStatusColor(order)}`,
                transition: 'transform 0.15s, box-shadow 0.15s'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'none';
                e.currentTarget.style.boxShadow = '';
              }}
            >
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  {order.drNumber ? (
                    <div style={{
                      fontFamily: 'Courier New, monospace',
                      fontWeight: 700,
                      fontSize: '1.2rem',
                      color: '#1976d2',
                      background: '#e3f2fd',
                      padding: '4px 10px',
                      borderRadius: 6,
                      display: 'inline-block'
                    }}>
                      DR-{order.drNumber}
                    </div>
                  ) : (
                    <div style={{ fontWeight: 600, color: '#666', fontSize: '0.85rem' }}>
                      {order.orderNumber}
                    </div>
                  )}
                  <div style={{ fontWeight: 600, fontSize: '1rem', marginTop: 6 }}>
                    {order.clientName}
                  </div>
                </div>
                {getStatusBadge(order.status)}
              </div>

              {/* Client PO */}
              {order.clientPurchaseOrderNumber && (
                <div style={{
                  fontSize: '0.85rem',
                  color: '#555',
                  marginBottom: 8,
                  background: '#f5f5f5',
                  padding: '4px 8px',
                  borderRadius: 4,
                  display: 'inline-block'
                }}>
                  PO# {order.clientPurchaseOrderNumber}
                </div>
              )}

              {/* Parts Count */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#666', fontSize: '0.85rem', marginBottom: 8 }}>
                <Package size={14} />
                <span>{order.parts?.length || 0} part{(order.parts?.length || 0) !== 1 ? 's' : ''}</span>
              </div>

              {/* Storage Location */}
              {order.storageLocation && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#666', fontSize: '0.85rem', marginBottom: 8 }}>
                  <MapPin size={14} />
                  <span>{order.storageLocation}</span>
                </div>
              )}

              {/* Dates */}
              <div style={{ display: 'flex', gap: 12, fontSize: '0.8rem', color: '#888', marginTop: 8 }}>
                {order.promisedDate && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Calendar size={12} />
                    <span>Due: {formatDate(order.promisedDate)}</span>
                  </div>
                )}
                {order.createdAt && (
                  <div>
                    Created: {formatDate(order.createdAt)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New Work Order Modal */}
      {showNewModal && (
        <div className="modal-overlay" onClick={() => setShowNewModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h3 className="modal-title">New Work Order</h3>
              <button className="modal-close" onClick={() => setShowNewModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleCreateOrder}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Client Name *</label>
                  <input
                    type="text"
                    className="form-input"
                    value={newOrder.clientName}
                    onChange={(e) => setNewOrder({ ...newOrder, clientName: e.target.value })}
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Client PO Number</label>
                  <input
                    type="text"
                    className="form-input"
                    value={newOrder.clientPurchaseOrderNumber}
                    onChange={(e) => setNewOrder({ ...newOrder, clientPurchaseOrderNumber: e.target.value })}
                  />
                </div>
                <div className="grid grid-2">
                  <div className="form-group">
                    <label className="form-label">Contact Name</label>
                    <input
                      type="text"
                      className="form-input"
                      value={newOrder.contactName}
                      onChange={(e) => setNewOrder({ ...newOrder, contactName: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Contact Phone</label>
                    <input
                      type="tel"
                      className="form-input"
                      value={newOrder.contactPhone}
                      onChange={(e) => setNewOrder({ ...newOrder, contactPhone: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-2">
                  <div className="form-group">
                    <label className="form-label">Requested Due Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={newOrder.requestedDueDate}
                      onChange={(e) => setNewOrder({ ...newOrder, requestedDueDate: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Promised Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={newOrder.promisedDate}
                      onChange={(e) => setNewOrder({ ...newOrder, promisedDate: e.target.value })}
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Notes</label>
                  <textarea
                    className="form-textarea"
                    value={newOrder.notes}
                    onChange={(e) => setNewOrder({ ...newOrder, notes: e.target.value })}
                    rows={3}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowNewModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Creating...' : 'Create Work Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkOrdersPage;
