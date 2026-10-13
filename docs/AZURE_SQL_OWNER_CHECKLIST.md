# Azure SQL read-only certification — owner checklist

Twelve steps. The detail for each is in [AZURE_SQL_READONLY_SETUP.md](AZURE_SQL_READONLY_SETUP.md);
this page is the order and the checks.

**Never paste a connection string, password or key into chat.**

---

1. **Choose a region and confirm the price.** Basic is billed per day: US$0.1610 in East US and
   West Europe, US$0.2010 in UK South, US$0.1771 in Australia East, read from Azure's Retail Prices
   API on 2026-10-12. Run the one-line check in §7 for your region before provisioning.

2. **Create a resource group and a Basic database** named so it cannot be mistaken for production.
   `dvm-cert` is used throughout. Synthetic data only.

3. **Run the seed script** from §2, connected to `dvm-cert` rather than `master`.

4. **Check the six numbers** the script is supposed to produce: 60 people, 48 distinct codes,
   20 without an email, 90 visits, 10 without a person, 45090.0000 total. The certification
   compares its own results against these, so a mismatch here means stopping rather than
   continuing.

5. **Optionally create the denied schema** (`dvm_ro_denied.secrets`). It turns on one extra check
   and costs nothing.

6. **Create the read-only user** `dvm_cert_read` in the database, add it to `db_datareader`, and
   apply the explicit `DENY` statements. Nothing else. If you made the denied schema, deny `SELECT`
   on it too.

7. **Find the runner's outbound address** with `curl -s https://api.ipify.org` on the machine that
   will run the certification. Not GitHub-hosted CI, which has no fixed address.

8. **Add one firewall rule** for exactly that address. Do not enable "Allow Azure services and
   resources to access this server", which admits every Azure tenant. Do not open a range.

9. **Authorize the run**, then set `TEST_AZURE_SQL_RO_URL` in the environment for one command and
   run `npm run test:engines`. Do **not** set `TEST_AZURE_SQL_ENTRA` (an unimplemented
   authentication mode) or `TEST_AZURE_SQL_URL` (the write suite, which will fail against this
   login and is not authorized).

10. **Read what the run recorded** in `evidence/engine-verification.json`: the server version it
    saw, and which capabilities passed. `write` and `upsert` will be absent, which is correct.

11. **Delete the firewall rule** once the run is finished.

12. **Delete the resource group**, or drop `dvm_cert_read` if you are keeping the database. Rotate
    the password if it was typed anywhere recoverable, including a shell history file.

---

## Before step 9, the suite checks these itself

So you do not have to take step 6 on trust:

- Effective permissions at database scope, from `sys.fn_my_permissions`, with `INSERT`, `UPDATE`,
  `DELETE`, `ALTER`, `CONTROL`, `CREATE TABLE`, `CREATE SCHEMA`, `TAKE OWNERSHIP` and `IMPERSONATE`
  all required to be absent.
- Effective permissions on `dvm_ro.people`: `SELECT` present, every write permission absent.
- Role membership resolved through nesting, with `IS_ROLEMEMBER`, so a login placed in a custom
  role that is itself a member of `db_datawriter` is caught.
- Ownership of schemas and objects, which confers rights that appear in no grant table.
- The explicit grants and denies recorded for the login and for the roles it belongs to, written
  into the evidence notes.

If any of that fails the run stops before reading your data.
