# Crash consistency: the protocol

**Written for:** whoever has to trust that a migration interrupted half way through did not quietly
duplicate a customer's data, and whoever maintains the engine afterwards.

The objective is not "retry successfully". It is: **after a crash, never pretend to know something we
cannot prove — and never create a second record merely because we lost evidence of the first one.**

---

## 1. The operation sequence, as it actually is

Per table, per batch of up to 500 records (`options.batchSize`, capped at 500):

```
 1  read a page from the source                      (no persistence)
 2  alreadyHandled(ids)                              reads the identity map
 3  prefetch lookups and candidate target records    reads the target
 4  for each record, up to 4 concurrently:
 4a   prepare: transform values                      (pure)
 4b   match: find the existing target record         reads the target
 4c   decide: CREATE / UPDATE / SKIP / UNCHANGED     (pure)
 4d   ── TARGET WRITE ──────────────────────────     writes the CUSTOMER's database
 4e   result held in memory
 5  countTransformations                             (in memory)
 6  ── persistResults ────────────────────────────   writes OUR database (identity map)
 7  ── refreshCounters ───────────────────────────   writes OUR database (counters)
 8  heartbeat                                        writes OUR database
```

Four persistence boundaries matter: **4d** (the customer's database), **6**, **7** and **8** (ours).
There is no transaction spanning 4d and 6, and there cannot be: they are two different databases, and
two-phase commit across a customer's production database is not something this product will ask for.

### The failure matrix

| #   | Moment                                                | Target state                                | Our state                  | Before this work                            | Risk   |
| --- | ----------------------------------------------------- | ------------------------------------------- | -------------------------- | ------------------------------------------- | ------ |
| 1   | Before 4d                                             | unchanged                                   | nothing                    | Record re-processed on resume. Correct      | none   |
| 2   | 4d sent, client times out                             | **unknown**                                 | nothing                    | Marked `FAILED`, **retried**, may duplicate | **P0** |
| 3   | 4d commits, response lost (reset, 504 from a gateway) | written                                     | nothing                    | Same as 2                                   | **P0** |
| 4   | 4d commits, response received, crash before 4e        | written                                     | nothing                    | Record re-processed on resume               | **P0** |
| 5   | Crash between 4e and 6                                | written                                     | nothing                    | Record re-processed on resume               | **P0** |
| 6   | 6 commits, crash before 7                             | written                                     | identity row               | Counters stale, then rebuilt                | none   |
| 7   | Crash between 7 and 8                                 | written                                     | row + counters             | Heartbeat stale only                        | none   |
| 8   | Crash mid-batch (some records written, some not)      | partially written                           | nothing for the batch      | Whole batch re-processed                    | **P0** |
| 9   | Crash during a retry attempt                          | may be written twice already                | partial                    | Compounds 2–5                               | **P0** |
| 10  | Crash during the deferred-relationship pass           | base records written, lookups partially set | `deferredStatus = PENDING` | Pass resumes; updates are idempotent        | none   |

Boundaries 6, 7 and 8 were already safe, and not by luck: **counters are derived from the identity map
by `GROUP BY`, never incremented**, so any crash after 6 is repaired by the next `refreshCounters`. The
deferred pass is safe because setting a lookup to a known value is idempotent.

Everything between 4d and 6 was not safe, and rows 2 and 3 were not safe **even without a crash**.

### The second bug, which is worse than the first

Every Dataverse request — including a `POST` that creates a record — goes through `withRetry`, which
retries `TIMEOUT`, `NETWORK`, `THROTTLED` and 502/503/504. A create that **committed** and whose
response was lost was therefore retried immediately, inside one attempt, with no crash involved. A
single lost response produced two records.

Two symptoms, one root cause: **an ambiguous write outcome was treated as a definite failure, and the
operation was repeated.** A timeout does not mean the target rejected the write. It means we do not
know.

---

## 2. Strategies considered

### A — Write-ahead intent

Persist "about to write this" before the write; mark it confirmed after.

**What an intent proves after a crash: nothing about the target.** It proves only that we were about to
write, which is precisely the ambiguous state. Its value is not proof — it is the difference between
_no evidence at all_ (today: resume sees a new record and creates it) and _knowing which records are in
doubt_ (resume can reconcile or stop).

An intent is necessary and not sufficient. It must be paired with reconciliation.

### B — Deterministic idempotency through a stable key

Where the target has a reliable alternate or business key, a repeat can be an upsert instead of an
insert, and reconciliation is a key lookup. **This is the strongest path and it is used wherever it
exists** — but it does not exist everywhere, and requiring customers to add uniqueness constraints as
the price of safety is not acceptable as the only answer.

### C — A target-side marker

Write a correlation id into the customer's table so a row can be traced to a run and a source record.

**Rejected as a universal strategy.** It means adding a column to a customer's schema, which this
product will not do: the schema is theirs, a migration that alters it is a different product, and in
Dataverse it would mean a solution component. Retained only as an option a customer may _choose_ — if
they already have a spare text column, mapping the source id into it makes every record reconcilable,
and the readiness assessment can say so.

### D — Post-crash reconciliation

Before re-processing an uncertain record, ask the target whether it already has it, using only evidence
that identifies a record **uniquely**:

| Evidence                                | Available when                                                    |
| --------------------------------------- | ----------------------------------------------------------------- |
| Preserved source id                     | Same provider family and the target accepts client-generated keys |
| Alternate key                           | The target defines one and it is mapped                           |
| Business key                            | Configured on the plan and complete for the record                |
| A target id captured before the failure | The response arrived and was recorded                             |

Never a non-unique value. Two records with the same name are not evidence of anything.

### E — Connector-native idempotency

- **Dataverse** has upsert semantics on an alternate key (`PATCH .../entity(key='value')`), which is
  genuinely idempotent — a real mechanism, available only with an alternate key.
- **PostgreSQL / MySQL / SQL Server** have `ON CONFLICT` / `ON DUPLICATE KEY` / `MERGE`, each requiring a
  unique constraint to conflict against. No constraint, no mechanism.
- **Files** are never a target.

No connector offers idempotency without a key. Nothing here generalises from one to another.

---

## 3. The protocol

The smallest thing that is actually safe, in four parts.

### Part 1 — An ambiguous write is never a failure

The engine now classifies every write error as **definitely rejected** or **ambiguous**:

| Definitely rejected                                                                                 | Ambiguous                                       |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `VALIDATION`, `FORBIDDEN`, `NOT_FOUND`, `REFERENCE_NOT_FOUND`, `DUPLICATE_RECORD`, `READ_ONLY_MODE` | `TIMEOUT`, `NETWORK`, `SERVER_ERROR`, `UNKNOWN` |
| The server answered and said no. The record is not there                                            | We do not know whether it committed             |

A definite rejection is `FAILED`, as before. An ambiguous outcome is **`UNRESOLVED`**, which is a
different thing and is never retried blindly.

**And a non-idempotent write is no longer retried on an ambiguous error.** A create is attempted once;
if the outcome is ambiguous, it stays ambiguous. An _update_ is still retried, because re-applying the
same values to the same primary key is idempotent — the asymmetry is the point.

### Part 2 — Write-ahead intent, per batch, per record

`processBatch` is now _decide → record intent → act → record outcome_:

```
decide every record in the batch        (reads only)
insert one intent row per record that will write        ← one statement
perform the writes, 4 at a time
update those rows with their outcomes                  ← one statement
```

Two statements per batch where there was one. Intents are written only for records that will actually
write — a `SKIP` or an `UNCHANGED` touches nothing, so it needs no intent.

### Part 3 — Reconciliation on resume

A row left `INTENDED` is a record that may or may not be in the target. Before anything else, resume
reconciles every one of them:

```
for each INTENDED row:
    is there evidence that identifies this record uniquely?
        no  → RECONCILIATION_REQUIRED. Stop the table.
        yes → ask the target
                found     → CONFIRMED; outcome becomes what the intent said (CREATED / UPDATED)
                not found → the write did not commit. Safe to re-process
```

Reconciliation is itself idempotent: running it twice reaches the same conclusion, and a crash during
reconciliation leaves the rows exactly as it found them.

### Part 4 — Stop rather than guess

When a record is `INTENDED`, the target assigned its own key, and no unique key is mapped, **there is no
evidence and the ambiguity is irreducible.** The run stops with
`RECONCILIATION_REQUIRED`, naming every affected record, and will not start again until a human resolves
it. A migration that stops is better than one that silently doubles a customer's table.

This is not a gap in the protocol. It is the honest answer to a question that has no automatic answer.

---

## 4. States

`outcome` keeps its five business values and gains a sixth; a new `writeState` column tracks the
crash-consistency state. They answer different questions: _what happened to this record_ and _do we know
that_.

```
writeState:   (none) ──intent──▶ INTENDED ──confirmed──▶ CONFIRMED
                                    │
                                    ├──ambiguous error──▶ UNKNOWN
                                    │
                                    └──reconciliation──▶ CONFIRMED        (found in target)
                                                       ├─ (none)          (not found: re-processable)
                                                       └─ RECONCILIATION_REQUIRED  (no evidence)

outcome:      CREATED · UPDATED · UNCHANGED · SKIPPED · FAILED · UNRESOLVED
```

`UNRESOLVED` is **non-terminal**: it means the outcome is not yet known, not that it failed. It is
resolved by reconciliation or by a person, never by assumption and never by time passing.

**The invariant**, enforced in code and asserted by test:

> A record whose `writeState` is `INTENDED`, `UNKNOWN` or `RECONCILIATION_REQUIRED` is never re-written,
> and a run cannot reach `COMPLETED` while any of its records is in one of those states.

---

## 5. Per connector

| Target         | Preserved primary key                                                                                         | Alternate / business key                                                   | Target-generated key + unique key     | Target-generated key, no unique key |
| -------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------- |
| **PostgreSQL** | Reconcile by primary key                                                                                      | Reconcile by key; `ON CONFLICT` available                                  | Reconcile by the unique key           | **RECONCILIATION REQUIRED**         |
| **SQL Server** | Reconcile by primary key                                                                                      | Reconcile by key; `MERGE` available                                        | Reconcile by the unique key           | **RECONCILIATION REQUIRED**         |
| **MySQL**      | Reconcile by primary key                                                                                      | Reconcile by key; `ON DUPLICATE KEY` available                             | Reconcile by the unique key           | **RECONCILIATION REQUIRED**         |
| **Azure SQL**  | As SQL Server by design. Not verified                                                                         | As SQL Server by design. Not verified                                      | As SQL Server by design. Not verified | **RECONCILIATION REQUIRED**         |
| **Dataverse**  | Reconcile by GUID — the strongest case, because a client-generated GUID makes the create naturally idempotent | Reconcile by alternate key; upsert on alternate key is natively idempotent | Reconcile by the alternate key        | **RECONCILIATION REQUIRED**         |
| **Files**      | Never a target                                                                                                |                                                                            |                                       |                                     |

Dataverse is designed for, not verified. The harness is written and waiting for an environment; until a
recorded run exists, every Dataverse row above is a design claim.

---

## 6. Batch or record

Measured rather than assumed — see the performance section of the final report.

**Chosen: intents written per batch, in one statement, with per-record rows.** Recovery precision is
per record (every row names its own source id and its own state), auditability is per record, and the
cost is one extra statement per batch rather than one extra round trip per record.

The trade accepted: after a crash, every record in the in-flight batch is `INTENDED`, not only the four
that were truly mid-write. That is the same window size as before — the difference is that it is now
_known_ rather than invisible. Where a key exists, all of them reconcile automatically in one batched
lookup. Where no key exists the run stops regardless, and stopping over 500 records rather than 4 makes
no practical difference to the person who has to resolve it.

---

## 7. Metrics

Unresolved records are not hidden to keep the old arithmetic tidy. The equations gain a term:

```
processed     = created + updated + unchanged + skipped + failed + unresolved
writtenByRun  = created + updated                        (unresolved is NOT written: we do not know)
accountedFor  = processed
```

`unresolved` appears in the run DTO, on the run screen, in `metrics.csv`, in lineage and in the evidence
package. A run with unresolved records cannot report `COMPLETED`.

---

## 8. Validation

A validation whose run has unresolved records **cannot report `PASS`**, however well the known records
match. Completeness is not provable while the fate of a record is unknown, and that is a statement about
the migration rather than about the comparison.

Coverage treats them as what they are: an unresolved record is not eligible for comparison (there may be
nothing to compare), and the eligible count says so. The verdict is `FAIL` with a message naming the
count, because a migration whose outcome is unknown for even one record has not been shown to have
worked.
