# Azure SQL Database setup

**Written for:** whoever will connect this platform to an Azure SQL Database. It assumes you have
read [SQL_SERVER_SETUP.md](SQL_SERVER_SETUP.md); everything there applies, and this page covers only
what is different about Azure SQL.

> **Not yet certified against a real Azure SQL Database.** The connector is shared with SQL Server
> and is covered by tests using a simulated database. It has not been run against a real Azure SQL
> instance.

---

## 1. Why it is a separate connection type

Azure SQL speaks the same protocol as SQL Server and uses the same connector. It is a distinct
connection type in this product because the things around the connection differ — firewall rules,
always-on encryption, serverless auto-pause, service tiers and their throttling, and the identity
options that are worth adding next. Keeping the type separate means those differences can be
reported honestly in the UI and in every export, instead of being hidden behind "SQL Server".

## 2. Create a contained user

Azure SQL has no server-level logins in the way SQL Server does. Create a **contained database user**
with a password, in the database itself:

```sql
-- Connect to the DATABASE (not to master), then:
CREATE USER [iic_migration_read] WITH PASSWORD = '<a long random password>';

ALTER ROLE db_datareader ADD MEMBER [iic_migration_read];
GRANT VIEW DEFINITION TO [iic_migration_read];
```

For a target database:

```sql
CREATE USER [iic_migration_write] WITH PASSWORD = '<a long random password>';
ALTER ROLE db_datareader ADD MEMBER [iic_migration_write];
ALTER ROLE db_datawriter ADD MEMBER [iic_migration_write];
GRANT VIEW DEFINITION TO [iic_migration_write];
```

Never use the server administrator account for a migration, and do not grant `db_owner`.

## 3. Firewall

Azure SQL refuses every connection until an address is allowed.

1. Azure portal → your SQL **server** → **Networking** → **Public access**.
2. Add a firewall rule for the address the application connects from.
   - Local development: your own public IP (the portal offers to add it).
   - A hosted deployment: the platform's outbound address. If your host does not offer a stable
     outbound IP, you need a private path (VNet integration / Private Link) rather than a firewall
     rule — an unstable IP is not something to solve by opening a wide range.
3. "Allow Azure services and resources to access this server" permits **every** Azure tenant's
   resources, not only yours. Prefer an explicit rule.

If the platform cannot reach the database, the connection test reports it as unreachable and names
the firewall as the likely cause. It cannot tell you which address to allow — check your host's
documentation for its outbound address.

## 4. Connection settings

| Field             | Value                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| Connection type   | **Azure SQL**                                                              |
| Server / host     | `yourserver.database.windows.net`                                          |
| Port              | `1433` (Azure SQL does not use other ports)                                |
| Database          | The database name (not `master`)                                           |
| Authentication    | SQL authentication (the contained user above)                              |
| Encrypt           | **On** — Azure SQL always requires TLS                                     |
| Trust certificate | **Off** — Azure SQL presents a valid certificate; never disable validation |

## 5. Service tiers, throttling and serverless

- **Transient errors.** Azure SQL routinely returns transient failures during maintenance and
  failover (40197, 40501, 40613, 49918–49920, 10928–10929). The client retries these with bounded
  exponential backoff; a migration pauses rather than fails.
- **Serverless auto-pause.** A paused database takes several seconds to resume, and the first
  connection may time out. Retry once the database has resumed; consider disabling auto-pause for
  the duration of a large migration.
- **DTU / vCore limits.** A migration writes row by row. On a small tier this is slower than the
  network, not faster; raising the tier for the migration window and lowering it afterwards is
  usually cheaper than a long run.
- **Batch size.** The plan's batch size and write concurrency are adjustable. If you see sustained
  throttling, reduce them before anything else.

## 6. Identity options worth adding

Only SQL authentication is implemented. For Azure SQL the natural next step is **managed identity**:
the platform would authenticate as its own Azure identity with no password stored anywhere. The
configuration shape already carries the mode, so adding it does not change existing connections.
Until then, treat the contained user's password as a secret with a rotation date.

## 7. Verifying

Follow section 8 of [SQL_SERVER_SETUP.md](SQL_SERVER_SETUP.md). Two additions for Azure SQL:

- Run the connection test from the deployment that will run the migration, not only from your
  laptop; a firewall rule that allows one does not allow the other.
- Check the database's tier before a large run, and watch for throttling in the run's errors — a
  rising number of retried transient errors means the tier is the bottleneck.

## 8. Troubleshooting

| Symptom                                         | Cause / fix                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Cannot reach the server                         | Firewall rule missing for the calling address, or the server name is wrong.                   |
| `Login failed` for a user that exists           | The contained user was created in `master` instead of the database, or the password is stale. |
| `Cannot open database … requested by the login` | The user exists on the server but not in that database.                                       |
| Frequent transient errors                       | Expected on small tiers; retried automatically. Reduce write concurrency or raise the tier.   |
| First connection after idle times out           | Serverless auto-pause; the database is resuming.                                              |
