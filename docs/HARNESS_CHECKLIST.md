# What to provide, to turn SIMULATED into VERIFIED

Two harnesses are written, compile, lint, and skip cleanly with nothing configured. **Neither has ever
been executed.** Every Dataverse capability in `shared/connector-verification.ts` says `SIMULATED` and
Azure SQL says `REQUIRES_CONFIGURATION` for `connect`, and both will keep saying so until a recorded run
of these files says otherwise. That is enforced by `tests/unit/connector-verification.test.ts`, which
refuses a claim the evidence files do not back.

This page is the handover: exactly what somebody has to supply, what each thing is for, and what it
costs. **No secret value appears here or belongs here.**

---

## Dataverse

`tests/tenant/dataverse.tenant.test.ts` — 26 cases. Run with `npm run test:engines`.

> **This harness cannot currently reach a real environment, whatever you configure.** Its setup cannot get
> there from here, for three independent reasons: `tests/helpers.ts` `createTestApp` hard-codes
> `DEMO_MODE: 'true'` and empty `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`, so no delegated token can be
> acquired; the database is created `memory://`, fresh and empty every run; and `harnessContext` calls
> `api.demoLogin()`, so it looks for your environment inside a brand-new demo organization and asserts it
> is there. Signing in to a deployment does not put a row in that database — the two steps never share one.
>
> Running this file against `TENANT_TEST_URL` therefore fails in `beforeAll`, at
> `expect(wanted).toBeTruthy()`. Recorded as D1 in
> [DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md](DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md),
> along with what would have to change.
>
> **For read-only certification, use `scripts/certify-dataverse-readonly.mjs` instead.** It drives a
> deployed build's own HTTP API with a real session, substitutes nothing, and is the route section 13 of
> that report describes. This harness's remaining value is the **write** half below, which that script
> deliberately does not do.

### The environment

| Provide                                                                                          | What it is                                                                           | Risk                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A **non-production** Power Platform environment                                                  | Everything runs against this one                                                     | Reads are harmless. Writes touch only the table you name below                                          |
| A dedicated custom table in it, e.g. `dvm_testrecord`                                            | Where every write goes                                                               | The suite refuses `account`, `contact`, `opportunity`, `lead` and `systemuser` even if a flag names one |
| A signed-in user, through part A of [REAL_TENANT_CERTIFICATION.md](REAL_TENANT_CERTIFICATION.md) | The harness authenticates through the product's own identity path, never from a file | None                                                                                                    |

### What the test table needs, for each capability to be exercised rather than skipped

The suite records `NOT_ATTEMPTED` with a reason for anything the table cannot support. Add these columns
if you want the corresponding row to produce evidence rather than a note.

| Column on the test table                                 | Unlocks                      | Skipped reason if absent            |
| -------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| A text primary name                                      | everything                   | —                                   |
| An **alternate key** over one or two text columns        | `alternateKeyUpsert`         | "defines no alternate key"          |
| A **lookup** to any table                                | `relationshipWrite`          | "no writable lookup column"         |
| A **self-referencing lookup** (to the test table itself) | `deferredRelationship`       | "no self-referencing lookup"        |
| User ownership (`ownerid`)                               | `ownerMapping`               | "is not user-owned"                 |
| `overriddencreatedon`                                    | `createdOnPreservation`      | "has no overriddencreatedon column" |
| A numeric column                                         | nothing, for now — see below | —                                   |

The `aggregates` case will record `NOT_ATTEMPTED` whatever the table looks like, and that is correct: the Dataverse connector deliberately does not implement server-side aggregates, because FetchXML totals within an aggregate row limit it silently stops at — the opposite of what a reconciliation is for. The case exists so that if the connector ever gains the capability, the harness already asks about it.

### The variables

| Variable                  | Value                    | Effect                                                                  |
| ------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `TENANT_TEST_URL`         | the environment's URL    | **Nothing runs without it.** Read-only on its own                       |
| `TENANT_TEST_WRITE`       | `1`                      | Permits the write half. A separate deliberate act from naming the table |
| `TENANT_TEST_WRITE_TABLE` | the table's logical name | The only table writes may touch                                         |
| `TENANT_TEST_PRIVILEGED`  | `1`                      | Permits the impersonation and created-on checks                         |

### The privilege, for two cases only

`prvActOnBehalfOfAnotherUser` — _Act on Behalf of Another User_. Microsoft documents that it must be
assigned **directly to the user**, not inherited through a team. Without it, `createdOnPreservation` and
the impersonation check record `NOT_ATTEMPTED` and everything else still runs.

### What it will not do, whatever you set

- **It cannot delete what it creates.** The product has no `deleteRecord` — "never issue DELETE as part
  of synchronisation" is a standing rule — so adding one to let a test tidy up would trade a real safety
  property for a convenience. Instead every record carries `DVM-HARNESS` in its primary name and the run
  writes `evidence/tenant-cleanup.json` listing each one by table and id. Removal is one filtered delete
  you perform.
- **It will not provoke throttling.** Reading hard enough to be throttled in somebody's environment is
  rude. The retry policy is unit-tested and its behaviour against the live service stays unverified.
- **It will not claim duplicate detection works.** `$apply=groupby` is valid OData and Dataverse
  implements a subset with an aggregate record limit it stops at rather than pages past. For a duplicate
  scan that is the worst available failure: "no duplicates" from a query that stopped early. The
  connector therefore does not implement `findDuplicateKeys` for Dataverse, the matrix says
  `NOT_SUPPORTED`, and a validation report says NOT VERIFIED rather than passing.

### Afterwards

The run writes `evidence/tenant-verification.json`: the environment, the version it reported, the mode,
and each capability as `PASSED`, `FAILED` or `NOT_ATTEMPTED` with a reason. Raising Dataverse out of
`SIMULATED` is then the same two steps the SQL engines took — commit the evidence, remove the holding
level — and the matrix test checks the claim against the file.

---

## Azure SQL

`tests/engines/azuresql.engine.test.ts` (the full conformance suite plus six Azure-specific cases) and
the Azure block of `tests/engines/crash.engine.test.ts`.

**Azure SQL does not inherit SQL Server's `ENGINE_VERIFIED`.** They share the `mssql` driver and most of
the T-SQL surface, and sharing an implementation is not evidence. The matrix keeps them apart on purpose.

### The variables

| Variable                     | Value                                                                 | What it unlocks                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `TEST_AZURE_SQL_URL`         | `sqlserver://user:password@server.database.windows.net:1433/database` | The conformance suite, the write path, upsert, relationships, duplicate validation, aggregate reconciliation, and the crash protocol |
| `TEST_AZURE_SQL_BLOCKED_URL` | a server whose firewall rejects this client                           | The firewall case: that a blocked connection is reported as a firewall problem and not as a wrong password                           |
| `TEST_AZURE_SQL_ENTRA`       | `1`, with a URL whose credentials are Entra                           | The Entra authentication case                                                                                                        |

### What the database needs

- A login that can `CREATE SCHEMA` and `DROP SCHEMA`. The suites provision `dvm_conf` and
  `dvm_crash_az`, and drop them afterwards — unlike the Dataverse harness, these clean up completely,
  because here the suite owns the schema rather than writing into a customer's table.
- Nothing else. No seeded data: every fixture is created by the run.

### What it covers

Encrypted connection (asserted: an unencrypted one must be refused, because the service refuses it) ·
SQL authentication · Entra authentication, when configured · firewall behaviour, when a blocked server is
supplied · schema discovery · read · write · upsert · relationships · duplicate validation · aggregate
reconciliation · transient fault recovery · and the crash-consistency protocol.

### Afterwards

The conformance run appends to `evidence/engine-verification.json` under its own `azuresql` key, and the
crash run to `evidence/crash-verification.json`. `scripts/check-evidence-drift.mjs` then fails CI if the
repository claims a capability the evidence does not show, or if one that used to pass stops.

---

## The order to do this in

1. **Azure SQL first.** It needs only a database and a login, it cleans up after itself, and it converts
   four matrix rows from `IMPLEMENTED` to `ENGINE_VERIFIED` in one run.
2. **Dataverse read-only next** — and **not through this harness**, which cannot reach a real environment
   (see the warning above). Through `scripts/certify-dataverse-readonly.mjs`, against a deployed build,
   with a real Microsoft session. Authentication, discovery, metadata, paging, users and teams, with
   nothing written anywhere.

   It needs **two** non-production environments, not one. Planning, preflight, principal mapping and
   schema comparison each refuse a source that is also the target — five separate services say so — so
   "users and teams" cannot be exercised with a single environment. `REAL_TENANT_CERTIFICATION.md` A0 has
   always asked for two; this line used to imply one was enough.

3. **Dataverse writes** once the read half has passed, with the dedicated table.
4. **The privileged cases** last, and only if created-on preservation matters to the pilot.

Each step is independently useful. Stopping after step 2 still replaces "we have never talked to
Dataverse" with "authentication, discovery and reading are verified against a real environment", which is
a materially different sentence to put in front of a customer.
