const bcrypt = require('bcryptjs');
const prisma = require('../../config/database');
const { successResponse, errorResponse, paginate, paginatedResponse } = require('../../utils/helpers');

// POST /api/v1/marketing/register  (PUBLIC)
async function register(req, res, next) {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) return errorResponse(res, 'name, email and password are required', 400);

    const exists = await prisma.adminUser.findUnique({ where: { email } });
    if (exists) return errorResponse(res, 'Email already in use', 409);

    const hashed = await bcrypt.hash(password, 12);
    const officer = await prisma.adminUser.create({
      data: { name, email, phone: phone || null, password: hashed, role: 'SALES_MANAGER', commission_rate: 0.10 },
    });

    const { password: _, ...safe } = officer;
    return successResponse(res, { data: safe }, 201, 'Officer registered successfully');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

// GET /api/v1/marketing/officers  (admin)
async function getOfficers(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);

    const officers = await prisma.adminUser.findMany({
      where: { role: 'SALES_MANAGER' },
      skip,
      take: limit,
      orderBy: { created_at: 'desc' },
      select: { id: true, name: true, email: true, phone: true, commission_rate: true, is_active: true, created_at: true },
    });
    const total = await prisma.adminUser.count({ where: { role: 'SALES_MANAGER' } });

    // Enrich with earnings
    const ids = officers.map((o) => o.id);
    const [clientCounts, payments] = await Promise.all([
      prisma.client.groupBy({ by: ['onboarded_by'], where: { onboarded_by: { in: ids } }, _count: { id: true } }),
      prisma.payment.findMany({
        where: { recorded_by: { in: ids } },
        select: { recorded_by: true, amount: true, status: true },
      }),
    ]);

    const clientMap = Object.fromEntries(clientCounts.map((r) => [r.onboarded_by, r._count.id]));

    const enriched = officers.map((o) => {
      const myPayments = payments.filter((p) => p.recorded_by === o.id);
      const pendingAmount  = myPayments.filter((p) => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
      const approvedAmount = myPayments.filter((p) => p.status === 'APPROVED').reduce((s, p) => s + p.amount, 0);
      return {
        ...o,
        clients_count:   clientMap[o.id] || 0,
        pending_amount:  pendingAmount,
        approved_amount: approvedAmount,
        commission_earned: +(approvedAmount * o.commission_rate).toFixed(2),
      };
    });

    return successResponse(res, paginatedResponse(enriched, total, page, limit));
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

// GET /api/v1/marketing/my-stats  (SALES_MANAGER own)
async function myStats(req, res, next) {
  try {
    const officerId = req.admin.id;
    const officer = await prisma.adminUser.findUnique({
      where: { id: officerId },
      select: { name: true, email: true, phone: true, commission_rate: true, created_at: true },
    });
    if (!officer) return errorResponse(res, 'Officer not found', 404);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalClients, monthClients, payments] = await Promise.all([
      prisma.client.count({ where: { onboarded_by: officerId } }),
      prisma.client.count({ where: { onboarded_by: officerId, created_at: { gte: startOfMonth } } }),
      prisma.payment.findMany({
        where: { recorded_by: officerId },
        select: { amount: true, status: true, date: true, client: { select: { business_name: true } } },
        orderBy: { date: 'desc' },
      }),
    ]);

    const pendingAmount  = payments.filter((p) => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
    const approvedAmount = payments.filter((p) => p.status === 'APPROVED').reduce((s, p) => s + p.amount, 0);
    const commissionEarned = +(approvedAmount * officer.commission_rate).toFixed(2);

    // Month-by-month breakdown (last 6 months)
    const monthlyMap = {};
    payments.forEach((p) => {
      const key = p.date ? new Date(p.date).toISOString().slice(0, 7) : 'unknown';
      if (!monthlyMap[key]) monthlyMap[key] = { month: key, total: 0, approved: 0 };
      monthlyMap[key].total   += p.amount;
      if (p.status === 'APPROVED') monthlyMap[key].approved += p.amount;
    });
    const monthly = Object.values(monthlyMap).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6);

    return successResponse(res, {
      data: {
        officer,
        total_clients:    totalClients,
        clients_this_month: monthClients,
        pending_amount:   pendingAmount,
        approved_amount:  approvedAmount,
        commission_rate:  officer.commission_rate,
        commission_earned: commissionEarned,
        monthly,
      },
    });
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

// GET /api/v1/marketing/my-clients  (SALES_MANAGER own)
async function myClients(req, res, next) {
  try {
    const officerId = req.admin.id;
    const { page, limit, skip } = paginate(req.query);

    const [clients, total] = await Promise.all([
      prisma.client.findMany({
        where: { onboarded_by: officerId },
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          subscriptions: { select: { plan_name: true, status: true, expiry_date: true }, orderBy: { created_at: 'desc' }, take: 1 },
          payments:      { select: { amount: true, status: true, method: true }, orderBy: { date: 'desc' }, take: 1 },
          licenses:      { select: { license_key: true, status: true }, orderBy: { created_at: 'desc' }, take: 1 },
        },
      }),
      prisma.client.count({ where: { onboarded_by: officerId } }),
    ]);

    return successResponse(res, paginatedResponse(clients, total, page, limit));
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

// PATCH /api/v1/marketing/officers/:id/commission  (SUPER_ADMIN)
async function updateCommission(req, res, next) {
  try {
    const { id } = req.params;
    const { commission_rate } = req.body;
    if (commission_rate == null || commission_rate < 0 || commission_rate > 1)
      return errorResponse(res, 'commission_rate must be between 0 and 1', 400);

    const officer = await prisma.adminUser.update({
      where: { id },
      data: { commission_rate },
      select: { id: true, name: true, email: true, commission_rate: true },
    });
    return successResponse(res, { data: officer }, 200, 'Commission rate updated');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

module.exports = { register, getOfficers, myStats, myClients, updateCommission };
