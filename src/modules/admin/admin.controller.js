const service = require('./admin.service');
const { successResponse, errorResponse } = require('../../utils/helpers');
const prisma = require('../../config/database');

async function createAdmin(req, res, next) {
  try {
    const data = await service.createAdmin(req.body);
    successResponse(res, { data }, 201, 'Admin created');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

async function findAll(req, res, next) {
  try {
    const result = await service.findAll(req.query);
    successResponse(res, result);
  } catch (err) { next(err); }
}

async function findOne(req, res, next) {
  try {
    const data = await service.findOne(req.params.id);
    successResponse(res, { data });
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const data = await service.update(req.params.id, req.body);
    successResponse(res, { data }, 200, 'Admin updated');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.remove(req.params.id);
    successResponse(res, {}, 200, 'Admin deleted');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    await service.resetPassword(req.params.id, req.body.new_password);
    successResponse(res, {}, 200, 'Password reset successfully');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

async function getAuditLogs(req, res, next) {
  try {
    const result = await service.getAuditLogs(req.query);
    successResponse(res, result);
  } catch (err) { next(err); }
}

async function clearAllData(req, res, next) {
  try {
    // Delete leaf tables first to satisfy FK constraints, then parents
    await prisma.ticketReply.deleteMany({});
    await prisma.invoice.deleteMany({});      // references Payment — must go before Payment
    await prisma.payment.deleteMany({});      // references Subscription — must go before Subscription
    await prisma.license.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.ticket.deleteMany({});
    await prisma.client.deleteMany({});
    await prisma.posDeviceAuditLog.deleteMany({});
    await prisma.posSalesReport.deleteMany({});
    await prisma.posData.deleteMany({});
    await prisma.posOperator.deleteMany({});
    await prisma.licenseDevice.deleteMany({});
    await prisma.auditLog.deleteMany({});
    successResponse(res, {}, 200, 'All data cleared');
  } catch (err) {
    next(err);
  }
}

module.exports = { createAdmin, findAll, findOne, update, remove, resetPassword, getAuditLogs, clearAllData };
