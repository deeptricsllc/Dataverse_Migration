# Five scenarios, reconciled by hand

Every number below was read from **deployed QA** (`dataverse-migration-app-qa.up.railway.app`,
`DEMO_MODE=true`, `REAL_TENANT_READ_ONLY=true`) by driving the same API the interface uses, and checked
with arithmetic rather than by an assertion. That is the point: the two worst bugs this product has had
— a report claiming 70 things happened to 67 records, and a verdict that passed over nothing — were
both found this way and neither was caught by a green test suite.

Each scenario answers the same nine questions.

---

## A — A clean successful migration

The curated _Customer Migration — Successful_ project, rebuilt by the demo reset, which runs a real
migration through the real engine.

**DeepTrics Development → DeepTrics UAT**, four tables, validated at STANDARD depth.

|                               |                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **What did we expect?**       | 441 records: 6 regions, 120 accounts, 300 contacts, 15 offices                                              |
| **What did we process?**      | 441                                                                                                         |
| **What did we write?**        | 441, all created                                                                                            |
| **What did we not write?**    | Nothing                                                                                                     |
| **What failed?**              | Nothing                                                                                                     |
| **What exists in target?**    | 441, matching the source counts table by table                                                              |
| **What did we validate?**     | All 441, coverage FULL on every table                                                                       |
| **What did we NOT validate?** | Nothing at record level. Schema differences are reported separately, and aggregate totals are supplementary |
| **Why is the verdict PASS?**  | Every check passed on every table, over every record                                                        |

```
created 441 + updated 0 + unchanged 0 + skipped 0 + failed 0 = 441 = processed   ✓
writtenByRun = 441 + 0 = 441                                                     ✓
per table: 6 + 120 + 300 + 15 = 441                                              ✓
account:    checked 120  matched 120 + missing 0 + different 0 = 120              ✓
contact:    checked 300  matched 300 + missing 0 + different 0 = 300              ✓
dtx_office: checked  15  matched  15 + missing 0 + different 0 =  15              ✓
dtx_region: checked   6  matched   6 + missing 0 + different 0 =   6              ✓
coverage:   eligible 441, examined 441, FULL                                     ✓
```

**The aggregate line worth reading**, from `account`:

```
SUM(revenue)  source 30024889.949999999985   target 30024889.95
              PASS — "The two sides report the same value.
                      Compared to 2 decimal place(s), which is all this column holds."
```

That is the Money(2) bug from earlier in the phase, fixed, and reported with the reason attached. The
same table also reconciled `SUM/MIN/MAX(numberofemployees)` and `MIN/MAX(revenue)` — seven totals, each
carrying the caveat that totals agreeing does not prove the records agree.

---

## B — A migration with failures

The curated _Customer Migration — Data Quality Issues_ project. **Legacy SQL Server (Demo) → DeepTrics
QA**, a target that already holds records, with source data built to fail in specific ways.

|                               |                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What did we expect?**       | 70 records: 4 regions, 26 customers, 40 contacts                                                                                                                                                  |
| **What did we process?**      | 70                                                                                                                                                                                                |
| **What did we write?**        | 65 — 2 regions, 23 customers, 40 contacts                                                                                                                                                         |
| **What did we not write?**    | 5: 2 skipped (already in the target, left alone by the conflict rules) and 3 failed                                                                                                               |
| **What failed?**              | 3 customers. One shares a business key with another source record, which the engine refuses to guess at rather than overwrite                                                                     |
| **What exists in target?**    | 4 regions, 38 customers (26 − 3 failed + 15 that were already there), 40 contacts                                                                                                                 |
| **What did we validate?**     | 67 records — everything except the 3 that were never written                                                                                                                                      |
| **What did we NOT validate?** | The 3 failed records: there is nothing in the target to compare them against. Aggregate totals were NOT VERIFIED for all three tables, because the simulated SQL connector cannot compute a total |
| **Why is the verdict FAIL?**  | 3 records the run accounted for are not in the target. A migration that did not deliver three records has not passed, whatever the reason                                                         |

```
created 65 + updated 0 + unchanged 0 + skipped 2 + failed 3 = 70 = processed      ✓
per table created: 2 + 23 + 40 = 65                                              ✓
eligible 67 = 70 processed − 3 failed                                            ✓
matched 66 + missing 0 + different 1 = 67 = examined                             ✓
dbo.Customer: checked 23 = 26 − 3 failed                                         ✓
              matched 23 + missing 0 + different 0 = 23                          ✓
              RECORD_EXISTENCE FAIL: "3 record(s) are not in the target
                                      — 3 the run reported as failed"
config.Region: RECORD_EXISTENCE PASS, with the composition stated:
               "(2 written by this run, 2 already in the target)"
```

This is the arithmetic that was once wrong. `missing` (validation's own finding) and `failedInRun` (the
run's finding, confirmed) are counted separately so the sums work, and both still fail the check so the
verdict stays honest.

---

## C — A resumed migration

**Development → UAT**, `product`, batch size 2, cancelled after about one second and then retried.

|                                 |                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What did we expect?**         | 40 products                                                                                                                                          |
| **First attempt**               | Cancelled with 8 processed, 8 created, 8 identity rows claimed — four whole batches                                                                  |
| **Failure boundary**            | Between batches. The identity map held exactly the records the target held: 8 and 8                                                                  |
| **Resume**                      | Retried as attempt 2 of the same run. Finished with 40 processed, 40 created                                                                         |
| **What did we write?**          | 40 — the 8 from attempt one plus 32 from attempt two. The 8 were not written again                                                                   |
| **What failed?**                | Nothing                                                                                                                                              |
| **What exists in target?**      | 40 products, one per source record                                                                                                                   |
| **What did we validate?**       | All 40 at FULL depth                                                                                                                                 |
| **What did we NOT validate?**   | One schema difference is reported rather than compared: `dtx_warrantymonths` is text in the source and a number in the target, by design in the demo |
| **Why is the verdict WARNING?** | That schema difference. Every record check passed                                                                                                    |

```
attempt 1: processed 8   created 8   identity rows 8                             ✓
attempt 2: processed 40  created 40  failed 0  attempt counter = 2               ✓
created is the RUN's figure, cumulative across attempts: 8 + 32 = 40             ✓
records.csv after resume: exactly 40 lineage rows — no record created twice      ✓
target 40 = source 40                                                           ✓
AGGREGATES PASS: COUNT 40=40, SUM(price) 97093.49 both sides,
                 MIN 127.64, MAX 4810.15
```

The run-versus-attempt semantics are visible here: one run, two attempts, one set of cumulative
figures. See `docs/RESUME_SEMANTICS.md`, including the P0 boundary this scenario does **not** exercise —
a clean cancel between batches is the benign case.

---

## D — Duplicates

Covered by scenario B's source data, which contains two customers sharing a customer number.

|                                       |                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What did we expect?**               | A duplicate business key in the source                                                                                                                                                      |
| **What happened?**                    | The engine refused it. `DUPLICATE_SOURCE_KEY`: "Source record X already migrates into this target record; two source records cannot both own it". It is one of the 3 failures in scenario B |
| **What exists in target?**            | One record for that key, not two                                                                                                                                                            |
| **What did the duplicate check say?** | `FIELD_VALUES PASS: No repeated values of accountnumber in the target`                                                                                                                      |
| **Attribution**                       | Not exercised: there were no duplicates in the target to attribute                                                                                                                          |

**So on deployed QA the demo demonstrates duplicate _prevention_, not duplicate _detection_.** That is
correct behaviour — a migration that guessed which of two records owned a target would be worse than one
that refused — but it means the attribution logic is not visible to an evaluator. Attribution is proven
instead by `tests/integration/duplicate-detection.test.ts` and against real PostgreSQL, MySQL and SQL
Server in the conformance suite, which cover: a repeated key found by the database, this run's records
attributed to it, and `NOT VERIFIED` rather than PASS where a connector cannot look.

**A finding from reading this closely.** When a table has no business key configured, the duplicate check
groups on the primary identifier — which is unique by construction, so it can never find anything. The
message is literally true and names the column (`No repeated values of accountid in the target`), but a
reader skimming for "no duplicates" will take more from it than it says. Recorded as P1 below.

---

## E — Sampled validation

The demo's own tables are all smaller than the smallest depth cap of 500 records, so sampling cannot be
demonstrated with them. This uses the path a customer would: a **1,200-row CSV uploaded** through the
real import, mapped to `product`, migrated into UAT, then validated three times at three depths.

|                                   |                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **What did we expect?**           | 1,200 rows                                                                                            |
| **What did we process?**          | 1,200                                                                                                 |
| **What did we write?**            | 1,200 created, 0 failed                                                                               |
| **What exists in target?**        | 1,200                                                                                                 |
| **What did we validate?**         | Depends on the depth, and the report says which                                                       |
| **Why are the verdicts WARNING?** | 17 schema differences between a 4-column CSV and a Dataverse product table. Every record check passed |

```
QUICK      mode SAMPLED   eligible 1,200   examined   500   41.7%
           "500 of 1,200 records this run accounted for examined (41.7%)."
           "No differences found in the 500 records on 3 mapped column(s) examined, of 1,200."

STANDARD   mode FULL      eligible 1,200   examined 1,200
           "All 1,200 records this run accounted for were examined."

FULL       mode FULL      eligible 1,200   examined 1,200
```

Sampling strategy, stated in the report: _"The first records in source-identifier order, so the same
depth examines the same records every time."_ Deterministic, and explicitly **not** a random sample — the
report never claims the 500 speak for the other 700.

**Confirmed: nothing in the product implies full validation over a sample.** The percentage is shown, the
eligible count is shown beside the examined count, and the passing message says "of 1,200" rather than
"all records".

Getting this scenario to run found four defects, all now fixed and all described in the final report:
an upload's columns could not be mapped, its key column could not be mapped, its key column's value was
dropped on read, and — the serious one — a validation that compared nothing reported
`PASS: Not verified — No records were examined. Every one of them is in the target.`

---

## The evidence package, verified on deployed QA

For scenario A's run, downloaded and then checked by the deployed verifier:

```
verdict            VALID
files checked      9
problems           none
schema version     2
lineage            1 chunk, 6 rows declared, 6 counted, 0 rows without a target
readiness.json     present and vouched for by the manifest
```

`proves` and `doesNotProve` travel with the verdict, in the words the evidence supports: the files are
internally consistent with their manifest, and nothing is signed.

---

## What this exercise cost, and why it was worth it

Five scenarios, four defects found, three of them in a path the product advertises and one of them a
green badge over an empty verdict. None of the four was caught by 757 passing tests, because every one
of them lived in the gap between what a component returns and what the next component assumes about it.

The two previous worst bugs in this product were found the same way. That is now three for three, and the
recommendation is to keep doing it: a hand reconciliation of the deployed product, every phase, with the
arithmetic written out.
