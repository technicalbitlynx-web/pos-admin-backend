require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = require('./app');
const config = require('./config/config');

// Ensure required storage directories exist on startup
['invoices'].forEach((sub) => {
  fs.mkdirSync(path.join(config.storage.path, sub), { recursive: true });
});
const logger = require('./utils/logger');
const prisma = require('./config/database');
const { setupWebSocket } = require('./websocket/posSocket');
const { startSubscriptionExpiryJob } = require('./jobs/subscriptionExpiry');

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

app.set('io', io);   // make io accessible in controllers via req.app.get('io')
setupWebSocket(io);

async function start() {
  try {
    await prisma.$connect();
    logger.info('Database connected');

    startSubscriptionExpiryJob();

    server.listen(config.port, () => {
      logger.info(`POS Admin Backend running on port ${config.port}`);
      logger.info(`Environment: ${config.env}`);
      logger.info(`API Base: /api/v1`);
      logger.info(`WebSocket: ws://localhost:${config.port}`);
    });
  } catch (err) {
    logger.error('Failed to start server', { message: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await prisma.$disconnect();
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await prisma.$disconnect();
  server.close(() => process.exit(0));
});

start();
