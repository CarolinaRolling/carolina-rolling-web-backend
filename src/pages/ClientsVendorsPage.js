import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Edit, Trash2, Users, Building2, Search, Check, X } from 'lucide-react';
import { getClients, createClient, updateClient, deleteClient, getVendors, createVendor, updateVendor, deleteVendor } from '../services/api';

const ClientsVendorsPage = () => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('clients');
  const [clients, setClients] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  
  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, [showInactive]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [clientsRes, vendorsRes] = await Promise.all([
        getClients({ active: showInactive ? undefined : 'true' }),
        getVendors({ active: showInactive ? undefined : 'true' })
      ]);
      setClients(clientsRes.data.data || []);
      setVendors(vendorsRes.data.data || []);
    } catch (err) {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const showMessage = (msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(''), 3000);
  };

  // Client functions
  const openClientModal = (client = null) => {
    setEditing(client);
    setFormData(client ? { ...client } : {
      name: '',
      contactName: '',
      contactPhone: '',
      contactEmail: '',
      address: '',
      taxStatus: 'taxable',
      resaleCertificate: '',
      customTaxRate: '',
      notes: ''
    });
    setShowModal(true);
  };

  const handleSaveClient = async () => {
    if (!formData.name?.trim()) {
      setError('Client name is required');
      return;
    }
    try {
      setSaving(true);
      if (editing) {
        await updateClient(editing.id, formData);
        showMessage('Client updated');
      } else {
        await createClient(formData);
        showMessage('Client created');
      }
      setShowModal(false);
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to save client');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClient = async (client) => {
    if (!window.confirm(`Deactivate client "${client.name}"?`)) return;
    try {
      await deleteClient(client.id);
      showMessage('Client deactivated');
      loadData();
    } catch (err) {
      setError('Failed to deactivate client');
    }
  };

  const handleReactivateClient = async (client) => {
    try {
      await updateClient(client.id, { isActive: true });
      showMessage('Client reactivated');
      loadData();
    } catch (err) {
      setError('Failed to reactivate client');
    }
  };

  // Vendor functions
  const openVendorModal = (vendor = null) => {
    setEditing(vendor);
    setFormData(vendor ? { ...vendor } : {
      name: '',
      contactName: '',
      contactPhone: '',
      contactEmail: '',
      address: '',
      accountNumber: '',
      notes: ''
    });
    setShowModal(true);
  };

  const handleSaveVendor = async () => {
    if (!formData.name?.trim()) {
      setError('Vendor name is required');
      return;
    }
    try {
      setSaving(true);
      if (editing) {
        await updateVendor(editing.id, formData);
        showMessage('Vendor updated');
      } else {
        await createVendor(formData);
        showMessage('Vendor created');
      }
      setShowModal(false);
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to save vendor');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteVendor = async (vendor) => {
    if (!window.confirm(`Deactivate vendor "${vendor.name}"?`)) return;
    try {
      await deleteVendor(vendor.id);
      showMessage('Vendor deactivated');
      loadData();
    } catch (err) {
      setError('Failed to deactivate vendor');
    }
  };

  const handleReactivateVendor = async (vendor) => {
    try {
      await updateVendor(vendor.id, { isActive: true });
      showMessage('Vendor reactivated');
      loadData();
    } catch (err) {
      setError('Failed to reactivate vendor');
    }
  };

  // Filter data
  const filteredClients = clients.filter(c => 
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.contactName?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredVendors = vendors.filter(v => 
    v.name.toLowerCase().includes(search.toLowerCase()) ||
    v.contactName?.toLowerCase().includes(search.toLowerCase())
  );

  const getTaxStatusBadge = (status) => {
    const styles = {
      taxable: { bg: '#e3f2fd', color: '#1565c0', label: 'Taxable' },
      resale: { bg: '#fff3e0', color: '#e65100', label: 'Resale' },
      exempt: { bg: '#e8f5e9', color: '#2e7d32', label: 'Tax Exempt' }
    };
    const s = styles[status] || styles.taxable;
    return (
      <span style={{ background: s.bg, color: s.color, padding: '2px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 500 }}>
        {s.label}
      </span>
    );
  };

  if (loading) return <div className="loading"><div className="spinner"></div></div>;

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button className="btn btn-secondary" onClick={() => navigate('/admin')} style={{ borderRadius: '50%', padding: 8 }}>
            <ArrowLeft size={20} />
          </button>
          <h1 className="page-title">Clients & Vendors</h1>
        </div>
      </div>

      {error && <div className="alert alert-error" onClick={() => setError('')}>{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`btn ${activeTab === 'clients' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setActiveTab('clients')}
        >
          <Users size={18} /> Clients ({clients.length})
        </button>
        <button
          className={`btn ${activeTab === 'vendors' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setActiveTab('vendors')}
        >
          <Building2 size={18} /> Vendors ({vendors.length})
        </button>
      </div>

      {/* Search and Actions */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#666' }} />
              <input
                className="form-input"
                placeholder={`Search ${activeTab}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ paddingLeft: 40 }}
              />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show Inactive
          </label>
          <button
            className="btn btn-primary"
            onClick={() => activeTab === 'clients' ? openClientModal() : openVendorModal()}
          >
            <Plus size={18} /> Add {activeTab === 'clients' ? 'Client' : 'Vendor'}
          </button>
        </div>
      </div>

      {/* Clients Tab */}
      {activeTab === 'clients' && (
        <div className="card">
          {filteredClients.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
              <Users size={48} style={{ opacity: 0.3 }} />
              <p style={{ marginTop: 12 }}>No clients found</p>
              <button className="btn btn-primary" onClick={() => openClientModal()} style={{ marginTop: 8 }}>
                <Plus size={18} /> Add First Client
              </button>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Client Name</th>
                  <th>Contact</th>
                  <th>Tax Status</th>
                  <th>Custom Rate</th>
                  <th>Status</th>
                  <th style={{ width: 100 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredClients.map(client => (
                  <tr key={client.id} style={{ opacity: client.isActive ? 1 : 0.5 }}>
                    <td>
                      <strong>{client.name}</strong>
                      {client.address && <div style={{ fontSize: '0.8rem', color: '#666' }}>{client.address}</div>}
                    </td>
                    <td>
                      {client.contactName && <div>{client.contactName}</div>}
                      {client.contactPhone && <div style={{ fontSize: '0.85rem', color: '#666' }}>{client.contactPhone}</div>}
                      {client.contactEmail && <div style={{ fontSize: '0.85rem', color: '#666' }}>{client.contactEmail}</div>}
                    </td>
                    <td>{getTaxStatusBadge(client.taxStatus)}</td>
                    <td>
                      {client.customTaxRate ? (
                        <span style={{ fontWeight: 500 }}>{(parseFloat(client.customTaxRate) * 100).toFixed(2)}%</span>
                      ) : (
                        <span style={{ color: '#999' }}>Default</span>
                      )}
                    </td>
                    <td>
                      {client.isActive ? (
                        <span style={{ color: '#2e7d32' }}>✓ Active</span>
                      ) : (
                        <span style={{ color: '#d32f2f' }}>Inactive</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm btn-outline" onClick={() => openClientModal(client)}><Edit size={14} /></button>
                        {client.isActive ? (
                          <button className="btn btn-sm btn-danger" onClick={() => handleDeleteClient(client)}><X size={14} /></button>
                        ) : (
                          <button className="btn btn-sm btn-success" onClick={() => handleReactivateClient(client)}><Check size={14} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Vendors Tab */}
      {activeTab === 'vendors' && (
        <div className="card">
          {filteredVendors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
              <Building2 size={48} style={{ opacity: 0.3 }} />
              <p style={{ marginTop: 12 }}>No vendors found</p>
              <button className="btn btn-primary" onClick={() => openVendorModal()} style={{ marginTop: 8 }}>
                <Plus size={18} /> Add First Vendor
              </button>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Vendor Name</th>
                  <th>Contact</th>
                  <th>Account #</th>
                  <th>Status</th>
                  <th style={{ width: 100 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredVendors.map(vendor => (
                  <tr key={vendor.id} style={{ opacity: vendor.isActive ? 1 : 0.5 }}>
                    <td>
                      <strong>{vendor.name}</strong>
                      {vendor.address && <div style={{ fontSize: '0.8rem', color: '#666' }}>{vendor.address}</div>}
                    </td>
                    <td>
                      {vendor.contactName && <div>{vendor.contactName}</div>}
                      {vendor.contactPhone && <div style={{ fontSize: '0.85rem', color: '#666' }}>{vendor.contactPhone}</div>}
                      {vendor.contactEmail && <div style={{ fontSize: '0.85rem', color: '#666' }}>{vendor.contactEmail}</div>}
                    </td>
                    <td>{vendor.accountNumber || <span style={{ color: '#999' }}>—</span>}</td>
                    <td>
                      {vendor.isActive ? (
                        <span style={{ color: '#2e7d32' }}>✓ Active</span>
                      ) : (
                        <span style={{ color: '#d32f2f' }}>Inactive</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm btn-outline" onClick={() => openVendorModal(vendor)}><Edit size={14} /></button>
                        {vendor.isActive ? (
                          <button className="btn btn-sm btn-danger" onClick={() => handleDeleteVendor(vendor)}><X size={14} /></button>
                        ) : (
                          <button className="btn btn-sm btn-success" onClick={() => handleReactivateVendor(vendor)}><Check size={14} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Client Modal */}
      {showModal && activeTab === 'clients' && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3>{editing ? 'Edit Client' : 'Add Client'}</h3>
              <button className="btn btn-icon" onClick={() => setShowModal(false)}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Client Name *</label>
                <input className="form-input" value={formData.name || ''} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Company or person name" />
              </div>
              <div className="form-group">
                <label className="form-label">Contact Name</label>
                <input className="form-input" value={formData.contactName || ''} onChange={(e) => setFormData({ ...formData, contactName: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input className="form-input" value={formData.contactPhone || ''} onChange={(e) => setFormData({ ...formData, contactPhone: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Email</label>
                <input className="form-input" type="email" value={formData.contactEmail || ''} onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Address</label>
                <textarea className="form-textarea" value={formData.address || ''} onChange={(e) => setFormData({ ...formData, address: e.target.value })} rows={2} />
              </div>
              
              <div style={{ gridColumn: 'span 2', borderTop: '1px solid #e0e0e0', paddingTop: 12, marginTop: 8 }}>
                <h4 style={{ marginBottom: 12, color: '#1976d2' }}>💰 Tax Settings</h4>
              </div>
              
              <div className="form-group">
                <label className="form-label">Tax Status</label>
                <select className="form-select" value={formData.taxStatus || 'taxable'} onChange={(e) => setFormData({ ...formData, taxStatus: e.target.value })}>
                  <option value="taxable">Taxable</option>
                  <option value="resale">Resale (Tax Exempt)</option>
                  <option value="exempt">Tax Exempt (Other)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Custom Tax Rate (%)</label>
                <input 
                  type="number" 
                  step="0.01" 
                  className="form-input" 
                  value={formData.customTaxRate ? (parseFloat(formData.customTaxRate) * 100).toFixed(2) : ''} 
                  onChange={(e) => setFormData({ ...formData, customTaxRate: e.target.value ? parseFloat(e.target.value) / 100 : '' })} 
                  placeholder="Leave blank for default (9.75%)"
                />
              </div>
              {formData.taxStatus === 'resale' && (
                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                  <label className="form-label">Resale Certificate #</label>
                  <input className="form-input" value={formData.resaleCertificate || ''} onChange={(e) => setFormData({ ...formData, resaleCertificate: e.target.value })} />
                </div>
              )}
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Notes</label>
                <textarea className="form-textarea" value={formData.notes || ''} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} rows={2} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveClient} disabled={saving}>
                {saving ? 'Saving...' : (editing ? 'Update Client' : 'Add Client')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vendor Modal */}
      {showModal && activeTab === 'vendors' && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3>{editing ? 'Edit Vendor' : 'Add Vendor'}</h3>
              <button className="btn btn-icon" onClick={() => setShowModal(false)}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Vendor Name *</label>
                <input className="form-input" value={formData.name || ''} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Company name" />
              </div>
              <div className="form-group">
                <label className="form-label">Contact Name</label>
                <input className="form-input" value={formData.contactName || ''} onChange={(e) => setFormData({ ...formData, contactName: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input className="form-input" value={formData.contactPhone || ''} onChange={(e) => setFormData({ ...formData, contactPhone: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Email</label>
                <input className="form-input" type="email" value={formData.contactEmail || ''} onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Address</label>
                <textarea className="form-textarea" value={formData.address || ''} onChange={(e) => setFormData({ ...formData, address: e.target.value })} rows={2} />
              </div>
              <div className="form-group">
                <label className="form-label">Account Number</label>
                <input className="form-input" value={formData.accountNumber || ''} onChange={(e) => setFormData({ ...formData, accountNumber: e.target.value })} placeholder="Your account # with vendor" />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Notes</label>
                <textarea className="form-textarea" value={formData.notes || ''} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} rows={2} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveVendor} disabled={saving}>
                {saving ? 'Saving...' : (editing ? 'Update Vendor' : 'Add Vendor')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ClientsVendorsPage;
