# Migration outcome semantics

What a run's result means, and why the result a run reports is not the same thing as whether the API
calls succeeded.

This document is the specification. The code follows it, and where the two disagree the code is wrong.
Written before the change it describes, because the change is to the meaning of a word the whole product
reports, and that is not something to settle while editing a component.

## 1. The run this document exists because of

A migration of 300 contacts into a target that had no accounts in it. The engine wrote every contact.
Every `POST` returned `204`. The run reported:

```
Completed · Attempted 300 · Succeeded 300 · Failed 0 · Unresolved 0
```

That report is accurate in every number and wrong as a statement about the migration. Each of those 300
contacts lost its `parentcustomerid` — the account it belonged to. The engine knew: it recorded 270
`LOOKUP_UNRESOLVED` rows in `migration_errors`, one per contact that had a parent, each naming the field
and the account id it could not find. The run then reported a clean result, the plan was marked executed,
and nothing in the product disagreed.

A consultant reading that screen would sign the migration off. The data in the target is not what the
source said.

**The defect is not the wording.** Calling the same run `Completed with warnings` would be a cosmetic
change to a report that is still telling somebody the migration carried the data across. The defect is
that the run's outcome was computed from a model in which a written record is a successful record.

## 2. Two different questions

| Question                                        | Answer comes from                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Did the writes succeed?                         | HTTP results, `migration_record_maps.writeState`, `failed` counts              |
| Is the data in the target what the source said? | the same evidence, _plus_ every reference and value the engine could not carry |

The first question is about transport. The second is about outcome. A migration tool that answers only
the first is a load-testing tool.

The product must never report an outcome that is better than the worse of the two answers.

## 3. What the engine already records

Nothing in this specification requires a new kind of evidence. The engine already distinguishes every
case below; the outcome model was reading only some of it.

### 3.1 Per record — `migration_record_maps`

| Column              | What it settles                                                           |
| ------------------- | ------------------------------------------------------------------------- |
| `outcome`           | `CREATED` / `UPDATED` / `UNCHANGED` / `SKIPPED` / `FAILED` / `UNRESOLVED` |
| `writeState`        | whether the write's result is known at all                                |
| `deferredStatus`    | `PENDING` / `RESOLVED` / `FAILED` — the second pass that sets references  |
| `runAttempt`        | which attempt produced this row                                           |
| `reconcileEvidence` | what a reconciliation found, when one ran                                 |

### 3.2 Per record failure — `migration_errors`

`errorCode`, `message`, `field`, `severity`, `retryable`, `httpStatus`, `operation`, `sourceRecordId`,
`attempts`, `resolved`.

`severity` is the column this document turns on. See §4.

### 3.3 Per dataset — `migration_run_entities`

`total`, `processed`, `created`, `updated`, `unchanged`, `skipped`, `failed`, `unresolved`,
`deferredPending`, `deferredResolved`, `deferredFailed`, and the dataset's own `status`.

## 4. An unresolved lookup is not one thing

A reference the engine could not resolve has materially different consequences depending on what the
target says about the field. The engine already makes that distinction, at
`server/src/services/migration-engine.ts`, in the deferred reference pass:

```ts
severity:
  tAttr?.requiredLevel === 'None' || tAttr?.requiredLevel === 'Recommended'
    ? 'WARNING'
    : 'ERROR',
```

The target's own metadata decides. A required reference that cannot be set is an `ERROR`; an optional one
is a `WARNING`. That is the correct classification and it is not what this change alters.

The cases, and what each one means:

| Case                                    | Evidence                                          | Consequence                                                                     |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Reference set on the second pass        | `deferredStatus = RESOLVED`, no error row         | None. This is the normal path.                                                  |
| Still waiting for a later dataset       | `deferredStatus = PENDING`                        | None yet. The pass has not reached it.                                          |
| **Required** reference could not be set | `severity = ERROR`, `deferredStatus = FAILED`     | The record is in the target and is not valid against its own schema. A failure. |
| **Optional** reference could not be set | `severity = WARNING`, `deferredStatus = RESOLVED` | **The record is in the target and the relationship is gone.**                   |
| The deferred update itself was refused  | a `DEFERRED_UPDATE` error from the target         | A failure.                                                                      |

The fourth row is the hole. The deferred update completed without being refused, so the engine marked
the row `RESOLVED` — and `RESOLVED` is read by `refreshDeferredCounters` as `deferredResolved`, by
`runHadErrors` as nothing at all, and by the run as `Completed`.

`RESOLVED` is the wrong word for it. The pass ran; the reference was not resolved.

### 4.1 Two paths, and only one of them reaches the second pass

A reference is dropped in one of two places, and the difference is not visible to anybody reading the
result — but it decides which counter holds the evidence, so it is written down here.

| Where                        | When                                                                              | Recorded in                                 |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| While the record is prepared | the referenced record is not in the target and the plan never deferred this field | `migration_errors` only                     |
| On the second pass           | the plan deferred this field to break a dependency cycle                          | `migration_errors` **and** `deferredStatus` |

The common case is the first. Migrating Contacts without Accounts drops every parent reference at prepare
time: the field is left off the record, the record is written, a warning is recorded, and the second pass
never sees it — so `deferredIncomplete` stays at zero for that dataset.

Only a field the plan deliberately deferred reaches the second pass. Accounts reference each other, so
that lookup is deferred to break the cycle, and a hundred of them are set on the second pass.

This is why `MigrationRunDto.omittedReferences` is read from `migration_errors` and is the number the
product shows. It covers both paths. `deferredIncomplete` covers one of them, and presenting it as the
total would report zero for the exact run this document exists because of.

## 5. The change: one new record state, one new run outcome

The smallest correct model, and no more than that. No score, no percentage, no severity index — each
state below is a distinct thing the engine already knows, and nothing is introduced that the engine
cannot answer from a recorded row.

### 5.1 `deferredStatus` gains `INCOMPLETE`

```
RESOLVED    every deferred reference on this record was set
INCOMPLETE  the record is written, at least one optional reference was omitted, none were required
FAILED      a required reference was omitted, or the target refused the update
PENDING     the pass has not reached this record
```

`INCOMPLETE` is the state the engine was already describing in `migration_errors` and had nowhere to put
on the record. It is not a failure: the record is in the target and the write succeeded. It is not
resolved either.

`migration_run_entities` gains `deferred_incomplete` to count it, beside the three counters already
there.

### 5.2 `migration_runs.status` gains `COMPLETED_WITH_WARNINGS`

The full set, in order of how bad the result is:

| Status                    | When                                                                                                 | What it tells the reader                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `COMPLETED`               | nothing failed, nothing in doubt, nothing omitted                                                    | The target has what the source said.                                    |
| `COMPLETED_WITH_WARNINGS` | every record written, nothing failed, nothing in doubt, **and something was omitted or substituted** | The writes succeeded. The data is not complete.                         |
| `COMPLETED_WITH_ERRORS`   | any failed record, failed dataset, or unresolved `ERROR`                                             | Some records are not in the target, or are there and not valid.         |
| `NEEDS_RECONCILIATION`    | the outcome of any write is unknown                                                                  | Nothing can be claimed about those records until somebody settles them. |
| `FAILED`                  | the run itself could not proceed                                                                     |                                                                         |
| `CANCELLED`               | stopped by a person                                                                                  |                                                                         |

`COMPLETED_WITH_WARNINGS` is not a softer way of saying completed. It is a different claim: _the
migration ran without failing and did not carry everything_. A plan whose last run ended this way has
work left, and the workspace says so.

### 5.3 Exactly what triggers `COMPLETED_WITH_WARNINGS`

Derived at the end of a run, from recorded rows only:

```
warningsThatChangeTheData =
    count(migration_record_maps where deferredStatus = 'INCOMPLETE')
  + count(migration_errors where severity = 'WARNING'
          and resolved = false
          and errorCode in (MATERIAL_WARNING_CODES))
```

`MATERIAL_WARNING_CODES` is the set of warning codes that mean the target's data differs from the
source's _and nobody asked for it to_. It is a list, not a rule, because the decision belongs to each
code's meaning:

| Code                   | Why it changes the data                                         |
| ---------------------- | --------------------------------------------------------------- |
| `LOOKUP_UNRESOLVED`    | a relationship the source had is not in the target              |
| `PRINCIPAL_UNRESOLVED` | the owner was not carried across, and no replacement was chosen |

### 5.3.1 The test is not "is the data different"

It is **"was this asked for"**, and the distinction took a wrong first answer to find.

`PRINCIPAL_FALLBACK_APPLIED` is the case that settles it. The owner on the target record is not the owner
on the source record, which is a real difference — and it is also precisely what the plan was configured
to do: the fallback identity is named in the plan, the plan raises `PRINCIPALS_FALLBACK` as an issue, and
the person acknowledges it before the run starts. Counting it would mark every run into a tenant with no
user mapping as incomplete, for the rest of the project, for doing what it was told.

Nobody asks for a relationship to be dropped. Somebody does ask for unmapped owners to fall back to a
named identity. So the configured ones are listed too, in `CONFIGURED_WARNING_CODES`, rather than left as
an absence — the next person adding a warning code has to decide which of the two it is:

| Code                         | Why it does not change the outcome                                 |
| ---------------------------- | ------------------------------------------------------------------ |
| `PRINCIPAL_FALLBACK_APPLIED` | the identity was named in the plan and acknowledged before the run |
| `ALREADY_EXISTS`             | a match was found and the conflict strategy leaves a match alone   |

`LOOKUP_PENDING_MIGRATION` is in neither list, because a real run never produces it: it is a preflight
warning, raised when the referenced record will be created earlier in the run that follows.

Reporting a configured outcome as a degraded one would train people to ignore the result line, which is
worse than not reporting it at all.

### 5.4 What this does not change

- A warning is still never counted as a failure. `failed` means failed.
- An unresolved write is still never counted as a failure, and still blocks completion outright.
- `requiredLevel` still decides `ERROR` against `WARNING`. The target's schema is the authority on
  whether a missing reference is a failure.

## 6. Historical runs

A run that finished before this change has `status = 'COMPLETED'` and keeps it. The product will not
rewrite a stored outcome, and will not tell somebody that a migration they signed off six months ago had
an issue that nobody recorded at the time.

What it will do is read the evidence that _is_ there. The 270 `LOOKUP_UNRESOLVED` warning rows were
written by the engine at the time; they are a record, not an inference. So for any run, old or new, the
failure summary reports omitted references from `migration_errors`, and the run detail shows them.

The distinction in practice:

- **Stored status** — never recomputed. An old run reads `Completed`.
- **Recorded evidence** — always shown. The same old run shows `270 references omitted`, because that is
  what the engine wrote down.
- **`deferred_incomplete`** — `0` for every historical dataset, because the state did not exist when they
  ran, and `0` for plenty of current ones, because a reference dropped at prepare time never reaches the
  second pass (§4.1). It is not the number the UI shows, for both of those reasons.

Nothing is backfilled. A column that is zero because the run predates it is not evidence that nothing
was omitted, and the UI must not present it as though it were.

## 7. Counting, and what must never be collapsed

`Skipped` is currently one number covering several different things. They are not the same outcome and
the engine records which is which, so the number is split on read rather than left ambiguous:

| Shown as                     | From                                      | Means                                                              |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Already current              | `outcome = UNCHANGED`                     | A matching target record was found and its values already matched. |
| Not changed by this strategy | `outcome = SKIPPED` with `ALREADY_EXISTS` | A match was found; the conflict strategy leaves it alone.          |
| Excluded                     | `outcome = SKIPPED` with any other reason | Filtered out, or refused before the write.                         |

`Already current` is used only where `outcome = UNCHANGED`, which is the engine saying it compared and
found no difference. Where the engine skipped without comparing, the product does not claim the record
was already correct, because it does not know that.

## 8. The rule, in one sentence

> A run reports the worst outcome its own recorded evidence supports.

Not the best. Not the average. `failed == 0` is one input to that decision and has never been
sufficient on its own.
