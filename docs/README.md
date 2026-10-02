# The documentation, and which of it is true now

Thirty-four documents accumulate ambiguity faster than they accumulate content. This index exists so that
a reader knows, before opening anything, **whether it describes the product as it is or the product as it
was**.

Five classes, and the rule that matters: where two documents disagree, the one in **Current product
truth** wins, and the other one has been corrected or marked. Historical sprint reports are kept
deliberately — they are the record of what was found and when — and they are not authority on anything.

---

## 1. Current product truth

What the product does now. Correct these first when behaviour changes; everything else cites them.

| Document                                                                    | The question it answers                                                                                  | Last reconciled with the code |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [VERIFICATION.md](VERIFICATION.md)                                          | How far is each connector capability proven, and what stops a claim outrunning its evidence?             | Phase 5                       |
| [SEMANTIC_EQUALITY.md](SEMANTIC_EQUALITY.md)                                | What does "equal" mean, field by field — including JSON, binary, and the third verdict `NOT_COMPARABLE`? | Phase 5                       |
| [TERMINOLOGY.md](TERMINOLOGY.md)                                            | One term, one concept. Which words collided and what each is settled to mean                             | Phase 5                       |
| [SCALE_ENVELOPE.md](SCALE_ENVELOPE.md)                                      | **The source of truth for anything numeric about scale.** Measured to 1,500,000 records                  | Phase 5                       |
| [CRASH_CONSISTENCY.md](CRASH_CONSISTENCY.md)                                | What happens to a write whose answer was lost, and why no record is duplicated after a resume            | Phase 4                       |
| [RESUME_SEMANTICS.md](RESUME_SEMANTICS.md)                                  | Attempts, resume, and the one boundary with no transaction across it                                     | Phase 4                       |
| [FILE_IMPORT.md](FILE_IMPORT.md)                                            | What the file reader does with every awkward case, and what it still cannot do                           | Phase 5                       |
| [GOLDEN_JOURNEYS.md](GOLDEN_JOURNEYS.md)                                    | The seven workflows that gate a release, and the defects writing them found                              | Phase 5                       |
| [EXPORT_FORMAT.md](EXPORT_FORMAT.md)                                        | Exactly what an exported file contains                                                                   | Phase 4                       |
| [TRANSFORMATION_ENGINE.md](TRANSFORMATION_ENGINE.md)                        | Every transformation rule, and what each one does to a value                                             | Phase 3                       |
| [DATA_PROFILING.md](DATA_PROFILING.md) · [DATA_QUALITY.md](DATA_QUALITY.md) | What profiling measures, and which quality problems are detected                                         | Phase 3                       |
| [ANALYSIS_AND_SCHEDULING.md](ANALYSIS_AND_SCHEDULING.md)                    | Projects, source analysis, the mapping workbook, schedules                                               | Phase 3                       |

## 2. Architecture and design

How it is built, and the decisions behind it. Design documents describe an intent; where one describes
something not yet built, it says so in its own first paragraph.

| Document                                                             |                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                                   | The shape of the system: processes, data flow, where state lives                |
| [IA_RECOMMENDATION.md](IA_RECOMMENDATION.md)                         | The information architecture recommendation, and what was deliberately deferred |
| [INCREMENTAL_SYNC_ARCHITECTURE.md](INCREMENTAL_SYNC_ARCHITECTURE.md) | Change detection, watermarks and drift. **Design** — read its own caveats       |
| [ON_PREM_AGENT_ARCHITECTURE.md](ON_PREM_AGENT_ARCHITECTURE.md)       | Reaching a database that is not on the internet. **Design, not built**          |
| [NAMING_BRIEF.md](NAMING_BRIEF.md)                                   | The product name question. A brief, not a decision                              |

## 3. Verification evidence

What was actually run, and what it proved. These are cited by claims elsewhere; the files in `evidence/`
are the raw record and a drift check in CI compares them against what the repository says.

| Document                                                     |                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [HARNESS_CHECKLIST.md](HARNESS_CHECKLIST.md)                 | **Start here.** Exactly what to provide to turn SIMULATED into VERIFIED, in the order worth doing it |
| [HARNESS_READINESS.md](HARNESS_READINESS.md)                 | What the two harnesses do, and why they stop where they stop                                         |
| [REAL_TENANT_CERTIFICATION.md](REAL_TENANT_CERTIFICATION.md) | The read-only certification against a real Microsoft tenant, step by step                            |
| [MANUAL_RECONCILIATION.md](MANUAL_RECONCILIATION.md)         | Five scenarios reconciled by hand on deployed QA, including the arithmetic                           |

## 4. Operations and setup

For whoever runs it or connects it to something.

| Document                                                                                                                       |                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [MICROSOFT_SETUP.md](MICROSOFT_SETUP.md)                                                                                       | Entra registration, the three decisions people conflate, and the troubleshooting table |
| [SQL_SERVER_SETUP.md](SQL_SERVER_SETUP.md) · [AZURE_SQL_SETUP.md](AZURE_SQL_SETUP.md) · [POSTGRES_SETUP.md](POSTGRES_SETUP.md) | Connecting each engine                                                                 |
| [UAT_GUIDE.md](UAT_GUIDE.md)                                                                                                   | Acceptance testing, as a script somebody can follow                                    |
| [DEMO_SCRIPT.md](DEMO_SCRIPT.md)                                                                                               | Showing the product without it going wrong                                             |

## 5. Pilot documentation

What a controlled pilot can and cannot promise.

| Document                                     |                                                      |
| -------------------------------------------- | ---------------------------------------------------- |
| [PILOT_CONSTRAINTS.md](PILOT_CONSTRAINTS.md) | The boundaries to agree before a pilot starts        |
| [PILOT_READINESS.md](PILOT_READINESS.md)     | Boundaries, scale, roles, and what is still unproven |
| [LAUNCH_READINESS.md](LAUNCH_READINESS.md)   | Evaluating the product with its gaps in view         |
| [MARKET_LANDSCAPE.md](MARKET_LANDSCAPE.md)   | The market this enters, and who else is in it        |

## 6. Historical sprint reports

**Not authority.** Kept because the record of what was found, when, and what was decided is worth more
than a tidy directory. Where one of these contradicts section 1, section 1 is current.

| Document                           |                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| [TRUST_SPRINT.md](TRUST_SPRINT.md) | Definitions, open decisions and known limits, as they stood at the end of that sprint |
| [SOURCES.md](SOURCES.md)           | Where each external claim came from, with links                                       |

---

## Contradictions found and resolved

Recorded rather than quietly fixed, because the fact that two documents disagreed is itself worth knowing.

| What disagreed                                                                                                          | Resolution                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCALE_ENVELOPE.md` claimed the platform's write rate was **flat at ~12,500/s at every size**, measured only to 500,000 | Withdrawn. Measured to 1,500,000, the rate halves. SCALE_ENVELOPE is now the single source for scale numbers and says what is measured, extrapolated and unknown |
| `PILOT_READINESS.md` §4 said **"nothing here has been run at volume"**                                                  | No longer true. It now points at SCALE_ENVELOPE and marks what remains unmeasured — disk, and the same test against a real PostgreSQL server                     |
| `PILOT_READINESS.md` listed **unbounded audit `details`** and an **unstreamed record-map export** as open risks         | Both fixed since. Marked as fixed, with the one export that is still unstreamed named rather than lumped in                                                      |
| `PILOT_CONSTRAINTS.md` cited peak heap **64 MB at 50k**                                                                 | Re-measured: 52 MB at 50k, 67 MB at 500k, 74 MB at 1.5M                                                                                                          |
| `MICROSOFT_SETUP.md` offered `ENTRA_TENANT_ID=organizations` and listed `ALLOWED_TENANT_IDS` under "optional hardening" | Both corrected. That combination is what broke QA sign-in: under `GATED`, an empty allow list admits nobody                                                      |
| The evidence package described a **re-assessed** readiness report as "the pre-migration assessment"                     | The assessment is now stored with the run. A package from before says which document it is holding                                                               |
