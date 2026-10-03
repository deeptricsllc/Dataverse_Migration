# User acceptance testing

Written for: the people invited to try the platform, and whoever is coordinating them.

Half an hour gets you through everything worth forming an opinion about. You need no software, no
Microsoft tenant, and no data of your own.

---

## 1 · Getting in

Open the deployment and choose **Continue with demo account**.

**Put your name in the box first.** Everyone testing shares one workspace, which is deliberate —
you will see each other's work, the way a migration team does. A name keeps your projects and your
entries in the audit trail apart from everyone else's. Without one you are "Demo User" along with
everybody else who skipped it, and nobody can tell who did what afterwards.

Signing in again with the same name puts you back as the same person. Spelling and spacing do not
matter: "Priya Raman", "priya raman" and " Priya Raman " are all one tester.

**What you are connected to:** simulated Dataverse environments and a simulated legacy SQL Server,
seeded with deliberately messy data. No Microsoft tenant is connected. Nothing you do reaches a real
system, and the deployment is configured so that it could not even if you tried.

---

## 2 · What to try

In rough order of how much we want the feedback. Stop whenever you have had enough — partial
feedback is still useful.

### a) Understand a source you know nothing about

**Projects → New project → Data analysis.** Source: **Legacy SQL Server (Demo)**. Run an analysis
over `dbo.Customer` and `dbo.Order` with "examine every record" ticked.

Look at: whether the numbers mean anything to you, whether "these numbers are exact" lands, whether
the findings are things you would actually want to know, and whether the load order looks right.

Then **download the mapping workbook** and open it. Would you send this to a colleague who knows the
data? If not, what is missing from it?

### b) The dry run

**Projects → New project → Data migration**, source **DeepTrics Development**, target **DeepTrics
QA**. Create a plan over `account` and `contact`, then run a **Preflight**.

This is the part we most want judged. Nothing is written. Every source record is classified as
create, update, unchanged, conflict or blocked, with field-level detail.

Look at: whether you could hand the blocked list to a business owner and get a decision from it, and
whether **Export all issues** gives you something you would actually work from.

### c) Migrate, then check it

**Execute** the plan, watch it run, then **Validate**.

Look at: whether the validation report tells you plainly what happened. It says in words what the
numbers mean before it shows the numbers — tell us if it still leaves you guessing.

### d) Compare two systems

**Projects → New project → Comparison & validation**, with **DeepTrics Development** and **DeepTrics
QA** as the two sides. Accept the proposed pairings and run it.

This sells on its own to organisations with no migration at all, so we want to know whether it
stands up without the rest of the product around it.

### e) Load a file

**Connections → Add → CSV / Excel file**, then upload anything you have: a CSV, a spreadsheet, or an
XML export. Column types are inferred and the reasoning is shown.

Try to break it. Upload something odd. It should refuse clearly rather than produce a table of
nonsense — if it produces nonsense, that is the most valuable bug you can find today.

### f) The audit trail

**Settings → Audit trail.** Find what _you_ did, using the filters.

---

## 3 · What we already know

Please do not spend time reporting these.

| Not working yet             | Why                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Rollback execution          | We show what a run created and will not delete it. Before-images are not captured yet |
| DELETE synchronisation      | A record removed from the source is never removed from the target                     |
| "Continue with Microsoft"   | Not configured on this deployment. The demo account is the way in                     |
| OneDrive / SharePoint files | Built, never run against a real tenant, switched off here                             |
| Retry re-reads the source   | Only failed records are written, but the read starts again                            |

Two more things that are working as intended and look odd at first:

- **You share a workspace with the other testers.** Projects you did not create are theirs.
- **Everyone is an administrator here.** In a real deployment, writing to production, scheduling
  unattended runs and deleting connections need one; ordinary members do everything else.

---

## 4 · What we want to hear

In order of usefulness:

1. **Anything that told you something confidently and wrongly.** A number that does not add up, a
   screen that says "completed" about something that did not, a table of nonsense from a file it
   should have refused. This matters more to us than anything else on this list.
2. **A moment you did not know what to do next**, or a screen you had to re-read.
3. **A word that means something different in your world** than the way we have used it.
4. **Something you expected to be there and was not.**
5. Visual problems, at the bottom, unless they made something unreadable.

A sentence and a screenshot is plenty. Tell us your tester name if you used one, and we can find
exactly what you did in the audit trail.

---

## 5 · If it breaks

Nothing here can damage anything, so keep going if you can.

- **Something got into a bad state:** an administrator can restore the simulated data from
  **Settings → Safety → Reset demo environment data**. It restores the records and keeps run
  history. Tell the others first, since the workspace is shared.
- **A screen will not load:** reload it. If it still will not, tell us what you did just before.
- **A migration will not start:** it is probably refusing on purpose, and the message should say
  why. If the message does not say why, that is a bug and we want it.
