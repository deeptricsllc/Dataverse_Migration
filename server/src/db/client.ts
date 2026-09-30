import fs from 'node:fs';
import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: AppDb;
  kind: 'postgres' | 'pglite';
  migrate(migrationsDir: string): Promise<void>;
  close(): Promise<void>;
}

/** Errors that mean "the database is not there yet" rather than "the database said no". */
const TRANSIENT_CODES = new Set([
  'EAI_AGAIN', // DNS not answering yet
  'ENOTFOUND', // the name does not resolve yet
  'ECONNREFUSED', // nothing listening yet
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P03', // PostgreSQL: the server is starting up
]);

/** The codes on an error and everything it was caused by, because drivers wrap. */
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

export function isDatabaseUnreachable(error: unknown): boolean {
  return errorCodes(error).some((code) => TRANSIENT_CODES.has(code));
}

/**
 * Applies the migrations, waiting for the database to exist rather than exiting the moment it does
 * not answer.
 *
 * A container often starts before the database's name resolves. Exiting turned that into minutes of
 * refused requests on every deploy, while the platform restarted the process until DNS caught up —
 * the app was the only thing in a hurry. Only the errors that mean "not yet" are waited out; a
 * rejected password or a migration that does not apply still fails at once, because no amount of
 * waiting would change either.
 */
export async function migrateWhenReachable(
  database: Pick<Database, 'migrate'>,
  migrationsDir: string,
  opts: {
    /** How long to keep waiting before giving up and letting the error through. */
    waitMs?: number;
    baseDelayMs?: number;
    onWait?: (info: { attempt: number; delayMs: number; waitedMs: number; codes: string[] }) => void;
  } = {},
): Promise<void> {
  const waitMs = opts.waitMs ?? 60_000;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await database.migrate(migrationsDir);
      return;
    } catch (error) {
      const waitedMs = Date.now() - startedAt;
      if (!isDatabaseUnreachable(error) || waitedMs >= waitMs) throw error;
      const delayMs = Math.min(5_000, baseDelayMs * 2 ** (attempt - 1));
      opts.onWait?.({ attempt, delayMs, waitedMs, codes: errorCodes(error) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Creates the database connection.
 *  - DATABASE_URL set: PostgreSQL via node-postgres (production).
 *  - otherwise: embedded PGlite (PostgreSQL compiled to WASM) persisted to PGLITE_DATA_DIR,
 *    or in-memory when the directory is 'memory://'. Same schema and SQL migrations as production.
 */
export async function createDatabase(opts: {
  databaseUrl?: string;
  pgliteDataDir: string;
  /** Called when a pooled connection fails while idle. Nothing is thrown at the caller. */
  onPoolError?: (error: unknown) => void;
}): Promise<Database> {
  if (opts.databaseUrl) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: opts.databaseUrl, max: 10 });
    // An idle connection dropped by the database emits 'error' on the pool, and an unhandled one
    // takes the process down. The pool replaces the connection by itself; it only needs to be told
    // that somebody is listening. Reported so a recurring drop is visible rather than silent.
    pool.on('error', (error) => opts.onPoolError?.(error));
    const db = drizzle(pool, { schema });
    return {
      db: db as unknown as AppDb,
      kind: 'postgres',
      migrate: (dir) => migrate(db, { migrationsFolder: path.resolve(dir) }),
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const inMemory = opts.pgliteDataDir.startsWith('memory://');
  if (!inMemory) fs.mkdirSync(path.resolve(opts.pgliteDataDir), { recursive: true });
  const client = inMemory ? new PGlite() : new PGlite(path.resolve(opts.pgliteDataDir));
  await client.waitReady;
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as AppDb,
    kind: 'pglite',
    migrate: (dir) => migrate(db, { migrationsFolder: path.resolve(dir) }),
    close: () => client.close(),
  };
}
