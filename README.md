# PesaPos — Admin Backend

Back-office and device-sync backend for the **PesaPos** point-of-sale platform.

It serves two distinct clients:

1. **Admin back-office** — staff log in (JWT + role-based access) to manage clients,
   subscriptions, payments, invoices, licenses, support tickets and reports.
2. **POS devices** — shop point-of-sale apps authenticate with a **license key** to
   validate their licence, sync sales, and push/pull their data in real time across
   multiple devices.

**Stack:** Node.js · Express · Prisma ORM · Turso / libSQL (SQLite-compatible) ·
Socket.IO · JWT · Winston.

---

## Architecture

A clean modular monolith. Each domain lives in `src/modules/<domain>/` and follows a
strict three-layer pattern:

```
routes  →  controller  →  service
(URL +     (HTTP glue)     (business logic
 middleware)               + Prisma DB calls)
```

To understand any feature, read those three files for the module.

```
src/
├── server.js          Boots HTTP + Socket.IO, connects DB, starts cron jobs
├── app.js             Express app: middleware + mounts every /api/v1/* route
├── config/
│   ├── config.js      Central env-driven config
│   ├── database.js    Prisma client over the libSQL (Turso) adapter
│   ├── redis.js       In-memory token store (Redis-compatible interface)
│   └── mailer.js      Nodemailer SMTP transport
├── middleware/
│   ├── auth.js        JWT verification (+ logout blacklist)
│   ├── rbac.js        Role → permission authorization
│   ├── rateLimiter.js Per-route rate limits
│   ├── auditLog.js    Writes admin actions to AuditLog
│   └── errorHandler.js
├── modules/           auth, clients, subscriptions, payments, licenses,
│                      invoices, tickets, reports, admin, pos, marketing, expenses
├── jobs/
│   └── subscriptionExpiry.js   Hourly cron: expires lapsed subscriptions
├── websocket/
│   ├── posSocket.js          Real-time multi-device POS sync
│   └── socketManager.js
└── utils/             logger, helpers, licenseGenerator, pdfGenerator
```

### Two authentication models

| Surface | Auth | Routes |
|---|---|---|
| Admin back-office | JWT (Bearer token) + RBAC role | `/api/v1/auth`, `/clients`, `/payments`, … |
| POS devices | License key (in body) | `/api/v1/pos/validate-license`, `/sync-all`, `/load-all`, … |

### Roles (RBAC)

Defined in `src/middleware/rbac.js`:

- `SUPER_ADMIN` — full access (`*`)
- `FINANCE_OFFICER` — payments, invoices, read reports/clients
- `SUPPORT_AGENT` — tickets, read clients/operators
- `SALES_MANAGER` — clients, subscriptions, create licenses/payments, read reports

---

## Data model

Twenty Prisma models (`prisma/schema.prisma`). Core business chain:

```
Client → Subscription (from a SubscriptionPlan) → Payment → Invoice (PDF)
                                                 ↘ License (license_key used by POS)
```

Device side: `LicenseDevice`, `PosOperator`, `PosData`, `PosSalesReport`,
`PosDeviceAuditLog`. Back-office: `AdminUser`, `AdminExpense`, `AdminConfig`,
`AuditLog`, `Ticket` / `TicketReply`.

> **Note:** the datasource is SQLite, which has no native enums. Status fields are
> plain strings; the allowed values are documented at the top of `schema.prisma`.

---

## Getting started (local development)

### Prerequisites
- Node.js 18+
- npm

### 1. Install
```bash
npm install
```

### 2. Configure environment
Copy the example and fill it in:
```bash
cp .env.example .env
```

For a **fully local** setup (no cloud account needed), point Prisma and the libSQL
adapter at a local SQLite file:
```env
DATABASE_URL="file:../dev.db"     # Prisma CLI (relative to prisma/)
TURSO_DATABASE_URL="file:./dev.db" # runtime libSQL adapter (relative to repo root)
TURSO_AUTH_TOKEN=
JWT_SECRET=local_dev_secret_change_me
```

To run against **Turso cloud** instead, set `TURSO_DATABASE_URL` /
`TURSO_AUTH_TOKEN` to your Turso credentials.

### 3. Create the schema and seed
```bash
npx prisma generate
npx prisma db push        # create tables in the local DB
node prisma/seed.js       # default admins + subscription plans
```

### 4. Run
```bash
npm run dev               # nodemon, http://localhost:3000
# or
npm start
```

Verify:
```bash
curl http://localhost:3000/health
```

### Default seeded logins

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@posadmin.com` | `Admin@123456` |
| Finance | `finance@posadmin.com` | `Finance@123456` |
| Support | `support@posadmin.com` | `Support@123456` |

> Change these immediately in any non-local environment.

---

## API

Base path: `/api/v1`. Health check: `GET /health`.

| Prefix | Module | Purpose |
|---|---|---|
| `/auth` | auth | Login, refresh, logout, change password |
| `/clients` | clients | Client (merchant) management |
| `/subscriptions` | subscriptions | Plans and subscription lifecycle |
| `/payments` | payments | Record / approve payments |
| `/invoices` | invoices | Invoice generation (PDF) |
| `/licenses` | licenses | License keys + device slots |
| `/tickets` | tickets | Support tickets and replies |
| `/reports` | reports | Financial / operational reports |
| `/admin` | admin | Admin users, config, danger zone |
| `/expenses` | expenses | Back-office expense tracking |
| `/marketing` | marketing | Marketing endpoints |
| `/pos` | pos | License validation + device data sync (license-key auth) |

### Example: login
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@posadmin.com","password":"Admin@123456"}'
```
Returns `{ accessToken, refreshToken, admin }`. Pass the access token as
`Authorization: Bearer <token>` on protected routes.

---

## Real-time sync

`src/websocket/posSocket.js` runs a Socket.IO server alongside Express. POS devices
join a room keyed by their license and exchange `pos:data-push` events, keeping a
shop's manager and cashier devices in sync (last-write-wins merge).

---

## Scripts

| Script | Action |
|---|---|
| `npm run dev` | Start with nodemon (auto-reload) |
| `npm start` | `prisma generate` then start the server |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:generate` | `prisma generate` |
| `npm run db:seed` | Seed default admins + plans |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:reset` | Reset the database (destructive) |

Standalone migration helpers (run once with `node <file>`):
`migrate-device-management.js`, `migrate-pos-credentials.js`,
`migrate-pos-operators.js`, `migrate-license-slots.js`, `migrate-expenses.js`,
`migrate-admin-config.js`, `seed-plans.js`.

---

## Deployment

- **Vercel** — `vercel.json` routes all traffic to `api/index.js` (the Express app
  as a serverless function).
- **Render** — `render.yaml` defines a web service (`node src/server.js`) plus a
  keep-alive cron that pings `/health` every 10 minutes.
- **Docker** — `Dockerfile` + `docker-compose.yml` for containerized runs.

### Required environment variables (production)

`NODE_ENV`, `PORT`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `DATABASE_URL`,
`JWT_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `ALLOWED_ORIGINS`,
`STORAGE_PATH`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, and SMTP settings for
email/invoices.

---

## Notes

- **Redis is in-memory.** `src/config/redis.js` implements the Redis interface with a
  `Map`; it backs the JWT logout blacklist only. Tokens reset on restart and it does
  not share state across instances. Swap in real Redis (`ioredis`) for multi-instance
  deployments.
- **Prisma vs runtime split.** The Prisma CLI reads `DATABASE_URL`; the running app
  uses the libSQL adapter with `TURSO_DATABASE_URL`. Keep both pointing at the same
  database.
