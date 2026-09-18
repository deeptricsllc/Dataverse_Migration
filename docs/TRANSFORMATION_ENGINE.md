# The transformation engine

**What this covers:** how a source value becomes a target value — every rule, the order they run in,
what each one does to a null, and what it takes to add another.
**Written for:** the engineer extending `server/src/services/transformation/engine.ts`, and the
migration consultant configuring a pipeline for a customer's data.

---

## 1. One engine, four callers

There is exactly one function that turns a source value into a target value: `transformField` in
`server/src/services/transformation/engine.ts`. Four code paths call it, and nothing else is allowed
to:

| Caller                                                         | What it is doing                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| `transformation-service.ts` → `previewField`, `previewRecords` | Showing a user what a pipeline does to their own data         |
| `record-planner.ts` → `prepareRecord`, used by the preflight   | Classifying a record as CREATE / UPDATE / UNCHANGED / BLOCKED |
| `record-planner.ts` → `prepareRecord`, used by the run engine  | Building the values a create or update actually writes        |
| `validation-service.ts` → `compareRecords`                     | Deciding whether the target now holds the right value         |

This is not a tidiness rule, it is a correctness rule. A second implementation anywhere would let
those four disagree, and every way they can disagree is a defect that destroys trust in the tool:

- Preview disagrees with migration → the user approved something other than what ran.
- Preflight disagrees with migration → "12 will be created" and 9 get created, with no explanation.
- Migration disagrees with validation → validation reports differences the migration itself caused,
  and the team spends a day chasing a bug that is in the comparison, not in the data.

The integration test `tests/integration/transformation-pipeline.test.ts` exists to hold this line. It
trims a padded legacy `CustomerName`, migrates it, then re-runs the preflight: because the preflight
compares the **transformed** source against the target, it reports `unchanged` rather than proposing
26 pointless updates. Validation then reports `different: 0` for the same reason. Both results are
only possible because all three ran the same function over the same rules.

`transformField` is pure and deterministic: no clock, no randomness, no I/O. The same value, rules and
context always produce the same result — asserted directly in `tests/unit/transformation-engine.test.ts`
("is deterministic: the same input always produces the same output").

---

## 2. The order of operations for one field

```
   source value (raw, exactly as the connector read it)
        │
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ 1. PIPELINE                                                  │
 │    mapping.transformations, in the configured order.         │
 │    Empty? then the legacy single-step transform is adapted   │
 │    into a one-rule pipeline (rulesFromLegacy).               │
 │    Each rule: value in → value out, or a hard failure that   │
 │    stops the field there.                                    │
 └──────────────────────────────────────────────────────────────┘
        │
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ 2. CHOICE / VALUE MAP                                        │
 │    mapping.choiceMap, appended by choiceMapRule() as a       │
 │    VALUE_MAP rule. Always last, because an excluded choice   │
 │    value is dropped by the map itself.                       │
 └──────────────────────────────────────────────────────────────┘
        │
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ 3. TYPE CONVERSION into the target column                    │
 │    Same provider on both sides → transformValue (values.ts). │
 │    Across providers (SQL ⇄ Dataverse) → convertValue         │
 │    (connectors/sql/type-map.ts).                             │
 │    Failures become STRING_TOO_LONG / INVALID_DATE /          │
 │    INVALID_NUMBER / TRANSFORMATION_FAILED.                   │
 └──────────────────────────────────────────────────────────────┘
        │
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ 4. TARGET CONSTRAINTS (checkTargetConstraints)               │
 │    maxLength, and required-level. Checked for every provider │
 │    pair, not only across them.                               │
 └──────────────────────────────────────────────────────────────┘
        │
        ▼
   target-ready value  +  applied[]  +  issues[]  +  lossy flag
```

Two details of step 1 that matter when reading the code:

- The pipeline and the legacy transform are alternatives, not a sequence. If
  `mapping.transformations` has any rules, the legacy `transform` is ignored entirely.
- `applied[]` records a step only when the rendered value actually changed. A `TRIM` on an already
  trimmed value leaves no trace, which is what keeps a record-level preview readable.

The **first** error wins. When a rule, the conversion or a constraint fails, `transformField` returns
immediately with `ok: false`, `value: null` and a populated `error` — later rules never run. The unit
test pins this: `TO_INTEGER` on `"not-a-number"` followed by a `CONSTANT` rule fails with
`INVALID_NUMBER`; the constant is never reached.

### Where lookups are resolved, and why not here

Lookup, Customer and Owner columns never reach `transformField`. `record-planner.ts` handles them
before the field path: it takes the source reference, looks the source id up in the run's identity
map (`lookups`), rewrites the table name through `targetTableFor`, and then either writes the
resolved reference, defers it to pass 2, reports it as pending, or blocks the record when the target
column is required and the reference cannot be resolved.

That work is deliberately outside the engine because it is not a function of the value:

- It needs the **run's** identity map, which only exists while a migration is executing.
- Its answer changes between passes — a reference that is unresolved in pass 1 resolves in pass 2.
- It is I/O-shaped and stateful, and the engine's guarantee is that it is neither.

Keeping it out is what lets the engine stay pure, and therefore lets preview call it with no run at
all. Ownership and audit attribution (`owner`, `createdby`, `modifiedby`) sit in the same place, for
the same reason.

---

## 3. Every transformation kind

The closed list lives in `TRANSFORMATION_KINDS` (`shared/domain.ts`). "Null" below means `null` or
`undefined`; "blank" means null, or a string that is empty after trimming.

### String

| Kind         | What it does                                               | Parameters            | Null / non-string                            | Lossy |
| ------------ | ---------------------------------------------------------- | --------------------- | -------------------------------------------- | ----- |
| `TRIM`       | Removes leading and trailing whitespace                    | —                     | Passes through untouched, never stringified  | no    |
| `LEFT_TRIM`  | Removes leading whitespace only                            | —                     | Passes through untouched                     | no    |
| `RIGHT_TRIM` | Removes trailing whitespace only                           | —                     | Passes through untouched                     | no    |
| `UPPERCASE`  | `toUpperCase()`                                            | —                     | Passes through untouched                     | no    |
| `LOWERCASE`  | `toLowerCase()`                                            | —                     | Passes through untouched                     | no    |
| `REPLACE`    | Replaces **every literal** occurrence — never a regex      | `find`, `replaceWith` | Passes through; also when `find` is empty    | no    |
| `PREFIX`     | Puts `value` in front of the stringified value             | `value`               | Null passes through (no bare prefix is made) | no    |
| `SUFFIX`     | Puts `value` after the stringified value                   | `value`               | Null passes through                          | no    |
| `SUBSTRING`  | Keeps `[start, start + length)`; `length` omitted = to end | `start`, `length`     | Null → null                                  | yes   |
| `TRUNCATE`   | Cuts to `length`; a value that already fits is not a loss  | `length`              | Null → null; `length ≤ 0` is a no-op         | yes   |

`REPLACE` is literal by construction: the implementation is `value.split(find).join(replaceWith)`.
`+`, `(`, `.` and every other metacharacter are data. This is asserted in the unit tests, and it is a
security property as much as a usability one — see [§10](#10-what-the-engine-refuses-to-be).

### Null and blank

| Kind               | What it does                                         | Parameters | Null behaviour                           | Lossy |
| ------------------ | ---------------------------------------------------- | ---------- | ---------------------------------------- | ----- |
| `EMPTY_TO_NULL`    | A string that is empty after trimming becomes `null` | —          | Null stays null                          | no    |
| `NULL_TO_EMPTY`    | `null` becomes `''`                                  | —          | That is the whole rule                   | no    |
| `DEFAULT_IF_NULL`  | Replaces **only** null with `value`                  | `value`    | `''` and `'   '` are kept as they are    | no    |
| `DEFAULT_IF_BLANK` | Replaces null **and** whitespace-only strings        | `value`    | Both null and `'   '` become the default | no    |
| `BLOCK_IF_NULL`    | Fails the field with `REQUIRED_VALUE_MISSING`        | —          | A blank string passes this rule (see §4) | no    |
| `CONSTANT`         | Ignores the input and produces `value`               | `value`    | Applies to every value, null included    | no    |

### Type

| Kind          | What it does                                                  | Parameters    | Null behaviour           | Lossy |
| ------------- | ------------------------------------------------------------- | ------------- | ------------------------ | ----- |
| `TO_STRING`   | Renders the value the way previews and diffs render it        | —             | Null → null              | no    |
| `TO_INTEGER`  | `Math.trunc`; non-numbers fail with `INVALID_NUMBER`          | —             | Null → null              | yes   |
| `TO_DECIMAL`  | Parses a number; rounds only when `scale` is set              | `scale`       | Null → null              | no\*  |
| `TO_BOOLEAN`  | Configured map first, then the unambiguous literals (§6)      | `map`         | Null → null; `''` → null | no    |
| `TO_DATE`     | Date-only `YYYY-MM-DD`; warns when a time of day is discarded | `inputFormat` | Null and `''` → null     | yes   |
| `TO_DATETIME` | Full ISO instant                                              | `inputFormat` | Null and `''` → null     | no    |
| `TO_GUID`     | Lowercases and re-hyphenates; 32 bare hex digits accepted     | —             | Null and `''` → null     | no    |

\* `TO_DECIMAL` with a `scale` emits a `LOSSY_TRANSFORMATION` **warning** when rounding changes the
value, but it is not in `LOSSY_TRANSFORMATIONS`, so it does not set the result's `lossy` flag and does
not require an acknowledgement. Only `TRUNCATE`, `SUBSTRING`, `TO_DATE` and `TO_INTEGER` do.

### Mapping, composition and conditions

| Kind        | What it does                                        | Parameters                             | Null behaviour                          | Lossy |
| ----------- | --------------------------------------------------- | -------------------------------------- | --------------------------------------- | ----- |
| `VALUE_MAP` | Maps a source value onto a target value (§7)        | `map`, `onUnmapped`, `defaultValue`    | Null → null, never "unmapped"           | no    |
| `CONCAT`    | Joins literals and other columns of the same record | `parts`, `separator`, `skipEmptyParts` | Ignores the incoming value; `''` → null | no    |
| `IF_THEN`   | Runs an action when one declarative condition holds | `condition`, `action`, `value`, `then` | Condition decides; otherwise unchanged  | no    |

`CONCAT` reads other columns from `context.record`, so the caller must supply the whole record — every
production caller does, and the preview reads the extra columns on purpose (§9). With
`skipEmptyParts` left at its default (`true`), a null middle name produces `"John Smith"` rather than
`"John  Smith"`; set it to `false` and you get `"John||Smith"`. Both are covered by unit tests.

`IF_THEN` supports three actions: `SET_VALUE` (the default when nothing else matches — produces
`value`), `SET_NULL`, and `APPLY`, which runs the nested `then` pipeline. Conditions come from the
closed `CONDITION_OPERATORS` list — `EQUALS`, `NOT_EQUALS`, `IS_NULL`, `IS_NOT_NULL`, `IS_BLANK`,
`CONTAINS`, `STARTS_WITH`, `GREATER_THAN`, `LESS_THAN`. `EQUALS`, `NOT_EQUALS`, `CONTAINS` and
`STARTS_WITH` compare case-insensitively; `EQUALS` and `NOT_EQUALS` also ignore surrounding
whitespace. A condition with no `field` tests the value flowing through the pipeline; with a `field`
it tests that column of the source record.

### Built-in templates

`templates.ts` ships six pipelines, applied by **copying** their rules onto a mapping — nothing stays
linked, so editing the mapping later cannot be undone by a template change, and a run's snapshot
stays meaningful.

| Template               | Rules                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| Trim text              | `TRIM`                                                           |
| Normalize email        | `TRIM` → `LOWERCASE` → `EMPTY_TO_NULL`                           |
| Empty string to null   | `EMPTY_TO_NULL`                                                  |
| Legacy Y/N to yes-no   | `TRIM` → `TO_BOOLEAN` with Y/YES/1/TRUE and N/NO/0/FALSE         |
| Legacy ACTIVE/INACTIVE | `TRIM` → `UPPERCASE` → `TO_BOOLEAN` with ACTIVE/A and INACTIVE/I |
| Clean phone number     | `TRIM` → four literal `REPLACE`s for `( ) - .` → `EMPTY_TO_NULL` |

---

## 4. Null and blank, precisely

Nothing about emptiness is implicit. The default is **PRESERVE**: with no rule configured, a null
stays a null and a blank string stays a blank string, all the way to the target. Every other
behaviour is a rule someone chose.

| You want                                         | Configure          | What happens to `null`   | What happens to `'   '` |
| ------------------------------------------------ | ------------------ | ------------------------ | ----------------------- |
| Nothing — keep the source exactly                | _no rule_          | `null`                   | `'   '`                 |
| A legacy blank string to become a real null      | `EMPTY_TO_NULL`    | `null`                   | `null`                  |
| A null to become an empty string                 | `NULL_TO_EMPTY`    | `''`                     | `'   '`                 |
| A fallback only where there is genuinely no data | `DEFAULT_IF_NULL`  | the default              | `'   '` (untouched)     |
| A fallback where the data is missing or hollow   | `DEFAULT_IF_BLANK` | the default              | the default             |
| To refuse the record rather than invent a value  | `BLOCK_IF_NULL`    | `REQUIRED_VALUE_MISSING` | passes the rule         |

The `DEFAULT_IF_NULL` / `DEFAULT_IF_BLANK` distinction is the one people get wrong, so it is pinned by
a unit test: `DEFAULT_IF_NULL` on `''` returns `''`, while `DEFAULT_IF_BLANK` on `'  '` returns the
default. Pick `DEFAULT_IF_NULL` when a blank string is meaningful in the source (someone cleared the
field on purpose) and `DEFAULT_IF_BLANK` when it is just legacy debris.

**A required target column rejects a blank string.** `checkTargetConstraints` treats null, `''` and
`'   '` identically: if the target's `requiredLevel` is `ApplicationRequired` or `SystemRequired`, the
field fails with `REQUIRED_VALUE_MISSING`. This is deliberate. Both Dataverse and SQL refuse a blank
where a value is required, so accepting it here would only move the failure from a reviewable
preflight into a half-finished migration.

This combination catches a real and easily missed case, and the integration test walks it end to end:
a legacy customer whose name is `'   '` is trimmed to `''` by a `TRIM` rule, `account.name` is
required, and the record is reported as BLOCKED by the preflight with reason code
`REQUIRED_VALUE_MISSING` — before anything is written.

---

## 5. Dates

**`01/02/2020` is refused, not guessed.** `toDateParts` tests every unformatted string against
`AMBIGUOUS_DATE` (`d{1,2}[/.-]d{1,2}[/.-]d{2,4}`) and fails it with `INVALID_DATE` and the message
"it could be day/month or month/day. Configure the input format for this column."

The reasoning is worth being blunt about. A guess here is not a formatting question, it is a silent
data change: read as `MM/DD/YYYY` the value is 2 January, read as `DD/MM/YYYY` it is 1 February. Both
parse, neither errors, and the wrong one moves every affected record's date by up to eleven months —
across a contract table that is a compliance incident nobody notices for a year. A migration tool that
guesses has chosen to be wrong quietly rather than blocked loudly.

Set `inputFormat` and the ambiguity is gone. The same string with the format stated produces different,
correct answers, which is exactly the point:

| Value        | `inputFormat` | Result                      |
| ------------ | ------------- | --------------------------- |
| `01/02/2020` | `MM/DD/YYYY`  | `2020-01-02T00:00:00.000Z`  |
| `01/02/2020` | `DD/MM/YYYY`  | `2020-02-01T00:00:00.000Z`  |
| `01/02/2020` | _(none)_      | `INVALID_DATE`, "ambiguous" |

`inputFormat` accepts exactly these patterns; anything else fails with "does not match the configured
format":

`YYYY-MM-DD` · `MM/DD/YYYY` · `DD/MM/YYYY` · `MM-DD-YYYY` · `DD-MM-YYYY` · `DD.MM.YYYY` · `YYYYMMDD`

Each is matched as a prefix of the trimmed value, so trailing text (a time, a timezone suffix) does not
break the parse, and the result is midnight UTC on that day.

Without an `inputFormat`, an unambiguous string (`2020-01-15`, `2020-01-15T10:30:00Z`) goes through
`Date.parse`, and a number is treated as epoch milliseconds.

**A calendar-invalid date is an error, not a rounding.** `2024-02-30` fails with `INVALID_DATE`.
`Date.parse` would roll it forward to 1 March, so the engine re-checks the parsed ISO day against
`realDate` and refuses anything that does not exist. `15/15/2020` with `MM/DD/YYYY` fails the same
way. A date that does not exist is a defect in the source data; the migration's job is to surface it,
not to invent a plausible neighbour.

`TO_DATE` keeps only `YYYY-MM-DD` and reports the discarded time of day as a `LOSSY_TRANSFORMATION`
warning ("time of day dropped"). `TO_DATETIME` keeps the full instant and is not lossy.

> The `assumeUtc` flag is declared on `TransformationRule` and accepted by the API schema, but the
> engine does not read it today. Zone-less input is handled by `Date.parse`.

---

## 6. Booleans

`TO_BOOLEAN` accepts, with no configuration, only the literals that cannot mean anything else —
`true`, `1`, `y`, `yes` and `false`, `0`, `n`, `no`, compared after trimming and lowercasing.
Everything else fails with `VALUE_MAP_MISSING`: _"is not a recognized true/false value. Configure
what it means."_

`"ACTIVE"` is the canonical example and it fails on purpose. In one legacy CRM `ACTIVE` is the
customer's status and maps to `statecode = 0`; in another it is a `DoNotContact`-style flag where
"active" means the suppression is on, i.e. `true` for the opposite question; in a third the column
holds `ACTIVE`, `INACTIVE` and `PENDING`, and only a person knows which side `PENDING` belongs on.
Assuming any of those is a guess about business meaning that a string comparison is not entitled to
make.

Configure it explicitly with `map`, which is checked before the built-in literals and matched
case- and whitespace-insensitively:

```json
{
  "kind": "TO_BOOLEAN",
  "map": [
    { "from": "ACTIVE", "to": true },
    { "from": "INACTIVE", "to": false }
  ]
}
```

The `Legacy ACTIVE/INACTIVE to yes-no` template is exactly this, and it ships **separate** from the
Y/N template for the same reason: bundling them would smuggle the assumption back in.

---

## 7. Value mapping and choice mapping

A choice mapping **is** a `VALUE_MAP` rule. `choiceMapRule` converts a `ChoiceMappingDto` into one, so
there is a single mechanism and a single set of semantics, not two features that drift apart.

**Many-to-one, case- and whitespace-insensitive.** Both sides of the comparison are trimmed and
lowercased, so one target value can absorb every spelling the legacy system accumulated:

```json
{
  "kind": "VALUE_MAP",
  "map": [
    { "from": "A", "to": "Active" },
    { "from": "ACTIVE", "to": "Active" },
    { "from": "Active", "to": "Active" },
    { "from": "D", "to": "Disabled" }
  ]
}
```

`A`, `ACTIVE`, `active` and `" Active "` all produce `"Active"` — asserted in the unit tests.

**Three states, and the difference between them is the whole design.**

| State               | How it is configured                      | Result                                     |
| ------------------- | ----------------------------------------- | ------------------------------------------ |
| Mapped              | entry `status: 'CONFIRMED'` with a target | The target value                           |
| Explicitly excluded | entry `status: 'IGNORED'`                 | `null` — an empty target column            |
| Undecided           | entry `status: 'UNMAPPED'`, or no entry   | **Blocks the record**, `VALUE_MAP_MISSING` |

Blocking is the default because "nobody has looked at this value yet" and "someone decided this value
should be dropped" produce the same empty column but mean opposite things. Writing an unreviewed value
as empty destroys data on the strength of an omission. The unit test states all three at once: `MFG`
maps to `1`, an `IGNORED` `Aerospace` becomes null, and an `UNMAPPED` `Retail` blocks.

A null source value is never "unmapped" — it passes straight through as null.

The policy is overridable per rule, with `onUnmapped`:

| Policy            | Unknown value becomes | Use when                                             |
| ----------------- | --------------------- | ---------------------------------------------------- |
| `BLOCK` (default) | a blocked record      | Anything you would have to explain to an auditor     |
| `IGNORE`          | `null`                | The column is optional and an unknown value is noise |
| `DEFAULT`         | `defaultValue`        | The target has a genuine "Other"/"Unknown" option    |

A `ChoiceMappingDto` with a `defaultTargetValue` produces `onUnmapped: 'DEFAULT'`; with `null` it
produces `BLOCK`.

Because the map runs **after** the pipeline, normalization rules can feed it. The unit test maps
`'  active  '` through `TRIM` → `UPPERCASE` into a choice map keyed on `ACTIVE`, arriving at option
value `1`.

---

## 8. Lossy transformations and the acknowledgement

Four kinds are lossy by definition (`LOSSY_TRANSFORMATIONS` in `shared/domain.ts`):

| Kind         | What is discarded                        |
| ------------ | ---------------------------------------- |
| `TRUNCATE`   | Characters beyond the configured length  |
| `SUBSTRING`  | Everything outside the configured window |
| `TO_DATE`    | The time of day                          |
| `TO_INTEGER` | The decimal digits                       |

They are surfaced in three places, at increasing commitment:

1. **Per value.** The rule returns a `LOSSY_TRANSFORMATION` warning, and `transformField` marks the
   step `lossy: true` in `applied[]` — but only when the value actually changed. `TRUNCATE(10)` over
   `"abc"` is not a loss and is not reported as one.
2. **Per record.** `record-planner` collects the field names into `lossyFields`, and the preflight and
   run reports carry them.
3. **Per plan.** `GET /api/plans/:id/lossy-transformations` lists every configured lossy rule as a
   `LossyTransformationDto` with a stable `key` of the form `table.sourceField:KIND` — for example
   `dbo.Customer.CustomerName:TRUNCATE` — plus a plain-English description
   ("Values longer than 10 characters are cut to 10").

**Execution is refused until each key is accepted.** `POST /api/plans/:id/execute` fetches the lossy
list, subtracts `options.lossyAcknowledgement.accepted`, and fails with HTTP 400 naming every rule
that was not accepted. Acknowledgement is `POST /api/plans/:id/lossy-transformations/acknowledge` with
the list of keys; it stores the accepted keys, `acknowledgedBy` and `acknowledgedAt` on the plan.

Because acceptance names **each rule by key**, adding another lossy rule afterwards leaves that key
unaccepted, and execution asks again. There is no blanket "I accept lossy transformations" switch.
Both steps are audited: `LOSSY_TRANSFORMATION_ACKNOWLEDGED` when it is accepted, and the run's
`MIGRATION_EXECUTION_REQUESTED` entry records the full key list and the acknowledgement, so who
accepted what and when is answerable years later. The integration test walks the whole gate:
configuring `TRUNCATE(10)` makes execute return 400, and only after acknowledging the single key does
the run proceed.

---

## 9. Ordering matters

Rules run in the order configured, top to bottom. This is the smallest example, taken verbatim from
the unit tests, and it is worth showing a consultant before they build their first pipeline:

| Pipeline               | `'  abcdef'` becomes | Why                                                      |
| ---------------------- | -------------------- | -------------------------------------------------------- |
| `TRIM` → `TRUNCATE(4)` | `'abcd'`             | Padding is removed first, so four real characters remain |
| `TRUNCATE(4)` → `TRIM` | `'ab'`               | The cut spends two of its four characters on whitespace  |

Same two rules, same input, half the data. The rule of thumb: **clean first, then constrain** — trim,
replace and normalize before truncating, converting or mapping.

The full-path test shows the same pairing doing the intended thing:
`'  ACME Corporation  '` with `TRIM` → `TRUNCATE(10)` into a 10-character target yields
`'ACME Corpo'`, `lossy: true`, and `applied` of `['TRIM', 'TRUNCATE']`.

---

## 10. Preview

`POST /api/plans/:id/mappings/:mappingId/preview` runs a candidate pipeline over **real source
values** through the same `transformField`, before anything is saved. A preview that can disagree with
the migration is worse than no preview, so the preview is not a front-end approximation of the rules.

| Property        | Behaviour                                                                       |
| --------------- | ------------------------------------------------------------------------------- |
| Rows returned   | Up to `PREVIEW_SAMPLE` = 25                                                     |
| Records scanned | Up to `PREVIEW_SCAN_LIMIT` = 500, read in pages of 100                          |
| Selection       | **Distinct values first** — a value already shown is skipped                    |
| Columns read    | The mapped column, plus every column a `CONCAT` part or a condition references  |
| Per row         | Source value, transformed value, `OK`/`WARNING`/`BLOCKED`, message, `applied[]` |
| Secured columns | Masked as `***` in the source, the result and every `applied` step              |
| `sampled`       | True when the scan limit was reached before the row limit                       |

Preferring distinct values is what makes the sample teach anything: fifty rows that all read `Active`
demonstrate nothing, while twenty-five different values show the mixed-case ones, the padded ones and
the blank one in a single screen. The null bucket is included, keyed as `<<null>>`.

`GET /api/plans/:id/entities/:entityId/preview` is the record-level view (up to 50 records, default
10): per field the source value, the transformed value and **what the target holds today**, plus the
action the migration would take — `CREATE`, `UPDATE`, `UNCHANGED` or `BLOCKED`.

The `lossy` flag on a field preview reports whether the configured pipeline **contains** a lossy kind,
not whether any previewed row actually lost data; the per-row `applied[].lossy` flags are the
value-level answer.

---

## 11. Versioning: a run keeps its own pipeline

When a run (or a preflight) starts, `buildSnapshot` in `migration-run-service.ts` copies the plan into
a `RunPlanSnapshot`, and every field mapping's `transformations`, legacy `transform` and `choiceMap`
go into it. The snapshot is stored on the run row.

Everything downstream reads the snapshot, never the live plan: `record-planner` during execution, and
`compareRecords` during validation. So:

- Editing a plan mid-run cannot change what the run is doing.
- Validating a two-year-old run re-derives the expected values with **that run's** rules, even if the
  plan has since been rewritten. The comparison stays deterministic instead of drifting into false
  differences.
- The audit trail's record of what ran is complete, because the rules are part of the run, not a
  pointer to something mutable.

This is also why templates are copied rather than linked (§3).

---

## 12. What the engine refuses to be

| Property                        | How it is enforced                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No expressions, scripts or SQL  | `kind` is the closed `TRANSFORMATION_KINDS` enum. There is no interpreter to reach, so configuration can never become an injection path.    |
| `REPLACE` is literal            | `split(find).join(replaceWith)`. No `RegExp` is constructed from user input anywhere in the engine.                                         |
| Server-side validation          | Every rule is parsed by zod in `server/src/routes/index.ts` before a service sees it. The client is not trusted.                            |
| Bounded configuration           | ≤ 20 rules per pipeline, ≤ 10 nested, ≤ 500 map entries, ≤ 20 CONCAT parts, `find`/`replaceWith` ≤ 200 chars, `value` ≤ 1000, `scale` 0–10. |
| One level of nesting            | `IF_THEN.then` accepts plain rules only, so a pipeline cannot recurse into itself or be made to blow the stack.                             |
| No I/O, no clock, no randomness | Every function in the module is pure. This is what makes preview, preflight, migration and validation agree.                                |
| Secured columns never leak      | `isSecured` attributes are masked to `***` in field previews, record previews and every `applied` step.                                     |

---

## 13. Adding a transformation kind

Five steps, in this order:

1. **`shared/domain.ts`** — add the name to `TRANSFORMATION_KINDS`, add any new parameter fields to
   `TransformationRule`, and add the kind to `LOSSY_TRANSFORMATIONS` if it discards information.
2. **`server/src/services/transformation/engine.ts`** — add a `case` to `applyRule` returning
   `ok(value, warning?)` or `fail(code, message)`. Give the failure a code that already means
   something (`INVALID_NUMBER`, `INVALID_DATE`, `VALUE_MAP_MISSING`, `REQUIRED_VALUE_MISSING`) unless
   the condition is genuinely new — codes surface in preflight reasons, CSV exports and the
   data-quality dashboard, so an ad-hoc one becomes a hole in a report.
3. **`server/src/routes/index.ts`** — add the new fields to the `baseRule` zod shape, **with explicit
   bounds**. A field with no maximum is a denial-of-service parameter.
4. **The mapping UI** — an editor for the parameters, and optionally a ready-made pipeline in
   `templates.ts` if the kind exists to solve a recurring legacy pattern.
5. **`tests/unit/transformation-engine.test.ts`** — the happy path, the null case, the failure case,
   and the loss warning if it is lossy. Add a case to
   `tests/integration/transformation-pipeline.test.ts` if the kind changes what a migration writes.

A new kind must obey all five of these, or it breaks the guarantee the rest of the platform is built on:

- **Pure.** No I/O, no database, no connector, no network.
- **Deterministic.** No `Date.now()`, no `Math.random()`, no locale-dependent behaviour. The same
  input must transform identically in a preview today and in a validation next year.
- **Null-safe.** Decide explicitly what null does and write it in the reference table above. Never
  stringify a null into `"null"`.
- **Honest about loss.** If information is discarded, return a `lossWarning` **and** register the kind
  in `LOSSY_TRANSFORMATIONS` so the acknowledgement gate sees it.
- **Failing, not guessing.** When the input cannot be handled, `fail` with a message that says what to
  configure. The date and boolean rules are the model: a blocked record a person can fix beats a
  migrated record nobody knows is wrong.
