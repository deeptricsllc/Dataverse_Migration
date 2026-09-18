# Data Migration & Validation Platform

**DeepTrics** — discover, compare, plan, migrate and validate data between Microsoft Dataverse,
SQL Server and Azure SQL.

> Know what will happen before migration. Migrate safely. Know exactly what happened afterward.

Long-term direction: _Dataverse Environment Intelligence & ALM Platform_
(Discover → Compare → Plan → Migrate → Validate → Reconcile → Report/Rollback).

## What works today

| Area              | Capability                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in           | **Continue with Microsoft** (Entra ID, auth code + PKCE, server-side encrypted token cache) and a clearly marked **DEMO MODE** account                                                                                                                                                                                                      |
| Connections       | Dataverse environments discovered through the Global Discovery Service, plus SQL Server and Azure SQL connections configured by hand (credentials encrypted at rest, never returned by the API). Read-only connection tests, capability reporting, source/target selection remembered per user                                              |
| SQL discovery     | Tables, views, columns, types, nullability, defaults, identity/computed/rowversion columns, primary keys, unique constraints and indexes, foreign keys and row counts, read from the system catalog and normalized into the same model as Dataverse metadata                                                                                |
| Cross-provider    | Table mapping (a suggestion is never migrated without confirmation), column mapping with a type-compatibility verdict, value-level **choice mapping**, field transformations, and SQL foreign keys resolved into Dataverse lookups through the record identity map                                                                          |
| Compare           | Table catalog diff plus column/relationship/alternate-key comparison with MATCH / SOURCE_ONLY / TARGET_ONLY / DIFFERENT / INCOMPATIBLE, drill-down, data profiling (counts, null statistics, sample records)                                                                                                                                |
| Users             | User/team/business-unit mapping between environments (matched on Entra object id, login, email or name) with manual override, CSV export and an impersonation privilege check                                                                                                                                                               |
| Plan              | Table selection with explicit dependency hints, dependency graph (topological order, cycle detection, two-pass strategy), deterministic field mapping with manual override and suggestions that need confirmation, match strategy (primary ID or alternate key), conflict strategy, BLOCKER / WARNING / INFO issues, plug-in/flow detection |
| Ownership & audit | **Audit policy** — `NONE`, `STANDARD` (owner + created on via overriddencreatedon, no extra writes) or `PRESERVE_ATTRIBUTION` (adds created by / modified by through impersonation, ~1 extra write per record, blocked unless the privilege is verified)                                                                                    |
| Identity policy   | **User resolution policy** — `STRICT` blocks records whose user references cannot be resolved; `FALLBACK` uses an identity you choose explicitly. Ownership is never silently reassigned to the executing user, ambiguous matches are never auto-mapped, and every substitution is reported per record                                      |
| Preflight         | **Dry run** classifying every source record as CREATE / UPDATE / UNCHANGED / CONFLICT / BLOCKED with field-level drill-down (source value, target value, proposed action). Reads only — no Dataverse writes — and shares its decision code with the migration engine so the two cannot diverge                                              |
| Matching          | Deterministic hierarchy: migration identity map → primary id → **active** alternate key → configured business key. Two candidates are a conflict, never a guess; duplicate source keys are reported                                                                                                                                         |
| Safety            | `REAL_TENANT_READ_ONLY` blocks every Dataverse write inside the client and before a run is queued, a read-only **Diagnostics** page explains each connection check, and production targets are flagged before execution                                                                                                                     |
| Sync              | `SKIP_EXISTING`, `CREATE_ONLY`, `UPSERT` or **`SYNC`**: create missing records, update only columns that differ, and leave identical records untouched so their modified on / modified by do not change                                                                                                                                     |
| Exports           | CSV download of schema differences, plan issues, migration errors, the record inventory, validation summary and validation differences, the user mapping, the preflight, and a single **remediation package** (severity, category, table, record, field, source/target value, issue, resolution, suggested action)                          |
| Execute           | Persisted, resumable, dependency-ordered batch migration in a background worker. Identity map, lookup resolution, deferred lookups (pass 2), retries with backoff and throttling handling, per-record structured errors, pause/resume/cancel/retry, audited confirmation                                                                    |
| Validate          | Schema, row counts, record existence, normalized field-level comparison, broken-reference checks, drill-down with masking                                                                                                                                                                                                                   |
| History           | Runs, validation runs, record inventory, rollback impact preview (execution intentionally _not yet supported_), audit trail, dashboard                                                                                                                                                                                                      |
| Platform          | Multi-tenant data model, CSRF/origin/session security, structured logs with request/run IDs, PostgreSQL or embedded PGlite                                                                                                                                                                                                                  |

### Supported migration paths

Source and target are chosen independently, so any pair works:

| Source ↓ / Target → | Dataverse | SQL Server | Azure SQL |
| ------------------- | --------- | ---------- | --------- |
| **Dataverse**       | ✓         | ✓          | ✓         |
| **SQL Server**      | ✓         | ✓          | ✓         |
| **Azure SQL**       | ✓         | ✓          | ✓         |

Every path runs on the same engine, planner, matcher, preflight and validation — a connector only
decides how to read and write, never what the migration does. See
[docs/SQL_SERVER_SETUP.md](docs/SQL_SERVER_SETUP.md) and
[docs/AZURE_SQL_SETUP.md](docs/AZURE_SQL_SETUP.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/MICROSOFT_SETUP.md](docs/MICROSOFT_SETUP.md) and
[docs/REAL_TENANT_CERTIFICATION.md](docs/REAL_TENANT_CERTIFICATION.md) (how to test against a real
Microsoft tenant without writing to it).

> **Not yet certified against a real Microsoft tenant or a real SQL Server.** Every integration in
> this repository is written against the vendor's current documentation and is covered by tests
> using simulated systems, but none of it has been exercised against a real tenant or database.
> Follow [docs/REAL_TENANT_CERTIFICATION.md](docs/REAL_TENANT_CERTIFICATION.md) and section 8 of
> [docs/SQL_SERVER_SETUP.md](docs/SQL_SERVER_SETUP.md) before trusting it with customer data.

## Quick start (demo, no external dependencies)

Requirements: **Node.js 20.11+** (tested on Node 24).

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3000> and click **Continue with demo account**.

`npm start` uses an embedded PostgreSQL (PGlite) in `./.data/pglite`, applies migrations
automatically and runs the job worker in-process. Demo mode is on by default outside
`NODE_ENV=production`. To start from a clean state, stop the server and delete `.data/`.

### Demo walkthrough

1. **Environments:** set _DeepTrics Development_ as source and _DeepTrics QA_ as target, then **Verify both connections**. _DeepTrics Production_ intentionally fails its connection test.
2. **Compare:** click **Analyze**. Expand _Account_ (source-only column, missing choice value, shorter max length) and _Product_ (String → Integer type mismatch).
3. **Select tables:** Account, Contact, Region, Office, Application Config, Product. The page shows what each table requires before you add it.
4. **Dependencies:** Region → Office and Account ↔ Contact cycles are resolved in two passes.
5. **Field mapping:** `dtx_tier` is unmapped (missing in QA), `dtx_warrantymonths` is incompatible, and Product/Config match by alternate key.
6. **Review:** warnings for server-side logic in QA, schema risks and more. Optionally switch the strategy to **Sync** and choose an audit policy (map users first on the **User mapping** page). With `STANDARD` or `PRESERVE_ATTRIBUTION` the unmatched Development-only service account becomes a **blocker** under the default `STRICT` user resolution policy; switch to `FALLBACK` and pick a fallback identity to continue.
   6b. **Preflight (dry run):** from the review step, open **Preflight** and run it. It reads both environments and reports how many records would be created, updated, left unchanged, or blocked, with the field-level changes. Nothing is written.
7. **Run:** live progress per table. Expect real failures: over-length website and routing-rule values, and industry value 7 missing in QA. Pre-existing QA records are skipped. Throttling is simulated and retried automatically.
8. **Validate:** the report shows missing records (the failed ones), pre-existing differences and zero broken references. Every table, error and difference list has an **Export CSV** button.
9. **Re-run** the same plan with the Sync strategy: everything that already matches is reported as _unchanged_ and nothing is written, so target audit stamps stay put.

The demo users (Priya Patel, Mateo Garcia, Aisha Haddad and a Development-only service account) exist in each simulated environment with **different record ids**, which is what makes the user mapping observable. A Development user called _Jordan Lee_ matches two different target users of the same name: it is reported as **ambiguous** and is never mapped automatically.

DeepTrics UAT is an empty target, useful for a clean full migration.

## Development

```bash
cp .env.example .env         # optional
npm run dev                  # API on :3000 (tsx watch) + Vite on :5173 (proxy /api)
```

Open <http://localhost:5173>. For Microsoft sign-in in dev, set `APP_BASE_URL=http://localhost:5173`
and register `http://localhost:5173/api/auth/callback`.

## Environment variables

All options are documented in [.env.example](.env.example). The important ones:

| Variable                                  | Default                                                  | Purpose                                                   |
| ----------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `DATABASE_URL`                            | _(unset → PGlite)_                                       | PostgreSQL connection string (UTF-8 database)             |
| `PGLITE_DATA_DIR`                         | `./.data/pglite`                                         | Embedded database location                                |
| `SESSION_SECRET`                          | dev: generated into `.data/`; **required in production** | Session + token-cache encryption key material (≥32 chars) |
| `APP_BASE_URL`                            | `http://localhost:3000`                                  | Public URL, redirect URI base, origin checks              |
| `DEMO_MODE`                               | `true` (non-production)                                  | Enable simulated environments + demo sign-in              |
| `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` | –                                                        | Enable Microsoft sign-in                                  |
| `ENTRA_TENANT_ID`                         | `organizations`                                          | Multi-tenant or a specific tenant                         |
| `ALLOWED_TENANT_IDS`, `ADMIN_EMAILS`      | –                                                        | Tenant allow-list and admin bootstrap                     |
| `DATAVERSE_DISCOVERY_URL`                 | `https://globaldisco.crm.dynamics.com`                   | Global Discovery endpoint (sovereign clouds differ)       |
| `POWER_PLATFORM_ENRICHMENT`               | `false`                                                  | Environment SKU/region from the Power Platform admin API  |
| `ALLOW_BUSINESS_LOGIC_BYPASS`             | `false`                                                  | Allow audited plug-in bypass for ADMINs                   |
| `REAL_TENANT_READ_ONLY`                   | `false`                                                  | Allow all reads, block every Dataverse write server-side  |
| `RUN_WORKER`                              | `true`                                                   | Run background jobs in the web process                    |
| `COOKIE_SECURE`                           | `true` in production                                     | Secure cookies (HTTPS)                                    |

## Microsoft Entra configuration (summary)

1. Register a **Web** app with redirect URI `${APP_BASE_URL}/api/auth/callback`.
2. Create a client secret → `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`.
3. Add delegated **Dynamics CRM → user_impersonation** (plus `openid profile email offline_access`) and **grant admin consent**.
4. Users need a Dataverse security role in each environment (read on source, create/write/append on target).

Full step-by-step guide, including how discovery and delegated access work: [docs/MICROSOFT_SETUP.md](docs/MICROSOFT_SETUP.md).

## Database

- Schema: `server/src/db/schema.ts` (Drizzle). SQL migrations: `server/drizzle/`.
- Migrations apply automatically on server/worker start, or explicitly with `npm run db:migrate`.
- After changing the schema: `npm run db:generate`, then commit the generated SQL.
- PostgreSQL locally: `docker compose up -d postgres`, then
  `DATABASE_URL=postgres://dvm:dvm@localhost:5432/dataverse_migration`.

## Background worker

- With PGlite, jobs always run inside the web process (`RUN_WORKER=true`).
- With PostgreSQL you can scale out: set `RUN_WORKER=false` on web instances and run
  `npm run worker` (built) or `npm run worker:dev` separately. Workers claim jobs with
  `SKIP LOCKED`, heartbeat, and re-queue stale jobs after a crash. Runs resume idempotently.

## Tests

```bash
npm test                 # unit + integration (Vitest, in-memory PostgreSQL via PGlite)
npm run test:unit
npm run test:integration
npm run build && npm run test:e2e   # Playwright: full demo journey in Chromium
npm run lint && npm run typecheck && npm run format:check
npm run verify           # everything above, in order
```

`TEST_DATABASE_URL=postgres://…` runs the integration suite against a real, empty UTF-8
PostgreSQL database. First-time Playwright setup: `npx playwright install chromium`.

## Project layout

```
shared/            domain DTOs + normalized Dataverse metadata model
server/src/
  app.ts, routes/  Fastify app, security hooks, API routes
  auth/            sessions, Microsoft identity (MSAL)
  dataverse/       connection interface, Web API client, discovery, retry, DEMO environments
  services/        comparison, dependency graph, mapping, planning, migration engine, validation, audit
  jobs/            database-backed queue + worker
  db/              schema, client (Postgres/PGlite), migrations CLI
web/src/           React SPA (pages, components, API client)
tests/             unit + integration tests
e2e/               Playwright happy path
docs/              architecture, Microsoft/SQL setup, certification, future designs
```

## Deploying to Railway

The repo ships a `Dockerfile` and `railway.json` (health check `/api/health`). In the Railway environment:

1. Add a PostgreSQL service. On the app service set `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
2. Set `SESSION_SECRET` (48+ random characters), `APP_BASE_URL=https://<service domain>` and `COOKIE_SECURE=true`.
3. Without Entra credentials set `DEMO_MODE=true`. For Microsoft sign-in add `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` and register `https://<service domain>/api/auth/callback`.
   When you first point a deployment at a real tenant, also set `REAL_TENANT_READ_ONLY=true` so
   the deployment can read but never write while you certify it.
4. Deploy (`railway up` or a GitHub-connected service). Migrations run on start; `PORT` is provided by Railway.

## Production considerations

- Run behind HTTPS with `NODE_ENV=production`, a strong `SESSION_SECRET` (secret manager), `COOKIE_SECURE=true` and PostgreSQL.
- Set `DEMO_MODE=false` unless you intentionally offer demos; demo organizations are isolated from real tenants.
- Restrict sign-in with `ALLOWED_TENANT_IDS` until onboarding flows exist.
- Scale web and worker processes independently. Keep worker concurrency modest: Dataverse service protection limits are per user.
- Ship JSON logs to your log platform. Logs carry `reqId`, `migrationRunId`, `validationRunId` and `jobId`, never tokens.
- Back up the database: the identity map and audit trail are the record of what each migration did.
- Test migrations against a copy of the target first. Treat every real environment as production.
