import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../server/src/db/client';

/**
 * `0033_comparison_rules.sql`, against a database that already holds validation results.
 *
 * The rule this follows was written after `0025` took QA down: a migration is only as safe as its
 * behaviour against the data that is already there. This one adds the comparison rules to every
 * dataset result, including the ones produced before the platform recorded them.
 *
 * The assertion that matters is that nothing is backfilled. A report written before this column
 * existed was produced under rules nobody wrote down, and writing today's rules onto it would make
 * an old finding look as though it had been compared under rules that did not exist when it ran —
 * which is the one thing a report somebody signed must never do. Those reports read
 * `Comparison rules not recorded`, and that is the truthful answer.
 */

type Row = Record<string, unknown>;
const rowsOf = async (db: Database, query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.db.execute(query)) as unknown as { rows: Row[] }).rows;

describe('adding the comparison rules to a database that already holds validation results', () => {
  let database: Database | null = null;

  afterEach(async () => {
    await database?.close();
    database = null;
  });

  const apply = async (db: Database) => {
    const sqlText = readFileSync('server/drizzle/0033_comparison_rules.sql', 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.db.execute(sql.raw(statement));
    }
  };

  /** A deployment as it was before the column, with one validation result already recorded. */
  const before = async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    await db.migrate('server/drizzle');
    await db.db.execute(
      sql.raw(`ALTER TABLE "validation_entity_results" DROP COLUMN IF EXISTS "comparison_rules"`),
    );
    const [org] = await rowsOf(
      db,
      sql`INSERT INTO "organizations" ("name", "is_demo") VALUES ('Contoso', false) RETURNING "id"`,
    );
    const env = async (name: string) => {
      const [row] = await rowsOf(
        db,
        sql`INSERT INTO "environments" ("organization_id", "provider", "display_name", "url")
            VALUES (${org!.id}, 'demo', ${name}, ${`https://${name}.example.test`})
            RETURNING "id"`,
      );
      return row!.id as string;
    };
    const sourceId = await env('source');
    const targetId = await env('target');
    const [vr] = await rowsOf(
      db,
      sql`INSERT INTO "validation_runs"
            ("organization_id", "source_environment_id", "target_environment_id", "tables", "status", "outcome")
          VALUES (${org!.id}, ${sourceId}, ${targetId}, '["account"]'::jsonb, 'COMPLETED', 'PASS')
          RETURNING "id"`,
    );
    await db.db.execute(
      sql`INSERT INTO "validation_entity_results"
            ("validation_run_id", "logical_name", "display_name", "outcome", "matched", "checks")
          VALUES (${vr!.id}, 'account', 'Account', 'PASS', 12, '[]'::jsonb)`,
    );
    return db;
  };

  it('adds the column and records no rules for a result that predates it', async () => {
    database = await before();
    await apply(database);

    const after = await rowsOf(
      database,
      sql`SELECT "logical_name", "outcome", "matched", "comparison_rules"
          FROM "validation_entity_results"`,
    );
    expect(after, 'nothing was dropped').toHaveLength(1);
    expect(after[0]!.matched, 'and the finding is unchanged').toBe(12);
    /*
     * Null. An older report was compared under rules nobody recorded, and the report says so rather
     * than showing the rules as they stand today — which is §10 of docs/VALIDATION_SEMANTICS.md.
     */
    expect(after[0]!.comparison_rules, 'no rules were invented for it').toBeNull();
  });

  /** A deployment that retries a migration must not fail the second time. */
  it('can be applied twice without failing', async () => {
    database = await before();
    await apply(database);
    await apply(database);
    const after = await rowsOf(database, sql`SELECT count(*)::int AS n FROM "validation_entity_results"`);
    expect(after[0]!.n).toBe(1);
  });

  /** And on a clean install, where the column is already there, it is a no-op rather than an error. */
  it('is a no-op on a database that already has the column', async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    database = db;
    await db.migrate('server/drizzle');
    await apply(db);
    const columns = await rowsOf(
      db,
      sql`SELECT "column_name", "data_type" FROM "information_schema"."columns"
          WHERE "table_name" = 'validation_entity_results' AND "column_name" = 'comparison_rules'`,
    );
    expect(columns).toHaveLength(1);
    expect(columns[0]!.data_type).toBe('jsonb');
  });
});
