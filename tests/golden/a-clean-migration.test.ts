import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountedFor, writtenByRun } from '../../shared/run-metrics';
import {
  createPlan,
  evidence,
  execute,
  keyCensus,
  lineage,
  openJourney,
  readiness,
  targetRows,
  validate,
  type Journey,
} from './journey';

/**
 * Golden Journey A — a clean migration.
 *
 * Source to target to validation to evidence, with nothing wrong anywhere. The least interesting
 * journey and the one most worth having: if this breaks, nothing else matters, and every other journey
 * is a variation on it.
 *
 * The question at each step is not "did it say it worked" but "does the target agree".
 */
describe('Golden Journey A: a clean migration', () => {
  let j: Journey;
  const TABLES = ['dtx_region', 'dtx_office'];

  beforeAll(async () => {
    j = await openJourney();
  }, 180_000);
  afterAll(async () => {
    await j?.close();
  });

  it('migrates, validates and produces verifiable evidence, with the target agreeing throughout', async () => {
    // --- before ------------------------------------------------------------
    const before = new Map<string, number>();
    for (const table of TABLES) before.set(table, (await targetRows(j, j.uat, table)).length);

    const plan = await createPlan(j, {
      name: 'Golden A',
      source: j.dev,
      target: j.uat,
      tables: TABLES,
      batchSize: 25,
    });

    // Readiness runs before the migration, and on a clean plan it must not be the thing that stops it.
    const assessment = await readiness(j, plan.id);
    expect(
      assessment.findings.filter((f) => f.severity === 'BLOCKER'),
      'a clean plan has nothing blocking it',
    ).toEqual([]);

    // --- the migration -----------------------------------------------------
    const run = await execute(j, plan);
    expect(run.status, run.errorMessage ?? '').toBe('COMPLETED');
    expect(run.failed).toBe(0);
    expect(run.unresolved, 'nothing was left unaccounted for').toBe(0);

    /**
     * The arithmetic that has to hold, stated rather than assumed: every source record was accounted
     * for exactly once, under exactly one outcome.
     */
    expect(accountedFor(run)).toBe(run.total);
    expect(run.processed).toBe(run.total);

    // --- the independent look ----------------------------------------------
    for (const table of TABLES) {
      const rows = await targetRows(j, j.uat, table);
      const entity = run.entities.find((e) => e.logicalName === table)!;
      const added = rows.length - before.get(table)!;

      expect(added, `${table}: the target gained exactly what the run says it wrote`).toBe(
        writtenByRun(entity),
      );

      // And no record arrived twice. This is the check the counters cannot make.
      const census = keyCensus(rows, `${table}id`);
      expect(census.repeated, `${table}: no identifier appears twice in the target`).toEqual([]);
      expect(census.distinct).toBe(census.total);
    }

    // --- lineage -----------------------------------------------------------
    const rows = await lineage(j, run.id);
    expect(rows.length, 'one lineage row per record the run handled').toBe(accountedFor(run));
    const sourceKeys = new Set(rows.map((r) => r['Source id']));
    expect(sourceKeys.size, 'no source record is listed twice').toBe(rows.length);
    const targetKeys = rows.map((r) => r['Target id']).filter(Boolean);
    expect(new Set(targetKeys).size, 'no target record is claimed by two source records').toBe(
      targetKeys.length,
    );
    // The export says what the platform can prove about each record, not only what it did.
    expect(new Set(rows.map((r) => r['Write state']))).toEqual(new Set(['CONFIRMED']));

    // Every target id in the lineage is a record that actually exists in the target.
    const present = new Set<string>();
    for (const table of TABLES) {
      for (const row of await targetRows(j, j.uat, table)) present.add(row.recordId.toLowerCase());
    }
    const dangling = targetKeys.filter((id) => !present.has(id.toLowerCase()));
    expect(dangling, 'lineage does not point at records that are not there').toEqual([]);

    // --- validation --------------------------------------------------------
    const report = await validate(j, run.id, 'FULL');
    expect(report.status).toBe('COMPLETED');
    expect(report.outcome, JSON.stringify(report.entities.map((e) => e.checks))).toBe('PASS');
    expect(report.summary!.missingRecords).toBe(0);
    expect(report.summary!.differentRecords).toBe(0);
    expect(report.summary!.brokenReferences).toBe(0);
    expect(report.summary!.coverage!.mode, 'a clean journey proves full coverage').toBe('FULL');
    expect(report.summary!.matchedRecords).toBe(writtenByRun(run));

    // --- evidence ----------------------------------------------------------
    const pack = await evidence(j, run.id);
    expect(pack.verdict, pack.problems.join('; ')).toBe('VALID');
    expect(pack.problems).toEqual([]);
    expect(pack.bytes.byteLength).toBeGreaterThan(0);
  }, 600_000);
});
