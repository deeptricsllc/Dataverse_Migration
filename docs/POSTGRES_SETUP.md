# PostgreSQL setup

Written for: whoever administers the database being connected to.

The platform reads PostgreSQL through an ordinary client connection. Nothing is installed on the
server, no extension is required, and a connection test never writes.

## 1. A role for the migration

Create a role for the platform rather than reusing an application login, so what it did is
distinguishable in the audit log and its rights can be revoked on their own.

```sql
CREATE ROLE migration_reader LOGIN PASSWORD 'a-long-random-password';
GRANT CONNECT ON DATABASE your_database TO migration_reader;
GRANT USAGE ON SCHEMA sales TO migration_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO migration_reader;
-- So tables created later are readable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA sales GRANT SELECT ON TABLES TO migration_reader;
```

That is everything an **analysis project** needs. It cannot write.

To use the database as a **migration target**, add what writing requires — and only for the tables
being migrated into:

```sql
GRANT INSERT, UPDATE ON sales.customer, sales.region TO migration_reader;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA sales TO migration_reader;
```

No `DELETE` is granted, because the platform never issues one.

## 2. Let it connect

- `listen_addresses` must include the interface the platform reaches the server on (`postgresql.conf`).
- `pg_hba.conf` needs a line permitting password authentication for the role, from the platform's
  address. `scram-sha-256` is preferred over `md5`.
- Reload afterwards: `SELECT pg_reload_conf();`

Managed services (RDS, Cloud SQL, Neon, Supabase, Azure Database for PostgreSQL) handle both; there
you only allow the platform's egress address in the instance's firewall.

## 3. TLS

Leave **Encrypt** on. Turn **Trust server certificate** on only for a server presenting a
self-signed certificate — it keeps the connection encrypted but stops verifying who is on the other
end, so it is a deliberate choice for a server you already control, not a default.

## 4. What the connection test checks

Four checks, none of which writes:

| Check               | How                                                                    |
| ------------------- | ---------------------------------------------------------------------- |
| Server reachable    | Opens a connection                                                     |
| Authentication      | The same connection succeeding                                         |
| Database accessible | `SELECT version(), current_database()`                                 |
| Read permission     | Reads the table catalogue and reports how many tables the role can see |

Write permission is deliberately **never probed**. Finding out by writing is not a test.

If the read check says "no tables are visible", the role is connected but has no `USAGE` on the
schema or no `SELECT` on its tables — or the connection is restricted to schemas that do not exist.

## 5. Schemas

Leave the schema list empty to read everything the role can see. Naming schemas restricts discovery,
which is worth doing on a database with hundreds of tables the migration does not care about.

Tables are named `schema.table` throughout the platform. A name with no schema means `public`.

## 6. What the platform reads from the catalog

`pg_catalog`, read-only: tables, views and materialized views; columns with their types, nullability,
defaults, collation and generated/identity status; primary keys; unique constraints and unique
indexes; and foreign keys, which become lookups.

Two details worth knowing, because they change what the platform will let you do:

- **`bigserial` and `GENERATED ... AS IDENTITY` are both treated as server-generated**, so the
  migration never supplies its own value for them and never collides with the sequence.
- **A partial unique index** (`CREATE UNIQUE INDEX ... WHERE ...`) is reported but marked unusable as
  an alternate key: it only enforces uniqueness over part of the table, so it cannot identify a
  record.

## 7. Row counts

An exact `count(*)` is used where it succeeds. If it cannot run, the planner's estimate from
`pg_class.reltuples` is reported instead and labelled an estimate — never presented as exact. A table
that has never been analyzed has no estimate at all, which is reported as unknown rather than as zero.
