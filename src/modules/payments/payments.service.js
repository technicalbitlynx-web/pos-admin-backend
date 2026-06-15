const prisma = require('../../config/database');
const { paginate, paginatedResponse, generateInvoiceNumber } = require('../../utils/helpers');
const { generateLicenseKey } = require('../../utils/licenseGenerator');
const { getSocketManager } = require('../../websocket/socketManager');

async function record(data, adminId, adminRole) {
  const { client_id, subscription_id, method, reference_number, notes } = data;
  const amount = parseFloat(data.amount);
  if (isNaN(amount) || amount <= 0) throw { statusCode: 400, message: 'Invalid amount' };

  const client = await prisma.client.findUnique({ where: { id: client_id } });
  if (!client) throw { statusCode: 404, message: 'Client not found' };

  // SALES_MANAGER (marketing officers) record PENDING payments; others auto-approve
  const isSalesManager = adminRole === 'SALES_MANAGER';

  const payment = await prisma.$transaction(async (tx) => {
    const p = await tx.payment.create({
      data: {
        client_id,
        subscription_id: subscription_id || null,
        amount,
        method,
        reference_number: reference_number || null,
        notes: notes || null,
        status: isSalesManager ? 'PENDING' : 'APPROVED',
        approved_by_id: isSalesManager ? null : adminId,
        recorded_by: adminId,
      },
      include: { client: { select: { business_name: true, email: true } } },
    });

    // Only auto-activate subscription/license when payment is immediately approved
    if (!isSalesManager && subscription_id) {
      const sub = await tx.subscription.update({
        where: { id: subscription_id },
        data: { status: 'ACTIVE' },
      });
      await tx.client.update({ where: { id: client_id }, data: { status: 'ACTIVE' } });

      const licenseCount = await tx.license.count({ where: { subscription_id } });
      if (licenseCount === 0) {
        await tx.license.create({
          data: {
            client_id,
            subscription_id,
            license_key: generateLicenseKey(),
            status: 'ACTIVE',
            activation_date: new Date(),
            expiry_date: sub.expiry_date || null,
          },
        });
      } else {
        await tx.license.updateMany({
          where: { subscription_id, status: 'PENDING' },
          data: { status: 'ACTIVE', activation_date: new Date() },
        });
      }

      const invoiceNumber = generateInvoiceNumber();
      await tx.invoice.create({ data: { client_id, payment_id: p.id, invoice_number: invoiceNumber, amount } });
    }

    return p;
  });

  if (!isSalesManager) {
    const sm = getSocketManager();
    if (sm && client_id) sm.notifyClient(client_id, 'payment:approved', { paymentId: payment.id });
  }

  return payment;
}

async function findAll(query) {
  const { page, limit, skip } = paginate(query);
  const where = {};
  if (query.status) where.status = query.status;
  if (query.client_id) where.client_id = query.client_id;
  if (query.method) where.method = query.method;

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take: limit,
      orderBy: { date: 'desc' },
      include: { client: { select: { business_name: true, email: true } }, invoice: true },
    }),
    prisma.payment.count({ where }),
  ]);

  return paginatedResponse(payments, total, page, limit);
}

async function findOne(id) {
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { client: true, subscription: true, invoice: true, approved_by: { select: { name: true, email: true } } },
  });
  if (!payment) throw { statusCode: 404, message: 'Payment not found' };
  return payment;
}

async function approve(id, adminId) {
  const payment = await prisma.payment.findUnique({ where: { id }, include: { subscription: true } });
  if (!payment) throw { statusCode: 404, message: 'Payment not found' };
  if (payment.status !== 'PENDING') throw { statusCode: 400, message: 'Payment is not pending' };

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.payment.update({
      where: { id },
      data: { status: 'APPROVED', approved_by_id: adminId },
    });

    if (payment.subscription_id) {
      const sub = await tx.subscription.update({
        where: { id: payment.subscription_id },
        data: { status: 'ACTIVE' },
      });
      await tx.client.update({
        where: { id: payment.client_id },
        data: { status: 'ACTIVE' },
      });

      const licenseCount = await tx.license.count({ where: { subscription_id: payment.subscription_id } });
      if (licenseCount === 0) {
        await tx.license.create({
          data: {
            client_id: payment.client_id,
            subscription_id: payment.subscription_id,
            license_key: generateLicenseKey(),
            status: 'ACTIVE',
            activation_date: new Date(),
            expiry_date: sub.expiry_date || null,
          },
        });
      } else {
        await tx.license.updateMany({
          where: { subscription_id: payment.subscription_id, status: 'PENDING' },
          data: { status: 'ACTIVE', activation_date: new Date() },
        });
      }
    }

    const invoiceNumber = generateInvoiceNumber();
    await tx.invoice.create({
      data: {
        client_id: payment.client_id,
        payment_id: id,
        invoice_number: invoiceNumber,
        amount: payment.amount,
      },
    });

    return p;
  });

  const sm = getSocketManager();
  if (sm && payment.client_id) {
    sm.notifyClient(payment.client_id, 'payment:approved', { paymentId: id });
  }

  return updated;
}

async function reject(id, adminId, reason) {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) throw { statusCode: 404, message: 'Payment not found' };
  if (payment.status !== 'PENDING') throw { statusCode: 400, message: 'Payment is not pending' };

  return prisma.payment.update({
    where: { id },
    data: { status: 'FAILED', approved_by_id: adminId, notes: reason || payment.notes },
  });
}

async function getRevenue(query) {
  const { start, end } = query;
  const where = { status: 'APPROVED' };
  if (start || end) {
    where.date = {};
    if (start) where.date.gte = new Date(start);
    if (end) where.date.lte = new Date(end);
  }

  const payments = await prisma.payment.findMany({
    where,
    select: { amount: true, method: true, date: true },
  });

  const total = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const byMethod = payments.reduce((acc, p) => {
    acc[p.method] = (acc[p.method] || 0) + Number(p.amount);
    return acc;
  }, {});

  return { total, byMethod, count: payments.length };
}

module.exports = { record, findAll, findOne, approve, reject, getRevenue };
