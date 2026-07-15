# Car Workshop Backend

Multi-branch car workshop management platform API (Express + MySQL). Ported and
rebranded from a delivery-service SaaS backend — see "Domain mapping" below for
what changed.

## Stack

- Node.js (ES modules), Express
- MySQL (`mysql2/promise`), no ORM — raw SQL via a connection pool
- JWT auth (`jsonwebtoken`) + `bcryptjs` password hashing
- Socket.IO for real-time work-order/mechanic-location updates
- Stripe for subscription billing
- Nodemailer (SMTP) for email, optional Twilio for SMS, optional Firebase for
  push notifications, optional AWS S3 for file storage (falls back to local
  disk under `uploads/` if not configured)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template and fill in real values:
   ```bash
   cp .env.example .env
   ```
   At minimum, set `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` and `JWT_SECRET`.
   Everything else (Stripe, SMS, push, S3) is optional — unconfigured
   integrations degrade gracefully (e.g. SMS logs to console instead of
   sending, uploads fall back to local disk).
3. Create the database and load the schema:
   ```bash
   mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS car_workshop CHARACTER SET utf8mb4"
   mysql -u root -p car_workshop < src/migrations/car_workshop.sql
   mysql -u root -p car_workshop < src/migrations/post/00_schema_patches.sql
   mysql -u root -p car_workshop < src/migrations/post/01_seed_countries.sql
   ```
4. (Optional) Seed demo data — a workshop branch, mechanics, customers,
   vehicles, and work orders:
   ```bash
   npm run seed
   ```
5. Start the API:
   ```bash
   npm start        # node src/server.js
   npm run dev       # node --watch src/server.js, restarts on file changes
   ```

The server listens on `PORT` (default `4000`) and exposes a health check at
`GET /health`.

## Project layout

```
src/
  config.js            env-driven config object
  server.js             Express app entrypoint, mounts every router, starts Socket.IO + cron jobs
  routes/                one file per API resource, mounted under /api/<name>
  lib/                    DB pool, email/SMS/push/notify helpers, financial calc, cron jobs
  middleware/             auth, workshop (multi-tenant) context, plan/feature gating, API-key auth
  migrations/             car_workshop.sql (full schema) + post/ patches + country seed data
  seeds/                  seed-demo-data.js — demo workshop/mechanics/customers/vehicles/work orders
```

## Domain mapping

This backend was ported from a delivery-service platform. Renamed concepts:

| Delivery concept | Car-workshop concept |
|---|---|
| tenants | workshops (a branch/location) |
| drivers | mechanics |
| clients | customers |
| orders | work orders |
| zones | service bays (physical bay/lane, not a geo-zone) |
| packages | parts (inventory used in a repair) |
| dispatch | job-assignment (assigning work orders to mechanics/bays) |
| tracking | service-status (customer-facing job status lookup) |
| pickup | vehicle-pickup (mobile mechanic / tow pickup of a customer's vehicle) |
| cash on delivery (COD) | cash-payment (pay-at-pickup / cash reconciliation) |
| returns | warranty-claims (post-completion rework requests) |
| driver earnings | mechanic-earnings (labor commission) |

A new `vehicles` table/module was added (not present in the original delivery
schema): customer-owned vehicles (make, model, year, plate, VIN, color),
linked to `customers` and referenced from `work_orders.vehicle_id`.

Two source files were intentionally **not** ported: `multi-stop.js` and
`routes/routing.js` (an OSRM multi-waypoint delivery-route proxy). A car
workshop work order isn't a multi-stop geographic delivery route — see
`src/routes/_DROPPED_multi-stop_and_routing.md` for the full rationale. The
one still-useful piece (road-distance estimation for a mobile-mechanic
vehicle pickup) was kept as `getRoadDistance()` in the trimmed
`src/lib/routing.js`.

## Notes

- No live MySQL connection is required for the process to *start* — the
  connection pool connects lazily on first query. `npm start` without a
  reachable database will boot the HTTP server and fail only when a request
  actually hits the DB.
- Demo/default login after seeding: username `admin`, password `Demo@12345`
  (change this immediately in any real deployment).
