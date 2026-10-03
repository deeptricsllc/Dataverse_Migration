# What is ready, and what you have to provide

> **The handover list lives in [HARNESS_CHECKLIST.md](HARNESS_CHECKLIST.md).** This page explains what the
> harnesses do and why they stop where they stop; that one is the exact set of things somebody has to
> supply, in the order worth doing them. Neither harness has ever been executed.

**Written for:** whoever will supply a Dataverse environment or an Azure SQL database so the platform
can stop saying `SIMULATED` and `REQUIRES_CONFIGURATION` about them.

The point of this document is that the answer to "how long after we give you credentials?" is
configuration and a test run, not a sprint of test-writing. Both harnesses are written, typechecked
and skipped by default. Neither has ever run, and the verification matrix says so.

## Dataverse

`tests/tenant/dataverse.tenant.test.ts`. Skipped unless `TENANT_TEST_URL` is set, and read-only unless
two further flags are set deliberately.

### What you provide

| Thing                                                                                    | Why                                                                                                 | Risk                                                                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A **non-production** Power Platform environment                                          | Everything below runs against it                                                                    | Reads are harmless; writes touch one table you name                                                                  |
| A signed-in user, via part A of `REAL_TENANT_CERTIFICATION.md`                           | The harness authenticates through the platform's own identity path, not from a file                 | None                                                                                                                 |
| `TENANT_TEST_URL`                                                                        | Names the environment                                                                               | —                                                                                                                    |
| _(for writes)_ a dedicated custom table, e.g. `dvm_testrecord`, with a text primary name | Writes go nowhere else                                                                              | The suite refuses to write to `account`, `contact`, `opportunity`, `lead` or `systemuser` even if the flag names one |
| _(for writes)_ `TENANT_TEST_WRITE=1` and `TENANT_TEST_WRITE_TABLE=<table>`               | Two separate deliberate acts                                                                        | —                                                                                                                    |
| _(optional)_ `TENANT_TEST_PRIVILEGED=1`                                                  | Permits the created-on / created-by preservation check, which needs _Act on Behalf of Another User_ | Creates one more record in the same table                                                                            |

### What it checks, read-only

Authentication and who-am-I · environment identification · table discovery · columns, types, choices
with their options, lookups with their targets · alternate keys · record reads across more than one
page with no record served twice · record counts · users, teams and business units · automation
detection · duplicate detection, **honestly** (see below).

### What it checks, writing only to the table you named

Create and read back · update one column and nothing else · Unicode, emoji, long text and a decimal
round-tripped · match by alternate key where the table has one · and that every record it created is
findable by its tag.

### Two things stated up front rather than discovered

**Cleanup is manual, and that is deliberate.** The platform has no delete: _"never issue DELETE as part
of synchronisation"_ is a standing rule and `MigrationConnector` has no `deleteRecord`, so nothing in
the product can destroy a customer's record. The harness therefore cannot remove what it creates.
Adding a delete path so a test could tidy up would trade a real safety property for a convenience, so
instead every record carries `DVM-HARNESS` in its primary name, and the run writes
`evidence/tenant-cleanup.json` listing each one by table and id. Removal is one filtered delete in the
environment. A harness that silently leaves litter would be unacceptable; one that leaves an exact list
is honest.

**Duplicate detection is the open question, not an assumption.** `$apply=groupby((col),aggregate($count
as n))` is valid OData and Dataverse implements a subset of it — with an aggregate record limit it stops
at rather than pages past. For a duplicate scan that is the worst possible failure mode: "no
duplicates" from a query that stopped early is worse than no answer at all. So the connector does not
implement `findDuplicateKeys` for Dataverse, the matrix says `NOT_SUPPORTED`, and a validation report
says NOT VERIFIED for that check rather than passing it. The harness asks whether the capability is
claimed and only tests it if it is; it does not assume OData syntax implies Dataverse behaviour.

Throttling is also **not** provoked. Reading hard enough to be throttled in somebody's environment is
rude, so the retry policy is unit-tested and its behaviour against a live service is recorded as
unverified.

### After it runs

The suite writes `evidence/tenant-verification.json`: the environment, the version it reported, the
mode, and each capability as PASSED or NOT_ATTEMPTED with a reason. Raising Dataverse in
`shared/connector-verification.ts` from `SIMULATED` is then the same two-step the SQL engines went
through — commit the evidence, remove the holding level — and the matrix test checks the claim against
the file rather than against anybody's memory.

## Azure SQL

`tests/engines/azuresql.engine.test.ts`. Skipped unless `TEST_AZURE_SQL_URL` is set.

### What you provide

| Thing                                                                                        | Why                                                                        |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| An Azure SQL database you are willing to let a test create and drop the `dvm_conf` schema in | The conformance fixture                                                    |
| `TEST_AZURE_SQL_URL="sqlserver://user:pw@server.database.windows.net:1433/db"`               | Names it                                                                   |
| _(optional)_ `TEST_AZURE_SQL_ENTRA=1`                                                        | Runs the Entra authentication check                                        |
| _(optional)_ `TEST_AZURE_SQL_BLOCKED_URL`                                                    | A server whose firewall should reject this client, for the rejection check |

### What it checks

**The shared half:** the full conformance suite, with the same fixture the SQL Server suite uses, so a
difference in behaviour is Azure's and not the fixture's. Connect, schema discovery, profiling, read,
pagination, write, upsert, relationship discovery, duplicate detection, aggregate reconciliation,
semantic equality on returned decimals and big integers.

**The Azure-specific half**, which has no SQL Server equivalent and is the reason sharing an
implementation is not evidence:

- An unencrypted connection is refused, because the service refuses it. The suite does not relax
  `encrypt` or trust any certificate — a test that trusted any certificate would prove nothing about a
  service requiring a real one.
- A wrong password is reported as a credential problem, not a network one, because the two send a
  person somewhere different.
- A firewall rejection is reported as a firewall rejection.
- Entra authentication, which is what most enterprises will actually use and a different code path from
  a username and password.
- Repeated reads across a span long enough for an idle connection to be dropped still agree.

### What remains after you provide an environment

Run `npm run test:engines`. On a green run, `AZURE_SQL.connect` can move off
`REQUIRES_CONFIGURATION`, and the rest of the row can be raised from the recorded evidence — bearing in
mind that `SQL_AUTH_IMPLEMENTED` currently contains only `SQL_LOGIN`, so Entra support is a product
change rather than a configuration one, and the harness will skip that check until it exists.

## What neither harness will do

- Read a credential from a file. Both authenticate the way a customer does.
- Run against anything the environment did not explicitly name.
- Write to a standard business table, even if a flag names one.
- Claim a capability the run did not demonstrate. `NOT_ATTEMPTED` with a reason is a result; a silent
  pass is not.
