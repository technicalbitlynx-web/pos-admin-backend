-- Add device management columns to LicenseDevice
ALTER TABLE "LicenseDevice" ADD COLUMN "device_type" TEXT NOT NULL DEFAULT 'pos';
ALTER TABLE "LicenseDevice" ADD COLUMN "device_name" TEXT;
ALTER TABLE "LicenseDevice" ADD COLUMN "registered_by" TEXT;
ALTER TABLE "LicenseDevice" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable PosDeviceAuditLog
CREATE TABLE "PosDeviceAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "license_key" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "device_type" TEXT,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'success',
    "details" TEXT,
    "ip_address" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "PosDeviceAuditLog_license_key_idx" ON "PosDeviceAuditLog"("license_key");
CREATE INDEX "PosDeviceAuditLog_device_id_idx" ON "PosDeviceAuditLog"("device_id");
