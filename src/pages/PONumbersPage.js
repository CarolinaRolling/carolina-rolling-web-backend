import React, { useState, useEffect } from 'react';
import { ShoppingCart, AlertTriangle, Trash2, RefreshCw, Save } from 'lucide-react';
import { getPONumberStats, setNextPONumber, voidPONumber, getVoidedPONumbers } from '../services/api';

function PONumbersPage() {
  const [stats, setStats] = useState({ lastUsed: 7764, nextNumber: 7765, voidedCount: 0, activeCount: 0 });
  const [voidedNumbers, setVoidedNumbers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  
  const [newNextNumber, setNewNextNumber] = useState('');
  const [voidNumber, setVoidNumber] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [statsRes, voidedRes] = await Promise.all([
        getPONumberStats(),
        getVoidedPONumbers()
      ]);
      setStats(statsRes.data.data);
      setNewNextNumber(statsRes.data.data.nextNumber.toString());
      setVoidedNumbers(voidedRes.data.data || []);
    } catch (err) {
      setError('Failed to load PO number data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateNextNumber = async () => {
    const num = parseInt(newNextNumber);
    if (!num || num < 1) {
      setError('Please enter a valid number');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      await setNextPONumber(num);
      setSuccess(`Next PO number set to ${num}`);
      loadData();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleVoidNumber = async () => {
    const num = parseInt(voidNumber);
    if (!num || num < 1) {
      setError('Please enter a valid PO number');
      return;
    }
    if (!voidReason.trim()) {
      setError('Please enter a reason for voiding');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      await voidPONumber(num, voidReason, 'admin');
      setSuccess(`PO${num} has been voided`);
      setVoidNumber('');
      setVoidReason('');
      setShowVoidConfirm(false);
      loadData();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to void PO number');
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

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
        <h1 className="page-title">
          <ShoppingCart size={28} style={{ marginRight: 8 }} />
          PO Number Management
        </h1>
        <button className="btn btn-outline" onClick={loadData}>
          <RefreshCw size={18} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          {error}
          <button 
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setError(null)}
          >×</button>
        </div>
      )}

      {success && (
        <div className="alert alert-success" style={{ marginBottom: 16 }}>
          {success}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#1976d2' }}>
            {stats.lastUsed || '—'}
          </div>
          <div style={{ fontSize: '0.85rem', color: '#666' }}>Last Used PO#</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#388e3c' }}>
            {stats.nextNumber}
          </div>
          <div style={{ fontSize: '0.85rem', color: '#666' }}>Next Available PO#</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#1976d2' }}>
            {stats.activeCount}
          </div>
          <div style={{ fontSize: '0.85rem', color: '#666' }}>Active PO Numbers</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#c62828' }}>
            {stats.voidedCount}
          </div>
          <div style={{ fontSize: '0.85rem', color: '#666' }}>Voided Numbers</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ gap: 20 }}>
        {/* Set Next PO Number */}
        <div className="card">
          <h3 style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShoppingCart size={20} />
            Set Next PO Number
          </h3>
          <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: 16 }}>
            Use this to continue from your existing purchase orders. 
            Enter the number you want to use for the next material order.
          </p>
          
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label className="form-label">Next PO Number</label>
              <input
                type="number"
                className="form-input"
                value={newNextNumber}
                onChange={(e) => setNewNextNumber(e.target.value)}
                min="1"
                style={{ maxWidth: 200 }}
              />
            </div>
            <button 
              className="btn btn-primary"
              onClick={handleUpdateNextNumber}
              disabled={saving}
            >
              <Save size={16} />
              {saving ? 'Saving...' : 'Update'}
            </button>
          </div>
          
          <div style={{ 
            marginTop: 16, 
            padding: 12, 
            background: '#e3f2fd', 
            borderRadius: 6,
            fontSize: '0.85rem'
          }}>
            💡 <strong>Tip:</strong> If your last purchase order was PO7764, 
            set this to 7765 to continue the sequence.
          </div>
        </div>

        {/* Void a PO Number */}
        <div className="card">
          <h3 style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, color: '#c62828' }}>
            <AlertTriangle size={20} />
            Void a PO Number
          </h3>
          <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: 16 }}>
            Voiding marks the PO number as canceled. Use for orders that were never placed 
            or were canceled before delivery.
          </p>
          
          <div className="form-group">
            <label className="form-label">PO Number to Void (numbers only)</label>
            <input
              type="number"
              className="form-input"
              value={voidNumber}
              onChange={(e) => setVoidNumber(e.target.value)}
              placeholder="e.g., 7764"
              min="1"
              style={{ maxWidth: 200 }}
            />
          </div>
          
          <div className="form-group">
            <label className="form-label">Reason (required)</label>
            <input
              type="text"
              className="form-input"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g., Order canceled, duplicate entry"
            />
          </div>
          
          {!showVoidConfirm ? (
            <button 
              className="btn btn-danger"
              onClick={() => setShowVoidConfirm(true)}
              disabled={!voidNumber || !voidReason.trim()}
            >
              <Trash2 size={16} />
              Void PO{voidNumber || '____'}
            </button>
          ) : (
            <div style={{ 
              background: '#ffebee', 
              border: '1px solid #ef5350', 
              borderRadius: 8, 
              padding: 16 
            }}>
              <p style={{ fontWeight: 600, color: '#c62828', marginBottom: 12 }}>
                ⚠️ Are you sure you want to void PO{voidNumber}?
              </p>
              <p style={{ fontSize: '0.85rem', marginBottom: 12 }}>
                This will mark the PO number as voided and remove it from any linked inbound orders.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button 
                  className="btn btn-danger"
                  onClick={handleVoidNumber}
                  disabled={saving}
                >
                  {saving ? 'Voiding...' : 'Yes, Void It'}
                </button>
                <button 
                  className="btn btn-secondary"
                  onClick={() => setShowVoidConfirm(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Voided Numbers History */}
      <div className="card" style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 16 }}>Voided PO Numbers History</h3>
        
        {voidedNumbers.length === 0 ? (
          <p style={{ color: '#666', fontStyle: 'italic' }}>No voided numbers</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Supplier</th>
                <th>Client</th>
                <th>Voided By</th>
                <th>Voided Date</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {voidedNumbers.map((po) => (
                <tr key={po.id} style={{ opacity: 0.7 }}>
                  <td>
                    <span style={{ textDecoration: 'line-through', color: '#c62828' }}>
                      PO{po.poNumber}
                    </span>
                  </td>
                  <td>{po.supplier || '—'}</td>
                  <td>{po.clientName || '—'}</td>
                  <td>{po.voidedBy || 'admin'}</td>
                  <td>{formatDate(po.voidedAt)}</td>
                  <td>{po.voidReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default PONumbersPage;
