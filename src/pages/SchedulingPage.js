import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Calendar, Clock, Search, ChevronDown, ChevronUp, 
  AlertTriangle, CheckCircle, ArrowUpDown, Filter
} from 'lucide-react';
import { getShipments } from '../services/api';

function SchedulingPage() {
  const navigate = useNavigate();
  const [shipments, setShipments] = useState([]);
  const [filteredShipments, setFilteredShipments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedRows, setExpandedRows] = useState({});
  
  // Load saved preferences from localStorage
  const [sortBy, setSortBy] = useState(() => {
    return localStorage.getItem('scheduling_sortBy') || 'promised_asc';
  });
  const [statusFilter, setStatusFilter] = useState(() => {
    return localStorage.getItem('scheduling_statusFilter') || 'all';
  });

  // Save preferences to localStorage when they change
  useEffect(() => {
    localStorage.setItem('scheduling_sortBy', sortBy);
  }, [sortBy]);

  useEffect(() => {
    localStorage.setItem('scheduling_statusFilter', statusFilter);
  }, [statusFilter]);

  useEffect(() => {
    loadShipments();
  }, []);

  useEffect(() => {
    filterAndSortShipments();
  }, [shipments, searchQuery, sortBy, statusFilter]);

  const loadShipments = async () => {
    try {
      setLoading(true);
      const response = await getShipments();
      // Filter out shipped items
      const activeShipments = (response.data.data || []).filter(s => s.status !== 'shipped');
      setShipments(activeShipments);
    } catch (err) {
      setError('Failed to load shipments');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const filterAndSortShipments = () => {
    let filtered = [...shipments];

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(s =>
        s.clientName?.toLowerCase().includes(query) ||
        s.clientPurchaseOrderNumber?.toLowerCase().includes(query) ||
        s.jobNumber?.toLowerCase().includes(query) ||
        s.description?.toLowerCase().includes(query)
      );
    }

    // Filter by status
    if (statusFilter !== 'all') {
      filtered = filtered.filter(s => s.status === statusFilter);
    }

    // Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'name_asc':
          return (a.clientName || '').localeCompare(b.clientName || '');
        case 'name_desc':
          return (b.clientName || '').localeCompare(a.clientName || '');
        case 'received_asc':
          return new Date(a.receivedAt || 0) - new Date(b.receivedAt || 0);
        case 'received_desc':
          return new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0);
        case 'promised_asc':
          if (!a.promisedDate && !b.promisedDate) return 0;
          if (!a.promisedDate) return 1;
          if (!b.promisedDate) return -1;
          return new Date(a.promisedDate) - new Date(b.promisedDate);
        case 'promised_desc':
          if (!a.promisedDate && !b.promisedDate) return 0;
          if (!a.promisedDate) return 1;
          if (!b.promisedDate) return -1;
          return new Date(b.promisedDate) - new Date(a.promisedDate);
        case 'requested_asc':
          if (!a.requestedDueDate && !b.requestedDueDate) return 0;
          if (!a.requestedDueDate) return 1;
          if (!b.requestedDueDate) return -1;
          return new Date(a.requestedDueDate) - new Date(b.requestedDueDate);
        case 'requested_desc':
          if (!a.requestedDueDate && !b.requestedDueDate) return 0;
          if (!a.requestedDueDate) return 1;
          if (!b.requestedDueDate) return -1;
          return new Date(b.requestedDueDate) - new Date(a.requestedDueDate);
        default:
          return 0;
      }
    });

    setFilteredShipments(filtered);
  };

  const formatDate = (dateString) => {
    if (!dateString) return '—';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getDaysUntil = (dateString) => {
    if (!dateString) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(dateString);
    target.setHours(0, 0, 0, 0);
    const diff = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
    return diff;
  };

  const getDateStatus = (dateString) => {
    const days = getDaysUntil(dateString);
    if (days === null) return 'none';
    if (days < 0) return 'overdue';
    if (days === 0) return 'today';
    if (days <= 3) return 'urgent';
    if (days <= 7) return 'soon';
    return 'normal';
  };

  const getDateBadgeStyle = (status) => {
    switch (status) {
      case 'overdue':
        return { background: '#ffebee', color: '#c62828', border: '1px solid #ef9a9a' };
      case 'today':
        return { background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80' };
      case 'urgent':
        return { background: '#fff8e1', color: '#f57f17', border: '1px solid #ffe082' };
      case 'soon':
        return { background: '#e3f2fd', color: '#1565c0', border: '1px solid #90caf9' };
      default:
        return { background: '#f5f5f5', color: '#666', border: '1px solid #e0e0e0' };
    }
  };

  const getStatusStyle = (status) => {
    switch (status) {
      case 'received':
        return { background: '#e3f2fd', color: '#1565c0' };
      case 'in_progress':
        return { background: '#fff3e0', color: '#e65100' };
      case 'completed':
        return { background: '#e8f5e9', color: '#2e7d32' };
      default:
        return { background: '#f5f5f5', color: '#666' };
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'received': return 'Received';
      case 'in_progress': return 'In Progress';
      case 'completed': return 'Completed';
      default: return status;
    }
  };

  const toggleRow = (id) => {
    setExpandedRows(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Stats - check both promisedDate and requestedDueDate
  const overdueCount = shipments.filter(s => 
    getDateStatus(s.promisedDate) === 'overdue' || 
    getDateStatus(s.requestedDueDate) === 'overdue'
  ).length;
  const todayCount = shipments.filter(s => 
    getDateStatus(s.promisedDate) === 'today' || 
    getDateStatus(s.requestedDueDate) === 'today'
  ).length;
  const urgentCount = shipments.filter(s => 
    getDateStatus(s.promisedDate) === 'urgent' || 
    getDateStatus(s.requestedDueDate) === 'urgent'
  ).length;

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
          <h1 className="page-title">Scheduling</h1>
          <p style={{ color: '#666', fontSize: '0.875rem', marginTop: 4 }}>
            {filteredShipments.length} active jobs
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Stats Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16, marginBottom: 20 }}>
        <div style={{ 
          background: overdueCount > 0 ? '#ffebee' : '#f5f5f5', 
          padding: 16, 
          borderRadius: 8,
          borderLeft: `4px solid ${overdueCount > 0 ? '#c62828' : '#ccc'}`
        }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: overdueCount > 0 ? '#c62828' : '#666' }}>
            {overdueCount}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Overdue</div>
        </div>
        <div style={{ 
          background: todayCount > 0 ? '#fff3e0' : '#f5f5f5', 
          padding: 16, 
          borderRadius: 8,
          borderLeft: `4px solid ${todayCount > 0 ? '#e65100' : '#ccc'}`
        }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: todayCount > 0 ? '#e65100' : '#666' }}>
            {todayCount}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Due Today</div>
        </div>
        <div style={{ 
          background: urgentCount > 0 ? '#fff8e1' : '#f5f5f5', 
          padding: 16, 
          borderRadius: 8,
          borderLeft: `4px solid ${urgentCount > 0 ? '#f57f17' : '#ccc'}`
        }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: urgentCount > 0 ? '#f57f17' : '#666' }}>
            {urgentCount}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Due in 3 Days</div>
        </div>
        <div style={{ 
          background: '#f5f5f5', 
          padding: 16, 
          borderRadius: 8,
          borderLeft: '4px solid #1976d2'
        }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#1976d2' }}>
            {filteredShipments.length}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Total Active</div>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="search-box" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
            <Search size={18} className="search-box-icon" />
            <input
              type="text"
              placeholder="Search by name, PO#, job number..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <select
            className="form-select"
            style={{ width: 'auto' }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="received">Received</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
          </select>
          <select
            className="form-select"
            style={{ width: 'auto' }}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <optgroup label="By Name">
              <option value="name_asc">Name A-Z</option>
              <option value="name_desc">Name Z-A</option>
            </optgroup>
            <optgroup label="By Date Received">
              <option value="received_asc">Oldest First</option>
              <option value="received_desc">Newest First</option>
            </optgroup>
            <optgroup label="By Promised Date">
              <option value="promised_asc">Promised (Soonest)</option>
              <option value="promised_desc">Promised (Latest)</option>
            </optgroup>
            <optgroup label="By Requested Date">
              <option value="requested_asc">Requested (Soonest)</option>
              <option value="requested_desc">Requested (Latest)</option>
            </optgroup>
          </select>
        </div>
      </div>

      {/* Schedule Board */}
      {filteredShipments.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📅</div>
          <div className="empty-state-title">No jobs to schedule</div>
          <p>{searchQuery || statusFilter !== 'all' ? 'No jobs match your filters' : 'All jobs have been shipped!'}</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Table Header */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 120px',
            background: '#f5f5f5',
            padding: '12px 16px',
            fontWeight: 600,
            fontSize: '0.75rem',
            textTransform: 'uppercase',
            color: '#666',
            borderBottom: '2px solid #e0e0e0'
          }}>
            <div>Client / Job</div>
            <div>PO Number</div>
            <div>Received</div>
            <div>Requested</div>
            <div>Promised</div>
            <div>Status</div>
          </div>

          {/* Table Body */}
          {filteredShipments.map((shipment, index) => {
            const promisedStatus = getDateStatus(shipment.promisedDate);
            const requestedStatus = getDateStatus(shipment.requestedDueDate);
            const isExpanded = expandedRows[shipment.id];

            return (
              <div key={shipment.id}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 120px',
                    padding: '16px',
                    borderBottom: '1px solid #eee',
                    cursor: 'pointer',
                    background: index % 2 === 0 ? 'white' : '#fafafa',
                    transition: 'background 0.2s',
                    alignItems: 'center'
                  }}
                  onClick={() => navigate(`/shipment/${shipment.id}`)}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#f0f7ff'}
                  onMouseLeave={(e) => e.currentTarget.style.background = index % 2 === 0 ? 'white' : '#fafafa'}
                >
                  {/* Client / Job */}
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{shipment.clientName}</div>
                    {shipment.jobNumber && (
                      <div style={{ fontSize: '0.8rem', color: '#666' }}>
                        Job: {shipment.jobNumber}
                      </div>
                    )}
                    {shipment.description && (
                      <div style={{ 
                        fontSize: '0.8rem', 
                        color: '#999',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: 250
                      }}>
                        {shipment.description}
                      </div>
                    )}
                  </div>

                  {/* PO Number */}
                  <div style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>
                    {shipment.clientPurchaseOrderNumber || '—'}
                  </div>

                  {/* Received Date */}
                  <div style={{ fontSize: '0.9rem', color: '#666' }}>
                    {formatDate(shipment.receivedAt)}
                  </div>

                  {/* Requested Date */}
                  <div>
                    {shipment.requestedDueDate ? (
                      <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 8px',
                        borderRadius: 4,
                        fontSize: '0.85rem',
                        ...getDateBadgeStyle(requestedStatus)
                      }}>
                        {requestedStatus === 'overdue' && <AlertTriangle size={14} />}
                        {formatDate(shipment.requestedDueDate)}
                      </div>
                    ) : (
                      <span style={{ color: '#ccc' }}>—</span>
                    )}
                  </div>

                  {/* Promised Date */}
                  <div>
                    {shipment.promisedDate ? (
                      <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 8px',
                        borderRadius: 4,
                        fontSize: '0.85rem',
                        fontWeight: 500,
                        ...getDateBadgeStyle(promisedStatus)
                      }}>
                        {promisedStatus === 'overdue' && <AlertTriangle size={14} />}
                        {promisedStatus === 'today' && <Clock size={14} />}
                        {formatDate(shipment.promisedDate)}
                        {getDaysUntil(shipment.promisedDate) !== null && (
                          <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                            ({getDaysUntil(shipment.promisedDate) === 0 
                              ? 'Today' 
                              : getDaysUntil(shipment.promisedDate) < 0 
                                ? `${Math.abs(getDaysUntil(shipment.promisedDate))}d late`
                                : `${getDaysUntil(shipment.promisedDate)}d`})
                          </span>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: '#ccc' }}>—</span>
                    )}
                  </div>

                  {/* Status */}
                  <div>
                    <span style={{
                      display: 'inline-block',
                      padding: '4px 10px',
                      borderRadius: 12,
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      ...getStatusStyle(shipment.status)
                    }}>
                      {getStatusLabel(shipment.status)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default SchedulingPage;
