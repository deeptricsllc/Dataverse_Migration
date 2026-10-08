import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { createDatabase, type Database } from '../../server/src/db/client';

/**
 * `0032_demo_setup_status.sql`, against databases that already have organizations in them.
 *
 * The rule this follows was written after `0025` took QA down: a migration is only as safe as its
 * behaviour against the data that is already there. This one adds a status to every organization,
 * including the ones that are not demos and will never have a value for it.
 *
 * The assertion that matters is that nothing is backfilled. A demo workspace built before this column
 * existed has its worked examples and no recorded status, and the product reads it as ready because the
 * examples are there. Writing `READY` onto it would be recording something nobody observed; writing
 * `PENDING` would be telling a working workspace it had not started.
 */

type Row = Record<string, unknown>;
const rowsOf = async (db: Database, query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.db.execute(query)) as unknown as { rows: Row[] }).rows;

describe('adding the demo setup status to a database that already holds organizations', () => {
  let database: Database | null = null;

  afterEach(async () => {
    await database?.close();
    database = null;
  });

  const apply = async (db: Database) => {
    const sqlText = readFileSync('server/drizzle/0032_demo_setup_status.sql', 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.db.execute(sql.raw(statement));
    }
  };

  /** A deployment as it was before the column: a real tenant, and a demo workspace already built. */
  const before = async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    await db.migrate('server/drizzle');
    for (const column of [
      'demo_setup_status',
      'demo_setup_detail',
      'demo_setup_attempts',
      'demo_setup_updated_at',
    ]) {
      await db.db.execute(sql.raw(`ALTER TABLE "organizations" DROP COLUMN IF EXISTS "${column}"`));
    }
    await db.db.execute(
      sql`INSERT INTO "organizations" ("name", "is_demo") VALUES ('Contoso', false), ('Demo workspace AB12', true)`,
    );
    return db;
  };

  it('adds the columns and leaves every organization as it was', async () => {
    database = await before();
    const countBefore = await rowsOf(database, sql`SELECT count(*)::int AS n FROM "organizations"`);
    expect(countBefore[0]!.n).toBe(2);

    await apply(database);

    const after = await rowsOf(
      database,
      sql`SELECT "name", "is_demo", "demo_setup_status", "demo_setup_detail", "demo_setup_attempts"
          FROM "organizations" ORDER BY "name"`,
    );
    expect(after, 'nothing was dropped').toHaveLength(2);
    for (const row of after) {
      /*
       * Null, for the real tenant and for the demo workspace alike. The demo one has its examples and
       * the product reads it as ready from the examples themselves; recording a status for a build
       * nobody watched would be inventing the one thing this column exists to stop inventing.
       */
      expect(row.demo_setup_status, `${String(row.name)} has no invented status`).toBeNull();
      expect(row.demo_setup_detail).toBeNull();
      // A count, so zero is the truthful starting value rather than an absence.
      expect(row.demo_setup_attempts).toBe(0);
    }
  });

  /** A deployment that retries a migration must not fail the second time. */
  it('can be applied twice without failing', async () => {
    database = await before();
    await apply(database);
    await apply(database);
    const after = await rowsOf(database, sql`SELECT count(*)::int AS n FROM "organizations"`);
    expect(after[0]!.n).toBe(2);
  });

  /** And on a clean install, where the columns are already there, it is a no-op rather than an error. */
  it('is a no-op on a database that already has the columns', async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    database = db;
    await db.migrate('server/drizzle');
    await apply(db);
    const columns = await rowsOf(
      db,
      sql`SELECT "column_name" FROM "information_schema"."columns"
          WHERE "table_name" = 'organizations' AND "column_name" LIKE 'demo_setup%'
          ORDER BY "column_name"`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      'demo_setup_attempts',
      'demo_setup_detail',
      'demo_setup_status',
      'demo_setup_updated_at',
    ]);
  });
});
