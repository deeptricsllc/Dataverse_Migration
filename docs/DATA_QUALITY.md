# Data quality

**What this covers:** where the platform's quality rules come from, what each finding means, how many
records it really affects, and what to do about each one.
**Written for:** the migration lead who has to get the source data fixed before the cutover.

Implementation: `server/src/services/data-quality-service.ts`, with the rule evaluator in
`server/src/services/profiling-service.ts` (`deriveTargetRules`, `evaluateRules`).

---

## 1. The rules come from the target

This is not a general data-quality product, and it is not an opinion about tidy data. A finding exists
because **the target system would refuse the value**. `deriveTargetRules` reads the target column each
source column is actually mapped to and states the rule against the source field:

| Target column property                                      | Rule produced   | Severity | Meaning                                                  |
| ----------------------------------------------------------- | --------------- | -------- | -------------------------------------------------------- |
| `requiredLevel` is `ApplicationRequired` / `SystemRequired` | `REQUIRED`      | BLOCKER  | The target rejects an empty value                        |
| `String`/`Memo` with `maxLength > 0`                        | `MAX_LENGTH`    | BLOCKER  | The target rejects anything longer                       |
| `minValue` or `maxValue` set                                | `NUMERIC_RANGE` | BLOCKER  | The target rejects values outside the range              |
| `format` is `Email`                                         | `VALID_EMAIL`   | WARNING  | The target expects an address; it will accept other text |

Only mapped columns produce rules — `DataQualityService` filters to mappings whose status is
`AUTO_MAPPED` or `MANUAL` and which have a target field. Change a mapping and the rules change with
it; there is no separate rule set to keep in sync.

So "428 missing required values" means "428 records the target would refuse", which is a number worth
spending a week of someone's time on. It is not "428 records look empty to us".

`DataQualityRuleDto.origin` distinguishes `TARGET_SCHEMA`, `MAPPING` and `USER`. **Today every rule the
platform produces has `origin: 'TARGET_SCHEMA'`.** The evaluator supports more kinds than the derivation
emits, and there is no endpoint yet for adding a rule by hand — see §9.

The rules a table implies are readable at
`GET /api/plans/:id/entities/:entityId/quality-rules`.

---

## 2. Rule kinds

| Kind             | Parameters   | A record fails when                                                                                               | How it is counted                                           |
| ---------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `REQUIRED`       | —            | The value is null, or a string that is empty after trimming                                                       | `nullCount + blankCount`                                    |
| `NOT_BLANK`      | —            | The value is present but trims to empty                                                                           | `blankCount`                                                |
| `MAX_LENGTH`     | `max`        | The untrimmed value is longer than `max` characters                                                               | Per record, while streaming                                 |
| `MIN_LENGTH`     | `min`        | A non-blank value is shorter than `min`                                                                           | Per record, while streaming                                 |
| `VALID_EMAIL`    | —            | A non-blank value does not look like `local@domain.tld`                                                           | Per record, while streaming                                 |
| `VALID_PHONE`    | —            | A non-blank value is not digits and phone punctuation, 5+ characters                                              | Per record, while streaming                                 |
| `NUMERIC_RANGE`  | `min`, `max` | A numeric value falls outside the range. Non-numbers are not range failures — they are counted as invalid values  | Per record, while streaming                                 |
| `DATE_RANGE`     | `min`, `max` | A parseable date falls outside the range                                                                          | Per record, while streaming                                 |
| `ALLOWED_VALUES` | `values[]`   | A non-blank trimmed value is not in the list                                                                      | Per record, while streaming                                 |
| `REGEX_PATTERN`  | `pattern`    | A non-blank value does not match. A pattern over 200 characters, or one that will not compile, is never evaluated | Per record, while streaming                                 |
| `UNIQUE`         | —            | The column repeats a value                                                                                        | From `duplicateCount`; skipped entirely when that is `null` |

Severity is per rule (`BLOCKER` or `WARNING`) and is carried onto every issue the rule produces.

---

## 3. The worked example: `account.name`

A legacy `dbo.Customer.CustomerName` is mapped to Dataverse `account.name`. That target column is
`ApplicationRequired` and `maxLength: 160`, so profiling the source runs with two derived rules:

```json
[
  { "kind": "REQUIRED", "field": "CustomerName", "origin": "TARGET_SCHEMA", "severity": "BLOCKER" },
  {
    "kind": "MAX_LENGTH",
    "field": "CustomerName",
    "max": 160,
    "origin": "TARGET_SCHEMA",
    "severity": "BLOCKER"
  }
]
```

The profile comes back with, among others:

> **38 records exceed the target limit of 160 characters (longest 204).**
> _Shorten the source values or add a TRUNCATE transformation to 160 characters, accepting the loss._

**Why 38 is exact rather than inferred.** Summary statistics cannot answer "how many values are longer
than 160 characters". They can only answer "the longest is 204". So the rules are handed **into**
profiling: as each record streams past, `FieldAccumulator.checkRules` evaluates every rule against that
one value and increments a per-rule counter, keeping up to 5 offending records as samples. The count is
a tally of records, not a deduction from a maximum — which is what makes it something you can put in a
remediation plan and give to a data owner.

If profiling runs **without** the rules (a bare table profile), the evaluator says so rather than
inventing a number:

> At least one value exceeds the target limit of 160 characters (longest 204); the exact number was not
> counted.

That issue carries `affected: 0`, and its resolution tells you to re-run profiling with the rule.

**The word "record" tells you the basis.** When the profile's basis is `EXACT` the message says
"38 records"; when it is `SAMPLED` it says "38 examined records". Every issue also carries
`basis` explicitly. A count taken from a sample must never read as a total — see
[DATA_PROFILING.md](DATA_PROFILING.md), §2.

---

## 4. From a finding to a blocked record

Data quality and preflight are two passes over the same truth, and they use the same words for it.

| Pass      | What it does                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| Profiling | Streams the **raw source values**, counts rule violations, produces `DataQualityIssueDto`                      |
| Preflight | Runs each record through the transformation engine and classifies it CREATE / UPDATE / UNCHANGED / **BLOCKED** |

A record becomes BLOCKED when `transformField` returns an error for any mapped field:
`record-planner.ts` stores `blocked = { code, reason }` and stops that record. The codes line up with
the quality issue codes on purpose — a `REQUIRED_VALUE_MISSING` BLOCKER in the dashboard is a
prediction that those records will come back BLOCKED with `REQUIRED_VALUE_MISSING` at preflight.

The integration test walks exactly this: one legacy customer's name is `'   '`, `account.name` is
required, and after the configured `TRIM` the value is empty — so the preflight's BLOCKED list contains
a record with `reasonCode: 'REQUIRED_VALUE_MISSING'`, and nothing is written.

The two passes are not identical, and the difference is worth holding in mind:

- **Profiling sees the source as it is; preflight sees it after the pipeline.** Add a `TRUNCATE(160)`
  rule and the preflight stops blocking those 38 records — but the profile still reports them, because
  it is measuring the source, not the plan. That is the honest reading: the data is still too long, you
  have chosen to cut it.
- The reverse also happens: a transformation can **create** a violation the profile did not see, such as
  a `TRIM` that turns `'   '` into an empty value for a required column.

Preflight is therefore the authority on what will happen; profiling is the authority on what is in the
source.

---

## 5. Issue codes

Produced by `evaluateRules`, per field:

| Code                     | Meaning                                                            | Severity source |
| ------------------------ | ------------------------------------------------------------------ | --------------- |
| `REQUIRED_VALUE_MISSING` | No value for a column the target requires                          | Rule            |
| `BLANK_VALUE`            | A present-but-blank value where one is expected                    | Rule            |
| `STRING_TOO_LONG`        | Longer than the target column accepts                              | Rule            |
| `STRING_TOO_SHORT`       | Shorter than a configured minimum                                  | Rule            |
| `INVALID_EMAIL`          | Not a valid email address, in a column the target formats as email | Rule            |
| `INVALID_PHONE`          | Not a recognisable phone number                                    | Rule            |
| `VALUE_OUT_OF_RANGE`     | Outside the target column's numeric range                          | Rule            |
| `DATE_OUT_OF_RANGE`      | Outside the accepted date range                                    | Rule            |
| `VALUE_NOT_ALLOWED`      | Not one of the values the target accepts                           | Rule            |
| `PATTERN_MISMATCH`       | Does not match a configured pattern                                | Rule            |
| `DUPLICATE_KEY`          | Repeats a value that must be unique in the target                  | Rule            |

Produced per table, regardless of rules:

| Code                  | Severity | Meaning                                                                     |
| --------------------- | -------- | --------------------------------------------------------------------------- |
| `PRIMARY_KEY_MISSING` | BLOCKER  | Records with no primary key. They cannot be matched, resumed or rolled back |
| `DUPLICATE_KEY`       | WARNING  | Records repeating a primary key already seen in this pass                   |

Every issue carries `field`, `affected`, `basis`, a `resolution` sentence and up to five `samples` of
`{ recordId, value }` — masked to `***` when the column is secured, so the counts are usable and the
values never leave.

---

## 6. The dashboard summary

`POST /api/plans/:id/data-quality` profiles every table in the plan and rolls the findings up
(`DataQualitySummaryDto`):

| Field                  | What it holds                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `tablesAnalyzed`       | Tables successfully profiled. A table that failed is logged and skipped, not fatal              |
| `recordsProfiled`      | Sum of `examined` across those tables                                                           |
| `basis`                | `EXACT` only if **every** table was EXACT — a summary must not look more certain than its parts |
| `blockers`, `warnings` | Total affected records, by severity                                                             |
| `categories[]`         | `{ code, label, severity, count }`, biggest first                                               |
| `tables[]`             | Per table: blocker and warning totals                                                           |
| `profiledAt`           | When the pass ran                                                                               |

A category is one issue code across the whole plan. Its `count` sums `affected`, and its severity is
that of its **most severe** finding. Codes are given readable labels:

| Code                     | Label                           |
| ------------------------ | ------------------------------- |
| `REQUIRED_VALUE_MISSING` | Missing required values         |
| `STRING_TOO_LONG`        | Strings too long                |
| `INVALID_DATE`           | Invalid dates                   |
| `INVALID_NUMBER`         | Invalid numbers                 |
| `VALUE_MAP_MISSING`      | Unmapped choices                |
| `DUPLICATE_KEY`          | Duplicate keys                  |
| `INVALID_EMAIL`          | Invalid emails                  |
| `INVALID_PHONE`          | Invalid phone numbers           |
| `PRIMARY_KEY_MISSING`    | Missing primary keys            |
| `NUMERIC_OUT_OF_RANGE`   | Values outside the target range |

Any code without a label is shown as its name with underscores replaced and lowercased, so a new code
degrades to something readable rather than to nothing.

Because a summary profiles every mapped table, it is the most expensive call in this area. Run it when
you want the whole picture; use `POST /api/plans/:id/entities/:entityId/profile` while you are working
on one table.

---

## 7. The CSV export

`GET /api/plans/:id/data-quality.csv` produces the file for the team fixing the source. It is UTF-8
with a BOM and CRLF line endings, so Excel opens it correctly without an import wizard.

| Column               | Contents                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Severity             | `BLOCKER` or `WARNING`                                                                                |
| Category             | The readable label from §6                                                                            |
| Source Connection    | The plan's source environment display name                                                            |
| Source Table         | The source table's logical name                                                                       |
| Source Record ID     | The offending record, when a sample was kept — otherwise empty                                        |
| Field                | The source column                                                                                     |
| Original Value       | The offending value, masked for secured columns                                                       |
| Transformed Value    | Always empty in this export — profiling reports raw source values                                     |
| Target Field         | Always empty in this export                                                                           |
| Rule                 | The category again, as the rule that produced the row                                                 |
| Issue                | The message plus `(N record(s))`, or `(N record(s) in the profiled sample)` when the basis is SAMPLED |
| Suggested Resolution | The issue's `resolution`, falling back to the per-code suggested action                               |

One issue produces **one row per kept sample** (up to five), or a single row with no record id when no
samples were kept — so the file names specific records to go and look at wherever it can.

The export profiles with `sampleSize: 5_000`, which keeps it responsive; its Issue column says so on
every row whose basis is SAMPLED.

For the full remediation package across preflight, validation and quality findings, use
`GET /api/plans/:id/issues-package.csv`.

---

## 8. Remediation

Each issue carries a `resolution` sentence; this is the menu behind it.

| Issue                                      | Options, roughly in order of preference                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUIRED_VALUE_MISSING` / `BLANK_VALUE`   | Fix the source. Or add `DEFAULT_IF_BLANK` with an agreed placeholder. Or exclude those records from the plan. Note `DEFAULT_IF_NULL` will **not** rescue a blank string — use `DEFAULT_IF_BLANK`. |
| `STRING_TOO_LONG`                          | Shorten the source values. Or configure `TRUNCATE` at the target's limit — which is lossy and must be acknowledged before the run. Or map the column to a `Memo` target with room for it.         |
| `INVALID_EMAIL` / `INVALID_PHONE`          | Clean the source. Or clear the bad values so the target column stays empty. These are warnings: the target will accept the text.                                                                  |
| `VALUE_NOT_ALLOWED` / unmapped choice      | Map the value to a target choice. Or mark it excluded, which writes an empty column as a deliberate decision. Or set a default target value for anything unmapped.                                |
| `VALUE_OUT_OF_RANGE` / `DATE_OUT_OF_RANGE` | Fix the source — the target column will reject these outright. There is no transformation that makes an out-of-range value acceptable without changing it.                                        |
| `PATTERN_MISMATCH` / `STRING_TOO_SHORT`    | Correct the source values so they match the expected format.                                                                                                                                      |
| `DUPLICATE_KEY`                            | De-duplicate the source. Or choose a different match key for the table — a business key on a genuinely unique column.                                                                             |
| `PRIMARY_KEY_MISSING`                      | Fix the source. There is no workaround: a record with no key cannot be matched, resumed or rolled back.                                                                                           |
| An ambiguous or invalid date               | Set the column's `inputFormat` so `01/02/2020` is read the way the source system meant it. A calendar-invalid date such as `2024-02-30` has to be fixed in the source.                            |

Two rules of thumb:

- **Fixing the source beats configuring around it.** A transformation travels with this plan only; the
  bad data stays bad for every other consumer of that system.
- **Every lossy option is gated.** `TRUNCATE`, `SUBSTRING`, `TO_DATE` and `TO_INTEGER` must be
  acknowledged per rule before a run will start, and both the acknowledgement and the run are audited.
  See [TRANSFORMATION_ENGINE.md](TRANSFORMATION_ENGINE.md), §8.

---

## 9. Honest limits

- **Counts are as exact as the profile is.** With `basis: 'SAMPLED'` — which is the default, at 10,000
  records, and always the case when the record total is only approximate — "38" means 38 within what was
  examined. Use `full: true` on a table under 200,000 records to get an `EXACT` basis.
- **The sample is the first _n_ records in primary-key order,** not a random sample. See
  [DATA_PROFILING.md](DATA_PROFILING.md), §2.
- **Rules come from the target schema only.** There is no API today for adding a rule by hand, so the
  `MAPPING` and `USER` origins are reserved but unused, and the kinds `NOT_BLANK`, `MIN_LENGTH`,
  `VALID_PHONE`, `DATE_RANGE`, `ALLOWED_VALUES`, `UNIQUE` and `REGEX_PATTERN` are implemented in the
  evaluator but never derived automatically.
- **`MAX_LENGTH` without per-record counting reports `affected: 0`.** The issue still appears, and its
  message says the exact number was not counted — but it contributes nothing to the dashboard totals.
- **Uniqueness is unknowable above 50,000 distinct values.** Past the distinct cap `duplicateCount`
  becomes `null` and the `UNIQUE` check is skipped rather than guessed. Duplicate **primary keys** stop
  being counted past the same cap.
- **Profiling sees raw source values.** It does not know what your transformations will do, and it does
  not read the target's data.
- **The platform cannot check** business meaning (is this the right customer?), cross-column consistency
  (a close date before an open date), cross-table referential integrity beyond a table's own primary key,
  duplicates by fuzzy match rather than exact value, or anything a target plug-in, business rule or
  alternate-key constraint will enforce at write time. Those surface at preflight or in the run's errors,
  not here.
- **A clean data-quality report is not a green light.** It means no rule derived from the target schema
  is violated in what was examined. The preflight is what tells you what will actually happen.
