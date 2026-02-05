import React, { useState, useEffect } from 'react';
import { Mail, Clock, Save, Send, RefreshCw, CheckCircle } from 'lucide-react';
import { getDailyEmailSettings, updateDailyEmailSettings, sendDailyEmailNow, sendTestEmail, getEmailLogs } from '../services/api';

function EmailSettingsPage() {
  const [settings, setSettings] = useState({
    recipient: 'jason@carolinarolling.com',
    sendTimes: ['05:00', '14:30'],
    includeEstimates: true,
    includeWorkOrders: true,
    includeInbound: true,
    includeInventory: true,
    enabled: true
  });
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [settingsRes, logsRes] = await Promise.all([
        getDailyEmailSettings(),
        getEmailLogs()
      ]);
      if (settingsRes.data.data) {
        setSettings(settingsRes.data.data);
      }
      setLogs(logsRes.data.data || []);
    } catch (err) {
      console.error('Failed to load email settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      await updateDailyEmailSettings(settings);
      setSuccess('Settings saved successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSendNow = async () => {
    try {
      setSending(true);
      setError(null);
      const response = await sendDailyEmailNow();
      setSuccess(response.data.message || 'Daily email sent');
      loadData();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  const handleTestEmail = async () => {
    try {
      setSending(true);
      setError(null);
      const response = await sendTestEmail();
      setSuccess(response.data.message || 'Test email sent');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('Failed to send test email');
    } finally {
      setSending(false);
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
          <Mail size={28} style={{ marginRight: 8 }} />
          Daily Email Settings
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
          <CheckCircle size={18} style={{ marginRight: 8 }} />
          {success}
        </div>
      )}

      <div className="grid grid-2" style={{ gap: 20 }}>
        {/* Settings */}
        <div className="card">
          <h3 style={{ marginBottom: 16 }}>Email Configuration</h3>
          
          <div className="form-group">
            <label className="form-label">Recipient Email Address</label>
            <input
              type="email"
              className="form-input"
              value={settings.recipient}
              onChange={(e) => setSettings({ ...settings, recipient: e.target.value })}
              placeholder="jason@carolinarolling.com"
            />
          </div>

          <div className="form-group">
            <label className="form-label">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                style={{ marginRight: 8 }}
              />
              Enable Daily Summary Emails
            </label>
          </div>

          <div className="form-group">
            <label className="form-label">Send Times</label>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Clock size={16} />
                <input
                  type="checkbox"
                  checked={settings.sendTimes?.includes('05:00')}
                  onChange={(e) => {
                    const times = settings.sendTimes || [];
                    if (e.target.checked) {
                      setSettings({ ...settings, sendTimes: [...times, '05:00'] });
                    } else {
                      setSettings({ ...settings, sendTimes: times.filter(t => t !== '05:00') });
                    }
                  }}
                />
                5:00 AM
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Clock size={16} />
                <input
                  type="checkbox"
                  checked={settings.sendTimes?.includes('14:30')}
                  onChange={(e) => {
                    const times = settings.sendTimes || [];
                    if (e.target.checked) {
                      setSettings({ ...settings, sendTimes: [...times, '14:30'] });
                    } else {
                      setSettings({ ...settings, sendTimes: times.filter(t => t !== '14:30') });
                    }
                  }}
                />
                2:30 PM
              </label>
            </div>
          </div>

          <h4 style={{ marginTop: 24, marginBottom: 12 }}>Include in Daily Summary:</h4>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.includeEstimates}
                onChange={(e) => setSettings({ ...settings, includeEstimates: e.target.checked })}
              />
              💰 Estimate updates (created, status changes)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.includeWorkOrders}
                onChange={(e) => setSettings({ ...settings, includeWorkOrders: e.target.checked })}
              />
              📋 Work Order updates (created, part status, shipped)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.includeInbound}
                onChange={(e) => setSettings({ ...settings, includeInbound: e.target.checked })}
              />
              📥 Inbound shipments (created, received)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.includeInventory}
                onChange={(e) => setSettings({ ...settings, includeInventory: e.target.checked })}
              />
              📦 Inventory changes (new items, shipped)
            </label>
          </div>

          <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Save size={16} />
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
            <button className="btn btn-outline" onClick={handleTestEmail} disabled={sending}>
              <Send size={16} />
              Send Test
            </button>
          </div>
        </div>

        {/* Send Now & Preview */}
        <div>
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginBottom: 16 }}>Send Summary Now</h3>
            <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: 16 }}>
              Send the daily summary email immediately with all pending activities.
            </p>
            <button 
              className="btn btn-success" 
              onClick={handleSendNow} 
              disabled={sending}
              style={{ width: '100%' }}
            >
              <Send size={16} />
              {sending ? 'Sending...' : 'Send Daily Summary Now'}
            </button>
          </div>

          <div className="card">
            <h3 style={{ marginBottom: 16 }}>Email Preview</h3>
            <div style={{ 
              background: '#f9f9f9', 
              border: '1px solid #e0e0e0', 
              borderRadius: 8, 
              padding: 16,
              fontSize: '0.85rem',
              fontFamily: 'monospace'
            }}>
              <div style={{ borderBottom: '1px solid #ddd', paddingBottom: 12, marginBottom: 12 }}>
                <strong>To:</strong> {settings.recipient}<br/>
                <strong>Subject:</strong> Carolina Rolling Daily Update - {new Date().toLocaleDateString()}
              </div>
              <div>
                {settings.includeEstimates && <div>💰 ESTIMATES - Recent activity</div>}
                {settings.includeWorkOrders && <div>📋 WORK ORDERS - Recent activity</div>}
                {settings.includeInbound && <div>📥 INBOUND - Recent activity</div>}
                {settings.includeInventory && <div>📦 INVENTORY - Recent activity</div>}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Email Logs */}
      <div className="card" style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 16 }}>Recent Email Log</h3>
        
        {logs.length === 0 ? (
          <p style={{ color: '#666', fontStyle: 'italic' }}>No emails sent yet</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Sent At</th>
                <th>Type</th>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.slice(0, 10).map((log) => (
                <tr key={log.id}>
                  <td>{formatDate(log.sentAt)}</td>
                  <td>
                    <span style={{ 
                      background: log.emailType === 'daily_summary' ? '#e3f2fd' : '#f3e5f5',
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: '0.75rem'
                    }}>
                      {log.emailType}
                    </span>
                  </td>
                  <td>{log.recipient}</td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {log.subject}
                  </td>
                  <td>
                    <span style={{ 
                      color: log.status === 'sent' ? '#388e3c' : '#f57c00',
                      fontWeight: 500
                    }}>
                      {log.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default EmailSettingsPage;
