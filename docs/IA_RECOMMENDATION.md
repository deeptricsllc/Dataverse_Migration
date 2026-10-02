# Information architecture: the recommendation

**Written for:** whoever decides whether to spend a phase on navigation, and whoever would implement it.

A recommendation, not an implementation. Nothing in this document has been built. It is written for a
migration professional doing the work, not for the shape of today's code — but it says what each change
costs, because a recommendation that ignores cost is a wish.

## What is there now

Ten flat destinations in one sidebar:

```
Dashboard · Projects · Connections · Schema comparison · User mapping ·
Migration · Validation · Runs · Microsoft checks · Settings
```

Routes:

| Route                                                                                    | Page                           |
| ---------------------------------------------------------------------------------------- | ------------------------------ |
| `/`                                                                                      | Dashboard                      |
| `/projects`, `/projects/:id`                                                             | Projects, one project          |
| `/analyses/:id`, `/data-comparisons/:id`                                                 | An analysis, a data comparison |
| `/environments`                                                                          | Connections                    |
| `/compare`, `/compare/:id`                                                               | Schema comparison              |
| `/users`                                                                                 | User mapping                   |
| `/migration`, `/migration/new`, `/migration/plans/:id`, `/migration/plans/:id/preflight` | Migration                      |
| `/runs`, `/runs/:id`                                                                     | Runs                           |
| `/validation`, `/validation/:id`                                                         | Validation                     |
| `/diagnostics`                                                                           | Microsoft checks               |
| `/settings`                                                                              | Settings                       |

### What is wrong with it

**It is organised by feature, and the work is organised by project.** A migration lead has one
question at a time — "what will this do", "did it work", "can I prove it" — and each answer is in a
different top-level section with no memory of which project they were in. The sidebar is a list of
what the product can do rather than a path through a job.

**Two of the ten are not destinations.** _Schema comparison_ and _User mapping_ are steps inside
preparing a migration. Having them at the top invites a reader to visit them cold, with no context for
what they are comparing or whose users they are mapping.

**The lifecycle is split across three sections.** A plan lives under _Migration_, its execution under
_Runs_, its verification under _Validation_, and the evidence package is reachable only from a run.
Those are four views of one thing, and the sidebar presents them as four unrelated areas. Somebody
auditing a migration has to reassemble it from three places.

**Evidence, findings and audit have no home.** Evidence is a download on a run page, findings are
inside a validation report, and the audit trail is not in the navigation at all. For the two roles
Phase 4 introduced — validator and auditor — those are the _only_ things they came for, and none of
them is a destination.

**One name is wrong and one is unclear.** _Microsoft checks_ names a vendor rather than a question.
_Connections_ is right; _Environments_ in the route is not, and the mismatch shows in the URL.

## The recommendation

**Yes to Workspace → Project → Migration lifecycle.** It is the correct hierarchy, with one
qualification that matters: **the lifecycle is a phase of a project, not a fourth level.** A migration
is not a thing inside a project that has its own children — it is the project, viewed at a stage. So
the hierarchy is two levels of container and a set of views, not three levels of nesting.

The test it has to pass: can somebody answer "what will this do", "what did it do", and "prove it"
without leaving the project they are in? Today they cannot.

### Workspace level

What is true across every project, and nothing else:

| Item            | Route          | Why it is here                                                                                                                                     |
| --------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projects**    | `/projects`    | The home page. A list of work, each with its stage and its last verdict. Replaces today's Dashboard.                                               |
| **Connections** | `/connections` | A connection is shared between projects, so it cannot live inside one. Carries each connector's verification level, which is workspace-wide truth. |
| **Audit**       | `/audit`       | Every action in the workspace, by anybody. The auditor's destination, and currently not in the navigation at all.                                  |
| **Team**        | `/team`        | Who is in the workspace and what they may do. The four roles exist; there is nowhere to see them.                                                  |
| **Settings**    | `/settings`    | Deployment-wide settings, safety mode, and the readiness of the environment itself — absorbing _Microsoft checks_.                                 |

Five items. Every one of them is something that is true of the workspace rather than of a piece of
work.

### Project level

Inside a project, in the order the work happens:

| Item                | Route                     | Absorbs                                                                |
| ------------------- | ------------------------- | ---------------------------------------------------------------------- |
| **Overview**        | `/projects/:id`           | The project's stage, its last run, its last verdict, what to do next   |
| **Source & target** | `/projects/:id/schema`    | _Schema comparison_, relationships, the dependency graph               |
| **Mapping**         | `/projects/:id/mapping`   | Table and column mapping, transformations, choice maps, _User mapping_ |
| **Readiness**       | `/projects/:id/readiness` | Preflight, the readiness assessment, blockers and their overrides      |
| **Migrate**         | `/projects/:id/migrate`   | Execution, progress, control, and this project's runs                  |
| **Verify**          | `/projects/:id/verify`    | Validation, coverage, findings, differences                            |
| **Evidence**        | `/projects/:id/evidence`  | Evidence packages, lineage, verification of a package                  |

Seven items, in lifecycle order, each a question rather than a feature. A reader who lands on any one
of them knows which project they are in and what comes next.

### Merge, rename, disappear

**Merge**

| Today             | Into                      | Reason                                                                             |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| Schema comparison | Project → Source & target | It is a step, not a destination, and it needs a project to mean anything           |
| User mapping      | Project → Mapping         | Mapping people is mapping; splitting it out implies it is a different kind of task |
| Runs (list)       | Project → Migrate         | A run belongs to a project. A workspace-wide run list is a report, not a place     |
| Validation (list) | Project → Verify          | The same                                                                           |
| Microsoft checks  | Settings                  | A tenant check is a setting's health, not a section of a migration tool            |
| Dashboard         | Projects                  | A dashboard that is not a list of work is a screen people pass through             |

**Rename**

| Today                | Proposed                                     | Reason                                                                                                                        |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Environments (route) | Connections                                  | The UI already says Connections; the route disagrees                                                                          |
| Migration            | Migrate                                      | A verb, matching the other lifecycle items                                                                                    |
| Validation           | Verify                                       | A verb, and it covers findings as well as the comparison                                                                      |
| Microsoft checks     | Microsoft connection health, inside Settings | Names the question, not the vendor                                                                                            |
| Preflight            | Readiness                                    | One word for one idea. "Preflight" and "readiness" are currently two names for overlapping things, which is worse than either |

**Disappear**

- The standalone **Dashboard**. Replaced by Projects.
- The standalone **Runs** and **Validation** lists as navigation items. The data stays; a
  workspace-wide view of either becomes a filter on Projects, for the person who wants one.
- **Microsoft checks** as a sidebar item.

Ten items become five plus seven — but only five are ever visible at once, and the seven appear only
once a reader is inside a project. The sidebar gets shorter and the product gets deeper, which is the
right trade for somebody who works on one migration for a week.

### Routes and backward compatibility

Every old route redirects; none breaks. People bookmark run pages and paste them into tickets.

| Old                                  | New                                                                 |
| ------------------------------------ | ------------------------------------------------------------------- |
| `/`                                  | `/projects`                                                         |
| `/environments`                      | `/connections`                                                      |
| `/compare`, `/compare/:id`           | `/projects/:id/schema` (or `/connections` when no project is known) |
| `/users`                             | `/projects/:id/mapping`                                             |
| `/migration`                         | `/projects`                                                         |
| `/migration/new`                     | `/projects/new`                                                     |
| `/migration/plans/:planId`           | `/projects/:projectId/mapping`                                      |
| `/migration/plans/:planId/preflight` | `/projects/:projectId/readiness`                                    |
| `/runs`                              | `/projects`                                                         |
| `/runs/:runId`                       | **kept** — a run is a stable thing people link to                   |
| `/validation`                        | `/projects`                                                         |
| `/validation/:id`                    | **kept**, for the same reason                                       |
| `/diagnostics`                       | `/settings#microsoft`                                               |

Two routes stay where they are on purpose: a run and a validation report are the two things people
share with somebody outside the product, and moving them would break links that are already in email.

Plan-scoped routes need a plan-to-project lookup to redirect, which every plan already has.

### How to do it, if it is done

Four steps, each one shippable and each one leaving the product working:

1. **Add the workspace items that do not exist.** Audit and Team become destinations; nothing moves.
   This is the step the Phase 4 roles need and it is additive.
2. **Give a project the seven tabs, as views over the pages that already exist.** No page is rewritten;
   each is rendered inside a project shell that knows the project. Old routes still work.
3. **Collapse the sidebar** to the five workspace items and add the redirects. This is the step a user
   notices, and by now every destination it points at exists.
4. **Retire the orphans** — the Dashboard, the standalone lists — once the logs show nobody reaching
   them except through a redirect.

### What this does not solve

- **A project is currently one source-target pair.** A real migration programme is several waves
  against the same pair, and the model has no word for a wave. This hierarchy makes that gap more
  visible rather than less, which is probably the right order to discover it in.
- **Nothing here improves a 100-table plan.** Mapping a hundred tables is a scale problem in one
  screen, and no amount of navigation fixes it.
- **The two curated demo projects** sit oddly in a project-first navigation: they are examples, not
  work. They probably want a label of their own.

## The recommendation in one line

Adopt Workspace → Project → lifecycle views; do step 1 next regardless, because the roles Phase 4
shipped have nowhere to go; and treat steps 2 to 4 as one phase with its own evidence, not as work
smuggled into a phase about correctness.
