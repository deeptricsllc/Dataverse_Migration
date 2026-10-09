# Validation experience — certification report

## 1. Verdict

**VALIDATION EXPERIENCE — INTERNALLY USABLE**

The validation engine was already substantially right. What it could not do was say so honestly: a
comparison that never ran reported **Passed with warnings**, a finding said what the comparison saw
and not what to do about it, and nothing on a result said which rules had produced it. Those are the
three things a migration engineer needs before they sign a cutover off, and all three are now there.

## 2. Candidate

|                       |                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------- |
| Branch                | `validation-experience`                                                                 |
| Starting `main`       | `bbe2243e9cd6c5c7a9c665f5a24451e1dab3ef4c`                                              |
| Reviewed and deployed | `e3d38ac5152f48849cba416ab1867ed737dd0660`                                              |
| Branch head           | `e3d38ac` plus this report. `git diff e3d38ac..HEAD` touches `docs/` only               |
| PR                    | [#5](https://github.com/deeptricsllc/Dataverse_Migration/pull/5) — **open, not merged** |

## 3. Release gate and CI

Local gate on `e3d38ac`: **7 passed, 0 failed, 0 did not run, 1 skipped.**

| Check                                | Result                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format                               | passed                                                                                                                                                                                    |
| lint                                 | passed, 0 errors                                                                                                                                                                          |
| content                              | passed                                                                                                                                                                                    |
| typecheck                            | passed                                                                                                                                                                                    |
| unit + integration + golden journeys | passed — 1,224 tests, 4 skipped, 126 files                                                                                                                                                |
| build                                | passed                                                                                                                                                                                    |
| end-to-end                           | passed — 29 browser journeys                                                                                                                                                              |
| evidence drift                       | **skipped** — it compares a committed snapshot against a fresh engine run, which CI does after the engine suites. Not run locally on purpose; it is not a check this change could affect. |

GitHub CI (`verify.yml` — the `checks` job and the `engines` job, the latter against real
PostgreSQL, MySQL and SQL Server) runs on every push to this branch. It completed green on
`46f57f9` and `888b03e`. Runs for later commits were superseded by the pushes that followed them,
which is how GitHub handles a newer push on the same branch; the PR shows the head's run. The
`engines` job is where `evidence drift` executes, which is why the local gate skips it.

## 4. QA deployment and provenance

Deployed from `validation-experience` with `scripts/deploy.mjs`, which derives `BUILD_BRANCH` and
`BUILD_COMMIT` from the repository it is about to upload and refuses a dirty tree, a detached HEAD or
a commit absent from the remote.

`/api/settings` reports `validation-experience@e3d38ac5152f`; `/api/health` reports ok. The 24-state
review asserts the deployed commit itself before it captures anything, so a review of the wrong image
fails rather than passing quietly. Migration 0033 applied on start; the deployed reports render the
comparison rules, which only exist in that column.

Production was not touched.

## 5. Deterministic scenarios

All sixteen, through the real engine.

| Scenario                                     | Where                                            |
| -------------------------------------------- | ------------------------------------------------ |
| 1 exact match                                | `tests/integration/validation-scenarios.test.ts` |
| 2 missing target record                      | same                                             |
| 3 unexpected target record                   | same                                             |
| 4 field value mismatch                       | same                                             |
| 5, 6 correct and incorrect transformed value | same                                             |
| 7, 8 duplicate and ambiguous identity        | same                                             |
| 9 missing required relationship              | same                                             |
| 10 wrong parent relationship                 | same                                             |
| 11 null versus empty                         | `tests/unit/validation-value-scenarios.test.ts`  |
| 12 decimal precision and tolerance           | same                                             |
| 13 date and time normalisation               | same                                             |
| 14 excluded field                            | `tests/integration/validation-scenarios.test.ts` |
| 15 comparison that could not run             | same                                             |
| 16 partial / incomplete validation           | same                                             |

Each integration scenario runs in its own workspace, migrates real demo data, then puts the target
into the state under test. Nothing is stubbed and no result is asserted against a fixture.

Count invariants are asserted per dataset: `matched + different + missing = checkedRecords`, with the
run's own findings (`failedInRun`, `unresolvedInRun`) deliberately outside that sum, and findings
counted separately from records.

## 6. Screenshot states

**24 of 24**, at 1440×900 and 1920×1080, against the deployed build. `e2e/validation-states.spec.ts`
names every state it must reach and fails with the ones it did not, rather than counting files — a
count would pass on the wrong twenty-four.

`validation-running` is reached by watching for it while a validation is genuinely still executing.
Nothing in the product was slowed down to widen that window.

## 7. Performance

Measured, not estimated. Wall clock on one developer machine against PGlite, so these are an order of
magnitude rather than a benchmark.

| Measurement                                   | Result                    |
| --------------------------------------------- | ------------------------- |
| 1,000 records migrated end to end             | 7.5 s                     |
| 1,000 records validated, FULL depth           | 241 ms                    |
| One page of 50 findings from 100,000          | 101 ms first, 264 ms last |
| Filtered page and count over 100,000 findings | 66 ms                     |
| CSV of 100,000 findings                       | 6.6 s, 39.6 MB            |

The 100,000-finding set is **query-level evidence**: the rows were written directly, because the
engine caps what it stores per table. The page, the count and the export are read by the same queries
whatever wrote the rows.

## 8. Defects fixed

Seven found by inspecting the code and the semantics:

1. A validation whose comparison could not run reported **Passed with warnings**. `INCOMPLETE` is now
   its own outcome, ranked `PASS < WARNING < INCOMPLETE < FAIL`.
2. A finding said what the comparison saw, not which rule produced it, what it costs, or what to do.
3. The rules a comparison ran under were nowhere on the result.
4. An empty text value was the absence of one everywhere — right in Dataverse, wrong in SQL, where it
   read a column the migration failed to write as correct.
5. A transformation that could not be evaluated was compared against the raw source value, producing
   a mismatch on a record that was probably correct.
6. "The run failed this record" and "validation cannot find this record" were one finding with the
   wrong next action on half of them.
7. Every column claimed a transformation, because `DIRECT` — the default — was listed as one.

Five more found only by reading the deployed build:

8. The review's own states depended on their order: once it migrated regions into QA for the warnings
   state, the run that was supposed to fail passed.
9. A queued validation said `Queued` twice and nothing about what was about to be compared.
10. A pass with warnings did not say why it was a pass — that the differing records were ones the run
    found already in the target and left alone.
11. In the list of columns that were not compared, a reason long enough to wrap put the next column
    name underneath it, so reasons could be read against the wrong column.
12. A run that had been validated showed a banner offering its report and, beneath it,
    "Next action: validate the run against the source" with a primary button that led to the
    validation _list_.

Two further defects were fixed on the way: the finding order had no total tiebreak, so a row could
appear on two pages or on none; and the export's category filter was missing `VALUE_LOST` and
`VALUE_TRUNCATED`, so choosing either on screen and pressing Export returned a validation error.

## 9. Correctness evidence

| Requirement                     | Evidence                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Comparison scope                | the run's identity map; `targetCount` is reported but never assumed to belong to the migration                                        |
| Identity matching               | identity map, primary key, business key or alternate key — recorded on the result, never row order                                    |
| Transformation-aware comparison | the run's immutable snapshot, through the same engine the migration used; an unevaluable rule is not compared                         |
| Relationship integrity          | the source reference is resolved to the record the run should have pointed at; a wrong parent is a `FAIL`                             |
| Null versus empty string        | decided per column from the column's own platform, and printed with the result                                                        |
| Incomplete outcome              | three engine sites, ranked above `WARNING`; the headline names the checks that could not be completed                                 |
| Count reconciliation            | asserted per dataset, with the run's own findings outside the sum                                                                     |
| Record-level findings           | category, severity, dataset, record, field, expected, actual, rule, consequence, next action                                          |
| Evidence export                 | `summary.csv` and streamed `differences.csv` carry the rules and the next action; the evidence package carries `validation-rules.csv` |
| Historical evidence preserved   | nullable columns read back as "not recorded"; migration 0033 backfills nothing, tested three ways                                     |
| Migration-run handoff           | the run page offers the validation, or the report when one exists                                                                     |

## 10. Known limitations

- **No "unexpected record" finding for a migration validation.** The comparison scope is the records
  the run claims, and a shared target holds rows from other sources. An unaccounted row is reported as
  a row-count difference. The dataset-to-dataset comparison answers the stronger question, where the
  scope is both whole tables.
- **No separate validation workspace.** Validation lives where the product's conventions put it: on
  the run it validates, and as the independent comparison for a dataset pair. A fourth top-level
  workspace would be new navigation for the same information.
- **Sampling cannot be demonstrated on the demo data.** Every demo table is smaller than the smallest
  depth cap, so `SAMPLED` coverage is exercised by the volume test rather than by a screenshot.
- **The 100,000-finding evidence is query level**, and labelled as such throughout.
- **`evidence drift` is skipped in the local gate**, by design: it belongs to the CI engines job.

## 11. Remaining blockers

None.

### A note on the review harness

Each of the 24 states now **causes** the condition it reviews rather than waiting for a worked
example to provide one. That was not true when this started, and three separate failures came from
it: a state that depended on what had run before it will certify the wrong thing the first time
somebody adds another. Two states still share a table — the failed state removes a record from
`dtx_applicationconfig` and the unexpected-record state copies one — and both carry a comment saying
so. A reviewer adding a state to that table should read them first.

## 12. Recommended next gate

**Audit experience.** See `docs/AUDIT_READINESS_ASSESSMENT.md`: one P0 — access decisions are not
audited at all — four P1s, five P2s, and five sequenced slices. The audit trail is the next surface a
reader will reach for after a validation report, and it is the one place where a missing record is a
record nobody can reconstruct.
