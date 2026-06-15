const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const { errorHandler, notFound } = require('./middleware/errorHandler');

const authRoutes = require('./modules/auth/auth.routes');
const clientsRoutes = require('./modules/clients/clients.routes');
const subscriptionsRoutes = require('./modules/subscriptions/subscriptions.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');
const licensesRoutes = require('./modules/licenses/licenses.routes');
const invoicesRoutes = require('./modules/invoices/invoices.routes');
const ticketsRoutes = require('./modules/tickets/tickets.routes');
const reportsRoutes = require('./modules/reports/reports.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const posRoutes = require('./modules/pos/pos.routes');

const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return callback(null, true);
    // Allow any vercel.app subdomain as fallback
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const API = '/api/v1';
app.use(`${API}/auth`, authRoutes);
app.use(`${API}/clients`, clientsRoutes);
app.use(`${API}/subscriptions`, subscriptionsRoutes);
app.use(`${API}/payments`, paymentsRoutes);
app.use(`${API}/licenses`, licensesRoutes);
app.use(`${API}/invoices`, invoicesRoutes);
app.use(`${API}/tickets`, ticketsRoutes);
app.use(`${API}/reports`, reportsRoutes);
app.use(`${API}/admin`, adminRoutes);
app.use(`${API}/pos`, posRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
