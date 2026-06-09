const prisma = require('../../config/database');
const { successResponse, errorResponse } = require('../../utils/helpers');
const { hashFingerprint } = require('../../utils/helpers');

async function validateLicense(req, res) {
  try {
    const { license_key, device_id, fingerprint } = req.body;
    if (!license_key) return errorResponse(res, 'license_key is required', 400);

    const license = await prisma.license.findUnique({
      where: { license_key },
      include: { subscription: true, client: { select: { business_name: true, status: true } } },
    });

    if (!license) return successResponse(res, { data: { valid: false, status: 'not_found', message: 'License key not found' } });

    if (license.device_id && device_id && license.device_id !== device_id) {
      return successResponse(res, { data: { valid: false, status: 'device_mismatch', message: 'License bound to a different device' } });
    }

    if (license.status === 'SUSPENDED') {
      return successResponse(res, { data: { valid: false, status: 'suspended', message: 'License suspended' } });
    }

    if (license.status === 'EXPIRED' || (license.expiry_date && new Date() > new Date(license.expiry_date))) {
      if (license.status !== 'EXPIRED') {
        await prisma.license.update({ where: { id: license.id }, data: { status: 'EXPIRED' } });
      }
      return successResponse(res, { data: { valid: false, status: 'expired', message: 'License has expired', expiry_date: license.expiry_date } });
    }

    // Auto-activate PENDING license on first POS use
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
      // Bind device on first use (ACTIVE but unbound)
      const fingerprintHash = fingerprint ? hashFingerprint(fingerprint) : null;
      await prisma.license.update({
        where: { id: license.id },
        data: { device_id, device_fingerprint: fingerprintHash, activation_date: new Date(), last_check: new Date() },
      });
    } else if (license.device_id) {
      await prisma.license.update({ where: { id: license.id }, data: { last_check: new Date() } });
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
    const onlineMap = new Map(onlineMetas.map((d) => [d.deviceId, d]));

    const licenses = await prisma.license.findMany({
      where: { status: 'ACTIVE' },
      include: {
        client: { select: { business_name: true } },
        subscription: { select: { plan_name: true, expiry_date: true } },
      },
      orderBy: { activation_date: 'desc' },
    });

    const devices = licenses.map((lic) => {
      const live = onlineMap.get(lic.device_id) || {};
      return {
        deviceId: lic.device_id,
        licenseKey: lic.license_key,
        licenseId: lic.id,
        businessName: live.businessName || lic.client?.business_name || null,
        planName: live.planName || lic.subscription?.plan_name || null,
        expiryDate: lic.expiry_date || lic.subscription?.expiry_date || null,
        activationDate: lic.activation_date,
        online: onlineMap.has(lic.device_id),
        ...live,
      };
    });

    return successResponse(res, { data: devices });
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

module.exports = { validateLicense, syncSales, getStatus, getDevices, sendDeviceCommand };
