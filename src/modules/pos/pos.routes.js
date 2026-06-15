const router = require('express').Router();
const controller = require('./pos.controller');
const { posLimiter } = require('../../middleware/rateLimiter');
const { authenticate } = require('../../middleware/auth');

// Public POS endpoints — authenticated via license key
router.post('/validate-license', posLimiter, controller.validateLicense);
router.post('/sync-sales', posLimiter, controller.syncSales);
router.get('/status', posLimiter, controller.getStatus);
router.post('/sync-all', posLimiter, controller.syncAllData);
router.get('/load-all',  posLimiter, controller.loadAllData);

// Admin-only: device management
router.get('/devices', authenticate, controller.getDevices);
router.post('/devices/:deviceId/command', authenticate, controller.sendDeviceCommand);

module.exports = router;
