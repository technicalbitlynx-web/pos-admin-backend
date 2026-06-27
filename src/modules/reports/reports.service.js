const prisma = require('../../config/database');
const ExcelJS = require('exceljs');
const { generateInvoicePDF } = require('../../utils/pdfGenerator');

async function revenue(query) {
  const where = { status: 'APPROVED' };
  if (query.start) where.date = { ...where.date, gte: new Date(query.start) };
  if (query.end) where.date = { ...where.date, lte: new Date(query.end) };

  const payments = await prisma.payment.findMany({
    where,
    include: { client: { select: { business_name: true } } },
    orderBy: { date: 'asc' },
  });

  const total = payments.reduce((s, p) => s + Number(p.amount), 0);
  const byMethod = payments.reduce((acc, p) => {
    acc[p.method] = (acc[p.method] || 0) + Number(p.amount);
    return acc;
  }, {});

  const byMonth = payments.reduce((acc, p) => {
    const key = new Date(p.date).toISOString().slice(0, 7);
    acc[key] = (acc[key] || 0) + Number(p.amount);
    return acc;
  }, {});

  return { total, count: payments.length, byMethod, byMonth, payments };
}

async function activeClients() {
  const [total, active, suspended, pending] = await Promise.all([
    prisma.client.count(),
    prisma.client.count({ where: { status: 'ACTIVE' } }),
    prisma.client.count({ where: { status: 'SUSPENDED' } }),
    prisma.client.count({ where: { status: 'PENDING' } }),
  ]);
  return { total, active, suspended, pending };
}

async function expiredLicenses() {
  const [total, active, expired, suspended, pending] = await Promise.all([
    prisma.license.count(),
    prisma.license.count({ where: { status: 'ACTIVE' } }),
    prisma.license.count({ where: { status: 'EXPIRED' } }),
    prisma.license.count({ where: { status: 'SUSPENDED' } }),
    prisma.license.count({ where: { status: 'PENDING' } }),
  ]);

  const expiredList = await prisma.license.findMany({
    where: { status: 'EXPIRED' },
    include: { client: { select: { business_name: true, email: true, phone: true } } },
    orderBy: { expiry_date: 'desc' },
    take: 50,
  });

  return { stats: { total, active, expired, suspended, pending }, list: expiredList };
}

async function monthlyPerformance(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59);

  const [newClients, payments, tickets, newLicenses] = await Promise.all([
    prisma.client.count({ where: { created_at: { gte: start, lte: end } } }),
    prisma.payment.findMany({
      where: { status: 'APPROVED', date: { gte: start, lte: end } },
      select: { amount: true, method: true },
    }),
    prisma.ticket.findMany({
      where: { created_at: { gte: start, lte: end } },
      select: { status: true },
    }),
    prisma.license.count({ where: { activation_date: { gte: start, lte: end } } }),
  ]);

  const revenue = payments.reduce((s, p) => s + Number(p.amount), 0);
  const resolvedTickets = tickets.filter((t) => t.status === 'RESOLVED').length;

  return {
    period: `${year}-${String(month).padStart(2, '0')}`,
    new_clients: newClients,
    revenue,
    payment_count: payments.length,
    new_licenses: newLicenses,
    tickets_opened: tickets.length,
    tickets_resolved: resolvedTickets,
  };
}

async function exportExcel(type, query) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');

  if (type === 'revenue') {
    const data = await revenue(query);
    sheet.columns = [
      { header: 'Client', key: 'client', width: 30 },
      { header: 'Amount', key: 'amount', width: 15 },
      { header: 'Method', key: 'method', width: 20 },
      { header: 'Date', key: 'date', width: 20 },
    ];
    data.payments.forEach((p) => {
      sheet.addRow({
        client: p.client?.business_name || 'N/A',
        amount: Number(p.amount),
        method: p.method,
        date: new Date(p.date).toLocaleDateString(),
      });
    });
  } else if (type === 'clients') {
    const clients = await prisma.client.findMany({ orderBy: { created_at: 'desc' } });
    sheet.columns = [
      { header: 'Business Name', key: 'business_name', width: 30 },
      { header: 'Owner', key: 'owner_name', width: 25 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 20 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Created', key: 'created_at', width: 20 },
    ];
    clients.forEach((c) => sheet.addRow({ ...c, created_at: new Date(c.created_at).toLocaleDateString() }));
  } else if (type === 'licenses') {
    const licenses = await prisma.license.findMany({
      include: { client: { select: { business_name: true, email: true } } },
      orderBy: { created_at: 'desc' },
    });
    sheet.columns = [
      { header: 'License Key', key: 'license_key', width: 40 },
      { header: 'Client', key: 'client', width: 30 },
      { header: 'Device ID', key: 'device_id', width: 25 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Expiry', key: 'expiry_date', width: 20 },
    ];
    licenses.forEach((l) =>
      sheet.addRow({
        license_key: l.license_key,
        client: l.client?.business_name || 'N/A',
        device_id: l.device_id || 'Not bound',
        status: l.status,
        expiry_date: l.expiry_date ? new Date(l.expiry_date).toLocaleDateString() : 'N/A',
      })
    );
  }

  return workbook;
}

async function posOverview() {
  const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthLabel = (key) => MN[parseInt(key.split('-')[1]) - 1] + ' \'' + key.split('-')[0].slice(2);

  const [approvedPayments, adminExpenses, officers] = await Promise.all([
    prisma.payment.findMany({
      where: { status: 'APPROVED' },
      include: {
        client:   { select: { business_name: true } },
        recorder: { select: { id: true, name: true, commission_rate: true, role: true } },
      },
      orderBy: { date: 'desc' },
    }),
    prisma.adminExpense.findMany({ orderBy: { date: 'desc' } }),
    prisma.adminUser.findMany({
      where: { role: 'SALES_MANAGER', is_active: true },
      select: { id: true, name: true, email: true, commission_rate: true },
    }),
  ]);

  // ── Subscription Revenue ──────────────────────────────────────────
  const totalRevenue   = approvedPayments.reduce((s, p) => s + Number(p.amount), 0);
  const uniqueClients  = new Set(approvedPayments.map((p) => p.client_id)).size;

  const byMethod = {};
  approvedPayments.forEach((p) => { byMethod[p.method] = (byMethod[p.method] || 0) + Number(p.amount); });

  // ── Admin Expenses ────────────────────────────────────────────────
  const totalExpenses  = adminExpenses.reduce((s, e) => s + Number(e.amount), 0);
  const expByCategory  = {};
  adminExpenses.forEach((e) => { expByCategory[e.category] = (expByCategory[e.category] || 0) + Number(e.amount); });

  // ── Officer Commissions ───────────────────────────────────────────
  // Build a map: officerId → { officer meta, payments handled }
  const officerMap = {};
  for (const o of officers) {
    officerMap[o.id] = { ...o, approved_amount: 0, payment_count: 0, commission_earned: 0 };
  }
  // Also include any officer that handled payments but isn't in active SALES_MANAGER list
  for (const p of approvedPayments) {
    if (p.recorder && p.recorder.role === 'SALES_MANAGER') {
      const oid = p.recorder.id;
      if (!officerMap[oid]) {
        officerMap[oid] = { id: oid, name: p.recorder.name, email: '', commission_rate: p.recorder.commission_rate, approved_amount: 0, payment_count: 0, commission_earned: 0 };
      }
      officerMap[oid].approved_amount += Number(p.amount);
      officerMap[oid].payment_count   += 1;
    }
  }
  for (const o of Object.values(officerMap)) {
    o.commission_earned = +(o.approved_amount * o.commission_rate).toFixed(2);
  }
  const officerRows = Object.values(officerMap).sort((a, b) => b.commission_earned - a.commission_earned);
  const totalCommissions = officerRows.reduce((s, o) => s + o.commission_earned, 0);

  // ── Net Profit ────────────────────────────────────────────────────
  const netProfit = totalRevenue - totalExpenses - totalCommissions;

  // ── Monthly Trend ─────────────────────────────────────────────────
  const mMap = {};
  for (const p of approvedPayments) {
    const d   = new Date(p.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!mMap[key]) mMap[key] = { revenue: 0, expenses: 0, commissions: 0 };
    mMap[key].revenue += Number(p.amount);
    if (p.recorder?.role === 'SALES_MANAGER') {
      mMap[key].commissions += Number(p.amount) * (p.recorder.commission_rate || 0);
    }
  }
  for (const e of adminExpenses) {
    const d   = new Date(e.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!mMap[key]) mMap[key] = { revenue: 0, expenses: 0, commissions: 0 };
    mMap[key].expenses += Number(e.amount);
  }
  const byMonth = Object.entries(mMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      month: monthLabel(key),
      revenue:     +v.revenue.toFixed(2),
      expenses:    +v.expenses.toFixed(2),
      commissions: +v.commissions.toFixed(2),
      net:         +(v.revenue - v.expenses - v.commissions).toFixed(2),
    }));

  return {
    summary: {
      total_revenue:     totalRevenue,
      total_expenses:    totalExpenses,
      total_commissions: totalCommissions,
      net_profit:        netProfit,
      payment_count:     approvedPayments.length,
      unique_clients:    uniqueClients,
      active_officers:   officerRows.length,
      expense_count:     adminExpenses.length,
    },
    byMonth,
    byMethod,
    expensesByCategory: expByCategory,
    officers: officerRows,
    recentPayments: approvedPayments.slice(0, 20).map((p) => ({
      id: p.id, client: p.client?.business_name || 'Unknown',
      amount: Number(p.amount), method: p.method, date: p.date,
      officer: p.recorder?.name || null,
    })),
    recentExpenses: adminExpenses.slice(0, 10).map((e) => ({
      id: e.id, amount: Number(e.amount), category: e.category, description: e.description, date: e.date,
    })),
  };
}

async function getCapitalConfig() {
  const configs = await prisma.adminConfig.findMany({ where: { key: { in: ['capital_apk', 'capital_exe'] } } });
  const result = { apk: 0, exe: 0 };
  configs.forEach((c) => { result[c.key.replace('capital_', '')] = Number(c.value) || 0; });
  return result;
}

async function setCapitalConfig({ apk, exe }) {
  const { randomUUID } = require('crypto');
  await Promise.all([
    prisma.adminConfig.upsert({ where: { key: 'capital_apk' }, update: { value: String(Number(apk) || 0) }, create: { id: randomUUID(), key: 'capital_apk', value: String(Number(apk) || 0) } }),
    prisma.adminConfig.upsert({ where: { key: 'capital_exe' }, update: { value: String(Number(exe) || 0) }, create: { id: randomUUID(), key: 'capital_exe', value: String(Number(exe) || 0) } }),
  ]);
  return { apk: Number(apk) || 0, exe: Number(exe) || 0 };
}

module.exports = { revenue, activeClients, expiredLicenses, monthlyPerformance, exportExcel, posOverview, getCapitalConfig, setCapitalConfig };
