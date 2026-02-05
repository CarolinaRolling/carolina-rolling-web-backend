import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://carolina-rolling-inventory-api-641af96c90aa.herokuapp.com/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// Auth
export const login = (username, password) => api.post('/auth/login', { username, password });
export const getCurrentUser = () => api.get('/auth/me');
export const changePassword = (currentPassword, newPassword) => 
  api.put('/auth/change-password', { currentPassword, newPassword });

// Admin - Users
export const getUsers = () => api.get('/auth/users');
export const createUser = (userData) => api.post('/auth/register', userData);
export const updateUser = (id, userData) => api.put(`/auth/users/${id}`, userData);
export const deleteUser = (id) => api.delete(`/auth/users/${id}`);

// Admin - Activity Logs
export const getActivityLogs = (limit = 100, offset = 0) => 
  api.get(`/auth/logs?limit=${limit}&offset=${offset}`);

// Shipments
export const getShipments = () => api.get('/shipments');
export const getShipmentById = (id) => api.get(`/shipments/${id}`);
export const getShipmentByQRCode = (qrCode) => api.get(`/shipments/qr/${qrCode}`);
export const getShipmentByWorkOrderId = (workOrderId) => api.get(`/shipments/workorder/${workOrderId}`);
export const createShipment = (data) => api.post('/shipments', data);
export const updateShipment = (id, data) => api.put(`/shipments/${id}`, data);
export const deleteShipment = (id) => api.delete(`/shipments/${id}`);

// Photos
export const uploadPhotos = (shipmentId, files) => {
  const formData = new FormData();
  files.forEach((file) => formData.append('photos', file));
  return api.post(`/shipments/${shipmentId}/photos`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
export const deletePhoto = (shipmentId, photoId) => 
  api.delete(`/shipments/${shipmentId}/photos/${photoId}`);

// Documents - Upload to Cloudinary via backend
export const uploadDocuments = async (shipmentId, files) => {
  const formData = new FormData();
  files.forEach((file) => formData.append('documents', file));
  return api.post(`/shipments/${shipmentId}/documents`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};

export const deleteDocument = async (shipmentId, documentId) => {
  return api.delete(`/shipments/${shipmentId}/documents/${documentId}`);
};

// Get signed URL for viewing private documents
export const getDocumentSignedUrl = async (shipmentId, documentId) => {
  const response = await api.get(`/shipments/${shipmentId}/documents/${documentId}/signed-url`);
  return response.data.data;
};

// Locations
export const getLocations = () => api.get('/settings/locations');
export const updateLocations = (locations) => api.put('/settings/locations', { locations });
export const addLocation = (location) => api.post('/settings/locations', location);
export const deleteLocation = (id) => api.delete(`/settings/locations/${id}`);
export const updateLocation = (id, location) => api.put(`/settings/locations/${id}`, location);

// Inbound Orders
export const getInboundOrders = () => api.get('/inbound');
export const getInboundOrderById = (id) => api.get(`/inbound/${id}`);
export const createInboundOrder = (data) => api.post('/inbound', data);
export const updateInboundOrder = (id, data) => api.put(`/inbound/${id}`, data);
export const deleteInboundOrder = (id) => api.delete(`/inbound/${id}`);

// Work Orders
export const getWorkOrders = (params) => api.get('/workorders', { params });
export const getWorkOrderById = (id) => api.get(`/workorders/${id}`);
export const createWorkOrder = (data) => api.post('/workorders', data);
export const updateWorkOrder = (id, data) => api.put(`/workorders/${id}`, data);
export const deleteWorkOrder = (id) => api.delete(`/workorders/${id}`);

// Work Order Parts
export const addWorkOrderPart = (workOrderId, data) => api.post(`/workorders/${workOrderId}/parts`, data);
export const updateWorkOrderPart = (workOrderId, partId, data) => api.put(`/workorders/${workOrderId}/parts/${partId}`, data);
export const deleteWorkOrderPart = (workOrderId, partId) => api.delete(`/workorders/${workOrderId}/parts/${partId}`);

// Work Order Part Files
export const uploadPartFiles = (workOrderId, partId, files) => {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  return api.post(`/workorders/${workOrderId}/parts/${partId}/files`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
export const getPartFileSignedUrl = async (workOrderId, partId, fileId) => {
  const response = await api.get(`/workorders/${workOrderId}/parts/${partId}/files/${fileId}/signed-url`);
  return response.data.data;
};
export const deletePartFile = (workOrderId, partId, fileId) => 
  api.delete(`/workorders/${workOrderId}/parts/${partId}/files/${fileId}`);

// Work Order Documents (for order-level attachments like POs, supplier docs)
export const uploadWorkOrderDocuments = (workOrderId, files) => {
  const formData = new FormData();
  files.forEach((file) => formData.append('documents', file));
  return api.post(`/workorders/${workOrderId}/documents`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
export const getWorkOrderDocumentSignedUrl = (workOrderId, documentId) => 
  api.get(`/workorders/${workOrderId}/documents/${documentId}/signed-url`);
export const deleteWorkOrderDocument = (workOrderId, documentId) => 
  api.delete(`/workorders/${workOrderId}/documents/${documentId}`);

// Work Order Material Ordering
export const orderWorkOrderMaterial = (workOrderId, data) => 
  api.post(`/workorders/${workOrderId}/order-material`, data);

// Work Order Estimate Linking
export const searchLinkableEstimates = (query) => 
  api.get('/workorders/linkable-estimates/search', { params: { q: query } });
export const linkEstimateToWorkOrder = (workOrderId, estimateId) => 
  api.post(`/workorders/${workOrderId}/link-estimate`, { estimateId });
export const unlinkEstimateFromWorkOrder = (workOrderId) => 
  api.post(`/workorders/${workOrderId}/unlink-estimate`);

// Estimates
export const getEstimates = (params) => api.get('/estimates', { params });
export const getEstimateById = (id) => api.get(`/estimates/${id}`);
export const createEstimate = (data) => api.post('/estimates', data);
export const updateEstimate = (id, data) => api.put(`/estimates/${id}`, data);
export const deleteEstimate = (id) => api.delete(`/estimates/${id}`);

// Estimate Parts
export const addEstimatePart = (estimateId, data) => api.post(`/estimates/${estimateId}/parts`, data);
export const updateEstimatePart = (estimateId, partId, data) => api.put(`/estimates/${estimateId}/parts/${partId}`, data);
export const deleteEstimatePart = (estimateId, partId) => api.delete(`/estimates/${estimateId}/parts/${partId}`);

// Estimate Part Files
export const getEstimatePartFiles = (estimateId, partId) => api.get(`/estimates/${estimateId}/parts/${partId}/files`);
export const uploadEstimatePartFile = (estimateId, partId, file, fileType = 'other') => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('fileType', fileType);
  return api.post(`/estimates/${estimateId}/parts/${partId}/files`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
export const deleteEstimatePartFile = (estimateId, partId, fileId) => 
  api.delete(`/estimates/${estimateId}/parts/${partId}/files/${fileId}`);

// Reset estimate conversion (if work order is missing)
export const resetEstimateConversion = (estimateId) => api.post(`/estimates/${estimateId}/reset-conversion`);
export const checkOrphanedEstimates = () => api.get('/estimates/check-orphaned');

// Order Material (creates inbound orders)
export const orderMaterial = (estimateId, data) => api.post(`/estimates/${estimateId}/order-material`, data);

// Estimate Files
export const uploadEstimateFiles = (estimateId, files) => {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  return api.post(`/estimates/${estimateId}/files`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
export const getEstimateFileSignedUrl = async (estimateId, fileId) => {
  const response = await api.get(`/estimates/${estimateId}/files/${fileId}/signed-url`);
  return response.data.data;
};
export const deleteEstimateFile = (estimateId, fileId) => api.delete(`/estimates/${estimateId}/files/${fileId}`);

// Download Estimate PDF
export const downloadEstimatePDF = (estimateId) => api.get(`/estimates/${estimateId}/pdf`, { responseType: 'blob' });

// Convert Estimate to Work Order
export const convertEstimateToWorkOrder = (estimateId, data) => api.post(`/estimates/${estimateId}/convert-to-workorder`, data);

// Duplicate Estimate (for repeat orders)
export const duplicateEstimate = (estimateId, data) => api.post(`/estimates/${estimateId}/duplicate`, data);

// Archive old estimates
export const archiveOldEstimates = () => api.post('/estimates/archive-old');

// Work Order Shipping & Archiving
export const shipWorkOrder = (id, data) => api.post(`/workorders/${id}/ship`, data);
export const archiveWorkOrder = (id) => api.post(`/workorders/${id}/archive`);
export const getArchivedWorkOrders = (params) => api.get('/workorders/archived', { params });
export const duplicateWorkOrderToEstimate = (id) => api.post(`/workorders/${id}/duplicate-to-estimate`);

// DR Numbers
export const getDRNumbers = (params) => api.get('/dr-numbers', { params });
export const getDRNumberStats = () => api.get('/dr-numbers/stats');
export const getNextDRNumber = () => api.get('/dr-numbers/next');
export const setNextDRNumber = (nextNumber) => api.put('/dr-numbers/next', { nextNumber });
export const assignDRNumber = (data) => api.post('/dr-numbers/assign', data);
export const voidDRNumber = (drNumber, reason, voidedBy) => api.post(`/dr-numbers/${drNumber}/void`, { reason, voidedBy });
export const getVoidedDRNumbers = () => api.get('/dr-numbers/voided');

// PO Numbers
export const getPONumbers = (params) => api.get('/po-numbers', { params });
export const getPONumberStats = () => api.get('/po-numbers/stats');
export const getNextPONumber = () => api.get('/po-numbers/next');
export const setNextPONumber = (nextNumber) => api.put('/po-numbers/next', { nextNumber });
export const assignPONumber = (data) => api.post('/po-numbers/assign', data);
export const voidPONumber = (poNumber, reason, voidedBy) => api.post(`/po-numbers/${poNumber}/void`, { reason, voidedBy });
export const getVoidedPONumbers = () => api.get('/po-numbers/voided');
export const deletePONumber = (id) => api.delete(`/po-numbers/${id}`);

// Daily Email Settings
export const getDailyEmailSettings = () => api.get('/email/settings');
export const updateDailyEmailSettings = (settings) => api.put('/email/settings', settings);
export const getDailyEmailActivities = (params) => api.get('/email/activities', { params });
export const sendDailyEmailNow = () => api.post('/email/send-daily');
export const sendTestEmail = () => api.post('/email/test');
export const getEmailLogs = () => api.get('/email/logs');

// Backup
export const getBackupInfo = () => api.get('/backup/info');
export const downloadBackup = (params) => api.get('/backup', { params, responseType: 'blob' });
export const restoreBackup = (data) => api.post('/backup/restore', data);

// Email Settings
export const getNotificationEmail = () => api.get('/settings/notification-email');
export const updateNotificationEmail = (email) => api.put('/settings/notification-email', { email });

// General Settings
export const getSettings = (key) => api.get(`/settings/${key}`);
export const updateSettings = (key, value) => api.put(`/settings/${key}`, { value });

// Schedule Email Settings
export const getScheduleEmailSettings = () => api.get('/settings/schedule-email');
export const updateScheduleEmailSettings = (email, enabled) => 
  api.put('/settings/schedule-email', { email, enabled });
export const sendScheduleEmailNow = () => api.post('/settings/schedule-email/send');

// Clients
export const getClients = (params) => api.get('/clients', { params });
export const searchClients = (q) => api.get('/clients/search', { params: { q } });
export const getClient = (id) => api.get(`/clients/${id}`);
export const createClient = (data) => api.post('/clients', data);
export const updateClient = (id, data) => api.put(`/clients/${id}`, data);
export const deleteClient = (id) => api.delete(`/clients/${id}`);

// Vendors
export const getVendors = (params) => api.get('/vendors', { params });
export const searchVendors = (q) => api.get('/vendors/search', { params: { q } });
export const getVendor = (id) => api.get(`/vendors/${id}`);
export const createVendor = (data) => api.post('/vendors', data);
export const updateVendor = (id, data) => api.put(`/vendors/${id}`, data);
export const deleteVendor = (id) => api.delete(`/vendors/${id}`);

export default api;
