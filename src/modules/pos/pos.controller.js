const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../../config/database');
const { successResponse, errorResponse } = require('../../utils/helpers');
const { hashFingerprint } = require('../../utils/helpers');

// ─── Device Management Constants ─────────────────────────────────────────────

const DEVICE_LIMITS = {
  basic:        { manager_desktop: 1, manager_mobile: 1 },
  intermediate: { manager_desktop: 2, manager_mobile: 2 },
  professional: { manager_desktop: 5, manager_mobile: 5 },
  enterprise:   { manager_desktop: null, manager_mobile: null }, // null = unlimited
};

function normalizePlatform(platform) {
  if (!platform) return 'desktop';
  const p = platform.toLowerCase();
  if (p === 'mobile' || p === 'android' || p === 'ios') return 'mobile';
  return 'desktop';
}

function getPlanLimits(planName) {
  const key = (planName || 'basic').toLowerCase().replace(/[\s-]+/g, '_');
  return DEVICE_LIMITS[key] || DEVICE_LIMITS.basic;
}

async function getManagerDeviceCount(license_key, platform, excludeDeviceId = null) {
  const where = {
    license_key,
    device_type: 'manager',
    is_active: true,
    platform: normalizePlatform(platform),
  };
  if (excludeDeviceId) where.device_id = { not: excludeDeviceId };
  return prisma.licenseDevice.count({ where });
}

async function verifyManagerPin(license_key, username, pin) {
  if (!username || !pin) return false;
  const operator = await prisma.posOperator.findFirst({
    where: { license_key, username, is_active: true, role: 'manager' },
  });
  if (!operator) return false;
  return bcrypt.compare(String(pin), operator.pin_hash);
}

async function logDeviceAudit({ license_key, device_id, device_type, user_id, action, result, details, ip_address }) {
  try {
    await prisma.posDeviceAuditLog.create({
      data: {
        id: uuidv4(),
        license_key,
        device_id,
        device_type: device_type || null,
        user_id: user_id || null,
        action,
        result: result || 'success',
        details: details ? JSON.stringify(details) : null,
        ip_address: ip_address || null,
      },
    });
  } catch (e) {
    console.error('Device audit log failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

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

    // Determine device registration status and subscription limits
    let device_info = { registered: false, device_type: null };
    let device_limits = null;

    if (device_id) {
      const deviceRow = await prisma.licenseDevice.findUnique({
        where: { license_key_device_id: { license_key, device_id } },
      });
      // device_name is only set by an explicit registerDevice call — use it to distinguish
      // a row auto-created by validate-license (device_name=null) from a properly registered device
      if (deviceRow && deviceRow.is_active && deviceRow.device_name !== null) {
        device_info = { registered: true, device_type: deviceRow.device_type };
      }
    }

    const planName = license.subscription?.plan_name || 'basic';
    const limits = getPlanLimits(planName);
    const [usedDesktop, usedMobile] = await Promise.all([
      prisma.licenseDevice.count({ where: { license_key, device_type: 'manager', is_active: true, platform: 'desktop' } }),
      prisma.licenseDevice.count({ where: { license_key, device_type: 'manager', is_active: true, platform: 'mobile' } }),
    ]);
    device_limits = {
      manager_desktop: limits.manager_desktop,
      manager_mobile: limits.manager_mobile,
      used_manager_desktops: usedDesktop,
      used_manager_mobiles: usedMobile,
    };

    return successResponse(res, {
      data: {
        valid: true,
        status: 'active',
        message: 'License valid',
        license_id: license.id,
        expiry_date: license.expiry_date,
        plan_name: license.subscription?.plan_name || null,
        business_name: license.client?.business_name || null,
        device_info,
        device_limits,
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

    const [row, operators] = await Promise.all([
      prisma.posData.findUnique({ where: { license_key } }),
      prisma.posOperator.findMany({
        where: { license_key, is_active: true },
        select: { id: true, name: true, username: true, role: true },
      }),
    ]);

    const p = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
    return successResponse(res, { data: {
      products:        row ? p(row.products)        : null,
      sales:           row ? p(row.sales)           : null,
      credits:         row ? p(row.credits)         : null,
      suppliers:       row ? p(row.suppliers)       : null,
      expenses:        row ? p(row.expenses)        : null,
      stock_log:       row ? p(row.stock_log)       : null,
      quotations:      row ? p(row.quotations)      : null,
      customers:       row ? p(row.customers)       : null,
      purchase_orders: row ? p(row.purchase_orders) : null,
      shifts:          row ? p(row.shifts)          : null,
      updated_at:      row?.updated_at || null,
      operators,
    }});
  } catch (err) {
    return errorResponse(res, err.message || 'Load error', err.statusCode || 500);
  }
}

// ─── POS Operator CRUD ───────────────────────────────────────────────────────

async function verifyOperatorPin(req, res) {
  try {
    const { license_key, username, pin } = req.body;
    if (!license_key || !username || !pin) {
      return errorResponse(res, 'license_key, username and pin are required', 400);
    }
    await requireActiveLicense(license_key);
    const operator = await prisma.posOperator.findFirst({
      where: { license_key, username, is_active: true },
    });
    if (!operator) return successResponse(res, { data: { valid: false } });
    const match = await bcrypt.compare(String(pin), operator.pin_hash);
    if (!match) return successResponse(res, { data: { valid: false } });
    return successResponse(res, {
      data: { valid: true, operator: { id: operator.id, name: operator.name, username: operator.username, role: operator.role } },
    });
  } catch (err) {
    return errorResponse(res, err.message || 'Error', err.statusCode || 500);
  }
}

async function listOperators(req, res, next) {
  try {
    const { license_key } = req.query;
    if (!license_key) return errorResponse(res, 'license_key is required', 400);
    const operators = await prisma.posOperator.findMany({
      where: { license_key },
      select: { id: true, name: true, username: true, role: true, is_active: true, created_at: true, updated_at: true },
      orderBy: { created_at: 'asc' },
    });
    return successResponse(res, { data: operators });
  } catch (err) {
    next(err);
  }
}

async function createOperator(req, res, next) {
  try {
    const { license_key, name, username, pin, role } = req.body;
    if (!license_key || !name || !username || !pin) {
      return errorResponse(res, 'license_key, name, username and pin are required', 400);
    }
    if (!/^\d{4,6}$/.test(String(pin))) {
      return errorResponse(res, 'PIN must be 4–6 digits', 400);
    }
    const lic = await prisma.license.findUnique({ where: { license_key } });
    if (!lic) return errorResponse(res, 'License not found', 404);

    const pin_hash = await bcrypt.hash(String(pin), 10);
    const operator = await prisma.posOperator.create({
      data: { license_key, name, username, pin_hash, role: role || 'teller' },
      select: { id: true, name: true, username: true, role: true, is_active: true, created_at: true },
    });
    return successResponse(res, { data: operator }, 201, 'Operator created');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

async function updateOperator(req, res, next) {
  try {
    const { id } = req.params;
    const { name, username, pin, role, is_active } = req.body;
    const data = {};
    if (name      !== undefined) data.name      = name;
    if (username  !== undefined) data.username  = username;
    if (role      !== undefined) data.role      = role;
    if (is_active !== undefined) data.is_active = is_active;
    if (pin !== undefined) {
      if (!/^\d{4,6}$/.test(String(pin))) return errorResponse(res, 'PIN must be 4–6 digits', 400);
      data.pin_hash = await bcrypt.hash(String(pin), 10);
    }
    const operator = await prisma.posOperator.update({
      where: { id },
      data,
      select: { id: true, name: true, username: true, role: true, is_active: true, updated_at: true },
    });
    return successResponse(res, { data: operator }, 200, 'Operator updated');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

async function removeOperator(req, res, next) {
  try {
    await prisma.posOperator.delete({ where: { id: req.params.id } });
    return successResponse(res, {}, 200, 'Operator deleted');
  } catch (err) {
    if (err.statusCode) return errorResponse(res, err.message, err.statusCode);
    next(err);
  }
}

// ─── POS Device Registration & Management ────────────────────────────────────

async function registerDevice(req, res) {
  try {
    const { license_key, device_id, device_type, platform, manager_username, manager_pin, access_code } = req.body;
    let device_name = req.body.device_name;

    if (!license_key || !device_id || !device_type) {
      return errorResponse(res, 'license_key, device_id and device_type are required', 400);
    }
    if (!['manager', 'pos'].includes(device_type)) {
      return errorResponse(res, 'device_type must be "manager" or "pos"', 400);
    }

    const license = await prisma.license.findUnique({
      where: { license_key },
      include: { subscription: { select: { plan_name: true } } },
    });
    if (!license || license.status !== 'ACTIVE') {
      return errorResponse(res, 'Invalid or inactive license', 403);
    }

    const normalizedPlatform = normalizePlatform(platform);

    // ── Manager registration: require manager PIN if any operator already exists ──
    if (device_type === 'manager') {
      const anyManager = await prisma.posOperator.findFirst({
        where: { license_key, is_active: true, role: 'manager' },
      });
      if (anyManager) {
        if (!manager_username || !manager_pin) {
          return errorResponse(res, 'Manager credentials are required to register a manager device', 403);
        }
        const authorized = await verifyManagerPin(license_key, manager_username, manager_pin);
        if (!authorized) {
          await logDeviceAudit({ license_key, device_id, device_type, action: 'register', result: 'denied', details: { reason: 'invalid_pin' }, ip_address: req.ip });
          return errorResponse(res, 'Invalid manager credentials', 403);
        }
      }

      const limits = getPlanLimits(license.subscription?.plan_name);
      const limitKey = normalizedPlatform === 'mobile' ? 'manager_mobile' : 'manager_desktop';
      const limit = limits[limitKey];

      if (limit !== null) {
        const existing = await prisma.licenseDevice.findUnique({
          where: { license_key_device_id: { license_key, device_id } },
        });
        const isNewManagerDevice = !existing || existing.device_type !== 'manager' || !existing.is_active;
        if (isNewManagerDevice) {
          const used = await getManagerDeviceCount(license_key, normalizedPlatform);
          if (used >= limit) {
            await logDeviceAudit({ license_key, device_id, device_type, user_id: manager_username || null, action: 'register', result: 'denied', details: { reason: 'limit_exceeded', limit, used }, ip_address: req.ip });
            return errorResponse(res, `Manager ${normalizedPlatform} device limit reached (${limit}/${limit}). Deregister an existing device or upgrade your plan.`, 403);
          }
        }
      }
    }

    // ── POS registration: require a valid access code ─────────────────────────
    if (device_type === 'pos') {
      if (!access_code) {
        // Check if any credentials exist — if so, require one
        const credCount = await prisma.$queryRawUnsafe(
          `SELECT COUNT(*) as cnt FROM PosDeviceCredential WHERE license_key = ? AND is_active = 1`,
          license_key
        );
        if (Number(credCount[0]?.cnt || 0) > 0) {
          return errorResponse(res, 'Access code required. Ask your manager for a POS device access code.', 403);
        }
        // No credentials exist yet — allow legacy open registration
      } else {
        const creds = await prisma.$queryRawUnsafe(
          `SELECT id, slot_name, access_code_hash FROM PosDeviceCredential WHERE license_key = ? AND is_active = 1`,
          license_key
        );
        let matchedCred = null;
        for (const cred of creds) {
          if (await bcrypt.compare(String(access_code).trim(), String(cred.access_code_hash))) {
            matchedCred = cred; break;
          }
        }
        if (!matchedCred) {
          await logDeviceAudit({ license_key, device_id, device_type, action: 'register', result: 'denied', details: { reason: 'invalid_access_code' }, ip_address: req.ip });
          return errorResponse(res, 'Invalid access code. Ask your manager to create or share a POS device credential.', 403);
        }
        // Credential matched — use slot name as device name and claim the slot
        device_name = matchedCred.slot_name;
        await prisma.$executeRawUnsafe(
          `UPDATE PosDeviceCredential SET device_id = ?, updated_at = ? WHERE id = ?`,
          device_id, new Date().toISOString(), matchedCred.id
        );
      }
    }

    const row = await prisma.licenseDevice.upsert({
      where: { license_key_device_id: { license_key, device_id } },
      update: {
        device_type,
        device_name: device_name || null,
        registered_by: manager_username || null,
        platform: normalizedPlatform,
        is_active: true,
        last_seen: new Date(),
      },
      create: {
        id: uuidv4(),
        license_key,
        device_id,
        device_type,
        device_name: device_name || null,
        platform: normalizedPlatform,
        registered_by: manager_username || null,
        is_active: true,
      },
    });

    await logDeviceAudit({
      license_key, device_id, device_type,
      user_id: manager_username || null,
      action: 'register', result: 'success',
      ip_address: req.ip,
    });

    // Notify all devices on this license that a new device was registered
    const io = req.app.get('io');
    if (io && license_key) {
      io.to('license:' + license_key).emit('pos:device-registered', {
        device_id,
        device_name: row.device_name,
        device_type: row.device_type,
      });
    }

    return successResponse(
      res,
      { data: { registered: true, device_type: row.device_type, device_id, device_name: row.device_name, platform: normalizedPlatform } },
      201,
      'Device registered'
    );
  } catch (err) {
    return errorResponse(res, err.message || 'Registration error', err.statusCode || 500);
  }
}

async function listPosDevices(req, res) {
  try {
    const { license_key } = req.query;
    if (!license_key) return errorResponse(res, 'license_key is required', 400);

    const license = await prisma.license.findUnique({
      where: { license_key },
      include: { subscription: { select: { plan_name: true } } },
    });
    if (!license || license.status !== 'ACTIVE') {
      return errorResponse(res, 'Invalid or inactive license', 403);
    }

    const devices = await prisma.licenseDevice.findMany({
      where: { license_key, is_active: true },
      orderBy: { last_seen: 'desc' },
      select: {
        device_id: true,
        device_type: true,
        device_name: true,
        platform: true,
        registered_by: true,
        last_seen: true,
        created_at: true,
      },
    });

    const limits = getPlanLimits(license.subscription?.plan_name);
    const [usedDesktop, usedMobile] = await Promise.all([
      prisma.licenseDevice.count({ where: { license_key, device_type: 'manager', is_active: true, platform: 'desktop' } }),
      prisma.licenseDevice.count({ where: { license_key, device_type: 'manager', is_active: true, platform: 'mobile' } }),
    ]);

    return successResponse(res, {
      data: {
        devices,
        device_limits: {
          manager_desktop: limits.manager_desktop,
          manager_mobile: limits.manager_mobile,
          used_manager_desktops: usedDesktop,
          used_manager_mobiles: usedMobile,
          plan_name: license.subscription?.plan_name || 'Basic',
        },
      },
    });
  } catch (err) {
    return errorResponse(res, err.message || 'Error', 500);
  }
}

async function reassignDevice(req, res) {
  try {
    const { deviceId } = req.params;
    const { license_key, new_device_type, manager_username, manager_pin } = req.body;

    if (!license_key || !new_device_type || !manager_username || !manager_pin) {
      return errorResponse(res, 'license_key, new_device_type, manager_username and manager_pin are required', 400);
    }
    if (!['manager', 'pos'].includes(new_device_type)) {
      return errorResponse(res, 'new_device_type must be "manager" or "pos"', 400);
    }

    const authorized = await verifyManagerPin(license_key, manager_username, manager_pin);
    if (!authorized) {
      await logDeviceAudit({
        license_key, device_id: deviceId, device_type: new_device_type,
        user_id: manager_username, action: 'reassign', result: 'denied',
        details: { reason: 'invalid_pin' }, ip_address: req.ip,
      });
      return errorResponse(res, 'Manager PIN verification failed', 403);
    }

    const existing = await prisma.licenseDevice.findFirst({
      where: { license_key, device_id: deviceId, is_active: true },
    });
    if (!existing) return errorResponse(res, 'Device not found or not active', 404);

    if (new_device_type === 'manager' && existing.device_type !== 'manager') {
      const license = await prisma.license.findUnique({
        where: { license_key },
        include: { subscription: { select: { plan_name: true } } },
      });
      const limits = getPlanLimits(license?.subscription?.plan_name);
      const normalizedPlatform = normalizePlatform(existing.platform);
      const limit = normalizedPlatform === 'mobile' ? limits.manager_mobile : limits.manager_desktop;

      if (limit !== null) {
        const used = await getManagerDeviceCount(license_key, normalizedPlatform, deviceId);
        if (used >= limit) {
          await logDeviceAudit({
            license_key, device_id: deviceId, device_type: new_device_type,
            user_id: manager_username, action: 'reassign', result: 'denied',
            details: { reason: 'limit_exceeded', limit, used }, ip_address: req.ip,
          });
          return errorResponse(res, `Manager ${normalizedPlatform} device limit reached (${limit})`, 403);
        }
      }
    }

    await prisma.licenseDevice.updateMany({
      where: { license_key, device_id: deviceId },
      data: { device_type: new_device_type, registered_by: manager_username },
    });

    await logDeviceAudit({
      license_key, device_id: deviceId, device_type: new_device_type,
      user_id: manager_username, action: 'reassign', result: 'success',
      details: { old_type: existing.device_type, new_type: new_device_type },
      ip_address: req.ip,
    });

    try {
      const { getSocketManager } = require('../../websocket/socketManager');
      const sm = getSocketManager();
      if (sm) sm.notifyDevice(deviceId, 'pos:refresh', { reason: 'device_reassigned' });
    } catch {}

    return successResponse(res, { data: { reassigned: true, device_id: deviceId, new_device_type } }, 200, 'Device reassigned');
  } catch (err) {
    return errorResponse(res, err.message || 'Error', 500);
  }
}

async function deregisterDevice(req, res) {
  try {
    const { deviceId } = req.params;
    const { license_key, manager_username, manager_pin } = req.body;

    if (!license_key || !manager_username || !manager_pin) {
      return errorResponse(res, 'license_key, manager_username and manager_pin are required', 400);
    }

    const authorized = await verifyManagerPin(license_key, manager_username, manager_pin);
    if (!authorized) {
      await logDeviceAudit({
        license_key, device_id: deviceId,
        user_id: manager_username, action: 'deregister', result: 'denied',
        details: { reason: 'invalid_pin' }, ip_address: req.ip,
      });
      return errorResponse(res, 'Manager PIN verification failed', 403);
    }

    const existing = await prisma.licenseDevice.findFirst({
      where: { license_key, device_id: deviceId, is_active: true },
    });
    if (!existing) return errorResponse(res, 'Device not found or already deregistered', 404);

    await prisma.licenseDevice.updateMany({
      where: { license_key, device_id: deviceId },
      data: { is_active: false },
    });

    await logDeviceAudit({
      license_key, device_id: deviceId, device_type: existing.device_type,
      user_id: manager_username, action: 'deregister', result: 'success',
      ip_address: req.ip,
    });

    try {
      const { getSocketManager } = require('../../websocket/socketManager');
      const sm = getSocketManager();
      if (sm) sm.notifyDevice(deviceId, 'pos:refresh', { reason: 'device_deregistered' });
    } catch {}

    return successResponse(res, { data: { deregistered: true, device_id: deviceId } }, 200, 'Device deregistered');
  } catch (err) {
    return errorResponse(res, err.message || 'Error', 500);
  }
}

// ─── POS Device Credentials ──────────────────────────────────────────────────

async function createDeviceCredential(req, res) {
  try {
    const { license_key, manager_username, manager_pin, slot_name, access_code } = req.body;
    if (!license_key || !manager_username || !manager_pin || !slot_name || !access_code) {
      return errorResponse(res, 'license_key, manager_username, manager_pin, slot_name, and access_code are required', 400);
    }
    const code = String(access_code).trim();
    if (!/^\d{4,8}$/.test(code)) return errorResponse(res, 'access_code must be 4–8 digits', 400);

    const authorized = await verifyManagerPin(license_key, manager_username, manager_pin);
    if (!authorized) return errorResponse(res, 'Invalid manager credentials', 403);

    const hash = await bcrypt.hash(code, 10);
    const now  = new Date().toISOString();

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM PosDeviceCredential WHERE license_key = ? AND slot_name = ?`,
      license_key, slot_name
    );
    if (existing.length > 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE PosDeviceCredential SET access_code_hash = ?, device_id = NULL, is_active = 1, updated_at = ? WHERE license_key = ? AND slot_name = ?`,
        hash, now, license_key, slot_name
      );
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO PosDeviceCredential (id, license_key, slot_name, access_code_hash, device_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
        uuidv4(), license_key, slot_name, hash, now, now
      );
    }
    return successResponse(res, { slot_name }, 201, 'POS device credential created');
  } catch (err) {
    return errorResponse(res, err.message || 'Failed to create credential', 500);
  }
}

async function listDeviceCredentials(req, res) {
  try {
    const { license_key } = req.query;
    if (!license_key) return errorResponse(res, 'license_key is required', 400);
    const creds = await prisma.$queryRawUnsafe(
      `SELECT id, slot_name, device_id, is_active, created_at, updated_at FROM PosDeviceCredential WHERE license_key = ? AND is_active = 1 ORDER BY created_at DESC`,
      license_key
    );
    return successResponse(res, { credentials: creds }, 200, 'OK');
  } catch (err) {
    return errorResponse(res, err.message || 'Failed to list credentials', 500);
  }
}

async function deleteDeviceCredential(req, res) {
  try {
    const { id } = req.params;
    const { license_key, manager_username, manager_pin } = req.body;
    if (!license_key || !manager_username || !manager_pin) {
      return errorResponse(res, 'license_key, manager_username and manager_pin are required', 400);
    }
    const authorized = await verifyManagerPin(license_key, manager_username, manager_pin);
    if (!authorized) return errorResponse(res, 'Invalid manager credentials', 403);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM PosDeviceCredential WHERE id = ? AND license_key = ?`, id, license_key
    );
    if (!rows.length) return errorResponse(res, 'Credential not found', 404);
    await prisma.$executeRawUnsafe(`DELETE FROM PosDeviceCredential WHERE id = ?`, id);
    return successResponse(res, {}, 200, 'Credential deleted');
  } catch (err) {
    return errorResponse(res, err.message || 'Failed to delete credential', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  validateLicense, syncSales, getStatus, getDevices, sendDeviceCommand, syncAllData, loadAllData,
  verifyOperatorPin, listOperators, createOperator, updateOperator, removeOperator,
  registerDevice, listPosDevices, reassignDevice, deregisterDevice,
  createDeviceCredential, listDeviceCredentials, deleteDeviceCredential,
};
