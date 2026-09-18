# Architecture

**Discover → Compare → Plan → Migrate → Validate → Reconcile/Report → (Rollback)**

The platform is provider-neutral. Dataverse, SQL Server and Azure SQL are connectors behind one
contract; every service above them is written once. Adding a provider means implementing
`MigrationConnector` and declaring its capabilities, not editing the engine.

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
│  MigrationEngine (PASS 1 / PASS 2 / PASS 3, identity map)   │
│  PreflightService (dry run) ─┐ share record-planner.ts and  │
│  MigrationEngine ────────────┘ record-matcher.ts            │
│  DiagnosticsService (read-only) · RemediationService        │
│  ValidationService (schema, counts, existence, fields, refs)│
│  InsightsService (profiling, dashboard) · AuditService      │
├──────────────────────┬──────────────────────────────────────┤
│ Job queue + Worker   │ Connectors (server/src/connectors)    │
│ (jobs table, SKIP    │  MigrationConnector + capabilities    │
│  LOCKED, heartbeats, │   ├─ WebApiConnection (Dataverse 9.2) │
│  stale recovery)     │   ├─ SqlConnector (SQL / Azure SQL)   │
│                      │   ├─ DemoConnection (simulated DV)    │
│                      │   └─ DemoSqlConnection (simulated SQL)│
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
| One decision module for dry run and execution             | `record-planner.ts` (what to write) and `record-matcher.ts` (which target record) are pure and shared, so a preflight cannot predict something different from what the engine does.                            |
| Policies instead of booleans                              | `AuditPolicy` and `UserResolutionPolicy` make the consequences explicit and reviewable. The engine reads derived capability flags, never the policy name.                                                      |
| `REAL_TENANT_READ_ONLY` enforced in the Dataverse client  | A UI or service mistake cannot reach a real tenant with a write: the block sits at the last layer before the HTTP request, and a second guard refuses to queue a run.                                          |

## The connector contract

`server/src/connectors/types.ts` defines `MigrationConnector`: discovery (`listTables`, `getTable`,
`countRecords`), reading (`queryRecords`, `retrieveByIds`, `findByAlternateKey`, `findByFields`),
writing (`createRecord`, `updateRecord`), a read-only `testConnection`, and the Dataverse-specific
operations that other providers decline. What a provider can actually do is a `ConnectorCapabilities`
record rather than an unimplemented method, so callers ask instead of guessing:

| Capability           | Dataverse | SQL Server / Azure SQL             |
| -------------------- | --------- | ---------------------------------- |
| Read / write         | yes       | yes                                |
| Transactions         | no        | yes                                |
| Batch write          | no        | yes                                |
| Alternate keys       | yes       | yes (unique constraints / indexes) |
| Record ownership     | yes       | no                                 |
| Audit impersonation  | yes       | no                                 |
| Native choices       | yes       | no (mapped from values)            |
| Client-generated ids | yes       | no (IDENTITY is server-assigned)   |
| Principals           | yes       | no                                 |

The UI reads these to decide which settings to show, so Dataverse-only options (ownership, created-by
impersonation, plug-in bypass) never appear for a SQL target.

### SQL metadata, normalized

`connectors/sql/catalog.ts` holds the catalog queries (constants, never interpolated) and the pure
functions that turn their rows into the shared model. The decisions that matter:

- Identity, computed and rowversion columns are read-only, so no migration writes them.
- A single-column primary key becomes the record id; a composite key is published as an alternate
  key instead, because there is no single id to match on.
- A **foreign key becomes a lookup**: the referencing column is typed `Lookup` with the referenced
  table as its target. This is what lets SQL relationships flow through the dependency graph,
  two-pass ordering and the record identity map unchanged.
- A unique constraint or unique index becomes an alternate key — unless it is disabled or filtered,
  which the shared `isKeyUsable` helper then refuses.

## Cross-provider mapping

| Layer          | What it decides                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table mapping  | Which target table a source table's rows belong in. Identical names pair automatically (`EXACT`); anything else is `AUTO_SUGGESTED` and blocks the plan until a person confirms it. |
| Column mapping | Which target column a source column feeds, with a verdict: `COMPATIBLE`, `CONVERSION_REQUIRED`, `LOSSY` or `INCOMPATIBLE`.                                                          |
| Choice mapping | Which target choice each source value becomes. Values are read from the data; an unmapped value blocks the plan rather than defaulting.                                             |
| Transformation | Direct copy, trim, upper, lower, constant, default-if-null. Persisted configuration, not a scripting language.                                                                      |

`record-planner.ts` applies all of it in one place, so the preflight and the engine cannot disagree
about what a value becomes.

### Record identity across systems

A SQL integer key means nothing in Dataverse and a Dataverse GUID means nothing in SQL, so:

- Record ids are preserved **only** within one provider, and only where the target accepts a
  client-supplied key. Otherwise the target assigns the key.
- `migration_record_maps` records the (source connection, source table, source id) →
  (target connection, target id) pair, and that map is what resolves every reference.
- A SQL foreign key is therefore resolved exactly like a Dataverse lookup: find the referenced
  source record in the identity map, and write the target's key.
- A target record may be claimed by at most one source record per run. Two source rows resolving to
  the same target is a conflict, not a last-writer-wins overwrite.

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
   - Match existing target records deterministically (`record-matcher.ts`): migration identity map
     (verified to still exist) then primary ID (batched `In` query), an **active** alternate key, or
     a configured business key. Two or more candidates is a `CONFLICT`, never a guess, and two
     source records carrying the same key are reported as `DUPLICATE_SOURCE_KEY`.
   - Apply the conflict strategy: `SKIP_EXISTING` (default), `CREATE_ONLY`, `UPSERT` or `SYNC`.
     `SYNC` reads the matched target record, writes only the columns whose normalized values differ,
     and records `UNCHANGED` without writing when everything matches, so modifiedon / modifiedby stay
     untouched. Creates
     preserve source GUIDs, and updates use `If-Match: *` so they never create.
   - Persist the identity map, per-record structured errors, counters and heartbeat. Check the
     cancel/pause flags between batches.
3. **PASS 2**: set deferred lookups on created/updated records.
4. **PASS 3** (only with `PRESERVE_ATTRIBUTION`): one impersonated update per record so that
   modifiedby matches the mapped source user.
5. Transient failures (429/502/503/504/network/timeouts) retry inside the client with bounded
   exponential backoff, honoring `Retry-After`. Permanent failures are recorded once per attempt.
   Authentication failures stop the run (`FAILED`) with a clear message.

Run states: `QUEUED → RUNNING → COMPLETED | COMPLETED_WITH_ERRORS | FAILED | CANCELLED`, plus `PAUSED`.
Retry re-queues the same run (`attempt + 1`) and only reprocesses records that did not succeed.

## Ownership and audit fields

Users, teams and business units have different record ids in every environment, so
`PrincipalService` builds a source -> target map (`principal_maps`) from both directories,
matching on Entra object id, then login, then email, then a unique display name. Manual overrides
and exclusions always win over automatic matches.

Matching is hierarchical and never ambiguous: Entra object id, then login, then email, then a
display name only when it is unique in both directories. Anything matching more than one target
principal is stored as `AMBIGUOUS` with its candidates and is never applied automatically; a human
chooses.

### Audit policy

| Policy                 | Writes                                                                | Cost                             |
| ---------------------- | --------------------------------------------------------------------- | -------------------------------- |
| `NONE` (default)       | nothing extra; records are owned and stamped by the executing user    | –                                |
| `STANDARD`             | owner + `overriddencreatedon`                                         | no additional Dataverse writes   |
| `PRESERVE_ATTRIBUTION` | adds created by (impersonated create) and modified by (PASS 3 update) | about one extra write per record |

| Field           | Mechanism                                                             | Requirement                                                                     |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Owner           | written on create/update as the mapped principal                      | mapped user or team                                                             |
| Created on      | `overriddencreatedon` on create                                       | target exposes the column; Dataverse requires `prvOverrideCreatedOnCreatedBy`   |
| Created by      | record created while impersonating the mapped user (`CallerObjectId`) | `prvActOnBehalfOfAnotherUser` (assigned directly, not through a team), verified |
| Modified by     | PASS 3 impersonated update                                            | same privilege, plus one extra write per record                                 |
| **Modified on** | **not possible**                                                      | Dataverse always stamps it with the write time                                  |

`PRESERVE_ATTRIBUTION` is a BLOCKER until the impersonation privilege has been verified by the
read-only check, and the plan states the estimated number of additional writes before execution.

### User resolution policy

| Policy             | Unresolved owner / user reference                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `STRICT` (default) | the record is **BLOCKED** and never written with substituted ownership                            |
| `FALLBACK`         | the explicitly configured fallback identity is used; every substitution is recorded on the record |

The executing user is never used as an implicit fallback. Under `FALLBACK` the plan shows which
identities, how many records and which fields are affected, the preflight lists them per record, and
the execution dialog requires a separate acknowledgement before the run starts.

## Preflight (dry run)

`PreflightService` streams the source exactly as the engine would, resolves lookups read-only, and
calls the same `prepareRecord` / `RecordMatcher.match` / `decideAction` functions. Each record is
classified `CREATE`, `UPDATE`, `UNCHANGED`, `CONFLICT` or `BLOCKED` and persisted with its
field-level changes (source value, target value, proposed action). Lookups pointing at records an
earlier pass of the same plan would create are reported as pending, not blocked. No Dataverse write
is ever issued during a preflight.

## Diagnostics

`DiagnosticsService` runs read-only checks (authentication, token acquisition, environment
discovery, source and target connection, metadata access, record read, user discovery and the
impersonation privilege) and maps failures to an actionable resolution. Write permission is reported
as `NOT_TESTED`: it is never probed automatically. No token or raw response is returned.

## Read-only certification mode

With `REAL_TENANT_READ_ONLY=true`:

- `WebApiConnection` refuses `POST`, `PATCH`, `PUT`, `DELETE` and `MERGE` before the request leaves
  the process (`READ_ONLY_MODE`, HTTP 403).
- `MigrationRunService` refuses to start, resume or retry a run against a Dataverse environment,
  records a `READ_ONLY_WRITE_BLOCKED` audit event and returns `403 REAL_TENANT_READ_ONLY`.
- The UI shows a permanent **REAL TENANT - READ ONLY** banner, visually distinct from DEMO MODE.
- Simulated demo environments are unaffected: they hold no tenant data.

See [REAL_TENANT_CERTIFICATION.md](REAL_TENANT_CERTIFICATION.md). The same switch refuses writes to a
real SQL database.

## Designed, not built

- [ON_PREM_AGENT_ARCHITECTURE.md](ON_PREM_AGENT_ARCHITECTURE.md) — reaching an on-premises SQL Server
  from a hosted deployment, without exposing the database to the internet.
- [INCREMENTAL_SYNC_ARCHITECTURE.md](INCREMENTAL_SYNC_ARCHITECTURE.md) — change tracking and CDC, so a
  repeated sync of a very large table does not re-read everything.

## Exports

Every review surface has a CSV export (`server/src/lib/csv.ts`): schema comparison, plan issues,
migration errors, record inventory, validation summary and differences, the user mapping, and the
preflight. `RemediationService` additionally builds the **remediation package**
(`/api/plans/:id/issues-package.csv`): one file with every blocking issue, covering missing target
tables and columns, type incompatibilities, missing choice values, unresolved and ambiguous users,
unresolved lookups, duplicate business keys, conflicts, blocked records, proposed updates and plan
warnings, with the columns `Severity, Category, Table, Source Record ID, Record Name, Field, Source
Value, Target Value, Issue, Resolution, Suggested Action`.
Exports reuse the same tenant-scoped services and masking as the UI, quote per RFC 4180, start with
a UTF-8 BOM for Excel, and neutralize leading `=`, `+`, `-` and `@` so spreadsheet formulas cannot
execute.

## Validation

Per table: schema diff (fresh metadata), row counts, record existence (identity map), field
comparison for mapped columns (normalized: line endings, trailing whitespace, precision, date
formats, GUID case), and lookup reference validation (every target lookup must resolve).
Differences on records the run skipped are `PRE_EXISTING_DIFFERENCE` warnings, not failures.
Secured columns are masked, values are truncated, and at most 5,000 records per table are compared
field by field (the report says so when this cap applies).

## Security

- Database credentials: AES-256-GCM (SecretBox, HKDF-derived key) in a separate `connection_secrets` table, so an ordinary environment query cannot return one. Never returned by the API, never logged, never copied into a run snapshot. Driver errors are redacted before they reach a message.
- SQL statements: every value is a bound parameter; identifiers come from the catalog the platform read and are quoted. An `UPDATE` is always keyed on the primary key, and the platform never issues `DELETE`, `DROP`, `ALTER` or `TRUNCATE`.
- Sessions: random 256-bit token in an HttpOnly, SameSite=Lax cookie (`Secure` in production). The DB stores only a SHA-256 hash.
- CSRF: per-session token required in `x-csrf-token` for every state-changing request, plus an Origin allow-list.
- OAuth: PKCE, single-use `state`, `nonce` validation, optional tenant allow-list, open-redirect-safe `returnTo`.
- Secrets: MSAL cache encrypted (AES-256-GCM, HKDF-derived key). Pino redaction for auth headers/cookies/tokens. `scrubSecrets` on error messages.
- Authorization: tenant-scoped queries, environment access checks, ADMIN-only demo reset and bypass, zod-validated inputs, CSP/helmet, rate limiting.
- Safety: execution requires re-validation, zero blockers, acknowledged warnings and typing the target environment name. Plug-ins/flows are never disabled, and bypass headers are opt-in and audited.
- Environment classification: environments Microsoft reports as `Production` (or `Default`) are flagged in the plan and in the execution dialog. An unknown type is reported as unknown, never assumed safe.
- `REAL_TENANT_READ_ONLY` blocks all Dataverse writes server-side, independently of the UI.

## Rollback foundation

`GET /api/runs/:id/rollback-preview` reports what the run created, updated, skipped and failed,
plus the reverse dependency order for deletion. **Execution is deliberately NOT YET SUPPORTED**.
Safe rollback needs before-images for updates, checks that created records weren't modified or
referenced since, and cascade analysis.
