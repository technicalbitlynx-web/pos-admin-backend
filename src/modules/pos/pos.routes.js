const router = require('express').Router();
const controller = require('./pos.controller');
const { posLimiter } = require('../../middleware/rateLimiter');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/rbac');

// Public POS endpoints — authenticated via license key
router.post('/validate-license', posLimiter, controller.validateLicense);
router.post('/sync-sales', posLimiter, controller.syncSales);
router.get('/status', posLimiter, controller.getStatus);
router.post('/sync-all', posLimiter, controller.syncAllData);
router.get('/load-all',  posLimiter, controller.loadAllData);

// Public — PIN verification (no JWT, authenticated by license_key in body)
router.post('/operators/verify-pin', posLimiter, controller.verifyOperatorPin);

// Admin-only: operator CRUD
router.get('/operators',      authenticate, authorize('operators:read'),  controller.listOperators);
router.post('/operators',     authenticate, authorize('operators:write'), controller.createOperator);
router.patch('/operators/:id', authenticate, authorize('operators:write'), controller.updateOperator);
router.delete('/operators/:id', authenticate, authorize('operators:write'), controller.removeOperator);

// Admin-only: full device overview + remote commands
router.get('/devices', authenticate, controller.getDevices);
router.post('/devices/:deviceId/command', authenticate, controller.sendDeviceCommand);

// Public device management — authenticated via license_key (+ manager PIN for write ops)
router.post('/devices/register',                posLimiter, controller.registerDevice);
router.get('/devices/list',                     posLimiter, controller.listPosDevices);
router.put('/devices/:deviceId/reassign',       posLimiter, controller.reassignDevice);
router.delete('/devices/:deviceId/deregister',  posLimiter, controller.deregisterDevice);

module.exports = router;
