# The Golden Journeys

Seven connected workflows that have to work, every release. They live in `tests/golden/` and run in the
ordinary `npm test`, so they are gates rather than something to remember.

## Why they exist

Every phase of this project repeated the same pattern: hundreds of green tests, and a workflow broken
end to end. The file-migration chain was **five** separate bugs, each in code that had passing tests,
and the chain was what nobody ran. A unit test proves a function. A journey proves that the product
does the thing a customer bought it for.

## The two rules

**Verify the target independently.** Every journey counts the rows in the target directly, through
`targetRows` in `tests/golden/journey.ts`, not through the counters the engine wrote or the report the
product produced. A migration that duplicated every record can report perfect numbers; only counting
the target catches it. Where a journey asserts a number the product calculated, it also asserts the
thing that number is about.

**Do not assert UI text.** These run at the API and database level. The screens have their own coverage
in `e2e/`. A journey that broke when a label changed would be deleted within a month.

## The seven

| Journey                             | What it proves                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** — clean migration             | Source → target → validation → evidence, with the target counted, every identifier checked for repeats, and every target id in the lineage checked to be a record that exists          |
| **B** — data the target will refuse | A value too long for the column: named by readiness **before** the run, the record refused rather than quietly shortened, reported absent by validation, and listed by name afterwards |
| **C** — interrupted, then resumed   | A fatal failure injected mid-batch, then a resume: nothing written twice, every record accounted for exactly once, every write state settled, validation at full coverage              |
| **D** — a target that holds data    | All four outcomes, each caused deliberately, with the target counted after every one                                                                                                   |
| **E** — above the sampling cap      | `SAMPLED`, with eligible, examined and strategy — and no sentence that claims more than was read. Then `FULL` over the same data, so the claim gets stronger                           |
| **F** — duplicates that matter      | Prevention on a business key nothing enforces, and detection of a duplicate that arrived by another route, attributed to the run that wrote one of the pair                            |
| **G** — a spreadsheet into a table  | Upload → mapping → migration → validation, checking the **values** that arrived and refusing a pass that examined nothing                                                              |

## What writing them found

Each of these was a real defect or a real misunderstanding, found by the journey and not by the suite
that already existed.

- **The write state was invisible outside the evidence package.** Journey A read the lineage export and
  found that the three columns the crash-consistency work added — write state, recovery evidence,
  recovery note — were in the evidence ZIP and nowhere else. The export a person downloads from a run,
  and the record list the run page reads, carried none of them. A run could say "4 records unresolved"
  and offer no way to learn which four.
- **`[object Object]` in a customer-facing finding.** Journey B asserts that no readiness finding prints
  an object or the word `undefined`. It immediately caught `CONNECTOR_NOT_ENGINE_VERIFIED` interpolating
  a label record instead of its `.label`.
- **`UPSERT`'s update count is not evidence that anything changed.** Journey D was written assuming the
  four outcomes were reachable by running the same plan repeatedly. They are not: the conflict strategy
  decides which outcome a matched record gets, and the three that admit an existing record mean three
  different amounts of work — `SKIP_EXISTING` leaves it alone without comparing, `UPSERT` writes it
  without comparing, and only `SYNC` compares. The journey asserts the distinction, because a test that
  treated them as interchangeable would be asserting that the option does nothing.

## Running them

```bash
npx vitest run tests/golden            # all seven, about a minute
npx vitest run tests/golden/c-resume-after-crash.test.ts
```

They use the simulated environments, so they need no credentials and no network. That is also their
limit: they prove the product's own logic end to end, not a real Dataverse or a real SQL Server. The
real-engine suites in `tests/engines/` cover that, and `docs/VERIFICATION.md` says which claims rest on
which.
