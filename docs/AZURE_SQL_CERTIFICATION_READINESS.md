# Azure SQL certification — readiness assessment

**Step 1 of Phase 3A. No Azure resource was created, no firewall rule changed, no charge incurred.**

This is where the work stops until the owner decides two things and provides one environment. Both
decisions are below, with what each costs and what each buys.

---

## 1. What is already implemented

Everything. There is no Azure SQL feature work outstanding.

- The connector exists and is the SQL Server connector. `SqlConnector` takes a
  `provider: 'sqlserver' | 'azuresql'`, stores it, and **never branches on it**. Azure SQL is the
  verified SQL Server code path wearing a different label.
- Transient-fault handling already carries Azure's own error numbers — 40613 (database
  unavailable), 10928/10929 (resource governance), 49918/49919/49920 (unavailable for processing),
  40197, 40501 — alongside the SQL Server ones. Written for Azure, never exercised against it.
- TLS is configurable per connection, and the certification harness pins `encrypt: true` with
  `trustServerCertificate: false` rather than relaxing either.
- **The certification harness already exists**: `tests/engines/azuresql.engine.test.ts`. It is
  skipped unless `TEST_AZURE_SQL_URL` is set. Providing an environment is configuration, not new
  test architecture.

## 2. What is verified, and against what

|            | Evidence                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQL Server | Conformance suite, SQL Server 2022 RTM-CU27, `mssql`/tedious driver, 10 of 10 capabilities, recorded 2026-10-02 in `evidence/engine-verification.json` |
| Azure SQL  | **Nothing.** `IMPLEMENTED`, with `connect` held at `REQUIRES_CONFIGURATION`                                                                            |

Sharing an implementation is not evidence. What differs between them is not the query — it is
everything around the connection, and that is the part that breaks in a customer's hands:
Entra sign-in, firewall rules, enforced encryption, serverless auto-pause, service-tier throttling
and transient faults. A local container exercises none of it.

## 3. What remains unverified, specifically

The ten provable capabilities (`connect`, `schemaDiscovery`, `profiling`, `read`, `pagination`,
`write`, `upsert`, `relationshipDiscovery`, `duplicateDetection`, `aggregateReconciliation`), plus
five Azure-specific behaviours the harness already covers and no container can:

1. An unencrypted connection is refused, because the service refuses it.
2. A wrong password reports as a credential problem, not a network one.
3. A firewall rejection reports as a firewall rejection — needs a second, deliberately unlisted
   server (`TEST_AZURE_SQL_BLOCKED_URL`).
4. Entra authentication — see the finding below.
5. A transient fault does not lose the operation.

## 4. Authentication — a finding, not a preference

**Microsoft Entra authentication is not implemented.** The brief prefers it "where supported", and
it is not supported.

`SqlConnector` throws for any mode other than a SQL login:

> `${authType} authentication is not implemented yet; use a SQL login.`

`SQL_AUTH_IMPLEMENTED` contains exactly one entry, `SQL_LOGIN`. `ENTRA_PASSWORD`,
`ENTRA_INTEGRATED`, `MANAGED_IDENTITY` and `WINDOWS` exist so the stored configuration shape will
not have to change when they are added, and the connection form already greys them out as "not
implemented yet".

Consequences:

- Certification must use **SQL authentication** with a contained database user.
- The harness's Entra test (`TEST_AZURE_SQL_ENTRA=1`) is written against that unimplemented path
  and would fail. **Do not set that variable.** It is correctly opt-in, so it cannot produce false
  evidence by accident.
- Implementing Entra for SQL is a separate piece of work and is not part of this certification.

## 5. Can Railway reach the database securely? Not today.

**Static Outbound IPs are disabled on the QA service** — confirmed by
`railway outbound-network static-ip status`. Without a stable outbound address, an Azure SQL
firewall rule cannot be scoped to this deployment, and `docs/AZURE_SQL_SETUP.md` is already right
that an unstable address is not a problem to solve by opening a wide range.

Enabling them, from Railway's own documentation:

- A **Pro plan** feature, toggled per service, requiring a redeploy.
- Assigns **three** IPv4 addresses with outbound traffic balanced across them, so all three must be
  allowlisted.
- Changing region changes the addresses.
- **Security caveat, in Railway's words:** _"There is no guarantee that the IPv4 addresses assigned
  to your service are dedicated. They may be shared with other customers."_

That last point matters for the brief's "no public exposure beyond the minimum necessary". An Azure
SQL firewall rule for a shared Railway address admits any Railway customer sharing it, not only
this deployment. It is narrower than opening the internet and it is **not** equivalent to a private
path. Private Link or VNet integration is the control that would be, and Railway does not offer it.

Also worth stating: "Allow Azure services and resources to access this server" permits **every**
Azure tenant's resources, not only yours. It should not be used.

---

## Decision 1 — where the certification runs

These buy different things and cost different access.

|                   | Run from CI or a controlled machine                                                      | Run through deployed QA                             |
| ----------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Firewall rule for | that one known IP                                                                        | three shared Railway IPs                            |
| Needs Pro plan    | no                                                                                       | yes                                                 |
| Proves            | the connector against a real Azure SQL, through the real driver and TLS                  | the above, plus the deployed product reaching Azure |
| Earns             | `ENGINE_VERIFIED`, the same rung and the same method as PostgreSQL, MySQL and SQL Server | the Step 4 UI journey as well                       |

The three existing `ENGINE_VERIFIED` connectors were all certified from CI against containers, not
from Railway. Taking the first column is consistent with how every other connector on this product
earned its badge. The second column is needed only for Step 4's end-to-end UI journey.

## Decision 2 — read-only, or full parity

**The conformance suite writes.** It creates schema `dvm_conf`, seeds fixtures into it, and drops
it afterwards. A read-only login cannot run it, which conflicts with the brief's "read-only
access", "no schema changes" and "no write permissions".

|                                        | Read-only login                                                                                                           | DDL and write on a throwaway database            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Capabilities provable                  | connect, schemaDiscovery, profiling, read, pagination, relationshipDiscovery, duplicateDetection, aggregateReconciliation | all ten                                          |
| Needs schema seeded                    | yes, by you, out of band                                                                                                  | no, the suite does it                            |
| Outcome                                | Azure SQL certified **as a source**; `write` and `upsert` stay `IMPLEMENTED`                                              | full parity with SQL Server                      |
| Matches the brief's safety constraints | yes                                                                                                                       | only if the database is disposable and synthetic |

If Azure SQL is only ever going to be read from, the read-only column is the honest and safer
choice and I would recommend it. Choosing it means the product will continue to say Azure SQL is
not verified for writing, which would be true.

---

## What I need from you

Nothing is created or changed by me. These are yours to do, and none of them involves sending a
secret through this conversation.

1. **A dedicated, non-production Azure SQL database** containing synthetic data only.
2. **A contained database user**, created in the database rather than on the server. The exact SQL
   is in `docs/AZURE_SQL_SETUP.md` §2. For read-only: `db_datareader` alone. For full parity: also
   `db_ddladmin` and `db_datawriter`, on a database you are content to have a schema created and
   dropped in.
3. **A firewall rule** for whichever address Decision 1 selects. Not "Allow Azure services".
4. **Your answers to Decisions 1 and 2.**
5. **The connection string placed in the environment, never in chat.** Locally, a shell variable
   for one command; in CI, a repository secret:

   ```
   TEST_AZURE_SQL_URL="sqlserver://<user>:<password>@<server>.database.windows.net:1433/<database>"
   ```

   Optionally, a second server that is deliberately _not_ firewalled for the client, which turns on
   the firewall-rejection check:

   ```
   TEST_AZURE_SQL_BLOCKED_URL="sqlserver://<user>:<password>@<other-server>.database.windows.net:1433/<database>"
   ```

   Do not set `TEST_AZURE_SQL_ENTRA` — see §4.

Costs are yours to approve: an Azure SQL database accrues charges, and Static Outbound IPs require
a Railway Pro plan. I have created nothing and will not.

## What happens once that exists

`npm run verify:engines` with the variable set. The suite runs, records the server version, tier
and what passed into `evidence/engine-verification.json`, and the verification matrix raises itself
from that file — a unit test refuses any `ENGINE_VERIFIED` cell the evidence does not back, so the
badge and the proof cannot drift apart. Then the deployed UI journey, if Decision 1 took the second
column.

Until then Azure SQL stays `Not live verified` on every card, which is what it is.
