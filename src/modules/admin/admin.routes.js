const router = require('express').Router();
const controller = require('./admin.controller');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/auditLog');

router.use(authenticate);

router.get('/audit-logs', authorize('admin:read'), controller.getAuditLogs);
router.delete('/clear-all-data', authorize('admin:delete'), controller.clearAllData);

router.post('/', authorize('admin:create'), auditLog('CREATE', 'admin'), controller.createAdmin);
router.get('/', authorize('admin:read'), controller.findAll);
router.get('/:id', authorize('admin:read'), controller.findOne);
router.put('/:id', authorize('admin:update'), auditLog('UPDATE', 'admin'), controller.update);
router.delete('/:id', authorize('admin:delete'), auditLog('DELETE', 'admin'), controller.remove);
router.patch('/:id/reset-password', authorize('admin:update'), auditLog('RESET_PASSWORD', 'admin'), controller.resetPassword);

module.exports = router;
