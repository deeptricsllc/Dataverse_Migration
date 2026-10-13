# Enterprise Data Intelligence

What the Analyze engine now works out about an enterprise export, how each number is arrived at, and
what it still cannot tell you.

|                    |                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Deployed           | `enterprise-data-intelligence@c7f43527effd` on Railway QA                                                                          |
| CI                 | **success** on `c7f43527effd`, both jobs including the engines job where evidence drift runs                                       |
| Local release gate | format, lint, content, typecheck, unit + integration, build all pass; e2e 32/32                                                    |
| Deployed journeys  | the enterprise journey and the certified first-time-user journey, both passing, each asserting the served SHA before anything else |
| Evidence           | `.capture-p2/` — 20 screenshots at 1440×900 and 1920×1080, plus `enterprise-findings.csv`                                          |

---

## 1. Duplicate business-key intelligence

The profiler derives collision arithmetic from the frequency map it already keeps, and records the
first few records holding each repeated value.

Three counts are reported rather than one, because they are easy to confuse and quoting the wrong
one understates the work. For a sixty-row `customer_number` where rows 48–59 reuse the first twelve
numbers:

|                                     |        |
| ----------------------------------- | ------ |
| Records examined                    | 60     |
| Distinct values, excluding blanks   | 48     |
| Values held by more than one record | 12     |
| **Records involved in a collision** | **24** |
| Rows beyond one per value           | 12     |
| Records with no value               | 0      |

Blanks are excluded deliberately. An absent identity is a completeness problem with a different
remedy, and folding blanks into a duplicate count would report one missing customer number as
evidence that customer numbers repeat.

**Expected repetition is not a defect.** Collisions are reported only for a column that identifies
the table it is in. `product_code` in an orders table names a product; ninety orders across twenty
products repeat it seventy times, correctly. The first enterprise fixture flagged two healthy
foreign keys before this rule existed.

Severity is critical when the collision is _why_ the table has no identity, and a warning when some
other column can still match records — the migration can run; the column is a quality problem.

---

## 2. Type and conversion intelligence

The semantic reader decides what a column _means_ from a distinct sample of its values. That is the
right question for "this column holds email addresses" and the wrong one for "how many records will
fail to convert" — a sample counts spellings, a migration converts records.

It is also why `credit_limit`, holding `$1,200.50` in twelve rows and bare numbers in the other
forty-eight, previously read as neither money nor number and produced no finding at all: four fifths
of the sample has to agree before the reader will call a column anything, and this column never
will.

`shared/value-shapes.ts` classifies one value at a time; the profiler tallies the answers per
record. One classifier, shared, so the rule used to count is the rule used to decide.

| Finding                | Fires when                                           | Reports                                                                                             |
| ---------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `MONEY_AS_TEXT`        | any record carries a written amount                  | records, currency marks, decimal conventions, greatest precision, the conversion and scale proposed |
| `MIXED_VALUE_TYPES`    | a column holds two kinds of thing above a floor      | the minority count, with examples of each kind                                                      |
| `INCONSISTENT_BOOLEAN` | three or more spellings of yes                       | the spellings in use                                                                                |
| `NUMERIC_PRECISION`    | records carry more decimals than a target would keep | the count and the greatest precision                                                                |

`MONEY_AS_TEXT` is **critical** rather than a warning when a column uses both a dot and a comma as
the decimal mark. Those amounts are already wrong for half their readers rather than merely awkward
to load: read `1.234,56` with the wrong convention and the amount is out by a factor of a thousand.

Boolean spellings are carried from schema inference, which is the last place they exist — inference
reads `Yes`, `no`, `TRUE` and `y` as one type and hands the profiler four identical booleans.
Understanding the data is not the same as the data being clean.

**Nothing is transformed.** Every recommendation is a proposal with its data-loss risk named.

---

## 3. Relationship discovery

A file export has no foreign keys. The relationships are still there, and a migration that does not
know about them loads children whose parents never arrive.

Each column is compared against the columns of every other table on name agreement, type
compatibility, parent uniqueness and value overlap, and the result is classified:

|            | Means                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| `DECLARED` | the source says these tables are related, and the column evidence agrees |
| `INFERRED` | names, types, uniqueness and coverage all agree, on complete samples     |
| `REVIEW`   | there is evidence and it is not conclusive — shown as a question         |

**An inferred relationship is never presented as a confirmed foreign key.** The distinction is the
feature: acting on a wrong relationship means loading in the wrong order, and a reader who cannot
tell these apart will act on all of them equally.

Orphans are counted in **records**, not values, because "how many records" is the question a broken
reference raises. A column whose distinct values exceed the comparison sample is capped at `REVIEW`
and reports no orphans at all: a value missing from a sample is not a broken reference, and a count
that might be a sampling artefact is worse than no count.

A parent column needs at least two distinct values. A column holding one value is unique by
arithmetic rather than by design, and without that guard a one-row table looks like a perfect parent
that every other table references.

---

## 4. Verified against the fixture

`e2e/enterprise-data-intelligence.spec.ts` builds a workbook whose defects are known by
construction, so every number can be counted by hand. Measured on the deployed build:

| Finding                                       | Reported                          | In the file                               |
| --------------------------------------------- | --------------------------------- | ----------------------------------------- |
| `customer_number` collisions                  | 24 records, 40%                   | rows 48–59 reuse the first twelve numbers |
| `credit_limit` money as text                  | 12 of 60                          | every fifth row                           |
| `price` money as text                         | 20 of 20                          | all rows                                  |
| `active` boolean spellings                    | 4                                 | Yes / no / TRUE / y                       |
| `ordered_on` mixed value types                | 9 of 90                           | every tenth row is not a date             |
| `email` empty                                 | 20 of 60, 33.3%                   | every third row                           |
| `Contacts.product_code` orphans               | 4 records                         | rows 0, 13, 26, 39                        |
| `Orders.product_code → Products`              | INFERRED                          | every value resolves                      |
| `Contacts.product_code → Products`            | REVIEW                            | 83% of values resolve                     |
| `order_number`, `product_code`, `contact_ref` | valid business keys, no deduction | unique and complete                       |

Fourteen findings, two critical, six warnings, six informational. Readiness 84/100.

---

## 5. Scoring

The contract is preserved. Three changes, each documented and tested.

**One deduction per defect.** `Finding.rootCause` groups findings that describe one problem; they
deduct once within their dimension, most severe winning. A colliding business key produces two true
statements — the table has no identifier, and this column repeats across these records — and both
are worth reading. Deducting for both would make one defect cost twice what an unrelated pair costs,
so the score would measure how thoroughly a problem was described. The screen says so:

```
Identity & keys   65
100 − 1 critical × 35 = 65 (one further finding describes the same defect and is not deducted again)
```

**The band counts defects, not findings.** `counts` beside the list stays a count of findings,
because the screen lists findings. The band is a judgement about how much is wrong, and describing
one defect twice does not make the data worse.

**Relationships are assessed when there is something to compare.** Previously the dimension required
a declared dependency, so a file import — which declares nothing — always reported it unassessed
while the relationships sat there waiting to be found. It is now assessed whenever a project holds
more than one table; a single table still reports not assessed, because it has nothing to reference.
This moves the demo project from 72 to 75, and the e2e test asserts that cause rather than only the
new number.

Findings also now state how they reach the score, on the card and in the export. The readiness panel
promised that every deduction traces to a finding you can open; read from the other end that promise
was unverifiable.

---

## 6. Four defects the fixture caught in this phase's own rules

Recorded because they are the reason to build a fixture with known contents rather than to test
against clean data.

- `product_code` in Orders and Contacts was reported as a duplicate-key violation. It is a foreign
  key, repeating correctly. Fixed by reporting collisions only for columns that identify their own
  table.
- `credit_limit` was reported as money-as-text _and_ as "more than one kind of value" — one defect,
  two deductions.
- `price` was reported by the new rule _and_ by the pre-existing `CURRENCY_AS_TEXT`. The new one says
  everything the old one says plus record counts, notation and proposed scale, so it supersedes it.
- Boolean spellings were invisible, for the reason described in §2.

A fifth was caught before it shipped: the first currency-notation signature folded in whether an
amount was grouped, so `$1,200.50` and `$9.99` counted as two notations and any currency column
holding amounts above and below a thousand reported itself as inconsistent.

---

## 7. Limitations

- **Live connectors remain simulated.** Azure SQL, SharePoint, OneDrive and Dataverse are labelled
  `SIMULATED` in the product and QA runs in `DEMO MODE`. Nothing here is evidence about a live
  tenant. File import — CSV, Excel, XML — is certified against real file content.
- **Relationship coverage uses a bounded sample** of 1,000 distinct values per column. Beyond that
  the edge is capped at `REVIEW` and orphans are not reported.
- **Declared relationships are table-level.** The analysis record carries which tables depend on
  which, not through which column, so a declaration raises confidence while the column evidence
  still comes from the data.
- **Secured columns are excluded from relationship discovery.** Masking collapses every value to one
  string, which would make any two secured columns look perfectly related.
- **Currency conversion is proposed, never performed**, and a column mixing two currencies is
  reported rather than reconciled.
- **The own-key heuristic is a name test.** A genuinely duplicated key whose name mentions neither
  its table nor a generic identifier would go unreported. It is used only to suppress, so the worst
  case is silence rather than a false claim.

---

## 8. Verdict

The three capabilities are real, deployed, and independently checkable against a fixture whose
contents are known. The certified file-based Analyze journey is preserved and still passes on the
same build.

**Ready for internal use on file-based data.** Not partner-demo-ready, for the reason it was not
before: everything except file import is simulated, and this phase did not change that.

One caveat worth stating plainly. Four of the defects above were in rules written during this phase
and were found by the fixture rather than by me. That is the fixture working, and it is also an
argument for a reviewer: this pull request, like the two before it, has no independent review.
