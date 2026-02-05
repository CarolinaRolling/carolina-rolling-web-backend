# Shipment Tracker Web App

A React-based web application for managing warehouse inventory and shipments. This is the web companion to the Android app.

## Features

- **Inventory Management** - View, search, and filter all shipments
- **Create Shipments** - Add new shipments with photos and documents
- **Shipment Details** - View and edit shipment information, upload files
- **Status Updates** - Change shipment status (Received, In Progress, Completed, Shipped)
- **QR Codes** - Generate and download QR codes for shipments
- **Inbound Orders** - Track expected deliveries
- **Location Settings** - Configure warehouse locations
- **Email Notifications** - Set up notification email

## Getting Started

### Prerequisites

- Node.js 16+ installed
- npm or yarn

### Installation

1. Navigate to the web-app directory:
   ```bash
   cd web-app
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm start
   ```

4. Open http://localhost:3000 in your browser

### Environment Variables

Create a `.env` file in the web-app directory if you want to override the API URL:

```
REACT_APP_API_URL=https://your-api-url.herokuapp.com/api
```

Default API URL: `https://carolina-rolling-inventory-api-641af96c90aa.herokuapp.com/api`

## Deployment

### Option 1: Deploy to Vercel (Recommended)

1. Install Vercel CLI:
   ```bash
   npm install -g vercel
   ```

2. Deploy:
   ```bash
   vercel
   ```

### Option 2: Deploy to Netlify

1. Build the app:
   ```bash
   npm run build
   ```

2. Drag and drop the `build` folder to Netlify

### Option 3: Deploy to Heroku

1. Add the following buildpack:
   ```bash
   heroku buildpacks:set mars/create-react-app
   ```

2. Deploy:
   ```bash
   git push heroku main
   ```

### Option 4: Host on Synology NAS (Local Network Only)

1. Build the app:
   ```bash
   npm run build
   ```

2. Copy the contents of the `build` folder to your Synology Web Station folder

3. Access via your NAS IP address

## Project Structure

```
web-app/
├── public/
│   └── index.html
├── src/
│   ├── components/
│   │   └── Layout.js
│   ├── pages/
│   │   ├── InventoryPage.js
│   │   ├── ShipmentDetailsPage.js
│   │   ├── NewShipmentPage.js
│   │   ├── InboundPage.js
│   │   ├── InboundDetailsPage.js
│   │   ├── SettingsPage.js
│   │   └── LocationSettingsPage.js
│   ├── services/
│   │   └── api.js
│   ├── App.js
│   ├── App.css
│   └── index.js
└── package.json
```

## Tech Stack

- React 18
- React Router v6
- Axios for API calls
- Lucide React for icons
- QRCode library for QR generation

## API Endpoints Used

- `GET /shipments` - List all shipments
- `GET /shipments/:id` - Get shipment details
- `POST /shipments` - Create shipment
- `PUT /shipments/:id` - Update shipment
- `DELETE /shipments/:id` - Delete shipment
- `POST /shipments/:id/photos` - Upload photos
- `POST /shipments/:id/documents` - Upload documents
- `GET /settings/locations` - Get locations
- `GET /inbound` - List inbound orders
- And more...

## License

Private - Carolina Rolling
