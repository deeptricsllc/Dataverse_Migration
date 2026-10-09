# Analyze Experience Certification

/ **Verdict: not yet certified for partner demonstrations. Cleared for internal use.** /

The Analyze journey a first-time user walks now completes end to end on deployed QA, and the report it
produces is arithmetically true about the data it was given. Two things stop this being a partner-demo
certification, and neither is a defect in the journey: the release has not had the independent review the
brief requires, and the connectors a partner would ask about are simulated.

---

## 1. What was certified, and where

|                                      |                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Deployment                           | `https://dataverse-migration-app-qa.up.railway.app` (Railway QA)                     |
| Commit                               | `analyse-journey@1e4a8b628f90` (`1e4a8b628f9062c22953c8fd56bffecee29a9f98`)          |
| Railway deployment                   | `6e3e61e3-…` superseded by the upload of this commit; previous deployments `REMOVED` |
| Evidence run                         | `e2e/analyse-first-time-user.spec.ts`, 1 passed, 34.7s                               |
| Console errors                       | 0                                                                                    |
| Failed network requests (HTTP ≥ 400) | 0                                                                                    |

The deployed SHA was not taken on trust. The walkthrough reads `/api/settings` before it touches anything
and fails if the commit the deployment reports is not a prefix of the candidate:

```
[provenance] analyse-journey@1e4a8b628f90
```

This guard was added during this work (`95eafb4`). It already existed for the validation walkthrough; the
Analyze walkthrough — the one this certification rests on — did not have it, which meant "I deployed it
first" was the only thing connecting the screenshots to the build. A deploy that silently fails to roll
over leaves the previous image answering every request, and the screenshots look identical.

### Reproducing the evidence

```bash
E2E_BASE_URL=https://dataverse-migration-app-qa.up.railway.app \
EXPECTED_SHA=$(git rev-parse HEAD) \
CAPTURE_DIR=.capture-cert \
npx playwright test e2e/analyse-first-time-user.spec.ts
```

Writes 16 screenshots at 1440×900 and 1920×1080, plus the exported findings CSV, into `.capture-cert/`.
Captures are gitignored deliberately — they are regenerated per build, and a stale screenshot in the
repository is worse than none.

---

## 2. Release process — BLOCKED, requires the owner

This is the part of the brief I could not complete, and I did not work around it.

|                  | PR #5                                            | PR #6                                               |
| ---------------- | ------------------------------------------------ | --------------------------------------------------- |
| Title            | A validation that could not check said it passed | Analysis of a connection nobody chose anything from |
| Head             | `0897ecd9`                                       | `1e4a8b62`                                          |
| `reviewDecision` | none                                             | none                                                |
| Author           | me                                               | me                                                  |
| Merged           | no                                               | no                                                  |

Both pull requests are authored by me, so I cannot be their independent reviewer. The brief says to merge
only after independent review and to not bypass approval requirements, so both remain open.

One thing worth stating plainly, because it changes what the blocker _is_: **`main` has no branch
protection rule.** There is no GitHub control preventing a merge here — the approval requirement is your
policy, not a configured gate. I have treated your policy as binding. If you want that policy enforced
rather than observed, a protection rule on `main` would make it so.

The repository has a single collaborator (`deeptricsllc`), so independent review needs either a second
reviewer added or an explicit, recorded owner exception of the kind you granted once before for PR #5.

CI has been re-run against each exact head as it moved. The last completed run before this report was
green; the run for `1e4a8b62` was still in progress at the time of writing and must be green before any
merge.

---

## 3. The first-time-user walkthrough

Twelve steps, every one a click. Nothing reaches past the interface to construct a state a user would have
had to reach themselves. Screenshot numbers are the files in `.capture-cert/<width>/`.

| #   | Step                                        | What it proves                                            | Shot   |
| --- | ------------------------------------------- | --------------------------------------------------------- | ------ |
| 1   | Arrive with no context                      | The landing page and demo entry work cold                 | 01, 02 |
| 2   | Create an analysis project                  | Name alone is enough; a source is optional                | 03, 04 |
| 3   | Attempt analysis with no file               | **There is no button to press**                           | 05     |
| 4–5 | Upload a 4-sheet workbook, read the preview | Every sheet offered with its shape, before import         | 06, 07 |
| 6   | Choose three of four sheets                 | The unchosen sheet is absent from the project             | 08, 09 |
| 7   | Run the analysis                            | All three datasets reach `Analysed`                       | 10     |
| 8   | Inspect findings                            | Severity, category, dataset filters; evidence per finding | 11     |
| 9   | Readiness and its arithmetic                | Every dimension shows its own calculation                 | 12     |
| 10  | Export the report                           | CSV downloads, 200, contains the critical finding         | 13     |
| 11  | Add a second source and re-analyse          | Four datasets across two connections                      | 14, 15 |
| 12  | Leave and reopen                            | 4 datasets, 205 records, all still `Analysed`             | 16     |

### Step 3 deserves a note

The original defect you reported was: create a project, attach a connection with nothing selected, press
Analyse, get `None of the requested tables exist in this source`. That state is now unreachable. The
project screen with no data offers `Add dataset` and nothing else — there is no Analyse control to press,
because an action that cannot succeed should not be offered.

The refusal path still exists for the case where content is removed after a project is built, and it is
covered separately by `e2e/analyse-nothing-selected.spec.ts` and five integration tests in
`tests/integration/analysis-nothing-selected.test.ts`, which assert the refusal at project creation, at
`addSource`, and at run time, plus the positive case and that an explicit selection is honoured.

---

## 4. UX defects found and fixed

All five were found by reading the screenshots this walkthrough produced against the deployed build, not
by inspection of the code. None were hypothetical.

**1 — The report could not be taken away.** Three export endpoints existed (`tables.csv`, `findings.csv`,
`columns.csv`), each behind a URL nothing in the analysis workspace linked to. A user told their data is
79/100 with one critical problem had no way to give that to anyone. Added
`GET /api/projects/:id/findings.csv` — every finding across every dataset, with the reasoning the screen
keeps behind a disclosure — and surfaced it in the workspace header. (`a8cadf9`)

This was hiding behind a test defect: the export step was wrapped in `if (visible)`, so when no export
control existed the step passed in silence and the screenshot labelled "export" was a picture of the
overview. The step is now required.

**2 — The overview contradicted its own header.** With a fourth dataset mid-analysis, the header read
`4 datasets · 205 records · 1 not analysed yet` and the paragraph directly beneath it read "contains 3
datasets across 3 tables" and quoted a readiness score, with nothing marking that score as partial. Both
numbers were arithmetically right and the sentence was still false. The summary now states what it has not
looked at, counted in the same unit the header counts in, so the two cannot disagree. (`7403210`)

**3 — "Dataset" meant two things on one screen.** The dataset list counts each _sheet_ as a dataset and
says "3 datasets" for one workbook; six inches below, "Analysis history" said "Each run covers one
dataset" above a single row named `FinanceExport.xlsx`. A run is per connection, and the caption now says
so. (`a69fb3a`)

**4 — Invalid email addresses were counted in spellings, not records.** See §5. (`1b698ee`)

**5 — The critical identity finding was refuted by its own evidence.** See §5. (`1b698ee`, `1e4a8b6`)

### A defect in the walkthrough itself

Defect 2 was only visible because the test photographed a half-finished project — it waited for the text
`Analysed`, which the _first_ dataset to finish puts on screen while the others are still running. It
would have read a partial score as the final one. It now waits for the amber "not analysed yet" to clear
and for no `Analysing` button to remain.

### Judgements I did not act on

- **All four sheets are pre-ticked in the preview,** including a one-row "Read Me". The default is visible
  and reversible and matches the documented "take the whole workbook when no selection is given"
  behaviour, so I left it. It is still the kind of default that quietly imports a notes tab.
- **The Source field on the new-project form now stacks three hints** that partly repeat each other
  ("Optional…", "The system this project reads. It is never written to.", and a `read-only` badge).
  Cosmetic redundancy, not a comprehension failure.

---

## 5. Business value, checked against the input

The brief is explicit that a clean file proves nothing. The test workbook is generated with known defects,
so every number the product reports can be checked against the data that produced it.

**Input:** `FinanceExport.xlsx` — Customers (60 rows), Contacts (40), Orders (90), "Read Me" (1, not
imported). Then `suppliers.csv` (15 rows) as a second connection.

### Every finding, against what was actually in the file

| Finding                                          | Reported                   | In the data                              | ✓   |
| ------------------------------------------------ | -------------------------- | ---------------------------------------- | --- |
| No reliable record identifier (Customers)        | CRITICAL, 60 records, 100% | No unique+complete identifier column     | ✓   |
| `customer_number` near miss                      | 48 distinct across 60      | 12 of 60 rows repeat an earlier number   | ✓   |
| `email` empty (Customers)                        | 20 records, 33.3%          | `i % 3 == 0` of 60 = 20                  | ✓   |
| `email` empty (Contacts)                         | 10 records, 25%            | `i % 4 == 0` of 40 = 10                  | ✓   |
| `email` not valid (Customers)                    | 4 records, 6.7%            | `i % 11 == 0` and not `% 3` = 4          | ✓   |
| `customer_name` stray spaces                     | 9 records, 15%             | `i % 7 == 0` of 60 = 9                   | ✓   |
| `opened_on` dates as numbers                     | 60 records                 | all 60 are Excel serials                 | ✓   |
| `ordered_on` dates as numbers                    | 90 records                 | all 90 are Excel serials                 | ✓   |
| `customer_number` / `order_number` business keys | INFO                       | both unique and complete in their tables | ✓   |
| Personal data columns                            | INFO ×2                    | both `email` columns                     | ✓   |
| "Read Me" sheet                                  | absent                     | deselected at import                     | ✓   |

`customer_name` is independently consistent: 52 distinct across 60, which is exactly what 9 rows sharing
one padded value produces.

### How readiness is calculated, on screen

Final state, four datasets, 205 records, 14 findings: **79 / 100, "Needs attention"**, 1 critical,
7 warnings, 6 informational. Each dimension shows its own arithmetic rather than asserting a number:

```
Identity & keys   65    100 − 1 critical × 35 = 65
Completeness      70    100 − 3 warning  × 10 = 70
Consistency       90    100 − 1 warning  × 10 = 90
Validity          90    100 − 1 warning  × 10 = 90
```

A critical finding forces at least "Needs attention" regardless of the average, so the number cannot say
"ready" next to "no record can be reliably identified".

### The two findings that were wrong, and are not now

Both were found by taking the report the deployed product produced and checking its numbers against the
generator. Both understated the problem, which is the direction that costs a migration.

**Invalid addresses were counted in spellings.** The semantic reader works from a _distinct_ sample of
values, so its "N are not addresses" is a count of distinct bad values. That number was published as
"Records affected" and divided by the record count. The file holds `not-an-email` in four records; the
report said **1 record, 1.7%**. One bad address repeated across ten thousand rows would have been reported
as one record. The profiler now counts records, using the same regex the reader uses to decide the column
holds addresses at all, so the two cannot disagree. It now reports **4 records, 6.7%**.

**"No reliable record identifier" was refuted by its own evidence.** The summary said "No column in
Customers is both unique and filled in for every record". The evidence printed underneath it read
`credit_limit: 60 distinct across 60 examined, 0 empty values` — a column that is exactly that. The
key-candidate rule was right to reject `credit_limit` (unique by accident, useless as a key); the
_near-miss_ list ranked by distinctness alone, so it surfaced the columns the key rule had just rejected
and pushed `customer_number` — the column obviously meant to be the key, repeating across 12 records —
off the end of a three-item list. Near misses now prefer columns that could plausibly identify a record,
and the sentence says "that could identify a record", which is what was measured. The evidence now reads
`customer_number: 48 distinct across 60 examined, 0 empty values`.

A follow-up to the first fix was caught by the release gate rather than by me: counting invalid addresses
into `invalidValueCount` as well raised a second finding claiming those values "could not be converted to
String". They convert to String perfectly well. The same records were being reported twice and deducted
twice.

Both fixes carry regression tests that were confirmed to fail without them.

---

## 6. Limitations

### Live connectors — UNVERIFIED, and the product says so

The connector picker labels Azure SQL, SharePoint and OneDrive `SIMULATED`, and Azure SQL carries the
sentence "Never run against a real Azure SQL database. Shares a driver with SQL Server, which is not
evidence." The whole QA environment runs in `DEMO MODE` behind a persistent banner: no Microsoft tenant is
connected and no real data is read or written.

Nothing in this certification is evidence about a live SharePoint, OneDrive, Azure SQL or Dataverse
connection. File import (CSV, Excel, XML) and the analysis engine are certified against real file content.
Certifying a live connector needs credentials and a tenant, which I do not have and did not ask for.

### Analysis gaps found but deliberately not fixed

Your brief says not to add features until the journey validates, so these are recorded rather than built:

- **The 12 colliding `customer_number` values are never counted.** The critical finding now names the
  column and shows `48 distinct across 60`, from which the collision count can be derived — but no finding
  says "12 records share a customer number". The near-unique duplicate rule has a deliberate threshold
  (around 99%) that 80% does not meet. For a double-export, which is the most expensive thing to find
  after a migration rather than before it, that count is the number a person wants.
- **Money stored as text is not detected.** `credit_limit` holds `$1,200.50` in 12 of 60 rows and plain
  numbers in the rest. Excel serial dates are detected and flagged; currency-as-text is not.
- **Relationships are not assessed.** `Contacts.customer_number` and `Orders.customer_number` both
  reference `Customers`, and nothing says so.

### Scope

Migration, validation and audit were not re-certified here. This covers the Analyze journey only.

---

## 7. Verdict

**Internal use: yes.** A first-time user can create an analysis project, import a multi-sheet workbook,
choose what to analyse, run it, read findings that are true about their data, see how the score was
calculated, export the report, add a second source, and come back later to find it all still there — with
no developer assistance and no console errors.

**Partner demonstrations: not yet.** Two reasons, in order:

1. **The release has not been independently reviewed.** PR #5 and PR #6 are both mine and both unmerged.
   What is deployed to QA is a branch, not a reviewed and merged release.
2. **Everything a partner would ask about a connector is simulated.** A demonstration that imports a
   spreadsheet is honest and useful; a demonstration implying a live SharePoint or Dataverse connection
   has been proven would not be, and the product's own `SIMULATED` labels would contradict it on screen.

The journey itself is no longer the blocker. It was when this work started.

---

_Evidence: `.capture-cert/` (16 screenshots × 2 widths, plus `analysis-findings.csv`), regenerated by the
command in §1. Release gate: 7 passed, 1 skipped — evidence drift runs in CI's engines job, not locally._
