# Projects, source analysis, the mapping workbook and schedules

Written for: engineers working on this codebase.

This is the half of the platform that is not migration. It answers three questions the migration
side cannot: what is actually in the source, who decides where each column goes, and how the target
stays correct after the first run.

---

## 1. Projects

`projects` is the container everything hangs off. A project is one of two kinds, and the kind is not
a label:

|                                   | `ANALYSIS`       | `MIGRATION`                             |
| --------------------------------- | ---------------- | --------------------------------------- |
| Source                            | required         | required                                |
| Target                            | **must be null** | required, and different from the source |
| Can write anywhere                | no               | yes, behind every existing gate         |
| Holds                             | `analysis_runs`  | `migration_plans`                       |
| May reference an analysis project | no               | yes, via `analysis_project_id`          |

`ProjectService` enforces that shape. Giving an analysis project a target is rejected rather than
ignored, and only a migration project may reference an analysis project. The reference is
self-referential on `projects` and deliberately `ON DELETE SET NULL`: losing the reference must never
delete the migration work that used it.

**Repointing is refused once a project holds work.** Changing the source of a project that already
has analyses or plans would leave stored results describing a system the project no longer points at,
so `assertNoWork` blocks it and asks for a new project instead. Archiving (`status = 'ARCHIVED'`)
hides a project from the default list without deleting anything, because decisions were made on it.

A `migration_plans.project_id` is nullable: plans predate projects and keep working without one.

---

## 2. Source analysis

`AnalysisService` runs as an `ANALYSIS` job on the existing queue. It reuses the profiling engine the
migration side uses — this matters more than it sounds, because a number seen while exploring has to
mean the same thing when a migration later acts on it.

```
analysis_runs        one run: options, totals, basis, status
  analysis_tables    one row per table, with the full TableProfileDto as jsonb
  analysis_findings  the profiles' issues, flattened so they can be listed and exported
```

Profiling itself persists nothing, so the analysis stores the profile: a full read of a source is
expensive, and an analysis nobody can come back to next week is not an analysis.

### What it adds over plan-scoped profiling

`DataQualityService` is target-bound — it derives rules from the target columns a source column maps
into. An analysis has no target, so it uses **`deriveSourceRules`**, which reuses `deriveTargetRules`
with every column mapped onto itself. That turns the source's own declared constraints into rules
about its own data: a column the schema calls required that nonetheless holds blanks, or an email
column holding something that is not an email. Those rules carry `origin: 'SOURCE_SCHEMA'`.

Three things only a source-wide pass can see:

- **A dependency-safe load order.** `analyzeDependencies` is called with the analysed set as its
  known-tables set, so a reference to a table outside the analysis is reported as out-of-scope rather
  than as missing. `analysis_tables.order_index` and `depends_on` come from that.
- **Empty columns** (`emptyColumns`): columns where `nullCount + blankCount >= examined`. Worth
  naming, because a column that is empty in the source is either dead weight that should not be
  migrated at all, or a sign the data everyone assumed was there is somewhere else.
- **Whether the whole picture is exact.** A run's `basis` is `EXACT` only when every table was read in
  full against an exact row count. One sampled table makes the run `SAMPLED`, and the UI says so.

### Bounds

`MAX_TABLES_PER_ANALYSIS = 200`. Selecting no tables analyses every migratable table up to that
limit. Sample size is clamped to 100–200,000 and the profiling service's own ceilings still apply.

A re-run deletes its own previous tables and findings first: a partial profile presented as a
complete one is the failure worth avoiding.

---

## 3. The mapping workbook

`MappingWorkbookService` produces and reads a real `.xlsx`. The formats are hand-rolled in
`server/src/lib/xlsx.ts` and `server/src/lib/zip.ts` — a spreadsheet is a ZIP of XML parts, and the
whole of the subset needed here fits in two files with no new dependency.

### Sheets

| Sheet           | Contents                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------- |
| `Overview`      | What this is, source, target, when, whether the statistics are exact, and how to fill it in |
| `Tables`        | Each table with records, columns, findings, load order, what it depends on, empty columns   |
| `Field mapping` | The sheet that is read back — see below                                                     |
| `Findings`      | Table, field, severity, code, finding, affected, statistics, suggested resolution           |

`MAPPING_SHEET_COLUMNS` in `shared/domain.ts` is the `Field mapping` header, exported as data because
the importer matches on those labels. Ten source columns are measured facts; four are decisions:
`Target table`, `Target field`, `Transformation`, `Notes`.

### Reading one back

`POST /api/plans/:id/mapping-workbook` takes the file base64-encoded in JSON (a mapping sheet is
small, and this keeps the upload inside the same CSRF-protected path as every other write) and is a
**dry run unless `apply: true`**. A mapping sheet arrives by email; nobody should learn what was in it
by watching it take effect.

Robustness is deliberate, because these files come back mangled:

- The sheet is found **by its header labels**, not its position or name (`rowsByHeader`), so reordered
  columns, a renamed sheet and extra notes above the header all keep working. Header matching ignores
  case, spaces and punctuation.
- Cells are placed by their own `r="C7"` reference. Excel omits empty cells entirely; a reader that
  trusts arrival order shifts every later column — silently.
- Shared strings, including entries split across formatting runs, are resolved.
- A CSV is accepted too, byte-order mark and all, because somebody always sends back a CSV.

Every row goes through **`PlanningService.updateMapping`**, so a target column that does not exist, is
the wrong type, or is already taken is refused exactly as it would be on screen — and refused
individually, naming the row, in `rejected`. A workbook cannot set a mapping the UI would refuse.

`IGNORE` in `Target field` means "deliberately not migrated". Blank leaves the decision open.

### Transformations

Three more sheets, in `server/src/services/transformation-sheets.ts`:

| Sheet             | Contents                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Transformations` | One row per rule step, in the order they run. Typed columns for every scalar parameter, plus `Inside step` for nesting |
| `Value maps`      | The entries of a `VALUE_MAP` or `TO_BOOLEAN` step, keyed by table, field and step                                      |
| `Concat parts`    | The pieces of a `CONCAT` step, ordered by their own `Order` column rather than by row position                         |

The first attempt squeezed a pipeline into one text cell. That handled `TRIM > TRUNCATE(160)` and
could not express a value map, a concatenation or a conditional at all, so those exported as
`VALUE_MAP(...)` and were refused on import. Wrong trade: the rules a business analyst most needs to
edit in a spreadsheet are exactly the value maps. The normalized form round-trips every kind the
engine supports.

Three rules make it safe:

- **What comes back is validated by `transformationRulesSchema`**, the same zod schema the
  transformation editor posts through, extracted to `server/src/routes/schemas.ts` so the two cannot
  drift. A workbook cannot describe a pipeline the API would reject.
- **It is applied through `TransformationService.updatePipeline`**, the same method the editor calls,
  so rules are validated and audited identically however they arrived.
- **A column the sheet does not mention is left alone.** Absence is not a decision: somebody
  hand-writing a sheet to add one rule must not silently wipe every other pipeline. Clearing one is
  said explicitly, with a `NONE` row.

A whole field's pipeline is dropped if any of its rows cannot be understood, rather than applied
half-configured: half a value map is not a smaller value map, it is a different one.

The `Transformation (reference)` column on `Field mapping` is a one-line summary and is **not**
imported, so there is one source of truth.

---

## 4. Schedules

`migration_schedules`, fired by `Scheduler` in whichever process runs the worker.

A scheduled run calls the same `MigrationRunService.start` a person does, so every gate applies: the
blocker check, the lossy-transformation acknowledgement, read-only enforcement, and the refusal to
overlap another run against the same target. Only two things differ.

**The environment confirmation.** Typing the target's name is the one thing a person does at the
keyboard that a timer cannot. So the confirmed names are captured on the schedule when it is created
and passed back at every firing. If the plan is later pointed at a different target, they no longer
match and the run is refused rather than misdirected.

**Warnings.** A schedule records the warning **codes** the plan raised when it was last confirmed
(`acknowledged_warnings`). Firing recomputes them and refuses when the plan raises one outside that
set, naming the codes. Blockers and data-loss acknowledgement are not waived either.

Codes rather than counts, deliberately: a schedule should keep running as a known warning comes and
goes with the data, and should stop when a _different kind_ appears. A count would block on noise and
wave through a genuinely new problem that replaced an old one.

Re-confirming is `PATCH /api/schedules/:id` with `acknowledgeWarnings: true` - its own deliberate
act, not a side effect of re-enabling a paused schedule. Enabling is not the same as having read what
changed.

### Firing

`runDue` claims each due schedule with a conditional `UPDATE ... WHERE next_run_at = <the value it
read>`, moving `next_run_at` forward **before** starting the run. Two worker processes cannot both win
the same slot, and a crash between claiming and starting loses one firing rather than repeating it
forever.

Three outcomes:

- **Started.** `last_run_id`, `last_status`, failure count reset.
- **Skipped.** The previous run is still going. Not a failure — counting it as one would pause a
  schedule that is merely busy.
- **Failed.** `consecutive_failures` increments; at `MAX_CONSECUTIVE_FAILURES = 5` the schedule is
  disabled with `paused_reason` kept. A schedule failing every five minutes for a week is not
  resilience, it is a queue of identical errors and, against a real target, identical partial writes.

On a failure the claim's advance **stands**. Writing the old `next_run_at` back would make a failing
schedule re-fire on every poll; that was a real bug, caught by the integration test.

### Cron

`server/src/lib/cron.ts`: five fields, `*`, lists, ranges, steps, names, `7` as Sunday, and the `@daily`
family. No seconds, no `L`/`W`/`#`.

Time zones are resolved by asking `Intl` what the wall clock reads at a candidate instant, not by
offset arithmetic. It costs a formatter call per candidate minute and is worth it: "02:30 in
Europe/London" then means 02:30 local across the DST change. A restricted day-of-month **and**
day-of-week is an OR, as cron has always had it.

### Incremental mode

`queryRecords` takes an optional `since: { field, value }`. Dataverse turns it into `$filter`, SQL
Server and PostgreSQL into one more predicate on the already-parameterized keyset read, and both demo
connectors
apply the identical comparison in memory — so a schedule tested against the demo source behaves as it
will against a real one. `capabilities.supportsIncrementalRead` reports it.

The rules that decide whether records are lost:

- **Compared as instants and as numbers, never as text.** Comparing row versions as strings puts `9`
  after `10` and skips everything between.
- **A run reports the maximum watermark it saw**, not the last record's: records arrive in
  primary-key order, not watermark order.
- **Only a run that finished advances the watermark.** A failed run leaves it, so records it never
  processed are read again rather than skipped forever.
- **A watermark never moves backwards**, so a late-finishing run cannot rewind a later one.
- **A missing watermark column is an error**, not a silent fall back to a full read that claims to be
  incremental.
- A value that is not a timestamp or a number is ignored; a lookup has no ordering to compare.

A watermark reaches a connector from a stored schedule and ends up inside an OData filter, so it is
validated against `WATERMARK_VALUE` — an ISO instant or a plain number — and the column is resolved
against real metadata before being quoted.

---

## 5. Where the code is

| Concern               | File                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects              | `server/src/services/project-service.ts`                                                                                                                                                                   |
| Analysis              | `server/src/services/analysis-service.ts`                                                                                                                                                                  |
| Mapping workbook      | `server/src/services/mapping-workbook-service.ts`                                                                                                                                                          |
| Schedules + scheduler | `server/src/services/schedule-service.ts`                                                                                                                                                                  |
| Cron                  | `server/src/lib/cron.ts`                                                                                                                                                                                   |
| XLSX / ZIP            | `server/src/lib/xlsx.ts`, `server/src/lib/zip.ts`                                                                                                                                                          |
| Routes                | `server/src/routes/projects.ts`                                                                                                                                                                            |
| Screens               | `web/src/pages/ProjectsPage.tsx`, `ProjectPage.tsx`, `AnalysisPage.tsx`, `web/src/components/MappingWorkbookCard.tsx`, `SchedulesCard.tsx`                                                                 |
| Tests                 | `tests/unit/xlsx-and-cron.test.ts`, `tests/unit/incremental-read.test.ts`, `tests/integration/projects-analysis.test.ts`, `tests/integration/incremental-schedule.test.ts`, `e2e/analysis-project.spec.ts` |
