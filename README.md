# Dataverse Migration & Validation Platform

**DeepTrics** — discover, compare, plan, migrate and validate Microsoft Dataverse environments.

> Know what will happen before migration. Migrate safely. Know exactly what happened afterward.

Long-term direction: _Dataverse Environment Intelligence & ALM Platform_
(Discover → Compare → Plan → Migrate → Validate → Reconcile → Report/Rollback).

## What works today

| Area         | Capability                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in      | **Continue with Microsoft** (Entra ID, auth code + PKCE, server-side encrypted token cache) and a clearly marked **DEMO MODE** account                                                                                                                                                                                                      |
| Environments | Discovery through the Dataverse Global Discovery Service (delegated), search/filter, refresh, connection test (WhoAmI), source/target selection remembered per user                                                                                                                                                                         |
| Compare      | Table catalog diff plus column/relationship/alternate-key comparison with MATCH / SOURCE_ONLY / TARGET_ONLY / DIFFERENT / INCOMPATIBLE, drill-down, data profiling (counts, null statistics, sample records)                                                                                                                                |
| Plan         | Table selection with explicit dependency hints, dependency graph (topological order, cycle detection, two-pass strategy), deterministic field mapping with manual override and suggestions that need confirmation, match strategy (primary ID or alternate key), conflict strategy, BLOCKER / WARNING / INFO issues, plug-in/flow detection |
| Execute      | Persisted, resumable, dependency-ordered batch migration in a background worker. Identity map, lookup resolution, deferred lookups (pass 2), retries with backoff and throttling handling, per-record structured errors, pause/resume/cancel/retry, audited confirmation                                                                    |
| Validate     | Schema, row counts, record existence, normalized field-level comparison, broken-reference checks, drill-down with masking                                                                                                                                                                                                                   |
| History      | Runs, validation runs, record inventory, rollback impact preview (execution intentionally _not yet supported_), audit trail, dashboard                                                                                                                                                                                                      |
| Platform     | Multi-tenant data model, CSRF/origin/session security, structured logs with request/run IDs, PostgreSQL or embedded PGlite                                                                                                                                                                                                                  |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/MICROSOFT_SETUP.md](docs/MICROSOFT_SETUP.md).

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
6. **Review:** warnings for server-side logic in QA, schema risks and more. Execute, acknowledge the warnings, and type `DeepTrics QA`.
7. **Run:** live progress per table. Expect real failures: over-length website and routing-rule values, and industry value 7 missing in QA. Pre-existing QA records are skipped. Throttling is simulated and retried automatically.
8. **Validate:** the report shows missing records (the failed ones), pre-existing differences and zero broken references.

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
docs/              architecture, Microsoft setup
```

## Deploying to Railway

The repo ships a `Dockerfile` and `railway.json` (health check `/api/health`). In the Railway environment:

1. Add a PostgreSQL service. On the app service set `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
2. Set `SESSION_SECRET` (48+ random characters), `APP_BASE_URL=https://<service domain>` and `COOKIE_SECURE=true`.
3. Without Entra credentials set `DEMO_MODE=true`. For Microsoft sign-in add `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` and register `https://<service domain>/api/auth/callback`.
4. Deploy (`railway up` or a GitHub-connected service). Migrations run on start; `PORT` is provided by Railway.

## Production considerations

- Run behind HTTPS with `NODE_ENV=production`, a strong `SESSION_SECRET` (secret manager), `COOKIE_SECURE=true` and PostgreSQL.
- Set `DEMO_MODE=false` unless you intentionally offer demos; demo organizations are isolated from real tenants.
- Restrict sign-in with `ALLOWED_TENANT_IDS` until onboarding flows exist.
- Scale web and worker processes independently. Keep worker concurrency modest: Dataverse service protection limits are per user.
- Ship JSON logs to your log platform. Logs carry `reqId`, `migrationRunId`, `validationRunId` and `jobId`, never tokens.
- Back up the database: the identity map and audit trail are the record of what each migration did.
- Test migrations against a copy of the target first. Treat every real environment as production.
