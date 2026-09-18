# SQL Server setup

**Written for:** whoever will connect this platform to a SQL Server database, and the DBA who has to
approve it. It explains the minimum permissions, the network reality, and how to verify the
connection before any migration is planned.

> **Not yet certified against a real SQL Server.** The connector is written against the SQL Server
> system catalog and is covered by tests using a simulated database. It has not been run against a
> real instance. Follow [Certifying a real database](#8-certifying-a-real-database) before trusting
> it with production data.

---

## 1. What the platform does with a SQL connection

| As a…      | It runs                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| **Source** | `SELECT` against the tables you choose, plus catalog reads to discover columns and keys      |
| **Target** | `INSERT` and `UPDATE`, always keyed on the primary key, only for the tables in a plan        |
| **Never**  | `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, schema changes, or anything outside the selected plan |

Every statement is parameterized: values from your data are bound as parameters and never
concatenated into SQL text. Table and column names come from the catalog the platform itself read,
and are quoted before use.

## 2. Create a login with least privilege

Do **not** use `sa`, and do not grant `sysadmin` or `db_owner`. Create a dedicated login and give it
only what the role requires.

### Source database (read only)

```sql
-- On the server
CREATE LOGIN [iic_migration_read] WITH PASSWORD = '<a long random password>';

-- In the database you will read
USE [YourDatabase];
CREATE USER [iic_migration_read] FOR LOGIN [iic_migration_read];

-- Read the data
ALTER ROLE [db_datareader] ADD MEMBER [iic_migration_read];

-- Read the catalog: column types, primary keys, unique constraints, foreign keys.
-- db_datareader alone does NOT include this.
GRANT VIEW DEFINITION TO [iic_migration_read];
```

If you prefer to grant per table rather than `db_datareader`:

```sql
GRANT SELECT ON [dbo].[Customer] TO [iic_migration_read];
GRANT VIEW DEFINITION ON [dbo].[Customer] TO [iic_migration_read];
-- …one pair per table you intend to migrate
```

A login without `VIEW DEFINITION` connects and reads rows but discovers no keys or relationships, so
the platform cannot match records or order tables. The Diagnostics page reports this as a failed
read permission check rather than failing silently.

### Target database (read and write)

```sql
USE [YourTargetDatabase];
CREATE USER [iic_migration_write] FOR LOGIN [iic_migration_write];

ALTER ROLE [db_datareader] ADD MEMBER [iic_migration_write];  -- to compare before writing
ALTER ROLE [db_datawriter] ADD MEMBER [iic_migration_write];  -- to insert and update
GRANT VIEW DEFINITION TO [iic_migration_write];
```

`db_datawriter` also grants `DELETE`. The platform never issues one, but if your policy requires
removing the possibility, grant per table instead:

```sql
GRANT SELECT, INSERT, UPDATE ON [dbo].[Customer] TO [iic_migration_write];
GRANT VIEW DEFINITION ON [dbo].[Customer] TO [iic_migration_write];
```

### What is never needed

`sysadmin`, `db_owner`, `ALTER ANY …`, `CONTROL`, `IMPERSONATE`, `xp_cmdshell`, linked servers, or
any server-level role. If someone asks you to grant one of these for this platform, the answer is
no.

## 3. Identity columns, computed columns and rowversion

The platform reads the catalog and treats these correctly without any configuration:

| Column kind                | Behavior                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `IDENTITY`                 | Never written. The database assigns the key, and the platform records it in the map. |
| Computed / persisted       | Never written; read for comparison only.                                             |
| `rowversion` / `timestamp` | Never written and never compared: it is meaningless in another database.             |
| Column with a default      | Written when it is mapped; left to the default when it is not.                       |

Because an identity key is assigned by the target, records cannot be matched on the record id when
SQL is the target. Match on a **unique constraint** or a **business key** instead — the platform
picks a usable unique key automatically when both sides have one, and blocks the plan if the only
candidate is a server-generated key.

## 4. Network requirements

The platform connects over TCP to the SQL Server port (1433 by default) **from wherever the
application runs**.

| Deployment                                     | Reachability                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Local development, database on the same LAN    | Works                                                                     |
| Application in the cloud, Azure SQL            | Works with a firewall rule (see [AZURE_SQL_SETUP.md](AZURE_SQL_SETUP.md)) |
| Application in the cloud, database on-premises | **Does not work** without a network path                                  |

For the on-premises case, do **not** publish SQL Server to the internet. The intended answer is the
customer-hosted migration agent described in
[ON_PREM_AGENT_ARCHITECTURE.md](ON_PREM_AGENT_ARCHITECTURE.md), which is designed but **not
implemented yet**. Until it exists, run the platform inside the network that can reach the database,
or use a VPN / private link that your network team already operates.

Checklist for a reachable server:

- TCP/IP protocol enabled in SQL Server Configuration Manager.
- The instance listening on a known port (a named instance using dynamic ports needs the port fixed
  or the SQL Browser reachable; this platform connects by port, not by instance name).
- Firewall allows inbound TCP on that port **from the application's address only**.
- The login is enabled and not locked out, and SQL authentication is enabled on the server
  (Mixed Mode), because that is the only mode implemented today.

## 5. Encryption

Set **Encrypt connection** (on by default). The connection then negotiates TLS.

**Trust server certificate** disables certificate validation. Leave it off. Turn it on only for an
on-premises server presenting a self-signed certificate, and understand what it costs: an attacker
able to intercept the connection can present their own certificate. The correct fix is to install a
certificate the application trusts.

Azure SQL always encrypts and needs a valid certificate; never enable "trust server certificate"
for it.

## 6. Creating the connection

**Connections → + Add connection → SQL Server**, then:

| Field               | Value                                                  |
| ------------------- | ------------------------------------------------------ |
| Connection name     | Anything meaningful, e.g. `IIC Legacy (read-only)`     |
| Server / host       | Host name or IP. Do not include the port here.         |
| Port                | `1433` unless your instance differs                    |
| Database            | The database to read or write                          |
| Authentication      | SQL authentication (the only implemented mode)         |
| Username / Password | The login created above                                |
| Encrypt             | On                                                     |
| Trust certificate   | Off (see above)                                        |
| Schemas             | Optional. Empty means every schema the login can read. |

The password is encrypted with AES-256-GCM before it is stored, is never returned by the API, never
appears in a log or an export, and is never copied into a migration run's snapshot.

Click **Test connection** before saving. It reads the server version and the catalog. It never writes
anything, so write permission is reported as "not tested" — that is deliberate: a connection test
must not change your data.

## 7. Authentication modes that are not implemented yet

The configuration shape already carries them so that adding one does not change stored connections:

| Mode                                | Status                                                    |
| ----------------------------------- | --------------------------------------------------------- |
| SQL authentication                  | **Implemented**                                           |
| Microsoft Entra password            | Designed, not implemented                                 |
| Microsoft Entra integrated          | Designed, not implemented                                 |
| Managed identity                    | Designed, not implemented (the natural fit for Azure SQL) |
| Windows / integrated authentication | Designed, not implemented (needs the agent for a domain)  |

Selecting one of these is refused with a clear message rather than failing at connection time.

## 8. Certifying a real database

Run this once per real server, on a database you are willing to lose:

1. Create the read-only login from section 2 and a connection for it.
2. **Test connection** — server reachable, authentication, database, read permission all pass; write
   permission says not tested.
3. **Connections → select it as source**, pick a Dataverse or SQL target, then **Analyze**.
4. Check discovery against what you know: table list, row counts, primary keys, unique constraints,
   foreign keys. Export the schema CSV and have the DBA read it.
5. Build a small plan (2–3 tables), map the tables and columns, and run a **preflight**. It reads
   only. Confirm the CREATE/UPDATE/UNCHANGED/CONFLICT/BLOCKED totals make sense for the data.
6. Only then, against a **scratch** target, execute and validate.
7. Re-run the same migration: it must report everything unchanged and write nothing.

Record what you saw. Until step 7 passes against a real server, this connector is "tested against a
simulated database", not certified.

## 9. Troubleshooting

| Symptom                                          | Cause / fix                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `ESOCKET` / `ETIMEOUT` / cannot reach            | Wrong host or port, TCP/IP disabled, firewall, or no network path from the deployment (see §4).    |
| `Login failed for user` (18456)                  | Wrong password, disabled login, or the server is not in Mixed Mode.                                |
| Connected, but no tables are visible             | The login lacks `VIEW DEFINITION` (and/or `SELECT`). See §2.                                       |
| Tables appear, but no keys or relationships      | `VIEW DEFINITION` missing on those objects specifically.                                           |
| Certificate error                                | Install a trusted certificate, or (on-premises only, knowingly) enable trust server certificate.   |
| Plan blocked: only a server-generated key exists | Match the table on a unique constraint or a business key instead of the record id.                 |
| Deadlock (1205) or a transient Azure error       | Retried automatically with backoff. Persistent deadlocks usually mean another process holds locks. |
