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
  const safeparse = (s) => {
    if (!s) return [];
    try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
  };

  const [allPosData, allSalesReports] = await Promise.all([
    prisma.posData.findMany(),
    prisma.posSalesReport.findMany({ orderBy: { report_date: 'asc' } }),
  ]);

  // Aggregate from PosSalesReport (dedicated daily summaries)
  const reportTotals = allSalesReports.reduce(
    (acc, r) => ({
      sales: acc.sales + Number(r.total_sales),
      profit: acc.profit + Number(r.total_profit),
      items: acc.items + Number(r.items_sold),
    }),
    { sales: 0, profit: 0, items: 0 }
  );

  // Monthly trend grouped by YYYY-MM
  const byMonthMap = {};
  for (const r of allSalesReports) {
    const month = r.report_date.slice(0, 7);
    if (!byMonthMap[month]) byMonthMap[month] = { sales: 0, profit: 0, items: 0 };
    byMonthMap[month].sales  += Number(r.total_sales);
    byMonthMap[month].profit += Number(r.total_profit);
    byMonthMap[month].items  += Number(r.items_sold);
  }
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const byMonth = Object.entries(byMonthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      month: MONTHS[parseInt(key.split('-')[1]) - 1] + ' ' + key.split('-')[0],
      sales: v.sales,
      profit: v.profit,
      items: v.items,
    }));

  // From PosData: capital invested and expenses per device
  let capitalInvested = 0;
  let totalExpenses = 0;
  const byDevice = [];

  for (const row of allPosData) {
    const products  = safeparse(row.products);
    const expenses  = safeparse(row.expenses);

    const capital  = products.reduce((s, p) => s + Number(p.buy_price || 0) * Number(p.available_stock || 0), 0);
    const expTotal = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);

    capitalInvested += capital;
    totalExpenses   += expTotal;

    // Per-device sales from PosSalesReport
    const deviceReports = allSalesReports.filter((r) => r.license_key === row.license_key);
    const devSales  = deviceReports.reduce((s, r) => s + Number(r.total_sales), 0);
    const devProfit = deviceReports.reduce((s, r) => s + Number(r.total_profit), 0);
    const devItems  = deviceReports.reduce((s, r) => s + Number(r.items_sold), 0);

    byDevice.push({
      license_key:      row.license_key,
      products_count:   products.length,
      capital_invested: capital,
      expenses:         expTotal,
      sales:            devSales,
      profit:           devProfit,
      items_sold:       devItems,
      net_profit:       devProfit - expTotal,
    });
  }

  const grossProfit = reportTotals.profit;
  const netProfit   = grossProfit - totalExpenses;
  const margin      = reportTotals.sales > 0 ? Math.round((grossProfit / reportTotals.sales) * 100) : 0;

  return {
    summary: {
      total_sales:       reportTotals.sales,
      gross_profit:      grossProfit,
      total_expenses:    totalExpenses,
      net_profit:        netProfit,
      capital_invested:  capitalInvested,
      items_sold:        reportTotals.items,
      gross_margin_pct:  margin,
      devices_count:     allPosData.length,
    },
    byMonth,
    byDevice,
  };
}

module.exports = { revenue, activeClients, expiredLicenses, monthlyPerformance, exportExcel, posOverview };
