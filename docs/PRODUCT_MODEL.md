# The product model

**Written for:** whoever works on this next — including me, later. It records the corrected domain model
and, at the bottom, exactly how much of it exists.

---

## Three questions, not one workflow

The product had one mental model — source → target — applied to everything. That is the migration model,
and imposing it on the other two workflows made both of them worse: an analysis project showed a target
selector it could never use, and comparing two systems required pretending one of them was a destination.

There are three questions, and they are different shapes:

|             | Question                                             | Shape                                     | Owns                                                                                                                          |
| ----------- | ---------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Analyse** | What is in my data, and what should I know about it? | **One or many sources. No target, ever.** | Profiling, findings, candidate keys, duplicates, relationships, data quality, semantic readings                               |
| **Migrate** | How do I safely move data from A to B?               | **Source → target**, distinct             | Schema diff, mapping, transformation, dependency ordering, identity mapping, preflight, execution, validation, reconciliation |
| **Compare** | Did these two systems agree?                         | **Two sides**, neither written to         | Counts, record matching, field comparison, missing and extra records, discrepancy export                                      |

**Source → target belongs only to migration.** No analysis screen may show it. A comparison has two sides
and no direction, so "source" and "target" are the wrong words there too.

The three are connected in one direction: an analysis can become a migration, carrying forward what it
learned, and only at that moment is a target introduced. That handoff is the point of having the analysis
workflow at all — otherwise it is a report nobody acts on.

---

## Connections are workspace assets

A connection is a reusable data system: a Dataverse environment, a SQL database, a file dataset. It belongs
to the **workspace**, not to a project. Projects reference connections.

The consequence that matters, and the one that was easiest to get wrong: **removing a source from a project
deletes the reference and nothing else.** Not the connection, not the credential, and not the same
connection out of another project that also uses it. If that boundary leaks, somebody tidying up one
analysis silently takes a configured connection away from a project they have never opened.

Creating a connection and choosing a project's source are therefore two separate acts, and must not be
collapsed into one screen.

---

## Observed, inferred, recommended, applied

The product tells someone whether a migration is safe. That makes the distinction between these four a
first-class part of the model rather than a presentation detail:

|                 | Example                                              | Rule                                         |
| --------------- | ---------------------------------------------------- | -------------------------------------------- |
| **Observed**    | 98.7% of rows in this column are populated           | A measurement. Stated plainly                |
| **Inferred**    | These integers are probably Excel serial dates       | Carries a confidence, and names its evidence |
| **Recommended** | Convert from Excel serial to a date before migrating | A suggestion. Never self-applying            |
| **Applied**     | This transformation ran on this run                  | A recorded action, with who and when         |

A reading that quietly became a transformation would be invisible and sometimes wrong, which is the one
failure mode this product cannot afford. So detection never mutates: `shared/semantic-types.ts` returns a
reading and a suggestion, and something else has to decide.

There is deliberately no "low confidence" tier. A reading that weak is a guess, and showing a guess beside
a fact teaches the reader to discount both — so it is not reported at all.

---

## Insight, not statistics

Every analysis output has to survive the question **"so what?"**

`column_1 has 46 nulls` does not. `column_1 contains no values in any of the 46 rows, so migrating it moves
nothing and may indicate an obsolete source field — exclude it unless the target requires it` does. The
first is a measurement the user must interpret; the second is a decision they can take.

This is why a finding is a first-class concept rather than a row in a statistics table: it carries severity,
evidence, affected count, impact and a recommended action. A number without an impact is trivia.

---

## Schema

```
organization
 └── environments            ← connections: Dataverse, SQL, file datasets. Workspace-scoped, reusable
 └── projects                ← kind: ANALYSIS | MIGRATION | COMPARISON
      ├── project_sources     ← the datasets an analysis is about (1..n). Deleting one keeps the connection
      ├── source_environment_id / target_environment_id
      │                        ← migration's two ends; also the primary entry in project_sources
      ├── analysis_runs       ← one per source analysed
      ├── migration_plans     ← migration only
      └── data_comparisons    ← comparison only
```

Two representations of the source exist on purpose, and they are written together: `project_sources` is the
list, and `source_environment_id` is the primary entry in it. Analysis runs, migration projects and
comparison projects all still read the column, and a migration's source genuinely is one thing. Two
representations that _can_ disagree eventually will, so `create`, `update`, `addSource` and `removeSource`
all maintain both.

Active project names are unique per workspace, case-insensitively, enforced by a partial unique index
rather than only in the service — two concurrent creates both pass an application check before either
inserts.

---

## Implementation state

Honest, because the point of this document is to be usable next time. Nothing below is marked done because
it was designed.

| Area                                                                                   | State                                                                                                                            | Where                                    |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Three project kinds                                                                    | **Done** — `ANALYSIS`, `MIGRATION`, `COMPARISON` exist and gate behaviour                                                        | `shared/domain.ts`, `project-service.ts` |
| Unique project names                                                                   | **Done** — index + race-safe service, 10 cases                                                                                   | `0025_unique_project_names.sql`          |
| Analysis holds many sources                                                            | **Done** — table, API, backfill, 11 cases                                                                                        | `0026_project_sources.sql`               |
| Removing a source keeps the connection                                                 | **Done**, tested three ways                                                                                                      | `project-service.ts`                     |
| Storage type vs semantic type                                                          | **Done** for file sources, 21 + 5 cases                                                                                          | `shared/semantic-types.ts`               |
| Excel serial dates, email, identifier, currency, percentage, phone, categorical, empty | **Done**                                                                                                                         | `shared/semantic-types.ts`               |
| Analysis runs one per source                                                           | **Partly** — runs are already per environment; "analyse all" is not wired                                                        |                                          |
| Findings as a first-class concept                                                      | **Not started** — findings exist as analysis output, not as the model above                                                      |                                          |
| Data readiness score or banding                                                        | **Not started.** If it cannot be made deterministic and explainable, use READY / NEEDS ATTENTION / HIGH RISK instead of a number |                                          |
| Analysis executive overview                                                            | **Not started**                                                                                                                  |                                          |
| Candidate-key discovery, duplicate groups, inferred relationships                      | **Not started** as first-class views                                                                                             |                                          |
| Cross-source insights                                                                  | **Not started**                                                                                                                  |                                          |
| Analysis → migration handoff                                                           | **Partly** — `analysis_project_id` exists; nothing carries findings forward                                                      |                                          |
| Project-creation experience (three kinds, explained)                                   | **Not started**                                                                                                                  |                                          |
| Connector gallery, Dataverse connect flow, file datasets with many files               | **Not started**                                                                                                                  |                                          |
| Migration workspace lifecycle and overview                                             | **Not started**                                                                                                                  |                                          |
| Comparison workspace                                                                   | **Not started**                                                                                                                  |                                          |
| Navigation, empty states, visual hierarchy, terminology pass                           | **Not started**                                                                                                                  |                                          |
| Realistic demo dataset with planted issues                                             | **Not started**                                                                                                                  |                                          |
| Analysis workbook export with an executive sheet                                       | **Not started**                                                                                                                  |                                          |

**Nothing in the UI has changed yet.** All three completed slices are model, server and test work. The
product looks exactly as it did; what changed is what it can represent.

---

## What not to do

- Do not show a target anywhere in an analysis project.
- Do not let a detection apply itself.
- Do not invent a readiness number that cannot be explained line by line.
- Do not delete a connection when a project stops using it.
- Do not report a capability as available because the code path exists. See
  [DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md](DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md) for
  what is actually certified against a real Dataverse environment, which remains: nothing.
