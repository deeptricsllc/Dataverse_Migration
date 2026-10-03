# The market this platform is entering

Written for: whoever decides what gets built and how it is sold — and, with light editing, for a
partner or investor who asks "why does this need to exist?"

This is an honest survey, not a competitive hit piece. Several of the tools below are excellent and
some of them we should integrate with rather than fight. The useful question is not "are we better
than Informatica" — we are not, at what Informatica does — but **which specific job is badly served
today, and is it a job somebody pays for.**

---

## 1 · Why there is a market at all

Three numbers explain the whole category.

| Number                                                                                                          | What it actually says                                                                |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **83%** of data migrations fail or overrun (Gartner); **~75%** with ~30% cost and ~41% schedule overrun (Bloor) | Migration is a routinely-failing project type, and everyone in the industry knows it |
| **$12.9M** average annual cost of poor data quality per organization (Gartner)                                  | The damage is continuous, not a one-off event                                        |
| **15–25%** of revenue lost to poor data quality (MIT Sloan)                                                     | It is a board-level number when someone bothers to compute it                        |

The interesting detail is _how_ migrations fail. They rarely fail loudly. They complete, and the
damage surfaces weeks later: truncated fields, reassigned ownership, duplicated records, a table
that silently did not arrive. By then the source has moved on and nobody can prove what happened.

**That gap — between "the job ran" and "the data is right" — is the product.**

---

## 2 · The five categories, and what each one is actually for

### a) Enterprise integration and ETL/ELT platforms

**Informatica (IDMC), Qlik Talend, IBM DataStage, SAP Data Services, Matillion, Azure Data Factory,
AWS DMS, Qlik Replicate.**

_The job:_ move large volumes on a schedule, transform on the way, with lineage and governance
attached. They are pipelines-as-infrastructure.

_Why people buy:_ scale, connector breadth (Talend claims 900+), regulatory lineage, and the fact
that a Fortune 500 audit committee has heard of them. Informatica handles petabyte-scale with
masking and governance built in.

_Where they leave the customer exposed:_ they are built for **repeating** flows. A migration is a
one-way, one-time, high-consequence event with a different question at its centre — not "did the
pipeline run?" but "is the destination now correct, and can I prove it?" These platforms will tell
you a job succeeded and how many rows moved. They will not tell you, before you commit, that 38
records will lose the end of a text field, or that two source records claim the same customer.

_Cost of entry:_ Qlik Talend is estimated at $60k–$180k/year base, typically $100k–$200k in
practice. Informatica is in the same bracket or above. That price point excludes an enormous middle
market.

_Consolidation worth noting:_ **Salesforce closed its $8B acquisition of Informatica in November
2025**, and **Fivetran and dbt Labs merged in October 2025** (~$600M combined ARR). The category is
consolidating into fewer, larger, more expensive suites. That historically opens room underneath.

### b) Ingestion / replication specialists

**Fivetran, Airbyte, Stitch, Hevo.**

_The job:_ get SaaS and database sources into a warehouse reliably, with schema drift handled
automatically. Fivetran sets a connector up in ten minutes.

_Why people buy:_ it removes an entire class of maintenance work.

_Where they leave the customer exposed:_ they are deliberately opinionated — source to warehouse,
append-oriented, warehouse-shaped. They are not designed to write into a _business application_
with referential integrity, ownership, business rules and plug-ins on the other side. Writing into
Dataverse is a fundamentally different problem from landing rows in Snowflake.

### c) Data quality and observability

**Great Expectations, Soda, Monte Carlo, Bigeye, Anomalo, Metaplane, Ataccama, Collibra DQ.**

_The job:_ assert that data meets expectations, and alert when it drifts. Great Expectations is the
leading open-source framework; Soda fits code-first engineering teams; Monte Carlo and Bigeye are
observability-first with lineage and anomaly detection.

_Why people buy:_ continuous confidence, and early warning before a dashboard lies to an executive.

_Where they leave the customer exposed:_ they check data **against rules you wrote**, in a warehouse
you control, usually after the fact. Someone has to know in advance what to assert. In a migration
the most expensive problems are the ones nobody thought to write a rule for — and they happen at the
moment of the write, not on a monitoring schedule.

### d) Row-level compare and reconciliation

**Redgate SQL Data Compare, ApexSQL Data Diff, dbForge, Datafold (data-diff).**

_The job:_ compare the contents of two datasets and report what differs. Redgate is used for
automating data migrations, analysing corrupted data, restoring row-level data and compiling audit
trails of missing or changed data. Datafold is the strongest "shift-left" companion, diffing data
before and after a code change.

_Why people buy:_ it is the only honest way to answer "are these two systems the same?"

_Where they leave the customer exposed:_ **they are almost all single-technology.** Redgate and
ApexSQL are SQL Server tools. Datafold is warehouse-oriented. None of them will reconcile a legacy
SQL Server against Dataverse, or a SharePoint list against Postgres — which is exactly the
comparison an organisation mid-migration or post-migration needs. This is the closest category to
our comparison feature, and the gap is real.

### e) Microsoft Dataverse / Dynamics 365 specialists

**KingswaySoft (SSIS Integration Toolkit), SSIS, Skyvia, XrmToolBox Data Migration Tool, CData,
the legacy Scribe Insight estate.**

_The job:_ move data in and out of Dataverse specifically, honouring its API semantics.

_Why people buy:_ KingswaySoft is genuinely good — eight actions (create, update, delete, upsert,
merge, convert, send, execute workflow), four matching options for update/upsert, parallel threads
for scale. It is the default answer for serious Dynamics migrations.

_Where they leave the customer exposed:_ **KingswaySoft is a component inside SSIS.** It requires
Visual Studio, an SSIS developer, and a deployment story. It is a toolkit for engineers, not a
platform a migration _team_ — including the business analysts who actually know what the data
means — can use together. XrmToolBox's Data Migration Tool is free and useful but is export-to-JSON
and import-back: no preflight, no validation report, no audit trail. Scribe Insight is end-of-life
and its estate is actively looking for replacements.

There is no "GitHub for a Dataverse migration": a place where the analysis, the mapping decisions,
the dry run, the execution and the proof all live together and can be handed to somebody else.

---

## 3 · The gap, stated plainly

Every category above owns a phase. **Nobody owns the seam between them.**

```
   Analysis                Mapping               Execution              Proof
   (profiling tools)       (spreadsheets!)       (ETL / KingswaySoft)   (nobody, or manual SQL)
        │                       │                       │                    │
        └───────────────────────┴───────────────────────┴────────────────────┘
                     ↑ the seam: where migrations actually fail
```

In practice the seam is held together by a spreadsheet and somebody's memory. The mapping lives in
Excel. The transformation rules live in SSIS expressions. The verification lives in ad-hoc SQL run
by whoever is still awake. Each artefact is produced by a different tool, and **nothing checks that
they agree with each other.**

That is why the "one transformation engine" property matters commercially and not just
architecturally: if preview, preflight, execution and validation all call the same code, the four
cannot disagree. In a stack assembled from four tools, they _always_ eventually disagree, and nobody
finds out until a customer complains.

**The specific, fundable job:** give a migration team a single place where they can answer, before
they commit, "exactly what will happen to my data?", and afterwards, "exactly what happened?" —
across systems that are not all the same technology.

---

## 4 · Where this platform already stands

Honest assessment against the categories above.

**Genuinely differentiated:**

1. **The preflight as a first-class product surface.** Classifying every source record as
   create / update / unchanged / conflict / blocked, with field-level detail, before anything is
   written. ETL tools have "validate" buttons that check connectivity and schema; this checks the
   actual records and produces something a business owner can make a decision from. I have not found
   a comparable screen in any tool in category (a) or (e).
2. **One transformation engine across preview, preflight, execution and validation.** This is an
   architectural property most suites cannot claim because they grew by acquisition.
3. **Exact-versus-sampled labelling on every statistic.** Most profiling tools sample silently.
4. **Data loss counted, not estimated, and acknowledged by name.** A truncation over 145,283 records
   where 38 actually lose information reports 38 — and somebody has to accept that in the audit
   trail before the run proceeds.
5. **Cross-technology row-level comparison.** Category (d) does this within one technology. Doing it
   between Dataverse and SQL Server and files is a real gap being filled.
6. **The analysis half being read-only by construction**, so it can be sold to an organisation that
   has not yet agreed to let anything write.

**Where the incumbents are ahead, and it would be dishonest to pretend otherwise:**

| They have                                            | We have                                                  |
| ---------------------------------------------------- | -------------------------------------------------------- |
| Hundreds of connectors                               | Nine                                                     |
| Petabyte-scale proven at reference customers         | A streaming engine that is not capped, unproven at scale |
| Lineage, masking, MDM, stewardship workflows         | An audit trail                                           |
| Rollback and before-image capture (Redgate, ApexSQL) | An inventory of what a run created, and no delete        |
| Decades of brand trust in procurement                | A QA deployment                                          |

---

## 5 · What the research says to build next

Ordered by (value to a buyer) ÷ (effort), with the reasoning rather than just the list.

### Tier 1 — closes a gap a buyer will actually ask about

1. **Before-image capture, and then real rollback.** Redgate and ApexSQL both do row-level
   restore; it is table stakes in category (d), and "can you undo it?" is the first question a
   serious evaluator asks. We currently answer no, honestly. Capturing the prior state of every
   record we update is the missing primitive — and it is also what would let a _comparison_ answer
   "what changed since last month", which sells on its own.
2. **Scheduled comparison with alerting.** Categories (c) and (d) have taught the market to expect
   continuous checking, not a manual run. We already have cron, time zones and a scheduler; pointing
   them at a comparison instead of a migration is a small piece of work that turns a one-off report
   into a subscription. _This is the single highest ratio item on this list._
3. **Reconciliation thresholds and pass/fail policy.** "Fail the run if more than 0.5% of records
   differ." Soda and Great Expectations sell on exactly this shape. Without it, a comparison is a
   report somebody has to read; with it, it is a gate something else can depend on.

### Tier 2 — widens the buyer

4. **More connectors, chosen deliberately.** Not breadth for its own sake: Snowflake, Salesforce
   and SharePoint Online cover most of what a Dataverse-adjacent buyer also holds.
5. **A repeatable "migration package"** — export a whole configured migration (mappings,
   transformations, keys, acknowledgements) and import it into another tenant. This is how a partner
   or SI makes money with the tool, and it makes them an advocate rather than a competitor.
6. **Business-user review workflow.** The remediation package is currently an export. The people who
   resolve those issues are not the people running the tool. A shareable, assignable issue list is
   what turns this from a technical tool into a project management surface — which is where
   incumbents are weakest.

### Tier 3 — strategic, not urgent

7. **The on-premises agent** (already designed, not built). It unblocks every customer whose source
   is behind a firewall, which in this market is most of them.
8. **Column-level lineage export** to Purview/Collibra. We do not need to build governance; we need
   to hand our facts to whoever owns it.
9. **A rules library** shaped like Great Expectations' expectations, so analysis findings become
   reusable assertions.

---

## 6 · How to position it

Against the field, three sentences that are all true and all defensible:

> **For the middle of the market that cannot buy Informatica and should not be doing this in
> spreadsheets.** A migration platform where nothing is written until you have seen exactly what
> writing would do — and where the proof afterwards is generated by the same engine that did the
> work, so the two cannot disagree.
>
> **The comparison half stands alone.** Two systems that are supposed to agree, reconciled record by
> record across different technologies — which the SQL-only compare tools cannot do.
>
> **It tells you what it does not know.** Every number says whether it is exact or sampled, every
> capped list says it is capped, and the gaps are published rather than discovered.

For a **Microsoft** conversation specifically: the honest pitch is that Dataverse migrations are a
recurring source of customer pain, the incumbent answer requires an SSIS developer, and the free
tooling has no assurance layer at all. This platform is complementary to Dataverse rather than
competitive with anything Microsoft sells.

For a **partner/SI** conversation: they currently bill for the manual reconciliation work this
automates. That is a threat unless it is framed as margin — the same team delivering more
migrations, with the evidence pack the client asks for at the end already produced. Item 5 in Tier 2
is what makes that argument concrete.

---

## 7 · What this survey changed about the product

Recorded so the reasoning is not lost:

- **Scheduled comparison moved to the top of the roadmap.** The research made it obvious that the
  market expects continuous checking; we had already built every component and simply had not
  pointed them at each other.
- **Rollback stopped being "a gap we disclose" and became the Tier 1 item.** Two direct competitors
  in the compare category ship row-level restore. It is no longer an acceptable permanent no.
- **The confirmation friction was reconsidered.** Typing a target name for every execution was
  protecting a sandbox as heavily as production, which trains people to type without reading. The
  gate now scales with the consequence — a pattern taken from how these tools treat destructive
  operations generally.

---

## Sources

- [Gartner/Bloor migration failure rates](https://www.gtconsult.com/blogs/post/why-83-of-data-migrations-fail-the-critical-phase-most-teams-skip) ·
  [Bloor overruns](https://dataflowmapper.com/blog/data-migration-costs-quantitative-analysis)
- [Cost of poor data quality (Gartner $12.9M, IBM $3.1T, MIT Sloan)](https://www.ibm.com/think/insights/cost-of-poor-data-quality)
- [Talend / Informatica / Fivetran / dbt comparison and pricing](https://technologymatch.com/blog/talend-vs-informatica-vs-fivetran-vs-dbt)
- [Enterprise data migration tool comparison](https://www.rocketlane.com/blogs/enterprise-data-migration-software)
- [Data observability: Monte Carlo vs Great Expectations vs Soda](https://algoscale.com/go/blog/data-observability-stack-comparison/)
- [Datafold and shift-left data diffing](https://www.dqlabs.ai/blog/best-data-quality-tools-for-enterprise-use-in-2026-a-practitioners-guide/)
- [Redgate SQL Data Compare](https://www.red-gate.com/products/sql-data-compare/) ·
  [ApexSQL Data Diff](https://alternativeto.net/software/apexsql-data-diff/about/)
- [KingswaySoft SSIS Integration Toolkit for Dataverse](https://www.kingswaysoft.com/connectors/api/dataverse) ·
  [XrmToolBox Data Migration Tool](https://www.xrmtoolbox.com/plugins/Dataverse.XrmTools.DataMigrationTool/)
- [Dynamics 365 CE migration approaches](https://dynamicsservicesgroup.com/2025/09/15/dynamics-365-ce-data-migration-approaches-overview/)
