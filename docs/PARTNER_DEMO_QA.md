# Partner questions, and the honest answers

**Written for:** whoever is in the room answering these — so the answers are short, and they are what the
code actually does today rather than what it is for.

One rule runs through all of it: **implemented is not certified.** This product's Dataverse support is
written against Microsoft's documentation and exercised against a simulator. As of the build this document
ships with, **no Dataverse operation has ever been executed against a real Dataverse environment.**
Authentication has. If you only remember one line from this page, make it that one — a partner who later
discovers you blurred it will stop believing the rest.

See [DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md](DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md)
for the per-capability status, and [VERIFICATION.md](VERIFICATION.md) for what each status word means.

---

## Positioning

**Why not use Microsoft's native tools?**
Microsoft's tooling is strong at moving _configuration_ — solutions, and the Configuration Migration tool
for small reference datasets. It is not built for moving _business records_ between environments with
identity remapping, dependency ordering, change detection and a record-level audit of what arrived. That
gap is what this fills. If the job is "ship a solution", use Microsoft's tools.

**How is this different from configuration migration?**
Configuration migration moves schema and small lookup tables, keyed on GUIDs that it expects to match. This
moves records, and assumes GUIDs and user identities _do not_ match between environments — so it maintains
a mapping, resolves lookups through it, and orders tables so a parent exists before the record pointing at
it.

**Can it migrate between tenants?**
Architecturally yes, and it is not certified. Environments are discovered with the signed-in user's own
delegated token, so one identity with a Dataverse role in both tenants — a guest, typically — would see
both. Nothing in the product treats a tenant boundary as special once an environment has been discovered,
which is also an honest caution: cross-tenant has had no testing.

**Between environments in one tenant?**
That is the intended case, and the one the certification path targets. Still not certified.

**Can SQL Server be a source? Azure SQL?**
SQL Server, PostgreSQL and MySQL are certified against real database servers — the conformance suite runs
against actual engines and the evidence is committed. **Azure SQL is deliberately not certified**, even
though it shares the driver and most of the T-SQL surface with SQL Server, because sharing an
implementation is not evidence. It is held at "requires configuration" until a real Azure SQL database has
been run against. Files (CSV/Excel) are a certified source.

---

## Identity and GUIDs

**How are GUID differences handled?**
A record-level identity map, unique on run + table + source id, records which target record each source
record became. Lookups are resolved through it rather than by hoping the GUID exists in the target. The
default matching strategy writes the source GUID to the target, so ids are preserved where the target
permits it; the alternatives are an alternate key, or a business key you nominate.

**How are users mapped?**
Source users, teams and business units are read from the source environment and matched to the target in
priority order: Entra object id, then login/domain identity, then email, then a display name that is
unique. Anything matching more than one target is marked **ambiguous and is not mapped** — a guess here
silently reassigns somebody's records. You resolve those by hand or exclude them, and unresolved owners
surface as preflight issues before anything is written.

**How are owners preserved?**
Through that mapping, under one of three policies. `STRICT` **blocks** a record whose owner does not map,
rather than quietly reassigning it. `FALLBACK` writes it with an identity you choose, and records the
substitution per record and in the exports. `PRESERVE_ATTRIBUTION` additionally impersonates, which needs
the _Act on Behalf of Another User_ privilege assigned directly to the user — Microsoft does not honour it
when inherited through a team.

**What happens to Created On?**
It can be preserved, where the table has `overriddencreatedon` and the user holds that same privilege.
Without both, the target's Created On is the migration time. The product does not pretend otherwise.

**Created By? Modified By?**
Created By can be set under `PRESERVE_ATTRIBUTION`, by impersonation. **Modified On cannot be preserved at
all** — Dataverse sets it, and nothing can override it. So a migrated record always carries a Modified On
of when it was migrated. Say this plainly; it is the kind of thing a Dataverse-literate partner will test.

---

## Records and relationships

**How are lookups handled?**
Resolved through the identity map at write time: the child's lookup is pointed at the _target_ parent, not
the source GUID. Where a reference cannot be resolved in the first pass — a circular relationship — it is
deferred to a second pass rather than written wrong.

**How are dependencies ordered?**
A dependency graph is built from the real relationship metadata and topologically ordered, so a referenced
table is migrated before the table referencing it.

**How are circular relationships handled?**
Detected and reported rather than hidden, then resolved by deferring one side's reference to a second
pass. Self-references are the common case and work the same way.

**How do you avoid duplicates?**
The identity map. A source record already migrated in a previous run is recognised and updated rather than
created again, which is also what makes a resumed run safe. Within a single run, two source records
resolving to the same target record is a **conflict**, not an overwrite of the first.

**How does upsert work?**
Match, then decide. The matcher finds the target record by preserved id, alternate key or business key;
change detection then classifies it CREATE, UPDATE or UNCHANGED. Updates use `PATCH` with `If-Match: *`,
so Dataverse cannot implicitly create a record the matcher did not find.

**How do you avoid updating unchanged rows?**
Field-level comparison before writing. A record whose comparable fields all match is classified UNCHANGED
and no request is sent for it. This is the behaviour worth demonstrating by running the same migration
twice — but note it is **not yet certified against a real environment**, so demonstrate it, do not promise
it.

---

## Failure, rollback, validation

**What happens if migration fails halfway?**
Write-ahead intent: the platform records what it is about to do before doing it, so after a crash it can
tell "written" from "might have been written" and reconciles rather than guessing. Records it cannot
resolve are marked as needing human reconciliation instead of being silently counted either way. Resuming
skips what the identity map already shows as migrated.

**Can we roll back?**
**No — and be careful here.** What exists is a rollback _preview_: an inventory, from the identity map, of
every record the run created or updated, per table. There is no rollback execution, and the connector has
no delete operation at all — deliberately, because deleting a customer's records is not something this
product is allowed to do. The preview also states plainly what a rollback could not restore: records that
were **updated** cannot be reverted, because before-images are not captured.

So the honest sentence is: _"You get an exact inventory of what the run touched. Undoing it is a decision
you make with that inventory, not a button we press."_ If a partner needs true rollback, that is a roadmap
conversation, not a feature.

**How do you validate the migration?**
After a run, validation compares source and target: record existence, field values, and reference
integrity, with per-record drill-down. Counters are **derived by querying the identity map**, not
incremented as the run goes — so a crash cannot leave a plausible-looking total that no records support.
Evidence packages carry a SHA-256 manifest and can be re-verified later.

**Can we export discrepancies before migration?**
Yes, and this is the strongest part of the story. Preflight classifies every source record before anything
is written, and the remediation package is a CSV with severity, category, table, record id, record name,
field, source value, target value, the issue and a suggested action. The pitch is "know what will happen,
and fix it, before you touch the target".

**Can we transform data?**
Yes: trimming, normalisation, null and default handling, type conversion, date handling, choice mapping,
lookup mapping, string transformation, field mapping and exclusion, with before/after previews.
Transformations that would discard data are flagged as lossy and must be acknowledged explicitly before a
run will start.

---

## Security and data handling

**How are credentials protected?**
Microsoft sign-in is delegated OAuth with authorization code and PKCE. Refresh tokens are encrypted at
rest. Database passwords for SQL connections are encrypted and write-only through the API — supplied, never
returned.

**Does the platform store Microsoft passwords?**
No. It never sees one. Authentication happens on Microsoft's own sign-in page; the platform receives tokens.

**Can DeepTrics access customer data without the customer?**
Not through the product. Every Dataverse call is made with the signed-in user's delegated token, and the
product has no service principal or application-level Dataverse permission — so it can never act with more
rights than the person using it, and it cannot act at all when nobody is signed in. Be straight about the
limit of that claim: it is a statement about the application, not about who administers the deployment's
infrastructure and database.

**How is tenant isolation enforced?**
Every record belongs to an organization, and every query is scoped to the caller's organization. Admission
is gated by directory: `ACCESS_MODE=GATED` admits only tenants on an allow-list, and an empty allow-list
admits nobody rather than everybody — a deployment cannot become open by omission.

**What gets logged?**
An audit trail of who did what and when: sign-ins, plan and mapping changes, policy changes, preflights,
executions, bypasses, refused writes. Secrets are scrubbed from logs; tokens and authorization codes are
not logged. Microsoft's raw error text goes to the operational log, never to the browser — a visitor sees
one of a closed set of messages.

**Is there a safety switch for a first connection?**
Yes, and it is server-side, not a hidden button. `REAL_TENANT_READ_ONLY` refuses every Dataverse write
inside the HTTP client — before a token is even acquired — and refuses to queue a run at all. Writes for a
controlled certification are opened for **named non-production environments only**, and production is
refused even when named.

---

## Status and roadmap

**What is currently certified versus merely supported by code?**

|                                                               |                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Certified against the real thing**                          | Microsoft authentication and tenant admission, end to end against the real Entra directory. SQL Server, PostgreSQL, MySQL and file import, against real engines                                                                     |
| **Implemented, exercised against a simulator, not certified** | Every Dataverse capability: discovery, metadata, reads, planning, preflight, writes, validation                                                                                                                                     |
| **Deliberately not claimed**                                  | Azure SQL. Dataverse duplicate detection and database-side total reconciliation, because the available Dataverse query stops early at an aggregate limit and "no duplicates" from a query that gave up is the worst possible answer |
| **Does not exist**                                            | Rollback execution. Record deletion of any kind                                                                                                                                                                                     |

**What is the roadmap?**
Complete the Dataverse real-tenant certification — read-only first, then controlled writes into a scratch
environment. Then Azure SQL. Rollback execution would need before-image capture and is not scheduled. Do
not present any of this as a date.

---

## If a partner pushes on certification

Do not get defensive, and do not oversell. The useful answer is roughly:

> "Authentication is proven against our real directory. Dataverse is implemented and tested against a
> simulator, and we have not yet run it against a live Dataverse environment — the tooling to do that is
> built and waiting on two sandbox environments. I would rather tell you that than show you a green
> dashboard and have you find out later."

That answer has repeatedly turned out to buy more credibility than a claim would, and it is the only one
the evidence supports.
