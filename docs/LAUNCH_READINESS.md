# Launch readiness

Written for: a technical evaluator deciding whether to pilot this — a partner architect, an SI lead, or
a Microsoft reviewer.

This document is written to be read by a sceptic. It states what the platform does, what it refuses to
do, where its numbers are complete and where they are bounded, and what is not built yet. Anything
claimed here is covered by a test; anything not tested is marked as such.

---

## 1 · What it is

A data analysis and migration platform. Work lives in a **project**, and a project is one of two
kinds:

|                 | Data analysis                                                    | Data migration                       |
| --------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Reads a source  | yes                                                              | yes                                  |
| Writes anywhere | **no — enforced**                                                | yes, behind every gate below         |
| Purpose         | Understand what is actually in a system before deciding anything | Map it, prove it, move it, verify it |

A migration project can be built from an analysis project, so the mapping starts from measured facts
rather than assumptions.

**Lifecycle:** Analyse → Map (in the app or in a spreadsheet) → Plan → Clean & transform → Preflight →
Migrate → Validate → Reconcile → Schedule.

## 2 · Sources

| Source                     | Read | Write  | Verified against                                                                                                        |
| -------------------------- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Microsoft Dataverse        | yes  | yes    | Simulated Dataverse end to end; real Web API semantics implemented (batching, throttling, `Retry-After`, impersonation) |
| SQL Server                 | yes  | yes    | Simulated SQL Server end to end                                                                                         |
| Azure SQL                  | yes  | yes    | Shares the SQL Server connector                                                                                         |
| PostgreSQL                 | yes  | yes    | **Real PostgreSQL** — PGlite is Postgres compiled to WebAssembly, so `pg_catalog` behaves as on a server                |
| MySQL / MariaDB            | yes  | yes    | Unit level only; the driver path needs a server (see §8)                                                                |
| CSV / Excel upload         | yes  | **no** | End to end, including in a browser                                                                                      |
| OneDrive / SharePoint file | yes  | **no** | Unit level only; never run against a real tenant                                                                        |
| SharePoint list            | yes  | **no** | Unit level only; never run against a real tenant                                                                        |

Files and lists are read-only by construction rather than by omission: capabilities report it, the
tables are marked as views so the planner refuses them as targets, no "set as target" control is
rendered, and the connector's write methods refuse. Four independent places, deliberately.

Details, including how to add a dialect: `docs/SOURCES.md`.

## 3 · What makes the numbers trustworthy

This is the part worth scrutinising, because it is the product's actual claim.

**Every statistic says whether it is exact or sampled.** `EXACT` requires both an exact row count from
the source _and_ every record examined. One sampled table makes an analysis sampled, and the screen
says so. An estimate is never presented as a total.

**One transformation engine.** Preview, preflight, migration and validation all call the same
`transformField`. If the preview says a value becomes `100000000`, preflight classifies against
`100000000`, the migration writes it, and validation compares it. A second implementation would let
those four disagree, which is the class of bug that makes a migration tool untrustworthy.

**Data loss is counted, not estimated.** A `TRUNCATE(160)` over 145,283 records where 38 exceed the
limit reports **38** — records that actually lose information, not records the rule runs on. Measured
by the preflight, which already reads every record; labelled `SAMPLED` when it comes from a bounded
scan instead.

**Where a list is bounded, it says so.** The counts are always complete. The per-record drill-down is
capped per action per table, and the preflight screen shows a "list capped" badge with the real
figures, the remediation package carries a row explaining it, validation reports it as a check, and
every CSV that hit its row limit ends with a line stating how many rows of how many it contains.

**A run reports what actually happened.** A whole table can fail without a single record failing.
Every such signal feeds one decision, so a run that lost a table is never stamped COMPLETED, the plan
is not marked EXECUTED, and the audit trail does not record success.

## 4 · Safety

**Nothing modifies a source.** Ever. Cleaning and transformation happen in flight.

**Nothing is written without a dry run being available.** Preflight classifies every source record as
CREATE / UPDATE / UNCHANGED / CONFLICT / BLOCKED with field-level detail, and shares its decision code
with the migration engine so the two cannot diverge.

**Matching is deterministic, never a guess.** Identity map → primary id → active alternate key →
configured business key. Two candidate matches is a conflict, not a choice. Two source records
claiming one target is refused.

**Data loss requires a named acknowledgement.** Each lossy rule is accepted individually by key;
adding another afterwards invalidates the acceptance and asks again. Recorded in the audit trail with
who and when.

**Ownership and attribution are never silently reassigned.** An unresolvable user reference either
blocks the record (`STRICT`) or uses an identity you chose explicitly (`FALLBACK`). Preserving
"created by" uses impersonation and is blocked unless the privilege is verified.

**Idempotent.** A record identity map, a unique key per run, and id preservation within one provider.
Running the same migration twice does not duplicate: the second run reports them as skipped.

**Resumable.** Pause, cancel and retry are durable across a worker restart — all control state is in
the database, with stale-job recovery. A re-run skips everything already migrated.

**`REAL_TENANT_READ_ONLY`** blocks every write to a real system, enforced at the application layer and
again inside every connector. A scheduled run cannot bypass it.

## 5 · Security posture

| Area             | Position                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication   | Entra ID, auth code + PKCE, single-use state, encrypted token cache. Sessions store only a hash of the token, expire server-side, and carry a per-session CSRF token                                                                                                                                                                                                                 |
| Tenant isolation | Every id-taking service method is organization-scoped. Tested by probing **every** route as another organization's **administrator**, because isolation must not depend on the role                                                                                                                                                                                                  |
| Authorization    | Members plan, analyse, preflight and migrate to non-production. An administrator is needed for what outlives the task: writing to production, writing unattended (schedules), and destroying shared configuration. An unclassified target counts as production                                                                                                                       |
| Scheduled runs   | Execute as their creator with the role held **now**, so revoking someone's access stops their schedules                                                                                                                                                                                                                                                                              |
| Credentials      | Encrypted at rest with AES-GCM in a separate table, decrypted only when a connector is built, never returned by the API, never logged. The API accepts a password and never emits one                                                                                                                                                                                                |
| Injection        | Every value is a bound parameter; no query concatenates input. Identifiers are resolved against real catalog metadata before being quoted, and anything that could not be a real identifier is refused rather than escaped                                                                                                                                                           |
| Uploads          | Size-bounded, with an inflation limit enforced inside the decompressor and spreadsheet references clamped to the real grid — a small file cannot force a large allocation. No XXE or entity expansion: the XML is never given to a DTD-aware parser                                                                                                                                  |
| Secured columns  | Masked in every preview, drill-down and export; the preflight stores them already masked                                                                                                                                                                                                                                                                                             |
| Exports          | CSV formula injection neutralised; `.xlsx` cells cannot be reinterpreted as formulas                                                                                                                                                                                                                                                                                                 |
| Public surface   | One route answers without a session and writes: the landing page's access-request form. Every field is length-bounded, one row per address, a honeypot is dropped silently, and the response is identical whether the address was new, already known or discarded — a public form must not become an enumeration oracle. It is the most tightly rate-limited endpoint in the product |
| Rate limiting    | Global, with tighter per-route limits on everything that scans a database, inflates an upload or queues a job, and the tightest on the endpoint that opens a connection to a host the caller names                                                                                                                                                                                   |
| Audit trail      | Every consequential action, with organization, user, request id, environments and options                                                                                                                                                                                                                                                                                            |

**Access to the deployment.** Where Microsoft sign-in is configured and no tenant allow-list is set,
the first person from a tenant creates that workspace and becomes its administrator; everyone after
them joins as a member. With an allow-list, unknown tenants are refused and the landing page offers
the request form instead of a sign-up that would dead-end. Inbound requests are readable only by the
operators of the deployment (`ADMIN_EMAILS`) — never by an administrator of a customer organization,
because they are other people's contact details rather than that tenant's data.

## 6 · Limits

The migration itself **streams and is not capped** — a real migration is never silently truncated.

The bounded things are in the assurance layer, and each is disclosed where it applies:

| Bound                                         | Value          | Disclosed                                                  |
| --------------------------------------------- | -------------- | ---------------------------------------------------------- |
| Preflight records analysed per table          | 20,000         | "sampled" badge                                            |
| Preflight records stored per action per table | 2,000          | "list capped" badge, plus a row in the remediation package |
| Validation records compared per table         | 5,000          | In the check message                                       |
| Validation differences stored per table       | 2,000          | As a check on the table                                    |
| CSV export rows                               | 50,000–100,000 | A final line in the file                                   |
| Analysis tables per run                       | 200            | Rejected, not truncated                                    |
| Profiling sample ceiling                      | 200,000        | `SAMPLED` basis                                            |

## 7 · Operations

Single container plus PostgreSQL. A durable job queue in the database — no Redis, no broker. Workers
claim with `FOR UPDATE SKIP LOCKED` so several can run side by side; stale jobs are recovered.
Health endpoint, structured logs with secret scrubbing, and schema migrations applied on start.

Deploys to Railway today; nothing ties it there.

## 8 · What is not built, and what is not verified

Stated plainly, because you will find it anyway.

**Rollback execution.** Not implemented, deliberately. The platform inventories everything a run
created, in reverse dependency order, and tells you so — but it does not delete. It also does not
capture before-images, so an updated record could not be restored, and the product says that rather
than implying otherwise. Auto-deleting production data on an incomplete picture would be worse than
refusing. _The missing primitive is before-image capture; that is the work, not the delete._

**Retry re-reads the source.** Only failed records are written, and already-migrated records are
skipped, never duplicated — but the source is read again from the start. On a very large table that is
a real cost, and the button says so.

**MySQL's driver path is unverified.** Quoting, parameter binding, the type vocabulary and
catalog-to-metadata are covered outright. The conversation with a real server is not, because there is
no embedded MySQL to test against. It is one environment variable away:
`TEST_MYSQL_URL=mysql://… npm test` runs the full connector contract against your server.

**OneDrive and SharePoint have never run against a real tenant.** Link resolution, sharing-link
encoding, list-to-rows shaping and the access diagnosis are unit-tested against a stubbed Graph. To
compensate, those connections perform a real Graph probe when tested and name which of four things is
wrong — the feature is off, nobody consented, the account lacks the scope, or Graph is unreachable.

**On-premises connectivity needs a network path.** A hosted deployment cannot reach a server behind a
corporate firewall. The outbound agent is designed (`docs/ON_PREM_AGENT_ARCHITECTURE.md`) and not
built; today the answer is a network route or a self-hosted deployment.

**No DELETE synchronisation.** The platform never deletes in a target. A record removed from the
source is not removed from the target.

**Authentication modes.** SQL and PostgreSQL logins use password authentication; Entra-based SQL
authentication modes are declared and not implemented.

## 9 · Verification

Run `npm run verify`: format, lint, typecheck, 471 tests across 39 files, build, and 6 end-to-end
browser journeys.

What the tests are for, beyond coverage:

- **A connector contract** every connector must satisfy — discovery, projection, paging stability,
  lookup by id and by value, watermark handling, read-only refusal. Validated by deliberately breaking
  a projection and a keyset predicate and confirming it catches both. Runs against a real server when
  you supply a URL.
- **Tenant isolation** probed as another organization's administrator, across every route.
- **Authorization** pinning both what is refused and what remains allowed.
- **Run honesty** — that a finished run, its plan and its audit trail cannot disagree.
- **Upload safety** — that a zip bomb and a spreadsheet claiming two billion rows are both refused
  from a file small enough to pass every size check.
- **Every screen** visited in a browser with a failure on any console error or bad response.

## 10 · What a pilot needs from you

1. A source and a target, and a network path to both.
2. A service account per system, with the rights in `docs/MICROSOFT_SETUP.md`,
   `docs/SQL_SERVER_SETUP.md`, `docs/AZURE_SQL_SETUP.md` or `docs/POSTGRES_SETUP.md`. Read-only is
   enough for the whole analysis half.
3. A non-production target to migrate into first. The product assumes this and enforces it for members.

A useful pilot is one table with a real problem in it — a duplicate key, an unresolvable owner, a
column longer than its destination. The product is built to find those, and finding one in your data is
worth more than a clean run.
