import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { createDatabase, type Database } from '../../server/src/db/client';
import { organizations } from '../../server/src/db/schema';

/**
 * `0030_deferred_incomplete.sql` and `0031_error_attempt.sql`, against a database that already holds runs.
 *
 * The rule this follows was written after `0025` took QA down: a migration is only as safe as its behaviour
 * against the data that is already there. These two add columns to the tables that hold the evidence of
 * every migration a customer has run, so the question is not whether they apply — it is what the existing
 * rows say afterwards.
 *
 * The answer has to be **null or zero meaning "not recorded"**, never a backfilled guess. A historical run
 * genuinely did not record which attempt found a failure, and inferring one — they all look like attempt 1 —
 * would put a fabrication in the one view somebody opens to see what changed between attempts.
 */

type Row = Record<string, unknown>;
const rowsOf = async (db: Database, query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.db.execute(query)) as unknown as { rows: Row[] }).rows;

describe('adding the outcome columns to a database that already holds migration evidence', () => {
  let database: Database | null = null;

  afterEach(async () => {
    await database?.close();
    database = null;
  });

  const apply = async (db: Database, file: string) => {
    const sqlText = readFileSync(`server/drizzle/${file}`, 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.db.execute(sql.raw(statement));
    }
  };

  /** A workspace whose runs finished before either column existed. */
  const evidenceBeforeTheColumns = async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    await db.migrate('server/drizzle');
    // Wind the schema back to what it was, including the indexes, so the migrations run as they will in QA.
    await db.db.execute(sql`DROP INDEX IF EXISTS "migration_errors_attempt_idx"`);
    await db.db.execute(sql`DROP INDEX IF EXISTS "migration_errors_code_idx"`);
    await db.db.execute(sql`ALTER TABLE "migration_errors" DROP COLUMN IF EXISTS "run_attempt"`);
    await db.db.execute(
      sql`ALTER TABLE "migration_run_entities" DROP COLUMN IF EXISTS "deferred_incomplete"`,
    );

    const [org] = await db.db.insert(organizations).values({ name: 'Workspace with runs' }).returning();
    const [env] = await rowsOf(
      db,
      sql`INSERT INTO "environments" ("organization_id", "display_name", "url", "provider", "connection_type")
          VALUES (${org!.id}, 'Historic target', 'https://historic.example.invalid', 'DEMO', 'DATAVERSE')
          RETURNING "id"`,
    );
    const [plan] = await rowsOf(
      db,
      sql`INSERT INTO "migration_plans" ("organization_id", "name", "source_environment_id", "target_environment_id", "options")
          VALUES (${org!.id}, 'A migration from before', ${env!.id}, ${env!.id}, '{}'::jsonb) RETURNING "id"`,
    );
    const [run] = await rowsOf(
      db,
      sql`INSERT INTO "migration_runs"
            ("organization_id", "plan_id", "source_environment_id", "target_environment_id",
             "status", "options", "plan_snapshot", "total", "processed", "created", "failed")
          VALUES (${org!.id}, ${plan!.id}, ${env!.id}, ${env!.id},
                  'COMPLETED', '{}'::jsonb, '{"entities":[]}'::jsonb, 300, 300, 300, 0)
          RETURNING "id"`,
    );
    await db.db.execute(
      sql`INSERT INTO "migration_run_entities" ("run_id", "logical_name", "display_name", "order_index", "status", "total", "processed", "created", "deferred_resolved")
          VALUES (${run!.id}, 'contact', 'Contacts', 0, 'COMPLETED', 300, 300, 300, 270)`,
    );
    for (let i = 0; i < 3; i++) {
      await db.db.execute(
        sql`INSERT INTO "migration_errors" ("run_id", "logical_name", "source_record_id", "operation", "severity", "error_code", "message", "retryable")
            VALUES (${run!.id}, 'contact', ${`historic-${i}`}, 'CREATE', 'WARNING', 'LOOKUP_UNRESOLVED', 'Recorded before the attempt was', true)`,
      );
    }
    return { db, runId: String(run!.id) };
  };

  it('adds both columns and leaves every existing row as it was', async () => {
    const { db, runId } = await evidenceBeforeTheColumns();
    database = db;

    const errorsBefore = await rowsOf(db, sql`SELECT count(*)::int AS n FROM "migration_errors"`);
    expect(errorsBefore[0]!.n).toBe(3);

    await apply(db, '0030_deferred_incomplete.sql');
    await apply(db, '0031_error_attempt.sql');

    const errors = await rowsOf(
      db,
      sql`SELECT "source_record_id", "run_attempt", "error_code" FROM "migration_errors" ORDER BY "source_record_id"`,
    );
    expect(errors, 'nothing was dropped').toHaveLength(3);
    /*
     * Null, not attempt 1. A failure recorded before the attempt was recorded belongs to an attempt nobody
     * wrote down, and the attempt history reads `Not recorded` for it — which is the truth, and is also what
     * stops somebody comparing two attempts against a column that was invented for one of them.
     */
    for (const row of errors) expect(row.run_attempt).toBeNull();

    const entities = await rowsOf(
      db,
      sql`SELECT "logical_name", "deferred_resolved", "deferred_incomplete" FROM "migration_run_entities"`,
    );
    expect(entities).toHaveLength(1);
    /*
     * Zero, and the product does not read it as "none omitted". The 270 deferred references this dataset
     * recorded as resolved were resolved under the old meaning of that word, which did not distinguish a
     * reference that was set from one that was dropped — so re-stating them as incomplete now would be
     * claiming something about a migration that was signed off months ago. The warnings the engine recorded
     * at the time are what the failure summary reads, and they are still there.
     */
    expect(entities[0]!.deferred_incomplete).toBe(0);
    expect(entities[0]!.deferred_resolved, 'and what it did record is untouched').toBe(270);

    // The run itself is not restated either.
    const runs = await rowsOf(db, sql`SELECT "status", "failed" FROM "migration_runs"`);
    expect(runs[0]!.status, 'a historical outcome is never recomputed').toBe('COMPLETED');
    expect(runs[0]!.failed).toBe(0);
    expect(runId).toBeTruthy();
  });

  /** Applied twice, because a deployment that retries a migration must not fail the second time. */
  it('can be applied twice without failing', async () => {
    const { db } = await evidenceBeforeTheColumns();
    database = db;
    await apply(db, '0030_deferred_incomplete.sql');
    await apply(db, '0031_error_attempt.sql');
    await apply(db, '0030_deferred_incomplete.sql');
    await apply(db, '0031_error_attempt.sql');
    const errors = await rowsOf(db, sql`SELECT count(*)::int AS n FROM "migration_errors"`);
    expect(errors[0]!.n).toBe(3);
  });

  /**
   * And against a database where the columns are already present, which is the state a clean install is in.
   *
   * The journal is the thing that decides whether a migration runs, and a clean install has these applied
   * already. Running them again has to be a no-op rather than an error, or the first deployment after this
   * change would fail on the databases that least need it.
   */
  it('is a no-op on a database that already has them', async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    database = db;
    await db.migrate('server/drizzle');
    await apply(db, '0030_deferred_incomplete.sql');
    await apply(db, '0031_error_attempt.sql');
    const columns = await rowsOf(
      db,
      sql`SELECT "column_name" FROM "information_schema"."columns"
          WHERE "table_name" = 'migration_errors' AND "column_name" = 'run_attempt'`,
    );
    expect(columns).toHaveLength(1);
  });
});
