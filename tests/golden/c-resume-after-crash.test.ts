import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountedFor, writtenByRun } from '../../shared/run-metrics';
import { DataverseError } from '../../server/src/dataverse/errors';
import {
  createPlan,
  evidence,
  execute,
  keyCensus,
  lineage,
  openJourney,
  retry,
  seedRows,
  targetRows,
  validate,
  type Journey,
} from './journey';

/**
 * Golden Journey C — interrupted, then resumed.
 *
 * The journey that closed the worst bug this product has had. A migration was killed partway through,
 * resumed, and reported that it had created six records out of three thousand — because identifiers
 * were stored lower-cased and the resume filter compared them in the source's casing, so every record
 * looked unhandled and was written again over the top of itself.
 *
 * What makes resume hard to test is that a run which completes proves nothing about a run which does
 * not. So the failure is injected at a known point rather than waited for: the connector throws a fatal
 * error on the Nth write, which stops the batch where it is and runs nothing downstream of the write.
 * That is as close as a test gets to the process dying, and it lands in the window between the target
 * write and the identity-map write — the two systems, in that order, with no transaction across them.
 *
 * The question afterwards is never "did it finish". It is whether the target, the identity map, the
 * metrics, the lineage, validation and the evidence all say the same thing.
 */
describe('Golden Journey C: interrupted, then resumed', () => {
  let j: Journey;
  const TABLE = 'dtx_office';
  /** Enough records that an interruption lands in the middle rather than at an edge. */
  const EXTRA_ROWS = 240;
  const FAIL_ON_WRITE = 70;

  let writes = 0;
  let failAt: number | null = null;

  beforeAll(async () => {
    j = await openJourney();

    const existing = await targetRows(j, j.dev, TABLE);
    const region = existing[0]?.data.dtx_regionid;
    expect(region, 'the demo source has an office with a region to borrow').toBeTruthy();
    await seedRows(
      j,
      j.dev,
      TABLE,
      Array.from({ length: EXTRA_ROWS }, (_, i) => ({
        dtx_officeid: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`,
        dtx_name: `Resumed Office ${i}`,
        dtx_city: `City ${i % 20}`,
        dtx_headcount: (i % 50) + 1,
        dtx_regionid: region,
      })),
    );

    /**
     * Every connector the engine builds for the target goes through here. `AUTH_REQUIRED` is what the
     * engine treats as fatal: it stops the run rather than marking one record failed, which is the
     * shape of a process that died.
     */
    const factory = j.t.services.connections as unknown as {
      connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const original = factory.connectorFor.bind(factory);
    factory.connectorFor = async (...args: unknown[]) => {
      const conn = await original(...args);
      const inner = conn.createRecord as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof inner !== 'function') return conn;
      const isTarget = String((args[0] as { id?: string })?.id ?? '') !== j.dev.id;
      if (!isTarget) return conn;
      conn.createRecord = async (...a: unknown[]) => {
        writes++;
        if (failAt !== null && writes === failAt) {
          throw new DataverseError('AUTH_REQUIRED', 'Injected fatal failure', 401);
        }
        return inner.apply(conn, a);
      };
      return conn;
    };
  }, 300_000);

  afterAll(async () => {
    await j?.close();
  });

  it('writes nothing twice, accounts for everything, and proves it', async () => {
    const sourceCount = (await targetRows(j, j.dev, TABLE)).length;
    expect(sourceCount).toBeGreaterThan(FAIL_ON_WRITE);

    const plan = await createPlan(j, {
      name: 'Golden C',
      source: j.dev,
      target: j.uat,
      // Small batches, so the interruption lands inside one rather than between two.
      tables: ['dtx_region', TABLE],
      batchSize: 10,
    });

    // --- the interruption ---------------------------------------------------
    failAt = FAIL_ON_WRITE;
    const interrupted = await execute(j, plan);
    failAt = null;

    expect(interrupted.status, 'a run that stopped partway does not report success').not.toBe('COMPLETED');
    expect(['FAILED', 'COMPLETED_WITH_ERRORS', 'NEEDS_RECONCILIATION']).toContain(interrupted.status);

    const partialRows = await targetRows(j, j.uat, TABLE);
    expect(partialRows.length, 'some records were written before the interruption').toBeGreaterThan(0);
    expect(partialRows.length, 'and not all of them').toBeLessThan(sourceCount);

    // Whatever state the run is in, it is not claiming records it cannot account for.
    expect(accountedFor(interrupted)).toBeLessThanOrEqual(interrupted.total);

    // --- the resume ---------------------------------------------------------
    const resumed = await retry(j, interrupted.id);
    expect(resumed.status, resumed.errorMessage ?? '').toBe('COMPLETED');
    expect(resumed.attempt, 'the resume is a second attempt of the same run').toBeGreaterThan(1);
    expect(resumed.failed).toBe(0);
    expect(resumed.unresolved, 'nothing is left unaccounted for').toBe(0);

    /**
     * The arithmetic, which is the whole claim: every source record accounted for exactly once, under
     * exactly one outcome, after an interruption and a resume.
     */
    expect(accountedFor(resumed)).toBe(resumed.total);

    // --- the independent look, which is where the old bug showed ------------
    const rows = await targetRows(j, j.uat, TABLE);
    expect(rows.length, 'the target holds one record per source record').toBe(sourceCount);

    const census = keyCensus(rows, 'dtx_officeid');
    expect(census.repeated, 'no record was written twice').toEqual([]);
    expect(census.distinct).toBe(census.total);

    // Names too, not only identifiers: a record written twice under two identifiers would pass the
    // check above and fail this one.
    const names = keyCensus(rows, 'dtx_name');
    expect(names.repeated, 'and no record arrived twice under a different identifier').toEqual([]);

    // --- lineage -----------------------------------------------------------
    const lineageRows = await lineage(j, resumed.id);
    expect(lineageRows.length, 'one row per record, across both attempts').toBe(accountedFor(resumed));
    expect(new Set(lineageRows.map((r) => r['Source id'])).size, 'no source record listed twice').toBe(
      lineageRows.length,
    );
    const targetIds = lineageRows.map((r) => r['Target id']).filter(Boolean);
    expect(new Set(targetIds).size, 'and no target record claimed by two source records').toBe(
      targetIds.length,
    );

    /**
     * Every record's write state is settled. After a resume, an `INTENDED` or `UNKNOWN` left behind
     * would mean the platform is still unsure about a record while reporting the run complete.
     */
    const states = new Set(lineageRows.map((r) => r['Write state']).filter(Boolean));
    expect([...states].sort(), 'every write is accounted for').toEqual(['CONFIRMED']);

    // --- validation and evidence -------------------------------------------
    const report = await validate(j, resumed.id, 'FULL');
    expect(report.outcome, JSON.stringify(report.entities.map((e) => e.checks))).toBe('PASS');
    expect(report.summary!.missingRecords).toBe(0);
    expect(report.summary!.differentRecords).toBe(0);
    expect(report.summary!.coverage!.mode, 'and it examined everything').toBe('FULL');
    const entity = report.entities.find((e) => e.logicalName === TABLE)!;
    expect(entity.unresolvedInRun).toBe(0);
    // A validation entity reports the run's accounting rather than carrying the run's counters.
    expect(entity.matched).toBe(writtenByRun(entity.accounting!));

    const pack = await evidence(j, resumed.id);
    expect(pack.verdict, pack.problems.join('; ')).toBe('VALID');
    expect(pack.problems).toEqual([]);
  }, 1_200_000);
});
