# Verification: what each level means, and how to earn the next one

Written for the engineering team. The taxonomy lives in `shared/connector-verification.ts`; the
evidence lives in `evidence/engine-verification.json`; this explains the reasoning and the plan for
the two connectors that cannot yet be verified automatically.

Dated 1 October 2026.

---

## 1. The ladder

Each level is a strictly stronger claim than the one below. `levelRank` encodes the order so a
summary cannot round a weak row up.

| Level                    | Means                                                             | Evidence behind it                                                      |
| ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `NOT_SUPPORTED`          | Deliberately absent                                               | A design decision                                                       |
| `REQUIRES_CONFIGURATION` | Available once somebody supplies network access or consent        | Cannot be exercised by us                                               |
| `SIMULATED`              | Exercised against our simulator                                   | Simulator tests. No real instance reached                               |
| `UNIT_TESTED`            | Logic tested in isolation                                         | Unit tests. No database involved                                        |
| `IMPLEMENTED`            | Production code passing tests that never reach the real engine    | Integration tests against simulators                                    |
| `ENGINE_COMPATIBLE`      | Run against a genuine build of the engine, in-process             | Embedded build. Proves the SQL and the catalog, not the connection path |
| `ENGINE_VERIFIED`        | Run against an actual server, through the real driver and network | Conformance suite, recorded with the server version                     |
| `ENVIRONMENT_VERIFIED`   | Run against a hosted environment matching customer deployment     | Conformance against a managed instance                                  |

### Why `ENGINE_COMPATIBLE` exists

Because we got this wrong, and the level is the correction.

PostgreSQL schema discovery was marked verified against the real engine on the strength of PGlite.
PGlite is PostgreSQL compiled to WebAssembly: genuine `pg_catalog`, genuine SQL, genuinely valuable.
It is also **linked into the test process**. There is no server, no wire protocol, no `pg` driver,
no authentication, no socket, no TLS. Those are exactly the layers a customer's deployment has and
exactly where connectors break. Collapsing that distinction made the taxonomy easy to challenge, so
PGlite gets a level of its own and PostgreSQL earned `ENGINE_VERIFIED` separately, against a real
server.

---

## 2. How a claim is prevented from outrunning its evidence

Three mechanisms, each covering a different way the claim could drift.

**The evidence file.** `npm run test:engines` runs the conformance suite against real servers and
writes what it proved — engine, server version, driver, and each capability that passed — into
`evidence/engine-verification.json`. Capabilities are recorded one at a time as each assertion
survives, so a suite that failed halfway records what it reached and nothing after it.

**The matrix test.** `tests/unit/connector-verification.test.ts` refuses any `ENGINE_VERIFIED` cell
the evidence file does not back, for that exact connector and that exact capability. Delete the
evidence and it fails. Promote a row without running the suite and it fails. Claim a capability the
suite never exercises and it fails. Promoting a row is no longer an edit — it is an edit plus a
passing run against a real database.

**The drift check.** In CI, `scripts/check-evidence-drift.mjs` compares what the engines just proved
against what the repository claims. A capability that used to pass and no longer does fails the
build; a capability that newly passes but has not been committed fails the build and says so. A new
timestamp or a newer container patch version is noted, not failed — a check that cried wolf on those
would be ignored within a week.

**And the suite itself is mutation-tested**, because a conformance suite that always passes is worse
than none. Six mutations are currently caught: identifier quoting removed, pagination stopping after
the first page, the duplicate `HAVING` clause loosened, nullability misread, varchar length dropped
from metadata, and every column mapped to the same type. The first attempt at the suite _did not_
catch the quoting mutation — the fixtures used only quote-safe names — so every fixture now carries
a reserved-word column (`order`) and a mixed-case one.

### A claim about uniqueness is only as good as the key it was counted over

A duplicate check is the only check that can catch a migration which wrote every record twice: value
comparison cannot see it, because each source record finds a target record holding exactly the right
values — just not only one of them. So the check matters. But _which columns_ it grouped on decides
what finding nothing proves, and those were being reported as one thing.

With no alternate or business key configured, the scan falls back to the target's own primary id. It
finds nothing, every time, because the target refuses a repeated primary key by itself. Reported as
"no duplicates", next to a row of passes, that restates the platform's guarantee and says nothing
about the data.

So every duplicate finding now carries the basis it was counted over, and the report distinguishes
four answers:

| Basis                    | Enforced by the target | Proves business uniqueness | What a clean result means                                                |
| ------------------------ | ---------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `PRIMARY_KEY`            | Yes                    | **No**                     | Only that the target kept its own promise. Nothing about the data.       |
| `ALTERNATE_KEY`          | Yes                    | Yes                        | No two target records share a key the customer declared.                 |
| `BUSINESS_KEY`           | No                     | Yes                        | A real test: nothing enforced this, and the migration did not duplicate. |
| `COMPOSITE_BUSINESS_KEY` | No                     | Yes                        | The same, over several columns together.                                 |
| `NOT_VERIFIED`           | —                      | **No**                     | The check did not run. The reason says why.                              |

`shared/uniqueness.ts` holds the vocabulary and writes the sentence, so the words a customer reads
and the words a test asserts are the same words. Under `PRIMARY_KEY` the report never prints "no
repeated values"; it prints what was checked and what that does not establish. The run-level summary
carries `businessUniquenessVerifiedTables`, and when it is zero the report says so in the headline
rather than letting a clean verdict be read as a uniqueness result.

`tests/unit/uniqueness.test.ts` holds the vocabulary; two cases in
`tests/integration/duplicate-detection.test.ts` run the same table under both match strategies, so the
only thing that differs between them is what the report is entitled to say.

---

## 3. What the real-engine suite covers

`tests/engines/conformance.ts`, run against PostgreSQL 16, MySQL 8.4 and SQL Server 2022.

Connection and authentication · schema and table discovery · column metadata including nullability,
varchar length and decimal scale · primary keys · foreign keys becoming lookups · exact row counts ·
keyset pagination across several pages with no row seen twice · reads of Unicode and emoji, long
text, empty strings, NULL, quotes and backslashes, large integers, decimals, timestamps and
timezone-aware timestamps where the engine has them · duplicate detection counted by the database ·
writes including Unicode and explicit nulls and decimal precision · finding a record by business key
· updating it without touching what it was not asked to · an unknown table raising rather than
reading as empty.

Fixtures are created with the **raw driver** before the connector sees them, so the connector is
describing rows it did not create. A connector that invented its answers would disagree with what is
actually in the database. The fixture schema is dropped afterwards whatever happened.

### What it does not cover

Transformations, validation, rollback inventory and retry/resume live in the engine **above** the
connector. They are exercised thoroughly against the connector contract, but not against any
particular database, so labelling them engine-verified would borrow credit from a run that did not
cover them. They stay at `IMPLEMENTED`, and `ENGINE_PROVABLE` is the list the matrix test enforces.

---

## 4. Azure SQL: verification plan

**Current level: `IMPLEMENTED`, with `connect` at `REQUIRES_CONFIGURATION`. It inherits nothing from
SQL Server**, and a test asserts it cannot.

Azure SQL shares SQL Server's implementation, and sharing an implementation is not evidence. What
differs is everything around the query — and that is where connections fail.

| Azure-specific risk                    | Why a local container cannot show it     | How to verify                                                                   |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| Entra authentication                   | The container has SQL logins only        | A test server with Entra auth enabled; exercise token acquisition and expiry    |
| Firewall rules                         | No firewall in front of a container      | Verify the error when the client IP is not allowed is actionable, not a timeout |
| Enforced encryption                    | The container runs with `encrypt: false` | Azure SQL always encrypts; verify certificate validation on the real endpoint   |
| Transient faults (40197, 40501, 40613) | Never produced locally                   | Verify the retry policy classifies them as retryable and backs off              |
| Throttling / DTU limits                | No resource governor locally             | Verify a throttled write is retried rather than failed                          |
| Idle connection termination            | Local pools are never cut                | Verify the pool recovers rather than failing the run                            |

**Recommended approach:** a single Azure SQL Basic tier database in a dedicated subscription, created
and destroyed by the workflow, reached through a `TEST_AZURE_SQL_URL` secret. Run the same
conformance suite plus an Azure-specific group for the table above. Until then the honest level is
`IMPLEMENTED`.

**Blocked on:** an Azure subscription and a decision about standing cloud cost. The brief says not
to create uncontrolled cloud resources, and this needs resources, so it is documented rather than
done.

---

## 5. Dataverse: verification plan

**Current level: `SIMULATED` throughout, with `duplicateDetection` at `NOT_SUPPORTED`.** The
flagship target, and everything we know about it comes from a simulator written to match documented
behaviour. A simulator agrees with whoever wrote it.

**Test architecture, so a tenant can be plugged in rather than designed for later:**

```
TEST_DATAVERSE_URL      https://org.crm.dynamics.com
TEST_DATAVERSE_TENANT   the dedicated test tenant's id
TEST_DATAVERSE_CLIENT   an app registration confined to that tenant
```

Never a production tenant, and never a tenant that holds anything real. The suite must refuse to run
unless the environment explicitly declares itself a test tenant, because "point it at your sandbox"
is how somebody eventually points it at production.

**Tests grouped by what they risk:**

| Group                                  | Contents                                                                                                                                                                             | Automatable                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Safe read**                          | Authentication, token refresh, metadata discovery, entities, attributes, option sets, alternate keys, lookups, pagination, `$filter` on a watermark, throttling behaviour under load | Yes, immediately                                        |
| **Safe write (test environment only)** | Create, update, upsert by alternate key, GUID handling, lookup resolution, relationship writes, deferred second pass, duplicate detection via `$apply=groupby`                       | Yes, against a dedicated environment                    |
| **Privileged**                         | Impersonation, `overriddencreatedon`, owner assignment, teams and business units, plug-in bypass                                                                                     | Yes, but needs elevated privileges granted deliberately |
| **Destructive / not automated**        | Bulk delete, solution import, anything that cannot be undone                                                                                                                         | No. Documented as manual, with a checklist              |

**The one capability worth doing first** is duplicate detection. `$apply=groupby((col),aggregate($count as count))`
is in the OData spec and Dataverse supports a subset of it; verifying which subset would move the
one cell currently reading `NOT_SUPPORTED` on the product's most important target.

**Blocked on:** a dedicated test tenant. Documented rather than faked.

---

## 6. How to run it

```bash
# Real servers, locally
docker run -d --name pg    -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=db -p 15432:5432 postgres:16-alpine
docker run -d --name mysql -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=db -p 13306:3306 mysql:8
docker run -d --name mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Pw!2026' -p 11433:1433 \
  mcr.microsoft.com/mssql/server:2022-latest

TEST_POSTGRES_URL=postgresql://postgres:pw@localhost:15432/db \
TEST_MYSQL_URL=mysql://root:pw@localhost:13306/db \
TEST_MSSQL_URL=sqlserver://sa:Pw%212026@localhost:11433/db \
  npm run test:engines
```

Then commit `evidence/engine-verification.json`. The matrix test reads it; CI re-runs the suite and
refuses evidence that no longer matches the engines.

An engine whose variable is unset is **skipped**, never assumed. A missing database can never be
mistaken for a pass.
