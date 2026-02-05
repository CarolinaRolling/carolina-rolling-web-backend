import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Users, Activity, Plus, Trash2, Edit, Save, X, 
  Shield, User, Clock, ChevronLeft, ChevronRight, Key, Check, AlertTriangle, RefreshCw,
  Mail, Send, DollarSign
} from 'lucide-react';
import { getUsers, createUser, updateUser, deleteUser, getActivityLogs, getScheduleEmailSettings, updateScheduleEmailSettings, sendScheduleEmailNow, getSettings, updateSettings } from '../services/api';
import { useAuth } from '../context/AuthContext';

// Global error log for NAS uploads
window.nasErrorLog = window.nasErrorLog || [];

export const logNasError = (error, details = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    error: error.message || error,
    details: details,
    type: 'NAS_UPLOAD_ERROR'
  };
  window.nasErrorLog.unshift(entry);
  // Keep only last 50 errors
  if (window.nasErrorLog.length > 50) {
    window.nasErrorLog = window.nasErrorLog.slice(0, 50);
  }
  console.error('NAS Error logged:', entry);
};

function AdminPage() {
  const navigate = useNavigate();
  const { user: currentUser, isAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [systemLogs, setSystemLogs] = useState([]);
  
  // New user modal
  const [showNewUserModal, setShowNewUserModal] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' });
  const [saving, setSaving] = useState(false);
  
  // Edit user modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editData, setEditData] = useState({ username: '', role: 'user' });
  
  // Reset password modal
  const [showResetPasswordModal, setShowResetPasswordModal] = useState(false);
  const [resetPasswordUser, setResetPasswordUser] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  
  // Schedule email settings
  const [scheduleEmail, setScheduleEmail] = useState('carolinarolling@gmail.com');
  const [scheduleEmailEnabled, setScheduleEmailEnabled] = useState(true);
  const [scheduleEmailSaving, setScheduleEmailSaving] = useState(false);
  const [scheduleEmailSending, setScheduleEmailSending] = useState(false);
  
  // Tax settings
  const [taxSettings, setTaxSettings] = useState({
    defaultTaxRate: 9.75,
    defaultLaborRate: 125,
    defaultMaterialMarkup: 20
  });
  const [taxSettingsSaving, setTaxSettingsSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin()) {
      navigate('/inventory');
      return;
    }
    
    if (activeTab === 'users') {
      loadUsers();
    } else if (activeTab === 'activity') {
      loadLogs();
    } else if (activeTab === 'schedule') {
      loadScheduleEmailSettings();
    } else if (activeTab === 'tax') {
      loadTaxSettings();
    } else if (activeTab === 'system') {
      setSystemLogs([...window.nasErrorLog]);
      setLoading(false);
    }
  }, [activeTab, logsPage]);

  const loadTaxSettings = async () => {
    try {
      setLoading(true);
      const response = await getSettings('tax_settings');
      if (response.data.data?.value) {
        setTaxSettings(response.data.data.value);
      }
    } catch (err) {
      // Settings may not exist yet, use defaults
      console.log('Using default tax settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveTaxSettings = async () => {
    try {
      setTaxSettingsSaving(true);
      setError(null);
      await updateSettings('tax_settings', taxSettings);
      setSuccess('Tax settings saved successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('Failed to save tax settings');
    } finally {
      setTaxSettingsSaving(false);
    }
  };

  const loadScheduleEmailSettings = async () => {
    try {
      setLoading(true);
      const response = await getScheduleEmailSettings();
      const data = response.data.data;
      setScheduleEmail(data.email || 'carolinarolling@gmail.com');
      setScheduleEmailEnabled(data.enabled !== false);
    } catch (err) {
      console.error('Failed to load schedule email settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveScheduleEmail = async () => {
    try {
      setScheduleEmailSaving(true);
      setError(null);
      await updateScheduleEmailSettings(scheduleEmail, scheduleEmailEnabled);
      setSuccess('Schedule email settings saved successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to save settings');
    } finally {
      setScheduleEmailSaving(false);
    }
  };

  const handleSendTestEmail = async () => {
    try {
      setScheduleEmailSending(true);
      setError(null);
      const response = await sendScheduleEmailNow();
      if (response.data.success) {
        setSuccess(response.data.message || 'Schedule email sent successfully');
      } else {
        setError(response.data.message || 'Failed to send email');
      }
      setTimeout(() => setSuccess(null), 5000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to send email. Make sure SMTP is configured.');
    } finally {
      setScheduleEmailSending(false);
    }
  };

  const refreshSystemLogs = () => {
    setSystemLogs([...window.nasErrorLog]);
  };

  const clearSystemLogs = () => {
    window.nasErrorLog = [];
    setSystemLogs([]);
  };

  const loadUsers = async () => {
    try {
      setLoading(true);
      const response = await getUsers();
      setUsers(response.data.data || []);
    } catch (err) {
      setError('Failed to load users');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadLogs = async () => {
    try {
      setLoading(true);
      const response = await getActivityLogs(50, logsPage * 50);
      setLogs(response.data.data || []);
      setLogsTotal(response.data.total || 0);
    } catch (err) {
      setError('Failed to load activity logs');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    if (!newUser.username || !newUser.password) {
      setError('Username and password are required');
      return;
    }

    try {
      setSaving(true);
      await createUser(newUser);
      await loadUsers();
      setShowNewUserModal(false);
      setNewUser({ username: '', password: '', role: 'user' });
      setSuccess('User created successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  const openEditModal = (user) => {
    setEditingUser(user);
    setEditData({ username: user.username, role: user.role });
    setShowEditModal(true);
    setError(null);
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    if (!editData.username) {
      setError('Username is required');
      return;
    }

    try {
      setSaving(true);
      await updateUser(editingUser.id, editData);
      await loadUsers();
      setShowEditModal(false);
      setEditingUser(null);
      setSuccess('User updated successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update user');
    } finally {
      setSaving(false);
    }
  };

  const openResetPasswordModal = (user) => {
    setResetPasswordUser(user);
    setNewPassword('');
    setConfirmPassword('');
    setShowResetPasswordModal(true);
    setError(null);
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!newPassword) {
      setError('Password is required');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    try {
      setSaving(true);
      await updateUser(resetPasswordUser.id, { password: newPassword });
      await loadUsers();
      setShowResetPasswordModal(false);
      setResetPasswordUser(null);
      setNewPassword('');
      setConfirmPassword('');
      setSuccess(`Password reset for ${resetPasswordUser.username}`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to reset password');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (!window.confirm('Are you sure you want to delete this user?')) return;
    
    try {
      await deleteUser(userId);
      await loadUsers();
      setSuccess('User deleted successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete user');
    }
  };

  const handleToggleActive = async (user) => {
    try {
      await updateUser(user.id, { isActive: !user.isActive });
      await loadUsers();
      setSuccess(`User ${user.isActive ? 'disabled' : 'enabled'} successfully`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('Failed to update user');
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  const getActionColor = (action) => {
    if (action.includes('LOGIN_SUCCESS')) return '#2e7d32';
    if (action.includes('LOGIN_FAILED')) return '#d32f2f';
    if (action.includes('CREATED')) return '#1976d2';
    if (action.includes('DELETED')) return '#d32f2f';
    if (action.includes('UPDATED')) return '#e65100';
    return '#666';
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Admin Panel</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* Quick Links */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>Quick Links</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={() => navigate('/admin/clients-vendors')}>
            👥 Clients & Vendors
          </button>
          <button className="btn btn-outline" onClick={() => navigate('/admin/dr-numbers')}>
            📋 DR Numbers
          </button>
          <button className="btn btn-outline" onClick={() => navigate('/admin/po-numbers')}>
            🔢 PO Numbers
          </button>
          <button className="btn btn-outline" onClick={() => navigate('/admin/email')}>
            📧 Email Settings
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button 
          className={`tab ${activeTab === 'users' ? 'active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          <Users size={16} style={{ marginRight: 6 }} />
          Users
        </button>
        <button 
          className={`tab ${activeTab === 'tax' ? 'active' : ''}`}
          onClick={() => setActiveTab('tax')}
        >
          <DollarSign size={16} style={{ marginRight: 6 }} />
          Tax & Rates
        </button>
        <button 
          className={`tab ${activeTab === 'schedule' ? 'active' : ''}`}
          onClick={() => setActiveTab('schedule')}
        >
          <Clock size={16} style={{ marginRight: 6 }} />
          Schedule Email
        </button>
        <button 
          className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          <Activity size={16} style={{ marginRight: 6 }} />
          Activity Logs
        </button>
        <button 
          className={`tab ${activeTab === 'system' ? 'active' : ''}`}
          onClick={() => setActiveTab('system')}
        >
          <AlertTriangle size={16} style={{ marginRight: 6 }} />
          System Logs
          {window.nasErrorLog?.length > 0 && (
            <span style={{ 
              marginLeft: 6, 
              background: '#e53935', 
              color: 'white', 
              borderRadius: 10, 
              padding: '2px 8px',
              fontSize: '0.75rem'
            }}>
              {window.nasErrorLog.length}
            </span>
          )}
        </button>
      </div>

      {loading ? (
        <div className="loading">
          <div className="spinner"></div>
        </div>
      ) : activeTab === 'tax' ? (
        <div>
          <div className="card">
            <h3 style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <DollarSign size={20} />
              Default Tax & Rate Settings
            </h3>
            <p style={{ color: '#666', marginBottom: 20 }}>
              These defaults will be used for new estimates and work orders. Individual clients can have custom rates set in the Clients & Vendors section.
            </p>
            
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 20 }}>
              <div className="form-group">
                <label className="form-label">Default Tax Rate (%)</label>
                <input 
                  type="number" 
                  step="0.01" 
                  className="form-input" 
                  value={taxSettings.defaultTaxRate || ''} 
                  onChange={(e) => setTaxSettings({ ...taxSettings, defaultTaxRate: parseFloat(e.target.value) || 0 })}
                  placeholder="9.75"
                />
                <small style={{ color: '#666', marginTop: 4, display: 'block' }}>
                  Standard sales tax rate (e.g., 9.75 for 9.75%)
                </small>
              </div>
              
              <div className="form-group">
                <label className="form-label">Default Labor Rate ($/hour)</label>
                <input 
                  type="number" 
                  step="0.01" 
                  className="form-input" 
                  value={taxSettings.defaultLaborRate || ''} 
                  onChange={(e) => setTaxSettings({ ...taxSettings, defaultLaborRate: parseFloat(e.target.value) || 0 })}
                  placeholder="125.00"
                />
                <small style={{ color: '#666', marginTop: 4, display: 'block' }}>
                  Default hourly rate for labor on estimates
                </small>
              </div>
              
              <div className="form-group">
                <label className="form-label">Default Material Markup (%)</label>
                <input 
                  type="number" 
                  step="0.01" 
                  className="form-input" 
                  value={taxSettings.defaultMaterialMarkup || ''} 
                  onChange={(e) => setTaxSettings({ ...taxSettings, defaultMaterialMarkup: parseFloat(e.target.value) || 0 })}
                  placeholder="20"
                />
                <small style={{ color: '#666', marginTop: 4, display: 'block' }}>
                  Default markup percentage on materials
                </small>
              </div>
            </div>
            
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #e0e0e0' }}>
              <button 
                className="btn btn-primary" 
                onClick={handleSaveTaxSettings}
                disabled={taxSettingsSaving}
              >
                <Save size={16} style={{ marginRight: 6 }} />
                {taxSettingsSaving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
          
          <div className="card" style={{ marginTop: 16 }}>
            <h4 style={{ marginBottom: 12 }}>📋 Tax Status Reference</h4>
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ padding: 12, background: '#e3f2fd', borderRadius: 8 }}>
                <strong style={{ color: '#1565c0' }}>Taxable</strong>
                <p style={{ margin: '4px 0 0', fontSize: '0.9rem', color: '#666' }}>
                  Standard customers who pay sales tax at the default rate (or custom rate if set)
                </p>
              </div>
              <div style={{ padding: 12, background: '#fff3e0', borderRadius: 8 }}>
                <strong style={{ color: '#e65100' }}>Resale</strong>
                <p style={{ margin: '4px 0 0', fontSize: '0.9rem', color: '#666' }}>
                  Customers with a valid resale certificate - no tax charged (they collect from end customer)
                </p>
              </div>
              <div style={{ padding: 12, background: '#e8f5e9', borderRadius: 8 }}>
                <strong style={{ color: '#2e7d32' }}>Tax Exempt</strong>
                <p style={{ margin: '4px 0 0', fontSize: '0.9rem', color: '#666' }}>
                  Government, non-profit, or other exempt organizations - no tax charged
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === 'schedule' ? (
        <div>
          <div className="card">
            <h3 style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Mail size={20} />
              Daily Schedule Email
            </h3>
            <p style={{ color: '#666', marginBottom: 20 }}>
              Receive a daily email at 6:00 AM Pacific Time with a summary of upcoming and overdue shipments.
            </p>
            
            <div className="form-group">
              <label className="form-label">Email Address</label>
              <input
                type="email"
                className="form-input"
                value={scheduleEmail}
                onChange={(e) => setScheduleEmail(e.target.value)}
                placeholder="Enter email address"
              />
            </div>
            
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={scheduleEmailEnabled}
                  onChange={(e) => setScheduleEmailEnabled(e.target.checked)}
                  style={{ width: 18, height: 18 }}
                />
                <span>Enable daily schedule email</span>
              </label>
              <small style={{ color: '#666', display: 'block', marginTop: 4 }}>
                When enabled, an email will be sent every day at 6:00 AM Pacific Time
              </small>
            </div>
            
            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
              <button 
                className="btn btn-primary" 
                onClick={handleSaveScheduleEmail}
                disabled={scheduleEmailSaving}
              >
                {scheduleEmailSaving ? 'Saving...' : 'Save Settings'}
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={handleSendTestEmail}
                disabled={scheduleEmailSending}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Send size={16} />
                {scheduleEmailSending ? 'Sending...' : 'Send Test Email Now'}
              </button>
            </div>
            
            <div style={{ 
              marginTop: 24, 
              padding: 16, 
              background: '#f5f5f5', 
              borderRadius: 8,
              fontSize: '0.9rem'
            }}>
              <strong style={{ display: 'block', marginBottom: 8 }}>Email Contents:</strong>
              <ul style={{ margin: 0, paddingLeft: 20, color: '#666' }}>
                <li>Overdue shipments (promised date passed)</li>
                <li>Upcoming shipments due within 7 days (promised date)</li>
                <li>Overdue shipments (requested date passed)</li>
                <li>Upcoming shipments due within 7 days (requested date)</li>
              </ul>
              <p style={{ margin: '12px 0 0 0', color: '#666' }}>
                Each entry includes: Client Name, Client PO#, Date Received, Promised Date, Requested Date
              </p>
            </div>
          </div>
        </div>
      ) : activeTab === 'users' ? (
        <div>
          <div style={{ marginBottom: 16 }}>
            <button className="btn btn-primary" onClick={() => setShowNewUserModal(true)}>
              <Plus size={18} />
              Add User
            </button>
          </div>

          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {user.role === 'admin' ? (
                          <Shield size={16} color="#1976d2" />
                        ) : (
                          <User size={16} color="#666" />
                        )}
                        <span style={{ fontWeight: 500 }}>{user.username}</span>
                        {user.id === currentUser?.id && (
                          <span style={{ 
                            fontSize: '0.7rem', 
                            background: '#e3f2fd', 
                            color: '#1976d2',
                            padding: '2px 6px',
                            borderRadius: 4
                          }}>
                            You
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${user.role === 'admin' ? 'status-shipped' : 'status-received'}`}>
                        {user.role}
                      </span>
                    </td>
                    <td>
                      <button
                        className={`btn btn-sm ${user.isActive ? 'btn-success' : 'btn-secondary'}`}
                        onClick={() => handleToggleActive(user)}
                        disabled={user.id === currentUser?.id}
                      >
                        {user.isActive ? 'Active' : 'Disabled'}
                      </button>
                    </td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          className="btn btn-sm btn-outline"
                          onClick={() => openEditModal(user)}
                          title="Edit user"
                        >
                          <Edit size={14} />
                        </button>
                        <button
                          className="btn btn-sm btn-warning"
                          onClick={() => openResetPasswordModal(user)}
                          title="Reset password"
                          style={{ background: '#ff9800', borderColor: '#ff9800' }}
                        >
                          <Key size={14} />
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => handleDeleteUser(user.id)}
                          disabled={user.id === currentUser?.id}
                          title="Delete user"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div>
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Details</th>
                  <th>IP Address</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Clock size={14} color="#999" />
                        {formatDate(log.createdAt)}
                      </div>
                    </td>
                    <td style={{ fontWeight: 500 }}>{log.username || '—'}</td>
                    <td>
                      <span style={{ 
                        color: getActionColor(log.action),
                        fontWeight: 500
                      }}>
                        {log.action}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.85rem', color: '#666' }}>
                      {log.resourceType && `${log.resourceType}`}
                      {log.details && (
                        <span style={{ marginLeft: 8 }}>
                          {JSON.stringify(log.details)}
                        </span>
                      )}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {log.ipAddress || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center',
              marginTop: 16,
              paddingTop: 16,
              borderTop: '1px solid #eee'
            }}>
              <div style={{ color: '#666', fontSize: '0.875rem' }}>
                Showing {logsPage * 50 + 1} - {Math.min((logsPage + 1) * 50, logsTotal)} of {logsTotal}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => setLogsPage(p => p - 1)}
                  disabled={logsPage === 0}
                >
                  <ChevronLeft size={16} />
                  Previous
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => setLogsPage(p => p + 1)}
                  disabled={(logsPage + 1) * 50 >= logsTotal}
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* System Logs Tab Content */}
      {activeTab === 'system' && !loading && (
        <div>
          <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" onClick={refreshSystemLogs}>
              <RefreshCw size={18} />
              Refresh
            </button>
            <button className="btn btn-danger" onClick={clearSystemLogs} disabled={systemLogs.length === 0}>
              <Trash2 size={18} />
              Clear Logs
            </button>
          </div>

          <div className="card">
            {systemLogs.length === 0 ? (
              <div className="empty-state" style={{ padding: 40 }}>
                <div className="empty-state-icon">✅</div>
                <div className="empty-state-title">No Errors</div>
                <p>No system errors have been logged.</p>
              </div>
            ) : (
              <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                {systemLogs.map((log, index) => (
                  <div 
                    key={index} 
                    style={{ 
                      padding: 16, 
                      borderBottom: '1px solid #eee',
                      background: index % 2 === 0 ? '#fff' : '#fafafa'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ 
                        background: '#ffebee', 
                        color: '#c62828', 
                        padding: '2px 8px', 
                        borderRadius: 4,
                        fontSize: '0.75rem',
                        fontWeight: 500
                      }}>
                        {log.type}
                      </span>
                      <span style={{ color: '#666', fontSize: '0.8rem' }}>
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ 
                      fontWeight: 500, 
                      color: '#c62828',
                      marginBottom: 8
                    }}>
                      {log.error}
                    </div>
                    {log.details && Object.keys(log.details).length > 0 && (
                      <pre style={{ 
                        background: '#f5f5f5', 
                        padding: 12, 
                        borderRadius: 4,
                        fontSize: '0.8rem',
                        overflow: 'auto',
                        margin: 0
                      }}>
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* New User Modal */}
      {showNewUserModal && (
        <div className="modal-overlay" onClick={() => setShowNewUserModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add New User</h3>
              <button className="modal-close" onClick={() => setShowNewUserModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleCreateUser}>
              <div className="form-group">
                <label className="form-label">Username *</label>
                <input
                  type="text"
                  className="form-input"
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Password *</label>
                <input
                  type="password"
                  className="form-input"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Role</label>
                <select
                  className="form-select"
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowNewUserModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Creating...' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {showEditModal && editingUser && (
        <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Edit User</h3>
              <button className="modal-close" onClick={() => setShowEditModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleUpdateUser}>
              <div className="form-group">
                <label className="form-label">Username *</label>
                <input
                  type="text"
                  className="form-input"
                  value={editData.username}
                  onChange={(e) => setEditData({ ...editData, username: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Role</label>
                <select
                  className="form-select"
                  value={editData.role}
                  onChange={(e) => setEditData({ ...editData, role: e.target.value })}
                  disabled={editingUser.id === currentUser?.id}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                {editingUser.id === currentUser?.id && (
                  <small style={{ color: '#666', marginTop: 4, display: 'block' }}>
                    You cannot change your own role
                  </small>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowEditModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {showResetPasswordModal && resetPasswordUser && (
        <div className="modal-overlay" onClick={() => setShowResetPasswordModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Reset Password</h3>
              <button className="modal-close" onClick={() => setShowResetPasswordModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleResetPassword}>
              <div style={{ 
                background: '#fff3e0', 
                padding: 12, 
                borderRadius: 8, 
                marginBottom: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 8
              }}>
                <Key size={18} color="#e65100" />
                <span>
                  Resetting password for <strong>{resetPasswordUser.username}</strong>
                </span>
              </div>
              <div className="form-group">
                <label className="form-label">New Password *</label>
                <input
                  type="password"
                  className="form-input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password (min 6 characters)"
                  required
                  minLength={6}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Confirm Password *</label>
                <input
                  type="password"
                  className="form-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  required
                />
                {confirmPassword && newPassword !== confirmPassword && (
                  <small style={{ color: '#d32f2f', marginTop: 4, display: 'block' }}>
                    Passwords do not match
                  </small>
                )}
                {confirmPassword && newPassword === confirmPassword && (
                  <small style={{ color: '#2e7d32', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Check size={14} /> Passwords match
                  </small>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowResetPasswordModal(false)}>
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="btn btn-primary" 
                  disabled={saving || newPassword !== confirmPassword || newPassword.length < 6}
                >
                  {saving ? 'Resetting...' : 'Reset Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminPage;
