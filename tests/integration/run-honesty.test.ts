import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { runHadErrors } from '../../server/src/services/migration-engine';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * A run must never claim more than it achieved.
 *
 * A whole table can fail without a single record failing — the table is missing in the source or the
 * target, or the source read itself fails. Those paths mark the table FAILED and write an error, but
 * produce no failed *record*, and the run status was derived only from record counters. So a run that
 * lost an entire table was stamped COMPLETED, the plan was marked EXECUTED, and the audit trail
 * recorded success. For a migration tool that is the worst available lie: the next person reads
 * "done" and moves on.
 */
describe('a finished run reports what actually happened', () => {
  /**
   * The derivation on its own. Exported precisely because it was the thing that was wrong, and
   * because the states that used to be mis-reported are awkward to provoke end to end — a missing
   * table needs a source that has since changed.
   */
  it('counts every kind of failure, not only failed records', () => {
    const clean = { failedRecords: 0, deferredFailed: 0, failedTables: 0, unresolvedErrors: 0 };
    expect(runHadErrors(clean)).toBe(false);

    // The bug: a whole table lost, no failed record anywhere. This returned false.
    expect(runHadErrors({ ...clean, failedTables: 1 })).toBe(true);
    // An error written without a corresponding failed record — any future path that does the same.
    expect(runHadErrors({ ...clean, unresolvedErrors: 1 })).toBe(true);
    // The two that always worked.
    expect(runHadErrors({ ...clean, failedRecords: 1 })).toBe(true);
    expect(runHadErrors({ ...clean, deferredFailed: 1 })).toBe(true);
  });

  // ---------------------------------------------------------------------------

  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let dev: EnvironmentDto;
  let qa: EnvironmentDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('keeps the run status, the plan status and the audit trail in step', async () => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Honesty ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['dtx_office'],
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
    const after = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);

    // Whatever happened, the three must agree. That is the invariant the bug broke: a run could say
    // COMPLETED while a table said FAILED, and the plan would still be marked EXECUTED.
    const clean = run.status === 'COMPLETED';
    const failedTables = run.entities.filter((e) => e.status === 'FAILED');

    if (clean) {
      expect(failedTables, 'a clean run has no failed table').toEqual([]);
      expect(run.failed).toBe(0);
      expect(run.errorCount).toBe(0);
      // Only a run that carried everything finishes the plan.
      expect(after.status).toBe('EXECUTED');
    } else {
      // Something failed, so the plan is still work to do rather than done.
      expect(after.status).not.toBe('EXECUTED');
      expect(
        failedTables.length > 0 || run.failed > 0 || run.errorCount > 0,
        'a run with errors can say which',
      ).toBe(true);
    }

    const audit = await api.get<{ action: string; outcome: string }[]>('/api/audit?limit=200');
    const completed = audit.find((e) => e.action === 'MIGRATION_COMPLETED');
    expect(completed, 'the run was audited').toBeTruthy();
    // The audit trail is what somebody reads months later; it cannot say SUCCESS for a run that lost
    // a table.
    expect(completed!.outcome).toBe(clean ? 'SUCCESS' : 'FAILURE');
  });
});
