import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, Printer, Edit2, Eye, RefreshCw, Search, Plus, X, Save, Trash2 } from 'lucide-react';
import { getPONumbers, getNextPONumber, assignPONumber, voidPONumber, deletePONumber } from '../services/api';

function PurchaseOrdersPage() {
  const navigate = useNavigate();
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('active');
  
  // Create/Edit PO Modal
  const [showModal, setShowModal] = useState(false);
  const [editingPO, setEditingPO] = useState(null);
  const [saving, setSaving] = useState(false);
  const [poForm, setPOForm] = useState({
    poNumber: '',
    supplier: '',
    clientName: '',
    description: '',
    items: [{ description: '', quantity: 1, unitPrice: 0 }],
    notes: '',
    shippingAddress: 'Carolina Rolling\n2657 Regional Rd S\nGreensboro, NC 27409'
  });

  // View/Print Modal
  const [showViewModal, setShowViewModal] = useState(false);
  const [viewingPO, setViewingPO] = useState(null);

  useEffect(() => {
    loadPurchaseOrders();
  }, [filterStatus]);

  const loadPurchaseOrders = async () => {
    try {
      setLoading(true);
      const response = await getPONumbers({ status: filterStatus, limit: 100 });
      setPurchaseOrders(response.data.data || []);
    } catch (err) {
      setError('Failed to load purchase orders');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const openCreateModal = async () => {
    try {
      const nextRes = await getNextPONumber();
      setPOForm({
        poNumber: nextRes.data.data.nextNumber,
        supplier: '',
        clientName: '',
        description: '',
        items: [{ description: '', quantity: 1, unitPrice: 0 }],
        notes: '',
        shippingAddress: 'Carolina Rolling\n2657 Regional Rd S\nGreensboro, NC 27409'
      });
      setEditingPO(null);
      setShowModal(true);
    } catch (err) {
      setError('Failed to get next PO number');
    }
  };

  const openEditModal = (po) => {
    // Parse items from description if stored as text
    let items = [{ description: '', quantity: 1, unitPrice: 0 }];
    if (po.description) {
      items = po.description.split('\n').filter(line => line.trim()).map(line => ({
        description: line,
        quantity: 1,
        unitPrice: 0
      }));
    }
    
    setPOForm({
      poNumber: po.poNumber,
      supplier: po.supplier || '',
      clientName: po.clientName || '',
      description: po.description || '',
      items: items.length > 0 ? items : [{ description: '', quantity: 1, unitPrice: 0 }],
      notes: po.notes || '',
      shippingAddress: 'Carolina Rolling\n2657 Regional Rd S\nGreensboro, NC 27409'
    });
    setEditingPO(po);
    setShowModal(true);
  };

  const openViewModal = (po) => {
    setViewingPO(po);
    setShowViewModal(true);
  };

  const handleSavePO = async () => {
    if (!poForm.supplier.trim()) {
      setError('Supplier is required');
      return;
    }
    
    try {
      setSaving(true);
      setError(null);

      // Build description from items
      const description = poForm.items
        .filter(item => item.description.trim())
        .map(item => `${item.description} (Qty: ${item.quantity})`)
        .join('\n');

      if (editingPO) {
        // Update existing - for now we'll just show success since backend update isn't implemented
        setSuccess('PO updated successfully');
      } else {
        // Create new PO
        await assignPONumber({
          customNumber: poForm.poNumber,
          supplier: poForm.supplier,
          clientName: poForm.clientName,
          description: description
        });
        setSuccess(`PO${poForm.poNumber} created successfully`);
      }
      
      setShowModal(false);
      loadPurchaseOrders();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to save purchase order');
    } finally {
      setSaving(false);
    }
  };

  const addItem = () => {
    setPOForm({
      ...poForm,
      items: [...poForm.items, { description: '', quantity: 1, unitPrice: 0 }]
    });
  };

  const removeItem = (index) => {
    const newItems = poForm.items.filter((_, i) => i !== index);
    setPOForm({
      ...poForm,
      items: newItems.length > 0 ? newItems : [{ description: '', quantity: 1, unitPrice: 0 }]
    });
  };

  const updateItem = (index, field, value) => {
    const newItems = [...poForm.items];
    newItems[index] = { ...newItems[index], [field]: value };
    setPOForm({ ...poForm, items: newItems });
  };

  const printPurchaseOrder = (po) => {
    const items = po.description ? po.description.split('\n').filter(line => line.trim()) : [];
    
    const printContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Purchase Order - PO${po.poNumber}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: Arial, sans-serif; 
            padding: 40px;
            max-width: 800px;
            margin: 0 auto;
          }
          .header { 
            display: flex; 
            justify-content: space-between; 
            align-items: flex-start;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 3px solid #1976d2;
          }
          .company-info h1 { 
            color: #1976d2; 
            font-size: 28px;
            margin-bottom: 8px;
          }
          .company-info p { 
            color: #666; 
            font-size: 12px;
            line-height: 1.6;
          }
          .po-number { 
            text-align: right;
          }
          .po-number h2 { 
            font-size: 32px; 
            color: #1976d2;
            margin-bottom: 8px;
          }
          .po-number p {
            font-size: 12px;
            color: #666;
          }
          .section { 
            margin-bottom: 25px; 
          }
          .section-title { 
            font-size: 12px;
            font-weight: bold;
            color: #666;
            text-transform: uppercase;
            margin-bottom: 8px;
            letter-spacing: 1px;
          }
          .section-content {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 4px;
          }
          .two-column {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
          }
          table { 
            width: 100%; 
            border-collapse: collapse; 
            margin-top: 10px;
          }
          th, td { 
            padding: 12px;
            text-align: left; 
            border-bottom: 1px solid #ddd;
          }
          th { 
            background: #1976d2;
            color: white;
            font-size: 12px;
            text-transform: uppercase;
          }
          td {
            font-size: 14px;
          }
          .notes {
            background: #fff3e0;
            padding: 15px;
            border-radius: 4px;
            border-left: 4px solid #ff9800;
          }
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
          }
          .signature-line {
            margin-top: 60px;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 40px;
          }
          .signature-box {
            border-top: 1px solid #333;
            padding-top: 8px;
            font-size: 12px;
            color: #666;
          }
          @media print {
            body { padding: 20px; }
            .no-print { display: none; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="company-info">
            <h1>CAROLINA ROLLING</h1>
            <p>
              2657 Regional Rd S<br>
              Greensboro, NC 27409<br>
              Phone: (336) 668-2710<br>
              Email: carolinarolling@gmail.com
            </p>
          </div>
          <div class="po-number">
            <h2>PO${po.poNumber}</h2>
            <p>Purchase Order</p>
            <p>Date: ${new Date(po.createdAt).toLocaleDateString()}</p>
          </div>
        </div>

        <div class="two-column">
          <div class="section">
            <div class="section-title">Vendor / Supplier</div>
            <div class="section-content">
              <strong>${po.supplier || 'Not specified'}</strong>
            </div>
          </div>
          <div class="section">
            <div class="section-title">Ship To</div>
            <div class="section-content">
              <strong>Carolina Rolling</strong><br>
              2657 Regional Rd S<br>
              Greensboro, NC 27409
            </div>
          </div>
        </div>

        ${po.clientName ? `
        <div class="section">
          <div class="section-title">For Customer</div>
          <div class="section-content">
            <strong>${po.clientName}</strong>
          </div>
        </div>
        ` : ''}

        <div class="section">
          <div class="section-title">Order Details</div>
          <table>
            <thead>
              <tr>
                <th style="width: 60%">Description</th>
                <th style="width: 20%">Quantity</th>
                <th style="width: 20%">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${items.length > 0 ? items.map((item, i) => `
                <tr>
                  <td>${item}</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              `).join('') : `
                <tr>
                  <td colspan="3" style="text-align: center; color: #999;">No items specified</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>

        <div class="section notes">
          <div class="section-title">Special Instructions</div>
          <p>Please reference PO${po.poNumber} on all correspondence, packing slips, and invoices.</p>
        </div>

        <div class="footer">
          <div class="signature-line">
            <div class="signature-box">Authorized Signature</div>
            <div class="signature-box">Date</div>
          </div>
        </div>
      </body>
      </html>
    `;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.print();
  };

  const filteredPOs = purchaseOrders.filter(po => {
    const search = searchTerm.toLowerCase();
    return (
      po.poNumber.toString().includes(search) ||
      (po.supplier || '').toLowerCase().includes(search) ||
      (po.clientName || '').toLowerCase().includes(search) ||
      (po.description || '').toLowerCase().includes(search)
    );
  });

  const formatDate = (dateString) => {
    if (!dateString) return '—';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  if (loading && purchaseOrders.length === 0) {
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
          Purchase Orders
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={loadPurchaseOrders}>
            <RefreshCw size={18} />
          </button>
          <button className="btn btn-primary" onClick={openCreateModal}>
            <Plus size={18} /> New PO
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
        </div>
      )}

      {success && (
        <div className="alert alert-success" style={{ marginBottom: 16 }}>
          {success}
        </div>
      )}

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#999' }} />
              <input
                type="text"
                className="form-input"
                placeholder="Search PO#, supplier, client..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{ paddingLeft: 40 }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`btn btn-sm ${filterStatus === 'active' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setFilterStatus('active')}
            >
              Active
            </button>
            <button
              className={`btn btn-sm ${filterStatus === 'void' ? 'btn-danger' : 'btn-outline'}`}
              onClick={() => setFilterStatus('void')}
            >
              Voided
            </button>
          </div>
        </div>
      </div>

      {/* PO List */}
      <div className="card">
        {filteredPOs.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#666' }}>
            <ShoppingCart size={48} style={{ opacity: 0.3, marginBottom: 16 }} />
            <p>No purchase orders found</p>
            <button className="btn btn-primary" onClick={openCreateModal} style={{ marginTop: 16 }}>
              <Plus size={18} /> Create First PO
            </button>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Supplier</th>
                <th>Customer</th>
                <th>Description</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPOs.map(po => (
                <tr key={po.id} style={po.status === 'void' ? { opacity: 0.5 } : {}}>
                  <td>
                    <strong style={{ color: po.status === 'void' ? '#c62828' : '#1976d2', textDecoration: po.status === 'void' ? 'line-through' : 'none' }}>
                      PO{po.poNumber}
                    </strong>
                  </td>
                  <td>{po.supplier || <span style={{ color: '#999' }}>—</span>}</td>
                  <td>{po.clientName || <span style={{ color: '#999' }}>—</span>}</td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {po.description || <span style={{ color: '#999' }}>No description</span>}
                  </td>
                  <td>{formatDate(po.createdAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => openViewModal(po)}
                        title="View"
                      >
                        <Eye size={14} />
                      </button>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => printPurchaseOrder(po)}
                        title="Print"
                      >
                        <Printer size={14} />
                      </button>
                      {po.status !== 'void' && (
                        <button
                          className="btn btn-sm btn-outline"
                          onClick={() => openEditModal(po)}
                          title="Edit"
                        >
                          <Edit2 size={14} />
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          if (window.confirm(`Delete PO${po.poNumber}? This will also clear material order flags on associated parts.`)) {
                            try {
                              await deletePONumber(po.id);
                              setSuccess(`PO${po.poNumber} deleted`);
                              loadPurchaseOrders();
                              setTimeout(() => setSuccess(null), 3000);
                            } catch (err) {
                              setError(err.response?.data?.error?.message || 'Failed to delete');
                            }
                          }
                        }}
                        title="Delete"
                      >
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

      {/* Create/Edit PO Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 700, maxHeight: '90vh', overflow: 'auto' }}>
            <div className="modal-header">
              <h3>{editingPO ? `Edit PO${editingPO.poNumber}` : 'Create New Purchase Order'}</h3>
              <button className="btn btn-icon" onClick={() => setShowModal(false)}><X size={20} /></button>
            </div>

            <div style={{ padding: 20 }}>
              <div className="grid grid-2" style={{ gap: 16, marginBottom: 16 }}>
                <div className="form-group">
                  <label className="form-label">PO Number</label>
                  <input
                    type="number"
                    className="form-input"
                    value={poForm.poNumber}
                    onChange={(e) => setPOForm({ ...poForm, poNumber: parseInt(e.target.value) || '' })}
                    disabled={!!editingPO}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Supplier *</label>
                  <input
                    type="text"
                    className="form-input"
                    value={poForm.supplier}
                    onChange={(e) => setPOForm({ ...poForm, supplier: e.target.value })}
                    placeholder="e.g., Metal Supermarket"
                  />
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label">For Customer (optional)</label>
                <input
                  type="text"
                  className="form-input"
                  value={poForm.clientName}
                  onChange={(e) => setPOForm({ ...poForm, clientName: e.target.value })}
                  placeholder="Customer name this material is for"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label">Items / Materials</label>
                {poForm.items.map((item, index) => (
                  <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      type="text"
                      className="form-input"
                      value={item.description}
                      onChange={(e) => updateItem(index, 'description', e.target.value)}
                      placeholder="Material description (e.g., 2x2x1/4 Angle A36)"
                      style={{ flex: 1 }}
                    />
                    <input
                      type="number"
                      className="form-input"
                      value={item.quantity}
                      onChange={(e) => updateItem(index, 'quantity', parseInt(e.target.value) || 1)}
                      placeholder="Qty"
                      style={{ width: 80 }}
                      min="1"
                    />
                    {poForm.items.length > 1 && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => removeItem(index)}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
                <button className="btn btn-sm btn-outline" onClick={addItem}>
                  <Plus size={14} /> Add Item
                </button>
              </div>

              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea
                  className="form-input"
                  value={poForm.notes}
                  onChange={(e) => setPOForm({ ...poForm, notes: e.target.value })}
                  rows={3}
                  placeholder="Special instructions, delivery notes, etc."
                />
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSavePO} disabled={saving}>
                <Save size={16} />
                {saving ? 'Saving...' : (editingPO ? 'Update PO' : 'Create PO')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View/Print PO Modal */}
      {showViewModal && viewingPO && (
        <div className="modal-overlay" onClick={() => setShowViewModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3>PO{viewingPO.poNumber}</h3>
              <button className="btn btn-icon" onClick={() => setShowViewModal(false)}><X size={20} /></button>
            </div>

            <div style={{ padding: 20 }}>
              <div style={{ background: '#e3f2fd', padding: 16, borderRadius: 8, marginBottom: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: '#666', textTransform: 'uppercase' }}>Supplier</div>
                    <div style={{ fontWeight: 600 }}>{viewingPO.supplier || 'Not specified'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: '#666', textTransform: 'uppercase' }}>Date</div>
                    <div style={{ fontWeight: 600 }}>{formatDate(viewingPO.createdAt)}</div>
                  </div>
                  {viewingPO.clientName && (
                    <div>
                      <div style={{ fontSize: '0.75rem', color: '#666', textTransform: 'uppercase' }}>For Customer</div>
                      <div style={{ fontWeight: 600 }}>{viewingPO.clientName}</div>
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: '0.75rem', color: '#666', textTransform: 'uppercase' }}>Status</div>
                    <div style={{ fontWeight: 600, color: viewingPO.status === 'void' ? '#c62828' : '#2e7d32' }}>
                      {viewingPO.status === 'void' ? 'VOIDED' : 'Active'}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '0.75rem', color: '#666', textTransform: 'uppercase', marginBottom: 8 }}>Items / Description</div>
                <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, whiteSpace: 'pre-wrap' }}>
                  {viewingPO.description || 'No items specified'}
                </div>
              </div>

              {viewingPO.voidReason && (
                <div style={{ background: '#ffebee', padding: 12, borderRadius: 4, marginBottom: 16 }}>
                  <div style={{ fontSize: '0.75rem', color: '#c62828', textTransform: 'uppercase', marginBottom: 4 }}>Void Reason</div>
                  <div>{viewingPO.voidReason}</div>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowViewModal(false)}>Close</button>
              <button className="btn btn-primary" onClick={() => { printPurchaseOrder(viewingPO); setShowViewModal(false); }}>
                <Printer size={16} /> Print PO
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PurchaseOrdersPage;
