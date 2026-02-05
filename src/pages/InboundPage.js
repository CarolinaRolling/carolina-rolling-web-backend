import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Search, ChevronDown, ChevronRight, Package, FileText, User } from 'lucide-react';
import { getInboundOrders, createInboundOrder, deleteInboundOrder } from '../services/api';

function InboundPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [groupedOrders, setGroupedOrders] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSuppliers, setExpandedSuppliers] = useState({});
  const [newOrder, setNewOrder] = useState({
    supplierName: '',
    purchaseOrderNumber: '',
    description: '',
    clientName: '',
  });

  useEffect(() => {
    loadOrders();
  }, []);

  useEffect(() => {
    groupOrdersBySupplier();
  }, [orders, searchQuery]);

  const loadOrders = async () => {
    try {
      setLoading(true);
      const response = await getInboundOrders();
      setOrders(response.data.data || []);
    } catch (err) {
      setError('Failed to load inbound orders');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const groupOrdersBySupplier = () => {
    let filtered = [...orders];

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(o => 
        o.supplierName?.toLowerCase().includes(query) ||
        o.clientName?.toLowerCase().includes(query) ||
        o.purchaseOrderNumber?.toLowerCase().includes(query) ||
        o.description?.toLowerCase().includes(query)
      );
    }

    // Group by supplier
    const grouped = filtered.reduce((acc, order) => {
      const supplier = order.vendor?.name || order.supplierName || order.supplier || 'Unknown Supplier';
      if (!acc[supplier]) {
        acc[supplier] = [];
      }
      acc[supplier].push(order);
      return acc;
    }, {});

    // Sort suppliers alphabetically
    const sortedGrouped = Object.keys(grouped)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => {
        acc[key] = grouped[key];
        return acc;
      }, {});

    setGroupedOrders(sortedGrouped);

    // Auto-expand all suppliers on first load
    if (Object.keys(expandedSuppliers).length === 0) {
      const expanded = {};
      Object.keys(sortedGrouped).forEach(supplier => {
        expanded[supplier] = true;
      });
      setExpandedSuppliers(expanded);
    }
  };

  const toggleSupplier = (supplier) => {
    setExpandedSuppliers(prev => ({
      ...prev,
      [supplier]: !prev[supplier]
    }));
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newOrder.supplierName.trim() || !newOrder.clientName.trim() || 
        !newOrder.purchaseOrderNumber.trim() || !newOrder.description.trim()) {
      setError('All fields are required');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      await createInboundOrder(newOrder);
      await loadOrders();
      setShowNewModal(false);
      setNewOrder({
        supplierName: '',
        purchaseOrderNumber: '',
        description: '',
        clientName: '',
      });
    } catch (err) {
      setError('Failed to create order');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this inbound order?')) return;
    try {
      await deleteInboundOrder(id);
      await loadOrders();
    } catch (err) {
      setError('Failed to delete order');
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const totalOrders = Object.values(groupedOrders).reduce((sum, arr) => sum + arr.length, 0);
  const supplierCount = Object.keys(groupedOrders).length;

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Inbound Orders</h1>
          <p style={{ color: '#666', fontSize: '0.875rem', marginTop: 4 }}>
            {totalOrders} orders from {supplierCount} suppliers
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNewModal(true)}>
          <Plus size={18} />
          New Inbound Order
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Search */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="search-box" style={{ marginBottom: 0 }}>
          <Search size={18} className="search-box-icon" />
          <input
            type="text"
            placeholder="Search by supplier, client, PO number, or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {supplierCount === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📦</div>
          <div className="empty-state-title">No inbound orders</div>
          <p>{searchQuery ? 'No orders match your search' : 'Track expected deliveries by creating inbound orders'}</p>
        </div>
      ) : (
        <div>
          {Object.entries(groupedOrders).map(([supplier, supplierOrders]) => (
            <div key={supplier} className="card" style={{ marginBottom: 16 }}>
              {/* Supplier Header */}
              <div 
                onClick={() => toggleSupplier(supplier)}
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  padding: '4px 0'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {expandedSuppliers[supplier] ? (
                    <ChevronDown size={20} color="#666" />
                  ) : (
                    <ChevronRight size={20} color="#666" />
                  )}
                  <div style={{
                    width: 40,
                    height: 40,
                    borderRadius: 8,
                    background: '#e3f2fd',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    <Package size={20} color="#1976d2" />
                  </div>
                  <div>
                    <h3 style={{ fontWeight: 600, fontSize: '1.1rem' }}>{supplier}</h3>
                    <p style={{ color: '#666', fontSize: '0.8rem' }}>
                      {supplierOrders.length} order{supplierOrders.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
              </div>

              {/* Orders List */}
              {expandedSuppliers[supplier] && (
                <div style={{ marginTop: 16, marginLeft: 32 }}>
                  {supplierOrders.map((order, index) => (
                    <div 
                      key={order.id}
                      style={{
                        padding: 16,
                        background: '#f9f9f9',
                        borderRadius: 8,
                        marginBottom: index < supplierOrders.length - 1 ? 12 : 0,
                        cursor: 'pointer',
                        transition: 'background 0.2s'
                      }}
                      onClick={() => navigate(`/inbound/${order.id}`)}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#f0f0f0'}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#f9f9f9'}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                          {/* PO Number */}
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: 8,
                            marginBottom: 8
                          }}>
                            <FileText size={16} color="#1976d2" />
                            <span style={{ fontWeight: 600, color: '#1976d2' }}>
                              PO# {order.purchaseOrderNumber}
                            </span>
                          </div>

                          {/* Client */}
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: 8,
                            marginBottom: 8
                          }}>
                            <User size={16} color="#666" />
                            <span style={{ fontWeight: 500 }}>
                              For: {order.clientName}
                            </span>
                          </div>

                          {/* Description */}
                          <div style={{ 
                            color: '#555',
                            fontSize: '0.9rem',
                            lineHeight: 1.5
                          }}>
                            {order.description}
                          </div>

                          {/* Date */}
                          <div style={{ 
                            color: '#999',
                            fontSize: '0.8rem',
                            marginTop: 8
                          }}>
                            Added {formatDate(order.createdAt)}
                          </div>
                        </div>

                        <button 
                          className="btn btn-sm btn-danger"
                          onClick={(e) => handleDelete(order.id, e)}
                          style={{ marginLeft: 12 }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* New Order Modal */}
      {showNewModal && (
        <div className="modal-overlay" onClick={() => setShowNewModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">New Inbound Order</h3>
              <button className="modal-close" onClick={() => setShowNewModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label">Supplier Name *</label>
                <input
                  type="text"
                  className="form-input"
                  value={newOrder.supplierName}
                  onChange={(e) => setNewOrder({ ...newOrder, supplierName: e.target.value })}
                  placeholder="e.g., Acme Steel Supply"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Purchase Order Number *</label>
                <input
                  type="text"
                  className="form-input"
                  value={newOrder.purchaseOrderNumber}
                  onChange={(e) => setNewOrder({ ...newOrder, purchaseOrderNumber: e.target.value })}
                  placeholder="e.g., PO-2024-001"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Client Name (who it's for) *</label>
                <input
                  type="text"
                  className="form-input"
                  value={newOrder.clientName}
                  onChange={(e) => setNewOrder({ ...newOrder, clientName: e.target.value })}
                  placeholder="e.g., Smith Manufacturing"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Description *</label>
                <textarea
                  className="form-textarea"
                  value={newOrder.description}
                  onChange={(e) => setNewOrder({ ...newOrder, description: e.target.value })}
                  placeholder="e.g., 10x Steel plates 4x8, 5x Aluminum sheets"
                  required
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowNewModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Creating...' : 'Create Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default InboundPage;
