import React, { useState, useEffect, useMemo } from 'react';
import { Upload } from 'lucide-react';
import { searchVendors } from '../services/api';

const THICKNESS_OPTIONS = [
  '24 ga', '20 ga', '16 ga', '14 ga', '12 ga', '11 ga', '10 ga',
  '3/16"', '1/4"', '5/16"', '3/8"', '1/2"', '5/8"', '3/4"', '7/8"',
  '1"', '1-1/4"', '1-1/2"', '2"', 'Custom'
];

const GRADE_OPTIONS = ['A36', '304 S/S', '316 S/S', 'AR400', 'Custom'];

// Convert thickness string to decimal inches for calculation
function thicknessToDecimal(t) {
  if (!t) return 0;
  const gaugeMap = {
    '24 ga': 0.0239, '20 ga': 0.0359, '16 ga': 0.0598, '14 ga': 0.0747,
    '12 ga': 0.1046, '11 ga': 0.1196, '10 ga': 0.1345
  };
  if (gaugeMap[t]) return gaugeMap[t];
  // Parse fraction strings like '1/4"', '1-1/2"'
  const clean = t.replace(/"/g, '').trim();
  if (clean.includes('-')) {
    const [whole, frac] = clean.split('-');
    const [n, d] = frac.split('/').map(Number);
    return Number(whole) + (n / d);
  }
  if (clean.includes('/')) {
    const [n, d] = clean.split('/').map(Number);
    return n / d;
  }
  return parseFloat(clean) || 0;
}

export default function PlateRollForm({ partData, setPartData, vendorSuggestions, setVendorSuggestions, showVendorSuggestions, setShowVendorSuggestions, showMessage, setError }) {
  const [customThickness, setCustomThickness] = useState('');
  const [customGrade, setCustomGrade] = useState('');
  const [rollValue, setRollValue] = useState(partData._rollValue || '');
  const [rollMeasurePoint, setRollMeasurePoint] = useState(partData._rollMeasurePoint || 'inside'); // inside, outside, centerline
  const [rollMeasureType, setRollMeasureType] = useState(partData._rollMeasureType || 'radius'); // radius, diameter
  const [showAngle, setShowAngle] = useState(!!(partData.arcDegrees));
  const [angleValue, setAngleValue] = useState(partData.arcDegrees || '');
  const [showTangent, setShowTangent] = useState(!!(partData._tangentLength));
  const [tangentLength, setTangentLength] = useState(partData._tangentLength || '');

  // Sync roll fields from partData on mount (for editing)
  useEffect(() => {
    if (partData.radius && !partData.diameter) {
      setRollValue(partData.radius);
      setRollMeasureType('radius');
    } else if (partData.diameter) {
      setRollValue(partData.diameter);
      setRollMeasureType('diameter');
    }
    if (partData.arcDegrees) {
      setShowAngle(true);
      setAngleValue(partData.arcDegrees);
    }
    if (partData._rollMeasurePoint) setRollMeasurePoint(partData._rollMeasurePoint);
    if (partData._tangentLength) {
      setShowTangent(true);
      setTangentLength(partData._tangentLength);
    }
  }, []);

  // Update partData when roll fields change
  useEffect(() => {
    const updates = {
      _rollValue: rollValue,
      _rollMeasurePoint: rollMeasurePoint,
      _rollMeasureType: rollMeasureType,
      _tangentLength: tangentLength,
      arcDegrees: showAngle ? angleValue : ''
    };
    if (rollMeasureType === 'radius') {
      updates.radius = rollValue;
      updates.diameter = '';
    } else {
      updates.diameter = rollValue;
      updates.radius = '';
    }
    setPartData(prev => ({ ...prev, ...updates }));
  }, [rollValue, rollMeasurePoint, rollMeasureType, showAngle, angleValue, tangentLength]);

  // Arc length calculation
  const calcResult = useMemo(() => {
    const thickDecimal = thicknessToDecimal(partData.thickness);
    const rv = parseFloat(rollValue) || 0;
    if (!rv || !thickDecimal) return null;

    let diameter = rollMeasureType === 'radius' ? rv * 2 : rv;

    // Adjust based on measure point
    let effectiveDiameter;
    if (rollMeasurePoint === 'inside') {
      effectiveDiameter = diameter + thickDecimal;
    } else if (rollMeasurePoint === 'outside') {
      effectiveDiameter = diameter - thickDecimal;
    } else {
      effectiveDiameter = diameter;
    }

    let arcLength = effectiveDiameter * Math.PI;

    // If angle, divide by 360 and multiply by angle
    const angle = parseFloat(angleValue) || 0;
    if (showAngle && angle > 0) {
      arcLength = (arcLength / 360) * angle;
    }

    // Add tangents
    const tang = parseFloat(tangentLength) || 0;
    let totalLength = arcLength;
    if (showTangent && tang > 0) {
      totalLength = arcLength + (tang * 2);
    }

    return {
      arcLength: arcLength,
      totalLength: totalLength,
      hasTangent: showTangent && tang > 0
    };
  }, [partData.thickness, rollValue, rollMeasurePoint, rollMeasureType, showAngle, angleValue, showTangent, tangentLength]);

  // Build material description string
  const materialDescription = useMemo(() => {
    const parts = [];
    if (partData.thickness) parts.push(partData.thickness);
    if (partData.width) parts.push(`x ${partData.width}`);
    if (partData.length) parts.push(`x ${partData.length}`);
    const grade = partData.material || '';
    if (grade) parts.push(grade);
    parts.push('Plate');
    const origin = partData._materialOrigin || '';
    if (origin) parts.push(`(${origin})`);
    return parts.join(' ');
  }, [partData.thickness, partData.width, partData.length, partData.material, partData._materialOrigin]);

  // Auto-update material description
  useEffect(() => {
    setPartData(prev => ({ ...prev, materialDescription: materialDescription }));
  }, [materialDescription]);

  // Calculate unit price
  const unitPrice = useMemo(() => {
    const mat = parseFloat(partData.materialTotal) || 0;
    const lab = parseFloat(partData.laborTotal) || 0;
    const setup = parseFloat(partData.setupCharge) || 0;
    const other = parseFloat(partData.otherCharges) || 0;
    return mat + lab + setup + other;
  }, [partData.materialTotal, partData.laborTotal, partData.setupCharge, partData.otherCharges]);

  // Auto-update part total
  useEffect(() => {
    const qty = parseInt(partData.quantity) || 1;
    setPartData(prev => ({ ...prev, partTotal: (unitPrice * qty).toFixed(2) }));
  }, [unitPrice, partData.quantity]);

  const isCustomThickness = partData.thickness === 'Custom' || (partData.thickness && !THICKNESS_OPTIONS.includes(partData.thickness) && partData.thickness !== customThickness);
  const selectedThicknessOption = THICKNESS_OPTIONS.includes(partData.thickness) ? partData.thickness : (partData.thickness ? 'Custom' : '');

  const isCustomGrade = partData.material && !GRADE_OPTIONS.includes(partData.material);
  const selectedGradeOption = GRADE_OPTIONS.includes(partData.material) ? partData.material : (partData.material ? 'Custom' : '');

  const sectionStyle = { gridColumn: 'span 2', borderTop: '1px solid #e0e0e0', marginTop: 8, paddingTop: 12 };
  const sectionTitle = (icon, text, color) => <h4 style={{ marginBottom: 10, color, fontSize: '0.95rem' }}>{icon} {text}</h4>;

  return (
    <>
      {/* === DIMENSIONS === */}
      <div className="form-group">
        <label className="form-label">Quantity *</label>
        <input type="number" className="form-input" value={partData.quantity} onChange={(e) => setPartData({ ...partData, quantity: e.target.value })} min="1" />
      </div>

      <div className="form-group">
        <label className="form-label">Thickness *</label>
        <select className="form-select" value={selectedThicknessOption} onChange={(e) => {
          if (e.target.value === 'Custom') {
            setPartData({ ...partData, thickness: customThickness || 'Custom' });
          } else {
            setPartData({ ...partData, thickness: e.target.value });
            setCustomThickness('');
          }
        }}>
          <option value="">Select...</option>
          {THICKNESS_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {(selectedThicknessOption === 'Custom' || isCustomThickness) && (
          <input className="form-input" style={{ marginTop: 4 }} placeholder="Enter custom thickness" 
            value={partData.thickness === 'Custom' ? customThickness : partData.thickness}
            onChange={(e) => { setCustomThickness(e.target.value); setPartData({ ...partData, thickness: e.target.value }); }} />
        )}
      </div>

      <div className="form-group">
        <label className="form-label">Width</label>
        <input className="form-input" value={partData.width || ''} onChange={(e) => setPartData({ ...partData, width: e.target.value })} placeholder='e.g. 48"' />
      </div>

      <div className="form-group">
        <label className="form-label">Length</label>
        <input className="form-input" value={partData.length || ''} onChange={(e) => setPartData({ ...partData, length: e.target.value })} placeholder="Optional" />
      </div>

      {/* === ROLL INFO === */}
      <div style={sectionStyle}>
        {sectionTitle('🔄', 'Roll Information', '#1565c0')}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
          <div className="form-group">
            <label className="form-label">Roll Value *</label>
            <input className="form-input" value={rollValue} onChange={(e) => setRollValue(e.target.value)} placeholder="Enter value" type="number" step="0.001" />
          </div>
          <div className="form-group">
            <label className="form-label">Measure To</label>
            <select className="form-select" value={rollMeasurePoint} onChange={(e) => setRollMeasurePoint(e.target.value)}>
              <option value="inside">Inside</option>
              <option value="outside">Outside</option>
              <option value="centerline">Centerline</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Type</label>
            <select className="form-select" value={rollMeasureType} onChange={(e) => setRollMeasureType(e.target.value)}>
              <option value="radius">Radius</option>
              <option value="diameter">Diameter</option>
            </select>
          </div>
        </div>

        {/* Angle */}
        <div style={{ marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500, fontSize: '0.9rem' }}>
            <input type="checkbox" checked={showAngle} onChange={(e) => { setShowAngle(e.target.checked); if (!e.target.checked) setAngleValue(''); }} />
            Arc Angle
          </label>
          {showAngle && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <input className="form-input" type="number" step="0.1" style={{ width: 120 }} value={angleValue} onChange={(e) => setAngleValue(e.target.value)} placeholder="Degrees" />
              <span style={{ fontSize: '0.85rem', color: '#666' }}>degrees</span>
            </div>
          )}
        </div>

        {/* Calculated Length */}
        {calcResult && (
          <div style={{ background: '#e3f2fd', padding: 12, borderRadius: 8, marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#1565c0' }}>Calculated Arc Length:</span>
              <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>{calcResult.arcLength.toFixed(3)}"</span>
            </div>

            <div style={{ marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.9rem' }}>
                <input type="checkbox" checked={showTangent} onChange={(e) => { setShowTangent(e.target.checked); if (!e.target.checked) setTangentLength(''); }} />
                Add Tangents
              </label>
              {showTangent && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <input className="form-input" type="number" step="0.1" style={{ width: 120 }} value={tangentLength} onChange={(e) => setTangentLength(e.target.value)} placeholder="Length each" />
                  <span style={{ fontSize: '0.85rem', color: '#666' }}>× 2 = {((parseFloat(tangentLength) || 0) * 2).toFixed(2)}"</span>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #bbdefb', paddingTop: 8 }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#1565c0' }}>Total Length:</span>
                <span style={{ fontWeight: 700, fontSize: '1.1rem', marginLeft: 8 }}>{calcResult.totalLength.toFixed(3)}"</span>
              </div>
              <button type="button" className="btn btn-sm" style={{ background: '#1565c0', color: 'white' }}
                onClick={() => setPartData(prev => ({ ...prev, length: calcResult.totalLength.toFixed(2) }))}>
                → Set as Length
              </button>
            </div>
          </div>
        )}
      </div>

      {/* === EASY/HARD WAY & SHAPE === */}
      <div style={{ ...sectionStyle, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="form-group">
          <label className="form-label">Roll Direction</label>
          <select className="form-select" value={partData.rollType || ''} onChange={(e) => setPartData({ ...partData, rollType: e.target.value })}>
            <option value="">Select...</option>
            <option value="easy_way">Easy Way</option>
            <option value="hard_way">Hard Way</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Custom Shape (PDF)</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', border: '1px dashed #bbb', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', color: '#666' }}>
            <Upload size={16} /> Upload drawing...
            <input type="file" accept=".pdf,.png,.jpg" style={{ display: 'none' }} onChange={(e) => {
              if (e.target.files[0]) setPartData({ ...partData, _shapeFile: e.target.files[0] });
            }} />
          </label>
          {partData._shapeFile && <div style={{ fontSize: '0.8rem', color: '#2e7d32', marginTop: 2 }}>📎 {partData._shapeFile.name}</div>}
        </div>
      </div>

      {/* === SPECIAL INSTRUCTIONS === */}
      <div style={sectionStyle}>
        <div className="form-group">
          <label className="form-label">Special Instructions</label>
          <textarea className="form-textarea" value={partData.specialInstructions || ''} onChange={(e) => setPartData({ ...partData, specialInstructions: e.target.value })} rows={2} />
        </div>
      </div>

      {/* === MATERIAL INFO === */}
      <div style={sectionStyle}>
        {sectionTitle('📦', 'Material Information', '#e65100')}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div className="form-group">
            <label className="form-label">Grade</label>
            <select className="form-select" value={selectedGradeOption} onChange={(e) => {
              if (e.target.value === 'Custom') {
                setPartData({ ...partData, material: customGrade || '' });
              } else {
                setPartData({ ...partData, material: e.target.value });
                setCustomGrade('');
              }
            }}>
              <option value="">Select...</option>
              {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
            {(selectedGradeOption === 'Custom' || isCustomGrade) && (
              <input className="form-input" style={{ marginTop: 4 }} placeholder="Enter grade"
                value={isCustomGrade ? partData.material : customGrade}
                onChange={(e) => { setCustomGrade(e.target.value); setPartData({ ...partData, material: e.target.value }); }} />
            )}
          </div>
          <div className="form-group">
            <label className="form-label">Origin</label>
            <select className="form-select" value={partData._materialOrigin || ''} onChange={(e) => setPartData({ ...partData, _materialOrigin: e.target.value })}>
              <option value="">Select...</option>
              <option value="Domestic">Domestic</option>
              <option value="Import">Import</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Material Source</label>
            <select className="form-select" value={partData.materialSource || 'customer'} onChange={(e) => setPartData({ ...partData, materialSource: e.target.value })}>
              <option value="customer">Client Supplies</option>
              <option value="we_order">We Order</option>
              <option value="in_stock">Stock Material</option>
            </select>
          </div>
        </div>

        {/* Vendor Selector */}
        {partData.materialSource === 'we_order' && (
          <div className="form-group" style={{ position: 'relative', marginTop: 8 }}>
            <label className="form-label">Vendor</label>
            <input className="form-input"
              value={partData._vendorSearch !== undefined ? partData._vendorSearch : (partData.vendor?.name || partData.supplierName || '')}
              onChange={async (e) => {
                const value = e.target.value;
                setPartData({ ...partData, _vendorSearch: value });
                if (value.length >= 1) {
                  try { const res = await searchVendors(value); setVendorSuggestions(res.data.data || []); setShowVendorSuggestions(true); } catch { setVendorSuggestions([]); }
                } else {
                  setPartData({ ...partData, _vendorSearch: value, vendorId: null, supplierName: '' }); setVendorSuggestions([]); setShowVendorSuggestions(false);
                }
              }}
              onFocus={async () => { try { const res = await searchVendors(''); setVendorSuggestions(res.data.data || []); setShowVendorSuggestions(true); } catch {} }}
              onBlur={() => setTimeout(() => setShowVendorSuggestions(false), 200)}
              placeholder="Search or add vendor..." autoComplete="off"
            />
            {showVendorSuggestions && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: 'white', border: '1px solid #ddd', borderRadius: 4, maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                {vendorSuggestions.map(v => (
                  <div key={v.id} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                    onMouseDown={() => { setPartData({ ...partData, vendorId: v.id, supplierName: v.name, _vendorSearch: undefined }); setShowVendorSuggestions(false); }}>
                    <strong>{v.name}</strong>
                    {v.contactPhone && <span style={{ fontSize: '0.8rem', color: '#666', marginLeft: 8 }}>{v.contactPhone}</span>}
                  </div>
                ))}
                {partData._vendorSearch && partData._vendorSearch.length >= 2 && !vendorSuggestions.some(v => v.name.toLowerCase() === (partData._vendorSearch || '').toLowerCase()) && (
                  <div style={{ padding: '8px 12px', cursor: 'pointer', background: '#e8f5e9', color: '#2e7d32', fontWeight: 600 }}
                    onMouseDown={async () => {
                      try {
                        const res = await fetch(`${process.env.REACT_APP_API_URL || ''}/api/vendors`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ name: partData._vendorSearch }) });
                        const data = await res.json();
                        if (data.data) { setPartData({ ...partData, vendorId: data.data.id, supplierName: data.data.name, _vendorSearch: undefined }); showMessage(`Vendor "${data.data.name}" created`); }
                      } catch { setError('Failed to create vendor'); }
                      setShowVendorSuggestions(false);
                    }}>
                    + Add "{partData._vendorSearch}" as new vendor
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Material Description for email */}
        <div className="form-group" style={{ marginTop: 12 }}>
          <label className="form-label">Material Description (for ordering)</label>
          <textarea className="form-textarea" value={partData.materialDescription || ''} onChange={(e) => setPartData({ ...partData, materialDescription: e.target.value })} rows={2}
            style={{ fontFamily: 'monospace', fontSize: '0.9rem' }} />
          <div style={{ fontSize: '0.75rem', color: '#999', marginTop: 2 }}>Auto-generated from dimensions — edit as needed for supplier email</div>
        </div>
      </div>

      {/* === PRICING === */}
      <div style={sectionStyle}>
        {sectionTitle('💰', 'Pricing', '#1976d2')}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="form-group">
            <label className="form-label">Material Price</label>
            <input type="number" step="0.01" className="form-input" value={partData.materialTotal || ''} onChange={(e) => setPartData({ ...partData, materialTotal: e.target.value })} placeholder="0.00" />
          </div>
          <div className="form-group">
            <label className="form-label">Labor Price</label>
            <input type="number" step="0.01" className="form-input" value={partData.laborTotal || ''} onChange={(e) => setPartData({ ...partData, laborTotal: e.target.value })} placeholder="0.00" />
          </div>
          <div className="form-group">
            <label className="form-label">Setup Charge</label>
            <input type="number" step="0.01" className="form-input" value={partData.setupCharge || ''} onChange={(e) => setPartData({ ...partData, setupCharge: e.target.value })} placeholder="0.00" />
          </div>
          <div className="form-group">
            <label className="form-label">Other Charges</label>
            <input type="number" step="0.01" className="form-input" value={partData.otherCharges || ''} onChange={(e) => setPartData({ ...partData, otherCharges: e.target.value })} placeholder="0.00" />
          </div>
        </div>

        {/* Unit Price & Part Total */}
        <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 8, marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontWeight: 500, color: '#666' }}>Unit Price:</span>
            <span style={{ fontWeight: 700, fontSize: '1.1rem', color: '#1976d2' }}>${unitPrice.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #ddd', paddingTop: 8 }}>
            <span style={{ fontWeight: 600 }}>Part Total ({partData.quantity || 1} × ${unitPrice.toFixed(2)}):</span>
            <span style={{ fontWeight: 700, fontSize: '1.2rem', color: '#2e7d32' }}>${(unitPrice * (parseInt(partData.quantity) || 1)).toFixed(2)}</span>
          </div>
        </div>
      </div>
    </>
  );
}
