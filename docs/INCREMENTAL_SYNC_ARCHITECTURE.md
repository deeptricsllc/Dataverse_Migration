# Incremental sync — change detection, watermarks and drift

> **Status: NOT IMPLEMENTED.** This document describes future work. Nothing in it exists in this
> repository today. There is no change feed, no watermark table, no incremental preflight and no
> scheduled sync. Every migration and every preflight performed by this product today is a **full**
> comparison, and that is the only mode the engine knows. Treat this as a design proposal to be
> reviewed, not as a description of the product.

**Audience:** the engineers who will build this, and whoever has to decide whether the design is
sound before that happens.

---

## 1. What happens today

For every table in the plan, in dependency order, the engine (`migration-engine.ts`) and the
preflight (`preflight-service.ts`) do the same thing, through the same shared decision code:

1. Page the entire selected source table (`queryRecords`, ordered by primary key, page size =
   batch size).
2. Resolve lookups in batches through the identity map, earlier runs for the same environment pair,
   then the target itself.
3. Match each source record against the target deterministically (`record-matcher.ts`): identity
   map → primary id → active alternate key → configured business key. Two candidates is a
   `CONFLICT`, never a guess.
4. Classify it (`record-planner.ts`): `CREATE`, `UPDATE`, `UNCHANGED`, `CONFLICT` or `BLOCKED`.
5. Write only what the classification says to write. Under `SYNC`, only the columns whose
   normalized values differ are written, and an identical record is recorded as `UNCHANGED` with no
   write at all, so `modifiedon` / `modifiedby` in the target stay untouched.

This is correct, and for a first sync it is exactly what you want: there is no prior state to trust,
so reading everything is not waste, it is the job. It is also what makes the product's central
promise verifiable — the preflight can say precisely what will happen because it performed the same
comparison the run will perform.

### 1.1 Cost model

| Dimension         | Scales with                              | Today                                                                      |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| Source reads      | **Total source rows selected**           | Every row, every run                                                       |
| Target reads      | **Total source rows** (batched matching) | Batched `In` queries plus field reads for `SYNC`                           |
| Writes            | **Actual differences**                   | Zero writes for unchanged records — this guarantee already holds and stays |
| Identity map rows | Total source rows                        | One row per (run, table, source id)                                        |
| Wall clock        | Total source rows                        | Dominated by reads and by Dataverse service protection limits              |
| Correctness       | —                                        | Highest possible: nothing is assumed, everything is observed               |

The zero-write guarantee is the part customers notice, and it is not what this document changes.
What it changes is the read cost, which today is paid in full whether one row changed or none did.

## 2. Where this stops being acceptable

**Worked example.** A customer syncs an `Order` table nightly. It holds 10,000,000 rows. Yesterday
5,000 of them changed.

| Mode                    | Source rows read | Target lookups | Rows written | Rough wall clock         |
| ----------------------- | ---------------- | -------------- | ------------ | ------------------------ |
| Full comparison (today) | 10,000,000       | 10,000,000     | 5,000        | Hours, every night       |
| Incremental (proposed)  | ~5,000           | ~5,000         | 5,000        | Seconds to a few minutes |

That is roughly 2,000 rows examined per row that needed writing, repeated every night forever. The
consequences are not just "slow":

- **Throttling.** Dataverse service protection limits are per user. A nightly full scan of several
  large tables spends its budget on rows that did not change, and starves the runs that matter.
- **Windows.** A sync that takes six hours cannot run hourly, so the product's freshness is bounded
  by its read cost rather than by the customer's need.
- **Cost.** Reads against the source (and any egress) are paid per run.
- **Failure surface.** A six-hour run has six hours in which to be interrupted. Short runs fail less
  because they are short.
- **Storage.** A full identity-map write per row per run grows the database in proportion to table
  size rather than to change.

Incremental sync is therefore a scaling feature, not a correctness feature. It must never buy speed
with correctness, which is what §6 exists to prevent.

## 3. The three change-detection sources

There is no single mechanism. Each of the three has different semantics, different prerequisites,
and — most importantly — a different way of failing.

### 3.1 SQL Server Change Tracking

The lightweight option, and the default choice for SQL sources.

- **Enable at two levels.** Once per database, with a retention period
  (`SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 7 DAYS, AUTO_CLEANUP = ON)`), then once per table
  (`ENABLE CHANGE_TRACKING`). Both are customer DDL: we detect it and report what is missing, we do
  not enable it ourselves.
- **What you get.** `CHANGETABLE(CHANGES <table>, @last_version)` returns the **primary keys** of
  rows that changed since a version, plus the operation (`I`/`U`/`D`) and optionally which columns
  were updated. It does **not** return column values: you join back to the base table to read the
  current row. A row changed five times since the watermark appears once, with its current state —
  which is exactly what a sync wants.
- **The version number is the watermark.** `CHANGE_TRACKING_CURRENT_VERSION()` is taken _before_
  reading, and becomes the next watermark only once the changed set has been applied (§5.3).
- **The failure mode that matters: retention.** Change tracking data is cleaned up after the
  retention period. If our stored watermark is older than
  `CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('<table>'))`, the database can no longer tell us what
  changed — not "nothing changed", but "the answer is gone". A sync that was paused for a long
  weekend, a table whose retention is two days, a restored database, a failover to a replica with a
  different version space: all land here. The **only** correct response is a full pass, announced
  (§5.4). Silently continuing from an invalid version means silently missing rows, which is the one
  outcome this product must never produce.
- **Cost.** Low. Tracking is written as part of the transaction; there is no log reader and no
  agent job.

### 3.2 SQL Server Change Data Capture (CDC)

The heavier option, and the right one when you need the _history_ rather than the current state.

- **What you get.** Capture tables holding the changed **column values** and the operation
  (`__$operation`: delete / update-before / update-after / insert), read through
  `cdc.fn_cdc_get_all_changes_*` or `fn_cdc_get_net_changes_*` over an LSN range.
- **Prerequisites.** Enabled per database and per table via `sys.sp_cdc_enable_db` /
  `sys.sp_cdc_enable_table`, and — on a self-hosted SQL Server — it depends on **SQL Server Agent**
  running the capture and cleanup jobs. If Agent is stopped, capture silently falls behind. Edition
  and platform availability differ (notably between SQL Server editions, Azure SQL Managed Instance
  and Azure SQL Database); verify against current Microsoft documentation for the customer's exact
  platform before promising it.
- **Cost.** Meaningfully higher than change tracking: a log reader, extra storage for the capture
  tables, cleanup jobs, and DBA attention. Retention (a few days by default) has the same
  too-old-baseline failure as change tracking.
- **Our position.** We do not need before-images to sync, so CDC is not the primary mechanism. It
  becomes interesting for column-level auditing, for capturing intermediate states, and for tables
  where change tracking is unavailable but CDC already exists.

### 3.3 Dataverse change tracking (delta links)

- **Enable per table.** Change tracking is a property on the table in Dataverse; it is off by
  default on most tables and is the customer's setting to turn on.
- **What you get.** A query sent with `Prefer: odata.track-changes` returns an `@odata.deltaLink`
  alongside the results. Re-issuing that link later returns only what changed since, including
  markers for **deleted** records — which is a capability the full comparison does not have at all
  (§4 of this document's ordering: see §6).
- **The failure mode that matters: token expiry.** A delta token is only valid while the
  corresponding change history is retained; an expired or otherwise invalid token is rejected by the
  service, and the only recovery is to re-issue the tracked query without the link — a full pass —
  and take a fresh token. Same rule as SQL: announce it, do not paper over it.
- **Caveats to design around.** The column selection is part of the tracked query, so changing the
  mapped column set invalidates the assumption behind the token (§6.4). Delta responses page like
  any other Dataverse query. The precise retention and error codes should be verified against
  current Microsoft documentation and against a real tenant before this ships — this repository is
  explicit that its Dataverse behaviour is written from documentation and not yet certified.

### 3.4 Summary

| Source                | Granularity                | Gives values? | Gives deletes? | Enablement         | Main failure mode           |
| --------------------- | -------------------------- | ------------- | -------------- | ------------------ | --------------------------- |
| SQL Change Tracking   | Row keys + operation       | No (re-read)  | Yes (key only) | DB + table DDL     | Retention → invalid version |
| SQL CDC               | Column values + operation  | Yes           | Yes            | DB + table + Agent | Agent stopped; retention    |
| Dataverse delta links | Changed records + removals | Yes           | Yes            | Per-table property | Token expiry / invalidation |
| `modifiedon` polling  | Rows above a timestamp     | Yes           | **No**         | None               | Clock skew; misses deletes  |

The fourth row is the last-resort fallback for a table nobody will enable tracking on. It is honest
only if the UI is honest about it: it cannot see deletes, and it trusts a clock we do not own.
`rowversion` columns on SQL sources (already captured as `isRowVersion` in the normalized metadata)
are the SQL equivalent, with the same blind spot.

## 4. The `ChangeFeed` abstraction

The engine must not know which of the four it is talking to, in the same way it does not know which
provider it is writing to. One interface, four implementations, and a watermark it treats as opaque.

```ts
/** Opaque to everything except the implementation that issued it. */
export interface Watermark {
  kind: 'sql-change-tracking' | 'sql-cdc' | 'dataverse-delta' | 'timestamp';
  /** The version, LSN, delta link or timestamp, serialized. Never parsed by callers. */
  token: string;
  issuedAt: string;
  /** Column set the token was issued for; a change here invalidates it (§6.4). */
  columnsHash: string;
}

export interface ChangedKey {
  id: string;
  operation: 'UPSERT' | 'DELETE';
}

export interface ChangeFeed {
  readonly kind: Watermark['kind'];

  /** Is this table actually tracked right now? Reported in preflight, never assumed. */
  status(
    table: TableMetadata,
  ): Promise<{ tracked: true } | { tracked: false; reason: string; resolution: string }>;

  /** Take a watermark to resume from later. Called BEFORE reading the changed set. */
  current(table: TableMetadata): Promise<Watermark>;

  /**
   * Changed keys since `since`, in batches.
   * Throws `WatermarkInvalidError` when the baseline is too old, expired or unusable —
   * the caller must then fall back to a full pass and say so (§5.4).
   */
  changesSince(table: TableMetadata, since: Watermark): AsyncGenerator<ChangedKey[]>;
}
```

The feed produces **keys**, not decisions. Once the changed set is known, the existing pipeline runs
unchanged: `retrieveByIds` for the rows, then the same lookup resolution, the same
`RecordMatcher.match`, the same `decideAction`. Incremental mode narrows the input set. It does not
get its own opinion about what should be written, and it must not acquire one.

### 4.1 Where the watermark lives

A new table, alongside the identity map rather than inside it:

| Column                               | Meaning                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `organization_id`                    | Tenant scoping, like every other table                                  |
| `environment_id`                     | The **connection** the watermark belongs to (source side)               |
| `logical_name`                       | The table                                                               |
| `feed_kind`                          | Which mechanism issued it                                               |
| `token`, `issued_at`, `columns_hash` | The serialized `Watermark`                                              |
| `status`                             | `VALID` / `EXPIRED` / `UNKNOWN`                                         |
| `last_full_pass_at`                  | When this table was last compared in full (drives reconciliation, §6.1) |
| `last_advanced_at`, `last_run_id`    | Provenance, for the run history and for debugging                       |

Unique on `(organization_id, environment_id, logical_name, feed_kind)`.

**The watermark is per (connection, table) and says nothing about any target.** "What changed in the
source since X" and "what has been applied to this target" are different facts:
`migration_record_maps` answers the second and remains the source of truth for it. Conflating them —
one watermark per environment pair — would mean a second target silently inheriting the first
target's progress. Don't.

## 5. Running an incremental pass

### 5.1 Mode selection, per table

Per table, not per run: one plan can legitimately contain a small reference table that is always
compared in full and a 10M-row transaction table that is not.

```
for each table in dependency order:
  watermark = load(connection, table)
  if no watermark            -> FULL  (reason: FIRST_SYNC)
  else if not feed.tracked   -> FULL  (reason: TABLE_NOT_TRACKED)
  else if columnsHash differs-> FULL  (reason: COLUMN_SET_CHANGED)
  else if forced by plan     -> FULL  (reason: RECONCILIATION | OPERATOR_REQUESTED)
  else                       -> INCREMENTAL
                                 └─ WatermarkInvalidError at read time
                                    -> FULL (reason: WATERMARK_EXPIRED), announced
```

### 5.2 The incremental pass itself

1. `next = feed.current(table)` — take the new watermark **first**, so changes committed while we
   read are caught by the _next_ run rather than lost between the two.
2. Stream `feed.changesSince(table, stored)` in batches.
3. For `UPSERT` keys: `retrieveByIds` the current rows, then the unchanged pipeline.
4. For `DELETE` keys: record them (§6), never delete in the target.
5. Persist results and the identity map exactly as today.
6. Only when the whole table has been processed: store `next` as the new watermark.

### 5.3 Idempotency and resumability

Step 6 is the rule: **the watermark advances at table completion, never mid-stream.** A crash, a
pause, a cancelled run or a lost agent means the next attempt replays from the old watermark and
re-examines rows that were already applied. That is cheap and it is safe, because replay produces
`UNCHANGED` for anything already correct — the same property that makes a re-run of a full migration
a no-op today. Advancing the watermark per batch would make a mid-table crash lose the un-applied
remainder, which is precisely the silent data loss this design exists to avoid.

In-flight progress within a table still uses the mechanism that already exists: source ids present
in `migration_record_maps` for the run are skipped on resume.

### 5.4 When the watermark is invalid, say so loudly

An invalid, expired or missing watermark is **never** a reason to skip work, and never a silent
event. It must produce, in this order: a full pass for that table; a `mode: FULL` with an explicit
reason code on the run and on the table; a visible banner in the run monitor and the preflight
("Full comparison — the change baseline for `Order` had expired"); an audit event; and the reason
carried into the CSV exports.

The governing rule, worth repeating in code comments: **when in doubt, do more work, not less.** An
unnecessary full pass costs time. A skipped one costs correctness, and it costs it invisibly.

## 6. Deletes

A full comparison walks the source and asks "does this exist in the target?". It has no way to
notice a source record that no longer exists — absence is not something you encounter while
iterating. A change feed, by contrast, reports deletions explicitly. **Incremental sync is the first
time this product can see a delete at all.**

The current product never deletes in the target, and that is deliberate, not an oversight: rollback
execution is intentionally unsupported because it needs before-images and cascade analysis, and a
delete is the one operation validation cannot undo or even fully describe afterwards. A source
record may also be absent for reasons that are not a deletion — a filter change, a security
trimming, a failed replication upstream.

Proposed, in order, and no faster:

| Stage                     | Behaviour                                                                                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase A — report only     | Deletions are recorded (`source_deleted_at` on the identity-map row) and surfaced as a **Deletions report** with a CSV export. The target is untouched. Default, forever, unless the customer opts out of the default.                                          |
| Phase B — opt-in soft     | Per table, explicitly enabled: mark the target record instead of removing it (`statecode` inactive on Dataverse, or a mapped flag column). Preflight shows the exact list and count; execution requires a separate acknowledgement, like `FALLBACK` does today. |
| Not planned — hard delete | Out of scope until rollback has before-images and cascade analysis. If it is ever built, it needs its own review, not a checkbox.                                                                                                                               |

No cascade, ever, in any phase. A soft-delete that quietly deactivates dependent records is a hard
delete wearing a disguise.

## 7. Correctness rules that must not be broken

1. **Target drift is invisible to a change feed.** A source row that has not changed since the
   watermark, whose _target_ copy was edited by a user, will never appear in any feed. Incremental
   sync therefore cannot be the only mode: a **periodic full reconciliation** (default: weekly, or
   every Nth run, configurable per table, tracked by `last_full_pass_at`) restores the guarantee.
   The validation service already performs normalized field-level comparison — reconciliation should
   reuse it rather than grow a second implementation. A customer who disables reconciliation must be
   told, in the UI, what they have given up.
2. **The identity map stays the source of truth.** A change feed narrows the candidate set. It never
   decides which target record a source record maps to, never substitutes for `RecordMatcher`, and
   never authorizes a write that the full path would have classified as `CONFLICT` or `BLOCKED`.
3. **Incremental runs are resumable and idempotent, exactly like full ones.** Same pause/resume,
   same retry semantics, same skip-what-succeeded behaviour, plus §5.3's advance-at-completion rule.
4. **A mapped column-set or schema change forces a full pass** for that table. Rows that never
   changed may still need the new column written, and no feed will mention them. `columns_hash`
   exists for exactly this.
5. **Mode is recorded and reported per table.** A run's counters are meaningless without it, and a
   mixed run (some tables full, some incremental) must not present a single undifferentiated total.
6. **Nothing about the zero-write guarantee changes.** Unchanged records are still never written,
   and `modifiedon` / `modifiedby` in the target still stay untouched.

## 8. What this does to preflight

Today a preflight streams the whole source and classifies every record, so "1,204 CREATE, 60
UPDATE, 9,000 UNCHANGED" is a statement about the entire table. An incremental preflight analyses
only the changed set, so the same shape of numbers means something different: "of the 5,000 records
that changed since 03:00 yesterday, 60 would be updated". The UNCHANGED count, in particular, stops
being a statement about the table at all.

That is a reporting problem before it is an engineering one. The requirements:

- Every preflight result carries its `mode` (`FULL` / `INCREMENTAL`), the reason code if it fell
  back, the watermark timestamp it analysed from, and `scannedRows` alongside the table's total row
  count.
- The UI labels it unmistakably: "Incremental — 5,000 of ~10,000,000 records changed since
  2026-09-16 03:00" versus "Full comparison — all 10,000,000 records examined". No screenshot of a
  preflight should ever be ambiguous about which question it answered.
- CSV exports, including the remediation package, gain a mode/reason column. The exports are
  evidence; evidence has to state its own scope.
- A per-table breakdown, because a mixed run is normal.
- An incremental preflight cannot report target drift (rule 1). It must say so rather than implying
  the target is clean.

## 9. Delivery plan

Estimates are engineer-weeks for one engineer already familiar with this codebase.

| Phase | Scope                                                                                                                                                                                                                                                             | Est.   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1     | Watermark plumbing: the table, the `ChangeFeed` interface, per-table mode selection, reason codes, forced-full fallback, mode surfaced in run/preflight/UI/exports. No real feed yet — mode is always `FULL`, but the reporting is honest and the seam is proven. | 2–3 wk |
| 2     | SQL Server Change Tracking feed: detection of enablement, `CHANGETABLE` reads, min-valid-version handling, retrieve-by-key path, deletions recorded as a report, tests covering expiry and replay.                                                                | 3–4 wk |
| 3     | Dataverse delta links: per-table tracking detection, `odata.track-changes`, delta link storage, expiry → full fallback, deleted-record markers, plus `modifiedon` polling as the labelled last resort.                                                            | 3–4 wk |
| 4     | Scheduled syncs and drift reconciliation: a schedule per plan, `last_full_pass_at`-driven periodic full passes, reconciliation reusing the validation comparison, deletions report, and the sync-history view.                                                    | 4–5 wk |
| Later | CDC feed, opt-in soft deletes (phase B above), per-table schedules, change-driven triggers.                                                                                                                                                                       | —      |

Phase 1 is worth shipping alone. It makes the product honest about which mode produced a number,
which is a prerequisite for every phase after it.

### Deliberately out of scope

- **Hard deletes in the target**, in any phase (§6).
- **CDC** as a first-class feed. Designed for, not built.
- **Real-time / streaming sync.** The unit of work stays a run. Sub-minute latency is a different
  product.
- **Bidirectional sync.** One direction, one source of truth. Two-way merge needs conflict
  resolution semantics this product deliberately does not have — it reports conflicts, it does not
  resolve them.
- **Enabling change tracking on the customer's behalf.** We detect it, we explain how to enable it
  in the remediation package, we do not issue DDL against a customer's database.
- **Schema-change replication.** A new source column still requires a plan and mapping change.
- **Incremental validation.** Validation stays full-scope until it has been thought about properly;
  a validation report over a changed subset is a different claim from the one it makes today.

## 10. Shortcuts considered and rejected

| Shortcut                                                       | Why not                                                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diff by hashing every row and comparing hashes                 | Still reads every row on both sides. Saves write decisions, not read cost — which is the cost that matters here.                                                                       |
| Cache the last-seen hash per record in our database            | Turns our database into a shadow copy of the customer's data, grows with total rows rather than change, and goes stale invisibly whenever a run is interrupted.                        |
| Install our own triggers / change tables in the source         | DDL in a customer's production database, owned by us, that breaks their deployments and their DBA's trust. Never.                                                                      |
| `modifiedon` / `rowversion` polling as the primary mechanism   | Cannot see deletes, trusts a clock or a version space we do not own, and misses rows updated by processes that do not stamp the column. Acceptable only as a labelled fallback (§3.4). |
| Trust the previous run's end time as a watermark               | Assumes no clock skew, no long-running transactions, no retries and no partial runs. All four happen.                                                                                  |
| Skip reconciliation because the feed "should" catch everything | A feed reports source changes. Target drift is not a source change. Rule 1 exists because this shortcut is the tempting one.                                                           |
