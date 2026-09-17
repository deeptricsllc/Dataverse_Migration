# Certifying the platform against a real Microsoft tenant

**Written for:** the person who will connect this platform to a real Microsoft 365 / Power Platform
tenant for the first time. No Microsoft identity expertise is assumed — every term is explained
where it first appears.

There are two certifications, in this order:

1. **Read-only certification** (this document, part A). Proves the platform can authenticate,
   discover, read and analyze a real tenant. **No data is written.**
2. **Controlled write certification** (part B). Proves a real migration works. It writes data, so it
   only ever runs against scratch environments you are willing to lose. **Do not start part B until
   part A passes.**

> **Status:** as of this release the platform has **not** been certified against a real Microsoft
> tenant. Until someone completes part A and records the result, treat every "works with Dataverse"
> statement as "written against Microsoft's documentation and covered by tests using simulated
> environments".

---

## Vocabulary (read once)

| Term                        | What it means here                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Tenant**                  | Your company's Microsoft directory (Entra ID, formerly Azure AD). It contains users and app registrations.                          |
| **App registration**        | The identity of this platform inside your tenant. It is what the sign-in prompt shows.                                              |
| **Delegated permission**    | The app acts **as the signed-in user**, never with more rights than that person has. This platform only uses delegated permissions. |
| **Environment**             | One Power Platform environment. A Dataverse database lives inside an environment.                                                   |
| **Dataverse security role** | What a user is allowed to do inside one environment. Roles are per environment, not per tenant.                                     |
| **Privilege**               | One entry inside a security role, e.g. "Act on Behalf of Another User".                                                             |
| **Production environment**  | An environment Microsoft classifies as `Production`. Live business data. This platform warns loudly before writing to one.          |
| **Sandbox environment**     | A non-production environment, usually a copy. This is where you certify.                                                            |

---

# Part A — Read-only certification

## A0. Before you start

You need:

- An account that can sign in to the tenant and has a Dataverse security role in at least two
  **non-production** environments (one source, one target). "System Customizer" or a read-capable
  custom role is enough for part A.
- The app registration from [MICROSOFT_SETUP.md](MICROSOFT_SETUP.md) (client id, client secret,
  redirect URI, admin consent granted).
- A deployment of this platform you control (local or Railway).

Never put the client secret in a commit, a screenshot, a chat message or a log. Store it in the
deployment's secret store.

## A1. Configure the deployment for read-only

Set these, exactly:

```bash
DEMO_MODE=false                # no simulated environments and no demo sign-in
REAL_TENANT_READ_ONLY=true     # all reads allowed, all Dataverse writes refused by the server
ENTRA_CLIENT_ID=...            # from your app registration
ENTRA_CLIENT_SECRET=...        # from your app registration (secret store, never a commit)
ENTRA_TENANT_ID=<tenant GUID>  # or "organizations"
APP_BASE_URL=https://<your deployment>
COOKIE_SECURE=true
```

`REAL_TENANT_READ_ONLY=true` is enforced **inside the server**, in the Dataverse HTTP client: any
`POST`, `PATCH`, `PUT`, `DELETE` or `MERGE` is refused before the request leaves the process, and a
migration cannot even be queued. It does not depend on the UI hiding a button.

Restart the deployment and confirm the header of every page shows a blue bar reading
**REAL TENANT — READ ONLY**. If you instead see the amber **DEMO MODE** bar, `DEMO_MODE` is still
on and you are not looking at real data.

## A2. The checklist

Work through it in order. Record the result of each step (pass / fail / what you saw).

| #   | Step                         | What to do                                                                          | Expected result                                                                                                                                     |
| --- | ---------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign in                      | Open the deployment, click **Continue with Microsoft**, complete the prompt         | You land on the dashboard as yourself. There is no demo sign-in button.                                                                             |
| 2   | Diagnostics — authentication | Go to **Diagnostics**, click **Run diagnostics**                                    | _Authentication_ and _Token acquisition_ are green. No token is displayed anywhere.                                                                 |
| 3   | Environment discovery        | Same report                                                                         | _Environment discovery_ lists the environments your account can see. If it is empty, see [A3](#a3-when-something-fails).                            |
| 4   | Select source and target     | **Environments** → pick a **non-production** source and a **non-production** target | Both cards show the environment URL. Production environments are labelled; do not select one.                                                       |
| 5   | Connection test              | Click **Verify both connections**                                                   | Both report connected, with your Dataverse user id.                                                                                                 |
| 6   | Metadata                     | Re-run **Diagnostics**                                                              | _Metadata access_ reports the number of readable tables and the columns/keys of a sample table.                                                     |
| 7   | Record read                  | Same report                                                                         | _Record read permission_ reports a record count.                                                                                                    |
| 8   | User discovery               | Same report                                                                         | _User discovery_ reports how many users are readable.                                                                                               |
| 9   | Write permission             | Same report                                                                         | _Write permission_ is **Not tested** and says writes are disabled for this deployment. This is correct: it is never probed.                         |
| 10  | Schema comparison            | **Compare** → **Analyze**                                                           | The table catalog is compared. Differences are listed per table and column. Export the CSV.                                                         |
| 11  | Dependencies                 | Create a plan for a handful of tables                                               | The dependency order is computed; cycles (if any) are reported and resolved in two passes.                                                          |
| 12  | Record counts                | Same plan / **Compare**                                                             | Source and target counts look plausible for those tables.                                                                                           |
| 13  | User mapping                 | **User mapping** → **Load and match users**                                         | Users are matched across environments. Anything matching more than one target is **Ambiguous** and is not mapped automatically.                     |
| 14  | Impersonation check          | Same page → **Run check**                                                           | A read-only answer either way. "Cannot impersonate" is a valid result; it only matters for the `PRESERVE_ATTRIBUTION` audit policy.                 |
| 15  | Preflight (dry run)          | Plan → **Review** → **Preflight (dry run)** → **Run preflight**                     | Every source record is classified CREATE / UPDATE / UNCHANGED / CONFLICT / BLOCKED, with field-level drill-down. **Nothing is written.**            |
| 16  | Remediation export           | Plan → **Review** → **Export all issues (remediation package)**                     | A CSV with `Severity, Category, Table, Source Record ID, Record Name, Field, Source Value, Target Value, Issue, Resolution, Suggested Action`.      |
| 17  | Write block                  | Plan → **Execute migration**                                                        | The server refuses with `REAL_TENANT_READ_ONLY` (HTTP 403) and records a `READ_ONLY_WRITE_BLOCKED` audit event. Confirm it in **Settings → Audit**. |

**No Dataverse writes are permitted during part A.** Step 17 exists to prove the block works.

### Recording the result

Save, alongside this file or in your ticket system:

- the date, the tenant name, and the two environment URLs used;
- the diagnostics report (screenshot or copy of the check list);
- the preflight totals;
- the remediation package CSV;
- the audit event from step 17.

Only after every step passes may the platform be described as "read-certified against a real
Microsoft tenant" — and still **not** as "migration-certified".

## A3. When something fails

| Symptom                                                 | Most likely cause                                                                                 | Fix                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in shows "need admin approval"                     | Admin consent was not granted for the delegated Dynamics CRM permission                           | A Global Administrator grants consent on the app registration (see MICROSOFT_SETUP.md).                                                      |
| Sign-in works, discovery returns no environments        | The account has no Dataverse security role anywhere, or an environment security group excludes it | Assign a security role in the environment; check the environment's security group membership.                                                |
| Discovery lists an environment but connecting fails 403 | No security role **in that environment**                                                          | Roles are per environment. Assign one there.                                                                                                 |
| Metadata reads fail                                     | The role lacks read privileges on entity metadata                                                 | Use a role with read access to customizations, e.g. System Customizer, or add the privileges.                                                |
| Impersonation check says "cannot impersonate"           | `prvActOnBehalfOfAnotherUser` is missing, or it was granted through a team                        | Microsoft requires this privilege to be assigned **directly** to the user, not inherited from a team. Or choose the `STANDARD` audit policy. |
| Everything is slow / HTTP 429                           | Dataverse service protection limits                                                               | Expected under load. The client honors `Retry-After` and backs off; reduce the batch size if it persists.                                    |

Diagnostics explains each failure in place, without printing tokens or raw responses.

---

# Part B — Controlled write certification (prepared, not executed)

**Do not run part B against any environment you are not willing to lose.** It writes data.

This section is a prepared checklist. It has **not** been executed for this release.

## B0. Preconditions

- Part A passed and its evidence is recorded.
- Two **scratch** environments exist, both non-production, both freshly created or freshly reset:
  - `SCRATCH-SOURCE` — holds a small, known dataset (start with fewer than 100 records).
  - `SCRATCH-TARGET` — empty at the start.
- You have a backup or a copy-on-demand snapshot of `SCRATCH-TARGET`.
- The account has create/write/append privileges in `SCRATCH-TARGET` and read in `SCRATCH-SOURCE`.
- Nobody else is using either environment during the test.

## B1. Configuration change (the only one)

```bash
REAL_TENANT_READ_ONLY=false   # writes are now possible. Everything else stays as in part A.
```

Confirm the **REAL TENANT — READ ONLY** banner disappears. Treat the deployment as live from this
moment.

## B2. Checklist

| #   | Step                    | What to do                                                                | Expected result                                                                                                          |
| --- | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Preflight first         | Run a preflight on the plan                                               | All records classified CREATE; zero blockers.                                                                            |
| 2   | Execute                 | Execute the plan, typing the target environment name to confirm           | Run completes. Created count equals the preflight CREATE count.                                                          |
| 3   | Validate                | Run validation on the completed run                                       | Record existence passes; field comparison passes; no broken references.                                                  |
| 4   | Spot check in Dataverse | Open 3 migrated records in the target environment directly                | Values, owner and created on match what the plan promised.                                                               |
| 5   | **No-op guarantee**     | Run the preflight again, then execute again with the `SYNC` strategy      | Preflight reports every record UNCHANGED; the run reports 0 created, 0 updated. **Target `modifiedon` must not change.** |
| 6   | Single-field change     | Change one field on one source record; preflight; execute                 | Exactly 1 update, the rest unchanged. Only that record's `modifiedon` changes in the target.                             |
| 7   | Ownership               | With `STANDARD`, confirm owner and created on in the target               | They match the mapped source user and the source creation date.                                                          |
| 8   | Attribution             | With `PRESERVE_ATTRIBUTION` (needs the impersonation privilege)           | Created by / modified by match the mapped source users. `modifiedon` is the migration time — this cannot be preserved.   |
| 9   | Strict policy           | Point a record at a user that does not exist in the target, keep `STRICT` | The record is **BLOCKED**, not silently reassigned.                                                                      |
| 10  | Fallback policy         | Switch to `FALLBACK`, choose an identity, acknowledge the impact          | The record is written with the chosen identity, and the substitution appears per record and in the exports.              |
| 11  | Throttling              | Migrate a larger table (a few thousand records)                           | 429s are retried with backoff; the run completes without data loss.                                                      |
| 12  | Resume                  | Pause mid-run, then resume                                                | No duplicates: already-migrated records are skipped through the identity map.                                            |
| 13  | Audit                   | Review **Settings → Audit**                                               | Every execution, policy change and bypass is recorded with who and when.                                                 |
| 14  | Clean up                | Reset or delete both scratch environments                                 | —                                                                                                                        |

## B3. After part B

Only when every step above has actually been executed and recorded may the platform be described as
**certified against a real Microsoft tenant**. Anything less is "tested with simulated
environments".
