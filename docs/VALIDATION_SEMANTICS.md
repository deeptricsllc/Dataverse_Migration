# Validation semantics

What a validation result means, and what evidence stands behind it.

The migration engine proves what it attempted. The validation engine has to prove what actually matches
the expected result, which is a different claim and a harder one. This document is the specification for
that claim; where the code and this document disagree, the code is wrong.

Written before the change it describes, because the change is to the meaning of the word a migration
engineer reads when they decide whether to sign a cutover off.

## 1. The defect this exists because of

A validation whose field comparison could not run at all reported:

```
Passed with warnings
```

The engine was honest everywhere underneath. Coverage was recorded as `NOT_VERIFIED`, the check carried
the reason, and the report printed both. But the outcome model had three values — `PASS`, `WARNING`,
`FAIL` — so "we could not check" had nowhere to go except `WARNING`, and `WARNING` is displayed as
_Passed with warnings_.

Somebody reading the headline sees the word **passed** on a validation that checked nothing.

This is the same defect the migration gate was called on, one system over: a model with too few states,
so the evidence gets rounded towards the good news. It is not fixed by renaming `WARNING`. It is fixed by
giving "could not be completed" its own outcome.

## 2. Outcomes

| Outcome      | When                                                        | What it tells the reader                                                                                                   |
| ------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PASS`       | Every required comparison ran and agreed                    | The target holds what the migration should have produced, to the stated coverage.                                          |
| `WARNING`    | Every required comparison ran; non-blocking findings remain | It agrees, and something is worth knowing — a pre-existing difference, a supplementary total that could not be reconciled. |
| `INCOMPLETE` | A required comparison could not be completed                | Nothing is known to be wrong. Something was not checked, and the report says which.                                        |
| `FAIL`       | A required comparison ran and disagreed                     | Records are missing, values differ, or references point at the wrong record.                                               |

`RUNNING` is a **status**, not an outcome. The two are separate columns because a validation that crashed
has `status = FAILED` and no outcome at all, and a validation that completed and found failures has
`status = COMPLETED, outcome = FAIL`. Collapsing them would make "the comparison could not run" and "the
comparison ran and the data is wrong" the same sentence.

### 2.1 Which outcome wins

Worst wins, ranked:

```
PASS  <  WARNING  <  INCOMPLETE  <  FAIL
```

`INCOMPLETE` outranks `WARNING` because not knowing is worse than knowing something minor.

`FAIL` outranks `INCOMPLETE`, which is the one ordering worth arguing about. A proven mismatch is
actionable and definite; an unchecked area is neither. A reader whose validation has both needs the
headline that says there is something to fix, and the unchecked part stays visible on the check that
could not run. The alternative — ranking "unknown" above "known wrong" — would hide a real failure behind
a limitation.

## 3. What makes a validation incomplete

Only these. Each is a recorded fact, not an inference.

| Condition                             | Evidence                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field comparison did not run          | `coverage.mode === 'NOT_VERIFIED'`, or `checkedRecords === 0` with records to compare                                                                         |
| The run could not account for records | `unresolvedInRun > 0` — a record whose write outcome is unknown may or may not be in the target, so it is excluded from the comparison rather than guessed at |
| A required check could not run        | the check records `NOT_VERIFIED`                                                                                                                              |

A **sampled** comparison is not incomplete. It ran, on a declared subset, and the report says how many
records and how they were chosen. That is a bounded claim, not an absent one.

A **supplementary** check that could not run is not incomplete either. Aggregate totals are corroboration:
totals agreeing does not prove the records agree, so totals being unavailable does not mean the records
were not compared. Those record `NOT_VERIFIED` and contribute a warning.

## 4. Counts, and how they reconcile

Per dataset, every record the validation examined is in exactly one of:

```
matched + different + missing  =  checkedRecords
```

Three numbers sit outside that sum on purpose, and each is reported separately:

- **`failedInRun`** — records the migration itself reported as failed. They are not in the target, so
  there is nothing to compare. Counting them as `missing` would make validation's finding and the run's
  finding the same number twice.
- **`unresolvedInRun`** — records the run could not account for. Excluded from the comparison because
  comparing them would report "missing" for something possibly present, or "matched" for something nobody
  can account for.
- **`targetCount`** — everything in the target table, which is not the same as everything this migration
  put there. A shared target holds records from other sources, from earlier migrations, and from people
  working in the system. The comparison scope is the records this migration claims, and row counts are
  only compared as equals where the migration owns the whole target table.

`different` counts **records**, not field differences. One record with four wrong columns is one
different record and four findings. The two are labelled separately wherever both appear.

### 4.1 Unexpected target records

A target row this migration cannot account for is reported as a **row-count difference**, not as a
finding against the migration. The comparison scope is the records this run claims, and a shared
target holds rows from other sources, from earlier runs, and from people working in the system.
Reporting every unaccounted row as this migration's problem would make a correct migration into a
shared table read as a failure.

Where the stronger question is the one being asked — is there anything in the target that is not in
the source at all — the dataset-to-dataset comparison answers it, because there the scope is both
whole tables and `ONLY_IN_RIGHT` is a finding with a count. A migration validation says what it can
defend and points at the tool that can defend the rest.

## 5. Identity

Records are matched by the identity the migration used, read from the run: the preserved primary key, a
configured alternate or business key, or the identity map the run wrote. Never by row order.

Where identity is not single-valued the comparison says so rather than choosing:

- **Duplicate identity** — more than one target record carries the key. Reported, with the occurrence
  count, and never resolved by picking one.
- **Not verified** — this connector cannot group on the key, or no business key is configured. The
  duplicate check records its own coverage separately from the record coverage, because it can be
  unverified while the values pass.
- **Which key was grouped on** is recorded. A scan over a primary key the target enforces by itself
  proves nothing about whether the same real-world record arrived twice, and a report that did not say
  which key it used would let the stronger claim be read into the weaker evidence.

## 6. Transformation-aware comparison

Validation compares the target against the **expected transformed value**, not the raw source value,
using the mapping pipeline exactly as the run executed it — read from the run's own immutable snapshot,
not from the plan as it stands now.

A source of `" ACTIVE "` trimmed and value-mapped to `100000000` matches a target of `100000000`.
Comparing the raw value would report a false mismatch on every transformed column in the migration.

Where the transformation cannot be evaluated, the comparison does not fall back to the raw value and call
the result a mismatch: the column is recorded as not compared, with the reason.

## 6.1 Normalisation, and what is allowed to be one

A comparison may normalise a difference away only for a reason a reader can find: a configured rule,
or a platform semantic recorded in `docs/SEMANTIC_EQUALITY.md`. Convenience is not a reason. Each
report prints the normalisations it ran under, next to the result rather than next to the plan.

The one that was wrong is **an empty text value against no value at all**. It was treated as the same
value everywhere, which is right in a Dataverse target — the platform stores one as the other, so
nothing can tell them apart — and wrong in a SQL target and in a file, where they are two values. A
column the migration failed to write read as correct. The rule is now decided per column, from the
column's own platform, and printed with the result.

## 7. Relationships

A lookup is compared by resolving the source reference to the target record the migration should have
pointed at, then comparing that to the reference the target actually holds. A record that exists with the
wrong parent is a `LOOKUP_MISMATCH`, not a pass.

Source references the migration could not resolve are not re-reported here — the run already recorded
them — so validation reports the references that resolved and went to the wrong place.

## 8. Columns that cannot be compared

Neither equal nor different, and said so. A JSON document that repeats a key, or a binary value past the
size this platform will read, is genuinely unknown.

The limitation is recorded against the **column**, with the reason and the number of records affected,
and the record is still compared on everything else. Counting such a record as matched would be a silent
false pass; counting it as different would report a problem nobody has shown; discarding the record would
throw away what is known about its other twenty columns.

## 9. Pre-existing differences

A record the migration deliberately skipped, because the target already held a matching record, is
compared — but a difference found in it is a `PRE_EXISTING_DIFFERENCE` and a warning, not a failure. The
migration did not write that record and is not answerable for its contents.

## 9.1 The rules are part of the result

Every dataset result carries the rules its comparison ran under: the identity it paired on, every
column pair it compared, every source column it did not and why, the normalisations, the numeric
tolerance, the date and time handling, and how references were matched.

Written from the run's immutable snapshot at the moment the comparison ran — not rendered from the
plan when somebody opens the report. A report is read when somebody asks what was compared, which is
usually after the plan has been edited, and today's rules beside an older finding answer a different
question than the one being asked.

Excluded columns are listed **by name**. A count invites the reader to assume the rest did not
matter, and a comparison that quietly left out the one column somebody cares about otherwise reads
exactly like one that compared everything.

Reports written before the rules were recorded say `Comparison rules not recorded`. They are not
backfilled; see §10.

## 9.15 Which finding is which

Two records are not in the target for two different reasons, and they are two findings:

- **`RECORD_FAILED_IN_RUN`** — the run reported the record as failed and the comparison confirms it is
  absent. The run already explained why. The reader's next step is the run's failure list.
- **`MISSING_IN_TARGET`** — the run recorded a target record for it, and no record with that identity
  is in the target now. Nobody has explained that yet, and the run's failure list will not mention it.

They were one category, so a reader filtering for missing records got both kinds mixed with the wrong
next action on half of them — while the counts beside them, `failedInRun` and `missing`, had kept the
two apart since the run gate.

## 9.2 A finding says what to do about it

Every finding carries, besides the values: its category, its severity, the dataset, the record
identity, the field, the **rule** that produced it, the **consequence**, and the **next action**.

Those last three come from one table keyed on the category the engine recorded — never from parsing
the message the engine wrote, which would be a second source of truth that breaks whenever somebody
improves the wording. The screen and the CSV read the same table, so the action a reader is given on
screen is the action in the evidence they attach to a change record.

The left-hand value is labelled **Expected**, not _Source_. On a value comparison it is the source
value after the transformations the run applied, and calling it the source invites a reader to check
it against the source system by hand and find a difference that is correct.

## 9.3 Findings are read a page at a time

Filtering, counting and ordering happen in the database. The order is `(table, record, column,
identifier)` — the first three are the order a reader wants, and the identifier last makes the order
total. Without it, rows that tied could come back in a different order on each query, so a finding
could appear on two pages or on none.

## 10. Evidence integrity

A validation result describes one comparison execution. Nothing recomputes it afterwards.

Changing a mapping, a transformation rule, the source data or the target data does not alter an existing
report, and must not: the report is the evidence that a comparison was run at a point in time and what it
found. A new comparison produces a new execution with its own evidence.

Reports produced before a field existed read `Not recorded` for it. They are not backfilled, because a
value nobody recorded is not a value, and the one place that matters most is the report somebody signed.

## 11. The rule, in one sentence

> A validation reports the worst outcome its own recorded evidence supports, and never reports a
> comparison that did not happen as one that passed.
