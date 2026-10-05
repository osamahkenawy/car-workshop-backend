# Pioneer Car Service Center — Handover

**Written 5 October 2026.** Everything needed to pick this up on another machine.

> This is a copy. The canonical version, together with `docs/`, `deploy/`
> and the roadmap, lives in **github.com/osamahkenawy/pioneer-workshop-docs**.
If you are an assistant reading this cold: read this file top to bottom before
touching anything. Section 7 is the part people get wrong.

---

## 1. What this is

A multi-branch car workshop management platform for Pioneer Car Service Center
(Abu Dhabi, Sharjah, Dubai, Al Ain), built for Mwasalat.

- **Backend** — Node 18+ / Express (ES modules) / MySQL via `mysql2/promise`.
  No ORM; raw SQL through a connection pool. JWT auth, Socket.IO, Nodemailer.
- **Frontend** — React 18 + Vite, lazy routes, i18next across **12 locales**
  (en, ar, es, fr, hi, ja, pt, sw, tl, tr, ur, zh).
- **Staging** — `ubuntu@130.61.83.110`, served at `workshop.pioneeruae.com`.

The backend was **ported from a delivery-service SaaS**. That matters more than
it sounds — see section 7.

---

## 2. Folder layout

```
car-workshp/                        ← this folder; everything lives here
├── HANDOVER.md                     ← you are here
├── car-workshop-backend/           ← git repo → github.com/osamahkenawy/car-workshop-backend
├── car-workshop-frontend/          ← git repo → github.com/osamahkenawy/car-workshop-frontend
├── docs/
│   ├── roadmap/                    ← ROADMAP-EXEC.html (current), roadmap PDFs
│   ├── process/                    ← process diagrams, the source work-order PDF
│   ├── plans/                      ← team leader plan, architecture, code review
│   ├── reports/                    ← KPI, CX survey, complaints workbooks
│   └── brand/                      ← logo
├── deploy/                         ← deployment scripts and nginx config
├── reference-data/                 ← CSV extracts from the legacy system (gitignored, ~15 MB)
├── process-diagrams/               ← DUPLICATE of docs/process, safe to delete
└── .claude/launch.json             ← dev server definitions
```

`process-diagrams/` is a leftover duplicate. I was blocked from deleting it
automatically; remove it by hand when convenient.

---

## 3. Running it

Two services. From this folder:

```bash
cd car-workshop-backend && npm install && npm run dev    # port 4000
cd car-workshop-frontend && npm install && npm run dev   # port 5173
```

Vite proxies `/api`, `/uploads` and `/socket.io` to `localhost:4000`
(`vite.config.js:11`), so the frontend needs no `VITE_API_URL` in development.

**Verifying the wiring:** `curl http://localhost:5173/api/customers` should
return **401**, not a connection error. 401 means the proxy reached the API and
the API correctly rejected an unauthenticated request. That is the healthy
answer.

### Database

MySQL, database `car_workshop`. First-time setup is in
`car-workshop-backend/README.md`. There is **no migration runner** — migrations
are applied by hand, in filename order:

```bash
mysql -u root -p car_workshop < src/migrations/<file>.sql
```

Every migration is written to be **idempotent**: each guards on
`information_schema` and uses `PREPARE`/`EXECUTE`/`DEALLOCATE`, so re-running
one is safe. Keep writing them that way.

Migrations that must be applied on a fresh machine (newest four, all added in
the last stretch of work):

| File | What it does |
|---|---|
| `20260914_estimate_approval_token.sql` | Tokenised customer approve/reject link |
| `20260914_team_leader_and_time_booking.sql` | Team leader structure, time bookings |
| `20260914_work_order_status_rename_widen.sql` | Widens the status enum (expand half only — see 7) |
| `20260917_work_order_intake_redesign.sql` | Customer class, vehicle identity, odometer, fleet intake tables |

---

## 4. GitHub

Two repos, both on `main`, both **fully committed and pushed as of this
handover**:

- `github.com/osamahkenawy/car-workshop-backend`
- `github.com/osamahkenawy/car-workshop-frontend`

On the new machine:

```bash
git clone https://github.com/osamahkenawy/car-workshop-backend.git
git clone https://github.com/osamahkenawy/car-workshop-frontend.git
```

`docs/`, `deploy/` and `reference-data/` are **not in either repo** — copy this
whole folder across, or put them in a third repo.

### Secrets — read this before pushing anything

- `.env` is gitignored in both repos and has never been committed. Keep it that way.
- `deploy/backend.staging.env` holds a **real `JWT_SECRET` and DB password**.
  It is not in any repo. A stripped `deploy/backend.staging.env.example` sits
  beside it with the 52 key names and no values — commit that one, never the other.
- **Known issue:** live GitHub personal access tokens were found in plaintext
  git remote URLs on the staging host. They have not been rotated. Do that
  before anyone else gets access to that server.

---

## 5. What was built most recently

Six commits, three per repo, all pushed. In dependency order:

**Backend**
1. `2971497` — Work order intake redesign. Customer class (internal: fleet/asset,
   external: insurance/walk-in), vehicle identity fields (plate code, plate
   emirate, engine number, fleet code), and VIN + odometer + complaint made
   mandatory at intake.
2. `c6bc857` — **The estimate pricing fix.** Detail in section 6.
3. `e6eb53b` — Team leader board and fleet coordinator intake page.

**Frontend**
1. `c6769b4` — New job card form rebuilt as a five-step wizard.
2. `101f09b` — Estimate screens: build an estimate, customer approval page.
3. `83074a7` — Team leader board, fleet intake form and staff queue, 12 locales.

### The five-step wizard

`src/components/NewWorkOrderModal.jsx`. Steps: Customer → Vehicle → Complaint
and service → Estimate and charges → Assign and review. 1020px wide, two-column,
stacks below 900px.

Two things worth knowing before editing it:

- `customerMode` is **derived**, not stored: it is a function of customer class
  and the external option. Do not reintroduce it as state — that is exactly how
  the two got to disagree before.
- All borders are written **longhand** (`borderStyle`/`borderWidth`/`borderColor`).
  Mixing the `border` shorthand with `borderColor` on the same element makes
  React warn on every re-render. Keep longhand.

### Fleet coordinator intake

The vehicle information section of the work order, on its own page, opened from
a tokenised link with no login, so a fleet coordinator can fill it in before the
vehicle arrives. Staff review submissions in a queue that shows what the
coordinator entered against what the system already knows.

`POST /fleet-intake/:id/convert` contains **the first database transaction in
this codebase** (`pool.getConnection()` → `beginTransaction`). A half-converted
submission would leave an orphan vehicle with no work order, which is why.
If you add multi-table writes elsewhere, copy this pattern.

---

## 6. The estimate pricing bug (found, fixed, verified)

Worth understanding because the shape of it recurs elsewhere in this codebase.

`convertEstimateToWorkOrder` copied the **estimate header totals** onto the new
work order. Those totals are computed at create/update time over *every* line
regardless of `customer_status`, and approving or rejecting an individual line
writes back only `service_estimates.status`. So a partially approved estimate
produced a job card priced at the **full quote, including the lines the customer
had just rejected**. `POST /:id/convert-to-work-order` admits
`partially_approved` explicitly, so this was reachable by design.

It reached the customer: `work_orders.service_fee` becomes the invoice subtotal
when the job card is confirmed (`invoices.js:413`).

Underneath it, a larger one: `service_fee` was carrying **labour only**.
`createInvoiceFromWorkOrder` reads nothing but `service_fee`, so parts and sublet
were dropped from the invoice of *every* converted estimate — not just the
partially approved ones.

**Fixed** in `estimates.js`: the job card is now priced from the approved lines,
and `service_fee` carries the whole approved subtotal.

**Verified live** against a 945 estimate (labour 100, parts 500, parts 300) with
the 300 line rejected → job card `service_fee` 600, total 630, auto-invoice
subtotal 600. Before the fix the same estimate invoiced 100. All test data was
removed afterwards; `work_orders` is back to 18,730 rows.

> **The underlying design issue is still there.** `invoices.js:413` reading a
> single `service_fee` column as the entire subtotal is fragile — any future
> charge type that is not folded into `service_fee` will silently never be
> billed. I did not restructure it; that is a bigger change than the bug warranted.

---

## 7. Traps — the things that have already cost time

**The platform was renamed from a delivery service.** Columns and tables still
carry delivery-era names. An "empty page" or a 500 is very often a column that
was renamed on one side only. Check the actual schema before believing the code.

**`users.role` is a fixed enum that predates the `roles` table.** Roles added
since — `team_leader`, `quality_coordinator` — do **not** appear in it and can
only ever be identified by `roles.slug`. `authMiddleware` now exposes this as
`user.role_slug`. Use that, never `user.role`, for any role added recently.

**The status enum rename is half done.** `20260914_work_order_status_rename_widen.sql`
is the *expand* half of an expand/contract migration: old and new vocabularies
both validate right now. Roughly **167 call sites** still read the old names.
The contract half has not been done. Do not remove the old values until they have
all been migrated.

**`req.userId` is wrong in about 6 other backend route files.** Not fixed; it was
out of scope each time it came up. Worth a sweep.

**Line endings.** `core.autocrlf=true` on this machine, but backend and frontend
files are **LF on disk**. `sed -i` is safe here. Git will warn about LF→CRLF on
almost every file; that warning is expected and harmless.

**`GROUP BY` + aggregates.** Use an `EXISTS` subquery, not a `JOIN`, when
filtering a query that already groups — a join multiplies rows and silently
inflates the aggregates.

**iconoir-react does not have** `Building2`, `Hash`, `Gauge` or `AlertCircle`.
The substitutes in use are `Building`, `Barcode`, `DashboardSpeed`, `WarningCircle`.

**Killing a stuck backend on Windows.** `pkill` does not work. Use:

```bash
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
```

I once spent a while debugging a fix that "didn't work" because the responding
server was the pre-edit instance.

---

## 8. Known gaps — confirmed, not speculation

### The estimate pipeline has no staff screen

**This is the biggest one.** Verified by reading the code during this handover:

- The frontend makes exactly **four** estimate API calls: `POST /estimates`,
  `POST /estimates/:id/send`, and two from the public customer approval page.
- Nothing ever calls `GET /estimates`. There is no `Estimates.jsx` page, no nav
  item, no list.
- `NewEstimateModal` is opened from `WorkOrders.jsx` and **creates and sends in
  one go**. No job card exists at that point, so the estimate does not appear in
  the work orders list either.
- `POST /:id/convert-to-work-order` — the route the pricing fix above lives in —
  **is never called from the UI at all.**

So: the backend estimate pipeline is complete and correct, and staff currently
have no way to see an estimate's status, see which lines the customer approved,
or convert an approved estimate into a job card. **A staff Estimates list screen
is the single highest-value next piece of work.**

### Data shape constraints that drove design decisions

Do not "fix" these by adding `NOT NULL` — the numbers are why:

- **5,694 of 5,944 vehicles have no VIN.**
- **18,506 of 18,730 work orders have no description.**

VIN, odometer and complaint are therefore enforced **at the form and the API**,
not in the schema. A schema constraint would lock the existing fleet out of the
system. Importers pass `allow_missing_vin` / `bypass_intake_required` to keep
bulk loads working. The wizard lets an advisor fix a missing VIN inline.

- **278 technicians have no team leader assigned.** The team leader board works;
  the data behind it is largely unpopulated.

### Classification left deliberately incomplete

The intake migration classified 7 internal accounts by name (5 fleet, 2 asset)
and assigned codes FLT-001…005, AST-001/002. **Insurance matched zero accounts**
and was left empty rather than guessed. COLEMONT is a broker, not an insurer, and
PERFECT INSURANCE MATERIAL FIXING is not an insurance company — both were left
alone on purpose. Do not bulk-classify these by string match.

---

## 9. Open questions for the client

These were asked and never answered. They block correct implementation.

1. **The N/A fallback arithmetic.** A job line prices Labour plus one of two part
   types (Genuine, After Market). When Genuine is N/A — say Labour 100, After
   Market 400 — is the Genuine column total **500** (labour plus the fallback
   part), or does the column stay N/A? And what happens when **both** part types
   are N/A? Asked twice, still open. The estimation diagram in
   `docs/process/Pioneer-Estimation-Logic.pdf` shows the rule but not this edge.

2. **External customer subcategories.** The whiteboard and the mockup contradict
   each other on what the External subcategories are. Flagged rather than
   silently picked; still unresolved.

---

## 10. Roadmap

Current version: **`docs/roadmap/ROADMAP-EXEC.html`** — three phases.

| Phase | Theme | Status | Estimate |
|---|---|---|---|
| 1 | Control the job, and put Pioneer on the phone | Largely built | 6–7 weeks |
| 2 | Close the loop | Awaiting a decision | 6–7 weeks |
| 3 | Connect outward | Blocked externally | 7–8 weeks |

Total 19–22 weeks, landing Q1 2027. The Phase 1 mobile app is **promotional
only** — send a complaint, book an appointment, contact the workshop, view your
profile and job card status. No actions.

**Known inconsistencies in the roadmap documents** (recovered from an audit that
was never completed — treat as unverified leads, not findings):

- The Phase 1 estimate row is labelled "including the promotional app" but may
  not leave any weeks for it; the total row may be mixing bases.
- **`docs/roadmap/ROADMAP.html` is stale** — it still describes **four waves**
  while every other document is on three phases. Either update it or delete it.
- The 96% / 99% figures quoted may be mis-sourced.
- "Rollout across four branches" may have no branch dimension in the schema to
  support it.

An audit workflow was run over these documents and **failed** — 202 of 240 agents
died on a session limit, and only one finding was ever confirmed. The remaining
77 are unverified and were deliberately not presented as results. If you want
them checked, do it **by hand in small batches**. Do not re-run that workflow.

### Blocked externally

WhatsApp provider, punch machine specification, ORBIT API, app store accounts.
None of these can move without the client.

---

## 11. Figma boards

The Figma MCP server **disconnected** and is no longer available in this session.
Board IDs, for reference:

| Board | ID |
|---|---|
| Roadmap, three phases (**current**) | `KVwylAAGxzOQ4hVuytCw4N` |
| Process steps 4–6 | `5YMRRkPUHMTVs7fYjr909C` |
| Estimation logic | `Vk9MukpiSN77pmnjLHA2hV` |
| Roadmap v1, v2 (superseded) | `kgh10zVS7EeJHgD7dxfJto`, `JCfqXYvjZEQyOsWShXq6Uj` |

Two things learned exporting these, in case anyone does it again:

- **Figma drops FigJam section titles on PDF export.** A subgraph name renders as
  a chip on canvas but is not a text node, so it vanishes. Every board lost its
  section names and they had to be drawn back on by locating the containers via
  their 0.902 grey fill.
- **The process flow cannot be made into one readable sheet.** It is
  920 × 7727 pt — a 1:8.4 ratio. Even A0 gives about 6.7 pt type. It needs a
  compact multi-column redraw, not a bigger sheet.

---

## 12. Suggested next steps

1. **Build the staff Estimates list screen** (section 8). The backend is done and
   correct; without this screen the whole estimate pipeline is unreachable.
2. **Rotate the staging GitHub tokens** (section 4).
3. Get answers to the two open questions in section 9.
4. Sweep the `req.userId` bug across the remaining ~6 route files.
5. Decide whether to finish the status enum contract migration or leave the
   widened enum in place.
6. Reconcile or delete `docs/roadmap/ROADMAP.html`.
