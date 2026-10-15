# Open findings from the code review

**Written for:** the owner, deciding what to schedule next.

Everything here was found during the review pass of 2026-10-15 and **deliberately not fixed in it**.
Each one needs a decision, a design, or a scale of change that does not belong in an unreviewed
overnight commit. What was fixed is in the pull request and its commits; this is the remainder.

Ordered by what would hurt first.

---

## 1. The principal directory is unbounded, and the market is enterprises

**Where:** `server/src/dataverse/web-api-connection.ts:186` (`getAll`), `:541` (`listPrincipals`),
`server/src/services/principal-service.ts:250` (`list`).

`getAll` follows `@odata.nextLink` in a `while (next)` loop with no page cap and no row cap,
accumulating every row in memory. `listPrincipals` uses it to fetch **every** `systemuser` in the
tenant. `principal-service.list` then selects the whole stored directory for the source environment
_and_ the target, and returns both in one response: `mappings` holds a row per source principal and
`targetPrincipals` holds every target principal, for manual selection.

At demo scale this is instant and correct, which is why it has never been visible. A tenant with
twenty thousand users produces a single JSON response carrying forty thousand objects, after a fetch
that held all of them in server memory at once. The user-mapping screen is not optional for a
migration that preserves ownership, so this is on the main path for exactly the customers this
product is sold to.

**Not fixed because** the honest fix is paging and server-side search across the API and the
screen — the target-principal list exists to be _chosen from_, so truncating it silently would be
worse than leaving it whole. That is a feature with design decisions in it, not a patch.

**Worth knowing:** record data does not have this problem. `queryRecords` is a paging generator and
is used for everything that reads customer rows. Metadata is bounded by schema size.

---

## 2. Six list endpoints return every row

**Where:** `analysis-service.list`, `environment-service.list`, `principal-service.list`,
`project-service.list`, `staged-source-service.list`, `team-service.list`.

Eight of the fourteen `list` methods bound their result; these six do not. Most are small by
nature — connections, team members and staged sources are counted in tens — so the practical risk is
concentrated in `project-service.list` and `analysis-service.list`, which grow for as long as a
workspace is used and are never pruned.

**Not fixed because** adding a `limit` without paging would silently hide rows, which is a worse
defect than loading them: a project that exists and is not listed is indistinguishable from one that
was deleted. These want the same treatment as finding 1 and should be done with it.

---

## 3. Dataverse cannot be connected with an app registration

**Where:** `server/src/auth/microsoft-identity.ts`, `server/src/routes/index.ts:576`.

The implemented authentication is a delegated token for the signed-in Microsoft account:
`acquireTokenByCode` and `acquireTokenSilent`, and nothing else. There is no client-credentials
flow, and `POST /api/connections` accepts SQL connections only, so a Dataverse connection can only
arrive through discovery.

This was reported by the owner as a defect on 2026-10-14. The screen now states the limitation
rather than offering fields it cannot honour.

**Not fixed because** it is a backend authentication feature: an MSAL client-credentials path,
per-connection encrypted secret storage, a connection-create endpoint that accepts a non-SQL
connection, and a connection test that proves it reaches a real environment. Scope it deliberately.

---

## 4. The `npm audit` advisory on the SQL driver, assessed and left alone

**What it says:** three moderate advisories, one chain. `sprintf-js` is vulnerable to denial of
service through unbounded precision specifiers; `tedious` depends on it; `mssql` depends on
`tedious`. `npm audit fix --force` resolves it by moving to `mssql@12.7.7`, which it labels a
breaking change. This repository declares `mssql@^11.0.2` and resolves `tedious@18.6.2`.

**Why it is being left:** the advisory needs a precision specifier inside the _format string_, and
every `sprintf` call in `tedious` passes a string literal from its own source — `login7-payload.js`
and `metadata-parser.js` build debug dumps with hardcoded formats and variable arguments. Nothing
reaching this product's code can place a specifier in a format. The call sites are also debug
`toString()` paths that tedious only invokes with its own debug logging switched on, which this
product never enables: there is no `debug:` option anywhere in `server/src/connectors/sql`.

So the exposure is not "low", it is absent in this usage, and the remedy offered is a major version
bump of the driver that both SQL Server and Azure SQL read through, in the middle of an Azure SQL
certification. That trade is the wrong way round. Upgrade it deliberately, on its own, with the
engine conformance suites run against real servers afterwards — which CI already does.

**Noticed while checking this:** the same tedious debug dump formats `Password:'%s'` in plaintext.
It is unreachable for the reason above, and the logger redacts `password`, `token`, `clientSecret`
and the rest by path regardless. Worth remembering before anyone switches on driver debugging to
diagnose a connection problem.

---

## 5. Fifty-nine redundant type assertions

**Where:** across `server/src`, reported by `@typescript-eslint/no-unnecessary-type-assertion`.

Each is an `as` or a `!` that the compiler can already prove. None of them changes behaviour and none
of them hides a bug — the rule is type-driven, so it only fires where the assertion is provably
unnecessary.

**Not fixed because** it is churn across many files for no behavioural gain, and a diff that size
buries the changes that matter. Worth doing as its own pass, with the rule turned on afterwards so
it stays clean.

---

## What was checked and found clean

Recorded because a review that only lists problems implies the rest was examined and found wanting,
and that is not what happened:

- No TODO, FIXME, HACK or XXX markers anywhere in the product source.
- No swallowed exceptions: zero empty `catch` blocks.
- No unconditionally skipped tests. All seventeen `skipIf` suites are gated on missing engine
  credentials, which is what they are for.
- No loose equality outside the `== null` idiom, no `parseInt` without a radix, no numeric `.sort()`
  without a comparator, no falsy-zero `||` defaults that could swallow a legitimate zero.
- **Zero floating promises, misused promises or `await`ed non-thenables** across the server, now
  enforced by lint rather than by habit.
- Every server source file is inside `tsconfig.server.json`; nothing escapes `tsc`.
- Frontend error handling is thorough: every query that can fail renders an error state, and the
  audit trail distinguishes "no events match these filters" from "no activity was recorded".
- The authorization model holds: every path that writes to a production target is guarded,
  reconciliation records a person's findings rather than writing, rollback is preview-only with no
  execute route, and an unknown mutating path default-denies before a handler can defend itself.

## How much of the code this covered

76,000 lines of product source and 33,000 of tests. Several defect classes were checked across all
of it by tooling; the reading was deep where that tooling pointed and shallow elsewhere. It is not a
line-by-line read of 109,000 lines, and is not offered as one.
