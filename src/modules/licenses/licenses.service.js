const prisma = require('../../config/database');
const { generateLicenseKey } = require('../../utils/licenseGenerator');
const { hashFingerprint, paginate, paginatedResponse } = require('../../utils/helpers');
const { getSocketManager } = require('../../websocket/socketManager');

async function generate(clientId, subscriptionId) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw { statusCode: 404, message: 'Client not found' };

  let expiryDate = null;
  if (subscriptionId) {
    const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (sub) expiryDate = sub.expiry_date;
  }

  const licenseKey = generateLicenseKey();

  return prisma.license.create({
    data: {
      client_id: clientId,
      subscription_id: subscriptionId || null,
      license_key: licenseKey,
      expiry_date: expiryDate,
      status: 'PENDING',
    },
    include: { client: { select: { business_name: true, email: true } } },
  });
}

async function findAll(query) {
  const { page, limit, skip } = paginate(query);
  const where = {};
  if (query.status) where.status = query.status;
  if (query.client_id) where.client_id = query.client_id;

  const [licenses, total] = await Promise.all([
    prisma.license.findMany({
      where,
      skip,
      take: limit,
      orderBy: { created_at: 'desc' },
      include: { client: { select: { business_name: true, email: true } } },
    }),
    prisma.license.count({ where }),
  ]);

  // Attach per-license device counts
  const keys = licenses.map((l) => l.license_key);
  const deviceRows = keys.length
    ? await prisma.licenseDevice.findMany({ where: { license_key: { in: keys } } })
    : [];
  const countByKey = deviceRows.reduce((acc, d) => {
    acc[d.license_key] = (acc[d.license_key] || 0) + 1;
    return acc;
  }, {});

  const sm = getSocketManager();
  const onlineMetas = sm ? sm.getConnectedDevicesMeta() : [];
  const onlineDeviceIds   = new Set(onlineMetas.map((d) => d.deviceId));
  const onlineLicenseKeys = new Set(onlineMetas.map((d) => d.licenseKey).filter(Boolean));
  const onlineByKey = deviceRows.reduce((acc, d) => {
    if (onlineDeviceIds.has(d.device_id) || onlineLicenseKeys.has(d.license_key))
      acc[d.license_key] = (acc[d.license_key] || 0) + 1;
    return acc;
  }, {});

  const enriched = licenses.map((l) => ({
    ...l,
    device_count: countByKey[l.license_key] || 0,
    online_devices: onlineByKey[l.license_key] || 0,
  }));

  return paginatedResponse(enriched, total, page, limit);
}

async function findOne(id) {
  const license = await prisma.license.findUnique({
    where: { id },
    include: { client: true, subscription: true },
  });
  if (!license) throw { statusCode: 404, message: 'License not found' };
  return license;
}

async function validate(licenseKey, deviceId, fingerprint) {
  const license = await prisma.license.findUnique({
    where: { license_key: licenseKey },
    include: { subscription: true },
  });

  if (!license) {
    return { valid: false, status: 'not_found', message: 'License key not found' };
  }

  if (license.device_id && license.device_id !== deviceId) {
    return { valid: false, status: 'device_mismatch', message: 'License is bound to a different device' };
  }

  if (license.status === 'EXPIRED') {
    return { valid: false, status: 'expired', message: 'License has expired', expiry_date: license.expiry_date };
  }

  if (license.status === 'SUSPENDED') {
    return { valid: false, status: 'suspended', message: 'License has been suspended' };
  }

  if (license.status === 'PENDING') {
    return { valid: false, status: 'pending', message: 'License is not yet activated' };
  }

  if (license.expiry_date && new Date() > new Date(license.expiry_date)) {
    await prisma.license.update({ where: { id: license.id }, data: { status: 'EXPIRED' } });
    return { valid: false, status: 'expired', message: 'License has expired', expiry_date: license.expiry_date };
  }

  if (!license.device_id) {
    const fingerprintHash = fingerprint ? hashFingerprint(fingerprint) : null;
    await prisma.license.update({
      where: { id: license.id },
      data: {
        device_id: deviceId,
        device_fingerprint: fingerprintHash,
        activation_date: new Date(),
        last_check: new Date(),
      },
    });
  } else {
    await prisma.license.update({ where: { id: license.id }, data: { last_check: new Date() } });
  }

  return {
    valid: true,
    status: 'active',
    message: 'License valid',
    expiry_date: license.expiry_date,
    license_id: license.id,
  };
}

async function activate(id) {
  const license = await findOne(id);
  const updated = await prisma.license.update({
    where: { id },
    data: { status: 'ACTIVE', activation_date: new Date() },
  });

  const sm = getSocketManager();
  if (sm && license.device_id) {
    sm.notifyDevice(license.device_id, 'license:activated', { licenseKey: license.license_key });
  }

  return updated;
}

async function suspend(id) {
  const license = await findOne(id);
  const updated = await prisma.license.update({ where: { id }, data: { status: 'SUSPENDED' } });

  const sm = getSocketManager();
  if (sm && license.device_id) {
    sm.notifyDevice(license.device_id, 'license:suspended', { licenseKey: license.license_key });
  }

  return updated;
}

async function revoke(id) {
  const license = await findOne(id);
  const updated = await prisma.license.update({
    where: { id },
    data: { status: 'EXPIRED', device_id: null, device_fingerprint: null },
  });

  const sm = getSocketManager();
  if (sm && license.device_id) {
    sm.notifyDevice(license.device_id, 'license:revoked', { licenseKey: license.license_key });
  }

  return updated;
}

module.exports = { generate, findAll, findOne, validate, activate, suspend, revoke };
