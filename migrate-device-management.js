require('dotenv').config();
const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function columnExists(table, column) {
  const result = await client.execute(`PRAGMA table_info("${table}")`);
  return result.rows.some((r) => r.name === column);
}

async function tableExists(table) {
  const result = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [table]
  );
  return result.rows.length > 0;
}

async function run() {
  console.log('Running device management migration...');

  // Add new columns to LicenseDevice (idempotent checks)
  const cols = [
    { name: 'device_type',   sql: `ALTER TABLE "LicenseDevice" ADD COLUMN "device_type" TEXT NOT NULL DEFAULT 'pos'` },
    { name: 'device_name',   sql: `ALTER TABLE "LicenseDevice" ADD COLUMN "device_name" TEXT` },
    { name: 'registered_by', sql: `ALTER TABLE "LicenseDevice" ADD COLUMN "registered_by" TEXT` },
    { name: 'is_active',     sql: `ALTER TABLE "LicenseDevice" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true` },
  ];

  for (const col of cols) {
    if (await columnExists('LicenseDevice', col.name)) {
      console.log(`  Column LicenseDevice.${col.name} already exists — skipping.`);
    } else {
      await client.execute(col.sql);
      console.log(`  Added column LicenseDevice.${col.name}.`);
    }
  }

  // Create PosDeviceAuditLog table
  if (await tableExists('PosDeviceAuditLog')) {
    console.log('  Table PosDeviceAuditLog already exists — skipping.');
  } else {
    await client.execute(`
      CREATE TABLE "PosDeviceAuditLog" (
        "id"          TEXT    NOT NULL PRIMARY KEY,
        "license_key" TEXT    NOT NULL,
        "device_id"   TEXT    NOT NULL,
        "device_type" TEXT,
        "user_id"     TEXT,
        "action"      TEXT    NOT NULL,
        "result"      TEXT    NOT NULL DEFAULT 'success',
        "details"     TEXT,
        "ip_address"  TEXT,
        "created_at"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.execute(`CREATE INDEX "PosDeviceAuditLog_license_key_idx" ON "PosDeviceAuditLog"("license_key")`);
    await client.execute(`CREATE INDEX "PosDeviceAuditLog_device_id_idx"   ON "PosDeviceAuditLog"("device_id")`);
    console.log('  Created table PosDeviceAuditLog with indexes.');
  }

  console.log('Migration complete.');
  process.exit(0);
}

run().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
