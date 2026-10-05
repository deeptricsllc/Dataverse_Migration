import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { createDatabase, type Database } from '../../server/src/db/client';
import { organizations, projects } from '../../server/src/db/schema';

/**
 * The migration that adds the unique project-name index, run against a database that already has duplicates.
 *
 * This is the case that took QA down. `0025_unique_project_names.sql` created the index on a database that
 * already contained two projects called `Test_Analysis` — which is the exact ambiguity it was written to
 * prevent — so `CREATE UNIQUE INDEX` failed, the migration aborted inside its transaction, and the
 * application crash-looped on startup behind a 502.
 *
 * It passed every test and every local run because every one of those started from an empty database.
 * A constraint is only as safe as its behaviour against the data that already exists, and "it works on a
 * fresh schema" is not that. So this test builds the state QA was actually in, runs the migrations over
 * it, and checks both that the application can start and that nobody's work was thrown away to achieve it.
 */

/** `execute` is untyped across drivers; naming the shape once keeps the assertions readable. */
type Row = Record<string, unknown>;
const rowsOf = async (db: Database, query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.db.execute(query)) as unknown as { rows: Row[] }).rows;

describe('adding the unique project-name index to a database that already has duplicates', () => {
  let database: Database | null = null;

  afterEach(async () => {
    await database?.close();
    database = null;
  });

  /**
   * The migration's own SQL, read from disk and run statement by statement.
   *
   * Deliberately not "re-run the migrator": drizzle records what it has applied, so persuading it to
   * replay one file means fighting its journal, and a test that fights its own tooling ends up asserting
   * about the tooling. This executes the exact file that shipped, against the exact state QA was in.
   */
  const applyMigration = async (db: Database) => {
    const sqlText = readFileSync('server/drizzle/0025_unique_project_names.sql', 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.db.execute(sql.raw(statement));
    }
  };

  /** A `projects` table with duplicate active names and no index, which is where QA was. */
  const databaseWithDuplicates = async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    await db.migrate('server/drizzle');
    await db.db.execute(sql`DROP INDEX IF EXISTS "projects_org_active_name_unique"`);

    const [org] = await db.db.insert(organizations).values({ name: 'Workspace with duplicates' }).returning();
    const made: { id: string; name: string }[] = [];
    // Three with the same name, one differing only in case, and one archived — every shape the rule meets.
    for (const [index, name] of ['Test_Analysis', 'Test_Analysis', 'test_analysis'].entries()) {
      const [row] = await db.db
        .insert(projects)
        .values({
          organizationId: org!.id,
          name,
          kind: 'ANALYSIS',
          status: 'ACTIVE',
          createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        })
        .returning();
      made.push({ id: row!.id, name: row!.name });
    }
    const [archived] = await db.db
      .insert(projects)
      .values({ organizationId: org!.id, name: 'Test_Analysis', kind: 'ANALYSIS', status: 'ARCHIVED' })
      .returning();
    const [untouched] = await db.db
      .insert(projects)
      .values({ organizationId: org!.id, name: 'Customer Migration', kind: 'ANALYSIS', status: 'ACTIVE' })
      .returning();
    return { db, organizationId: org!.id, made, archived: archived!, untouched: untouched! };
  };

  it('completes instead of failing, so the application can start', async () => {
    const built = await databaseWithDuplicates();
    database = built.db;
    // This is the assertion the outage was: the migration must not throw.
    await expect(applyMigration(built.db)).resolves.toBeUndefined();

    const index = await rowsOf(
      built.db,
      sql`SELECT indexname FROM pg_indexes WHERE indexname = 'projects_org_active_name_unique'`,
    );
    expect(index, 'the index exists afterwards').toHaveLength(1);
  });

  it('keeps every project, renaming the later ones rather than deleting or archiving them', async () => {
    const built = await databaseWithDuplicates();
    database = built.db;
    await applyMigration(built.db);

    const rows = await rowsOf(
      built.db,
      sql`SELECT id, name, status FROM projects WHERE organization_id = ${built.organizationId} ORDER BY created_at`,
    );
    expect(rows, 'nothing was deleted').toHaveLength(5);

    const byId = new Map(rows.map((r) => [String(r.id), r]));
    // The oldest keeps the name it had; a workspace should not find its original project renamed.
    expect(String(byId.get(built.made[0]!.id)!.name)).toBe('Test_Analysis');
    // The later ones are disambiguated, visibly, with their own id so two cannot collide.
    for (const later of built.made.slice(1)) {
      const name = String(byId.get(later.id)!.name);
      expect(name).not.toBe(later.name);
      expect(name).toContain(later.id.slice(0, 8));
      expect(name.startsWith(later.name), 'the original name is still readable').toBe(true);
    }
    // Everything still ACTIVE: renaming is the whole intervention.
    expect(rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(4);
  });

  it('leaves an archived clash and an unrelated project alone', async () => {
    const built = await databaseWithDuplicates();
    database = built.db;
    await applyMigration(built.db);

    const rows = await rowsOf(
      built.db,
      sql`SELECT id, name FROM projects WHERE id IN (${built.archived.id}, ${built.untouched.id})`,
    );
    const byId = new Map(rows.map((r) => [String(r.id), String(r.name)]));
    // The index only covers ACTIVE, so an archived project keeps its name even though it clashes.
    expect(byId.get(built.archived.id)).toBe('Test_Analysis');
    expect(byId.get(built.untouched.id)).toBe('Customer Migration');
  });

  it('enforces the rule from then on', async () => {
    const built = await databaseWithDuplicates();
    database = built.db;
    await applyMigration(built.db);

    await expect(
      built.db.db
        .insert(projects)
        .values({ organizationId: built.organizationId, name: 'Customer Migration', kind: 'ANALYSIS' }),
    ).rejects.toThrow();
  });

  it('is a no-op on a database that has no duplicates', async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    database = db;
    await db.migrate('server/drizzle');
    const [org] = await db.db.insert(organizations).values({ name: 'Clean workspace' }).returning();
    const [project] = await db.db
      .insert(projects)
      .values({ organizationId: org!.id, name: 'Customer Migration', kind: 'ANALYSIS' })
      .returning();

    // Applying it again must not rename anything: a migration's hash changes when it is edited, so
    // drizzle will re-run this one, and it now edits rows.
    await applyMigration(db);
    const rows = await rowsOf(db, sql`SELECT name FROM projects WHERE id = ${project!.id}`);
    expect(String(rows[0]!.name)).toBe('Customer Migration');
  });
});
