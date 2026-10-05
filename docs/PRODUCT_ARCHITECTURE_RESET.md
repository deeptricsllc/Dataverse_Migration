# Product architecture reset

**Written for:** whoever implements this, and whoever has to judge afterwards whether it was done. It is a
design document, not a status report — the implementation state lives at the bottom of
[PRODUCT_MODEL.md](PRODUCT_MODEL.md) and in the slice table in section H.

---

## A. The current broken mental model

The application contains **two product architectures at once**, and they contradict each other on screen.

|                       | The new model                       | The old model                                |
| --------------------- | ----------------------------------- | -------------------------------------------- |
| Unit of work          | A project, of a declared type       | A global source and target                   |
| Where data comes from | Datasets chosen into a project      | Environments selected once, application-wide |
| What a connection is  | Reusable access to a system         | Half of a migration                          |
| How a workflow starts | Choose Analyse / Migrate / Validate | Go to Connections and pick two things        |

The second model is older and still structural. It is not a few stale labels.

### Where it is visible, verified on the deployed build

| Observation                                                                                                                                                               | Confirmed by                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A global `SOURCE → TARGET` strip renders above Connections, Migration, Validation, Audit, Compare, User mapping and Diagnostics                                           | `Layout.tsx` shows the strip on every route **except** a deny-list of seven paths. The default is to show it |
| Connections offers **"Set as source"** and **"Set as target"** per connection, and a callout reading **"Choose a source and a target"**                                   | `EnvironmentsPage.tsx:571`, `:581`, `:620`                                                                   |
| **New Migration** sends the user to Connections — `navigate('/environments')` behind a button labelled "Select environments", with a wizard whose step 1 _is_ Connections | `NewMigrationPage.tsx:44`, `:48`                                                                             |
| A connection with **no data at all** can be added to an analysis project as a "dataset", and analysis is **accepted** (HTTP 200)                                          | Probed on the current build. The run is then queued and fails: `dataset state = FAILED`                      |
| Audit is one flat chronological table with filters                                                                                                                        | `AuditPage.tsx`                                                                                              |

### The one piece of good news

The global source/target is a **per-user preference row** (`user_preferences.source_environment_id` /
`target_environment_id`), and **no service reads it**. The only readers are `getWorkspace` / `setWorkspace`
and the screens that call them. Nothing in analysis, planning, migration, validation or audit depends on
it.

That matters more than anything else in this document: **the old architecture is a UI-layer disease, not a
domain-layer one.** Removing it does not require rewriting the engine, and the domain logic that has been
built and tested — findings, readiness, dispositions, preflight, the write-scope guard, crash consistency
— is not implicated and must not be disturbed.

### The one place it is a domain problem

**Connection is being treated as Dataset.** Probed behaviour on the current build:

```
connection created                     -> HTTP 201, type=FILE, nothing imported
add empty connection as a dataset      -> HTTP 200      ← should be refused
POST /analyse                          -> HTTP 200      ← should be refused
… asynchronously …
dataset state                          -> FAILED
readiness                              -> null
```

Readiness is not fabricated, which is better than it could be. But a request that cannot possibly succeed
is _accepted_, and the user is told about it later, in the vocabulary of a failure rather than of a
missing choice. The correct answer is a domain rejection at the moment of asking.

---

## B. The target domain model

```
Organization
 └── Connection            reusable authenticated access to a system or storage location
 └── Project               the unit of work; has a declared type
      ├── ANALYSIS         → Datasets (1..n).  No source. No target. Ever.
      ├── MIGRATION        → Source side, Target side, both owned by this project
      └── VALIDATION       → a completed Migration Run, or two explicitly chosen sides
```

| Concept            | Definition                                                                                | Hard rule                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Connection**     | Reusable authenticated access to a system or storage location                             | Has **no** inherent source/target role. Creating one creates no dataset and makes no analysis possible |
| **Dataset**        | A concrete collection of data selected for work: a file, a sheet, a table, a view, a list | Must **resolve to actual accessible data or schema**. A connection with nothing selected is not one    |
| **Project**        | The unit of work. Type decides the workflow                                               | Type is declared at creation and does not change                                                       |
| **Analysis Run**   | One execution of the analysis engine over **one dataset**                                 | Cannot be created without a valid dataset                                                              |
| **Migration Run**  | One execution of a migration plan from source to target                                   | Cannot start without source dataset(s) and a target                                                    |
| **Validation Run** | One execution of a comparison                                                             | Cannot start without a comparison scope or a completed migration run                                   |
| **Finding**        | Something observed, with evidence, severity and consequence                               | Derived from stored profiles. Never edited                                                             |
| **Disposition**    | What a person decided about a finding                                                     | Stored separately. Never overwrites a finding                                                          |
| **Audit Event**    | Who did what, when, to which project, with what outcome                                   | Carries its own context. Does not depend on global state                                               |

The relationship that was missing and causes most of section A:

> **A Connection becomes a Dataset only when a workflow selects concrete content from it.** Selection is
> the event that creates a dataset. Authentication is not selection.

---

## C. Route ownership

| Route                            | Verdict                                                                       | Why                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/` dashboard                    | **KEEP**                                                                      | Already the three-workflow chooser                                                                                     |
| `/projects`                      | **KEEP**                                                                      | The unit of work                                                                                                       |
| `/analysis/:projectId`           | **KEEP**                                                                      | The reset's reference implementation                                                                                   |
| `/projects/:projectId`           | **CHANGE**                                                                    | Still the old generic project page. Becomes the Migration/Validation workspace only; analysis projects never land here |
| `/environments`                  | **CHANGE**                                                                    | Becomes _Connections_: what systems can this organization reach. Loses "set as source/target" entirely                 |
| `/migration/new`                 | **CHANGE**                                                                    | Must create a Migration **project** first, then configure sides inside it. Must not redirect to Connections            |
| `/migration`                     | **MERGE** into the migration project workspace                                | A global migration page is the old model                                                                               |
| `/compare`                       | **MERGE** into the migration project (schema step) and the validation project | Schema comparison is a step, not a destination                                                                         |
| `/users`                         | **MERGE** into the migration project (identity mapping step)                  | Only meaningful with a source and a target, which belong to a project                                                  |
| `/validation`, `/validation/:id` | **CHANGE**                                                                    | Validation becomes a project type with explicit comparison scope                                                       |
| `/runs`, `/runs/:runId`          | **KEEP**                                                                      | Execution history is legitimately cross-project; reachable from a project too                                          |
| `/audit`                         | **CHANGE**                                                                    | Project-centric grouping with drill-down                                                                               |
| `/analyses/:analysisId`          | **DEPRECATE**                                                                 | Superseded by the analysis workspace; keep the URL resolving so saved links work                                       |
| `/data-comparisons/:id`          | **KEEP**                                                                      | Detail view inside a validation project                                                                                |
| `/diagnostics`                   | **KEEP**, de-emphasise                                                        | Genuinely operational. Should not sit in primary navigation beside Projects                                            |
| `/team`, `/settings`             | **KEEP**                                                                      | Administration                                                                                                         |

**Navigation becomes:** Projects · Connections · Audit · (Administration). Schema comparison, User
mapping, Migration and Validation stop being global silos, because Projects already represents the unit of
work.

---

## D. Source/target ownership

Every place the concept exists today, and whether it belongs there.

| Where                                                      | Belongs?                  | Action                                                                                        |
| ---------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `user_preferences.source/target_environment_id`            | **No**                    | Global application state for a per-project concept. Stop reading it; leave the column (see G) |
| `GET/PUT /api/workspace`                                   | **No**                    | Remove from the shell. Retire once no screen calls it                                         |
| `Layout` global strip                                      | **No**                    | Remove. It is the old model made visible                                                      |
| Connections page "set as source/target"                    | **No**                    | Remove. A connection has no role until a workflow gives it one                                |
| `/compare`, `/users`, `/migration` reading global state    | **No**                    | These become steps inside a migration project, taking the project's sides                     |
| `DiagnosticsPage` reading global state                     | **No**                    | Should take an explicit environment, or report on connections                                 |
| `projects.source_environment_id` / `target_environment_id` | **Yes**                   | This is the right home: the sides belong to the project                                       |
| `migration_plans.source/target_environment_id`             | **Yes**                   | A plan is scoped to its two ends                                                              |
| `migration_runs`, `data_comparisons`                       | **Yes**                   | A run records what it ran against                                                             |
| Audit event `sourceEnvironmentId` / `targetEnvironmentId`  | **Yes**, as event context | What a migration run was between is part of the event, not page state                         |
| `REAL_TENANT_READ_ONLY` / certification write scope        | **Yes**                   | Deployment safety, unrelated to this model                                                    |

---

## E. Workflows

**Analysis** — already implemented; this is the shape the others should follow.

```
Create project (name only)
→ Add dataset → connector → select concrete content → preview → add
→ Analyse (per dataset)
→ Overview · Findings · Evidence · Decision
→ Re-analyse
```

**Migration**

```
Create migration project (name only)
→ Add source data: existing connection → browse → select datasets, or upload files
→ Choose target: existing compatible connection, or create one
→ Review what was discovered (schema, dependencies, identities)
→ Map → Transform → Prepare (preflight) → Migrate → Validate
```

Source and target are configured **inside** the project. Nothing redirects to Connections.

**Validation**

```
Create validation project
→ Define the comparison: a completed migration run, OR two explicitly chosen sides
→ Configure checks → Run → Differences → Evidence → Decision
```

**Connections**

```
Connections: what this organization can reach
→ New connection → choose connector → configure → Test
→ Per connection: Test · Edit · Browse data · Disable
```

Browsing data from here is a _preview_, not a dataset. Datasets are created inside a project.

**Audit**

```
Audit, grouped by project by default
→ Project → runs and activity → individual event with its own context
```

---

## F. Product invariants

Server-side. Not disabled buttons.

| #   | Invariant                                                                         | Enforcement                                         |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | A connection is not a dataset                                                     | Adding a project source requires resolvable content |
| 2   | A dataset resolves to actual data or schema                                       | Checked when added and before a run                 |
| 3   | Analysis cannot run without at least one valid dataset                            | `POST /analyse` rejects with a domain error         |
| 4   | An analysis project has no target                                                 | Already enforced on create and update               |
| 5   | A connection has no inherent source/target role                                   | No endpoint assigns one outside a project           |
| 6   | Source/target exist only in migration or comparison scope                         | Project columns only                                |
| 7   | Audit does not depend on global source/target                                     | Events carry their own context                      |
| 8   | A SharePoint/OneDrive connection with nothing selected cannot be analysed         | Same rule as 1 and 3                                |
| 9   | An empty connection cannot produce readiness or findings                          | Follows from 3                                      |
| 10  | A migration cannot execute without source dataset(s) and a target                 | Extends the existing execute guard                  |
| 11  | Validation cannot execute without a comparison scope or a completed migration run | Checked at create                                   |

Invariants 1, 2, 3, 8 and 9 are the ones the probe showed are **currently violated**.

---

## G. Data migration impact

**No destructive cleanup.** Nothing in this reset deletes a row.

| Thing                                           | Impact                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user_preferences.source/target_environment_id` | Stop reading. **Leave the columns.** Dropping them would be an irreversible change to live data for a cosmetic gain, and they are harmless once unread |
| Existing analysis projects                      | Unaffected. They already have `project_sources`                                                                                                        |
| Existing migration projects and plans           | Unaffected. Their sides are already project-scoped                                                                                                     |
| Connections with no content                     | Stay. They become visible as connections that no dataset uses, which is the truth about them                                                           |
| Audit events                                    | Unaffected. Grouping is a read-side change                                                                                                             |

**Migration certification rule**, added after the `0025` incident (section A of
[DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md](DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md) and
the commit that fixed it). Every schema or data migration that **adds a constraint or changes existing
semantics** must be tested against three states:

1. a clean database,
2. a representative upgraded database,
3. **the dirty state the constraint is about** — the duplicates, the nulls, the orphans.

`0025` was tested against (1) only. It passed everything and took QA down, because the one state that
mattered was the one never exercised. And: **a deployment reporting SUCCESS while the process crash-loops
is not evidence of a successful release.** Health is part of deployment.

---

## H. Implementation slices

Smallest coherent vertical slices, in dependency order. Each leaves the product working.

| #   | Slice                    | Scope                                                                                                                                 | State |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | **Product shell**        | Remove the global source/target strip and the preference it reads. Navigation becomes Projects · Connections · Audit · Administration |       |
| 2   | **Connection ≠ Dataset** | Server invariants 1, 2, 3, 8, 9. A connection with no resolvable content cannot be added or analysed, and the refusal says what to do |       |
| 3   | **File ingestion**       | Retire the old staged-source UX. Upload → preview → add, inside a project. Excel sheet selection                                      |       |
| 4   | **Migration entry**      | New Migration creates a project; sides configured inside it; `/compare` and `/users` become steps                                     |       |
| 5   | **Validation entry**     | Explicit comparison scope; inherit from a migration run where applicable                                                              |       |
| 6   | **Audit**                | Project-centric grouping and drill-down                                                                                               |       |

Slices 1 and 2 are the reset. Everything after them is applying the same model to the two workflows that
have not had it yet, and they are large — slice 4 in particular is the whole migration experience.

---

## What this document does not license

Cross-dataset intelligence, more analysis rules, more connectors, AI, Dataverse certification. The model
comes first. A screen that works and expresses the wrong model is a failed screen, and adding features to
a wrong model makes it more expensive to fix, not less.
