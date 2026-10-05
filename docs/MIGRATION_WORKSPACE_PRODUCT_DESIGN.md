# The migration workspace

A design document, written before the code, because the question this phase asks is not "how do we build
it" but "which of the nine steps were ever real".

The short answer: the engine underneath is mature and mostly correct, and the wizard on top of it is the
problem. Blockers, readiness, dependency ordering, upsert identity, retry semantics, write guards and
audit all exist and are good. What does not exist is **one place a migration lives**. Today a migration is
nine pages, four of them query-string steps of a fifth, and the only way to answer "what is blocking us"
is to walk back through the pages you already clicked past.

---

## 1. The nine-step workflow as it stands

`WIZARD_STEPS` in [WizardSteps.tsx](../web/src/components/WizardSteps.tsx), and where each one actually lives:

| #   | Step                | Where it is                              | What it really is                              |
| --- | ------------------- | ---------------------------------------- | ---------------------------------------------- |
| 1   | Source and target   | `/projects/:id` → `/environments`        | Choosing the migration's two ends              |
| 2   | Analyze             | `/compare?projectId=`                    | Schema comparison between the two ends         |
| 3   | Select tables       | `/migration/new?projectId=`              | Choosing scope                                 |
| 4   | Review dependencies | `/migration/plans/:id?step=dependencies` | Load order                                     |
| 5   | Map fields          | `…?step=mapping`                         | Field, choice and transformation configuration |
| 6   | Review plan         | `…?step=review`                          | Issues, readiness, execute                     |
| 7   | Execute             | `/runs/:id`                              | A migration run                                |
| 8   | Validate            | `/validation`                            | Reconciliation                                 |
| 9   | Results             | `/validation/:id`                        | The reconciliation report                      |

The stepper is rendered by four different pages, each hard-coding which number it is. `PlanPage` is 1,540
lines and carries steps 3–6 as `?step=` values with "Continue: …" buttons between them.

## 2. Which steps are real domain concepts

These survive, because they are things that exist whether or not anyone drew a wizard:

- **Scope** — which datasets move. Backed by `migration_plan_entities`.
- **Mapping** — source field to target field. Backed by `field_mappings`, with object mapping, choice
  mapping and transformations beside it.
- **Dependencies** — the order the data must move in. `DependencyAnalysisDto` already produces order,
  cycles with deferrable edges, and **missing dependencies** (a table required by the scope but not in it).
- **Readiness** — can this execute safely. `ReadinessService` already assembles findings from plan
  validation, the connector verification matrix, target state, resume capability, measured scale and
  rollback reality, and produces one verdict.
- **Execution** — a run, with attempts.
- **Results and failure** — per-record outcomes, errors, reconciliation.

## 3. Which steps exist only because of the wizard

- **"Source and target" as a step.** The migration project already owns `sourceEnvironmentId` and
  `targetEnvironmentId`. Making it step 1 sent people to the Connections page, which is where the old
  global model lived. It is a property of the migration, editable at any time, not a stage you pass.
- **"Analyze" as a step.** Schema comparison is evidence the mapping screen needs; it is not a thing a
  consultant sets out to do. It should run when scope changes and be visible as freshness, not as a gate.
- **"Review plan" as a step.** Review is not a stage — it is the Overview, available always. A review you
  can only reach at step 6 is a review nobody does twice.
- **"Validate" and "Results" as steps.** Validation is separate work with its own workspace; it belongs to
  a _completed run_, as an action on that run, not as steps 8 and 9 of a line.
- **The stepper itself.** It encodes "I completed step 6, so I guess I'm ready" — the exact sentence the
  product must stop producing.

## 4. The workspace

One route, one project, sections that are always available:

```
/migration/:projectId        Overview · Data · Mapping · Transformations · Dependencies · Runs
```

Six sections, not nine, and not nine renamed. Validation and Audit are **handoffs**, not sections: each is
a link that carries the migration's context into a workspace this phase does not touch.

Why these six:

- **Overview** answers §5's eight questions in one screen and is the default.
- **Data** is the scope: what is moving, how much of it, and to which target table.
- **Mapping** is field-level work, revisited constantly, never "completed".
- **Transformations** is its own section because §13 is right: a consultant has to be able to answer
  "what will happen to this field before it reaches the target" without opening every field mapping. It is
  a read-across of what is configured; editing still happens beside the field it belongs to.
- **Dependencies** explains order and names the consequences of a missing parent.
- **Runs** is history: every run, every attempt, what failed and why, and what to do next.

### The plan stops being a noun the user meets

Today a migration project _contains plans_, and the plan is where everything happens. That is one layer
too many: "a controlled body of work for moving defined data from one place to another" is the project.

**The plan becomes the project's migration configuration**, created implicitly the first time source data
is added. The user never creates, names or chooses a plan. `migration_plans` stays exactly as it is —
nothing is dropped, nothing is migrated — and the workspace reads the project's **current** plan, defined
as its most recently updated one.

A project that already has several plans keeps all of them: the workspace works on the latest, and the
others remain reachable through the runs attached to them. This is the only choice that satisfies §36
without a data migration.

## 5. Migration project state

Status describes reality, never a step number (§29):

| Status                  | Means                                                         |
| ----------------------- | ------------------------------------------------------------- |
| `DRAFT`                 | No source data, or no destination                             |
| `PREPARING`             | Both ends set, configuration incomplete, nothing blocking yet |
| `BLOCKED`               | Readiness says execution would be unsafe                      |
| `READY`                 | Readiness is READY or READY_WITH_WARNINGS                     |
| `RUNNING`               | A run is queued or running                                    |
| `COMPLETED_WITH_ISSUES` | Last run finished with failures                               |
| `COMPLETED`             | Last run finished clean                                       |

Derived on read from evidence that already exists — the project's two ends, the plan's entity count, the
readiness verdict and the latest run's status. Nothing new is stored, so nothing can drift out of step
with the thing it describes.

## 6. Readiness and blockers

**Reused, not reinvented.** `ReadinessService.assess(planId)` already produces the verdict, the findings
and the overrides. §15 warns against "arbitrary scoring complexity" and that is exactly what inventing a
second model would be.

Two layers, both already server-enforced in `MigrationRunService.start`:

1. `validatePlan` → `PLAN_HAS_BLOCKERS` (409) — forty-odd deterministic codes including
   `REQUIRED_TARGET_COLUMN_UNMAPPED`, `OBJECT_MAPPING_MISSING`, `CHOICE_MAPPING_INCOMPLETE`,
   `PRIMARY_KEY_MISMATCH`, `CROSS_PROVIDER_IDENTITY`.
2. `ReadinessService` → `READINESS_BLOCKED` (409), with per-finding named overrides.

Plus a typed confirmation for production targets. The work here is **surfacing**: the Overview states the
verdict, the three biggest blockers in the vocabulary of what to do, and the next action.

What is missing and will be added: readiness must also refuse **no destination** and **no source data**,
which today are impossible to reach because the wizard would not create a plan without them. In a
workspace they are ordinary states, so they become ordinary findings.

## 7. Execution

Unchanged. `POST /api/plans/:id/execute` creates a run; the worker executes it. Write scope, read-only
guards, plugin bypass controls, target locking, concurrency protection and the evidence chain are all
`KEEP` — §18 is non-negotiable and nothing in this phase touches them.

The workspace shows truthful progress only: per-entity counters the engine actually maintains, and
"Waiting" for entities that have not started. No synthetic percentage is invented for anything the backend
cannot count.

## 8. Retry and rerun

The engine's model, which already satisfies §22 and is better than what §22 asks for:

- **Retry** re-queues the _same_ run with `attempt + 1`, and only what is outstanding. Run #15 stays
  Run #15; its attempts are separate, visible execution records, decomposed by final responsibility so
  they sum to the run total without double counting (`attempt-metrics.ts`).
- **Run again** is a new execution of the configuration — a new run, a new number.
- Retry is **refused** when a record in doubt has nothing that could identify it, because another attempt
  could create a second copy. Those records are named instead.

The workspace must make the attempt visible, so a retry never looks like the original run quietly
changed. That is the only change: the model is right, the screen hides it.

## 9. Validation handoff

`POST /api/validations` already accepts `migrationRunId` and derives source, target and scope from the
run. The workspace adds a **Validate run** action on a completed run that passes it, so nobody re-selects
a source and target they have just migrated between. Validation itself is untouched (§26, §40).

## 10. Audit

Migration actions already emit `MIGRATION_PLAN_CREATED`, `MIGRATION_EXECUTION_REQUESTED`,
`MIGRATION_COMPLETED`, `MIGRATION_RETRY_REQUESTED` and the rest, carrying actor, outcome, run and both
environments.

**The gap**: `audit_events` has no `project_id`. Every migration event is tied to environments and a run,
which is the old global model's vocabulary — "which project was this" is answerable only by joining
through a plan that may since have changed. §27 requires the project on the event.

So: add a nullable `project_id` column, populate it on migration and project events, and expose it. No
backfill — an event recorded before the column existed genuinely did not record a project, and inventing
one by inference would be worse than null.

## 11. Route changes

| Route                                | Now                  | After                                                         |
| ------------------------------------ | -------------------- | ------------------------------------------------------------- |
| `/migration/:projectId`              | —                    | **The workspace.** Sections as `?section=`                    |
| `/projects/:id` (MIGRATION)          | Lists plans          | Redirects to the workspace                                    |
| `/migration/new`                     | Wizard step 3        | Name + optional purpose, then the workspace                   |
| `/migration/plans/:planId`           | The wizard           | Redirects to its project's workspace                          |
| `/migration/plans/:planId/preflight` | Preflight page       | Kept; reached from the workspace                              |
| `/compare`                           | Wizard step 2        | Kept for comparison projects; no longer a migration step      |
| `/users`                             | Wizard-adjacent page | Reachable, and surfaced inside Mapping where it belongs (§24) |
| `/runs/:id`                          | Run detail           | Kept; the workspace links into it and back                    |

Nothing is deleted. A bookmark to a plan still lands somewhere sensible, which is what §36 requires of
existing work.

## 12. Compatibility with existing plans and runs

- `migration_plans`, `migration_plan_entities`, `field_mappings`, `migration_runs`,
  `migration_record_maps` — **unchanged**. No migration of existing rows.
- A plan with `project_id = null` (created before projects existed) is still readable at its own route and
  still shows its runs. It has no workspace, because it belongs to no project, and that is honest.
- A project with several plans shows the latest as current; the rest stay reachable through their runs.
- `audit_events.project_id` is additive and nullable.

Tested against a database built in the state an established workspace is in, not only a clean one — the
rule written after `0025` took QA down.

## 13. Implementation slices

Each slice is gated, deployed and reviewed before the next.

**Slice A — the workspace shell and Overview.** The route, the six sections, the project status model, and
an Overview that answers the eight questions. The wizard stepper stops being navigation. Readiness gains
the two findings a workspace makes reachable (no destination, no source data).

**Slice B — Data and destination.** Source data added by reusing the dataset experience built last phase
(`AddDatasetDrawer`, same components, same server rules), called **Add source data**. Destination chosen
in context, with target capability stated and a read-only or simulated target never appearing executable.
Changing either end explains what it invalidates and requires confirmation.

**Slice C — Mapping, Transformations, Dependencies.** The three sections that carry the existing engine's
intelligence, moved out of wizard steps into persistent sections: suggested versus confirmed, what happens
to each field before it is written, load order and the consequences of a missing parent. Identity strategy
per dataset, because "will this duplicate data" is the question a rerun turns on.

**Slice D — Runs, failure and handoff.** Run history with attempts, a result that answers what happened,
a failure experience that answers what failed and why and whether retry is safe, and the validation and
audit handoffs carrying project and run.

---

## What this document does not license

Redesigning Validation, Audit, Analysis findings, dataset ingestion or Connections. Rewriting the
migration engine. Adding connectors or AI. The engine is mature; this phase changes where a consultant
stands while using it.
