require('dotenv').config();
const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function run() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS AdminConfig (
      id         TEXT PRIMARY KEY,
      key        TEXT NOT NULL UNIQUE,
      value      TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('AdminConfig table created (or already exists).');
  console.log('Migration complete.');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
