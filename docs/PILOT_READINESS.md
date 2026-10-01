# Pilot readiness: boundaries, scale, roles and what is still unproven

Written for the engineering team and product owner. Companion to `TRUST_SPRINT.md`, which holds the
metric definitions and the terminology decisions.

Dated 1 October 2026.

---

## 1. The workspace boundary

**The boundary is the organization.** Every table that holds customer data carries `organization_id`
and references `organizations` with `ON DELETE CASCADE`. Every query filters on it. That boundary
predates this sprint and is covered by `tests/integration/tenant-isolation.test.ts`, which walks
every route as an intruder.

What changed is who gets one.

| Path                      | Workspace                         | Why                                                                                                              |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Demo sign-in, no name     | A new organization per sign-in    | A prospect evaluating alone. Signing out and back in gives a fresh one.                                          |
| Demo sign-in, with a name | The shared team organization      | Testers evaluating together, where seeing each other's work is the point and the audit trail distinguishes them. |
| Microsoft sign-in         | One organization per Entra tenant | First person from a tenant creates it and becomes its administrator.                                             |

**The hole this closed.** `demo_records` — the simulated Dataverse and SQL Server rows — was keyed by
environment alone, with no organization. Every demo visitor shared one copy. Somebody who migrated
441 records into the simulated UAT left them there for the next visitor, whose "empty target" was
not empty. It is now partitioned by the organization that owns the environment reading it, and both
demo connectors narrow every read and write through a single `scope()` helper rather than repeating
the predicate at twenty call sites.

**Tests that attack it** — `tests/integration/evaluator-isolation.test.ts`:

- Two demo sign-ins produce two organizations.
- Reading another workspace's project, plan, run, validation, differences or environment tables by
  id returns 403 or 404 and never a body.
- Mutating them — rename, archive, change options, execute, cancel, validate — is refused.
- No listing (`/api/projects`, `/api/plans`, `/api/runs`, `/api/validations`, `/api/audit`) mentions
  another workspace's ids.
- The audit trail does not carry another workspace's run.
- **The behavioural one:** a second evaluator migrating the same table into the same simulated target
  _creates_ the records rather than skipping them, which is only possible if their target was empty.

Removing the organization predicate from the demo connector fails the suite immediately.

**Expiry.** Abandoned evaluator workspaces are deleted after `DEMO_WORKSPACE_TTL_HOURS` (default 48),
cascading everything. A workspace with a session that has not expired is never removed, whatever its
age — logging somebody out mid-evaluation is worse than keeping the row.

### What the boundary does not yet cover

- **Workspaces are not a separate concept from organizations.** The model in `TRUST_SPRINT.md` §3
  (Organization → Workspace → Projects) is not built. Today one organization is one workspace. For a
  customer wanting production and sandbox workspaces under one tenant, that is a gap.
- **No per-project access control.** Everyone in an organization sees every project in it.
- **Cost per evaluator.** Each anonymous sign-in seeds ~1,250 simulated rows and runs two real
  migrations. On the QA instance that takes roughly 30–60 seconds of background work. At a hundred
  concurrent evaluators that is a real load, and nothing throttles it.

---

## 2. Validation: what it can prove

| Dimension                      | State                                                           | Evidence                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Completeness**               | SUPPORTED                                                       | Row counts plus record existence through the identity map, bounded by depth and declared as coverage.                                                                                                                                                                               |
| **Accuracy**                   | SUPPORTED                                                       | Every mapped column compared, semantically.                                                                                                                                                                                                                                         |
| **Transformation correctness** | SUPPORTED                                                       | Compares against the value the transformation _should_ have produced, using the same engine and the run's own snapshot of the rules.                                                                                                                                                |
| **Relationships**              | SUPPORTED                                                       | Lookups resolved through the identity map; broken references counted separately.                                                                                                                                                                                                    |
| **Duplicates**                 | SUPPORTED where the connector can group; NOT VERIFIED otherwise | `GROUP BY key HAVING COUNT(*) > 1` run by the database. Implemented for SQL Server, Azure SQL, PostgreSQL, MySQL and the simulators. Not for real Dataverse.                                                                                                                        |
| **Nullability**                | SUPPORTED                                                       | A value present in the source after transformation and absent in the target is `VALUE_LOST`, reported separately from a wrong value.                                                                                                                                                |
| **Types**                      | SUPPORTED                                                       | Comparison is semantic, not textual: numbers within the column's own precision, dates parsed and normalised, booleans coerced, multi-selects order-independent, GUIDs case-folded. Truncation is its own finding when the target holds a strict prefix at exactly the column width. |
| **Traceability**               | SUPPORTED                                                       | Source id → run → target id per record, exportable.                                                                                                                                                                                                                                 |
| **Scope and accountability**   | SUPPORTED                                                       | Created / updated / unchanged / skipped / failed, and the target's pre-existing rows are never attributed to the run.                                                                                                                                                               |

### Coverage

Three states, never styled alike:

- **FULL** — every eligible record compared. Only `depth: FULL` can produce it.
- **SAMPLED** — the report gives eligible, examined, percentage, the cap and how the records were
  chosen: _the first in source-identifier order_. Reproducible, and deliberately not described as a
  random or stratified sample, because it is neither and nothing here supports an inference about the
  records nobody looked at.
- **NOT VERIFIED** — the check could not run. Distinct from PASS, and the duplicate check can be NOT
  VERIFIED on a table whose values all matched.

Depths: Quick (500/table), Standard (5,000/table), Full (uncapped). Named for what they cost. **No
statistical confidence is claimed anywhere**, because the sampling model does not support one.

### Still missing

- **Dataverse duplicate detection.** `$apply=groupby(...)` exists in the OData spec and we have no
  tenant to verify it against, so the connector does not implement it and the report says NOT
  VERIFIED. That is the honest state and it is also the least satisfying cell in the matrix.
- **Aggregate checks.** Sums and averages of numeric columns are not compared — a plausible way to
  detect loss cheaply over tables too large to validate record by record.
- **Validation of unchanged/skipped records' field values** happens, but is reported as
  `PRE_EXISTING_DIFFERENCE` warnings rather than as its own dimension.

---

## 3. Connector verification

> **Superseded by `VERIFICATION.md` (1 October 2026, Phase 3).** The connectors have since been run
> against real PostgreSQL 16, MySQL 8.4 and SQL Server 2022 servers through their production
> drivers, which found two bugs: SQL Server's catalog query was a syntax error against a real
> server, and MySQL reported varchar lengths as strings so truncation detection could never fire.
> The section below is kept because its reasoning still holds; its levels are out of date.

See `shared/connector-verification.ts`, which is tested rather than maintained by hope.

The finding that matters: **the end-to-end journeys run against built-in simulators.** "Legacy SQL
Server (Demo)" is a simulator over the platform's own database. No real SQL Server, Azure SQL or
MySQL is reached in continuous integration at all.

| Connector                  | Overall                                     | Notes                                                                                                                                    |
| -------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **File (CSV/Excel/XML)**   | VERIFIED                                    | No external engine to simulate; storage is our own database and the journey uploads a real file. Read-only by design.                    |
| **PostgreSQL**             | Schema discovery VERIFIED, rest IMPLEMENTED | PGlite is PostgreSQL compiled to WebAssembly, so catalog queries run against a real `pg_catalog`.                                        |
| **SQL Server / Azure SQL** | IMPLEMENTED                                 | Code complete, SQL unit-tested, never run against the engine in CI.                                                                      |
| **MySQL**                  | IMPLEMENTED                                 | As above. Already disclosed on the landing page.                                                                                         |
| **Microsoft Dataverse**    | SIMULATED                                   | The flagship target. Everything we know comes from a simulator written to match documented behaviour. Duplicate detection NOT SUPPORTED. |
| **OneDrive / SharePoint**  | IMPLEMENTED, REQUIRES CONFIGURATION         | Needs Graph consent. Read-only by design.                                                                                                |

**The single highest-value engineering investment available** is a CI job that runs the existing
journeys against real SQL Server, PostgreSQL and MySQL containers. Most of the matrix would move to
VERIFIED in an afternoon of plumbing, and the claims would then be worth something.

---

## 4. Scale

Classified by tracing the architecture, not by benchmarking. Nothing here has been run at volume and
this document does not claim it has.

### Safe

| Area                   | Why                                                                               |
| ---------------------- | --------------------------------------------------------------------------------- |
| Source reads           | Paged through `queryRecords`, page size bounded at 500. Never loads a table.      |
| Record writes          | Batched, concurrency capped at 4, pause and cancel honoured between batches.      |
| Run counters           | A single `GROUP BY` aggregate, not a scan.                                        |
| Deferred-lookup pass   | Keyset-paged on source id (fixed this sprint).                                    |
| Modified-by pass       | Keyset-paged on source id (fixed this sprint).                                    |
| Resume membership      | Per-page indexed lookup, skipped entirely on a first attempt (fixed this sprint). |
| Validation differences | Capped at 2,000 stored per table, and the report says so.                         |
| Duplicate detection    | Grouped by the database; at most 50 groups and 5 sample ids each returned.        |

### Needs testing

| Area                    | Concern                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity map growth     | One row per processed record, forever. A 100-million-row migration is a 100-million-row table with a unique index on `(run, table, source id)`. Correct, and nobody has measured the insert rate or the disk. |
| Validation `fetchByIds` | Chunks at 200 ids per call; fine at a 5,000 cap, unmeasured if the cap rises.                                                                                                                                 |
| Demo workspace creation | ~1,250 seeded rows plus two real migrations per anonymous sign-in. Unthrottled.                                                                                                                               |
| PGlite in production    | The embedded database is used when `DATABASE_URL` is unset. Fine for a laptop, not for a pilot.                                                                                                               |

### Scale risk

| Area                  | Concern                                                                                                          | Suggested fix                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Audit `details`       | Unbounded JSONB per event, written on every consequential action. A run with a large options payload repeats it. | Cap the serialised size and store a reference for the remainder. |
| Record-map CSV export | `limit: 100_000` in one response.                                                                                | Stream it, or paginate with a continuation.                      |
| Validation storage    | Differences are capped per table but not per run; 500 tables × 2,000 = a million rows.                           | Cap per run as well, and say so in the report.                   |
| Table count           | Plans accept up to 500 tables; dependency analysis is in-memory over the whole set. 1,500 tables is untested.    | Measure before promising.                                        |

### Architectural limit

| Area                         | Limit                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-process worker        | One worker drains the queue. Throughput is one process. Horizontal scaling needs a real lease/claim protocol in the queue; the schema has the shape for it but nothing is tested for concurrent workers. |
| No transaction across tables | Dataverse has no cross-table transaction, so a partial migration is the designed behaviour. Rollback is an inventory, not an execution — already disclosed.                                              |
| 30–40 years of history       | Nothing is time-partitioned. An incremental read needs a watermark column; a table without one is a full read every time.                                                                                |

**Answer to "5 million rows, fails at 3.8 million":** the identity map holds every processed record,
so re-running writes only the remainder without duplicating. Pause and cancel are honoured between
batches. After this sprint the resume path no longer loads the identity map into memory first. The
unmeasured part is how long 5 million identity rows take to insert and how large that table gets.

---

## 5. Roles and permissions (design only)

Nothing is built. Today `role: ADMIN | MEMBER` on a user, plus `platformOperator` from
`ADMIN_EMAILS` — a deployment operator, deliberately distinct from a customer administrator.

Proposed, smallest set that covers the real jobs:

| Role                   | Connections & credentials | Projects & mapping | Execute             | Validate | Exports | Audit | Members     |
| ---------------------- | ------------------------- | ------------------ | ------------------- | -------- | ------- | ----- | ----------- |
| **Organization admin** | Full                      | Full               | Any target          | Yes      | Yes     | Yes   | Yes         |
| **Workspace admin**    | Full in workspace         | Full               | Any target          | Yes      | Yes     | Yes   | Invite only |
| **Migration lead**     | Use, not create           | Full               | Any target          | Yes      | Yes     | Read  | No          |
| **Engineer**           | Use, not create           | Full               | Non-production only | Yes      | Yes     | Read  | No          |
| **Validator**          | Use, not create           | Read               | No                  | Yes      | Yes     | Read  | No          |
| **Auditor**            | Read names only           | Read               | No                  | No       | Yes     | Yes   | No          |

Two principles worth fixing now, before more code assumes otherwise:

1. **Executing against production is a separate permission from editing a plan.** The confirmation
   gates already treat it as a different kind of act; the role model should agree.
2. **Reading credentials is nobody's permission.** No route returns a password today. That should
   stay a property of the system rather than of a role.

---

## 6. Remaining P0/P1

**P0 — none open.** Workspace isolation, duplicate detection and explicit coverage are done,
deployed and tested.

**P1 open:**

1. **Dataverse duplicate detection** — the flagship target reports NOT VERIFIED.
2. **Real-engine CI** — would move most of the connector matrix off IMPLEMENTED.
3. **Information architecture** — the global wizard and the project model still coexist. The safe
   half is done (no step indicator on pages that state their own context); the rest is a decision.
4. **Team management** — designed above, not built.
5. **Evidence export** — a run exports records, errors and a validation summary as separate CSVs.
   There is no single retainable evidence bundle with the configuration snapshot, coverage and
   connector limitations in it.
6. **Readiness assessment** — preflight answers "what will this do?" well. "What will stop this
   succeeding?" is answered across preflight, plan issues and analysis findings rather than in one
   place.
