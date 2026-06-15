const prisma = require('../../config/database');
const { successResponse, errorResponse } = require('../../utils/helpers');
const { hashFingerprint } = require('../../utils/helpers');

async function requireActiveLicense(license_key) {
  if (!license_key) { const e = new Error('license_key is required'); e.statusCode = 400; throw e; }
  const lic = await prisma.license.findUnique({ where: { license_key } });
  if (!lic || lic.status !== 'ACTIVE') { const e = new Error('Invalid or inactive license'); e.statusCode = 403; throw e; }
  return lic;
}

async function validateLicense(req, res) {
  try {
    const { license_key, device_id, fingerprint } = req.body;
    if (!license_key) return errorResponse(res, 'license_key is required', 400);

    const license = await prisma.license.findUnique({
      where: { license_key },
      include: { subscription: true, client: { select: { business_name: true, status: true } } },
    });

    if (!license) return successResponse(res, { data: { valid: false, status: 'not_found', message: 'License key not found' } });

    if (license.status === 'SUSPENDED') {
      return successResponse(res, { data: { valid: false, status: 'suspended', message: 'License suspended' } });
    }

    if (license.status === 'EXPIRED' || (license.expiry_date && new Date() > new Date(license.expiry_date))) {
      if (license.status !== 'EXPIRED') {
        await prisma.license.update({ where: { id: license.id }, data: { status: 'EXPIRED' } });
      }
      return successResponse(res, { data: { valid: false, status: 'expired', message: 'License has expired', expiry_date: license.expiry_date } });
    }

    // Auto-activate PENDING license on first POS use; record the first device
    if (license.status === 'PENDING') {
      const fingerprintHash = fingerprint ? hashFingerprint(fingerprint) : null;
      await prisma.license.update({
        where: { id: license.id },
        data: {
          status: 'ACTIVE',
          device_id: device_id || null,
          device_fingerprint: fingerprintHash,
          activation_date: new Date(),
          last_check: new Date(),
        },
      });
    } else if (!license.device_id && device_id) {
      const fingerprintHash = fingerprint ? hashFingerprint(fingerprint) : null;
      await prisma.license.update({
        where: { id: license.id },
        data: { device_id, device_fingerprint: fingerprintHash, activation_date: new Date(), last_check: new Date() },
      });
    } else {
      await prisma.license.update({ where: { id: license.id }, data: { last_check: new Date() } });
    }

    // Track every device that validates this license (multi-device support)
    if (device_id) {
      const platform = req.headers['user-agent']?.toLowerCase().includes('android') ? 'android' : 'desktop';
      await prisma.licenseDevice.upsert({
        where: { license_key_device_id: { license_key, device_id } },
        update: { last_seen: new Date(), platform },
        create: { license_key, device_id, platform, last_seen: new Date() },
      });
    }

    return successResponse(res, {
      data: {
        valid: true,
        status: 'active',
        message: 'License valid',
        license_id: license.id,
        expiry_date: license.expiry_date,
        plan_name: license.subscription?.plan_name || null,
        business_name: license.client?.business_name || null,
      },
    });
  } catch (err) {
    return errorResponse(res, err.message || 'Validation error', err.statusCode || 500);
  }
}

async function syncSales(req, res) {
  try {
    const { license_key, device_id, report_date, total_sales, total_profit, items_sold, payload } = req.body;
    if (!license_key) return errorResponse(res, 'license_key is required', 400);

    const license = await prisma.license.findUnique({ where: { license_key } });
    if (!license || license.status !== 'ACTIVE') {
      return errorResponse(res, 'Invalid or inactive license', 403);
    }

    const date = report_date || new Date().toISOString().slice(0, 10);

    await prisma.posSalesReport.upsert({
      where: {
        // Use a synthetic unique key: license_key + date
        id: `${license_key}-${date}`,
      },
      update: {
        total_sales: total_sales || 0,
        total_profit: total_profit || 0,
        items_sold: items_sold || 0,
        payload: payload ? JSON.stringify(payload) : null,
      },
      create: {
        id: `${license_key}-${date}`,
        license_key,
        device_id: device_id || null,
        report_date: date,
        total_sales: total_sales || 0,
        total_profit: total_profit || 0,
        items_sold: items_sold || 0,
        payload: payload ? JSON.stringify(payload) : null,
      },
    });

    return successResponse(res, { data: { synced: true, date } });
  } catch (err) {
    return errorResponse(res, err.message || 'Sync error', err.statusCode || 500);
  }
}

async function getStatus(req, res) {
  try {
    const { license_key } = req.query;
    if (!license_key) return errorResponse(res, 'license_key is required', 400);

    const license = await prisma.license.findUnique({
      where: { license_key },
      include: {
        subscription: { select: { plan_name: true, expiry_date: true, status: true } },
        client: { select: { business_name: true, status: true } },
      },
    });

    if (!license) return errorResponse(res, 'License not found', 404);

    return successResponse(res, {
      data: {
        license_status: license.status,
        expiry_date: license.expiry_date,
        last_check: license.last_check,
        plan_name: license.subscription?.plan_name || null,
        subscription_status: license.subscription?.status || null,
        subscription_expiry: license.subscription?.expiry_date || null,
        business_name: license.client?.business_name || null,
        client_status: license.client?.status || null,
      },
    });
  } catch (err) {
    return errorResponse(res, err.message || 'Error', err.statusCode || 500);
  }
}

async function getDevices(req, res) {
  try {
    const { getSocketManager } = require('../../websocket/socketManager');
    const sm = getSocketManager();
    const onlineMetas = sm ? sm.getConnectedDevicesMeta() : [];
    const onlineDeviceIds   = new Set(onlineMetas.map((d) => d.deviceId));
    const onlineLicenseKeys = new Set(onlineMetas.map((d) => d.licenseKey).filter(Boolean));
    const metaByDeviceId    = new Map(onlineMetas.map((d) => [d.deviceId, d]));
    const metaByLicenseKey  = new Map(onlineMetas.filter((d) => d.licenseKey).map((d) => [d.licenseKey, d]));

    // Load all licenses for lookup
    const licenses = await prisma.license.findMany({
      include: {
        client: { select: { business_name: true } },
        subscription: { select: { plan_name: true, expiry_date: true } },
      },
    });
    const licByKey = new Map(licenses.map((l) => [l.license_key, l]));

    // Load every registered device (one row per unique device+license)
    const allDeviceRows = await prisma.licenseDevice.findMany({
      orderBy: { last_seen: 'desc' },
    });

    const entries = allDeviceRows.map((d) => {
      const lic    = licByKey.get(d.license_key);
      const isOnline = onlineDeviceIds.has(d.device_id) || onlineLicenseKeys.has(d.license_key);
      const live   = metaByDeviceId.get(d.device_id) || metaByLicenseKey.get(d.license_key) || {};
      const { socketId: _s, deviceId: _d, licenseKey: _lk, ...liveMeta } = live;
      return {
        deviceId:       d.device_id,
        licenseKey:     d.license_key,
        licenseId:      lic?.id || null,
        platform:       d.platform || 'desktop',
        lastSeen:       d.last_seen,
        businessName:   lic?.client?.business_name || null,
        planName:       lic?.subscription?.plan_name || null,
        expiryDate:     lic?.expiry_date || lic?.subscription?.expiry_date || null,
        activationDate: lic?.activation_date || null,
        licenseStatus:  lic?.status || null,
        online:         isOnline,
        ...liveMeta,
      };
    });

    // Include licenses with a device_id but no LicenseDevice record yet (legacy/first-run)
    const knownDeviceIds = new Set(allDeviceRows.map((d) => d.device_id));
    for (const lic of licenses) {
      if (lic.device_id && !knownDeviceIds.has(lic.device_id)) {
        const isOnline = onlineDeviceIds.has(lic.device_id) || onlineLicenseKeys.has(lic.license_key);
        const live = metaByDeviceId.get(lic.device_id) || metaByLicenseKey.get(lic.license_key) || {};
        const { socketId: _s, deviceId: _d, licenseKey: _lk, ...liveMeta } = live;
        entries.push({
          deviceId:       lic.device_id,
          licenseKey:     lic.license_key,
          licenseId:      lic.id,
          platform:       'desktop',
          lastSeen:       lic.last_check || lic.activation_date,
          businessName:   lic.client?.business_name || null,
          planName:       lic.subscription?.plan_name || null,
          expiryDate:     lic.expiry_date || lic.subscription?.expiry_date || null,
          activationDate: lic.activation_date,
          licenseStatus:  lic.status,
          online:         isOnline,
          ...liveMeta,
        });
      }
    }

    // Sort: online first, then by lastSeen desc
    entries.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
    });

    return successResponse(res, { data: entries });
  } catch (err) {
    return errorResponse(res, err.message || 'Error', 500);
  }
}

async function sendDeviceCommand(req, res) {
  try {
    const { getSocketManager } = require('../../websocket/socketManager');
    const { command, payload } = req.body;
    const { deviceId } = req.params;
    if (!command) return errorResponse(res, 'command is required', 400);
    const sm = getSocketManager();
    const sent = sm ? sm.notifyDevice(deviceId, `pos:${command}`, payload || {}) : false;
    if (!sent) return errorResponse(res, 'Device not connected', 404);
    return successResponse(res, { data: { sent: true } }, 200, 'Command sent');
  } catch (err) {
    return errorResponse(res, err.message || 'Error', 500);
  }
}

async function syncAllData(req, res) {
  try {
    const { license_key, products, sales, credits, suppliers, expenses, stock_log, quotations, customers, purchase_orders, shifts } = req.body;
    await requireActiveLicense(license_key);
    const data = {};
    if (products        !== undefined) data.products        = JSON.stringify(products);
    if (sales           !== undefined) data.sales           = JSON.stringify(sales);
    if (credits         !== undefined) data.credits         = JSON.stringify(credits);
    if (suppliers       !== undefined) data.suppliers       = JSON.stringify(suppliers);
    if (expenses        !== undefined) data.expenses        = JSON.stringify(expenses);
    if (stock_log       !== undefined) data.stock_log       = JSON.stringify(stock_log);
    if (quotations      !== undefined) data.quotations      = JSON.stringify(quotations);
    if (customers       !== undefined) data.customers       = JSON.stringify(customers);
    if (purchase_orders !== undefined) data.purchase_orders = JSON.stringify(purchase_orders);
    if (shifts          !== undefined) data.shifts          = JSON.stringify(shifts);
    await prisma.posData.upsert({
      where:  { license_key },
      update: data,
      create: { license_key, ...data },
    });
    return successResponse(res, { data: { synced: true } });
  } catch (err) {
    return errorResponse(res, err.message || 'Sync error', err.statusCode || 500);
  }
}

async function loadAllData(req, res) {
  try {
    const { license_key } = req.query;
    await requireActiveLicense(license_key);
    const row = await prisma.posData.findUnique({ where: { license_key } });
    if (!row) return successResponse(res, { data: null });
    const p = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
    return successResponse(res, { data: {
      products:        p(row.products),
      sales:           p(row.sales),
      credits:         p(row.credits),
      suppliers:       p(row.suppliers),
      expenses:        p(row.expenses),
      stock_log:       p(row.stock_log),
      quotations:      p(row.quotations),
      customers:       p(row.customers),
      purchase_orders: p(row.purchase_orders),
      shifts:          p(row.shifts),
      updated_at:      row.updated_at,
    }});
  } catch (err) {
    return errorResponse(res, err.message || 'Load error', err.statusCode || 500);
  }
}

module.exports = { validateLicense, syncSales, getStatus, getDevices, sendDeviceCommand, syncAllData, loadAllData };
