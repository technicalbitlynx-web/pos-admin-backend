const service = require('./reports.service');
const { successResponse, errorResponse } = require('../../utils/helpers');

async function revenue(req, res, next) {
  try {
    const data = await service.revenue(req.query);
    successResponse(res, { data });
  } catch (err) { next(err); }
}

async function activeClients(req, res, next) {
  try {
    const data = await service.activeClients();
    successResponse(res, { data });
  } catch (err) { next(err); }
}

async function expiredLicenses(req, res, next) {
  try {
    const data = await service.expiredLicenses();
    successResponse(res, { data });
  } catch (err) { next(err); }
}

async function monthlyPerformance(req, res, next) {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
    const data = await service.monthlyPerformance(year, month);
    successResponse(res, { data });
  } catch (err) { next(err); }
}

async function exportReport(req, res, next) {
  try {
    const { type, format } = req.params;
    const validTypes = ['revenue', 'clients', 'licenses'];
    if (!validTypes.includes(type)) return errorResponse(res, 'Invalid report type', 400);

    if (format === 'excel' || format === 'xlsx') {
      const workbook = await service.exportExcel(type, req.query);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${type}-report.xlsx"`);
      await workbook.xlsx.write(res);
      res.end();
    } else if (format === 'csv') {
      const workbook = await service.exportExcel(type, req.query);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
      await workbook.csv.write(res);
      res.end();
    } else {
      errorResponse(res, 'Invalid format. Use excel or csv', 400);
    }
  } catch (err) { next(err); }
}

async function posOverview(req, res, next) {
  try {
    const data = await service.posOverview();
    successResponse(res, { data });
  } catch (err) { next(err); }
}

async function getCapitalConfig(req, res, next) {
  try {
    const data = await service.getCapitalConfig();
    successResponse(res, { data });
  } catch (err) { next(err); }
}

async function setCapitalConfig(req, res, next) {
  try {
    const { apk, exe } = req.body;
    const data = await service.setCapitalConfig({ apk, exe });
    successResponse(res, { data, message: 'Capital config updated' });
  } catch (err) { next(err); }
}

module.exports = { revenue, activeClients, expiredLicenses, monthlyPerformance, exportReport, posOverview, getCapitalConfig, setCapitalConfig };
