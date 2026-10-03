# Release-candidate security audit

A focused review of the surfaces a migration platform actually exposes: it holds credentials for
somebody else's databases, dials hosts a user typed in, serves exports of customer data, and accepts
archives and spreadsheets from the internet.

**No offensive testing against any external system.** Everything here is a reading of this repository plus
safe local tests. Where a finding was fixed, the fix has a test; where it was not, it says so and says
why.

Classification:

|        | Means                                                                                  |
| ------ | -------------------------------------------------------------------------------------- |
| **P0** | Exploitable now, by somebody outside, with meaningful consequence                      |
| **P1** | Exploitable by an authenticated tenant, or a weakness in a boundary this product sells |
| **P2** | Defence in depth, or a weakness needing unusual conditions                             |
| **P3** | Hardening, or a limit worth recording                                                  |

---

## Findings

### P1 — Server-side request forgery through connection configuration · **FIXED**

A migration platform connects to a host a signed-in user typed in. That is the product working, and
nothing bounded it: only emptiness was checked. A tenant could point a connection at this deployment's
loopback services, or at `169.254.169.254`, which on several cloud providers hands instance credentials to
anything that asks.

The obvious rule would have been wrong. "Refuse private addresses" breaks the main case — a customer's
SQL Server on `10.x` reached through a tunnel is the normal shape of an enterprise migration. So the
refusals are narrow and specific: loopback, link-local, the unspecified address, and the metadata
hostnames the providers publish. Private ranges stay open.

`server/src/lib/network-policy.ts`, `ALLOW_INTERNAL_CONNECTIONS` (default **off**), 13 cases in
`tests/unit/network-policy.test.ts`. Writing those found a gap in my own normaliser: `127.0.0.1:5432`
slipped past the address check because the port was not stripped, and stripping it naively would have
truncated an IPv6 address at its last group.

### P2 — A crafted link could choose the words on the sign-in page · **FIXED**

The callback redirected to `/login?error=<sentence>` and the page rendered whatever arrived. React escapes
it, so nothing could be injected — but anyone could send a prospect a link to **our own domain** showing a
sentence of their choosing under a "Sign-in failed" heading. That is a phishing surface for the price of a
query string.

Now a closed set of codes, mapped to wording the page owns: `shared/sign-in-failures.ts`. An unrecognised
code reads as the generic failure. Microsoft's `error_description`, where the `AADSTS` text lives, is
logged and never travels to a browser.

### P2 — Audit payloads were bounded but not scrubbed · **FIXED**

Nothing deliberately puts a credential in an audit payload — a connection event records
`passwordChanged: true`, not the password — but the payload is free-form and the free-form thing most
likely to carry one is an error message, which is exactly where a connection string ends up. The audit
trail is the most durable place a secret could land: rows are kept deliberately, exported, and read by
people who did not write them.

The same scrubber the logs and error responses use now runs over every string on the way in.

### P3 — The SSRF bound checks the host as written, not where it resolves · **OPEN, recorded**

A hostname under an attacker's control can point at `127.0.0.1`, and the policy above will allow it.
Closing this means resolving the name and pinning the connection to the address that was checked, which
none of `pg`, `mysql2` or `mssql` will do without supplying our own socket — a real piece of work rather
than a line of validation.

There is a test asserting the gap, so it is visible to whoever reads the policy next rather than mistaken
for a bug in the rules. Exploiting it yields a connection attempt from the server to an internal address
with a database handshake, which is a port scan rather than data access; the metadata endpoint does not
speak PostgreSQL.

### P3 — One export still holds a page in memory · **OPEN**

`lossy-records.csv` fetches `limit: 100_000` in one response. Availability rather than confidentiality:
a large plan makes one large allocation. The record and lineage exports were converted to streaming in
Phase 4; this one was missed.

### P3 — `mailto:` links are built from an access request's email · **OPEN, accepted**

`AccessRequestsCard` renders `mailto:${r.email}`. A crafted address could append mail-header-ish text. The
reader is an operator looking at a request they are about to action, the value is validated as an email on
the way in, and the consequence is a pre-filled mail client. Recorded rather than fixed.

---

## Configuration findings on the deployed QA environment

Read from Railway's own variable listing, not guessed. These are deployment facts, not code defects.

| Finding                                                             | Consequence                                                                                                                                          | What to do                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ALLOWED_TENANT_IDS` unset with `ACCESS_MODE` defaulting to `GATED` | **Every** Microsoft sign-in is refused after Microsoft succeeds. Fails closed, which is correct, and is the second half of the sign-in outage        | Set it to the directory ids permitted to sign in                      |
| `ENTRA_TENANT_ID` unset, so the authority is `/organizations`       | With a single-tenant registration, Microsoft refuses every user whose home directory is not the registration's. This is the first half of the outage | Set it to the registration's own directory id                         |
| `ADMIN_EMAILS` unset                                                | **Nobody is a platform operator**, so the operator-only diagnostics and the auth-configuration report are unreachable                                | Set it to the operators' addresses                                    |
| `DEMO_MODE=true`                                                    | An anonymous visitor creates a workspace without authenticating. Correct for an evaluation deployment, and worth stating                             | Intentional. `DEMO_MAX_WORKSPACES` and a 48-hour sweep bound the cost |
| `ALLOW_INTERNAL_CONNECTIONS` unset                                  | Defaults to off, which is what a hosted deployment wants                                                                                             | Nothing                                                               |

The product now reports the first three itself: a startup log line per finding, worst first, and
`GET /api/platform/auth-configuration` for an operator.

---

## Checked and found sound

Each of these was read rather than assumed, and most have a test named beside them.

| Surface                  | What is there                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication**       | Authorization code + PKCE, confidential client. Single-use `state` deleted and read atomically; `nonce` compared. Both asserted directly, so a simulation cannot disable them silently                                       |
| **Session storage**      | The cookie holds an opaque token; the database holds its **SHA-256 hash**. A database read does not yield a usable session                                                                                                   |
| **Cookies**              | `httpOnly`, `sameSite=lax` (required for the OAuth redirect), `secure` configurable, `path=/`                                                                                                                                |
| **CSRF**                 | A header token required on every non-GET, held in memory and never in `localStorage`. Asserted in the auth matrix                                                                                                            |
| **Workspace isolation**  | Every query scoped by organization. **Mutation-tested**: removing the scope from one read-by-id fails the matrix                                                                                                             |
| **Role boundaries**      | Four roles, with a read-only role that may read everything and change nothing. Asserted end to end                                                                                                                           |
| **Credentials at rest**  | Connection passwords AES-GCM encrypted in their own table, keyed from `SESSION_SECRET`; tampering is detected. The MSAL token cache likewise. Neither is ever returned to a client — `hasSecret` is a boolean                |
| **Secret redaction**     | Pino redaction paths for tokens, cookies and secrets, plus `scrubSecrets` over free text: bearer tokens, `password=`, URI credentials, JWTs, `client_secret=`                                                                |
| **Error disclosure**     | 500s return a generic message and a request id. Stack traces never leave the process. Scrubbed on the way out                                                                                                                |
| **Exports**              | Every export resolved through the organization-scoped service. CSV formula injection neutralised: a leading `=`, `+`, `-` or `@` is prefixed with a quote                                                                    |
| **Evidence package**     | A test scans the real output for password patterns, bearer-ish tokens, URI credentials and private keys — rather than trusting that the generator would have refused                                                         |
| **ZIP handling**         | Declared sizes checked before allocating; the inflater bounded by `maxOutputLength`, so a bomb never reaches memory. Entries go into a map, **never to the filesystem**, so path traversal does not apply                    |
| **Upload bounds**        | 32 MB, 500,000 rows, 300 columns, all refusals with a reason rather than truncations                                                                                                                                         |
| **SQL injection**        | Values bound, never concatenated. Identifiers bracketed by a quoting helper that refuses anything that is not an identifier. Mutation-tested in the engine suite: removing the quoting fails it                              |
| **XSS from source data** | React escapes by default and there is no `dangerouslySetInnerHTML` anywhere. Environment URLs and record values render as text, never as an `href`                                                                           |
| **Open redirect**        | `safeReturnTo` refuses anything not beginning with a single `/`. Asserted against `//evil.example` and `https://evil.example`                                                                                                |
| **Entra callback**       | `state` single-use, `nonce` compared, redirect URI derived from `APP_BASE_URL` and checked at startup against it                                                                                                             |
| **Rate limiting**        | 900/minute globally, and tighter where a request costs something: 30 on the auth routes, 15 on demo sign-in (each seeds a workspace and runs two migrations), 6 on alert tests, 5 on the unauthenticated access-request form |
| **Demo abuse**           | A ceiling on live workspaces, swept hourly, and the visitor is told to come back shortly rather than told the limit                                                                                                          |

---

## Not done, and why

- **No offensive testing.** Not against Microsoft, not against Railway, not against any host this
  deployment can reach. The brief forbids it and it would be wrong anyway.
- **No dependency CVE audit.** `npm audit` output changes daily and acting on it is a maintenance
  activity rather than a release gate; it belongs in CI on a schedule, not in a one-night review.
- **No penetration test.** This is a code review by the person who wrote the code, which is the weakest
  form of security assurance available. It finds the things a careful reader finds and misses the things
  an adversary finds. An external review is the next step and nothing here substitutes for it.
