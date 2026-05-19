require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const logger = require('./src/utils/logger');
const routes = require('./src/middleware/routes');
const { registerWebhooks } = require('./src/webhooks/handler');
const { startScheduler } = require('./src/scheduler/cron');

// ============================================================
// SETUP
// ============================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Ensure logs directory exists
if (!fs.existsSync('logs')) fs.mkdirSync('logs');

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(helmet({
  contentSecurityPolicy: false // allow inline scripts in dashboard
}));
app.use(cors());

// Raw body for webhook signature verification
app.use('/webhooks', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  req.body = JSON.parse(req.body.toString());
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again in 15 minutes.' }
});
app.use('/api', limiter);

// Static dashboard
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api', routes);

// ============================================================
// REAL-TIME DASHBOARD via Socket.IO
// ============================================================
io.on('connection', (socket) => {
  logger.info(`🖥️  Dashboard connected: ${socket.id}`);

  socket.on('trigger-agent', async ({ agent }) => {
    io.emit('agent-log', { agent, status: 'running', message: `Starting ${agent}...` });
    try {
      let result;
      switch (agent) {
        case 'research':
          const products = await require('./src/agents/productResearchAgent').run();
          result = { productsFound: products.length };
          break;
        case 'pricing':
          result = await require('./src/agents/pricingAgent').run();
          break;
        case 'fulfillment':
          result = await require('./src/agents/fulfillmentAgent').run();
          break;
        case 'inventory':
          result = await require('./src/agents/inventoryAgent').run();
          break;
        default:
          throw new Error(`Unknown agent: ${agent}`);
      }
      io.emit('agent-log', { agent, status: 'complete', message: `${agent} complete`, result });
    } catch (error) {
      io.emit('agent-log', { agent, status: 'error', message: error.message });
    }
  });

  socket.on('disconnect', () => {
    logger.info(`🖥️  Dashboard disconnected: ${socket.id}`);
  });
});

// Broadcast logs to dashboard in real-time
const originalLog = logger.info.bind(logger);
logger.stream = {
  write: (message) => {
    io.emit('log', { message: message.trim(), timestamp: new Date().toISOString() });
  }
};

// ============================================================
// ADMIN DASHBOARD (served at root)
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  logger.info(`🚀 Dropship AI Server running on port ${PORT}`);
  logger.info(`📊 Dashboard: http://localhost:${PORT}`);
  logger.info(`🏪 Store: ${process.env.SHOPIFY_SHOP_NAME || 'NOT CONFIGURED'}`);

  // Register webhooks
  if (process.env.BASE_URL && process.env.SHOPIFY_SHOP_NAME) {
    try {
      await registerWebhooks(process.env.BASE_URL);
      logger.info('✅ Shopify webhooks registered');
    } catch (error) {
      logger.warn('Webhook registration failed (non-fatal)', { error: error.message });
    }
  }

  // Start AI agent scheduler
  startScheduler();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason: String(reason) });
});

module.exports = { app, server, io };
