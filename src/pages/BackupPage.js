import React, { useState, useEffect, useRef } from 'react';
import { Download, Upload, Database, Settings, FileText, Package, ClipboardList, DollarSign, AlertTriangle } from 'lucide-react';
import { getBackupInfo, downloadBackup, restoreBackup } from '../services/api';

function BackupPage() {
  const [backupInfo, setBackupInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const fileInputRef = useRef(null);

  const [backupOptions, setBackupOptions] = useState({
    includeShipments: true,
    includeWorkOrders: true,
    includeEstimates: true,
    includeInbound: true,
    includeSettings: true,
  });

  const [restoreOptions, setRestoreOptions] = useState({
    clearExisting: false,
  });

  const [uploadedBackup, setUploadedBackup] = useState(null);

  useEffect(() => {
    loadBackupInfo();
  }, []);

  const loadBackupInfo = async () => {
    try {
      setLoading(true);
      const response = await getBackupInfo();
      setBackupInfo(response.data.data);
    } catch (err) {
      setError('Failed to load backup info');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadBackup = async () => {
    try {
      setDownloading(true);
      setError(null);

      const response = await downloadBackup(backupOptions);
      
      // Create blob from response
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      setSuccess('Backup downloaded successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('Failed to download backup');
    } finally {
      setDownloading(false);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        if (!backup.data || !backup.version) {
          setError('Invalid backup file format');
          return;
        }
        setUploadedBackup(backup);
        setError(null);
      } catch (err) {
        setError('Failed to parse backup file');
      }
    };
    reader.readAsText(file);
  };

  const handleRestore = async () => {
    if (!uploadedBackup) return;
    if (!window.confirm('Are you sure you want to restore from this backup? This action cannot be undone.')) return;

    try {
      setRestoring(true);
      setError(null);

      await restoreBackup({
        backup: uploadedBackup,
        options: {
          restoreShipments: true,
          restoreWorkOrders: true,
          restoreEstimates: true,
          restoreInbound: true,
          restoreSettings: true,
          clearExisting: restoreOptions.clearExisting,
        }
      });

      setSuccess('Backup restored successfully');
      setUploadedBackup(null);
      await loadBackupInfo();
    } catch (err) {
      setError('Failed to restore backup');
    } finally {
      setRestoring(false);
    }
  };

  if (loading) {
    return <div className="loading"><div className="spinner"></div></div>;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">
          <Database size={28} style={{ marginRight: 12 }} />
          Backup & Restore
        </h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="grid grid-2">
        {/* Create Backup */}
        <div className="card" style={{ border: '2px dashed #1976d2', background: '#f0f7ff' }}>
          <h3 className="card-title" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Download size={20} />
            Create Backup
          </h3>
          <p style={{ color: '#666', marginBottom: 16 }}>
            Download a complete backup of all your data including shipments, work orders, estimates, settings, and files.
          </p>

          <div style={{ marginBottom: 16 }}>
            <label className="form-label">Select data to include:</label>

            <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, cursor: 'pointer', borderBottom: '1px solid #e0e0e0', background: backupOptions.includeShipments ? '#e3f2fd' : 'white' }}>
                <input type="checkbox" checked={backupOptions.includeShipments}
                  onChange={(e) => setBackupOptions({ ...backupOptions, includeShipments: e.target.checked })} />
                <Package size={18} />
                <div>
                  <strong>Shipments & Inventory</strong>
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>{backupInfo?.shipments || 0} records</div>
                </div>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, cursor: 'pointer', borderBottom: '1px solid #e0e0e0', background: backupOptions.includeWorkOrders ? '#e3f2fd' : 'white' }}>
                <input type="checkbox" checked={backupOptions.includeWorkOrders}
                  onChange={(e) => setBackupOptions({ ...backupOptions, includeWorkOrders: e.target.checked })} />
                <ClipboardList size={18} />
                <div>
                  <strong>Work Orders</strong>
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>{backupInfo?.workOrders || 0} records</div>
                </div>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, cursor: 'pointer', borderBottom: '1px solid #e0e0e0', background: backupOptions.includeEstimates ? '#e3f2fd' : 'white' }}>
                <input type="checkbox" checked={backupOptions.includeEstimates}
                  onChange={(e) => setBackupOptions({ ...backupOptions, includeEstimates: e.target.checked })} />
                <DollarSign size={18} />
                <div>
                  <strong>Estimates</strong>
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>{backupInfo?.estimates || 0} records</div>
                </div>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, cursor: 'pointer', borderBottom: '1px solid #e0e0e0', background: backupOptions.includeInbound ? '#e3f2fd' : 'white' }}>
                <input type="checkbox" checked={backupOptions.includeInbound}
                  onChange={(e) => setBackupOptions({ ...backupOptions, includeInbound: e.target.checked })} />
                <FileText size={18} />
                <div>
                  <strong>Inbound Orders</strong>
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>{backupInfo?.inboundOrders || 0} records</div>
                </div>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, cursor: 'pointer', background: backupOptions.includeSettings ? '#e3f2fd' : 'white' }}>
                <input type="checkbox" checked={backupOptions.includeSettings}
                  onChange={(e) => setBackupOptions({ ...backupOptions, includeSettings: e.target.checked })} />
                <Settings size={18} />
                <div>
                  <strong>Settings & Users</strong>
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>{backupInfo?.settings || 0} settings, {backupInfo?.users || 0} users</div>
                </div>
              </label>
            </div>
          </div>

          <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleDownloadBackup} disabled={downloading}>
            <Download size={18} />
            {downloading ? 'Preparing Download...' : 'Download Full Backup'}
          </button>
          <p style={{ fontSize: '0.8rem', color: '#666', marginTop: 8, textAlign: 'center' }}>
            Backup file will be saved as: backup-{new Date().toISOString().split('T')[0]}.json
          </p>
        </div>

        {/* Restore Backup */}
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Upload size={20} />
            Restore from Backup
          </h3>
          <p style={{ color: '#666', marginBottom: 16 }}>
            Upload a previously downloaded backup file to restore your data.
          </p>

          <input type="file" accept=".json" style={{ display: 'none' }} ref={fileInputRef} onChange={handleFileSelect} />

          {!uploadedBackup ? (
            <div
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: '2px dashed #ddd',
                borderRadius: 12,
                padding: 40,
                textAlign: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseOver={(e) => { e.currentTarget.style.borderColor = '#1976d2'; e.currentTarget.style.background = '#f0f7ff'; }}
              onMouseOut={(e) => { e.currentTarget.style.borderColor = '#ddd'; e.currentTarget.style.background = 'white'; }}
            >
              <div style={{ fontSize: '2rem', marginBottom: 12 }}>📁</div>
              <p><strong>Click to select backup file</strong></p>
              <p style={{ fontSize: '0.8rem', color: '#666' }}>or drag and drop here</p>
            </div>
          ) : (
            <div style={{ background: '#e8f5e9', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong>Backup File Loaded</strong>
                <button className="btn btn-sm btn-secondary" onClick={() => setUploadedBackup(null)}>Remove</button>
              </div>
              <div style={{ fontSize: '0.9rem' }}>
                <div><strong>Created:</strong> {new Date(uploadedBackup.createdAt).toLocaleString()}</div>
                <div><strong>Version:</strong> {uploadedBackup.version}</div>
                {uploadedBackup.counts && (
                  <div style={{ marginTop: 8 }}>
                    <strong>Contains:</strong>
                    <ul style={{ margin: '4px 0 0 20px', fontSize: '0.85rem' }}>
                      {uploadedBackup.counts.shipments > 0 && <li>{uploadedBackup.counts.shipments} shipments</li>}
                      {uploadedBackup.counts.workOrders > 0 && <li>{uploadedBackup.counts.workOrders} work orders</li>}
                      {uploadedBackup.counts.estimates > 0 && <li>{uploadedBackup.counts.estimates} estimates</li>}
                      {uploadedBackup.counts.inboundOrders > 0 && <li>{uploadedBackup.counts.inboundOrders} inbound orders</li>}
                      {uploadedBackup.counts.settings > 0 && <li>{uploadedBackup.counts.settings} settings</li>}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="alert" style={{ background: '#ffebee', border: '1px solid #ef9a9a', display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 16 }}>
            <AlertTriangle size={20} style={{ color: '#c62828', flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong style={{ color: '#c62828' }}>Warning</strong>
              <div style={{ fontSize: '0.85rem', color: '#666' }}>
                Restoring from a backup will add data to your system. Enable "Clear existing data" to replace all current data.
              </div>
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={restoreOptions.clearExisting}
              onChange={(e) => setRestoreOptions({ ...restoreOptions, clearExisting: e.target.checked })} />
            <span style={{ fontSize: '0.9rem' }}>Clear existing data before restore</span>
          </label>

          <button className="btn btn-warning" style={{ width: '100%', marginTop: 16 }} onClick={handleRestore}
            disabled={!uploadedBackup || restoring}>
            <Upload size={18} />
            {restoring ? 'Restoring...' : 'Restore Backup'}
          </button>
        </div>
      </div>

      {/* Data Summary */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="card-title" style={{ marginBottom: 16 }}>Current Data Summary</h3>
        <div className="grid grid-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <div style={{ textAlign: 'center', padding: 16, background: '#f5f5f5', borderRadius: 8 }}>
            <Package size={32} color="#1976d2" />
            <div style={{ fontSize: '2rem', fontWeight: 600, marginTop: 8 }}>{backupInfo?.shipments || 0}</div>
            <div style={{ color: '#666' }}>Shipments</div>
          </div>
          <div style={{ textAlign: 'center', padding: 16, background: '#f5f5f5', borderRadius: 8 }}>
            <ClipboardList size={32} color="#388e3c" />
            <div style={{ fontSize: '2rem', fontWeight: 600, marginTop: 8 }}>{backupInfo?.workOrders || 0}</div>
            <div style={{ color: '#666' }}>Work Orders</div>
          </div>
          <div style={{ textAlign: 'center', padding: 16, background: '#f5f5f5', borderRadius: 8 }}>
            <DollarSign size={32} color="#f57c00" />
            <div style={{ fontSize: '2rem', fontWeight: 600, marginTop: 8 }}>{backupInfo?.estimates || 0}</div>
            <div style={{ color: '#666' }}>Estimates</div>
          </div>
          <div style={{ textAlign: 'center', padding: 16, background: '#f5f5f5', borderRadius: 8 }}>
            <FileText size={32} color="#7b1fa2" />
            <div style={{ fontSize: '2rem', fontWeight: 600, marginTop: 8 }}>{backupInfo?.inboundOrders || 0}</div>
            <div style={{ color: '#666' }}>Inbound Orders</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BackupPage;
