# Connector readiness plan

**Written for:** the owner, deciding what to authorize next and what it will cost them personally in
access and consent.

Nothing here is implementation. It is the order the connectors should be taken in, what each one
actually needs, and which of those needs only the owner can supply.

---

## Where each connector stands today

Read from `shared/connector-verification.ts`, which a unit test holds to the recorded evidence.

| Connector              | Level today                                      | Evidence behind it                                                                                                                         |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| File (CSV, Excel, XML) | `ENGINE_VERIFIED`                                | Real files through the real import path on every journey run. There is no external engine to verify against.                               |
| PostgreSQL             | `ENGINE_VERIFIED`                                | Conformance suite, PostgreSQL 16.15, `pg` driver, 10/10 capabilities, 2026-10-02                                                           |
| MySQL                  | `ENGINE_VERIFIED`                                | Conformance suite, MySQL 8.4.11, `mysql2` driver, 10/10, 2026-10-02                                                                        |
| SQL Server             | `ENGINE_VERIFIED`                                | Conformance suite, SQL Server 2022 RTM-CU27, `mssql`/tedious, 10/10, 2026-10-02                                                            |
| Azure SQL              | `IMPLEMENTED`, `connect: REQUIRES_CONFIGURATION` | Shares SQL Server's implementation. Never run against a real Azure SQL database.                                                           |
| OneDrive               | `IMPLEMENTED`, `connect: REQUIRES_CONFIGURATION` | Microsoft Graph, simulator only.                                                                                                           |
| SharePoint             | `IMPLEMENTED`, `connect: REQUIRES_CONFIGURATION` | Microsoft Graph, simulator only.                                                                                                           |
| Dataverse              | `SIMULATED`                                      | Simulator only. Authentication against the real Entra directory is proven; no Dataverse operation has ever run against a real environment. |

Two capabilities are deliberately `NOT_SUPPORTED` on Dataverse and will stay that way until
someone can defend them: duplicate detection, because no grouping query is worth standing behind
without a tenant to try it on; and aggregate reconciliation, because FetchXML totals stop silently
at an aggregate row limit, which is the opposite of what a reconciliation is for.

---

## The honest ordering

The brief suggests Azure SQL, Dataverse, SharePoint/OneDrive, SQL Server on-premises. That order is
right, and the reason is worth stating: it runs from the connector that needs least from you to the
one that needs most, so each step either produces evidence or stops at a boundary you can see
coming.

### 1. Azure SQL — the cheapest real evidence available

Closest to the line. The query path is the SQL Server path, already verified against a real server;
what is unproven is everything around the connection, which is also everything that breaks one:
Entra sign-in, firewall rules, enforced encryption, transient faults, serverless auto-pause and
tier throttling. A local container cannot exercise any of it.

**What it needs from you:** an Azure SQL database that is not production, a contained database user
with `db_datareader` (the exact SQL is in `docs/AZURE_SQL_SETUP.md`), and a firewall rule admitting
the deployment's egress addresses.

**What I would do with it:** point the existing conformance suite at it, record the server version
and what passed into `evidence/engine-verification.json`, and let the matrix raise itself. No new
test harness; the suite exists.

**Realistic outcome:** `ENGINE_VERIFIED` for the ten provable capabilities, or a precise list of
what Azure SQL does differently. Either is worth having.

### 2. Dataverse — blocked on one thing, and it is not engineering

`docs/DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md` already records a full attempt. Its verdict
is that authentication is verified against a real tenant and Dataverse is not: not one Dataverse
operation has run against a real environment. The certification driver exists and is one command
(`scripts/certify-dataverse-readonly.mjs`); it drives the deployed application's own HTTP API
through ten phases and substitutes nothing.

**The boundary, stated precisely:** Dataverse access is delegated. The only credential that can
reach the tenant is the refresh token from a person's own interactive sign-in, held encrypted in
the deployment's database. There is no service principal, no API token and no headless sign-in, by
design, because the product never acts with more rights than the person using it. **An automated
session cannot cross this.**

**What it needs from you, and only you:**

1. A person signs in to deployed QA with a work account in the target tenant. That person is you or
   someone you nominate.
2. Dataverse security roles for that account in **two** non-production environments. With one,
   phases 5 to 9 cannot run. With none, discovery returns empty and nothing past phase 2 runs.
3. A decision on `DEMO_MODE=true` on QA, which currently leaves anonymous demo sign-in reachable
   and contradicts this repository's own certification prerequisites.

Whether the tenant has any Power Platform environment at all is **not yet known**. The prepared run
answers that in its first thirty seconds, which makes it a cheap first move once a session exists.

**Realistic outcome:** read-only certification of discovery, metadata, relationships, dependencies
and identity mapping. Writes stay refused. Duplicate detection and aggregate reconciliation stay
`NOT_SUPPORTED`.

### 3. SharePoint and OneDrive — same gate as Dataverse, smaller surface

Both are Microsoft Graph, both `IMPLEMENTED`, both need a Microsoft sign-in, which a demo workspace
cannot do. They share Dataverse's delegated-credential boundary, so they become reachable in the
same session that unblocks Dataverse, and the work is smaller: list a site, read a document
library, read a list, page through it.

**What it needs from you:** the Entra app registration described in `docs/MICROSOFT_SETUP.md` with
delegated Graph permissions granted, plus a SharePoint site and a OneDrive with a spreadsheet in
each that you are content for a test to read.

### 4. SQL Server on-premises — not a connector problem

The SQL Server connector is already `ENGINE_VERIFIED`. What is missing is reachability: the
platform is hosted and a customer's SQL Server usually sits behind their firewall. The design for
an outbound agent is written up in `docs/ON_PREM_AGENT_ARCHITECTURE.md`, which opens by stating
that **nothing in it exists** — no agent, no protocol, no transport, no enrollment.

This is a build, not a certification, and it is much larger than the three above. It should not be
started in the same breath as them, and I would not start it without a separate decision from you
about whether on-premises reachability is a thing this product commits to.

---

## What I will not do

- Mark any connector verified without a live run. The matrix is held to the evidence file by a
  test, so the claim and the proof cannot drift apart.
- Ask you to paste a secret into chat, or commit one.
- Deploy to production, or enable writes against a real tenant.

## What I need from you to start

Only one thing, and which one depends on where you want to begin:

- **To start with Azure SQL:** a non-production Azure SQL database, a read-only contained user, and
  a firewall rule. I can then run the existing suite against it unattended.
- **To start with Dataverse, SharePoint or OneDrive:** an interactive sign-in by a real person with
  the roles above. I cannot perform this step, and no amount of engineering removes it.

If neither is available yet, the honest position is the one the product already states on every
connector card: those four are built and have never been run against the real thing.
