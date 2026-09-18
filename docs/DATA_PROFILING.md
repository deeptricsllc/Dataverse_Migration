# Data profiling

**What this covers:** what the profiler reads, every number it produces, and exactly when a number is
a fact about the whole table rather than about a sample.
**Written for:** the person deciding whether to trust the numbers — and to act on them.

Implementation: `server/src/services/profiling-service.ts`. Shapes: `TableProfileDto`,
`FieldProfileDto`, `StatisticBasis` in `shared/domain.ts`.

---

## 1. Three promises

Profiling answers "what is actually in this column" before a migration runs, so a person sees the 38
records that will be rejected instead of finding them in an error log afterwards. Three properties
matter more than any individual statistic.

**1. It is strictly read-only.** The profiler calls exactly three connector methods: `countRecords`,
`getTable` and `queryRecords`. It never creates, updates or deletes anything, so it behaves
identically when `REAL_TENANT_READ_ONLY=true` blocks every write at the HTTP client. Profiling a
production source is safe by construction, not by convention.

**2. It never loads a table into memory.** Records stream page by page (`PROFILE_PAGE_SIZE` = 500) and
are folded into a fixed-size `FieldAccumulator` per column. Every `Set` and `Map` it keeps has an
explicit cap. Memory does not grow with the table.

**3. It never presents a sampled number as an exact one.** Every profile, every field and every issue
carries a `StatisticBasis` of `EXACT` or `SAMPLED`, and `EXACT` is claimed only when provably true.

It is also provider-neutral: it talks only to `MigrationConnector` and the normalized metadata model,
so Dataverse, SQL Server and Azure SQL are profiled by the same code.

---

## 2. EXACT versus SAMPLED

One line decides it:

```ts
const basis: StatisticBasis = !total.approximate && examined >= total.count ? 'EXACT' : 'SAMPLED';
```

Both halves are required:

- **Every record was examined** (`examined >= total.count`), and
- **the total itself was exact** (`total.approximate === false`).

**An approximate total can never produce an EXACT basis.** When SQL Server refuses `COUNT_BIG` the
connector falls back to `sys.dm_db_partition_stats`; when a Dataverse FetchXML aggregate exceeds its
50,000-row limit (`0x8004E023`) the connector falls back to `RetrieveTotalRecordCount`, a snapshot
that can be up to 24 hours old. In both cases `approximate: true` comes back, and there is then no
way to prove that reading _n_ records read all of them — so the profile says `SAMPLED` even if it
streamed the entire table. Claiming EXACT from an estimate would be exactly the kind of quiet
overstatement this service exists not to make.

### How many records get read

`resolveLimit` decides, in this order:

| Input                                      | Records read                              |
| ------------------------------------------ | ----------------------------------------- |
| `full: true`, exact total ≤ 200,000        | `max(total, 1)` — the whole table         |
| `full: true`, approximate or total > limit | falls through to the sampling rules below |
| `sampleSize: n`                            | `min(n, MAX_SAMPLE_SIZE)`                 |
| nothing                                    | `DEFAULT_SAMPLE_SIZE`                     |

| Constant              | Value   | Meaning                                             |
| --------------------- | ------- | --------------------------------------------------- |
| `DEFAULT_SAMPLE_SIZE` | 10,000  | Read when the caller asks for nothing in particular |
| `MAX_SAMPLE_SIZE`     | 200,000 | Ceiling on an explicit `sampleSize`                 |
| `FULL_PROFILE_LIMIT`  | 200,000 | Largest table a `full` profile is honoured for      |

**`full: true` degrades to sampling without an error.** Ask for a full profile of a 5-million-record
table and you get a 10,000-record sample instead — no exception, no warning field. The degradation is
reported through `basis: 'SAMPLED'` and through `examined` (10,000) sitting next to `totalRecords`
(5,000,000). Those three fields are the contract; if you are writing code or a report against a
profile, read `basis` rather than assuming your request was honoured.

### What "sample" means here, precisely

The sample is the **first _n_ records the connector returns**, and `queryRecords` streams ordered by
primary key. It is a head sample, not a random one. That is a deliberate trade — random sampling would
require either an expensive server-side shuffle or a second pass — but it has consequences you should
know before quoting a percentage:

- If the table is loaded in chronological order, a sample is the **oldest** records, which in most
  legacy systems are the dirtiest. Expect quality percentages to be pessimistic.
- If a defect was introduced by a recent import, a head sample can miss it entirely.

When a number will be acted on — a remediation budget, a go/no-go — use `full: true` on a table inside
the limit and check that `basis` came back `EXACT`.

---

## 3. Which columns are profiled

`selectColumns` picks them:

| Rule                                  | Effect                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `isValidForRead` must be true         | Always. There is no way to profile a column the provider will not read.           |
| Explicit `fields` in the request      | Profiles exactly those, and **bypasses** every exclusion below                    |
| Otherwise: `SYSTEM_MANAGED_COLUMNS`   | Excluded — `createdon`, `modifiedby`, `versionnumber`, `owninguser`, and the rest |
| Otherwise: `Image`, `File`, `Virtual` | Excluded — binary, computed or navigation values are not data a profile can read  |
| Otherwise: columns with `attributeOf` | Excluded — the computed child of another column, such as a lookup's name field    |
| `MAX_PROFILED_COLUMNS` = 300          | Hard cap, so a pathologically wide table cannot stall a request                   |

Passing `fields` is therefore the only way to profile a system-managed column deliberately.

The **primary key is always read**, whether or not it is profiled, so key integrity can be reported
for every table.

When profiling runs for a plan (`DataQualityService.profileEntity`), `fields` is set to the columns
that are actually mapped and active — profiling a column nobody migrates is noise in a report someone
has to read.

---

## 4. Every statistic

A value is reduced to one canonical string before it is counted, compared or measured: a lookup
profiles by its **id** (not its label), an array joins on `,`, everything else is `String(value)`.

### Produced for every column

| Field                                         | Meaning                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `examined`                                    | Records folded into this accumulator                                            |
| `nullCount`, `nullPercent`                    | `null`/`undefined` count, and its share of `examined` to one decimal            |
| `blankCount`                                  | Strings that are empty after trimming. Only string values can be blank.         |
| `distinctCount`                               | Distinct canonical values, or **`null`** when the distinct cap was hit (§5)     |
| `duplicateCount`                              | `nonNull - distinctCount`, or `null` for the same reason                        |
| `topValues`                                   | Up to 50 `{ value, count }`, most frequent first, ties broken alphabetically    |
| `topValuesTruncated`                          | True when there are more distinct values than were returned, or the cap was hit |
| `invalidValueCount`                           | Values that could not be interpreted as the column's type at all                |
| `type`, `displayName`, `targetField`, `basis` | Metadata carried through for the UI and the report                              |

### Text columns

Applies to `String`, `Memo`, `EntityName`, `Uniqueidentifier`, `Other` — and to lookups, which are
measured by the length of their id.

| Field             | Meaning                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `minLength`       | Shortest non-null value                                                             |
| `maxLength`       | Longest non-null value — the number the target's limit is compared against          |
| `averageLength`   | Mean length over non-null values, to one decimal                                    |
| `whitespaceCount` | Non-blank strings with leading or trailing whitespace — the "this needs TRIM" count |

### Numeric columns

Applies to `Integer`, `BigInt`, `Decimal`, `Double`, `Money` — and to `Picklist`, `State`, `Status`,
so a choice column's stored values can be profiled as numbers.

| Field                  | Meaning                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `minValue`, `maxValue` | Range of the values that parsed as numbers                                                    |
| `averageValue`         | Mean, to six decimals                                                                         |
| `maxScale`             | Most decimal places seen. `null` for exponent notation, where the form gives no honest answer |
| `invalidValueCount`    | Non-blank values that are not numbers at all                                                  |

### Date columns

Applies to `DateTime`.

| Field                | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `minDate`, `maxDate` | Earliest and latest parseable value, as ISO strings                            |
| `invalidDateCount`   | Non-blank values `Date.parse` rejects; these also count in `invalidValueCount` |

### Per-type validity checks

Beyond the above, three column types get a specific check that feeds `invalidValueCount`:

| Column type        | Counted as invalid when                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `Boolean`          | A non-boolean value outside `true`/`false`/`0`/`1`/`yes`/`no` (case-insensitive) |
| Lookup-typed       | The value is neither a lookup reference nor a string                             |
| `Uniqueidentifier` | A non-blank value that is not a GUID, with or without braces                     |

### Table-level

| Field                                  | Meaning                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `totalRecords`, `totalApproximate`     | What `countRecords` reported, and whether it was an estimate                     |
| `examined`, `columns`, `basis`         | What this pass actually did                                                      |
| `primaryKeyField`, `primaryKeyMissing` | Records whose key is null or blank — they cannot be matched or re-run            |
| `duplicateKeyCount`                    | Records repeating a key already seen in this pass                                |
| `issues`                               | Table-level findings: `PRIMARY_KEY_MISSING` (BLOCKER), `DUPLICATE_KEY` (WARNING) |
| `profiledAt`, `durationMs`             | When, and how long — so a full profile of a bigger table can be judged           |

---

## 5. The caps, and what happens at each one

Every cap exists to bound memory or run time, and every one is exported so tests and the UI state the
same number the service uses.

| Cap                    | Value  | What happens when it is reached                                                           |
| ---------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `DISTINCT_VALUE_CAP`   | 50,000 | `distinctCount` and `duplicateCount` become **`null`**; `topValuesTruncated` becomes true |
| `TOP_VALUES_LIMIT`     | 50     | Only the 50 most frequent values are returned; `topValuesTruncated` becomes true          |
| `MAX_ISSUE_SAMPLES`    | 5      | An issue keeps at most 5 offending records; the `count` keeps rising                      |
| `MAX_PROFILED_COLUMNS` | 300    | Columns beyond the 300th are not profiled                                                 |
| `MAX_REGEX_LENGTH`     | 200    | A longer `REGEX_PATTERN` rule does not compile and is never evaluated                     |
| `PROFILE_PAGE_SIZE`    | 500    | Page size requested from the connector; not a limit on what is read                       |

**The distinct cap returns `null`, not a wrong number.** This is the single most important behaviour in
the file. A column of GUIDs or timestamps would grow one map entry per record — exactly the unbounded
memory the service promises not to use. So once 50,000 distinct values are held, values already in the
map keep counting (which keeps `topValues` useful), but no new value is admitted. At that point the
true distinct count is unknowable, and reporting the 50,000 that fit would be a lie by arithmetic.
`null` means "not known", and every consumer must treat it that way: `evaluateRules` skips the `UNIQUE`
check entirely when `duplicateCount` is `null`, because a duplicate count derived from a truncated map
would understate reality.

**Key tracking shares the same cap.** The set of seen primary keys also stops growing at 50,000, so on
a larger pass duplicate keys beyond the cap go unreported. The overflow is written to the structured
log (`keyOverflow`) but does not appear in `TableProfileDto` — so a `duplicateKeyCount` of 0 on a table
with more than 50,000 examined records means "none found within the first 50,000 distinct keys", not
"none exist".

---

## 6. Top values and choice mapping

`topValues` is the bridge from profiling to configuration. For a legacy status column, the 50 most
frequent values **are** the choice map's left-hand side: they show which spellings actually occur, how
many records each covers, and therefore which ones are worth mapping and which are a handful of
typos. A value the profiler never saw is a value nobody needs to map — and if it turns up later, the
`VALUE_MAP` blocks that record rather than guessing (see
[TRANSFORMATION_ENGINE.md](TRANSFORMATION_ENGINE.md), §7).

Sorting is by count descending, ties broken by value ascending, so the list is stable between runs.

A choice map can also be built from a dedicated endpoint,
`GET /api/plans/:id/entities/:entityId/values/:field` (`PlanningService.sourceValues`), which scans up
to 20,000 records or 500 distinct values and returns up to 200 `{ value, occurrences }` pairs with a
`sampled` flag. It exists because building a choice map needs distinct values for one column and
nothing else; the profiler's `topValues` gives the same picture as part of a whole-table profile,
capped at 50.

---

## 7. Secured columns

A column with `isSecured` has its **values** masked to `***` — in `topValues` and in every issue
sample. The **counts are kept**: null counts, lengths, distinct counts and violation counts are all
still computed and reported.

That split is the point. Knowing that 12% of a secured column is empty, or that 38 values exceed the
target's limit, is exactly what a migration lead needs, and none of it discloses a protected value.
The same masking is applied by the transformation previews, so no screen in the product shows a
secured value.

---

## 8. API

| Endpoint                                                        | What it does                                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /api/environments/:id/tables/:table/profile`              | Profiles any table of any connection. Body: `fields[]` (≤300), `sampleSize` (1–200,000), `full` |
| `GET /api/environments/:id/tables/:table/fields/:field/profile` | One column. Query: `sampleSize`                                                                 |
| `POST /api/plans/:id/entities/:entityId/profile`                | Profiles a plan's source table with its target-derived rules. Body: `sampleSize`, `full`        |
| `GET /api/plans/:id/entities/:entityId/quality-rules`           | The rules that table's target schema implies                                                    |
| `POST /api/plans/:id/data-quality`                              | The workspace summary across every mapped table                                                 |
| `GET /api/plans/:id/data-quality.csv`                           | The findings as remediation rows                                                                |

`profileField` delegates to `profileTable` with a single-column `fields` list, so there is exactly one
implementation of every statistic.

> `GET /api/environments/:id/tables/:table/profile` (without a body, note the verb) is a different,
> older endpoint served by `InsightsService`: a small metadata-and-sample overview for the table
> browser — up to 40 columns, a 200-record sample, null counts and five example records. It is not this
> profiler, and its numbers carry no `StatisticBasis`.

---

## 9. Profiling a large table

- **Start sampled.** The 10,000-record default answers most questions in seconds. Use it to find out
  _which_ columns have problems.
- **Narrow, then go full.** Pass `fields` with the three or four columns that matter. A full profile of
  4 columns costs a fraction of a full profile of 300, because the cost is dominated by the columns
  read per record.
- **Check `durationMs` before scaling up.** It is returned on every profile precisely so you can
  extrapolate: a 10,000-record profile that took 4 seconds implies roughly 80 seconds for 200,000.
- **Remember the `full` ceiling is 200,000.** Above it you cannot get an `EXACT` basis from this
  service at all, and above the `COUNT_BIG` / FetchXML-aggregate thresholds you cannot get one even
  below the ceiling, because the total itself becomes approximate.
- **Profile the source, not the target.** Plan profiling reads the source connection; the target's
  schema only contributes rules.
- **One unreadable table does not sink a summary.** `DataQualityService.summary` logs the failure and
  continues, so a permissions problem on one table still leaves the other findings usable.

---

## 10. What profiling deliberately does not do

- **It does not write.** No profile is persisted, no marker column is set, no query hint is applied.
  Every call recomputes from the source.
- **It does not apply transformations.** Statistics describe the **raw** source values. A column with a
  configured `TRIM` still reports its `whitespaceCount`. To see post-transformation values, use the
  transformation preview, which runs the engine.
- **It does not sample randomly.** See §2 — it is the first _n_ records in primary-key order.
- **It does not compute percentiles, medians or histograms.** Min, max, mean, and a capped frequency
  list are the whole numeric vocabulary. A median cannot be computed in one streaming pass with
  bounded memory, and an approximate one would violate promise 3.
- **It does not check across columns or across tables.** No "these two columns disagree", no referential
  integrity beyond the table's own primary key. Cross-table reference resolution is the migration's
  job, reported through `LOOKUP_UNRESOLVED` at preflight.
- **It does not infer meaning.** It will tell you a column holds 4 distinct values in 26,000 records;
  it will not tell you it is a status column, or which target choice each value should become.
- **It does not detect anomalies or outliers.** Nothing is flagged as suspicious on statistical
  grounds. A finding exists only because a rule — almost always derived from the target schema — says
  the target would refuse the value. See [DATA_QUALITY.md](DATA_QUALITY.md).
- **It does not profile the target.** Every number describes the source data you are migrating.
