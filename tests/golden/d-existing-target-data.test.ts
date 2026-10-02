import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ConflictStrategy, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { accountedFor, writtenByRun } from '../../shared/run-metrics';
import { demoRecords } from '../../server/src/db/schema';
import {
  createPlan,
  envKeyOf,
  execute,
  keyCensus,
  lineage,
  openJourney,
  targetRows,
  validate,
  type Journey,
} from './journey';

/**
 * Golden Journey D — a target that already holds data.
 *
 * The four outcomes a migration can reach on a record, each caused deliberately, with the target
 * counted directly after every one. This is the journey that catches the most expensive kind of
 * mistake, because every version of it looks like success: a run that re-creates records it already
 * migrated reports a large number of creations and nobody notices until the target holds two of
 * everything, and a run reporting "unchanged" for records it never looked at reports the same numbers
 * as one that checked them.
 *
 * Which outcome a matched record gets is the conflict strategy's decision, and the three that admit an
 * existing record mean three different amounts of work:
 *
 *   SKIP_EXISTING  (the default)  leaves it alone without comparing     -> SKIPPED
 *   UPSERT                        writes it without comparing           -> UPDATED
 *   SYNC                          compares, and writes only if it differs -> UNCHANGED or UPDATED
 *
 * That distinction is asserted here because it is easy to misread: **`UPSERT`'s update count is not
 * evidence that anything changed.** Only `SYNC` can tell you that, and a journey that treated the two
 * as interchangeable would be asserting that the option does nothing.
 */
describe('Golden Journey D: a target that already holds data', () => {
  let j: Journey;
  const TABLE = 'dtx_region';

  beforeAll(async () => {
    j = await openJourney();
  }, 180_000);
  afterAll(async () => {
    await j?.close();
  });

  it('creates, skips, upserts, compares and updates — with the target agreeing each time', async () => {
    const plan = await createPlan(j, {
      name: 'Golden D',
      source: j.dev,
      target: j.uat,
      tables: [TABLE],
    });
    const sourceCount = (await targetRows(j, j.dev, TABLE)).length;
    expect(sourceCount, 'the demo source has regions to migrate').toBeGreaterThan(0);

    /** Runs the plan under a strategy, after confirming the option really changed. */
    const runWith = async (strategy: ConflictStrategy): Promise<MigrationRunDto> => {
      await j.api.patch(`/api/plans/${plan.id}/options`, { conflictStrategy: strategy });
      const fresh = await j.api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
      expect(fresh.options.conflictStrategy, 'the option was actually applied').toBe(strategy);
      return execute(j, fresh);
    };

    /** The target, counted directly, with the duplicate check that counters cannot make. */
    const census = async () => {
      const rows = await targetRows(j, j.uat, TABLE);
      expect(keyCensus(rows, `${TABLE}id`).repeated, 'no identifier appears twice in the target').toEqual([]);
      return rows;
    };

    // --- 1. an empty target: everything is created --------------------------
    const created = await runWith('SKIP_EXISTING');
    expect(created.status).toBe('COMPLETED');
    expect(created.created, 'the first run creates every record').toBe(sourceCount);
    expect(created.updated + created.unchanged + created.skipped).toBe(0);
    expect((await census()).length, 'and the target holds exactly that many').toBe(sourceCount);

    // --- 2. the same plan again, default strategy: left alone ---------------
    const skipped = await runWith('SKIP_EXISTING');
    expect(skipped.skipped, 'the default strategy leaves existing records alone').toBe(sourceCount);
    expect(skipped.created, 'and above all creates nothing').toBe(0);
    expect(skipped.unchanged, 'skipped is not unchanged: nothing was compared').toBe(0);
    expect((await census()).length, 'the target did not grow').toBe(sourceCount);

    const skippedRows = await lineage(j, skipped.id);
    expect(new Set(skippedRows.map((r) => r.Outcome))).toEqual(new Set(['SKIPPED']));
    expect(
      new Set(skippedRows.map((r) => r['Matched by'])),
      'and says how each record was recognised',
    ).toEqual(new Set(['IDENTITY_MAP']));

    // --- 3. upsert: written again, without being compared ------------------
    const upserted = await runWith('UPSERT');
    expect(upserted.updated, 'upsert writes every matched record').toBe(sourceCount);
    expect(upserted.unchanged, 'because it does not compare, it can never report unchanged').toBe(0);
    expect(upserted.created).toBe(0);
    expect((await census()).length, 'writing them again created nothing new').toBe(sourceCount);

    // --- 4. sync: compared, and found identical ----------------------------
    const unchanged = await runWith('SYNC');
    expect(unchanged.unchanged, 'sync compares, and these are identical').toBe(sourceCount);
    expect(unchanged.updated, 'so nothing needed writing').toBe(0);
    expect(unchanged.created).toBe(0);
    expect(unchanged.skipped).toBe(0);
    const beforeEdit = await census();
    expect(beforeEdit.length).toBe(sourceCount);

    // --- 5. a target record changed behind the product's back --------------
    /**
     * Someone edited the target. Sync has to notice that one record and leave the others alone — a run
     * that reports every record as updated is as wrong as one that reports none.
     */
    const victim = beforeEdit[0]!;
    await j.t.services.db
      .update(demoRecords)
      .set({ data: { ...victim.data, dtx_name: 'Edited outside the migration' } })
      .where(
        and(
          eq(demoRecords.organizationId, j.organizationId),
          eq(demoRecords.environmentKey, envKeyOf(j.uat)),
          eq(demoRecords.logicalName, TABLE),
          eq(demoRecords.recordId, victim.recordId),
        ),
      );

    const repaired = await runWith('SYNC');
    expect(repaired.updated, 'exactly the one record that differed').toBe(1);
    expect(repaired.unchanged, 'and the rest untouched').toBe(sourceCount - 1);
    expect(repaired.created).toBe(0);

    // The update restored the source value rather than writing something else.
    const afterRepair = await census();
    const restored = afterRepair.find((r) => r.recordId === victim.recordId)!;
    expect(restored.data.dtx_name).toBe(victim.data.dtx_name);
    expect(afterRepair.length, 'and still no new rows').toBe(sourceCount);

    // Attribution: the lineage names which record was updated, not only how many.
    const updatedRows = (await lineage(j, repaired.id)).filter((r) => r.Outcome === 'UPDATED');
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]!['Source id'].toLowerCase()).toBe(victim.recordId.toLowerCase());
    expect(updatedRows[0]!['Matched by'], 'and says how it found the record').toBeTruthy();
    expect(updatedRows[0]!['Write state'], 'and that the write is accounted for').toBe('CONFIRMED');

    // --- the arithmetic, over every run ------------------------------------
    const runs = [created, skipped, upserted, unchanged, repaired];
    for (const run of runs) {
      expect(run.status, `${run.id}`).toBe('COMPLETED');
      expect(accountedFor(run), `${run.id}: every record accounted for exactly once`).toBe(run.total);
      expect(run.failed).toBe(0);
      expect(run.unresolved).toBe(0);

      const rowsForRun = await lineage(j, run.id);
      expect(rowsForRun.length, 'one lineage row per record').toBe(accountedFor(run));
      expect(new Set(rowsForRun.map((r) => r['Source id'])).size, 'no record listed twice').toBe(
        rowsForRun.length,
      );
    }

    // What each run actually wrote, which is the number that matters for accountability.
    expect(runs.map(writtenByRun), 'created / skipped / upserted / compared / repaired').toEqual([
      sourceCount,
      0,
      sourceCount,
      0,
      1,
    ]);

    // --- and validation agrees --------------------------------------------
    const report = await validate(j, repaired.id, 'FULL');
    expect(report.outcome, JSON.stringify(report.entities.map((e) => e.checks))).toBe('PASS');
    expect(report.summary!.missingRecords).toBe(0);
    expect(report.summary!.differentRecords).toBe(0);
  }, 900_000);
});
