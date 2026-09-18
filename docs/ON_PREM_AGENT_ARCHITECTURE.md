# On-premises connectivity — the DeepTrics Migration Agent

> **Status: NOT IMPLEMENTED.** This document describes future work. Nothing in it exists in this
> repository today. There is no agent, no agent protocol, no `AgentTransport` and no enrollment
> flow. The only transport that exists today is the direct one described below, and even that is
> implicit — connectors open their own connections. Treat every sentence here as a design proposal
> to be reviewed, not as a description of the product.

**Audience:** the engineers who will build this, and whoever has to decide whether the design is
sound before that happens.

---

## 1. The problem, stated plainly

The platform is hosted (Railway). A customer's SQL Server usually is not. It sits inside their
network, behind a corporate firewall, with no inbound route from the public internet — which is
exactly how it should be.

The product can already read and write Dataverse, because Dataverse is a public HTTPS endpoint the
hosted app can reach with a delegated token. SQL Server is the opposite case: the credentials are
ours to carry, the protocol is TDS, and the server is unreachable.

So there are two ways to connect a hosted migration platform to a private database: the customer
opens a path inward, or something inside their network reaches outward. The second is the one we
should build.

## 2. What works today, and what needs the agent

Today there is one transport, and it is a direct one: the server process opens a TDS connection to
the host in the connection profile. That works whenever the SQL Server is genuinely reachable from
the app.

| Scenario                                                   | Works with the direct transport? | Notes                                                                    |
| ---------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Azure SQL Database with a firewall rule for our egress IPs | Yes                              | The intended cloud-to-cloud case. Needs stable outbound IPs on our side. |
| Azure SQL Managed Instance with a public endpoint          | Yes                              | Customer must have enabled the public endpoint and allowed our range.    |
| SQL Server on a VM with a public endpoint                  | Yes, but see §3                  | Technically works. Not what we should recommend.                         |
| VPN or private link between our infrastructure and theirs  | Yes                              | Works, and is a legitimate enterprise answer. See the decision log.      |
| Local development / demo (`demosql`)                       | Yes                              | Everything is in one process or one machine.                             |
| SQL Server on a corporate LAN, no inbound route            | **No**                           | The case this document exists for.                                       |
| SQL Server reachable only from a jump host or a subnet     | **No**                           | Same problem with extra hops.                                            |
| Customer policy forbids any inbound exposure of the data   | **No**                           | Common in regulated industries. Policy, not topology.                    |

Everything in the "No" rows is what the agent unlocks. Nothing else about the product changes: the
same plan, the same preflight, the same identity map, the same validation report.

## 3. Why "just open port 1433" is not the answer

It will be suggested, because it takes five minutes and it works. Say no, and say why:

- **Credential stuffing and brute force.** A SQL Server on the public internet is scanned within
  minutes and attacked continuously. The only thing between an attacker and the database is a
  password that lives in two places instead of one.
- **No egress control.** An exposed TDS port accepts a connection from anyone who can reach it, not
  just from us. Our IP allow-list, if the customer even configures one, is the customer's rule to
  maintain, and it breaks the moment our hosting changes an outbound address.
- **Unpatched surface.** On-premises SQL Servers are patched on the customer's schedule, which is
  measured in quarters. Exposing the protocol surface of a database that is two cumulative updates
  behind is a different risk class from exposing a hardened HTTPS endpoint.
- **Compliance.** "The database is directly reachable from the internet" fails most internal
  security reviews, ISO 27001 and SOC 2 control narratives, and every PCI/health-data assessment we
  are likely to meet. A customer who agrees to it quickly is usually a customer whose security team
  has not been asked yet.
- **It makes us the risk.** If the only thing protecting the database is a credential we hold in
  our cloud, then a breach of our cloud is a breach of their database. That is a promise we should
  not be making.

A publicly reachable SQL Server is acceptable for a scratch environment during a proof of concept.
It is not the recommended production architecture, and the product should say so in the UI when a
direct SQL connection profile points at a public host.

## 4. The transport seam

`server/src/connectors/types.ts` already defines the provider-neutral `MigrationConnector`: the
migration engine, preflight, comparison and validation call `listTables`, `queryRecords`,
`createRecord` and friends, and never ask who the provider is — they ask `ConnectorCapabilities`.

The agent adds a second axis. A SQL connector needs to answer the same questions whether the query
runs in our process or in a binary on the customer's network. That is a transport concern, not a
connector concern, so it belongs **below** the connector:

```
Railway (hosted)                                  Customer network
┌───────────────────────────────────────┐        ┌──────────────────────────────────┐
│ MigrationEngine / Preflight / Compare │        │ DeepTrics Migration Agent        │
│   └─ MigrationConnector (SqlConnector)│        │   connection profiles (local)    │
│        └─ ConnectionTransport         │        │   credentials (local, never sent)│
│             ├─ DirectTransport ───────┼─ TDS ─▶│   instance allow-list            │
│             └─ AgentTransport ◀═══════┼═ WSS ══╡ (agent dials out, always)        │
└───────────────────────────────────────┘  443   └───────────────┬──────────────────┘
                                                                 │ TDS, inside the LAN
                                                                 ▼
                                                        SQL Server / instances
```

### 4.1 What an implementation must provide

```ts
export type TransportKind = 'direct' | 'agent';

export interface ConnectionTransport {
  readonly kind: TransportKind;
  /** For logs and the UI: `direct` or `agent:<agentId>`. Never contains a credential. */
  readonly locator: string;

  /** One request/response round trip: metadata, a count, a single write. */
  execute<T>(request: TransportRequest, signal: AbortSignal): Promise<T>;

  /** A streamed result set, delivered in batches, with back-pressure (§7.2). */
  stream(request: TransportRequest, signal: AbortSignal): AsyncGenerator<ResultBatch>;

  /** Reachability and identity of the far end, as ConnectionCheck[] the UI already renders. */
  probe(): Promise<ConnectionTestResult>;

  dispose(): Promise<void>;
}

export interface TransportRequest {
  /** Opaque reference to a connection profile. The cloud never sends a connection string. */
  connectionRef: string;
  op: 'describeCatalog' | 'describeTable' | 'count' | 'query' | 'insert' | 'update' | 'exec';
  payload: unknown;
  /** True for anything that can modify data. The agent authorizes writes separately (§6.4). */
  writeIntent: boolean;
  /** Retries of the same logical operation carry the same key, so a write cannot double-apply. */
  idempotencyKey?: string;
  deadlineMs: number;
}
```

Non-negotiable properties of any implementation:

| Property     | Requirement                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| Ordering     | `stream` yields batches in the order the connector asked for (primary key order), with a resumable cursor |
| Errors       | Failures arrive as the same classified errors the connectors already raise, not as socket exceptions      |
| Transience   | Transient/permanent classification survives the hop, so existing retry and backoff logic still applies    |
| Cancellation | An `AbortSignal` stops work on the far end, not just locally                                              |
| Secrets      | A transport never receives, logs or returns a credential                                                  |
| Timing       | A deadline is carried end to end; a hung far end surfaces as a timeout, never as an indefinite stall      |

### 4.2 Why the seam sits below the connector, not inside it

- **One SQL implementation, not two.** Query construction, type normalization, identity/computed
  column handling and batching are hard and provider-specific. Duplicating them into an
  `AgentSqlConnector` guarantees the two drift, and a drift here means a preflight that predicts
  something different from what the engine does — the one failure mode this codebase is built to
  prevent (`record-planner.ts` / `record-matcher.ts` are shared for exactly this reason).
- **The capability model already covers the real differences.** Whether a table has ownership or
  transactions is a property of the provider. Whether a packet goes over a socket or a WebSocket is
  not, and must not become a capability flag.
- **Testability.** A fake transport lets every existing connector test run "over the agent" without
  an agent, and the agent's own tests only need to prove the framing, not the SQL.
- **It generalizes.** If a future customer needs an agent in front of something else (an on-prem
  Oracle, a file share, a second Dataverse behind a proxy), the seam is already there.

The connector decides _what_ to ask. The transport decides _where the asking happens_.

## 5. Agent design

### 5.1 Outbound only, always

The agent makes connections; it never accepts them. The primary channel is a WebSocket over TLS to
`wss://<our host>:443`, which is the one outbound path essentially every corporate firewall already
permits. Once established, the cloud sends requests over a connection the customer initiated.

A long-poll fallback (HTTPS `POST /agent/poll` with a held response, plus `POST /agent/reply`)
exists for networks where inspecting proxies break WebSocket upgrades. It is slower and chattier,
uses the same message types, and is selected automatically after repeated upgrade failures — with
the reason shown on the agent's page so nobody has to guess why throughput halved.

No inbound firewall rule. No port forward. No DMZ host. If a deployment needs one, the design has
failed.

### 5.2 Enrollment and pairing

1. An administrator creates an agent in the UI (name, optional network-zone tag). The cloud issues a
   **one-time enrollment token**: high entropy, single use, short TTL (15 minutes by default),
   displayed once and stored only as a hash.
2. The administrator runs `deeptrics-agent enroll --token <token> --url https://<our host>`.
3. The agent generates a key pair **locally**, keeps the private key in the OS key store (DPAPI on
   Windows, a 0600 file on Linux), and sends only the public key with a hardware/install
   fingerprint.
4. The cloud burns the token and issues a per-agent client credential (client certificate for mTLS,
   or a signed credential bound to that public key). It is bound to one organization and one agent
   id.
5. Every later connection authenticates mutually: the agent validates our server certificate (with
   optional pinning to our issuing CA), we validate the agent's client credential. An enrollment
   token is never a long-term credential and can never be replayed.

Revocation is a single action in the UI, and takes effect on the agent's next request, not on its
next restart.

### 5.3 What the agent may reach — the allow-list lives with the customer

The agent holds a local configuration file listing the SQL instances and databases it is permitted
to reach, and the credential to use for each. The cloud can ask the agent what it advertises; it
cannot add to that list.

```yaml
# deeptrics-agent.yaml — on the customer's machine, never uploaded
agent:
  name: crm-prod-zone
  url: https://app.deeptrics.com
connections:
  - ref: iic-prod # the opaque reference the cloud knows
    server: sql01.corp.local
    database: IIC_PROD
    auth: { mode: sql, username: svc_deeptrics_ro, passwordEnv: DTX_IIC_PROD_PW }
    allowWrites: false # read-only regardless of what the cloud asks
  - ref: iic-stage
    server: sql02.corp.local
    database: IIC_STAGE
    auth: { mode: integrated } # the agent's own service account
    allowWrites: true
```

A request naming a `connectionRef` the agent does not hold is refused, logged locally and reported
to the cloud as a configuration error — never as a connection failure, because the two mean
different things to the person debugging it.

### 5.4 Heartbeats, liveness and multiple agents

- The agent heartbeats on the control channel (default 30s), reporting version, protocol version,
  uptime, advertised connection refs and whether each last probed healthy.
- The cloud marks an agent `ONLINE` / `DEGRADED` / `OFFLINE` from heartbeat age. This mirrors the
  existing job-queue heartbeat and stale-job recovery, which already exists for workers.
- A customer may run several agents: for different network zones, for resilience, or because two
  SQL estates are not mutually reachable. Each connection profile records which agent ids can serve
  it.
- For the first release, selection is deliberately simple: a run binds to one healthy agent at
  start and stays with it (sticky). Failing over a half-finished stream to a second agent is a
  correctness problem, not a routing problem, and it is out of scope (§8).

### 5.5 Versioning and upgrade

- The agent reports both a **build version** (semver) and a **protocol version** (integer). They
  move independently.
- The cloud declares a minimum supported protocol version and supports at least the two previous
  ones. An agent below the floor is refused with an explicit `AGENT_TOO_OLD` message naming the
  version to install — never allowed to connect and then misbehave subtly.
- Upgrades are customer-initiated by default (replace the binary, restart the service; the container
  image is a tag bump). An opt-in auto-update channel can come later; for a process holding database
  credentials, silent self-update is a decision the customer should make explicitly.
- The UI shows the installed version, the newest version, and whether an upgrade is required or
  merely available.

## 6. Security model

### 6.1 Where the credentials live

Database credentials live on the customer's machine, in the agent's configuration or in their own
secret store, referenced by environment variable. They are never transmitted to us, never stored by
us and never appear in our logs, our database or our backups. That is the entire point of the
design and it should be stated in the sales conversation, not buried here.

### 6.2 What the cloud stores instead

| Stored in the cloud                                              | Never stored in the cloud             |
| ---------------------------------------------------------------- | ------------------------------------- |
| Agent id, display name, zone tag, enrollment record              | SQL passwords or connection strings   |
| The agent's public key / issued client credential identifier     | The agent's private key               |
| Connection **references** and display labels (`sql01/IIC_PROD`)  | Credentials behind those references   |
| Normalized metadata, plans, identity map, counters, audit events | Anything the customer did not migrate |
| Row data only while a migration is actively moving it            | A durable copy of source rows         |

### 6.3 A compromised cloud is not a compromised database

If our infrastructure is breached, the attacker gains the ability to send requests to an agent that
is already authenticated. They do **not** gain the credentials, and they are contained by four
independent limits the customer controls: the agent's allow-list (only those instances), the SQL
principal's own grants (least privilege — read-only on the source is the recommended configuration),
the agent's `allowWrites` flag, and the customer's ability to stop the agent, which severs
everything instantly with no coordination with us.

That is a meaningfully weaker blast radius than "our database holds a password to their production
SQL Server", which is what the direct transport means for an on-premises estate.

### 6.4 Writes are authorized separately, and refused by default

A `writeIntent: true` request must carry a signed **run authorization**: run id, organization,
connection ref, the tables the plan targets, the operations permitted, and an expiry. The agent
validates the signature, checks it against its local `allowWrites` policy, and refuses anything
outside it.

This mirrors `REAL_TENANT_READ_ONLY`, which is enforced in the Dataverse client rather than the UI
for exactly the same reason: the last layer before the wire is the only layer worth trusting. An
agent that is not explicitly configured to allow writes must behave as a read-only agent even if
every layer above it says otherwise, and the refusal must be visible in the run's errors rather
than silently reclassified as a failed write.

### 6.5 Auditability

The agent keeps its own local, append-only log: timestamp, request id, run id, connection ref,
operation class, table, row counts, duration, outcome. No credentials, no row values, no
predicates that could embed personal data. It is the customer's evidence of what we did inside
their network, in a form they can ship to their SIEM, and it should be readable without our help.

## 7. A migration through an agent

### 7.1 Request and response framing

One control channel per agent; logical requests are multiplexed over it by request id.

| Message     | Direction     | Purpose                                                                  |
| ----------- | ------------- | ------------------------------------------------------------------------ |
| `HELLO`     | agent → cloud | Protocol version, build version, agent id, advertised connection refs    |
| `WELCOME`   | cloud → agent | Accepted, session id, negotiated protocol version, heartbeat interval    |
| `HEARTBEAT` | agent → cloud | Liveness plus per-connection health                                      |
| `REQUEST`   | cloud → agent | A `TransportRequest` (§4.1)                                              |
| `BATCH`     | agent → cloud | One page of rows for a streaming request, with a cursor                  |
| `END`       | agent → cloud | Stream complete, with the final cursor and row count                     |
| `RESULT`    | agent → cloud | The response to a non-streaming request                                  |
| `ERROR`     | agent → cloud | Classified error (transient / permanent / configuration / authorization) |
| `CREDIT`    | cloud → agent | Back-pressure: permission to send N more batches                         |
| `CANCEL`    | cloud → agent | Stop this request id (pause, cancel, or a deadline elapsed)              |
| `BYE`       | either        | Graceful shutdown, so a restart is not misread as a fault                |

### 7.2 Streaming and back-pressure

`queryRecords` already streams page by page and never loads a whole table. Over an agent the same
shape holds: the agent reads a page, frames it, sends a `BATCH`, and waits for credit. The cloud
grants a small window (start with 2–4 batches in flight) and grants more only after a page has been
processed and persisted. The database is therefore read no faster than the target can be written,
which is what keeps memory flat on both ends and keeps a slow Dataverse target from turning into a
queue in our process.

Rows are compressed on the wire and, for a large table, that is worth more than any protocol
cleverness.

### 7.3 Resumability and disconnects

Every `BATCH` carries a cursor — the primary key ordering the connector already requires. Two
recovery paths, and they are different:

1. **The agent restarts.** The control channel drops, reconnects with the same credential, and the
   cloud reissues the in-flight request from the last cursor it persisted. Re-reading a page is
   free; re-applying it is safe because the engine skips source ids already present in the identity
   map for that run.
2. **The agent disconnects mid-run and does not come back immediately.** The run **pauses** — it
   does not fail. Status `PAUSED`, phase preserved, an explicit reason (`AGENT_DISCONNECTED`), the
   run monitor says which agent and when it was last seen. If the agent returns inside a grace
   window (default 15 minutes, configurable), the run resumes automatically; after that it stays
   paused for a human to resume or cancel.

This is the correct default because a migration that fails at 80% costs a maintenance window, while
one that waits fifteen minutes for a rebooted Windows service costs nothing. `PAUSED` and
resumability already exist in the engine and the job queue; the agent reuses them rather than
introducing a parallel notion of "interrupted".

Writes are the delicate case: a write that was sent but whose acknowledgement was lost must not
double-apply. Hence `idempotencyKey` (§4.1) — the agent keeps a short-lived record of recently
completed write keys and returns the original result instead of executing twice.

## 8. Operations

| Concern    | Position for the first release                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Footprint  | One self-contained binary (~50–80 MB) or one container image. No database, no message broker, no IIS, no admin rights beyond installing a service.                         |
| Install    | `deeptrics-agent enroll` then `deeptrics-agent install-service`. A Windows service or a systemd unit. Uninstall removes the service and the local credential.              |
| OS support | Windows Server 2019/2022/2025 and Windows 11, Ubuntu 22.04/24.04 LTS, RHEL 9. Container image for `linux/amd64` and `linux/arm64`.                                         |
| Egress     | One hostname, TCP 443, TLS. Documented so a network team can allow it by name without a packet capture.                                                                    |
| Proxy      | `HTTPS_PROXY` / `NO_PROXY`, HTTP `CONNECT` proxies with no auth or basic auth, and an explicit trust store for a TLS-inspecting proxy's CA. NTLM/Kerberos proxies: §9.     |
| Logging    | Structured JSON, rotating local files. Table names, row counts, durations, error codes. **Never** credentials, **never** row values, **never** query parameters.           |
| Health     | `deeptrics-agent status`, a loopback-only health endpoint, and `deeptrics-agent test --connection <ref>` running the same `ConnectionCheck[]` list the UI already renders. |
| Cloud-side | An **Agents** page: online/offline, last heartbeat, version, advertised connections, last error, and a revoke button.                                                      |
| Resources  | Bounded by the credit window, not by table size. A published memory ceiling and a CPU expectation, because this runs on a server someone else owns.                        |

## 9. Delivery plan

Estimates are engineer-weeks for one engineer who already knows this codebase, and exclude the SQL
connector work itself, which is a separate track.

| Phase | Scope                                                                                                                                                                      | Est.   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0     | Extract `ConnectionTransport`, implement `DirectTransport`, move SQL connectors onto it, fake transport in tests. No behaviour change.                                     | 1–2 wk |
| 1     | Agent skeleton: enrollment, mutual auth, control channel, heartbeats, Agents page, revocation, `probe` only.                                                               | 3–4 wk |
| 2     | `AgentTransport` read path: request framing, streamed batches, credit-based back-pressure, cursors, cancellation, error classification across the hop.                     | 3–4 wk |
| 3     | Write path: run authorization, `allowWrites`, idempotency keys, disconnect → pause/resume, agent-side audit log.                                                           | 2–3 wk |
| 4     | Operational hardening: installers and service wrappers, proxy support, protocol version floor and upgrade UX, docs, an install runbook a customer's IT can follow unaided. | 2–3 wk |

Roughly 11–16 engineer-weeks to a first customer install, plus a pilot. Phase 0 is worth doing on
its own merits even if the agent is deferred: it is where the testability comes from.

### Deliberately out of scope for the first agent release

- **Agent failover mid-run.** One run, one agent. Moving a half-finished stream between agents is a
  correctness problem, and the pause/resume path already covers the common case.
- **Data-plane bypass.** Rows flow source agent → cloud → target. Letting the agent write directly
  to the customer's Dataverse so row data never touches our infrastructure is attractive, and is a
  second project with its own token-handling design.
- **On-prem → on-prem migrations** where both endpoints sit behind the same or different agents.
- **End-user credential delegation** (Kerberos constrained delegation, per-user SQL identities). The
  agent uses a service identity; who _asked_ is recorded in our audit trail, not in SQL's.
- **NTLM/Kerberos-authenticated forward proxies.**
- **Auto-update**, agent-side scheduling, agent-side transformation, and any execution of
  customer-supplied SQL.
- **High availability of the agent itself.** Two agents for the same estate give redundancy between
  runs, not inside one.

## 10. Decision log

| Alternative                                          | Why rejected as _the_ answer                                                                                                                                                                                                                               | When it is still right                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Customer-managed VPN or private link only            | Network-level, not request-level: everything routable becomes reachable, with no per-request authorization or audit. Takes weeks of a network team's time per customer, prices out everyone below enterprise, and we still hold the database credentials.  | The customer already has ExpressRoute/private link, policy forbids new outbound agents, or the target is Azure SQL. Keep supporting it. |
| Reverse SSH tunnel from a customer jump host         | Exposes a whole port to our cloud with no notion of which request is allowed; nothing to audit but a TCP byte count; key distribution and rotation become a manual, permanent liability; reconnection behaviour under a corporate proxy is poor.           | A supervised one-off consulting engagement with a fixed end date and someone watching the tunnel.                                       |
| Microsoft's On-premises Data Gateway                 | Built for Power Platform connectors, not arbitrary streamed TDS with our batching and back-pressure. Adds Power Platform licensing and a component we cannot debug, and its failure modes become our support tickets.                                      | A customer already operates one and only needs modest, connector-shaped access. Worth revisiting if Microsoft opens the surface.        |
| Run the whole platform on-premises (customer-hosted) | Contradicts the multi-tenant, continuously-deployed design; every customer pins a version; we lose the telemetry that makes failures diagnosable; support cost per customer rises sharply. Solves connectivity by giving up the product's operating model. | A regulated customer whose data genuinely cannot leave their network. That is an enterprise SKU decision, not a connectivity one.       |
| Customer exports to files we ingest (S3/SFTP/CSV)    | Loses the live comparison the product is built around: preflight, matching and validation all assume both sides are queryable now. A snapshot is stale the moment it is written, and deltas become the customer's problem.                                 | A one-time, one-way load of a frozen dataset where nobody needs validation against a live source.                                       |

## 11. Open questions for review

1. Is the sticky one-agent-per-run rule acceptable for the first real customer, or does a long
   migration need failover on day one?
2. mTLS client certificates or signed bearer credentials for agent authentication? Certificates are
   stronger and harder to support on Windows.
3. Do we publish an installer (MSI / apt / rpm) in phase 4, or is "a binary and a service command"
   enough for a pilot?
4. What is the honest throughput expectation over an agent versus direct, and where does the credit
   window need to sit for a real corporate link?
5. Should a direct SQL connection to a public host be a WARNING in the plan, the way production
   Dataverse environments already are? The argument for yes is in §3.
