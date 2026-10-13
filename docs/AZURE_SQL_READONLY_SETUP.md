# Azure SQL read-only certification — setup

**Written for:** the owner, doing this once, by hand, before authorizing a certification run.

Everything here is yours to run. Nothing in this repository creates an Azure resource, changes a
firewall rule, or incurs a charge. **Do not paste a connection string, password or key into chat.**

Estimated time: about twenty minutes. Estimated cost: see §7.

---

## 1. Create a non-production database

Azure portal, or the CLI. A **Basic** or **Serverless General Purpose** tier is ample: the fixture
is 150 rows.

```bash
az sql server create -g <resource-group> -n <server-name> -l <region> \
  --admin-user <admin-login> --admin-password '<admin-password>'

az sql db create -g <resource-group> -s <server-name> -n dvm-cert \
  --service-objective Basic --backup-storage-redundancy Local
```

Call it something that cannot be mistaken for production. `dvm-cert` is used throughout this page.

**It must contain synthetic data only.** The fixture below is generated; do not point this at a
copy of anything real.

## 2. Load the fixture

Connect to **the `dvm-cert` database** (not `master`) as the admin, and run this whole script. It
is deterministic: the same script always produces the same 150 rows, which is what lets the suite
assert exact numbers.

```sql
CREATE SCHEMA dvm_ro;
GO

CREATE TABLE dvm_ro.people (
  people_id    INT           NOT NULL PRIMARY KEY,
  person_code  NVARCHAR(32)  NOT NULL,
  full_name    NVARCHAR(100) NOT NULL,
  email        NVARCHAR(200) NULL,
  credit_limit NVARCHAR(32)  NULL,
  opened_on    DATE          NULL,
  is_active    BIT           NOT NULL
);

CREATE TABLE dvm_ro.visits (
  visit_id   INT           NOT NULL PRIMARY KEY,
  visit_ref  NVARCHAR(32)  NOT NULL,
  people_id  INT           NULL REFERENCES dvm_ro.people(people_id),
  visited_on DATE          NULL,
  amount     DECIMAL(12,4) NULL
);
GO

-- 60 people. Rows 49-60 reuse the first twelve person_codes, so there are 48 distinct
-- codes, 12 of them held twice, and 24 rows in a collision.
WITH n AS (
  SELECT TOP (60) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS i FROM sys.all_objects
)
INSERT dvm_ro.people (people_id, person_code, full_name, email, credit_limit, opened_on, is_active)
SELECT
  i + 1,
  CONCAT('P-', 1000 + CASE WHEN i < 48 THEN i ELSE i - 48 END),
  CASE WHEN i % 7 = 0 THEN '  Northwind Trading  ' ELSE CONCAT('Person ', i) END,
  CASE WHEN i % 3 = 0 THEN NULL
       WHEN i % 11 = 0 THEN 'not-an-email'
       ELSE CONCAT('user', i, '@example.test') END,
  CASE WHEN i % 5 = 0 THEN CONCAT('$1,', 200 + i, '.50')
       ELSE CAST(1000 + i * 7 AS NVARCHAR(32)) END,
  DATEADD(DAY, i, '2024-01-01'),
  CASE WHEN i % 2 = 0 THEN 1 ELSE 0 END
FROM n;

-- 90 visits. Every ninth has no person, so ten references resolve to nothing.
WITH n AS (
  SELECT TOP (90) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS i FROM sys.all_objects
)
INSERT dvm_ro.visits (visit_id, visit_ref, people_id, visited_on, amount)
SELECT
  i + 1,
  CONCAT('V-', 5000 + i),
  CASE WHEN i % 9 = 0 THEN NULL ELSE (i % 48) + 1 END,
  DATEADD(DAY, i % 200, '2024-02-01'),
  CAST((i % 9) * 125.25 AS DECIMAL(12,4))
FROM n;
GO
```

Optional, and it turns on one more check — a table the certification login is forbidden to read:

```sql
CREATE SCHEMA dvm_ro_denied;
GO
CREATE TABLE dvm_ro_denied.secrets (id INT NOT NULL PRIMARY KEY, note NVARCHAR(50) NULL);
INSERT dvm_ro_denied.secrets VALUES (1, 'nothing real');
GO
```

### Check it loaded

```sql
SELECT COUNT(*) AS people FROM dvm_ro.people;                        -- 60
SELECT COUNT(DISTINCT person_code) AS codes FROM dvm_ro.people;      -- 48
SELECT COUNT(*) AS no_email FROM dvm_ro.people WHERE email IS NULL;  -- 20
SELECT COUNT(*) AS visits FROM dvm_ro.visits;                        -- 90
SELECT COUNT(*) AS orphan FROM dvm_ro.visits WHERE people_id IS NULL;-- 10
SELECT SUM(amount) AS total FROM dvm_ro.visits;                      -- 45090.0000
```

Those six numbers are what the certification compares its own results against. If any of them
differs, stop: the suite will fail and it will be right to.

## 3. Create the least-privilege user

In **the `dvm-cert` database**, not on the server:

```sql
CREATE USER [dvm_cert_read] WITH PASSWORD = '<a long random password>';
ALTER ROLE db_datareader ADD MEMBER [dvm_cert_read];

-- Nothing else. No db_datawriter, no db_ddladmin, no db_owner.
DENY INSERT, UPDATE, DELETE, ALTER, CREATE TABLE TO [dvm_cert_read];
```

If you created the optional denied schema:

```sql
DENY SELECT ON SCHEMA::dvm_ro_denied TO [dvm_cert_read];
```

The suite reads this user's role membership and **fails if it finds write or DDL rights**. It
checks rather than trusting, and it proves the point by reading `sys.database_role_members` instead
of attempting a write it is not supposed to make.

## 4. TLS

Nothing to configure. Azure SQL requires encryption, and the suite connects with `encrypt: true`
and `trustServerCertificate: false` — it does not relax either, and one of its checks is that an
unencrypted connection is refused.

Leave the server's **Minimum TLS Version** at 1.2 or higher.

## 5. Restrict the firewall

Find the runner's outbound address first (§6), then add **one** rule for it:

```bash
az sql server firewall-rule create -g <resource-group> -s <server-name> \
  -n dvm-cert-runner --start-ip-address <IP> --end-ip-address <IP>
```

- Do **not** enable _"Allow Azure services and resources to access this server"_. It permits every
  Azure tenant's resources, not only yours.
- Do **not** open a range.
- If you also created a second server for the firewall-rejection check, add **no** rule to it. That
  is the point of it.

## 6. The runner, and its address

Decision 2 of the readiness assessment chose a controlled runner over an Azure-hosted one. The
address to allowlist is whichever machine runs the suite.

```bash
curl -s https://api.ipify.org
```

Allowlist exactly that. Note it changes if the machine moves network, and the rule should be
removed afterwards (§9).

**Not GitHub-hosted CI.** GitHub's hosted runners use a large, rotating pool of Azure addresses
published as a weekly-changing list. Allowlisting it means allowlisting a range that other
people's jobs also run inside, which is the opposite of least privilege.

## 7. Cost

|                                               |                                                                 |
| --------------------------------------------- | --------------------------------------------------------------- |
| Azure SQL Basic, 2 GB                         | roughly US$5 per month, billed hourly, so a day or two is cents |
| Serverless General Purpose                    | auto-pauses when idle; cheaper if left alone between runs       |
| Optional second server for the firewall check | a second Basic database, same order of cost                     |
| Outbound data                                 | the fixture is 150 rows; negligible                             |
| Railway                                       | **unchanged. No Pro upgrade, no static IPs.**                   |

Delete the resource group when finished (§9) and the cost stops.

## 8. Run the certification

The connection string goes in the environment for one command. Not in a file, not in chat, not in
the repository.

```bash
# PowerShell
$env:TEST_AZURE_SQL_RO_URL = "sqlserver://dvm_cert_read:<password>@<server>.database.windows.net:1433/dvm-cert"
$env:TEST_AZURE_SQL_RO_DENIED_TABLE = "dvm_ro_denied.secrets"   # optional
npm run test:engines
```

```bash
# bash
TEST_AZURE_SQL_RO_URL="sqlserver://dvm_cert_read:<password>@<server>.database.windows.net:1433/dvm-cert" \
TEST_AZURE_SQL_RO_DENIED_TABLE="dvm_ro_denied.secrets" \
npm run test:engines
```

**Do not set `TEST_AZURE_SQL_ENTRA` or `TEST_AZURE_SQL_URL`.** The first targets an authentication
mode this product has not implemented; the second starts the write suite, which creates and drops a
schema and will fail against a read-only login.

The run records what passed into `evidence/engine-verification.json`, including the server version
it saw. The verification matrix is raised from that file by a test that refuses any claim the
evidence does not carry, so the badge and the proof cannot drift apart.

## 9. Remove the access afterwards

```bash
az sql server firewall-rule delete -g <resource-group> -s <server-name> -n dvm-cert-runner
az group delete -n <resource-group> --yes            # if the group holds nothing else
```

And drop the login if you keep the database:

```sql
DROP USER [dvm_cert_read];
```

Rotate the password if it was ever typed anywhere it could be recovered from — a shell history
file counts.
