# Phase 5 — product completion and release candidate

A sprint report. Historical: it records what was done on the night of 1–2 October 2026 and what was found,
and it is not authority on how the product behaves now. For that, see
[the documentation index](README.md).

19 commits, pushed, CI green on both jobs.

---

## 1. Release candidate verdict

**CONTROLLED PILOT READY.** Not a release candidate.

The gap is not features and not correctness. It is this:

**Dataverse has never been exercised against a real environment.** The product's name is about Dataverse
and every Dataverse capability in the matrix says `SIMULATED`. Everything known about it comes from a
simulator written to match Microsoft's documentation, which proves a great deal about the planner and the
engine and nothing whatever about Dataverse. Azure SQL likewise, and it does not inherit SQL Server's
status. A release candidate for enterprise migration cannot have an unverified primary connector.

**Sign-in does not work on the deployed environment**, and the remaining fix needs two values only the
directory's administrator can see.

What is genuinely strong, and would be a release candidate if the connector were verified: the evidence
chain, the crash-consistency protocol, the honesty of the reporting. Three separate defects tonight were
cases of the product claiming more than it had proven, and each was fixed by claiming less.

What would move this to RELEASE CANDIDATE: a Dataverse environment and
[the checklist](HARNESS_CHECKLIST.md). Nothing in the code is waiting on engineering for that.

## 2. The authentication incident

**Root cause.** Two independent faults, stacked, with the second invisible behind the first.

Diagnosed by probing Microsoft's **token** endpoint with the configured client id and a deliberately
invalid secret — which validates the application before anything else:

| Authority probed              | Microsoft's answer                          | What it establishes                                   |
| ----------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| `0eca5595-…` (your directory) | `AADSTS700016`                              | the application is **not** in your directory          |
| `/organizations`              | `AADSTS53003` (a Conditional Access policy) | the application **does** exist — in another directory |
| `/consumers`                  | `AADSTS700016`                              | not a personal-account application                    |

So application `69bc3659-…` is registered in a directory that is not `0eca5595-…`, and QA's authority was
`organizations`, which makes Microsoft resolve **the signing-in user's** home directory. It looks for the
application there, does not find it, and says so on its own page — before any request reaches this product,
which is why nothing the product renders could have improved it.

The **second** fault: `ACCESS_MODE` defaults to `GATED` and `ALLOWED_TENANT_IDS` was unset. An empty allow
list admits **nobody**, not everybody. Microsoft would have authenticated you successfully and this product
would then have refused you — correctly, and unhelpfully.

A note on method: an **authorize**-endpoint probe is not diagnostic here and nearly misled this. A wrong
client id, and even a deliberately unregistered redirect URI, both render a normal sign-in page, because
that validation is deferred until after the user authenticates. Only the token endpoint answers directly.

**What changed.** No Entra configuration was touched and no credential was read.

- The three decisions people conflate are named apart and validated at startup: **client identity**,
  **authority** (a question put to Microsoft), **admission** (our decision afterwards, on a tenant id
  already proven). A deployment nobody can sign in to now says so on its first log line.
- `GET /api/platform/auth-configuration` for an operator, with no secret values.
- The sign-in callback sends the browser a **code**, not a sentence. It used to redirect to
  `/login?error=<message>` and render whatever arrived — which let anyone send a prospect a link to our own
  domain showing a sentence of their choosing under a "Sign-in failed" heading.
- `MICROSOFT_SETUP.md` offered `ENTRA_TENANT_ID=organizations` and listed `ALLOWED_TENANT_IDS` under
  "optional hardening". That documentation is what produced this outage; both corrected.

**What remains for you.** Three variables on `dataverse-migration-app`. No secrets.

```
ENTRA_TENANT_ID     = <Directory (tenant) ID of the app registration>
ALLOWED_TENANT_IDS  = <that directory id, plus any other you want admitted>
ADMIN_EMAILS        = srinivas@deeptrics.com
```

The first is in **Entra admin centre → App registrations → the app → Overview → Directory (tenant) ID**.
If that registration is not one you control, the alternative is a new single-tenant registration in
`0eca5595-…` — which was not created, as the brief requires. `ADMIN_EMAILS` is absent too, which means
nobody is a platform operator and the new diagnostics would be unreachable even after a deploy.

## 3. Product changes

| Problem                                                                           | Root cause                                                                                                                              | Fix                                                                          | Verification                 |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| A semicolon-separated CSV delivered `Smith  John` for `Smith, John`               | The reader rewrote the file to comma-separated before parsing, and turned existing commas into spaces                                   | Parse with the file's own delimiter                                          | 6 reader cases               |
| A part number `007` became `7`                                                    | `INTEGER.test('007')` is true, so an identifier was a number — and nothing reported a difference, because by then the value _was_ seven | Digits with a leading zero are an identifier, kept as text                   | 4 cases, mutation-checked    |
| "No duplicates" over a primary key the target already enforces                    | The scan fell back to the primary id and reported a pass                                                                                | The basis travels with the finding; four distinguished answers               | 7 unit + 2 end-to-end        |
| A JSON column reported as different when the documents matched                    | Compared by serialisation                                                                                                               | A `jsonb` target is compared as a document, key order ignored, numbers exact | 16 cases                     |
| A column that cannot be compared had to be called equal or different              | Equality had two outcomes                                                                                                               | A third verdict, reported per column with the reason                         | 13 cases                     |
| `[object Object]` shown to a customer in a readiness finding                      | A label record interpolated instead of its `.label`                                                                                     | Fixed, plus a guard asserting no finding prints an object or `undefined`     | Golden Journey B             |
| A version-2 evidence package failed its own verification                          | The verifier compared every package against the current column set                                                                      | Columns are a function of the declared version                               | mutation-checked             |
| The write state was invisible outside the evidence package                        | The three columns were added to the ZIP and not to the run's export                                                                     | `RecordMapDto` and the per-run CSV carry them                                | Journey A                    |
| The evidence package's "pre-migration assessment" was written after the migration | Re-assessed at packaging time                                                                                                           | Stored with the run; an older package says which document it holds           | 5 chain cases                |
| The sign-off's outcome table did not add up                                       | `processed` counts unresolved records; the table listed five outcomes                                                                   | An Unresolved row, and a block saying the run is not complete                | parses the table and sums it |
| Unbounded outbound connections                                                    | Only emptiness was checked                                                                                                              | Loopback, link-local, metadata hosts refused; private ranges allowed         | 13 cases                     |
| The four workspace roles could not be assigned                                    | No API, no UI — `VALIDATOR` and `READ_ONLY` were unreachable                                                                            | `/api/team`, with both lockout guards                                        | 10 cases                     |

## 4. Golden journeys

Seven, in `tests/golden/`, running in the ordinary `npm test`. **All pass.**

|     | Journey                                  | Verdict |
| --- | ---------------------------------------- | ------- |
| A   | Clean migration → validation → evidence  | PASS    |
| B   | Data the target refuses                  | PASS    |
| C   | Interrupted, then resumed                | PASS    |
| D   | A target that already holds data         | PASS    |
| E   | Above the sampling threshold             | PASS    |
| F   | Duplicates on a key that means something | PASS    |
| G   | A spreadsheet into a table               | PASS    |

Each verifies the target **directly** rather than through the product's counters. See
[GOLDEN_JOURNEYS.md](GOLDEN_JOURNEYS.md) for the three defects writing them found.

## 5. Connector truth

| Connector         | Level                                                                                      | Evidence                                                             |
| ----------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **PostgreSQL**    | `ENGINE_VERIFIED`                                                                          | Real server in CI, version recorded, including the crash protocol    |
| **MySQL**         | `ENGINE_VERIFIED`                                                                          | Same                                                                 |
| **SQL Server**    | `ENGINE_VERIFIED`                                                                          | Same                                                                 |
| **Azure SQL**     | `IMPLEMENTED`, `connect: REQUIRES_CONFIGURATION`                                           | **Never run.** Does not inherit SQL Server's status                  |
| **Dataverse**     | `SIMULATED` everywhere; `duplicateDetection` and `aggregateReconciliation` `NOT_SUPPORTED` | **Never run.** 26 harness cases written, never executed              |
| **File / upload** | `ENGINE_VERIFIED`                                                                          | Its engine is this platform's own database; Journey G runs the chain |

Unchanged tonight, deliberately. No claim was raised without a run to back it.

## 6. Scale

**Measured to 1,500,000 records**, and it contradicted what this repository claimed.

|   Records | Identity map written | Paged read | Peak heap |
| --------: | -------------------: | ---------: | --------: |
|   500,000 |    44.7 s (11,183/s) |     2.85 s |   67.1 MB |
| 1,000,000 |    111.2 s (8,991/s) |     7.91 s |   69.1 MB |
| 1,500,000 |    260.3 s (5,763/s) |     7.88 s |   74.4 MB |

The previous claim — "about 12,500 rows a second at every size", measured only to 500,000 — is
**withdrawn**. Carried to 1.5M the rate halves, and 1.5M took 260 seconds where flat throughput predicts 134. It was an extrapolation wearing a measurement's clothes.

The claim that survived is the one worth having: **memory is flat.** 67 MB to 74 MB for three times the
data, because validation holds one page and lets it go.

Whether the slowdown is ours or PGlite's index maintenance competing for one core in the same process is
**open**. The same suite against a real PostgreSQL server answers it. Disk is unmeasured. Above 1.5M is
extrapolated **downward**.

## 7. Security

No P0. Full review in [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

|        | Finding                                                                      | Status                                                                                      |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **P1** | SSRF through connection configuration                                        | **Fixed**, narrowly — private ranges stay open because that is where customer databases are |
| **P2** | A crafted link could choose the words under our own "Sign-in failed" heading | **Fixed** — a closed set of codes                                                           |
| **P2** | Audit payloads bounded but not scrubbed                                      | **Fixed** — the same scrubber the logs use                                                  |
| **P3** | The SSRF bound checks the host as written, not where it resolves             | **Open**, with a test asserting the gap                                                     |
| **P3** | One export still holds a page in memory                                      | **Open**                                                                                    |
| **P3** | `mailto:` built from an access request's email                               | **Open, accepted**                                                                          |

The section that matters most is the last one in that document: this is a code review by the author, which
is the weakest security assurance available. An external review is the next step.

## 8. Dataverse — what remains

A non-production environment, a dedicated test table, and a signed-in user. Four variables, one optional
privilege. [HARNESS_CHECKLIST.md](HARNESS_CHECKLIST.md) is the exact list, including which column on the
test table unlocks which capability and what each one records when it is absent.

Nothing is waiting on engineering. The harness compiles, lints, and skips cleanly.

## 9. Azure SQL — what remains

`TEST_AZURE_SQL_URL`, and a login that can create and drop a schema. Optionally a firewall-blocked server
and an Entra-credentialled URL for those two cases. It cleans up after itself.

This is the cheaper of the two and converts four matrix rows in one run.

## 10. Information architecture

**Step 1 done**, which is what the Phase 4 recommendation said to do "next regardless". `/team` and
`/audit` are destinations; every existing route still works; nothing else moved.

Doing it found the gap behind the navigation one: **the four workspace roles could not be assigned.**

Steps 2 to 4 — project tabs, collapsing the sidebar, retiring the orphans — deliberately deferred. They are
a routing change with its own evidence, not work to smuggle into a phase about correctness.

## 11. The evidence chain

Each stage recorded what it saw in its own vocabulary and nothing joined them.
`GET /api/runs/:id/chain` joins them on the column, which is what all three name.

On the brief's own example:

```
READINESS    SCHEMA_MAXLENGTH on account.websiteurl
             "Values longer than 100 characters will be rejected"
                                  ↓
MIGRATION    6 records refused, each named, each with the column that refused them
                                  ↓
VALIDATION   RECORD_EXISTENCE FAIL — those records are not in the target
             each listed individually, with no invented target id
                                  ↓
EVIDENCE     readiness.json holds the assessment made BEFORE the run
             lineage/ holds one row per record with its write state
```

Three confidences, labelled: `MATCHED_ON_COLUMN` (a strong inference, not a recorded relationship),
`RECORDED` (a prediction with nothing downstream), `UNMATCHED` (a failure no prediction accounts for — the
row that shows where readiness has a gap).

## 12. Operational readiness

`GET /api/platform/operations`, operator-only, answering the brief's questions with a verdict **and** the
number it came from: healthy, running, stuck, backing up, retrying, waiting on a person, growing, cleanup.

One check is not on the brief's list and is the most important: records with an unresolved write state, and
runs needing reconciliation. Those do not resolve on their own and nothing else told an operator they were
waiting.

A test asserts every detail carries a figure. It failed first time — "Every running job has heartbeated
recently" has no number in it. The code changed, not the test.

## 13. Manual inspection

**The deployed QA environment was not inspected, and that is a gap.** The Railway CLI cannot execute in this
session — `railway --version` exits non-zero with no output while `curl` to QA works, so it is the binary and
not the network. Reaching Railway through its MCP connector confirmed the obstacle: the service has **no
GitHub source attached**, so its only deploy path is `railway up` from local source. MCP's `redeploy` reruns
an existing build and `create-deployment` would build a different service.

What was done instead, against the **built server** (`dist/`, `NODE_ENV=production`) and labelled as such:

- **The pilot workflow, walked end to end.** Ten steps, ten API calls, no dead ends, evidence `VALID`.
- **Twelve screens at 1440, 390, 360 and 320 pixels.** No horizontal overflow, no console error, no error
  card, no empty page.
- **The public surfaces.** Health carries the version and deployment and nothing else. A crafted
  `?error=Your account is locked. Call 0800…` link redirects to `/login?error=INCOMPLETE`. Operator
  diagnostics refuse an unauthenticated request.

### What the inspection found that tests had not

- **A first pilot migration into a populated target reports FAIL.** Correct — six records the target refused
  are six records not there — and a customer's first impression of their own pilot is a red verdict.
  Documented rather than softened.
- **A demo workspace arrives with two projects nobody made.** For an evaluator they are the point; for a
  pilot customer they are indistinguishable from their own work.
- **One false alarm, mine.** 500s appeared on several screens until I realised I had deleted the running
  server's data directory during a tidy-up. Worth recording: the pages still rendered with no error card, so
  a failing workspace query degrades silently rather than visibly.

## 14. Remaining P0 and P1

**P0**

1. **Dataverse is unverified.** Needs an environment. Not an engineering task.
2. **Sign-in is broken on the deployed environment.** Needs the three variables in section 2.

**P1**

3. Azure SQL unverified.
4. Tonight's work is not on QA. Needs `railway up` from a machine where the CLI runs.
5. The SSRF bound does not resolve names. Needs a pinned socket, not validation.
6. Whether the write slowdown above a million rows is ours or PGlite's.
7. "Attempt" means two things, and the evidence lineage column shows the wrong one. Needs an evidence
   schema 4 and a verifier that knows three column sets.
8. A hundred-table plan is one enormous screen.

## 15. Remaining work, classified

**Requires engineering** — IA steps 2 to 4; the lineage "Attempt" column and schema 4; streaming the
lossy-records export; pinning the SSRF resolution; the mapping screen at a hundred tables; a navigation path
from a validation difference to the whole record.

**Requires an external environment** — Dataverse verification; Azure SQL verification; scale against a real
PostgreSQL server; a sustained multi-hour run; the QA deploy.

**Requires a product decision** — whether a pilot deployment seeds the curated demo projects, and whether
they get a label; whether evidence packages are signed, which needs a key somebody controls; the product
name; whether a project should have a word for a migration wave.

**Requires a customer pilot** — whether readiness findings are the ones people actually need; whether a FAIL
verdict on a first migration reads as honesty or as a broken product; whether the evidence package satisfies
a real auditor.

## 16. The next ten

1. Set the three Entra variables. Everything about sign-in is blocked behind them.
2. `railway up` so tonight's work reaches QA, then walk the pilot flow there.
3. Azure SQL verification — cheapest conversion of unverified to verified.
4. Dataverse read-only verification. Even stopping there replaces "we have never talked to Dataverse" with
   "authentication, discovery and reading are verified".
5. Attach a GitHub source to the Railway service, so a deploy is a push.
6. Dataverse writes against the dedicated table.
7. Re-run the scale suite against a real PostgreSQL server.
8. An external security review.
9. The evidence lineage "Attempt" column, with schema 4.
10. One real pilot customer, and listen to which of section 15's "requires a customer pilot" questions they
    answer differently from how we guessed.
