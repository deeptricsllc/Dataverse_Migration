import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationEntityResultDto,
  ValidationRunDto,
} from '../../shared/domain';
import { AGGREGATE_CAVEAT } from '../../shared/aggregates';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Totals compared across the two sides, and the scope they are allowed to speak for.
 *
 * The failure worth preventing is not a wrong total — it is a right total answering the wrong
 * question. There are two ways to get one. A SUM over a target that holds records this run never
 * wrote compares two numbers that were never meant to match; and a MIN over `createdon` compares a
 * source timestamp against the moment the target platform inserted the row, which must differ. Both
 * produce failures nobody can act on, and a report that fails on them trains people to ignore it.
 *
 * So scope and column choice are asserted here before any arithmetic.
 *
 * Both migrations happen once, in setup, because a second run into the same target no longer owns
 * it — which is itself the behaviour the third case checks.
 */
describe('aggregate reconciliation', () => {
  let t: TestApp;
  let api: ApiClient;
  /** A table with a numeric column, migrated into an empty target: this run wrote everything. */
  let owned: ValidationEntityResultDto;
  /** A table migrated into a target that already held records nobody here wrote. */
  let shared: ValidationEntityResultDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    const qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;

    const migrateAndValidate = async (target: EnvironmentDto, tables: string[], of: string) => {
      const plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: `Aggregates ${of} ${Date.now()}`,
        sourceEnvironmentId: dev.id,
        targetEnvironmentId: target.id,
        tables,
      });
      const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
        confirmSourceName: dev.displayName,
        confirmTargetName: target.displayName,
        acknowledgeWarnings: true,
      });
      await worker.drain(180_000);
      const validation = await api.post<ValidationRunDto>('/api/validations', {
        migrationRunId: started.id,
        depth: 'FULL',
      });
      await worker.drain(180_000);
      const report = await api.get<ValidationRunDto>(`/api/validations/${validation.id}`);
      return report.entities.find((e) => e.logicalName === of)!;
    };

    // Offices carry a headcount and an opening date, so there is something to total beyond rows.
    // Regions come along because an office looks one up.
    owned = await migrateAndValidate(uat, ['dtx_region', 'dtx_office'], 'dtx_office');
    // QA already contains accounts before anything migrates into it.
    shared = await migrateAndValidate(qa, ['account'], 'account');
    await worker.stop();
  }, 600_000);

  afterAll(async () => {
    await t.close();
  });

  it('reconciles totals when this run wrote everything in the target', () => {
    const aggregates = owned.aggregates ?? [];
    expect(aggregates.length, 'totals were compared').toBeGreaterThan(0);

    const count = aggregates.find((a) => a.kind === 'COUNT')!;
    expect(count.outcome, 'the counts agree').toBe('PASS');
    expect(count.scope, 'the scope says this run owns the target').toMatch(/written by this run/i);
    expect(count.sourceValue).toBe(count.targetValue);

    // More than a row count: a real column total was computed on both sides and agreed.
    const sum = aggregates.find((a) => a.kind === 'SUM' && a.column === 'dtx_headcount')!;
    expect(sum, 'the headcount was summed').toBeTruthy();
    expect(sum.outcome).toBe('PASS');
    expect(sum.sourceValue).not.toBeNull();

    // Every result identifies what it compared and over what.
    for (const a of aggregates) {
      expect(a.entity).toBe('dtx_office');
      expect(a.scope, `${a.kind} states its scope`).toBeTruthy();
      expect(a.reason, `${a.kind} explains itself`).toBeTruthy();
      if (a.kind !== 'COUNT') expect(a.column, `${a.kind} names its column`).toBeTruthy();
    }
  });

  it('leaves alone the columns the target platform writes itself', () => {
    // `createdon` and `modifiedon` are stamped by the target at insert time. Their extremes must
    // differ from the source's, so reconciling them can only ever produce a false failure.
    const columns = (owned.aggregates ?? []).map((a) => a.column);
    expect(columns).not.toContain('createdon');
    expect(columns).not.toContain('modifiedon');
    expect(columns).not.toContain('overriddencreatedon');
  });

  it('refuses to compare totals when the target holds records this run did not write', () => {
    // A SUM over the whole table would answer a different question from "did this run move the data
    // correctly", and a mismatch would send somebody looking for a bug that is not there.
    const aggregates = shared.aggregates ?? [];
    const count = aggregates.find((a) => a.kind === 'COUNT')!;

    expect(count.outcome, 'not a pass and not a failure — not verifiable').toBe('NOT_VERIFIED');
    expect(count.reason).toMatch(/did not write/i);
    expect(count.scope).toMatch(/this run wrote/i);
    // And nothing further is attempted, rather than attempted against the wrong scope.
    expect(aggregates.filter((a) => a.kind !== 'COUNT')).toEqual([]);
    // Nor is the entity given a warning for it: being unable to compare two numbers is not a
    // finding about the migration, and a top-up run would otherwise never read clean again.
    expect(shared.checks.some((c) => c.check === 'AGGREGATES')).toBe(false);
  });

  it('never lets a passing total read as proof the records match', () => {
    const check = owned.checks.find((c) => c.check === 'AGGREGATES')!;
    expect(check, 'the totals are reported as a check').toBeTruthy();
    expect(check.outcome).toBe('PASS');
    // The caveat is part of the message, not part of the styling, so it survives an export.
    expect(check.message).toContain(AGGREGATE_CAVEAT);
    expect(check.message).toMatch(/does not prove/i);
  });
});
