# Pilot constraints

**Written for:** whoever signs off a controlled enterprise pilot, and whoever runs it.

This replaces the constraint list that was in `PILOT_READINESS.md` at the end of Phase 3. Dated
2 October 2026, after Phase 4.

Read this before the feature list. Everything here is a limit the product has, stated so nobody has to
discover it during a migration.

---

## Verdict

**Ready for a controlled enterprise pilot**, within the constraints below, against **SQL Server,
PostgreSQL, MySQL and file uploads**.

**Not ready for a Dataverse pilot.** Everything the product knows about Dataverse comes from a
simulator written against Microsoft's documentation. That simulator is exercised hard and proves
nothing about a tenant. The harness is written and waiting for an environment — see
`docs/HARNESS_READINESS.md` — and until a recorded run exists, "works with Dataverse" means "written
against the documentation".

**Not ready for production migration.** One P0 correctness gap remains, and it is described first.

---

## The one P0: an interrupted run can duplicate records

Target writes and identity-map writes are two systems, in that order, with no transaction across them.
A process that dies between them leaves up to one batch of records in the target that the platform has
no row for. Recovery depends entirely on the match strategy:

| Configuration                                                           | On resume                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| Ids preserved, or an alternate key, or a complete business key          | **Safe.** Records are re-matched, not re-created              |
| `PRIMARY_ID` + target assigns its own keys + a unique constraint exists | Records reported FAILED although they are present and correct |
| `PRIMARY_ID` + target assigns its own keys + **no** unique constraint   | **Duplicates.** The run reports COMPLETED with zero failures  |

**Mitigation, which closes it completely: configure an alternate key or a business key for every table
whose target assigns its own keys.** The readiness assessment raises
`RESUME_CANNOT_RECOVER_INTERRUPTION` as a blocker for exactly this combination and will not let the run
start until somebody either fixes it or accepts it by name with a reason.

Reproduced in `tests/integration/chaos-resume.test.ts`; full description in `docs/RESUME_SEMANTICS.md`,
including what a fix would be and why it belongs in its own phase.

---

## What is proven, and against what

| Claim                                                                                              | Evidence                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SQL Server, PostgreSQL, MySQL read, write, upsert, page, discover, find duplicates, compute totals | A conformance suite against real servers in hosted CI, with committed evidence per capability, server version and driver                   |
| The numbers on every screen agree                                                                  | One canonical metric vocabulary; a test that compares the run screen and the validation report                                             |
| Validation never claims more than it checked                                                       | FULL / SAMPLED / NOT_VERIFIED on every result, with eligible and examined counts; a check that examined nothing is a warning, never a pass |
| Resume does not re-do or duplicate completed work                                                  | 13 chaos tests with failures injected at known points                                                                                      |
| Validation does not grow with the table                                                            | Measured: peak heap 64 MB at 50k records, 68 MB at 500k                                                                                    |
| An evidence package can be checked                                                                 | A verifier with 11 corruption tests, and wording that states what a digest does and does not prove                                         |
| Authorization is server-side                                                                       | Four roles enforced before any handler runs; tested through the API with valid sessions, not by hidden buttons                             |

---

## Scale

| Per table           | Status                                                                     |
| ------------------- | -------------------------------------------------------------------------- |
| Up to 10,000        | Measured end to end                                                        |
| 10,000 – 500,000    | The platform's own cost is measured and flat; the connectors are the limit |
| 500,000 – 5,000,000 | Extrapolated. Plan for it, measure before promising a window               |
| Above 5,000,000     | **Unknown.** Nothing of that size has been run                             |

Full envelope, with what is MEASURED, EXTRAPOLATED and UNKNOWN: `docs/SCALE_ENVELOPE.md`.

---

## Operational constraints for the pilot

1. **Non-production targets only.** Writing to a production target works and asks for the environment's
   name to be typed; for a pilot, do not.
2. **Take a backup of the target first.** Rollback is an inventory of what the run wrote, not an undo.
   The readiness assessment says this before every run.
3. **Configure a key for every table.** See the P0 above. This is the single most valuable thing a pilot
   team can do.
4. **Validate at FULL depth while the volumes allow it.** STANDARD samples above 5,000 records per table
   and says so; FULL is the only depth that can report full coverage.
5. **Do not interrupt a run on a table matched by record id.** If one is interrupted, reconcile the
   target record count against the identity map before retrying.
6. **One migration at a time per target.** The product enforces this; it is not a race condition to test.
7. **Expect a schema-difference warning** whenever source and target columns differ in type or width.
   That is the report doing its job, not a fault.

---

## What the product does not do

- **No automatic destructive undo.** Rollback is an inventory.
- **No deletes, ever.** Synchronisation never deletes a target record. A record removed from the source
  stays in the target, and the product does not pretend otherwise.
- **No arbitrary code in transformations.** No JavaScript, Python, SQL expressions, shell or `eval`. A
  transformation cannot become an injection route.
- **No per-attempt metrics.** A retry is a new attempt of the same run and the figures are cumulative
  over the run. "What did attempt two do on its own" is not a question the product answers.
- **No signed evidence.** A package's digests prove its files are internally consistent with its
  manifest. They prove nothing about who made it. The package says so in those words.
- **Aggregate reconciliation needs a target this run owns.** Migrating into a populated target reports
  NOT VERIFIED for totals rather than comparing two numbers that mean different things.
- **No JSON or binary column comparison.** JSON is compared by serialisation, so key order matters;
  binary has no defined comparison. Both are stated in `docs/SEMANTIC_EQUALITY.md`.
- **Date-only extremes are not reconciled by total.** The engine returns an instant and the column means
  a day; which day depends on a timezone neither side declares.

---

## Known limitations worth saying out loud

- **Sub-second time is ignored** when comparing timestamps, deliberately: engines keep different
  precision and comparing finer would fail every migration between them.
- **Trailing whitespace is ignored** in text, deliberately, because `CHAR` columns pad. A genuinely lost
  trailing space reads as equal.
- **An empty string and a NULL are treated as the same value.** Right for Dataverse, which stores one as
  the other; a limitation for SQL-to-SQL.
- **The duplicate check needs a business key to be meaningful.** With none configured it groups on the
  primary identifier, which is unique by construction, and reports that nothing repeats. True, and less
  than a reader may take from it.
- **A negative number exports as text** in CSV, because a leading `-` is a spreadsheet formula. The value
  is unchanged and prefixed with a quote.
- **The demo cannot demonstrate sampling.** Every demo table is smaller than the smallest depth cap.

---

## What must happen before a production migration

In order:

1. **Close the resume P0** with a write-ahead intent record, or require a key on every table by policy
   and enforce it in the gate as non-overridable.
2. **Run the Dataverse harness** against a real environment, if Dataverse is a target.
3. **Measure one table above a million records** against the customer's real connections.
4. **Run a failure/resume drill** on the customer's own data, deliberately, before the real cutover.
5. **Agree who may override a readiness blocker**, and check the evidence package records it.
