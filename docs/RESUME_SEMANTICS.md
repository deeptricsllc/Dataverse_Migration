# Resume, attempts, and the one boundary with no transaction across it

What a resumed migration means, what its numbers count, and the one place where the platform can be
wrong about a customer's target. Everything here is demonstrated by
`tests/integration/chaos-resume.test.ts`, which injects failures at known points rather than waiting
for them.

## The semantic model

Four things get confused in migration tooling, so they are named here.

| Concept            | In this platform                                                                                  | Identified by                                    |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Migration**      | A plan executed against an environment pair.                                                      | `migration_plans.id`                             |
| **Run**            | One logical migration of that plan. The unit every screen, report and evidence package describes. | `migration_runs.id`                              |
| **Attempt**        | One execution of that run. A retry is a new attempt of the _same_ run, not a new run.             | `migration_runs.attempt` (an integer on the run) |
| **Record attempt** | How many times one record has been processed across all attempts.                                 | `migration_record_maps.attempts`                 |

**All reported metrics are per Run, cumulative across attempts.** A record created in attempt one and
matched in attempt two is one record, counted once, as `created`. The identity map is keyed
`(runId, logicalName, sourceId)` with one row per source record for the life of the run, so the
accounting identities hold over the run regardless of how many attempts it took:

```
processed = created + updated + unchanged + skipped + failed
writtenByRun = created + updated
```

This is deliberate and it is the right default: a migration lead asking "what happened to our
customer table" means the run, not the last attempt. The cost is that **per-attempt figures are not
reported**. `attempt` says how many there were and the audit trail says when each was requested, but
"what did attempt two do on its own" is not a question the product answers today. That is a
limitation, not an ambiguity — nothing in the product presents an attempt figure as a run figure.

`resume` (after a pause) does not increment `attempt`; `retry` (after a failure) does. Both are
recorded in the audit trail as `MIGRATION_RESUMED` and `MIGRATION_RETRY_REQUESTED`, and the original
`MIGRATION_EXECUTION_REQUESTED` appears exactly once however many attempts follow.

## What resume is safe about

Proven by the chaos suite:

- **Completed batches are not re-done.** Records already claimed by the run are skipped by
  identifier, not re-read and not re-written. A failure part-way through a multi-batch table resumes
  from the remaining scope, and the persisted work is always a whole number of batches.
- **Updates are not duplicated or invented.** A second pass over a populated target with one changed
  source record produces exactly one update; the rest stay `unchanged` rather than becoming false
  updates. Interrupting the update pass and resuming still produces exactly one.
- **The deferred relationship pass resumes cleanly.** Base records keep the target identifiers they
  already had, lookups that could not be written are still marked `PENDING` with the columns they are
  waiting on, and a pass that fails twice leaves them outstanding rather than marking them resolved.
  Nothing is written off.
- **Unretried transient failures are safe.** Automatic retry belongs to the connector (the Dataverse
  connector honours `Retry-After`). Past that budget a write becomes a `FAILED` record that claims no
  target identifier, is recorded as retryable, and is recovered by a retry without touching the
  records that succeeded.
- **An interrupted validation cannot report PASS.** It has a status of its own and no verdict.

One property that is _not_ true, and should not be asserted: "resume does not write to a record it
already claimed". The deferred pass is supposed to come back to a claimed record and fill in its
lookups. The correct property is that resume never _creates_ a claimed record again.

## P0 — the target-write / identity-map boundary

**Target writes and identity-map writes are two systems, in that order, with no transaction across
them.** Per batch:

1. each record is written to the target, four at a time;
2. once the batch finishes, one identity row per record is written to the platform database.

A process that dies between them leaves **up to one batch of records in the customer's target that
the platform has no row for**. The chaos suite measures this window: after an injected fatal failure
mid-batch, records are in the target and the identity map holds zero rows for them.

Recovery depends entirely on whether the configured match strategy can find those records again:

| Configuration                                                                         | On resume                                    | Outcome                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ids preserved (same provider, target accepts client-generated keys)                   | Matched on the record id                     | **Safe.** Re-matched, not re-created.                                                                                                                                       |
| `ALTERNATE_KEY`, or `BUSINESS_KEY` with a complete key                                | Matched on that key                          | **Safe.**                                                                                                                                                                   |
| `PRIMARY_ID` + target assigns its own key + target table **has** a unique constraint  | The re-create is refused by the target       | **Wrong, visibly.** Records are reported `FAILED` although they are present and correct in the target. The run cannot complete; the evidence understates what was migrated. |
| `PRIMARY_ID` + target assigns its own key + target table has **no** unique constraint | Nothing matches; the record is created again | **Wrong, invisibly.** Duplicates in the target. The run reports `COMPLETED` with zero failures, and the platform's own records are perfectly self-consistent.               |

The last row is the P0. It is reproduced in
`tests/integration/chaos-resume.test.ts` → _"creates a duplicate when the target assigned the key and
nothing can match it"_, which asserts the duplicate count rather than being written to pass.

**What prevents it today:** nothing in the platform. The protection in the third row is the
_target's_ uniqueness constraint, which is the target's property and not something the platform may
assume. There is no write-ahead intent record, so a resumed run cannot distinguish "never written"
from "written and unrecorded".

**Scope of exposure.** It requires all of: a failure in the window between a target write and the
batch's identity-map write; `PRIMARY_ID` as the match strategy; and a target that assigns its own
keys. `PRIMARY_ID` is the default only when the table has no shared alternate key, and a target that
assigns its own keys is the ordinary case for SQL identity columns and for Dataverse when no id is
supplied — so the combination is reachable with default settings on a real plan.

**Mitigations available now, in order of preference:**

1. **Configure `ALTERNATE_KEY` or `BUSINESS_KEY` for every table whose target assigns its own keys.**
   This closes the gap completely and costs nothing. A pre-migration readiness check should raise it.
2. Prefer a target that accepts client-generated identifiers where the choice exists, which makes the
   record id itself the recovery key.
3. After any interrupted run on a `PRIMARY_ID` table, reconcile the target record count against the
   identity map before retrying. A difference is the size of the orphaned window.

**What a fix would look like**, for a later phase and deliberately not attempted here: a write-ahead
intent row per record before the target write, cleared when the identity row is written. On resume,
an outstanding intent means "this record may already be in the target" — which turns an invisible
duplicate into an explicit finding a human can resolve. That is a change to the most load-bearing
path in the product and belongs in its own phase with its own evidence, not bolted onto this one.

## How to reproduce any of this

```
npx vitest run tests/integration/chaos-resume.test.ts
```

The failures are injected by wrapping the target connector so that the Nth write throws — the same
error the engine treats as fatal, which is the closest a test gets to the process dying. Nothing is
random, so a failure here is a real change in behaviour rather than a flake.
