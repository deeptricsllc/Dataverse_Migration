#!/usr/bin/env node
/**
 * Real-tenant Dataverse read-only certification, driven against a deployed build.
 *
 * This exists because of a lesson that cost a night: `tests/integration/auth-matrix.test.ts` replaced
 * `redeemCode` with a stub, so ten green cases could not notice that the real redemption was broken. One
 * real sign-in found it immediately. The same reasoning applies to Dataverse, and harder — everything this
 * repository knows about Dataverse comes from a simulator written to match Microsoft's documentation.
 *
 * So this script substitutes nothing. It drives the deployed application's own HTTP API, as a browser
 * does, with a real session belonging to a real signed-in user, and records what the deployment actually
 * answered. It cannot prove Dataverse works by passing; it can only report what happened.
 *
 * ## Why it needs a session, and what it does with it
 *
 * Dataverse tokens are delegated. The only refresh token that can reach the tenant is the one the
 * signed-in user's own sign-in produced, and it lives encrypted in the deployment's database. There is no
 * service credential to use instead, by design — the product only ever acts as the person using it. So
 * this script borrows that person's session the way their browser holds it.
 *
 * The session value is read from a file and **never printed, never logged, never written to evidence**.
 * Pass the path in `CERT_SESSION_FILE`. The file holds the value of the `dvm_session` cookie on one line.
 *
 * ## Why it is safe to point at a real tenant
 *
 * Every call below is a read of the tenant. Several are HTTP POSTs — discovery, diagnostics, comparison,
 * preflight — because that is how the product models "do some work and give me the answer"; none of them
 * mutates Dataverse. The single exception is the phase 10 probe, which deliberately asks for a migration
 * in order to establish that the server refuses it.
 *
 * Two interlocks guard that probe:
 *
 *   1. It runs only with `--prove-write-block`, which is not the default.
 *   2. Before it runs, the deployment is asked whether `realTenantReadOnly` is true, from its own
 *      `/api/auth/session`. If the answer is anything else the probe is skipped and recorded as BLOCKED.
 *      A probe that would start a real migration is not a probe.
 *
 * The script also refuses to select a Production environment for the deeper phases, whatever else is
 * available, and says so rather than quietly carrying on.
 *
 *   CERT_SESSION_FILE=~/qa-session.txt node scripts/certify-dataverse-readonly.mjs
 *   CERT_SESSION_FILE=... node scripts/certify-dataverse-readonly.mjs --prove-write-block
 *   CERT_BASE_URL=http://localhost:3000 CERT_SESSION_FILE=... node scripts/certify-dataverse-readonly.mjs
 *
 * Writes `evidence/dataverse-real-tenant.json` and prints a table. Exits non-zero if any step FAILED —
 * NOT_EXECUTED and BLOCKED are not failures, they are the certification boundary.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const BASE = (process.env.CERT_BASE_URL ?? 'https://dataverse-migration-app-qa.up.railway.app').replace(
  /\/+$/,
  '',
);
const PROVE_WRITE_BLOCK = process.argv.includes('--prove-write-block');
/**
 * Lets this script be exercised against a demo session, to prove its own plumbing works.
 *
 * It proves nothing whatever about Dataverse — a demo session reaches a simulator — and the evidence file
 * says so loudly, because an evidence file that cannot be told apart from a real one is worse than none.
 * Without this flag a demo session is refused outright, which is the behaviour that matters.
 */
const SELF_TEST = process.env.CERT_ALLOW_DEMO_SESSION === '1';
/**
 * A self-test never writes to the certification evidence path.
 *
 * `evidence/` is where this repository keeps verification evidence that other checks read and that claims
 * in the documentation are measured against. A file there called dataverse-real-tenant.json, holding a
 * run against a simulator, is a trap for whoever reads it next — so the two kinds of run cannot collide
 * on a filename, whatever flags were passed.
 */
const EVIDENCE_FILE = SELF_TEST
  ? 'evidence/dataverse-driver-selftest.json'
  : 'evidence/dataverse-real-tenant.json';
const KEEP_URLS = process.argv.includes('--keep-urls');
/** How many tables to certify deeply. Three to five: enough shapes, not a sweep of somebody's tenant. */
const DEEP_TABLE_LIMIT = Number(process.env.CERT_TABLE_LIMIT ?? 5);

// ---------------------------------------------------------------------------
// The session, and the care taken with it
// ---------------------------------------------------------------------------

const sessionFile = process.env.CERT_SESSION_FILE;
if (!sessionFile) {
  console.error(
    'CERT_SESSION_FILE is not set.\n\n' +
      'This script needs the session of a signed-in user, because Dataverse access is delegated and no\n' +
      'service credential exists. Put the value of the `dvm_session` cookie on one line in a file and\n' +
      'point CERT_SESSION_FILE at it. The value is never printed and never reaches the evidence file.\n',
  );
  process.exit(2);
}
const sessionToken = (() => {
  const lines = readFileSync(sessionFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error(`${sessionFile} is empty`);
  // Tolerates a whole cookie header or a `name=value` pair, because that is what people copy.
  const raw = lines[0];
  const match = /(?:^|;\s*)dvm_session=([^;]+)/.exec(raw);
  const value = (match ? match[1] : raw).trim();
  if (value.length < 20) throw new Error('that does not look like a session value (too short)');
  return value;
})();

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** A GUID keeps its first block, which is enough to tell two apart and not enough to be one. */
const guid = (v) => (typeof v === 'string' && v.length >= 8 ? `${v.slice(0, 8)}…` : (v ?? null));

/** An environment host keeps its shape and loses the organization, unless --keep-urls says otherwise. */
const host = (url) => {
  if (!url) return null;
  if (KEEP_URLS) return url;
  try {
    const u = new URL(url);
    const [first, ...rest] = u.hostname.split('.');
    return `${u.protocol}//${first.slice(0, 4)}….${rest.join('.')}`;
  } catch {
    return '(unparseable)';
  }
};

/**
 * Scrubs anything that smells like a credential out of a response before it is recorded.
 *
 * Belt and braces: the API is not supposed to return a token, and this file is not the place to find out
 * that it did. Keys whose names suggest a secret are dropped; long opaque strings are truncated.
 */
const SECRET_KEY = /secret|token|password|authorization|cookie|bearer|credential/i;
const scrub = (value, depth = 0) => {
  if (depth > 6) return '(deep)';
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) {
        out[k] = v === null || v === undefined ? null : '(redacted)';
        continue;
      }
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 400) return `${value.slice(0, 400)}…`;
  return value;
};

// ---------------------------------------------------------------------------
// The record of what happened
// ---------------------------------------------------------------------------

const evidence = {
  recordedAt: new Date().toISOString(),
  baseUrl: BASE,
  /** Filled from the deployment itself, so the report names the build that answered. */
  build: null,
  deploymentMode: null,
  writeBlockProbe: PROVE_WRITE_BLOCK ? 'REQUESTED' : 'NOT_REQUESTED',
  /**
   * The single field that decides whether this file is evidence about Dataverse or a self-test of the
   * script. Nothing downstream may treat SELF_TEST output as certification.
   */
  kind: SELF_TEST ? 'SELF_TEST_AGAINST_SIMULATOR' : 'REAL_TENANT',
  steps: [],
  notes: [],
};

let currentPhase = '0. setup';
const phase = (name) => {
  currentPhase = name;
  console.log(`\n=== ${name}`);
};

/**
 * One line of evidence.
 *
 * `expected` is written down in the call that makes the request, which is the only way a PASS means
 * anything: a verdict chosen after seeing the answer is not a verdict.
 */
const record = (step) => {
  const row = { phase: currentPhase, at: new Date().toISOString(), ...step };
  evidence.steps.push(row);
  const mark =
    { PASS: 'PASS ', FAIL: 'FAIL ', BLOCKED: 'BLOCK', NOT_EXECUTED: 'N/EX ' }[row.verdict] ?? '?    ';
  console.log(`  ${mark} ${row.operation}`);
  if (row.actual) console.log(`         ${String(row.actual).slice(0, 300)}`);
  return row;
};

const note = (text) => {
  evidence.notes.push(text);
  console.log(`  note   ${text}`);
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let csrfToken = null;

/** Calls the deployment the way its own interface does. Never throws on a status; returns it. */
async function api(method, path, body) {
  const headers = { cookie: `dvm_session=${sessionToken}`, accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(process.env.CERT_TIMEOUT_MS ?? 300_000)),
    });
  } catch (err) {
    return { status: 0, ms: Date.now() - startedAt, error: err.message, data: null };
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { nonJson: text.slice(0, 300) };
    }
  }
  return { status: res.status, ms: Date.now() - startedAt, data };
}

/** A download: we want the size and the first line, not the body in the evidence file. */
async function download(path) {
  const res = await fetch(BASE + path, {
    headers: { cookie: `dvm_session=${sessionToken}` },
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text), firstLine: text.split(/\r?\n/)[0] ?? '' };
}

const errorCode = (r) => r.data?.error?.code ?? (r.error ? 'TRANSPORT' : null);
const arrayOf = (data) => (Array.isArray(data) ? data : (data?.items ?? data?.rows ?? []));

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * Waits for a queued job to finish, and returns the finished row.
 *
 * Preflight and comparison both `enqueue` and hand back the QUEUED row at once. An earlier version of
 * this script recorded that row, so a preflight that classified 427 records was written into the evidence
 * file as seven zeros — a certification run reporting that nothing was exercised, about work that had not
 * started yet. Reading a status field before the work behind it has run is the single easiest way to
 * produce confident, false evidence.
 *
 * Returns `{ data, waitedMs, timedOut }`. A timeout is reported, never treated as a completion.
 */
async function waitForJob(path, { timeoutMs = 900_000, intervalMs = 3000 } = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const r = await api('GET', path);
    last = r;
    const status = r.data?.status;
    if (r.status !== 200) break;
    if (status === undefined || TERMINAL.has(status)) {
      return { data: r.data, status, waitedMs: Date.now() - startedAt, timedOut: false };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    data: last?.data ?? null,
    status: last?.data?.status,
    waitedMs: Date.now() - startedAt,
    timedOut: true,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — the real authentication chain
// ---------------------------------------------------------------------------

async function phase1() {
  phase('1. Authentication chain');

  const session = await api('GET', '/api/auth/session');
  if (session.status !== 200 || !session.data?.user) {
    record({
      operation: 'GET /api/auth/session resolves a signed-in user',
      expected: 'HTTP 200 with a user',
      actual: `HTTP ${session.status}, user ${session.data?.user ? 'present' : 'null'}`,
      verdict: 'FAIL',
    });
    throw new Error(
      'The session did not resolve. Either the value in CERT_SESSION_FILE is wrong, or it has expired — ' +
        'sign in again and copy a fresh one.',
    );
  }
  csrfToken = session.data.csrfToken;
  const user = session.data.user;
  evidence.deploymentMode = { realTenantReadOnly: session.data.realTenantReadOnly };
  record({
    operation: 'GET /api/auth/session resolves a signed-in user',
    expected:
      'HTTP 200, a user whose authProvider is microsoft, and the deployment states its read-only mode',
    actual: `authProvider=${user.authProvider} role=${user.role} org=${guid(user.organization?.id)} readOnly=${session.data.realTenantReadOnly}`,
    verdict: user.authProvider === 'microsoft' ? 'PASS' : 'FAIL',
    response: scrub({
      user: {
        ...user,
        id: guid(user.id),
        organization: { ...user.organization, id: guid(user.organization?.id) },
      },
      realTenantReadOnly: session.data.realTenantReadOnly,
    }),
  });
  if (user.authProvider !== 'microsoft') {
    if (!SELF_TEST) {
      throw new Error(
        `This session was created by "${user.authProvider}", not by Microsoft. A demo session cannot reach a ` +
          'real tenant and certifying with one would prove nothing. Sign in with Microsoft and use that session.',
      );
    }
    note(
      'CERT_ALLOW_DEMO_SESSION=1: this run is a self-test of the script against simulated environments. It ' +
        'establishes that the driver works. It establishes NOTHING about Dataverse, and must never be cited ' +
        'as certification.',
    );
  }

  const settings = await api('GET', '/api/settings');
  evidence.build = scrub(settings.data?.build ?? null);
  record({
    operation: 'GET /api/settings names the build and the Microsoft configuration',
    expected:
      'the commit that produced this deployment, the tenant it authenticates against, and read-only true',
    actual:
      settings.status === 200
        ? `commit=${settings.data.build?.commit} demoMode=${settings.data.demoMode} tenant=${settings.data.microsoft?.tenant} readOnly=${settings.data.safety?.realTenantReadOnly} database=${settings.data.database}`
        : `HTTP ${settings.status}`,
    verdict: settings.status === 200 && settings.data?.safety?.realTenantReadOnly === true ? 'PASS' : 'FAIL',
    response: scrub(settings.data),
  });
  if (settings.data?.demoMode === true) {
    note(
      'DEMO_MODE is true on this deployment. Real environments are still discovered through the real Global ' +
        'Discovery Service — that choice is made per environment, not per deployment — but the interface shows ' +
        'the amber DEMO MODE bar rather than the blue READ ONLY one, and anonymous demo sign-in is reachable ' +
        'while it is true. docs/REAL_TENANT_CERTIFICATION.md step A1 asks for DEMO_MODE=false.',
    );
  }

  for (const [path, label] of [
    ['/api/platform/auth-configuration', 'the sign-in configuration report'],
    ['/api/platform/operations', 'the operator diagnostics'],
  ]) {
    const r = await api('GET', path);
    record({
      operation: `GET ${path} — ${label} is reachable by this operator`,
      expected: 'HTTP 200, because ADMIN_EMAILS names this user',
      actual: `HTTP ${r.status}${r.status === 200 ? '' : ` ${errorCode(r)}`}`,
      verdict: r.status === 200 ? 'PASS' : 'FAIL',
      response: scrub(r.data),
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — real environment discovery
// ---------------------------------------------------------------------------

async function phase2() {
  phase('2. Dataverse environment discovery');

  const r = await api('POST', '/api/environments/discover');
  if (r.status !== 200) {
    record({
      operation: 'POST /api/environments/discover against the real Global Discovery Service',
      expected: 'HTTP 200 and the environments this identity can reach',
      actual: `HTTP ${r.status} ${errorCode(r)}: ${r.data?.error?.message ?? r.error ?? ''}`,
      verdict: 'FAIL',
      response: scrub(r.data),
    });
    return [];
  }
  const all = arrayOf(r.data);
  const dataverse = all.filter((e) => e.provider === 'dataverse');
  const other = all.filter((e) => e.provider !== 'dataverse');
  record({
    operation: 'POST /api/environments/discover against the real Global Discovery Service',
    expected:
      'HTTP 200, and at least one environment whose provider is "dataverse" — a real one, not a simulated one',
    actual: `${all.length} environment(s): ${dataverse.length} real dataverse, ${other.length} simulated/other`,
    verdict: dataverse.length > 0 ? 'PASS' : 'FAIL',
    request:
      'POST /api/environments/discover (no body). Reaches /api/discovery/v2.0/Instances on the Global ' +
      'Discovery Service with this user’s delegated token.',
    response: all.map((e) => ({
      provider: e.provider,
      displayName: e.displayName,
      url: host(e.url),
      apiUrl: host(e.apiUrl),
      environmentId: guid(e.environmentId),
      dataverseOrganizationId: guid(e.dataverseOrganizationId),
      uniqueName: e.uniqueName,
      environmentType: e.environmentType,
      region: e.region,
      version: e.version,
      state: e.state,
    })),
  });
  if (dataverse.length === 0) {
    if (SELF_TEST && other.length > 0) {
      note(
        'Self-test: no real environment exists, so the simulated ones are used to exercise the rest of this ' +
          'script. Every verdict below describes the simulator answering, not Dataverse.',
      );
      return other.filter((e) => e.provider === 'demo');
    }
    note(
      'Discovery succeeded and returned no real environment. Per docs/REAL_TENANT_CERTIFICATION.md A3 that ' +
        'means this account has no Dataverse security role anywhere, or an environment security group excludes it.',
    );
    return [];
  }

  // Phase 2 asks whether another tenant's environment can enter this workspace. It cannot arrive by
  // accident: discovery is a delegated call, so the service returns only instances this identity can
  // reach, and for a non-demo organization discovery is the only writer of environment rows.
  const types = [...new Set(dataverse.map((e) => e.environmentType ?? '(unclassified)'))];
  record({
    operation: 'Environment provenance: every row came from the delegated discovery call',
    expected: 'no environment can enter the workspace from a source other than this identity’s own discovery',
    actual: `types seen: ${types.join(', ')}. For a non-demo organization, discovery is the only writer of environment rows.`,
    verdict: 'PASS',
  });
  return dataverse;
}

/**
 * Picks the environments the deeper phases will use: a source, and a target.
 *
 * **Two, not one.** Planning, preflight, principal mapping, data comparison and schema comparison all
 * refuse a source that is also the target — `badRequest('Source and target must be different
 * environments')`, in five separate services. An earlier version of this script pointed both at the same
 * environment and every one of those phases came back HTTP 400. That is the product being right and the
 * harness being wrong, and it is why docs/REAL_TENANT_CERTIFICATION.md A0 asks for a role in *two*
 * non-production environments.
 *
 * Production is refused outright for either role. Reading a production environment would be harmless
 * here, but a certification run that selects production by default is a habit that will eventually be
 * run with the write flag on.
 */
function selectEnvironments(envs) {
  const kind = (e) => String(e.environmentType ?? '').toLowerCase();
  const usable = envs.filter((e) => kind(e) !== '' && !/production|default/.test(kind(e)));
  const unclassified = envs.filter((e) => kind(e) === '');
  const production = envs.length - usable.length - unclassified.length;

  const rejected = [];
  if (production > 0) rejected.push(`${production} production`);
  if (unclassified.length > 0) {
    rejected.push(
      `${unclassified.length} unclassified (the product’s safety classifier treats these as production)`,
    );
  }
  const rejectedWhy = rejected.length > 0 ? ` Not eligible: ${rejected.join(', ')}.` : '';

  if (usable.length === 0) {
    return {
      source: null,
      target: null,
      why: `no non-production environment was discovered.${rejectedWhy}`,
    };
  }
  if (usable.length === 1) {
    return {
      source: usable[0],
      target: null,
      why: `one non-production environment (${usable[0].environmentType}).${rejectedWhy}`,
      targetWhy:
        'only one non-production environment is available. Planning, preflight, principal mapping and ' +
        'schema comparison each require a source and a distinct target, so none can be exercised. ' +
        'Creating a second environment to manufacture them is out of scope for this phase.',
    };
  }
  return {
    source: usable[0],
    target: usable[1],
    why: `source ${usable[0].environmentType}, target ${usable[1].environmentType}.${rejectedWhy}`,
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — a real connection
// ---------------------------------------------------------------------------

async function phase3(env, role) {
  const test = await api('POST', `/api/environments/${env.id}/test`);
  record({
    operation: `POST /api/environments/:id/test — ${role}: token acquisition and WhoAmI against ${host(env.url)}`,
    expected: 'HTTP 200, connected, and the Dataverse user id this identity maps to inside that environment',
    actual:
      test.status === 200
        ? JSON.stringify(scrub(test.data)).slice(0, 250)
        : `HTTP ${test.status} ${errorCode(test)}: ${test.data?.error?.message ?? ''}`,
    verdict: test.status === 200 ? 'PASS' : 'FAIL',
    response: scrub(test.data),
  });

  return test.status === 200;
}

/** The product's own connection report. It takes both environments, so it runs once for the pair. */
async function diagnostics(source, target) {
  const diag = await api('POST', '/api/diagnostics', {
    sourceEnvironmentId: source.id,
    ...(target ? { targetEnvironmentId: target.id } : {}),
  });
  const checks = diag.data?.checks ?? [];
  record({
    operation: 'POST /api/diagnostics — the product’s own connection report, every check',
    expected:
      'authentication, token acquisition, environment discovery, metadata access, record read and user ' +
      'discovery each answer; the write check is never attempted',
    actual:
      diag.status === 200
        ? checks.map((c) => `${c.key}=${c.status}`).join(' ')
        : `HTTP ${diag.status} ${errorCode(diag)}`,
    verdict: diag.status === 200 ? 'PASS' : 'FAIL',
    response: scrub(diag.data),
  });

  const write = checks.find((c) => c.key === 'write');
  record({
    operation: 'The diagnostics write check is never probed on a read-only deployment',
    expected: 'the write check reports a not-tested status and says why, rather than attempting a write',
    actual: write ? `status=${write.status} message=${write.message}` : 'no write check present',
    verdict: write && /REAL_TENANT_READ_ONLY/.test(write.message ?? '') ? 'PASS' : write ? 'FAIL' : 'BLOCKED',
  });
  return checks;
}

// ---------------------------------------------------------------------------
// Phase 4 — real metadata
// ---------------------------------------------------------------------------

/**
 * Chooses tables that exercise different Dataverse shapes rather than the first five alphabetically.
 *
 * The brief asks for relationships, choices and ownership. Scoring beats a hard-coded list, because a
 * hard-coded list is wrong in any environment that does not happen to contain those tables.
 */
function pickTables(summaries) {
  const candidates = summaries
    .filter((t) => t.logicalName && !/^(msdyn_|adx_|mspp_)/.test(t.logicalName))
    .map((t) => ({
      t,
      score:
        (/^(account|contact|systemuser|team|businessunit)$/.test(t.logicalName) ? 3 : 0) +
        (t.ownershipType === 'UserOwned' ? 2 : 0) +
        (t.isCustom ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  const out = [];
  for (const name of ['account', 'contact', 'systemuser', 'businessunit', 'team']) {
    const hit = candidates.find((c) => c.t.logicalName === name);
    if (hit && !out.includes(hit.t)) out.push(hit.t);
  }
  for (const c of candidates) {
    if (out.length >= DEEP_TABLE_LIMIT) break;
    if (!out.includes(c.t)) out.push(c.t);
  }
  return out.slice(0, DEEP_TABLE_LIMIT);
}

async function phase4(env) {
  phase('4. Dataverse metadata discovery');

  const list = await api('GET', `/api/environments/${env.id}/tables`);
  const summaries = Array.isArray(list.data) ? list.data : (list.data?.tables ?? []);
  record({
    operation: 'GET /api/environments/:id/tables — the real table catalog',
    expected: 'HTTP 200 and a catalog of readable tables, read from EntityDefinitions',
    actual: list.status === 200 ? `${summaries.length} table(s)` : `HTTP ${list.status} ${errorCode(list)}`,
    verdict: list.status === 200 && summaries.length > 0 ? 'PASS' : 'FAIL',
  });
  if (list.status !== 200 || summaries.length === 0) return [];

  const chosen = pickTables(summaries);
  note(`Deep metadata on ${chosen.length} table(s): ${chosen.map((t) => t.logicalName).join(', ')}`);

  const detailed = [];
  /** Which of the shapes the brief asks about were actually present to be exercised. */
  const shapes = {
    relationshipsOneToMany: false,
    relationshipsManyToOne: false,
    relationshipsManyToMany: false,
    selfReference: false,
    optionSets: false,
    alternateKeys: false,
    userOwned: false,
    stateStatus: false,
    calculated: false,
    readOnlyAttributes: false,
    lookups: false,
  };

  for (const t of chosen) {
    const r = await api('GET', `/api/environments/${env.id}/tables/${t.logicalName}`);
    if (r.status !== 200) {
      record({
        operation: `GET metadata for ${t.logicalName}`,
        expected: 'HTTP 200 with attributes, keys and relationships',
        actual: `HTTP ${r.status} ${errorCode(r)}: ${r.data?.error?.message ?? ''}`,
        verdict: 'FAIL',
      });
      continue;
    }
    const m = r.data;
    const attrs = m.attributes ?? [];
    const oneToMany = m.oneToManyRelationships ?? [];
    const manyToOne = m.manyToOneRelationships ?? [];
    const manyToMany = m.manyToManyRelationships ?? [];
    const keys = m.alternateKeys ?? m.keys ?? [];
    const lookups = attrs.filter((a) => a.type === 'Lookup' || (a.targets?.length ?? 0) > 0);
    const choices = attrs.filter((a) => (a.options?.length ?? 0) > 0);
    const calculated = attrs.filter((a) => a.isCalculated || a.sourceType);
    const writable = attrs.filter((a) => a.isValidForUpdate || a.isValidForCreate);
    const readOnly = attrs.filter((a) => !a.isValidForUpdate && !a.isValidForCreate);
    const required = attrs.filter((a) => /Required$/.test(String(a.requiredLevel ?? '')));
    const selfRefs = [...manyToOne, ...oneToMany].filter(
      (rel) => rel.referencedEntity === t.logicalName && rel.referencingEntity === t.logicalName,
    );
    const hasStateStatus = attrs.some((a) => /^(statecode|statuscode)$/.test(a.logicalName));

    shapes.relationshipsOneToMany ||= oneToMany.length > 0;
    shapes.relationshipsManyToOne ||= manyToOne.length > 0;
    shapes.relationshipsManyToMany ||= manyToMany.length > 0;
    shapes.selfReference ||= selfRefs.length > 0;
    shapes.optionSets ||= choices.length > 0;
    shapes.alternateKeys ||= keys.length > 0;
    shapes.userOwned ||= m.ownershipType === 'UserOwned';
    shapes.stateStatus ||= hasStateStatus;
    shapes.calculated ||= calculated.length > 0;
    shapes.readOnlyAttributes ||= readOnly.length > 0;
    shapes.lookups ||= lookups.length > 0;

    const summary = {
      logicalName: m.logicalName,
      displayName: m.displayName,
      entitySetName: m.entitySetName,
      primaryIdAttribute: m.primaryIdAttribute,
      primaryNameAttribute: m.primaryNameAttribute,
      ownershipType: m.ownershipType,
      isCustom: m.isCustom,
      attributes: attrs.length,
      distinctTypes: [...new Set(attrs.map((a) => a.type))].sort(),
      requiredLevelsSeen: [...new Set(attrs.map((a) => a.requiredLevel).filter(Boolean))].sort(),
      required: required.length,
      writable: writable.length,
      readOnly: readOnly.length,
      lookups: lookups.length,
      choiceAttributes: choices.length,
      calculated: calculated.length,
      alternateKeys: keys.length,
      oneToMany: oneToMany.length,
      manyToOne: manyToOne.length,
      manyToMany: manyToMany.length,
      selfReferencing: selfRefs.length,
      hasStateStatus,
    };
    detailed.push({ meta: m, summary });
    record({
      operation: `GET metadata for ${t.logicalName}`,
      expected:
        'attributes with types and required levels, the primary id and name attributes, alternate keys, ' +
        'and relationships in all three directions',
      actual:
        `${attrs.length} attributes (${summary.distinctTypes.length} distinct types), ${required.length} required, ` +
        `${writable.length} writable / ${readOnly.length} read-only, ${lookups.length} lookups, ` +
        `${choices.length} with choices, ${keys.length} alternate key(s), relationships 1:N ${oneToMany.length} / ` +
        `N:1 ${manyToOne.length} / N:N ${manyToMany.length}` +
        (selfRefs.length ? `, ${selfRefs.length} self-referencing` : ''),
      verdict: attrs.length > 0 && m.primaryIdAttribute ? 'PASS' : 'FAIL',
      response: summary,
    });
  }

  for (const [shape, seen] of Object.entries(shapes)) {
    if (!seen) note(`Shape not present in the selected tables, so not exercised: ${shape}`);
  }
  evidence.shapesExercised = shapes;
  return detailed;
}

// ---------------------------------------------------------------------------
// Phases 5 and 8 — the dependency engine and planning, which share one plan
// ---------------------------------------------------------------------------

async function phase5and8(source, target, detailed) {
  phase('5. Dependency analysis against real relationships');

  const tables = detailed.map((d) => d.summary.logicalName);
  if (tables.length === 0) {
    record({
      operation: 'Dependency analysis over real metadata',
      expected: 'an ordering computed from real relationships',
      actual: 'no table metadata was read, so there is nothing to order',
      verdict: 'BLOCKED',
    });
    return null;
  }

  const plan = await api('POST', '/api/plans', {
    name: `Read-only certification ${new Date().toISOString().slice(0, 16)}`,
    sourceEnvironmentId: source.id,
    targetEnvironmentId: target.id,
    tables,
  });
  if (plan.status !== 200) {
    record({
      operation: 'POST /api/plans over the real tables, from the source environment to the target',
      expected: 'HTTP 200 and a plan whose entities are in dependency order',
      actual: `HTTP ${plan.status} ${errorCode(plan)}: ${plan.data?.error?.message ?? ''}`,
      verdict: 'FAIL',
      response: scrub(plan.data),
    });
    return null;
  }
  const p = plan.data;
  const entities = p.entities ?? [];
  const order = entities.map((e) => `${e.sequence ?? '?'}:${e.logicalName ?? e.sourceTable}`);
  record({
    operation: 'POST /api/plans over the real tables, from the source environment to the target',
    expected: 'HTTP 200; entities ordered so that a referenced table precedes the table referencing it',
    actual: `plan ${guid(p.id)} with ${entities.length} entities, order ${order.join(' → ')}`,
    verdict: entities.length > 0 ? 'PASS' : 'FAIL',
    response: scrub({ ...p, id: guid(p.id), entities: entities.map((e) => ({ ...e, id: guid(e.id) })) }),
  });

  const cycles = p.dependencyCycles ?? p.cycles ?? [];
  const deferred = entities.filter((e) => e.deferredReferences?.length || e.requiresSecondPass);
  record({
    operation: 'Cycles, self references and deferred lookups, from real relationships',
    expected:
      'cycles reported rather than hidden, and anything circular resolved by deferring a reference to a second pass',
    actual: `${cycles.length} cycle(s) reported; ${deferred.length} entity/entities need a second pass`,
    verdict: 'PASS',
    response: scrub({ cycles, deferred: deferred.map((e) => e.logicalName) }),
  });

  const warnings = p.warnings ?? [];
  record({
    operation: 'Plan validation findings over real metadata',
    expected: 'whatever the real environment produces, reported rather than suppressed',
    actual: `${warnings.length} warning(s): ${warnings
      .map((w) => w.code ?? w.key ?? w)
      .slice(0, 12)
      .join(', ')}`,
    verdict: 'PASS',
    response: scrub(warnings),
  });

  phase('8. Migration planning and preflight (dry run)');

  const readiness = await api('GET', `/api/plans/${p.id}/readiness`);
  record({
    operation: 'GET /api/plans/:id/readiness — what the product says about this plan before any write',
    expected: 'a readiness verdict per check, computed from the real metadata',
    actual:
      readiness.status === 200
        ? `${(readiness.data?.findings ?? readiness.data?.checks ?? []).length} finding(s); verdict ${readiness.data?.verdict ?? readiness.data?.level ?? '(none)'}`
        : `HTTP ${readiness.status} ${errorCode(readiness)}`,
    verdict: readiness.status === 200 ? 'PASS' : 'FAIL',
    response: scrub(readiness.data),
  });

  const pre = await api('POST', `/api/plans/${p.id}/preflight`);
  if (pre.status !== 200) {
    record({
      operation: 'POST /api/plans/:id/preflight — the dry run: read every source record and classify it',
      expected:
        'HTTP 200 and every record classified CREATE / UPDATE / UNCHANGED / CONFLICT / BLOCKED. Nothing written.',
      actual: `HTTP ${pre.status} ${errorCode(pre)}: ${pre.data?.error?.message ?? ''}`,
      verdict: 'FAIL',
      response: scrub(pre.data),
    });
    return { plan: p, preflight: null };
  }
  // The POST enqueues the work and returns a QUEUED row, so the answer is not in `pre`.
  const queued = pre.data;
  const done = await waitForJob(`/api/preflight/${queued.id}`);
  const pf = done.data ?? queued;
  const totals = pf.totals ?? pf.summary ?? {};
  record({
    operation: 'POST /api/plans/:id/preflight — the dry run: read every source record and classify it',
    expected:
      'HTTP 200, then the preflight reaches COMPLETED, having read records from the real environment and ' +
      'classified every one. No Dataverse write of any kind.',
    actual: done.timedOut
      ? `preflight ${guid(queued.id)} was still ${pf.status} after ${Math.round(done.waitedMs / 1000)}s`
      : `preflight ${guid(pf.id)} ${pf.status} after ${Math.round(done.waitedMs / 1000)}s: ${JSON.stringify(scrub(totals)).slice(0, 220)}`,
    verdict: done.timedOut ? 'FAIL' : pf.status === 'COMPLETED' ? 'PASS' : 'FAIL',
    response: scrub({ ...pf, id: guid(pf.id) }),
  });
  if (pf.status !== 'COMPLETED') return { plan: p, preflight: pf.id ? pf : null };

  /**
   * Which classifications the real data actually produced. The brief is explicit that forcing the rest
   * into existence would be worthless, so the ones that did not occur are reported as not exercised.
   */
  const CLASSES = ['CREATE', 'UPDATE', 'UNCHANGED', 'CONFLICT', 'BLOCKED'];
  const seen = {};
  const queriedSeparately = {};
  for (const c of CLASSES) {
    seen[c] = totals[c.toLowerCase()] ?? 0;
    const r = await api('GET', `/api/preflight/${pf.id}/records?action=${c}&limit=5`);
    queriedSeparately[c] = r.status === 200 ? (r.data?.total ?? arrayOf(r.data).length) : null;
  }
  // Two routes to the same number. They are supposed to agree; if they ever do not, the disagreement is
  // the finding, and a report that quietly picked one of them would have buried it.
  const disagreements = CLASSES.filter(
    (c) => queriedSeparately[c] !== null && queriedSeparately[c] !== seen[c],
  );
  record({
    operation: 'Preflight classifications actually produced by real data',
    expected:
      'the classifications the data naturally produces, the rest reported as not exercised rather than ' +
      'manufactured, and the per-action record query agreeing with the run totals',
    actual:
      `${CLASSES.map((c) => `${c}=${seen[c]}`).join(' ')} (analyzed ${totals.analyzed ?? '?'} of ` +
      `${totals.sourceRecords ?? '?'} source records)` +
      (disagreements.length
        ? `. DISAGREEMENT between totals and the per-action query for: ${disagreements
            .map((c) => `${c} ${seen[c]} vs ${queriedSeparately[c]}`)
            .join(', ')}`
        : '. The per-action query agrees with the totals.'),
    verdict: disagreements.length === 0 ? 'PASS' : 'FAIL',
    response: { fromTotals: seen, fromRecordQuery: queriedSeparately, totals: scrub(totals) },
  });
  for (const c of CLASSES) {
    if (!seen[c]) note(`Preflight classification not exercised by this environment’s data: ${c}`);
  }
  evidence.classifications = seen;
  return { plan: p, preflight: pf };
}

// ---------------------------------------------------------------------------
// Phase 6 — users, teams, business units
// ---------------------------------------------------------------------------

async function phase6(source, target) {
  phase('6. User / team / business unit discovery and mapping');

  const refresh = await api('POST', '/api/principal-mappings/refresh', {
    sourceEnvironmentId: source.id,
    targetEnvironmentId: target.id,
    refreshDirectory: false,
  });
  record({
    operation:
      'POST /api/principal-mappings/refresh — read systemuser, team and businessunit from the real environment',
    expected:
      'HTTP 200; principals discovered and matched by Entra object id, then domain name, then email, then unique display name',
    actual:
      refresh.status === 200
        ? JSON.stringify(scrub(refresh.data)).slice(0, 300)
        : `HTTP ${refresh.status} ${errorCode(refresh)}: ${refresh.data?.error?.message ?? ''}`,
    verdict: refresh.status === 200 ? 'PASS' : 'FAIL',
    response: scrub(refresh.data),
  });

  const list = await api(
    'GET',
    `/api/principal-mappings?sourceEnvironmentId=${source.id}&targetEnvironmentId=${target.id}`,
  );
  const rows = arrayOf(list.data).length ? arrayOf(list.data) : (list.data?.mappings ?? []);
  const byKind = {};
  const byState = {};
  for (const m of rows) {
    const kind = m.logicalName ?? 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const state = m.ignored ? 'IGNORED' : m.ambiguous ? 'AMBIGUOUS' : m.targetId ? 'MAPPED' : 'UNRESOLVED';
    byState[state] = (byState[state] ?? 0) + 1;
  }
  record({
    operation: 'GET /api/principal-mappings — the mapping result, including what could not be mapped',
    expected:
      'users, teams and business units each counted, and ambiguous / unresolved / disabled recorded rather than guessed',
    actual:
      list.status === 200
        ? `${rows.length} principal(s). by kind ${JSON.stringify(byKind)}. by state ${JSON.stringify(byState)}`
        : `HTTP ${list.status} ${errorCode(list)}`,
    verdict: list.status === 200 ? 'PASS' : 'FAIL',
    response: { byKind, byState, matchBasesSeen: [...new Set(rows.map((m) => m.matchedBy).filter(Boolean))] },
  });

  const imp = await api('POST', '/api/principal-mappings/impersonation-check', {
    sourceEnvironmentId: source.id,
    targetEnvironmentId: target.id,
  });
  record({
    operation: 'POST /api/principal-mappings/impersonation-check — read-only either way',
    expected:
      'an answer about prvActOnBehalfOfAnotherUser. "Cannot impersonate" is a valid result, and it writes nothing.',
    actual:
      imp.status === 200
        ? JSON.stringify(scrub(imp.data)).slice(0, 250)
        : `HTTP ${imp.status} ${errorCode(imp)}: ${imp.data?.error?.message ?? ''}`,
    verdict: imp.status === 200 ? 'PASS' : 'FAIL',
    response: scrub(imp.data),
  });
}

// ---------------------------------------------------------------------------
// Phase 7 — schema comparison
// ---------------------------------------------------------------------------

async function phase7(source, target, tables) {
  phase('7. Schema comparison');

  const cmp = await api('POST', '/api/comparisons', {
    sourceEnvironmentId: source.id,
    targetEnvironmentId: target.id,
    tables,
    refreshMetadata: true,
  });
  if (cmp.status !== 200) {
    record({
      operation: `POST /api/comparisons between ${host(source.url)} and ${host(target.url)}`,
      expected: 'HTTP 200 and a per-table, per-column difference list',
      actual: `HTTP ${cmp.status} ${errorCode(cmp)}: ${cmp.data?.error?.message ?? ''}`,
      verdict: 'FAIL',
      response: scrub(cmp.data),
    });
    return;
  }
  // Enqueued, like preflight. Reading the tables before the job has run reports zero differences.
  const finished = await waitForJob(`/api/comparisons/${cmp.data.id}`);
  const detail = await api('GET', `/api/comparisons/${cmp.data.id}/tables`);
  const rows = Array.isArray(detail.data) ? detail.data : (detail.data?.tables ?? []);
  const kinds = {};
  for (const t of rows) {
    for (const d of t.differences ?? []) {
      const k = d.kind ?? d.type ?? 'other';
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
  }
  record({
    operation: `POST /api/comparisons between ${host(source.url)} and ${host(target.url)}`,
    expected: 'the comparison reaches COMPLETED, and naturally occurring differences are classified by kind',
    actual: finished.timedOut
      ? `still ${finished.status} after ${Math.round(finished.waitedMs / 1000)}s`
      : `${finished.status} after ${Math.round(finished.waitedMs / 1000)}s; ${rows.length} table(s) compared; difference kinds ${JSON.stringify(kinds)}`,
    verdict: !finished.timedOut && finished.status === 'COMPLETED' ? 'PASS' : 'FAIL',
    response: scrub({ status: finished.status, kinds, tablesCompared: rows.length }),
  });
}

// ---------------------------------------------------------------------------
// Phase 9 — validation exports
// ---------------------------------------------------------------------------

async function phase9(plan, preflight) {
  phase('9. Validation and export artifacts');

  if (!plan) {
    record({
      operation: 'Exports built from a real plan',
      expected: 'the remediation package and the issue exports',
      actual: 'no plan was created, so nothing could be exported',
      verdict: 'BLOCKED',
    });
    return;
  }
  const downloads = [
    [`/api/plans/${plan.id}/issues-package.csv`, 'the remediation package: every issue with its resolution'],
    [`/api/plans/${plan.id}/issues.csv`, 'plan issues'],
    [`/api/plans/${plan.id}/data-quality.csv`, 'data quality findings'],
    [`/api/plans/${plan.id}/lossy-records.csv`, 'records a transformation would discard data from'],
  ];
  if (preflight) downloads.push([`/api/preflight/${preflight.id}/records.csv`, 'every classified record']);

  for (const [path, label] of downloads) {
    const d = await download(path);
    // An export is where a credential would escape unnoticed, so the first line is checked for one.
    const leaks = /bearer |eyJ[A-Za-z0-9_-]{10}|client_secret|dvm_session/i.test(d.firstLine);
    record({
      operation: `GET ${path.replace(/[0-9a-f-]{36}/g, ':id')} — ${label}`,
      expected: 'HTTP 200, a CSV whose header names useful identifiers, and no credential anywhere in it',
      actual: `HTTP ${d.status}, ${d.bytes} bytes, header: ${d.firstLine.slice(0, 200)}`,
      verdict: d.status === 200 && !leaks ? 'PASS' : 'FAIL',
      response: { bytes: d.bytes, header: d.firstLine.slice(0, 400) },
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 10 — the server-side read-only guard
// ---------------------------------------------------------------------------

async function phase10(plan) {
  phase('10. Server-side read-only enforcement');

  if (!PROVE_WRITE_BLOCK) {
    record({
      operation: 'Execution request against a real environment, expecting refusal',
      expected: 'HTTP 403 REAL_TENANT_READ_ONLY and a READ_ONLY_WRITE_BLOCKED audit event',
      actual: 'not run: --prove-write-block was not passed',
      verdict: 'NOT_EXECUTED',
    });
    return;
  }
  /**
   * The interlock.
   *
   * Asking a deployment to execute a migration is only a safe probe if that deployment has already said
   * it will refuse. Trusting the Railway variable is not enough — what matters is what the running
   * process believes, which is what it reports here.
   */
  const session = await api('GET', '/api/auth/session');
  if (session.data?.realTenantReadOnly !== true) {
    record({
      operation: 'Execution request against a real environment, expecting refusal',
      expected: 'HTTP 403 REAL_TENANT_READ_ONLY',
      actual:
        `the deployment reports realTenantReadOnly=${session.data?.realTenantReadOnly}. The probe was NOT sent, ` +
        'because against a deployment that permits writes this would not be a probe, it would be a migration.',
      verdict: 'BLOCKED',
    });
    return;
  }
  if (!plan) {
    record({
      operation: 'Execution request against a real environment, expecting refusal',
      expected: 'HTTP 403 REAL_TENANT_READ_ONLY',
      actual: 'no plan exists to request the execution of',
      verdict: 'BLOCKED',
    });
    return;
  }
  if (SELF_TEST) {
    record({
      operation: 'Execution request against a real environment, expecting refusal',
      expected: 'HTTP 403 REAL_TENANT_READ_ONLY',
      actual:
        'this is a self-test against simulated environments. A demo target is deliberately exempt from the ' +
        'read-only guard — it holds no tenant data — so the probe would answer about the wrong thing.',
      verdict: 'NOT_EXECUTED',
    });
    return;
  }

  const before = await api('GET', '/api/runs');
  const runsBefore = arrayOf(before.data).length;

  const body = {
    acknowledgeWarnings: true,
    confirmed: true,
    confirmSourceName: plan.sourceEnvironment?.displayName,
    confirmTargetName: plan.targetEnvironment?.displayName,
  };
  const exec = await api('POST', `/api/plans/${plan.id}/execute`, body);
  record({
    operation: 'POST /api/plans/:id/execute — the real execution boundary, through the normal API',
    expected: 'HTTP 403 with code REAL_TENANT_READ_ONLY. The guard is in the service, not in the interface.',
    actual: `HTTP ${exec.status} ${errorCode(exec)}: ${exec.data?.error?.message ?? ''}`,
    verdict: exec.status === 403 && errorCode(exec) === 'REAL_TENANT_READ_ONLY' ? 'PASS' : 'FAIL',
    response: scrub(exec.data),
  });

  // Deterministic, not a race won once.
  const repeats = [];
  for (let i = 0; i < 3; i++) {
    const again = await api('POST', `/api/plans/${plan.id}/execute`, body);
    repeats.push(`${again.status}/${errorCode(again)}`);
  }
  record({
    operation: 'The refusal is deterministic: the same request, three more times',
    expected: 'the same 403 REAL_TENANT_READ_ONLY every time; no attempt succeeds on a retry',
    actual: repeats.join(' '),
    verdict: repeats.every((r) => r === '403/REAL_TENANT_READ_ONLY') ? 'PASS' : 'FAIL',
  });

  const after = await api('GET', '/api/runs');
  const runsAfter = arrayOf(after.data).length;
  record({
    operation: 'No run was created by the refused requests',
    expected: 'the run list is unchanged, so nothing is queued for a worker to pick up later',
    actual: `${runsBefore} run(s) before, ${runsAfter} after`,
    verdict: runsBefore === runsAfter ? 'PASS' : 'FAIL',
  });

  const audit = await api('GET', '/api/audit?limit=50');
  const rows = arrayOf(audit.data);
  const blocked = rows.filter((e) => e.action === 'READ_ONLY_WRITE_BLOCKED');
  record({
    operation: 'GET /api/audit — the refusal is on the record',
    expected: 'a READ_ONLY_WRITE_BLOCKED event for each refused attempt, with who and when',
    actual: `${blocked.length} READ_ONLY_WRITE_BLOCKED event(s) in the last ${rows.length} audit rows`,
    verdict: blocked.length >= 4 ? 'PASS' : 'FAIL',
    response: scrub(
      blocked
        .slice(0, 6)
        .map((e) => ({ action: e.action, outcome: e.outcome, at: e.createdAt ?? e.at, details: e.details })),
    ),
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Certifying ${BASE}`);
  console.log(`Session read from ${sessionFile} (the value is never printed)`);

  await phase1();
  const envs = await phase2();
  let plan = null;

  /** Records every phase that depends on something absent, with the one reason it is absent. */
  const blockDownstream = (phases, label, why) => {
    note(why);
    for (const n of phases) {
      currentPhase = `${n}. (${label})`;
      record({
        operation: 'Certification steps that depend on the environment(s) above',
        expected: 'a real Dataverse environment of the required kind',
        actual: why,
        verdict: 'BLOCKED',
      });
    }
  };

  const describe = (e) => ({
    displayName: e.displayName,
    url: host(e.url),
    environmentType: e.environmentType,
    environmentId: guid(e.environmentId),
    dataverseOrganizationId: guid(e.dataverseOrganizationId),
    region: e.region,
    version: e.version,
  });

  if (envs.length === 0) {
    blockDownstream(
      [3, 4, 5, 6, 7, 8, 9],
      'dependent on discovery',
      'no real Dataverse environment was discovered for this identity',
    );
  } else {
    const { source, target, why, targetWhy } = selectEnvironments(envs);
    if (!source) {
      blockDownstream([3, 4, 5, 6, 7, 8, 9], 'no non-production environment', why);
    } else {
      note(`Selected: ${why}`);
      evidence.selectedEnvironments = { source: describe(source), target: target ? describe(target) : null };

      phase('3. Dataverse connection');
      await phase3(source, 'source');
      if (target) await phase3(target, 'target');
      await diagnostics(source, target);

      const detailed = await phase4(source);
      const tables = detailed.map((d) => d.summary.logicalName);

      if (!target) {
        // Five services refuse a source that is also the target, so there is nothing to run here. Saying
        // so once, with the reason, beats four identical HTTP 400s recorded as failures.
        blockDownstream([5, 6, 7, 8, 9], 'no second environment', targetWhy);
      } else {
        const result = await phase5and8(source, target, detailed);
        plan = result?.plan ?? null;
        const preflight = result?.preflight ?? null;
        await phase6(source, target);
        await phase7(source, target, tables);
        await phase9(plan, preflight);
      }
    }
  }
  await phase10(plan);

  mkdirSync('evidence', { recursive: true });
  writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);

  const tally = {};
  for (const s of evidence.steps) tally[s.verdict] = (tally[s.verdict] ?? 0) + 1;
  console.log(`\n${'='.repeat(78)}\nCERTIFICATION RUN\n${'='.repeat(78)}`);
  for (const s of evidence.steps) {
    console.log(`${s.verdict.padEnd(13)} ${s.phase.padEnd(34)} ${s.operation.slice(0, 90)}`);
  }
  console.log('='.repeat(78));
  console.log(
    Object.entries(tally)
      .map(([k, v]) => `${v} ${k}`)
      .join(', '),
  );
  console.log('Written to evidence/dataverse-real-tenant.json');
  console.log('BLOCKED and NOT_EXECUTED are not failures. They are the certification boundary.');
  // `process.exitCode` rather than `process.exit()`: exiting while an HTTP handle is still closing makes
  // libuv assert on Windows, which turns a completed run into what looks like a crash.
  process.exitCode = (tally.FAIL ?? 0) > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nThe run stopped: ${err.message}`);
  mkdirSync('evidence', { recursive: true });
  evidence.notes.push(`Run stopped: ${err.message}`);
  writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = 1;
});
