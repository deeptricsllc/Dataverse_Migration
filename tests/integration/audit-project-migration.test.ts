import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { createDatabase, type Database } from '../../server/src/db/client';
import { organizations } from '../../server/src/db/schema';

/**
 * `0029_audit_project.sql`, run against a database that already holds an audit trail.
 *
 * The rule this follows was written after `0025` took QA down: a migration is only as safe as its
 * behaviour against the data that already exists. The audit trail is the worst possible table to get this
 * wrong on — it is the one part of the product whose whole value is that it has not been edited.
 *
 * The assertion that matters is that existing events come back **null**, not backfilled. An event recorded
 * before this column existed genuinely did not record a project, and inferring one afterwards by joining
 * through a plan that may since have been reconfigured would put a guess in the one place in the product
 * that is supposed to contain only what was observed.
 */

type Row = Record<string, unknown>;
const rowsOf = async (db: Database, query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.db.execute(query)) as unknown as { rows: Row[] }).rows;

describe('adding the project column to a database that already has an audit trail', () => {
  let database: Database | null = null;

  afterEach(async () => {
    await database?.close();
    database = null;
  });

  const applyMigration = async (db: Database) => {
    const sqlText = readFileSync('server/drizzle/0029_audit_project.sql', 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.db.execute(sql.raw(statement));
    }
  };

  /** A workspace with history, as it was before the column existed. */
  const trailBeforeTheColumn = async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    await db.migrate('server/drizzle');
    await db.db.execute(sql`DROP INDEX IF EXISTS "audit_events_project_idx"`);
    await db.db.execute(sql`ALTER TABLE "audit_events" DROP COLUMN IF EXISTS "project_id"`);

    const [org] = await db.db.insert(organizations).values({ name: 'Workspace with history' }).returning();
    for (const action of ['MIGRATION_PLAN_CREATED', 'MIGRATION_EXECUTION_REQUESTED', 'CONNECTION_CREATED']) {
      await db.db.execute(
        sql`INSERT INTO "audit_events" ("organization_id", "action", "outcome")
            VALUES (${org!.id}, ${action}, 'SUCCESS')`,
      );
    }
    return db;
  };

  it('adds the column and leaves every existing entry exactly as it was', async () => {
    database = await trailBeforeTheColumn();
    const before = await rowsOf(database, sql`SELECT count(*)::int AS n FROM "audit_events"`);
    expect(before[0]!.n).toBe(3);

    await applyMigration(database);

    const after = await rowsOf(database, sql`SELECT "action", "project_id" FROM "audit_events"`);
    expect(after, 'nothing was dropped').toHaveLength(3);
    /*
     * Null, not a guess. The trail's value is that it records what was observed; an entry that names a
     * project nobody recorded at the time is worse than one that admits it does not know.
     */
    for (const row of after) expect(row.project_id).toBeNull();
  });

  it('is safe to run twice, which is what a retried deployment does', async () => {
    database = await trailBeforeTheColumn();
    await applyMigration(database);
    await expect(applyMigration(database)).resolves.not.toThrow();
    const rows = await rowsOf(database, sql`SELECT "project_id" FROM "audit_events"`);
    expect(rows).toHaveLength(3);
  });

  it('leaves the application able to start', async () => {
    database = await trailBeforeTheColumn();
    await applyMigration(database);
    await expect(database.migrate('server/drizzle')).resolves.not.toThrow();
  });
});
