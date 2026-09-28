# Demo script

Written for: whoever is running the demo.

Fifteen minutes, no setup, nothing to configure. Demo mode ships with two simulated Dataverse
environments and a simulated legacy SQL Server, seeded with data that is deliberately messy — padded
names, blank and malformed emails, a duplicate business key, a broken foreign key, a choice value the
target does not have, a record whose owner cannot be resolved. Every problem you will point at is a
real problem in the data, found by the product, not a slide.

**The one thing to internalise:** the product's pitch is not "it moves data". Plenty of things move
data. The pitch is **"you will know exactly what is going to happen before it happens, and exactly
what happened afterwards."** Every beat below serves that. If you are short on time, cut the breadth
and keep the preflight.

---

## Before you start

- Open the QA deployment. The landing page is the front door now, and **Try the live demo** is on it —
  no tenant needed, nothing to configure.
- Confirm the amber **DEMO MODE** banner is visible. Say it out loud once: nothing here touches a real
  system. It buys you credibility for everything after.
- Have the browser at a width where the tables do not wrap.

---

## 0 · The landing page (30 seconds, optional)

Only if your audience arrived cold. Scroll past the hero to **"The gaps, before you find them."**

> "Before I show you anything — that section is on our public page. Rollback, DELETE synchronisation,
> what we have not tested against a live server. We would rather you heard the limits from us than
> found them in week three."

It is a disarming way to open with a technical audience, and it sets up everything that follows: the
whole product is built on saying what is actually true, including when the answer is "we do not know
that yet".

---

## 1 · Frame the problem (1 min, no clicking)

> "Most migration failures are not technical. Somebody moves 40,000 records, and three weeks later
> finance finds that 200 of them have the wrong owner, or the notes field was silently truncated. By
> then the source has moved on and nobody can prove what happened.
>
> So this tool is built around one idea: nothing is a surprise. Let me show you the two halves —
> understanding a source, and moving it."

---

## 2 · Analyse a source you know nothing about (4 min)

**Projects → New project → Data analysis.** Name it, pick **Legacy SQL Server (Demo)** as the source.

> "Note what it does _not_ ask for. An analysis project has no target. It cannot write anywhere — that
> is enforced, not a convention."

**Run an analysis** over `dbo.Customer` and `dbo.Order`, with "examine every record" ticked.

When it finishes, slow down. This screen is the one that earns trust:

- **"These numbers are exact."** Point at it. → _"Every count on this page is a total, because every
  record was read. If we had sampled, it would say sampled and treat the numbers as a floor. The tool
  never presents an estimate as a fact — that distinction runs through the whole product."_
- **Load order.** `dbo.Customer` before `dbo.Order`, with the dependency shown. → _"It worked that out
  from the real foreign keys. Nobody told it."_
- **Empty columns.** → _"That column is in every export because the report has always had it, and it
  has never contained anything. You would have mapped it and never known."_
- **Click into a table.** Per-column population, nulls, blanks, distinct values, lengths, ranges.
  → _"This is the conversation you normally have three weeks in, over email."_
- **Findings tab.** → _"These are things the source contradicts about itself — a column its own schema
  says is required, holding blanks. No target involved yet."_

**Download the mapping workbook.** Open it.

> "Four sheets. The source columns are measured facts. The target columns are blank, because that is
> the decision only your team can make — and they will make it in Excel, not in my tool. Fill it in,
> send it back, import it. Every row goes through the same validation the mapping screen uses, so this
> file cannot set a mapping the product would have refused."

_If they ask about file sources:_ Connections → Add → **CSV / Excel file**, then upload anything. Point
out the inferred types with the **reason** for each, and that a column with one `TBC` in it stays text
— _"guessing a number would have failed every row at migration time; guessing text costs one
conversion."_

---

## 3 · Preflight: the beat that closes the demo (5 min)

Switch to the migration side. **Projects → New project → Data migration**, source **DeepTrics
Development**, target **DeepTrics QA**, based on the analysis project.

Create a plan over `account` and `contact`, then walk the steps quickly — mapping is table-by-table
and column-by-column, with a compatibility verdict per column. Two things to land:

- A suggested mapping is **never** applied without confirmation.
- `dtx_tier` has a choice value the target does not have; the plan says so rather than dropping it.

Now **Preflight**, and let it finish.

> "Nothing has been written. This is a dry run that read every record and classified it."

Walk the tiles: **create, update, unchanged, conflict, blocked.** Then click into **blocked**.

> "This record is blocked because its owner does not exist in the target. This one because two source
> records share the same business key — so the tool refuses to guess which one you meant. And this
> field-level view shows the source value, the target value and what it would do.
>
> This is the screen that makes the difference. You can hand this to the business and get a decision
> before anything moves, instead of after."

Then **Export all issues (remediation package)**.

> "Every problem, with a suggested resolution, in one file. If the list is a subset because a table is
> enormous, the file says so — we would rather tell you the number is partial than let you work from
> it thinking it is complete."

_If they push on data loss:_ show the **data-loss acknowledgement** — a truncation is named, with how
many records are actually affected (not how many the rule runs on), the longest source value, and a
per-rule checkbox. _"You cannot run this until somebody accepts that, by name, and it is in the audit
trail."_

---

## 4 · Run it, then prove it (3 min)

**Execute.** Type the target name to confirm — _"we make you type it; a dropdown is too easy"_ — then
watch it run: live progress, per-table counts, transformations applied.

When it finishes: **Validate.**

> "This is not the same code re-reading its own work. It compares the target against the source
> independently: row counts, record existence, field values, references. Every check either passes or
> tells you exactly what differs."

Then the parts people ask about:

- **Record inventory** — every source record and the target record it became. _"Run it twice and
  nothing duplicates. That is what this map is for."_
- **Runs history** and the **audit trail** in Settings. _"Who ran what, against which environments,
  with which options, and who accepted the data-loss warning."_
- **Rollback panel.** Be straight: _"We show you exactly what this run created, in reverse dependency
  order, and we tell you plainly that we will not delete it for you — because we do not capture
  before-images yet, so we could not restore an updated record and we will not pretend otherwise."_
  Honesty here buys more than a half-working feature would.

---

## 4b · Comparison, for the people who are not migrating anything (2 min)

Worth its own beat, because it sells on its own — an organization with no migration in flight still
has two systems that are supposed to agree.

**Projects → New project → Comparison & validation.** Point it at two connections.

> "No target, no plan, no migration. Two datasets and one question: do they agree?"

Run it. The setup proposes which tables pair with which and what identifies a record; confirm and go.

Then the result: matched, different, only on A, only on B — and the field-level detail with the key
of every record that differs.

> "This is the monthly reconciliation somebody currently does in Excel. It is also what you run a
> year after a migration, when somebody asks whether the two systems have drifted."

_If they ask what happens with a bad key:_ show it. Pick a column that is empty on one side — the run
comes back FAILED saying nothing was compared and naming the key. _"A tool that returns zeroes and
lets you read them as a pass is worse than one that refuses."_

---

## 5 · Keep it correct (2 min)

On the plan's review step, **add a schedule**.

> "Data does not hold still, so a migration is only correct at the moment somebody clicked. A schedule
> keeps it correct — cron in a real time zone, so 02:00 stays 02:00 across the clock change. It can
> read only what changed since last time.
>
> And it goes through exactly the same gates as a person: it will not run a plan with unresolved
> blockers, it will not perform a transformation that discards data unless that was already accepted,
> and it will not run if a warning has appeared that nobody has reviewed. If it fails repeatedly it
> pauses itself rather than queueing the same error all night."

---

## Questions you will be asked

**"Can it do rollback?"** Not execution, deliberately. We inventory everything a run created, in
reverse dependency order, and we are explicit that updates cannot be restored because before-images
are not captured. Auto-deleting production data on the strength of that would be worse than saying no.

**"How does it handle 10 million records?"** The migration streams and is not capped. It is resumable:
pause, cancel and retry are durable across a worker restart, and a re-run skips everything already
migrated. Preflight and validation _are_ capped — and say so on screen and in the file.

**"What about our SQL Server / Postgres / MySQL / spreadsheets?"** All sources, either direction for
the databases. Files are read-only by design. See `docs/SOURCES.md` for what each one is tested
against, including what is not.

**"Is our data safe?"** Never modified in the source. Credentials encrypted at rest and never returned
by the API. Secured columns masked in every preview and export. Tenant isolation covered by tests that
probe every route as another organization's administrator. Writing to production needs an
administrator; a member can migrate to a sandbox.

**"What is missing?"** `docs/LAUNCH_READINESS.md` — hand it over. It is written to be read by a
sceptic, and it names the gaps before they find them.

---

## Do not

- **Do not claim rollback.** The panel says NOT YET SUPPORTED. Say the same thing.
- **Do not say "exact" about a sampled number.** The product is careful about this; be as careful.
- **Do not demo OneDrive or SharePoint live.** The connector is built and unit-tested, but it has never
  run against a real tenant. Say that if asked.
- **Do not skip the DEMO MODE banner.** Someone will ask whether this is touching real data, and you
  want to have said it first.
