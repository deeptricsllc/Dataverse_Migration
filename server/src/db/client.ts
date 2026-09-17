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

/**
 * Creates the database connection.
 *  - DATABASE_URL set: PostgreSQL via node-postgres (production).
 *  - otherwise: embedded PGlite (PostgreSQL compiled to WASM) persisted to PGLITE_DATA_DIR,
 *    or in-memory when the directory is 'memory://'. Same schema and SQL migrations as production.
 */
export async function createDatabase(opts: {
  databaseUrl?: string;
  pgliteDataDir: string;
}): Promise<Database> {
  if (opts.databaseUrl) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: opts.databaseUrl, max: 10 });
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
