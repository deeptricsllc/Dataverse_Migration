# Audit readiness

A read-only assessment of what the audit trail records today, what it cannot answer, and the order in
which to fix that. Nothing here is implemented yet.

The question this assessment is written against is not "does the product have an audit table" — it has
one, and it is used. It is **"can somebody who was not here reconstruct what happened, and prove it?"**
Those are different questions, and the gap between them is where the work is.

## What exists

| Capability                 | State                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One trail, one table       | `audit_events`, indexed on `(organization, created_at)` and `(project, created_at)`                                                                                            |
| Event shape                | organization, actor, action, outcome (`SUCCESS` / `FAILURE` / `REQUESTED`), source and target environment, run, project, request id, free-form `details`, timestamp            |
| Vocabulary                 | 61 named actions, as a union type rather than free strings                                                                                                                     |
| Migration lifecycle        | plan created and updated, execution requested, completed, cancel / pause / resume / retry requested, reconciled, readiness blocker overridden and withdrawn, preflight, bypass |
| Validation lifecycle       | requested, completed, failed, evidence exported                                                                                                                                |
| Rules changed              | object mapping, choice mapping, transformation, principal mapping, table category, lossy acknowledgement, plan options                                                         |
| Evidence leaving           | evidence package exported and verified, mapping workbook exported and imported, validation summary and findings exported                                                       |
| Write safety               | `READ_ONLY_WRITE_BLOCKED`, `CERTIFICATION_WRITE_PERMITTED`                                                                                                                     |
| Secrets                    | the scrubber used for logs and error responses runs over every string on the way in (`docs/SECURITY_AUDIT.md`, P2, fixed)                                                      |
| Immutability               | nothing in the codebase updates or deletes a row — append-only in practice, though not enforced by the database                                                                |
| A destination, not a panel | `/audit`, with filters for category, outcome, user, free text and days                                                                                                         |

That is a real audit trail, and most of this gate's work is not adding events. It is making the ones
that exist answerable.

## What it cannot answer

### P0

**1. Who was let into the workspace is not recorded.**
`server/src/services/access-request-service.ts` contains no audit call. Requesting access, granting it
and marking a request handled all leave nothing behind. Access decisions are the first thing an auditor
asks about, and they are the one category of action here with no trail at all. `TEAM_ROLE_CHANGED`
records a role change _after_ somebody is in; nothing records how they got in.

### P1

**2. Filtering and counting happen in memory, over the most recent 2,000 events.**
`MAX_SCANNED = 2000` in `audit-service.ts`. Category, user and free-text filters are applied after that
scan, so a workspace with more than two thousand events cannot answer "show me every role change"
truthfully — and `total` is the number matching _within the scan_, which the screen presents as the
number matching. A trail that quietly stops looking is worse than one that says it cannot.

**3. There is no pagination.**
A limit, and nothing else — no cursor, no offset. Past the limit the screen says "narrow the filters to
see the rest", which cannot reach anything older than the scan whatever the filters say.

**4. A change is recorded without what it changed from.**
`MIGRATION_PLAN_UPDATED` carries the new value: `{ options: patch }`, `{ field, transform }`. The
previous value is nowhere. The trail can say a transformation changed and not say from what, which is
exactly the evidence a change record exists to carry.

**5. The trail cannot leave the screen.**
Every other evidence surface in the product has a CSV and the evidence package has a manifest. The
audit trail has neither, so the one record of who did what cannot be attached to anything.

### P2

**6. Every workspace member can read everything.**
`GET /api/audit` is an ordinary read; no permission narrows it. A validator can read the operator's
role changes. That may be the right answer for a small team, but it is currently the default rather
than a decision.

**7. An event does not link to what it describes.**
The run is printed as the first eight characters of a GUID. A reader who wants the run it names has to
go and find it.

**8. No retention statement.**
Rows are kept forever, deliberately. Nothing says so, nothing bounds the growth, and nothing says what
would happen if somebody asked for a deletion.

**9. No session context on the event.**
The sessions table holds `user_agent`; the audit event does not, so an event cannot be tied back to the
session that produced it.

**10. `DEMO_*` actions are categorised as `ADMIN` by falling through.**
True, but by elimination rather than by a rule anybody wrote.

## Audit evidence versus application logs

Worth stating before the work starts, because it decides what belongs in the table.

An **audit event** is a claim about a human decision: somebody with a name did something at a time, and
the system either did it or refused. It is kept, exported, and read by people who were not there. An
**application log line** is a claim about the software: a request took 400ms, a connector retried. It is
kept for as long as it is useful to an engineer.

The present trail holds both kinds. `ENVIRONMENTS_DISCOVERED` and `CONNECTION_TESTED` fire on ordinary
page loads and are closer to logs than to decisions; `TEAM_ROLE_CHANGED` and
`READINESS_BLOCKER_OVERRIDDEN` are decisions. Mixing them is not harmful today, but it is why a reader
scrolling the trail sees mostly noise — and it is a reason the 2,000-row scan fills up quickly. Part of
this gate is deciding which actions are evidence and which are telemetry, and saying so.

## Recommended implementation order

Five slices, each independently shippable. Complexity is relative to this codebase, not absolute.

**A — Answerable queries.** _Medium._ Move category, user, search and date filtering into SQL; add
keyset pagination on `(created_at, id)`; make `total` the real total. Removes P1-2 and P1-3 together,
because they are the same defect. Reuse: the keyset paging in
`validation-service.differencePages` and `migration-run-service.records` is the pattern. Deterministic
test: insert 5,000 events, assert a filtered count matches a direct `SELECT count(*)`, and that paging
through them yields every event exactly once.

**B — Access decisions.** _Low._ Audit the three access-request transitions and the invite path, with
the actor, the subject and the decision. Removes P0-1. Reuse: `team-service.setRole` is the shape to
copy. Deterministic test: grant and refuse, assert both are in the trail with the subject named.

**C — What it was, and what it became.** _Medium._ Record a before value alongside the after for the
mapping, transformation, options and role changes. The before is already loaded by every one of those
call sites — `planning-service.loadMapping` reads the row it is about to change — so this is mostly
passing what is already in hand. Removes P1-4. Deterministic test: change a transformation twice and
assert the trail reconstructs the sequence.

**D — Evidence that leaves.** _Low._ A CSV of the filtered trail, streamed the way
`differences.csv` is, and an entry in the evidence package. Removes P1-5. Reuse: `streamCsv`, `csvCell`,
`csvFileName`. Deterministic test: the export's row count equals the filtered total, and exporting is
itself recorded.

**E — Reading it.** _Medium._ Separate decisions from telemetry in the category model; link a run, a
validation and a project to the thing it names; state the retention and the read permission. Removes
P2-6, P2-7, P2-8, P2-10. Deterministic test: every action in the union maps to a category by a stated
rule, asserted exhaustively rather than by sampling.

Suggested order: **B, A, C, D, E.** B is the only P0 and is a day's work; A unlocks every other claim
about completeness; C is what makes the trail evidence rather than a list; D makes it portable; E makes
it readable.

## What this assessment did not look at

Alerting, scheduled reports, SIEM export, tamper-evidence (hash chaining), and multi-workspace
aggregation. None of them is needed for an internally usable audit experience, and each would be a
larger decision than this gate.
