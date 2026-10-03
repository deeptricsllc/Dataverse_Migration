# The release-candidate audit

Four readers, each with their own reason to disbelieve the product, and the top five objections each one
would raise. Then the pilot workflow, walked end to end.

Where an objection was cheap to answer, it was answered tonight and says so. Where it was not, it is here
unanswered — which is the point of writing it down.

---

## The pilot workflow, walked

Walked against the **built server** (`dist/`, `NODE_ENV=production`, embedded database), start to finish,
in the order a pilot customer performs it. Not a test: nothing asserted, every step performed and timed.

| Step                  | API calls | What happened                                                    |
| --------------------- | --------- | ---------------------------------------------------------------- |
| Create a workspace    | 1         | A workspace, a user, and an administrator role, from one call    |
| Add source and target | 1         | Discovery returned four environments                             |
| Create a project      | 1         | —                                                                |
| Analyze the source    | 1         | Tables, columns and types                                        |
| Create a plan         | 1         | Auto-mapped                                                      |
| Review readiness      | 1         | `READY_WITH_WARNINGS`, with each warning named                   |
| Migrate               | 1 + poll  | 120 records: 99 created, 6 refused, 15 already there and skipped |
| Validate              | 1 + poll  | `FAIL`, full coverage, 0 missing, 8 differences                  |
| Follow the findings   | 1         | 19 chain links                                                   |
| Generate evidence     | 2         | 13 KB package, verdict `VALID`                                   |

**Ten steps, ten API calls, no dead ends.** Nothing required reading the code, nothing required a
database, and nothing required a credential.

### What the walk found

**The validation says FAIL on a first pilot migration, and it is right to.** Six records the target
refused, so six records are not there. A customer's first impression of their own pilot is a red verdict.
The report does separate the causes — `RECORD_EXISTENCE` fails because of the run's own failures, while the
eight differences are `PRE_EXISTING_DIFFERENCE` warnings on records the run skipped and never wrote — but
the _headline_ is FAIL either way. That is correct and it is worth a human being warned before they see
it. **Documented, not softened:** a verdict that goes amber to spare feelings is the beginning of every
dishonest report.

**A demo workspace arrives with two projects nobody made.** The curated examples build in the background
on first sign-in. For an evaluator they are the point; for a pilot customer they are two projects in their
workspace that they did not create and cannot distinguish from their own work. The IA recommendation
already names this ("they are examples, not work. They probably want a label of their own"). **Not fixed
tonight** — it needs a label on a project and a decision about whether a pilot deployment seeds them at
all, which is a product decision rather than a bug.

**Readiness answers before anything is written, and that is the strongest part of the flow.** The narrow
column, the unmapped choices, the already-populated target, the server-side logic that will fire — all
named with a recommendation, before a record moves. Nothing in the walk was a surprise after the fact.

---

## Persona 1 — the migration engineer

_Can I run this without knowing how it works?_

| #   | Objection                                                                                                                                                                         | Status                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Why did my validation fail when nothing is missing?" The verdict is one word and the causes are three kinds.                                                                     | **Partly answered.** The per-check rows distinguish them. The headline does not, and that is deliberate                                                                                      |
| 2   | "A hundred-table plan is one enormous screen." Mapping at that width is a scale problem no navigation fixes.                                                                      | **Open.** Named in the IA recommendation; nothing tonight touched it                                                                                                                         |
| 3   | "I cannot tell what the conflict strategy will do without trying it." `UPSERT` writes without comparing, `SYNC` compares — and the difference is one parenthetical in a dropdown. | **Partly answered.** Golden Journey D now asserts the distinction, and the attempts panel shows what actually happened. The dropdown is still the only place it is explained before the fact |
| 4   | "What do I do about an unresolved record?"                                                                                                                                        | **Answered tonight.** The run says how many, the lineage says which and with what evidence, and the sign-off says the run is not complete and what the next action is                        |
| 5   | "I have to leave the product to find out which build produced a report."                                                                                                          | **Answered tonight.** Settings, the health endpoint, and every evidence package                                                                                                              |

## Persona 2 — the data owner

_Can I tell whether my data arrived correctly?_

| #   | Objection                                                                                                                             | Status                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "You told me there are no duplicates. Did you check anything that could repeat?"                                                      | **Answered tonight.** A primary-key-only scan now says so and the summary refuses to imply business uniqueness                                |
| 2   | "A sampled validation and a full one look the same at a glance."                                                                      | **Answered.** `SAMPLED` with eligible, examined, strategy — and Golden Journey E asserts no sentence in a sampled report claims "all of them" |
| 3   | "My JSON column is reported as different and the documents are the same."                                                             | **Answered tonight.** A `jsonb` target is compared as a document, key order ignored                                                           |
| 4   | "What about the columns you could not compare?"                                                                                       | **Answered tonight.** Named at column level with the reason, and the records still compared on everything else                                |
| 5   | "I cannot see my own data in the product to check a value by eye." Record preview exists on analysis, not on a validation difference. | **Open.** A difference shows the two values; getting from there to the whole record is a navigation step that does not exist                  |

## Persona 3 — the auditor

_Can I establish what happened without trusting the operator's memory?_

| #   | Objection                                                                                                                                                                             | Status                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Your package is verified by your own endpoint."                                                                                                                                      | **Answered tonight.** The package now gives the `shasum` and `Get-FileHash` commands and says the arithmetic is the authority, not our endpoint |
| 2   | "This 'pre-migration assessment' was written after the migration." It was — re-assessed at packaging time.                                                                            | **Answered tonight.** The assessment is stored with the run; a package from before says which document it is holding                            |
| 3   | "Your digests prove nothing about who wrote the files." Correct, and the package says so in those words: not signed, detects accidental change and casual tampering, not a signature. | **Answered, by refusing to claim otherwise.** Signing needs a key somebody controls, which is a deployment decision                             |
| 4   | "I cannot tie a number in this report to the records behind it."                                                                                                                      | **Answered.** `lineage/` is one row per source record with its outcome and write state; the chain joins readiness to the run to validation      |
| 5   | "Who changed that person's permissions?"                                                                                                                                              | **Answered tonight.** A role change is an audited event recording who, by whom, from what, to what                                              |

## Persona 4 — the enterprise security and architecture reviewer

_Data boundaries, credentials, connector claims, failure recovery, limits, deployment risk._

| #   | Objection                                                                  | Status                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Your product dials hosts my users type in."                               | **Answered tonight,** narrowly: loopback, link-local, metadata hostnames refused; private ranges allowed because that is where customer databases are. **The bound checks the name, not where it resolves** — recorded as open, with a test asserting the gap |
| 2   | "You claim Dataverse support and have never spoken to Dataverse." Correct. | **Open, and stated.** Every Dataverse capability says `SIMULATED`; the harness is written and skips until configured; `HARNESS_CHECKLIST.md` is what to provide                                                                                               |
| 3   | "What happens when your process dies mid-migration?"                       | **Answered.** The crash-consistency protocol, nine chaos scenarios, a destructive drill, and a record whose answer was lost is reported unresolved rather than guessed                                                                                        |
| 4   | "A code review by the author is the weakest security assurance there is."  | **Agreed, in writing.** `SECURITY_AUDIT.md` says so in its last section. An external review is the next step and nothing here substitutes for it                                                                                                              |
| 5   | "Your scale numbers are extrapolated." They were.                          | **Partly answered tonight.** Measured to 1,500,000, and the previous flat-throughput claim withdrawn because the measurement contradicted it. Above that it is extrapolated **downward**, and disk is unmeasured                                              |

---

## What this audit did not do

- **It is still the author auditing their own work.** Four personas written by one person are four guesses
  about what somebody else would object to. They are better than none and worse than four actual readers.
- **No customer has used this.** Every "answered" above is answered to my satisfaction, which is not the
  standard that matters.
- **The deployed QA environment was not inspected tonight.** The Railway CLI could not run in this
  session, so the walk above is against a local production build. That is the same artifact Railway would
  serve, and it is not the same as checking the deployment.
