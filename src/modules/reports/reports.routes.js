const router = require('express').Router();
const controller = require('./reports.controller');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/rbac');

router.use(authenticate, authorize('reports:read'));

router.get('/revenue', controller.revenue);
router.get('/clients', controller.activeClients);
router.get('/licenses/expired', controller.expiredLicenses);
router.get('/monthly', controller.monthlyPerformance);
router.get('/pos-overview', controller.posOverview);
router.get('/capital-config', controller.getCapitalConfig);
router.put('/capital-config', controller.setCapitalConfig);
router.get('/export/:type/:format', controller.exportReport);

module.exports = router;
