import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    );

const isProduction = process.env.NODE_ENV === 'production';
// Curated demo content is off under test, where a suite counts only the runs it started itself.
const isTest = process.env.NODE_ENV === 'test';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(false),

  DATABASE_URL: z.string().optional(),
  PGLITE_DATA_DIR: z.string().default('./.data/pglite'),
  MIGRATIONS_DIR: z.string().default('./server/drizzle'),

  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: bool(isProduction),

  DEMO_MODE: bool(!isProduction),
  DEMO_LATENCY_MS: z.coerce.number().int().min(0).default(12),
  /**
   * Builds the two worked migrations a visitor should find already done, by running them.
   *
   * Separate from DEMO_MODE because the two mean different things: DEMO_MODE decides whether the
   * connectors are simulated, this decides whether the workspace comes with curated content. Off
   * under test, where every suite wants to count only the runs it started itself, and off for a
   * pilot tenant that wants the simulated environments without somebody else's example projects.
   */
  DEMO_SCENARIOS: bool(!isTest),
  /**
   * How long an abandoned evaluator workspace is kept before it is deleted with everything in it.
   *
   * Each demo sign-in creates its own organization, so something has to clear them up. A workspace
   * with a session that has not expired is never removed, whatever its age — logging somebody out
   * mid-evaluation would be worse than keeping the row. Zero disables the sweep entirely.
   */
  DEMO_WORKSPACE_TTL_HOURS: z.coerce.number().min(0).default(48),
  /**
   * How many evaluator workspaces may exist at once.
   *
   * Each one seeds its own copy of the simulated data and runs two real migrations to build its
   * worked examples, so a sign-in is a few seconds of genuine work rather than a row insert. That
   * is the right behaviour — the demo is honest because it actually runs — and it is also a way to
   * spend somebody else's compute. Past this ceiling a new visitor is asked to come back shortly
   * rather than being handed a workspace the deployment cannot afford.
   *
   * The limit is on live workspaces, not on sign-ins, so the expiry sweep is what frees capacity.
   */
  DEMO_MAX_WORKSPACES: z.coerce.number().int().min(1).default(200),

  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_TENANT_ID: z.string().default('organizations'),
  ENTRA_AUTHORITY_HOST: z.string().url().default('https://login.microsoftonline.com'),
  ENTRA_REDIRECT_URI: z.string().url().optional(),
  ALLOWED_TENANT_IDS: z.string().optional(),
  /**
   * Who may sign in with a Microsoft account.
   *
   * GATED      only tenants named in ALLOWED_TENANT_IDS. A tenant nobody listed is refused.
   * OPEN_BETA  any Microsoft work or school account; a workspace is created on first sign-in.
   *
   * GATED by default, and deliberately so. Leaving ALLOWED_TENANT_IDS empty used to mean "allow
   * everyone", so a deployment became an open beta by omission — the one way that decision should
   * never be made. Opening up is now a thing somebody writes down.
   */
  ACCESS_MODE: z.enum(['GATED', 'OPEN_BETA']).default('GATED'),
  ADMIN_EMAILS: z.string().optional(),
  /**
   * Shown on the public landing page as the way to reach a human. Unset by default: a page that
   * publishes an address nobody reads is worse than a page that offers only the form.
   */
  CONTACT_EMAIL: z.string().email().optional(),
  /**
   * Where consequential events are announced: a schedule that paused itself, a run that ended
   * badly, somebody asking for access. Any endpoint that accepts a JSON POST — a Slack or Teams
   * incoming webhook, a queue, a function. Unset means those events are recorded and not announced,
   * which is right for a demo and wrong for a deployment with users on it.
   */
  ALERT_WEBHOOK_URL: z.string().url().optional(),

  DATAVERSE_DISCOVERY_URL: z.string().url().default('https://globaldisco.crm.dynamics.com'),
  /**
   * Reading files from OneDrive and SharePoint, and SharePoint lists.
   *
   * Off by default on purpose: switching it on adds Files.Read.All and Sites.Read.All to what every
   * user is asked to consent to at sign-in. That is a decision for whoever runs the tenant, not a
   * default — and a deployment that does not use it should never ask.
   */
  // `bool`, not `z.coerce.boolean()`: coercion is `Boolean(String)`, so the string "false" is
  // truthy and MICROSOFT_FILES_ENABLED=false would have switched the feature ON — adding
  // Files.Read.All and Sites.Read.All to what every user in the tenant is asked to consent to.
  MICROSOFT_FILES_ENABLED: bool(false),
  DATAVERSE_API_VERSION: z.string().default('v9.2'),
  POWER_PLATFORM_ENRICHMENT: bool(false),
  ALLOW_BUSINESS_LOGIC_BYPASS: bool(false),
  /**
   * Certification safety switch: allow every read against a real tenant, block every write.
   * Enforced server-side in the Dataverse client, not just in the UI.
   */
  REAL_TENANT_READ_ONLY: bool(false),

  RUN_WORKER: bool(true),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  /** How often the worker looks for a migration schedule that is due. */
  SCHEDULER_POLL_MS: z.coerce.number().int().positive().default(30_000),
});

export type AppConfig = z.infer<typeof schema> & {
  sessionSecret: string;
  microsoftEnabled: boolean;
  redirectUri: string;
  allowedTenantIds: string[];
  adminEmails: string[];
};

function resolveSessionSecret(raw: z.infer<typeof schema>): string {
  if (raw.SESSION_SECRET) {
    if (raw.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    return raw.SESSION_SECRET;
  }
  if (raw.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required in production');
  if (raw.NODE_ENV === 'test') return 'test-only-session-secret-0123456789abcdef';
  // Development convenience: persist a random secret locally so sessions and the encrypted
  // token cache survive restarts. The .data directory is git-ignored.
  const file = path.resolve('.data', 'dev-session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  const raw = schema.parse({ ...process.env, ...overrides });
  const microsoftEnabled = Boolean(raw.ENTRA_CLIENT_ID && raw.ENTRA_CLIENT_SECRET);
  const list = (v?: string) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const cfg: AppConfig = {
    ...raw,
    sessionSecret: resolveSessionSecret(raw),
    microsoftEnabled,
    redirectUri: raw.ENTRA_REDIRECT_URI ?? `${raw.APP_BASE_URL.replace(/\/$/, '')}/api/auth/callback`,
    allowedTenantIds: list(raw.ALLOWED_TENANT_IDS),
    adminEmails: list(raw.ADMIN_EMAILS),
  };
  if (!cfg.microsoftEnabled && !cfg.DEMO_MODE) {
    throw new Error(
      'No sign-in method is configured. Set ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET, or DEMO_MODE=true for local demos.',
    );
  }
  return cfg;
}
