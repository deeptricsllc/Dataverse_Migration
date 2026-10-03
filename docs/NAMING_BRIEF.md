# Naming brief

Research only. Nothing is renamed, and `shared/product.ts` is where a decision would land.

Dated 1 October 2026.

---

## What the product has actually become

It is not a pipeline. Pipelines move data and are judged on throughput; this is judged on whether
somebody believes the result. Three sprints of work have gone into one thing: making every number
the product shows defensible, and saying so when it is not.

What it does that a pipeline does not:

- Profiles a source and names what contradicts the target's requirements **before** anything runs.
- Classifies every source record in a dry run — create, update, unchanged, conflict, blocked — while
  writing nothing.
- Records source → run → target for every record, so any row can be traced back.
- Verifies the target against the **source**, through the same transformation engine the migration
  used, rather than re-reading its own work.
- States how much it examined, and refuses to say "all checks passed" over a sample.
- Says NOT VERIFIED where a check could not run, instead of passing.
- Publishes what it cannot guarantee, per connector, with the evidence behind each claim.

## Category

**Migration assurance.** Not ETL, not integration, not data quality.

The nearest existing categories are all adjacent and none fits: ETL/ELT is about moving, data
observability is about monitoring production pipelines over time, data quality is about profiling
and cleansing, test-data management is about provisioning. This is the thing a migration programme
needs between "we think it worked" and signing off — evidence a sponsor can accept and an auditor
can read.

## One-sentence positioning

> For teams moving business-critical data between systems, this is the platform that proves what
> actually happened — record by record, with the coverage stated and the limits published.

Alternative, shorter, for a hero line:

> Know what a migration will do, and prove what it did.

## Core buyer

**Primary: the migration lead** — a consultant or internal programme lead accountable for a cutover.
They are measured on a go/no-go decision and on nobody discovering a problem three months later.
They have tooling to move data; what they lack is evidence.

**Economic buyer:** the programme sponsor or Head of Data who signs off the cutover, carries the
risk, and needs something to show an auditor or a board.

**Blocker:** the platform or security team who will ask where the data goes, which is why the
published security and governance posture matters more than a feature list.

## Primary pain

A migration ends and nobody can prove it was correct. The counts in the tool disagree with the
counts in the target. The things that failed are in a log nobody reads. Three months later a sales
director says a region's revenue looks wrong and there is no way to tell whether it is a migration
defect, a source problem, or always-was. Cutover weekend decisions get made on spreadsheets and
nerve.

## Differentiated promise

**Honest limitations, provably correct results, actionable validation.** Specifically, three things
competitors generally will not say:

1. Coverage is stated. "No differences in the 50,000 records examined, of 10,000,000" is a sentence
   most tools will not print.
2. Capability claims carry their evidence. "Implemented, not verified" sits on the connection card.
3. A check that could not run says NOT VERIFIED rather than passing.

The strategic bet: in a category where every vendor claims everything works, the one that publishes
what it cannot guarantee is the one a cautious buyer trusts. That is also a hard position to copy,
because copying it means admitting things.

## Naming directions

Fifteen, grouped by what they lean on. None is checked for trademark or domain availability.

### Evidence and proof

1. **Provenant** — provenance plus "proven". Serious, slightly legal, one word, ownable.
2. **Attest** — what the product does to a migration. Short, confident, crowded in compliance.
3. **Ledgerly** — a ledger is the record nobody argues with. Risks sounding like fintech.
4. **Receipt** — a migration's receipt. Memorable, informal, might undersell.
5. **Veritrail** — truth plus trail. Says traceability directly; slightly constructed.

### Before and after

6. **Beforehand** — the preflight promise in one word. Warm, very ownable, says less about proof.
7. **Foreknown** — knowing what will happen before it does. Distinctive, a touch literary.
8. **Dryrun** — exactly what the product sells. Almost certainly taken; generic.

### Crossing and landing

9. **Landfall** — where the data arrives, and arriving safely. Evocative, memorable, not literal.
10. **Crossing** — the migration itself, with weight. Common word, harder to own.
11. **Causeway** — a safe crossing built to carry weight. Strong metaphor, pleasant to say.

### Instrument and measure

12. **Plumbline** — the oldest instrument for checking something is true. Short, physical, exact.
13. **Assay** — to test a material for what it actually contains. Precise, slightly technical.
14. **Benchmark** — too generic, listed only to be rejected explicitly.

### Compound, descriptive

15. **MigrationProof** — says the category and the promise. Clear, searchable, a little flat, and it
    would never be misunderstood.

### If it stays in the GoGroup family

The company's other products are **SaaradhiGo**, **BhojanGo**, **ETicketsGo**. A consistent sibling
would be **MigrateGo** or **ProofGo**. Honest assessment: the `-Go` suffix reads as consumer and
fast-moving, which is the opposite of what this product sells. A migration-assurance platform
sounding like a delivery app works against the trust position. Recommend breaking the pattern here
and letting this one carry DeepTrics as the endorsing brand instead.

## Shortlist

If three had to go forward: **Plumbline**, **Provenant**, **Causeway**.

- _Plumbline_ if the product leads on measurement and exactness.
- _Provenant_ if it leads on evidence and audit.
- _Causeway_ if it leads on safe passage and the migration itself.

## Checks before deciding

- Trademark search in the markets that matter, in the software class.
- `.com` availability, and whether the exact-match domain is worth what it costs.
- Say it on a call: "we're running the migration through _X_". Names that are hard to say on the
  phone lose to names that are not.
- Check it does not already mean something in data engineering.
