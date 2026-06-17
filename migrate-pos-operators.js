require('dotenv').config();
const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function run() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS "PosOperator" (
      "id"          TEXT     NOT NULL PRIMARY KEY,
      "license_key" TEXT     NOT NULL,
      "name"        TEXT     NOT NULL,
      "username"    TEXT     NOT NULL,
      "pin_hash"    TEXT     NOT NULL,
      "role"        TEXT     NOT NULL DEFAULT 'teller',
      "is_active"   INTEGER  NOT NULL DEFAULT 1,
      "created_at"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE("license_key","username")
    )
  `);
  console.log('PosOperator table created (or already exists).');

  await client.execute(`
    CREATE INDEX IF NOT EXISTS "PosOperator_lk_idx"
    ON "PosOperator"("license_key")
  `);
  console.log('Index created.');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
