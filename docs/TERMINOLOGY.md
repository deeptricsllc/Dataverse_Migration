# One term, one concept

An audit of the words this product uses, against one rule: **a word means the same thing everywhere, or
it is two words.** The product is not renamed and nothing is renamed for novelty; what follows is the
collisions, what each term is settled to mean, and which fixes are deliberately deferred.

The category this language should sound like is **migration assurance** rather than generic ETL. Not a
tool that moves rows — a tool that can tell you afterwards what happened to them. That shows up in which
word wins each collision below: the one that names evidence usually beats the one that names a mechanism.

---

## Collisions found

### `Reconciliation` — three meanings, one of them in front of customers

| Sense                                     | Where                                                                     | What it means                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Compare two datasets record by record     | Comparison projects, the UI: _"Reconciles two datasets record by record"_ | A read-only comparison. Nothing is migrated                       |
| Compare **totals** across the two sides   | Validation: _aggregate reconciliation_                                    | Supplementary evidence: sums, counts and extremes agreeing        |
| **Settle a write nobody can account for** | `NEEDS_RECONCILIATION`, `reconcileEvidence`, `reconcileNote`              | After an interruption, a person decides what happened to a record |

The third was rendering as the badge **"Needs reconciliation"** on a run — which a customer who has used
Comparison projects would reasonably read as "this run wants a comparison". It is the most consequential
of the three and the only one with a status attached.

**Settled.** The badge now says **"Unresolved writes"**. The enum keeps its name, because it is in a
database column and in evidence packages that are already written; the label is where the ambiguity is
fixed. "Reconciliation" without a qualifier means comparing — datasets or totals — and the crash sense is
always "unresolved writes" in anything a customer reads.

### `Attempt` — two meanings, and the evidence export shows the wrong one

| Sense                                     | Where                                                    |
| ----------------------------------------- | -------------------------------------------------------- |
| Which execution of a run this is          | `migrationRuns.attempt`, "Attempt 2", the attempts panel |
| How many times **one record** was written | `migrationRecordMaps.attempts`                           |

The evidence lineage column labelled **`Attempt`** holds the second. A reader comparing it to the run's
"Attempt 2" is comparing two different numbers with the same name.

**Deferred, deliberately.** Fixing the label means a new evidence schema version and a verifier that knows
three column sets. That is a change to make on purpose rather than at the end of a long night, and the
risk of getting it wrong is a package that fails its own verification. Recorded here and in the commit
that found it. Until then: a run has an **attempt**; a record has **write attempts**, and that is the
phrase to use in any new surface.

### `Run` — four kinds, which is fine, but only when qualified

Migration run, validation run, comparison run, analysis run. All are jobs with a status and a history, so
the shared noun is right. The failure mode is the bare word: "the run failed" is ambiguous in a product
where four things are runs.

**Settled.** Always qualified in anything a customer reads. `MigrationRunDto` and `ValidationRunDto`
already keep them apart in the code.

### `Verification` — two meanings, both legitimate

| Sense                                                         | Where                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| How far a **connector** has been proven against a real engine | `shared/connector-verification.ts`, `ENGINE_VERIFIED`       |
| Whether an **evidence package** is intact                     | `/api/evidence/verify`, `VALID` / `MODIFIED` / `INCOMPLETE` |

**Settled, with a qualifier.** _Connector verification_ and _evidence verification_ are never shortened to
"verification" alone. They answer different questions and share no vocabulary beyond the word.

### `Sync` — a conflict strategy, and a thing this product does not do

`SYNC` is one of four conflict strategies, shown as **"Sync (insert new, update changed)"**. It compares a
matched record and writes only when it differs — which is exactly what the label says.

The collision is with the standing rule it sits next to: _"never issue DELETE as part of
synchronisation"_. A synchronisation, in most people's usage, makes two sides the same, and making two
sides the same means deleting from one of them. This product has no delete at all — `MigrationConnector`
has no `deleteRecord` — so `SYNC` moves a record's values and never removes anything the source no longer
has.

**Settled, as a qualifier rather than a rename.** The strategy's own label already says what it does, and
renaming an option in a plan's stored configuration is not worth doing for a word. What is settled is that
"sync" never appears unqualified at product level: repeated runs are **incremental migration**, and the
strategy is always written as `SYNC` with its parenthetical. I claimed in the first draft of this document
that the product does not use the word at all. It does; this is the accurate version.

### `Coverage` — one meaning, two scopes

Validation coverage (how many records were examined) and duplicate coverage (how thoroughly the duplicate
scan ran) are the same concept applied to two checks, and both use `ValidationCoverage` with the same
`FULL` / `SAMPLED` / `NOT_VERIFIED` modes.

**No change.** One concept, one type, two scopes — which is what a shared term is for.

---

## Settled meanings

| Term                       | Means exactly                                                                                    | Not to be used for                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Analyze**                | Understanding a source: profiling columns, finding quality problems, before any target is chosen | Comparing two systems — that is Compare                                                           |
| **Schema comparison**      | Two systems' structures, side by side                                                            | Comparing data — that is a data comparison                                                        |
| **Readiness**              | What can fail, assessed **before** a migration, from the plan and the two environments           | A verdict on data quality on its own                                                              |
| **Mapping**                | Which source column goes to which target column                                                  | Changing a value — that is a transformation                                                       |
| **Transformation**         | A rule that changes a value on the way across                                                    | Mapping                                                                                           |
| **Migration**              | The whole act of moving records from one environment to another                                  | One execution of it — that is a run                                                               |
| **Run**                    | One execution, with a status, counters and a history                                             | The migration as a concept                                                                        |
| **Attempt**                | Which execution of a run this is                                                                 | How many times a record was written — that is **write attempts**                                  |
| **Validation**             | Reading both sides afterwards and comparing them                                                 | The run's own counters, which are the run's claim rather than validation's                        |
| **Finding**                | Something a stage observed, with evidence, an explanation and a recommendation                   | A difference between two values — that is a difference                                            |
| **Difference**             | One field on one record holding something other than expected                                    | A finding                                                                                         |
| **Lineage**                | One row per source record: where it went, what happened, whether that is provable                | A log                                                                                             |
| **Evidence**               | The package, and the artifacts in it                                                             | A claim about the data; the package proves what the files say, not that the migration was correct |
| **Unresolved**             | The platform cannot prove what happened to this record                                           | Failed. A failure is known; this is not                                                           |
| **Sync** (the strategy)    | Compare a matched record and write only if it differs                                            | Synchronisation. Nothing is ever deleted                                                          |
| **Written by this run**    | Created plus updated. Records this run put there                                                 | Accounted for, which also counts unchanged, skipped, failed and unresolved                        |
| **Accounted for**          | Every record the run has an outcome for                                                          | Processed successfully                                                                            |
| **Coverage**               | How much was examined, and how those records were chosen                                         | A quality verdict                                                                                 |
| **Connector verification** | How far a connector has been proven against a real engine                                        | Evidence verification                                                                             |
| **Evidence verification**  | Whether a package is intact and unmodified                                                       | Connector verification                                                                            |

---

## Words deliberately not used

- **"Exactly-once delivery"** — the architecture cannot prove it. After an interruption a record can be
  in an unresolved state, which is the honest answer and the opposite of an exactly-once claim.

  Note the phrase that **is** used and is a different claim: _"every source record is accounted for
  exactly once"_. That is about the identity map — one row per source record, one outcome each — not about
  writes. One is a statement about bookkeeping and the other about delivery, and conflating them is how an
  honest product starts over-claiming. I conflated them in the first draft of this document.

- **"Successfully migrated"** on its own — it hides which of created, updated, unchanged or skipped
  happened, and those mean different things to whoever signs.
- **"Verified"** without saying by what. See the two senses above.
- **"No duplicates"** when only a primary key was checked. See [VERIFICATION.md](VERIFICATION.md).
- **"Clean"** as a verdict — it invites the reader to assume a scope nobody stated.

---

## What was checked and needed no change

`Analyze`, `Mapping`, `Transformations`, `Finding`, `Lineage`, `Evidence`, `Schema comparison`,
`Coverage`, and `Written by this run` are each used in exactly one sense across the server, the shared
types and the interface. `Written by this run` in particular is already distinct from `accounted for`
everywhere, including in `shared/run-metrics.ts`, where the distinction is the point.
