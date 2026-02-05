import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Package, Inbox, PlusCircle, Settings, Shield, LogOut, CalendarClock, ClipboardList, DollarSign, Database, Hash, Mail, ShoppingCart } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

function Layout({ children }) {
  const navigate = useNavigate();
  const { user, logout, isAdmin } = useAuth();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Shipment Tracker</h1>
          <p>Carolina Rolling</p>
        </div>
        <nav>
          <ul className="sidebar-nav">
            <li>
              <NavLink to="/inventory" className={({ isActive }) => isActive ? 'active' : ''}>
                <Package size={20} />
                <span>Inventory</span>
              </NavLink>
            </li>
            <li>
              <NavLink to="/scheduling" className={({ isActive }) => isActive ? 'active' : ''}>
                <CalendarClock size={20} />
                <span>Scheduling</span>
              </NavLink>
            </li>
            <li>
              <NavLink to="/new-shipment" className={({ isActive }) => isActive ? 'active' : ''}>
                <PlusCircle size={20} />
                <span>New Shipment</span>
              </NavLink>
            </li>
            <li>
              <NavLink to="/inbound" className={({ isActive }) => isActive ? 'active' : ''}>
                <Inbox size={20} />
                <span>Inbound</span>
              </NavLink>
            </li>
            <li>
              <NavLink to="/workorders" className={({ isActive }) => isActive ? 'active' : ''}>
                <ClipboardList size={20} />
                <span>Work Orders</span>
              </NavLink>
            </li>
            <li>
              <NavLink to="/estimates" className={({ isActive }) => isActive ? 'active' : ''}>
                <DollarSign size={20} />
                <span>Estimates</span>
              </NavLink>
            </li>
            <li>
              <NavLink to="/purchase-orders" className={({ isActive }) => isActive ? 'active' : ''}>
                <ShoppingCart size={20} />
                <span>Purchase Orders</span>
              </NavLink>
            </li>
            <li>
              <NavLink to="/settings" className={({ isActive }) => isActive ? 'active' : ''}>
                <Settings size={20} />
                <span>Settings</span>
              </NavLink>
            </li>
            <li>
              <NavLink to="/backup" className={({ isActive }) => isActive ? 'active' : ''}>
                <Database size={20} />
                <span>Backup</span>
              </NavLink>
            </li>
            {isAdmin() && (
              <>
                <li style={{ 
                  marginTop: 16, 
                  paddingTop: 16, 
                  borderTop: '1px solid rgba(255,255,255,0.1)',
                  fontSize: '0.7rem',
                  color: 'rgba(255,255,255,0.5)',
                  paddingLeft: 20,
                  textTransform: 'uppercase',
                  letterSpacing: 1
                }}>
                  Admin
                </li>
                <li>
                  <NavLink to="/admin" className={({ isActive }) => isActive ? 'active' : ''}>
                    <Shield size={20} />
                    <span>Users & Logs</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink to="/admin/dr-numbers" className={({ isActive }) => isActive ? 'active' : ''}>
                    <Hash size={20} />
                    <span>DR Numbers</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink to="/admin/po-numbers" className={({ isActive }) => isActive ? 'active' : ''}>
                    <Hash size={20} />
                    <span>PO Numbers</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink to="/admin/email" className={({ isActive }) => isActive ? 'active' : ''}>
                    <Mail size={20} />
                    <span>Daily Email</span>
                  </NavLink>
                </li>
              </>
            )}
          </ul>
        </nav>
        
        {/* User info and logout */}
        <div style={{ 
          position: 'absolute', 
          bottom: 0, 
          left: 0, 
          right: 0,
          padding: '16px 20px',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          background: 'rgba(0,0,0,0.1)'
        }}>
          <div style={{ 
            color: 'rgba(255,255,255,0.8)', 
            fontSize: '0.8rem',
            marginBottom: 8
          }}>
            Logged in as <strong>{user?.username}</strong>
            {user?.role === 'admin' && (
              <span style={{ 
                marginLeft: 6,
                background: 'rgba(255,255,255,0.2)',
                padding: '2px 6px',
                borderRadius: 4,
                fontSize: '0.7rem'
              }}>
                Admin
              </span>
            )}
          </div>
          <button
            onClick={handleLogout}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              color: 'white',
              padding: '8px 12px',
              borderRadius: 6,
              cursor: 'pointer',
              width: '100%',
              fontSize: '0.85rem'
            }}
          >
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}

export default Layout;
