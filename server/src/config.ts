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

  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_TENANT_ID: z.string().default('organizations'),
  ENTRA_AUTHORITY_HOST: z.string().url().default('https://login.microsoftonline.com'),
  ENTRA_REDIRECT_URI: z.string().url().optional(),
  ALLOWED_TENANT_IDS: z.string().optional(),
  ADMIN_EMAILS: z.string().optional(),

  DATAVERSE_DISCOVERY_URL: z.string().url().default('https://globaldisco.crm.dynamics.com'),
  DATAVERSE_API_VERSION: z.string().default('v9.2'),
  POWER_PLATFORM_ENRICHMENT: bool(false),
  ALLOW_BUSINESS_LOGIC_BYPASS: bool(false),

  RUN_WORKER: bool(true),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
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
