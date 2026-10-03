# Dataverse real-tenant read-only certification

**Recorded:** 2026-10-03 · **Deployed build certified against:** `9ce2862f9e2e` (QA) · **Mode:**
`REAL_TENANT_READ_ONLY=true`

---

## 1. Executive verdict

**This certification did not complete, and Dataverse remains uncertified against a real tenant.**

What is proven, and was proven before this phase began, is the authentication chain: a real person signed
in through the deployed QA application against the real Microsoft Entra directory, and the real `tid`
claim passed the workspace admission gate. That holds.

What is **not** proven is everything the phase was actually about. Not one Dataverse operation has been
executed against a real Dataverse environment. Discovery, connection, metadata, relationships,
dependencies, identity mapping, schema comparison, planning, preflight and the live write refusal are all
**NOT EXECUTED**. The verification matrix still says `SIMULATED` for every Dataverse capability, and this
report does not change a single cell of it.

The reason is a single missing prerequisite, and it is not an engineering defect:

> **Dataverse access is delegated.** The only credential that can reach the tenant is the refresh token
> produced by a person's own interactive sign-in, held encrypted in the deployment's database. There is no
> service credential, by design — the product never acts with more rights than the person using it. So
> every Dataverse call must be made as a signed-in user, and nothing in this session is one.

That boundary is stated precisely in [section 13](#13-remaining-release-candidate-blockers), with the one
action required to cross it.

What this phase did produce:

- **A certification run that is now one command** — [`scripts/certify-dataverse-readonly.mjs`](../scripts/certify-dataverse-readonly.mjs),
  which drives the deployed application's own HTTP API through all ten phases and writes a sanitized
  evidence file. It substitutes nothing for Dataverse.
- **Two defects found and fixed in that run before it could produce false evidence** — both of the kind
  that reports success about work that did not happen. See [section 11](#11-defects-found).
- **Four discrepancies between the documentation and the implementation**, including one that makes the
  documented read-only harness route impossible to execute as written. See [section 11](#11-defects-found).
- **One configuration finding on QA** that contradicts this repository's own certification prerequisites.
  See [section 2](#2-environment).

Nothing here supports calling the product a release candidate. The sentence it currently earns is
unchanged from before this phase: _authentication is verified against a real tenant; Dataverse is not._

---

## 2. Environment

| Thing                        | Value                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Deployment                   | QA, `https://dataverse-migration-app-qa.up.railway.app`                            |
| Deployed commit              | `9ce2862f9e2e`                                                                     |
| Repository HEAD at recording | `4d56b011784b`                                                                     |
| Code difference between them | **None.** `git diff 9ce2862 HEAD` touches `docs/PHASE_5_REPORT.md` only            |
| Deployment created           | 2026-10-03T00:10:44Z, status SUCCESS                                               |
| Node / runtime               | `NODE_ENV=production`, worker enabled (`RUN_WORKER=true`)                          |
| Database                     | PostgreSQL (Railway)                                                               |
| Microsoft tenant             | `0eca5595-…` (the DeepTrics directory)                                             |
| App registration             | `ecf355ec-83f9-4be4-b937-5bf080e97379` — public; it travels in every authorize URL |
| Admission                    | `ACCESS_MODE=GATED`, `ALLOWED_TENANT_IDS=0eca5595-…`                               |
| Operator                     | `ADMIN_EMAILS` names one address                                                   |
| Discovery service            | `https://globaldisco.crm.dynamics.com` (default)                                   |
| Dataverse API version        | `v9.2`                                                                             |
| Power Platform enrichment    | off                                                                                |
| **`REAL_TENANT_READ_ONLY`**  | **`true`** — confirmed from the running process, not only from the variable        |
| Session lifetime             | 12 hours (`SESSION_TTL_HOURS` default)                                             |

`REAL_TENANT_READ_ONLY=true` was confirmed three ways from the deployed build itself, unauthenticated:

```
GET /api/health        200 {"status":"ok","version":"1.0.0","deployment":"qa"}
GET /api/auth/config   200 {"microsoftEnabled":true,"demoEnabled":true,
                            "realTenantReadOnly":true,"signUpEnabled":false}
GET /api/auth/session  200 {"user":null,"csrfToken":null,"realTenantReadOnly":true}
```

It was **not** changed, weakened, bypassed or worked around at any point in this phase.

### Configuration finding: QA has `DEMO_MODE=true`

`demoEnabled:true` above is a real finding, and it contradicts this repository's own prerequisite.
[REAL_TENANT_CERTIFICATION.md](REAL_TENANT_CERTIFICATION.md) step A1 says to set `DEMO_MODE=false`
("no simulated environments and no demo sign-in") and then says:

> Confirm the header of every page shows a blue bar reading **REAL TENANT — READ ONLY**. If you instead
> see the amber **DEMO MODE** bar, `DEMO_MODE` is still on and you are not looking at real data.

On QA you will see the amber bar. Two consequences, and they are not the same size:

- **Not a blocker to real discovery.** The simulated-versus-real decision is made **per environment**, not
  per deployment: [`factory.ts`](../server/src/dataverse/factory.ts) branches on `env.provider === 'demo'`,
  and [`environment-service.ts`](../server/src/services/environment-service.ts) selects the discovery
  provider from `ctx.isDemoOrg`, a property of the organization. A workspace created by a real Microsoft
  sign-in is not a demo organization, so it gets `GlobalDiscoveryProvider` and a real `WebApiConnection`
  regardless. Real certification is therefore possible on QA as configured.
- **It does leave anonymous sign-in open.** `POST /api/auth/demo-login` is reachable while `DEMO_MODE` is
  true, so anyone with the QA URL can create a workspace without Microsoft at all. `ACCESS_MODE=GATED`
  governs the Microsoft path only. On a deployment whose URL is shared with prospects that may well be
  the intent — but it is worth being a decision rather than a leftover.

**This was not changed.** Turning it off would remove the demo scenarios and the demo sign-in that the QA
deployment exists to show, which is an outward-facing change and the owner's call, not mine.

---

## 3. Authentication evidence

**Status: VERIFIED.** Established 2026-10-02 against the deployed QA build, recorded in
[PHASE_5_REPORT.md](PHASE_5_REPORT.md) §2 and §14. Reproduced here because the rest of this report depends
on it.

The chain, every link real:

| Link                      | Evidence                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| User → deployed QA        | `GET /api/auth/login` in the QA request log                                                                                           |
| → Microsoft authorization | Microsoft's own consent screen, titled with the app registration's display name                                                       |
| → correct application     | consent screen named the registration behind `ecf355ec-…`; the prior `AADSTS700016` for `69bc3659-…` is what identified the wrong one |
| → correct tenant          | authority is tenant-specific: `login.microsoftonline.com/0eca5595-…`                                                                  |
| → callback                | `GET /api/auth/callback` in the QA request log, returning a redirect, not an error page                                               |
| → MSAL code redemption    | succeeded only after the nonce fix; before it, `ClientAuthError: nonce_mismatch`                                                      |
| → verified identity       | `acquireTokenByCode` returned `idTokenClaims` MSAL had validated against the issued nonce                                             |
| → real `tid`              | the `tid` claim was compared against `ALLOWED_TENANT_IDS` and admitted                                                                |
| → workspace admission     | `AUTH_SIGN_IN` / `SUCCESS` audit event with an organization id and a user id                                                          |
| → authenticated session   | `/api/auth/session` ×3 then `/api/dashboard` ×2, all 200                                                                              |

No refusals, no 4xx, no 5xx. Nothing in this chain was mocked.

**The gap this closed is worth restating, because it is the reason this document is cautious.** 910 tests
were green while the first real sign-in was broken, because
[`tests/integration/auth-matrix.test.ts`](../tests/integration/auth-matrix.test.ts) replaces `redeemCode`
wholesale. Its own header says those cases prove the boundary behaves correctly _given_ a verified
identity, not that Microsoft verified one. That was accurate, documented — and exactly the gap that bit.
**Apply the same reading to every `SIMULATED` cell for Dataverse below.**

### Operator diagnostics

**Status: NOT EXECUTED.** `/api/platform/auth-configuration` and `/api/platform/operations` both correctly
return `401 UNAUTHENTICATED` to an anonymous caller, which is the only half that can be established
without a session. That the signed-in operator can reach them is phase 1 of the prepared run and has not
been executed.

---

## 4. Environment discovery evidence

**Status: NOT EXECUTED.**

No call was made to the Dataverse Global Discovery Service. What exists is the prepared step and a read of
the code path it will exercise:

- `POST /api/environments/discover` → `EnvironmentService.discover` → `ConnectionFactory.discoveryProvider(ctx.isDemoOrg, …)`
  → `GlobalDiscoveryProvider.discover()` → `GET {discoveryUrl}/api/discovery/v2.0/Instances` with the
  user's delegated token.
- Returned instances are mapped to `provider: 'dataverse'` rows carrying `FriendlyName`, `Url`, `ApiUrl`,
  `Id`, `EnvironmentId`, `UniqueName`, `OrganizationType`, `Region`, `Version` and `State`.
- Anonymous probe confirms the route is behind a session: `POST /api/environments/discover → 401 UNAUTHENTICATED`.

**On another tenant's environment entering the workspace.** Nothing was executed, so this is an
architectural reading, not evidence: discovery is a delegated call, so the service returns only instances
the signed-in identity can reach, and for a non-demo organization `discover()` is the only writer of
environment rows. There is no import, no manual URL entry and no admin-supplied list. The residual case
worth watching once a real run happens is a **guest** identity with roles in a second directory, which
would legitimately see instances from both — the prepared run records every environment's type and
organization id so that case is visible rather than inferred.

---

## 5. Metadata evidence

**Status: NOT EXECUTED.** No Dataverse metadata has been read.

The prepared step reads `GET /api/environments/:id/tables` for the catalog, then
`GET /api/environments/:id/tables/:table` for three to five tables chosen to exercise different shapes
rather than the first five alphabetically, and records for each: attribute count and distinct types,
required levels seen, writable versus read-only counts, lookups, choice attributes, calculated
attributes, alternate keys, one-to-many / many-to-one / many-to-many relationship counts, self references,
`statecode`/`statuscode` presence, ownership type, and the primary id and name attributes.

Every shape the brief asks about that the selected tables do **not** contain is recorded as not
exercised, by name. That list is the honest part: it is how a reader can tell "this environment has no
many-to-many relationship in these tables" from "we did not look".

---

## 6. Dependency engine evidence

**Status: NOT EXECUTED against real relationships.**

The dependency engine is exercised heavily against simulator-generated relationships by the ordinary
suite and the golden journeys. That establishes the algorithm; it establishes nothing about Dataverse's
relationship metadata, which is the thing in question.

The prepared step builds a plan over the real tables, then records the computed entity order, reported
cycles, entities requiring a second pass, and plan validation warnings — **capturing what the current
implementation produces before changing anything**, as the brief requires. No algorithm change was made,
because no real relationship data has been seen to justify one.

---

## 7. Identity mapping evidence

**Status: NOT EXECUTED.**

The prepared step calls `POST /api/principal-mappings/refresh`, then reads the result and counts
principals by kind (`systemuser`, `team`, `businessunit`) and by state (MAPPED / AMBIGUOUS / UNRESOLVED /
IGNORED), recording which match bases actually fired. It then runs
`POST /api/principal-mappings/impersonation-check`, which is read-only in both directions — "cannot
impersonate" is a valid answer and writes nothing.

No owner is modified and no user is impersonated for a write, in this phase or by this tooling: the
product has no code path that would, and `REAL_TENANT_READ_ONLY` refuses the attempt regardless.

**This step needs two environments.** See [section 13](#13-remaining-release-candidate-blockers).

---

## 8. Schema diff evidence

**Status: NOT EXECUTED.**

Cross-environment comparison requires two environments, and the prepared run marks this step
`NOT_EXECUTED` with that exact reason if only one is available rather than inventing a result. No schema
was created to manufacture differences, and none will be.

---

## 9. Migration planning evidence

**Status: NOT EXECUTED.**

The prepared step creates a plan, reads its readiness report, runs a preflight, waits for it to reach
`COMPLETED`, and records the classification counts from the run totals **cross-checked against an
independent per-action record query**. Classifications the real data does not naturally produce are
recorded as not exercised; none is forced into existence.

The two routes to those counts are compared on purpose. They are supposed to agree, and if they ever do
not, the disagreement is the finding — a report that quietly picked one of them would have buried it.

---

## 10. Read-only enforcement evidence

**Status: PARTIALLY VERIFIED.** This is the one row that moved, and it moved by a small amount that needs
describing precisely.

### What is verified

The guard exists in two places, and both were read in full for this report.

**1. The last layer before the HTTP request.** [`web-api-connection.ts:123`](../server/src/dataverse/web-api-connection.ts):

```ts
if (this.opts.readOnly && WRITE_METHODS.has(method.toUpperCase())) {
  throw new DataverseError('READ_ONLY_MODE', `REAL_TENANT_READ_ONLY is enabled. …`, 403, …, false);
}
```

`WRITE_METHODS` is `POST, PATCH, PUT, DELETE, MERGE`. Three properties were established:

- **There is exactly one `fetch` call site in the connection**, at line 148, and the guard is above it.
  Every write method in the class (`createRecord`, `updateRecord`, including the impersonated form) routes
  through `request()`. No method bypasses it.
- **No read is performed via a write method.** `WhoAmI` and the impersonation check are `GET`, so the
  guard cannot be weakened by an exemption for POST-shaped reads, and there is none.
- **The refusal happens before a token is acquired** — the guard is above `getAccessToken()`. This was
  previously untested and is now asserted in
  [`tests/unit/safety-and-matching.test.ts`](../tests/unit/safety-and-matching.test.ts): a refused write
  must not acquire a Dataverse token. Mutation-checked — moving the guard below token acquisition fails
  that case and only that case (`expected 1 to be +0`), with the other thirteen still passing. It is what
  makes "refused before the request leaves the process" literally rather than nearly true.

**2. Before a run can be queued.** [`migration-run-service.ts:62`](../server/src/services/migration-run-service.ts)
`assertWritesAllowed` records a `READ_ONLY_WRITE_BLOCKED` audit event and throws
`403 REAL_TENANT_READ_ONLY`. It is called from all three entry points — `start` (181), `resume` (369) and
`retry` (373) — and it exempts only `demo` and `demosql` providers, which hold no tenant data.

Each bypass vector the brief names, traced to where it is stopped:

| Vector                    | Stopped by                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| The UI                    | Both guards are server-side; neither depends on a disabled button                        |
| Direct API invocation     | `assertWritesAllowed` in `start`, before any run row is created                          |
| Workers / background jobs | The worker builds its connector from the same factory, which sets `readOnly` from config |
| Retries                   | `assertWritesAllowed(…, 'RETRY')` at line 373                                            |
| Resumed jobs              | `assertWritesAllowed(…, 'RESUME')` at line 369                                           |
| Scheduled jobs            | `ScheduleService.fire` calls `runs.start`, so it passes through the same guard at 181    |
| Represented in job state  | The throw happens before the run row is inserted, so no run reaches a misleading state   |
| On the audit trail        | `READ_ONLY_WRITE_BLOCKED` with organization, user, target environment and request id     |

### What is not verified, and is the gap

- **No live refusal against a real tenant has been observed.** Phase 10 of the prepared run requests
  execution through the normal API and asserts `403 REAL_TENANT_READ_ONLY`, four times, that the run list
  does not grow, and that four `READ_ONLY_WRITE_BLOCKED` audit events appear. It has not been run.
- **No independent inspection of a target environment** has established that no mutation occurred, because
  no target environment has been touched.
- **The queue-time guard has no automated test.** The client-side guard has four; `assertWritesAllowed`
  has none. A fixture-heavy integration test was deliberately not written: the brief is explicit that
  tests should follow a defect, and reading the five call sites found no defect to follow. The live probe
  is the proof this needs, and it is prepared.

**The probe is interlocked.** It runs only with `--prove-write-block`, and before sending it the script
asks the deployment whether `realTenantReadOnly` is true _from the running process_ and refuses to
continue otherwise. Against a deployment that permits writes it would not be a probe, it would be a
migration.

---

## 11. Defects found

### D1 — The documented read-only harness cannot reach a real tenant (documentation defect)

**Symptom.** [HARNESS_CHECKLIST.md](HARNESS_CHECKLIST.md) presents
`tests/tenant/dataverse.tenant.test.ts` as ready to run, needing only configuration, and its "order to do
this in" step 2 says _"Dataverse read-only next — `TENANT_TEST_URL` alone."_ That cannot work.

**Root cause.** Three independent reasons, all in the harness's own setup:

1. [`tests/helpers.ts`](../tests/helpers.ts) `createTestApp` hard-codes `DEMO_MODE: 'true'`,
   `PGLITE_DATA_DIR: 'memory://'`, and empty `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`. With no client
   credentials no delegated token can ever be acquired.
2. The database is created with `pgliteDataDir: 'memory://'` — a fresh, empty database per run.
3. `harnessContext` calls `api.demoLogin()`, creating a **new demo organization**. The harness then looks
   for an environment matching `TENANT_TEST_URL` in that organization and asserts it exists.

So the harness's `beforeAll` fails at `expect(wanted).toBeTruthy()`: a brand-new demo organization in a
brand-new in-memory database can never contain an environment discovered by somebody signing in to the
deployed QA application. The checklist's premise — sign in, then this finds it by URL — assumes one shared
database that does not exist between those two steps.

**Impact.** The primary source of truth for this phase points at a route that cannot be executed. Anyone
following it loses the time it takes to find out.

**Fix.** Not applied to the harness. Making it work means letting `createTestApp` take a real database and
real client credentials, and resolving a real non-demo organization instead of a demo login — which is a
change to the fixture 92 test files depend on, for a route superseded for read-only certification by
`scripts/certify-dataverse-readonly.mjs`. The harness's remaining value is the **write** half, which is
out of scope for this phase. [HARNESS_CHECKLIST.md](HARNESS_CHECKLIST.md) has been corrected to say so
rather than left asserting something untrue.

### D2 — The read-only certification path needs two environments, not one

**Symptom.** The first run of the prepared driver pointed source and target at the same environment and
got `HTTP 400 BAD_REQUEST: Source and target must be different environments` from planning, preflight and
principal mapping.

**Root cause.** The product is right, and consistently so: five services refuse it —
`comparison-service.ts:38`, `environment-service.ts:340`, `planning-service.ts:228`,
`principal-service.ts:157`, `validation-service.ts:334`.

**Impact.** On the harness, none — this was a defect in the new driver, fixed before any real run. On the
documentation, a real one: [REAL_TENANT_CERTIFICATION.md](REAL_TENANT_CERTIFICATION.md) A0 correctly asks
for a role in _two_ non-production environments, but HARNESS_CHECKLIST's step 2 implies `TENANT_TEST_URL`
alone certifies "users and teams", and identity mapping cannot run with one environment.

**Fix.** The driver now selects a source and a distinct target, refuses production for either role, and
when only one non-production environment exists records phases 5–9 as `BLOCKED` with that single reason
instead of four identical HTTP 400s recorded as failures.

### D3 — The driver read queued job state as a result (the serious one)

**Symptom.** The driver's self-test recorded a preflight as
`{"sourceRecords":0,"analyzed":0,"create":0,"update":0,"unchanged":0,"conflict":0,"blocked":0}` and
reported "no classification exercised". Fetched a moment later, the same preflight read
`{create: 409, unchanged: 16, blocked: 2, analyzed: 427, sourceRecords: 427}`.

**Root cause.** `POST /api/plans/:id/preflight` and `POST /api/comparisons` both `enqueue` a job and
return the `QUEUED` row immediately. The driver recorded that row as the answer.

**Impact.** This is the one worth dwelling on. It is the same class of error as the nonce bug: **tooling
that reports confidently about work that did not happen.** Against a real tenant it would have written a
certification evidence file stating that a preflight classified nothing — understating every number,
hiding any real failure behind a zero, and doing it in the file whose entire purpose is to be trusted
later. A successful certification run is exactly when nobody re-checks.

**Fix.** A `waitForJob` helper polls until the status is terminal, with a timeout that is reported as a
failure and never as a completion. Classification counts are now taken from the completed run's totals
**and** cross-checked against an independent per-action query, with any disagreement recorded as a FAIL.

**Retest.** The self-test now records `COMPLETED after 3s`, `CREATE=409 UPDATE=0 UNCHANGED=16 CONFLICT=0
BLOCKED=2 (analyzed 427 of 427 source records)`, and `The per-action query agrees with the totals`.

### D4 — Evidence paths for a self-test and a real run could collide

**Symptom.** Running the driver against the simulator wrote `evidence/dataverse-real-tenant.json`.

**Impact.** `evidence/` is where this repository keeps verification evidence that other checks read and
that documentation claims are measured against. A file there with that name, holding a simulator run,
is a trap for whoever reads it next.

**Fix.** The output path is derived from the kind of run: a self-test writes
`evidence/dataverse-driver-selftest.json`, which is `.gitignore`d. The certification path can only be
written by a run with a real Microsoft session. Additionally the evidence file carries a top-level
`kind` field (`REAL_TENANT` or `SELF_TEST_AGAINST_SIMULATOR`), and a self-test cannot be mistaken for
certification even if the file is moved.

### Regression evidence added

One test, at the boundary the certification claim depends on: a refused write must not acquire a
Dataverse token ([section 10](#10-read-only-enforcement-evidence)). Mutation-checked.

The full gate is green on the certified code: **914 tests passed, 4 skipped, across 92 files**; format,
lint, typecheck, unit + integration + golden journeys, build and end-to-end all exit 0. Evidence drift
skipped, as designed, because it compares a committed snapshot against a fresh engine run.

### Deliberately not done

No test was written merely to raise the count. No algorithm was changed on suspicion. The harness was not
refactored. `REAL_TENANT_READ_ONLY` was not touched. No Dataverse write was attempted. `DEMO_MODE` was
not changed on QA.

---

## 12. Certification matrix

Nothing below is upgraded without evidence. The deployed build is `9ce2862f9e2e`.

| Capability                                   | Previous state                  | Current state          | Evidence                                                                          | Notes                                                                       |
| -------------------------------------------- | ------------------------------- | ---------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Microsoft authentication                     | SIMULATED (`redeemCode` mocked) | **VERIFIED**           | Real sign-in, deployed QA, 2026-10-02; request log + `AUTH_SIGN_IN` audit event   | Required three fixes; the third was ours                                    |
| Tenant admission                             | SIMULATED                       | **VERIFIED**           | Same sign-in; real `tid` checked against `ALLOWED_TENANT_IDS`                     | First time the gate met a real claim                                        |
| Dataverse environment discovery              | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 2. Anonymous probe → `401`                                 | Needs a signed-in session                                                   |
| Dataverse authentication / token acquisition | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 3                                                          | Delegated only; no service credential exists                                |
| Dataverse connectivity                       | REQUIRES_CONFIGURATION          | NOT EXECUTED           | Prepared: `POST /api/environments/:id/test`                                       | A 200 alone would not be certification                                      |
| Dataverse metadata discovery                 | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 4                                                          | Records which shapes were absent, by name                                   |
| Dataverse relationship discovery             | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 4                                                          | 1:N, N:1, N:N and self references counted separately                        |
| Dependency analysis                          | SIMULATED (Dataverse)           | NOT EXECUTED           | Prepared: driver phase 5                                                          | Exercised against the simulator; that is not this                           |
| User / team / business-unit discovery        | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 6                                                          | Needs two environments                                                      |
| Identity mapping                             | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 6                                                          | Ambiguous and unresolved recorded, never guessed                            |
| Schema comparison                            | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 7                                                          | Marked NOT EXECUTED by the run itself if only one environment exists        |
| Source data reads                            | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 8 (preflight reads every source record)                    | —                                                                           |
| Migration planning                           | SIMULATED                       | NOT EXECUTED           | Prepared: driver phases 5 and 8                                                   | —                                                                           |
| Transformation planning                      | IMPLEMENTED                     | NOT EXECUTED           | Prepared: lossy-transformation and lossy-record exports                           | Implemented above the connector; never run on real metadata                 |
| Upsert / change planning                     | SIMULATED                       | NOT EXECUTED           | Prepared: preflight classification                                                | CREATE/UPDATE/UNCHANGED/CONFLICT/BLOCKED, cross-checked two ways            |
| Preflight validation                         | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 8                                                          | Waits for COMPLETED — see D3                                                |
| Validation exports                           | SIMULATED                       | NOT EXECUTED           | Prepared: driver phase 9, five CSVs, each checked for leaked credentials          | —                                                                           |
| **Server-side read-only enforcement**        | Asserted in 2 test files        | **PARTIALLY VERIFIED** | Code read in full; 5 guarded entry points; new mutation-checked before-token test | Live refusal against a real tenant NOT EXECUTED                             |
| Actual Dataverse writes                      | SIMULATED                       | **NOT EXECUTED**       | None attempted                                                                    | **Intended.** This is the boundary of the phase                             |
| Rollback                                     | SIMULATED                       | **NOT EXECUTED**       | None attempted                                                                    | **Intended.** Requires mutation; cannot be tested without touching a tenant |
| Real migration reconciliation                | SIMULATED                       | NOT EXECUTED           | None attempted                                                                    | Depends on a real write                                                     |

`shared/connector-verification.ts` is **unchanged**: every Dataverse capability still reads `SIMULATED`,
`connect` still reads `REQUIRES_CONFIGURATION`, and `duplicateDetection` and `aggregateReconciliation`
still read `NOT_SUPPORTED` for the documented reasons. `tests/unit/connector-verification.test.ts` would
refuse a claim the evidence files do not back, and there is no new evidence file to back one.

---

## 13. Remaining release-candidate blockers

### Environment prerequisites — the actual blocker

**B1. A signed-in session this tooling can use.** Dataverse access is delegated; the only usable
credential is the refresh token from a person's interactive sign-in, encrypted in the deployment's
database. There is no service-principal path, no API token and no headless sign-in, by design. This is
the one thing that cannot be prepared.

**B2. Dataverse security roles in two non-production environments.** Per
[REAL_TENANT_CERTIFICATION.md](REAL_TENANT_CERTIFICATION.md) A0, and per D2 above. With one, phases 5–9
cannot run. With none, discovery returns empty and nothing past phase 2 runs — and whether the DeepTrics
tenant has any Power Platform environment at all is **not yet known**; the prepared run answers that in
its first thirty seconds.

### Configuration issues

**C1. `DEMO_MODE=true` on QA.** Does not block certification (section 2), but contradicts A1 and leaves
anonymous demo sign-in reachable. A decision to make, not a defect to fix.

### Engineering defects

**None blocking.** D1 is a documentation defect, now corrected. D2, D3 and D4 were defects in the new
driver, found by its own self-test and fixed before any real run. No defect was found in the product
during this phase — which is itself unproven ground, because the product's Dataverse path has still not
been executed.

### Unexecuted certification work

Everything in [section 12](#12-certification-matrix) marked NOT EXECUTED. Also still outstanding from
before this phase, and untouched by it: **Azure SQL**, which `shared/connector-verification.ts` holds at
`REQUIRES_CONFIGURATION` for `connect` and which does not inherit SQL Server's `ENGINE_VERIFIED`. It needs
only a database and a login, cleans up after itself, and is the cheapest row on the board.

### Actual write certification

Out of scope, and correctly `NOT EXECUTED`. See section 14.

---

### What is needed, exactly

1. **What was attempted.** Every read-only step that does not require a session: the deployed build's
   identity and mode confirmed three ways; eight anonymous endpoint probes; a full read of the connector,
   discovery, token-acquisition and guard implementations; and the complete ten-phase certification run
   built and proven end to end against a local instance.
2. **What evidence was obtained.** Sections 2, 3 and 10. The authentication chain holds. The read-only
   guard is where the documentation says it is, covers all five service entry points, and refuses before
   it acquires a token. No Dataverse operation was executed.
3. **The exact blocker.** B1 and B2 above. No Dataverse call can be made without a signed-in user's
   delegated token, and no useful plan can be made without two non-production environments.
4. **The minimum action.**
   - Confirm the account has a Dataverse security role in **two non-production** Power Platform
     environments in the `0eca5595-…` tenant. (If there are none, that is the finding, and it is an
     environment-provisioning task rather than an engineering one.)
   - Sign in at `https://dataverse-migration-app-qa.up.railway.app` with Microsoft — already working.
   - In the browser's developer tools, copy the value of the **`dvm_session`** cookie, and save it as a
     single line in `C:\Users\srini\OneDrive\Documents\Dataverse_Migration_QA_Session.txt` — the same
     place and the same handling as the Entra and Railway keys: read from the file, never printed, never
     logged, never written to an evidence file. It is valid for 12 hours.
5. **How it will be verified afterwards.**

   ```
   CERT_SESSION_FILE=C:/Users/srini/OneDrive/Documents/Dataverse_Migration_QA_Session.txt \
     node scripts/certify-dataverse-readonly.mjs --prove-write-block
   ```

   The run refuses to proceed if the session is not a Microsoft one, refuses to select a production
   environment, and refuses to send the write probe unless the deployment itself reports
   `realTenantReadOnly: true`. It writes `evidence/dataverse-real-tenant.json` and prints a verdict per
   step. This report's sections 4 through 10 and its matrix are then rewritten from that file — including
   any row that comes back FAILED.

---

## 14. Next recommended gate

**Not a write gate yet.** The expected next gate after this phase succeeds is a controlled real-write
certification against disposable non-production Dataverse data —
[REAL_TENANT_CERTIFICATION.md](REAL_TENANT_CERTIFICATION.md) part B — and it was not performed here.

But that gate is two steps away, not one, because **this phase did not succeed.** The honest ordering:

1. **Execute this phase.** One action (section 13), then one command. Until it runs, every Dataverse row
   stays `SIMULATED` and the product is a controlled pilot rather than a release candidate.
2. **Then** part B, against two freshly created scratch environments, with `REAL_TENANT_READ_ONLY=false`
   as its only configuration change, and only after this phase's evidence is recorded.

Two things worth doing in the meantime, both independent of the session:

- **Azure SQL.** It needs a database and a login, it cleans up after itself, and it converts four matrix
  rows from `IMPLEMENTED` to `ENGINE_VERIFIED` in one run. It is the only unexecuted certification on the
  board that needs nothing from Microsoft.
- **Decide `DEMO_MODE` on QA** (C1) — deliberately, either way.

One closing caution, because this document has used the word "prepared" a great deal. A prepared run is
not a passed one. The driver has been proven to work; it has proven nothing about Dataverse. The only
sentence this build has earned is the one in section 1.
