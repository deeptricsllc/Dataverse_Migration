# Trust sprint: definitions, open decisions and known limits

Written for the engineering team and product owner. It records the metric definitions the product
now commits to, the terminology that still means two things, and the decisions that need a person
rather than a patch.

Dated 1 October 2026.

---

## 1. Canonical run metrics

One definition each, in `shared/run-metrics.ts`, read by the run page, the validation report, the
CSV export and the tooltips. Changing a definition there changes it everywhere, which is the point.

| Metric | Definition |
| --- | --- |
| **Processed** | Source records this run evaluated and reached a decision about. |
| **Created** | Records that did not exist in the target. This run inserted them. |
| **Updated** | Records that existed in the target and differed. This run changed them. |
| **Unchanged** | Records that existed in the target and already matched the source. Nothing was sent. |
| **Skipped** | Records that existed in the target and were left alone by the conflict rules. They are in the target, but this run did not write them. |
| **Failed** | Records this run tried to write and could not. They are not in the target. |
| **Written by this run** | Created + Updated. Nothing else. |
| **Expected in the target** | Created + Updated + Unchanged + Skipped. The set validation checks. Excludes Failed, because the run is already telling you those did not make it. |

The five outcomes are exhaustive and mutually exclusive: every record the run accounted for lands in
exactly one, and they sum back to Processed.

**The rule that was being broken:** a record the run deliberately did not write is not a record the
run wrote. `tests/unit/run-metrics.test.ts` asserts it directly, and
`tests/integration/metric-agreement.test.ts` asserts the run page and the validation report produce
identical numbers for the same migration — by running one twice so the second run skips.

**Historical reports.** Validation reports written before 1 October 2026 recorded a single
`migrated_records` figure computed the old way. It cannot be converted into an honest breakdown, so
it is not read back and not restated. Those reports say the breakdown was not recorded. Re-running
the validation produces a correct one.

---

## 2. Terminology inventory

Words that currently carry more than one meaning. None of these are safe to mass-rename; each needs
a decision.

| Word | Meaning A | Meaning B | Recommendation |
| --- | --- | --- | --- |
| **Compare** | `/compare` — schema comparison between two environments: tables, columns, keys. | A "Comparison & validation" project — data reconciliation, record by record. | Rename A to **Schema comparison** and B to **Data reconciliation**. They answer different questions for different people. |
| **Validation** | Verifying a migration against its source after the fact. | `plan.issues` — the blockers that stop a plan executing. | Keep A. Rename B to **Plan checks** or **Readiness**; it happens before anything runs. |
| **Migrated** | Removed. Was "not failed", which included skipped. | — | Done. Use **Written by this run**. |
| **Analysis** | Profiling a source: columns, statistics, findings. | `analyzeDependencies` — the load-order graph. | Keep A as the user-facing word. B is internal; no UI uses it. |
| **Diagnostics** | Read-only checks of the **Microsoft** connection only. | Reads as "diagnostics for the product". | Rename to **Microsoft connection checks**, or generalise it per provider. A buyer migrating Postgres→Postgres should not meet a Dataverse-only tab in the main nav. |
| **Skipped** | A record the conflict rules left alone (has a target id). | A *table* skipped because it was not reached. | Same word, different grain. Acceptable, but the table-level one should read **Not reached**. |
| **Matched** | Validation: identical on both sides. | Planning: a source record paired with a target record by key. | Distinguish as **Identical** (validation) and **Paired** (planning). |

Also: Connections has two adjacent filters labelled "All connection types" and "All types". One is
provider, one is environment kind. Both need real labels.

---

## 3. Information architecture: the wizard versus projects

**The problem.** There are two navigation models for the same work. A nine-step strip
(`Select environments → … → Results`) describes one global guided migration driven by a single
source→target "workspace". Projects describe many migrations, each with its own source and target.
They contradict each other: a run opened from a project showed "Development → UAT" under a banner
reading "Legacy SQL Server → QA" with a progress bar claiming step 7 of a migration the reader had
never started.

**Fixed tonight (low risk):** the global strip and the step indicator no longer appear on run detail
or validation report pages, which state their own source and target. The suppression list and its
reasoning already existed; those two routes simply were not on it.

**Recommended target model** — not implemented, needs a decision:

```
Organization
└── Workspace            (an evaluation or an engagement; isolates data)
    ├── Connections      platform-level, shared across projects
    ├── Audit            platform-level
    ├── Team             platform-level
    └── Project          analysis | migration | reconciliation
        └── Analyze → Map/Transform → Migrate → Validate → Results
```

- Global nav carries **capabilities**: Dashboard, Projects, Connections, Audit, Team, Settings.
- Progress belongs **inside a project**, where the steps are real and the source and target are the
  project's own.
- The global source→target workspace disappears. It is the root cause: it is a second, invisible
  place where "which migration am I looking at" is decided.

**Affected routes if adopted:** `/migration`, `/migration/new`, `/migration/plans/:id`,
`/migration/plans/:id/preflight`, `/compare`, `/validation`, `/runs`. Components: `WizardSteps`,
`WorkspaceHeader`, `useWorkspace`, and the `showWorkspace` test in `Layout.tsx`. Estimate: this is a
week, not an evening, and it changes every e2e journey.

---

## 4. Team and workspace model (design only)

Nothing here is built. The data model already has `organizations` and `users` with a
`role: ADMIN | MEMBER`, and `platformOperator` derived from `ADMIN_EMAILS` — a deployment operator,
deliberately distinct from a customer administrator.

Proposed roles, smallest set that covers the real jobs:

| Role | Can |
| --- | --- |
| **Organization admin** | Everything, plus billing, members and connections. |
| **Migration lead** | Create projects and plans, execute migrations, approve lossy mappings. |
| **Engineer** | Edit plans, mappings and transformations. Cannot execute against a production target. |
| **Validator / reviewer** | Run validations and reconciliations. Read everything. No writes to a target. |
| **Auditor** | Read-only, including the audit trail. No project or connection changes. |

**Evaluator isolation.** Today every demo visitor shares one workspace, which is why it fills with
other people's work and why a prospect sees it. The smallest honest fix is a workspace per demo
session: `organizations` already scopes everything, so a per-session demo organization with its own
seeded environments would isolate evaluators without touching authorization. The curated scenarios
would be built per workspace rather than once, which costs a few seconds of background work per
visitor.

---

## 5. What validation can prove today

| Question | Status | Notes |
| --- | --- | --- |
| **Completeness** — did everything expected arrive? | Yes | Row counts, plus record existence through the identity map. Sampled above 5,000 records per table, and the report says so. |
| **Accuracy** — do source and target agree? | Yes | Every mapped column compared. |
| **Transformation correctness** | Yes | Compares against the value the transformation *should* have produced, using the same engine and the run's own snapshot of the rules — not against the raw source. |
| **Referential integrity** | Yes | Lookups resolved through the identity map; broken references counted separately. |
| **Migration accountability** | Yes | Created / updated / unchanged / skipped / failed, per table and in total. |
| **Scope awareness** | Yes | Distinguishes "the target holds 144 rows" from "this run was responsible for 28", and says so in words. |
| **Business-key reconciliation** | Yes | Source→target identity is recorded per record and exportable. |
| **Nullability** | Partial | A required value that is missing fails the write and is reported as a failed record. Validation does not separately re-assert nullability in the target. |
| **Type / format correctness** | Partial | Covered implicitly by value comparison. No explicit "this date survived conversion" check. |
| **Uniqueness** | **No** | Nothing checks whether the migration introduced duplicates in the target. The analysis side detects duplicate business keys in the *source*; the post-migration equivalent does not exist. This is the largest genuine gap. |

**Sampling.** Above 5,000 records per table validation compares a sample, and above 2,000
differences it stores the first 2,000 — both stated in the report rather than silently. For a
multi-million-row migration that means "validated" is a strong sample, not a census. A buyer
migrating at that scale will ask; the honest answer today is the sample size.

---

## 6. Connector capabilities, as implemented

Capabilities are declared per **family**, not per engine: `server/src/connectors/capabilities.ts`
returns one of three constants. PostgreSQL, MySQL, SQL Server and Azure SQL therefore advertise
identical capabilities, which is not the same as having identical verification behind them.

| Connector | Read | Write | Schema | Profile | Migrate | Validate | Verified by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Microsoft Dataverse | Yes | Yes | Yes | Yes | Yes | Yes | Simulated connector end to end; no real tenant in CI |
| SQL Server | Yes | Yes | Yes | Yes | Yes | Yes | Full journey, source and target |
| Azure SQL | Yes | Yes | Yes | Yes | Yes | Yes | Shares the SQL Server implementation |
| PostgreSQL | Yes | Yes | Yes | Yes | Yes | Yes | Dedicated connector and safety tests |
| MySQL | Yes | Yes | Yes | Yes | Yes | Yes | Unit-level; **not exercised end to end** |
| CSV / Excel / XML | Yes | **No** | Inferred | Yes | Source only | As a source | Full journey as a source |
| OneDrive / SharePoint file | Yes | **No** | Inferred | Yes | Source only | As a source | Requires Microsoft Graph to be enabled |
| SharePoint list | Yes | **No** | Yes | Yes | Source only | As a source | Requires Microsoft Graph to be enabled |

The landing page already discloses the MySQL gap in "The gaps, before you find them". Keep that.

**Recommendation:** replace the single `SQL_CAPABILITIES` constant with per-engine declarations and
a verification tier — `SUPPORTED`, `PARTIALLY SUPPORTED`, `EXPERIMENTAL`,
`REQUIRES NETWORK CONFIGURATION` — surfaced on the connection card. The product's strongest trait is
that it says what it cannot guarantee; the capability model should say it too.

---

## 7. Scale risks

Classified, not fixed. Nothing here is a correctness bug.

| | Where | Risk |
| --- | --- | --- |
| **P2** | `migration-engine.ts` `resolveDeferred` and `stampModifiedBy` | Load every pending record map for a table into memory with no limit, then batch. The main read path is paged; these two second passes are not. A multi-million-row table with deferred lookups would hold the whole set at once. Fix: keyset-paginate over `migrationRecordMaps` the way the primary loop pages the source. |
| **P2** | `validation-service.ts` | Compares at most 5,000 records per table. Correct and disclosed, but at ten million rows "validated" means a 0.05% sample. Fix: make the cap a documented, configurable validation depth with the confidence stated in the report. |
| **P3** | `validation-service.ts` `fetchByIds` | Fetches source and target records for the sample in one call each. Fine at 5,000; would need chunking if the cap rises. |
| **P3** | Audit details | Stored as unbounded JSONB. A run with a very large options payload writes it on every event. |

The answer to "a five-million-row migration fails after 3.8 million rows" is good today: the identity
map records every processed record, `checkControl` honours pause and cancel between batches, and
"Re-run, writing only what failed" reprocesses the remainder without duplicating what landed. That
is the right design; the memory ceiling above is what would bite first.

---

## 8. Known open items

- **Uniqueness after migration** is not validated. Section 5.
- **Evaluator workspaces are shared.** Section 4.
- **Diagnostics is Microsoft-only** but sits in the main nav of a multi-database product.
- **`/validation` shows a dead card** — "Validate environment tables" says "Analyze the environments
  first to choose tables" with no link to doing so.
- **Settings shows `Database: postgres`**, an implementation detail with no meaning for a customer.
- **No team management.** Section 4.
- **No pricing or packaging.** Deliberate; "Request access" remains the only commercial action.
