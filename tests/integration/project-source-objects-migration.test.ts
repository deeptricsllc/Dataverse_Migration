import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { createDatabase, type Database } from '../../server/src/db/client';
import { environments, organizations, projects } from '../../server/src/db/schema';

/**
 * `0028_project_source_objects.sql`, run against a database that already has projects in it.
 *
 * The rule this follows was written after `0025` took QA down: a migration is only as safe as its
 * behaviour against the data that already exists, and "it works on a fresh schema" is not that. So this
 * builds a database in the state a real workspace is in — projects with sources, analysed and not — runs
 * the migration file that shipped, and checks the two things that matter.
 *
 * The first is that nothing breaks. The second is subtler and is the one worth a test: a project created
 * before objects could be chosen means **everything in the connection**, and must go on meaning that. A
 * migration that defaulted the new column to an empty array would quietly narrow every existing project to
 * nothing, and the next analysis would find no data in a project that had been working for months.
 */

type Row = Record<string, unknown>;
const rowsOf = async (db: Database, query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.db.execute(query)) as unknown as { rows: Row[] }).rows;

describe('adding object selection to a database that already has projects', () => {
  let database: Database | null = null;

  afterEach(async () => {
    await database?.close();
    database = null;
  });

  /** The migration's own SQL, statement by statement, exactly as it shipped. */
  const applyMigration = async (db: Database) => {
    const sqlText = readFileSync('server/drizzle/0028_project_source_objects.sql', 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.db.execute(sql.raw(statement));
    }
  };

  /** A workspace that predates the column: projects with sources, and no selection anywhere. */
  const workspaceBeforeTheColumn = async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    await db.migrate('server/drizzle');
    // Back to where an existing deployment was: the column did not exist.
    await db.db.execute(sql`ALTER TABLE "project_sources" DROP COLUMN IF EXISTS "selected_objects"`);

    const [org] = await db.db.insert(organizations).values({ name: 'Established workspace' }).returning();
    const [connection] = await db.db
      .insert(environments)
      .values({
        organizationId: org!.id,
        provider: 'demosql',
        connectionType: 'SQL_SERVER',
        displayName: 'Legacy Finance',
        url: 'sqlserver://sql01.example/Finance',
        uniqueName: 'Finance',
      })
      .returning();

    for (const name of ['Customer modernization', 'Finance review']) {
      const [project] = await db.db
        .insert(projects)
        .values({ organizationId: org!.id, name, kind: 'ANALYSIS', sourceEnvironmentId: connection!.id })
        .returning();
      /*
       * Raw SQL on purpose. The typed insert names every column the current schema declares, including the
       * one this database does not have yet — so building "the state before the migration" has to be
       * written the way that database would have accepted it.
       */
      await db.db.execute(
        sql`INSERT INTO "project_sources" ("project_id", "environment_id", "position")
            VALUES (${project!.id}, ${connection!.id}, 0)`,
      );
    }
    return db;
  };

  it('adds the column without disturbing the rows that are already there', async () => {
    database = await workspaceBeforeTheColumn();
    const before = await rowsOf(database, sql`SELECT count(*)::int AS n FROM "project_sources"`);
    expect(before[0]!.n).toBe(2);

    await applyMigration(database);

    const after = await rowsOf(
      database,
      sql`SELECT "project_id", "selected_objects" FROM "project_sources" ORDER BY "project_id"`,
    );
    expect(after, 'no listing was lost').toHaveLength(2);
    /*
     * Null, not an empty array. The whole upgrade turns on this distinction: null means "everything in the
     * connection", which is what these projects have always meant, and an empty array would mean "nothing
     * chosen" — the same rows, silently narrowed to no data at all.
     */
    for (const row of after) expect(row.selected_objects).toBeNull();
  });

  it('is safe to run twice, which is what a retried deployment does', async () => {
    database = await workspaceBeforeTheColumn();
    await applyMigration(database);
    await expect(applyMigration(database)).resolves.not.toThrow();

    const rows = await rowsOf(database, sql`SELECT "selected_objects" FROM "project_sources"`);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.selected_objects).toBeNull();
  });

  it('accepts a selection once the column exists, and keeps the order given', async () => {
    database = await workspaceBeforeTheColumn();
    await applyMigration(database);

    const [existing] = await rowsOf(database, sql`SELECT "id" FROM "project_sources" LIMIT 1`);
    await database.db.execute(
      sql`UPDATE "project_sources" SET "selected_objects" = ARRAY['dbo.Customer','config.Region'] WHERE "id" = ${existing!.id}`,
    );

    const [updated] = await rowsOf(
      database,
      sql`SELECT "selected_objects" FROM "project_sources" WHERE "id" = ${existing!.id}`,
    );
    expect(updated!.selected_objects).toEqual(['dbo.Customer', 'config.Region']);
  });

  it('leaves the application able to start, which is the failure that made this rule', async () => {
    database = await workspaceBeforeTheColumn();
    await applyMigration(database);
    // The migrator runs over the same database the way a deployment does, and must complete.
    await expect(database.migrate('server/drizzle')).resolves.not.toThrow();
  });
});
