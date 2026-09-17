# Architecture

**Discover → Compare → Plan → Migrate → Validate → Reconcile/Report → (Rollback)**

```
┌──────────────── Browser (React SPA, web/) ────────────────┐
│ Dashboard · Environments · Compare · Migration wizard ·    │
│ Run monitor · Validation report · Runs · Settings          │
│ HttpOnly session cookie + in-memory CSRF token             │
└───────────────────────────┬────────────────────────────────┘
                            │ JSON /api (same origin)
┌───────────────────────────▼────────────────────────────────┐
│ Fastify API (server/src/app.ts, routes/)                    │
│  helmet/CSP · rate limit · origin check · session → tenant  │
│  context · CSRF · zod validation · structured errors        │
├─────────────────────────────────────────────────────────────┤
│ Services (server/src/services/)                             │
│  AuthService · MicrosoftIdentityService (MSAL)              │
│  EnvironmentService (discovery, connection tests, workspace)│
│  MetadataService (DB-cached normalized metadata, counts)    │
│  ComparisonService → schema-diff.ts                         │
│  PlanningService → dependency-graph.ts, mapping.ts,         │
│                     plan-validation.ts                      │
│  MigrationRunService (start/control/errors/rollback preview)│
│  MigrationEngine (PASS 1 / PASS 2, identity map)            │
│  ValidationService (schema, counts, existence, fields, refs)│
│  InsightsService (profiling, dashboard) · AuditService      │
├──────────────────────┬──────────────────────────────────────┤
│ Job queue + Worker   │ Dataverse layer (server/src/dataverse)│
│ (jobs table, SKIP    │  DataverseConnection interface        │
│  LOCKED, heartbeats, │   ├─ WebApiConnection (real, v9.2)    │
│  stale recovery)     │   └─ DemoConnection (DEMO MODE)       │
│                      │  GlobalDiscoveryProvider · retry/     │
│                      │  throttling · error classification    │
└──────────┬───────────┴──────────────────────────────────────┘
           │ Drizzle ORM (same schema + SQL migrations)
   PostgreSQL (DATABASE_URL)  or  embedded PGlite (local)
```

## Key decisions

| Decision                                                  | Rationale                                                                                                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One `DataverseConnection` interface for real and demo     | Demo mode runs the same services, engine and UI. Demo writes go to a simulated store that rejects invalid data the way Dataverse does, so outcomes are computed, not scripted.                                 |
| Normalized metadata model (`shared/metadata.ts`)          | Diffing, mapping and the UI never touch raw Web API payloads. Responses are normalized and cached per environment.                                                                                             |
| Database-backed job queue                                 | Long-running comparisons, migrations and validations don't depend on an HTTP request or the browser tab, and no extra infrastructure is needed. `FOR UPDATE SKIP LOCKED` allows several workers on PostgreSQL. |
| PGlite fallback                                           | `npm start` works with no Docker or Postgres install, and tests run against real Postgres semantics in memory.                                                                                                 |
| Plan snapshot per run                                     | Editing a plan never changes an in-flight or historical run.                                                                                                                                                   |
| Identity map (`migration_record_maps`) as source of truth | Drives lookup resolution, idempotent resume/retry, counters, validation and the rollback inventory.                                                                                                            |
| Tenant scoping in every query                             | Each read or write is filtered by `organization_id`, and environment access by `environment_access` (who discovered it). Cross-tenant IDs return 404.                                                          |

## Migration engine

1. **Plan**: selected tables → source metadata → dependency edges from mapped lookup columns.
   Tarjan SCC finds cycles. A cycle is broken by deferring optional lookup edges (single
   attribute + target table), preferring edges out of the table others depend on most. Kahn's
   algorithm gives a deterministic order. Required-only cycles are reported as BLOCKERs.
2. **Execute** (`migration-engine.ts`), per table in order:
   - Page source records (`odata.maxpagesize` = batch size), skipping records this run already
     migrated (resume/retry).
   - Batch-resolve lookups: current-run identity map → earlier runs for the same environment pair
     (verified to still exist in the target) → same ID already in the target. Unresolved required
     lookups fail the record; unresolved optional ones are left empty with a warning.
   - Match existing target records by primary ID (batched `In` query) or alternate key.
   - Apply the conflict strategy: `SKIP_EXISTING` (default), `CREATE_ONLY` or `UPSERT`. Creates
     preserve source GUIDs, and updates use `If-Match: *` so they never create.
   - Persist the identity map, per-record structured errors, counters and heartbeat. Check the
     cancel/pause flags between batches.
3. **PASS 2**: set deferred lookups on created/updated records.
4. Transient failures (429/502/503/504/network/timeouts) retry inside the client with bounded
   exponential backoff, honoring `Retry-After`. Permanent failures are recorded once per attempt.
   Authentication failures stop the run (`FAILED`) with a clear message.

Run states: `QUEUED → RUNNING → COMPLETED | COMPLETED_WITH_ERRORS | FAILED | CANCELLED`, plus `PAUSED`.
Retry re-queues the same run (`attempt + 1`) and only reprocesses records that did not succeed.

## Validation

Per table: schema diff (fresh metadata), row counts, record existence (identity map), field
comparison for mapped columns (normalized: line endings, trailing whitespace, precision, date
formats, GUID case), and lookup reference validation (every target lookup must resolve).
Differences on records the run skipped are `PRE_EXISTING_DIFFERENCE` warnings, not failures.
Secured columns are masked, values are truncated, and at most 5,000 records per table are compared
field by field (the report says so when this cap applies).

## Security

- Sessions: random 256-bit token in an HttpOnly, SameSite=Lax cookie (`Secure` in production). The DB stores only a SHA-256 hash.
- CSRF: per-session token required in `x-csrf-token` for every state-changing request, plus an Origin allow-list.
- OAuth: PKCE, single-use `state`, `nonce` validation, optional tenant allow-list, open-redirect-safe `returnTo`.
- Secrets: MSAL cache encrypted (AES-256-GCM, HKDF-derived key). Pino redaction for auth headers/cookies/tokens. `scrubSecrets` on error messages.
- Authorization: tenant-scoped queries, environment access checks, ADMIN-only demo reset and bypass, zod-validated inputs, CSP/helmet, rate limiting.
- Safety: execution requires re-validation, zero blockers, acknowledged warnings and typing the target environment name. Plug-ins/flows are never disabled, and bypass headers are opt-in and audited.

## Rollback foundation

`GET /api/runs/:id/rollback-preview` reports what the run created, updated, skipped and failed,
plus the reverse dependency order for deletion. **Execution is deliberately NOT YET SUPPORTED**.
Safe rollback needs before-images for updates, checks that created records weren't modified or
referenced since, and cascade analysis.
