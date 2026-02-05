import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Mail, Save, ArrowRight, DollarSign, Archive } from 'lucide-react';
import { getNotificationEmail, updateNotificationEmail, getSettings, updateSettings } from '../services/api';

function SettingsPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Tax and markup settings
  const [taxSettings, setTaxSettings] = useState({
    defaultTaxRate: 7.0,
    taxLabel: 'NC Sales Tax',
    materialMarkup: 20,
    otherServicesMarkup: 15,
    archiveAfterMonths: 1,
    keepArchivedYears: 2
  });

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const response = await getNotificationEmail();
      setEmail(response.data.data?.email || '');
      
      // Try to load tax settings
      try {
        const taxResponse = await getSettings('tax_settings');
        if (taxResponse.data.data?.value) {
          setTaxSettings(prev => ({ ...prev, ...taxResponse.data.data.value }));
        }
      } catch (e) {
        // Settings might not exist yet
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveEmail = async () => {
    try {
      setSaving(true);
      setError(null);
      await updateNotificationEmail(email);
      showSuccess('Email saved successfully');
    } catch (err) {
      setError('Failed to save email');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTaxSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      await updateSettings('tax_settings', taxSettings);
      showSuccess('Tax settings saved');
    } catch (err) {
      setError('Failed to save tax settings');
    } finally {
      setSaving(false);
    }
  };

  const showSuccess = (msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="grid grid-2">
        {/* Location Settings */}
        <div 
          className="card" 
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/settings/locations')}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ 
                width: 48, 
                height: 48, 
                borderRadius: 12, 
                background: '#e3f2fd',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <MapPin size={24} color="#1976d2" />
              </div>
              <div>
                <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Location Settings</h3>
                <p style={{ color: '#666', fontSize: '0.875rem' }}>Configure warehouse map locations</p>
              </div>
            </div>
            <ArrowRight size={20} color="#999" />
          </div>
        </div>

        {/* Email Settings */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
            <div style={{ 
              width: 48, 
              height: 48, 
              borderRadius: 12, 
              background: '#fff3e0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <Mail size={24} color="#e65100" />
            </div>
            <div>
              <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Email Notifications</h3>
              <p style={{ color: '#666', fontSize: '0.875rem' }}>Configure new shipment email alerts</p>
            </div>
          </div>
          
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">Notification Email</label>
            <input
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter email address"
              disabled={loading}
            />
          </div>
          <button 
            className="btn btn-primary btn-sm" 
            onClick={handleSaveEmail}
            disabled={saving}
          >
            <Save size={16} />
            {saving ? 'Saving...' : 'Save Email'}
          </button>
        </div>
      </div>

      {/* Tax Settings */}
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
          <div style={{ 
            width: 48, 
            height: 48, 
            borderRadius: 12, 
            background: '#e8f5e9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <DollarSign size={24} color="#388e3c" />
          </div>
          <div>
            <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Tax & Pricing Settings</h3>
            <p style={{ color: '#666', fontSize: '0.875rem' }}>Configure default tax rate and markups for estimates</p>
          </div>
        </div>
        
        <div className="grid grid-2">
          <div className="form-group">
            <label className="form-label">Default Tax Rate (%)</label>
            <input
              type="number"
              className="form-input"
              value={taxSettings.defaultTaxRate}
              onChange={(e) => setTaxSettings({ ...taxSettings, defaultTaxRate: parseFloat(e.target.value) || 0 })}
              step="0.1"
            />
            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: 4 }}>Applied to all new estimates</p>
          </div>
          <div className="form-group">
            <label className="form-label">Tax Label</label>
            <input
              type="text"
              className="form-input"
              value={taxSettings.taxLabel}
              onChange={(e) => setTaxSettings({ ...taxSettings, taxLabel: e.target.value })}
              placeholder="e.g., NC Sales Tax"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Default Material Markup (%)</label>
            <input
              type="number"
              className="form-input"
              value={taxSettings.materialMarkup}
              onChange={(e) => setTaxSettings({ ...taxSettings, materialMarkup: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Default Other Services Markup (%)</label>
            <input
              type="number"
              className="form-input"
              value={taxSettings.otherServicesMarkup}
              onChange={(e) => setTaxSettings({ ...taxSettings, otherServicesMarkup: parseFloat(e.target.value) || 0 })}
            />
          </div>
        </div>
        <button className="btn btn-primary" onClick={handleSaveTaxSettings} disabled={saving}>
          <Save size={16} />
          {saving ? 'Saving...' : 'Save Tax Settings'}
        </button>
      </div>

      {/* Archive Settings */}
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
          <div style={{ 
            width: 48, 
            height: 48, 
            borderRadius: 12, 
            background: '#f3e5f5',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <Archive size={24} color="#7b1fa2" />
          </div>
          <div>
            <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Archive Settings</h3>
            <p style={{ color: '#666', fontSize: '0.875rem' }}>Configure estimate archiving rules</p>
          </div>
        </div>
        
        <div className="grid grid-2">
          <div className="form-group">
            <label className="form-label">Auto-archive estimates after</label>
            <select
              className="form-select"
              value={taxSettings.archiveAfterMonths}
              onChange={(e) => setTaxSettings({ ...taxSettings, archiveAfterMonths: parseInt(e.target.value) })}
            >
              <option value={1}>1 month</option>
              <option value={2}>2 months</option>
              <option value={3}>3 months</option>
              <option value={0}>Never</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Keep archived estimates for</label>
            <select
              className="form-select"
              value={taxSettings.keepArchivedYears}
              onChange={(e) => setTaxSettings({ ...taxSettings, keepArchivedYears: parseInt(e.target.value) })}
            >
              <option value={1}>1 year</option>
              <option value={2}>2 years</option>
              <option value={5}>5 years</option>
              <option value={99}>Forever</option>
            </select>
          </div>
        </div>
        <button className="btn btn-primary" onClick={handleSaveTaxSettings} disabled={saving}>
          <Save size={16} />
          {saving ? 'Saving...' : 'Save Archive Settings'}
        </button>
      </div>

      {/* App Info */}
      <div className="card" style={{ marginTop: 24 }}>
        <h3 className="card-title" style={{ marginBottom: 16 }}>About</h3>
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item-label">Application</div>
            <div className="detail-item-value">Shipment Tracker Web</div>
          </div>
          <div className="detail-item">
            <div className="detail-item-label">Version</div>
            <div className="detail-item-value">1.0.0</div>
          </div>
          <div className="detail-item">
            <div className="detail-item-label">Company</div>
            <div className="detail-item-value">Carolina Rolling</div>
          </div>
          <div className="detail-item">
            <div className="detail-item-label">API</div>
            <div className="detail-item-value" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
              {process.env.REACT_APP_API_URL || 'https://carolina-rolling-inventory-api-641af96c90aa.herokuapp.com/api'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
