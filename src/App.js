import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import InventoryPage from './pages/InventoryPage';
import ShipmentDetailsPage from './pages/ShipmentDetailsPage';
import NewShipmentPage from './pages/NewShipmentPage';
import InboundPage from './pages/InboundPage';
import InboundDetailsPage from './pages/InboundDetailsPage';
import WorkOrdersPage from './pages/WorkOrdersPage';
import WorkOrderDetailsPage from './pages/WorkOrderDetailsPage';
import EstimatesPage from './pages/EstimatesPage';
import EstimateDetailsPage from './pages/EstimateDetailsPage';
import BackupPage from './pages/BackupPage';
import SettingsPage from './pages/SettingsPage';
import LocationSettingsPage from './pages/LocationSettingsPage';
import AdminPage from './pages/AdminPage';
import SchedulingPage from './pages/SchedulingPage';
import DRNumbersPage from './pages/DRNumbersPage';
import PONumbersPage from './pages/PONumbersPage';
import PurchaseOrdersPage from './pages/PurchaseOrdersPage';
import EmailSettingsPage from './pages/EmailSettingsPage';
import ClientsVendorsPage from './pages/ClientsVendorsPage';
import './App.css';

// Protected Route Component
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  
  if (loading) {
    return (
      <div className="loading" style={{ minHeight: '100vh' }}>
        <div className="spinner"></div>
      </div>
    );
  }
  
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  
  return children;
};

// Admin Route Component
const AdminRoute = ({ children }) => {
  const { user, loading, isAdmin } = useAuth();
  
  if (loading) {
    return (
      <div className="loading" style={{ minHeight: '100vh' }}>
        <div className="spinner"></div>
      </div>
    );
  }
  
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  
  if (!isAdmin()) {
    return <Navigate to="/inventory" replace />;
  }
  
  return children;
};

function AppRoutes() {
  const { user } = useAuth();
  
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/inventory" replace /> : <LoginPage />} />
      
      <Route path="/" element={<Navigate to="/inventory" replace />} />
      
      <Route path="/inventory" element={
        <ProtectedRoute>
          <Layout><InventoryPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/shipment/:id" element={
        <ProtectedRoute>
          <Layout><ShipmentDetailsPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/new-shipment" element={
        <ProtectedRoute>
          <Layout><NewShipmentPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/inbound" element={
        <ProtectedRoute>
          <Layout><InboundPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/inbound/:id" element={
        <ProtectedRoute>
          <Layout><InboundDetailsPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/workorders" element={
        <ProtectedRoute>
          <Layout><WorkOrdersPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/workorders/:id" element={
        <ProtectedRoute>
          <Layout><WorkOrderDetailsPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/estimates" element={
        <ProtectedRoute>
          <Layout><EstimatesPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/estimates/:id" element={
        <ProtectedRoute>
          <Layout><EstimateDetailsPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/purchase-orders" element={
        <ProtectedRoute>
          <Layout><PurchaseOrdersPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/backup" element={
        <ProtectedRoute>
          <Layout><BackupPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/settings" element={
        <ProtectedRoute>
          <Layout><SettingsPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/settings/locations" element={
        <ProtectedRoute>
          <Layout><LocationSettingsPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/scheduling" element={
        <ProtectedRoute>
          <Layout><SchedulingPage /></Layout>
        </ProtectedRoute>
      } />
      
      <Route path="/admin" element={
        <AdminRoute>
          <Layout><AdminPage /></Layout>
        </AdminRoute>
      } />
      
      <Route path="/admin/dr-numbers" element={
        <AdminRoute>
          <Layout><DRNumbersPage /></Layout>
        </AdminRoute>
      } />
      
      <Route path="/admin/po-numbers" element={
        <AdminRoute>
          <Layout><PONumbersPage /></Layout>
        </AdminRoute>
      } />
      
      <Route path="/admin/email" element={
        <AdminRoute>
          <Layout><EmailSettingsPage /></Layout>
        </AdminRoute>
      } />
      
      <Route path="/admin/clients-vendors" element={
        <AdminRoute>
          <Layout><ClientsVendorsPage /></Layout>
        </AdminRoute>
      } />
      
      {/* Alternate route for workorder (singular) */}
      <Route path="/workorder/:id" element={
        <ProtectedRoute>
          <Layout><WorkOrderDetailsPage /></Layout>
        </ProtectedRoute>
      } />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <AppRoutes />
      </Router>
    </AuthProvider>
  );
}

export default App;
