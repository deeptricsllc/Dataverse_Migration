import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The passes that run after the records are written, over more rows than fit in one page.
 *
 * Both used to select every pending identity row for a table into an array and then batch over
 * that array. The primary read path has always been paged; these two were not, so a table with
 * millions of deferred lookups would hold all of their identity rows at once — at exactly the
 * scale where it matters.
 *
 * Proving "bounded" without migrating millions of rows: run with a batch size far smaller than the
 * number of pending rows, so the pass is forced through several pages, and require that all of the
 * work completes. A cursor that fails to advance hangs; a pass that stops after one page leaves
 * rows behind. Both are visible at fifteen rows just as they would be at fifteen million.
 */
describe('the second passes work in pages', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('resolves every deferred lookup when they span many pages', async () => {
    // Regions and offices reference each other, so the references closing the cycle are deferred
    // to a second pass. A batch size of two forces that pass through page after page.
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Paging ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'dtx_office'],
    });
    await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, { batchSize: 2 });

    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);

    expect(run.status).toBe('COMPLETED');
    expect(run.failed).toBe(0);

    const { migrationRecordMaps } = await import('../../server/src/db/schema');
    const { and, eq, inArray } = await import('drizzle-orm');
    const rows = await t.services.db
      .select()
      .from(migrationRecordMaps)
      .where(eq(migrationRecordMaps.runId, run.id));

    // Enough rows that two-at-a-time is genuinely several pages, not one.
    expect(rows.length).toBeGreaterThan(10);
    const deferred = rows.filter((r) => r.deferredStatus !== null);
    expect(deferred.length, 'the cycle produced deferred work to page over').toBeGreaterThan(4);

    // Nothing left behind: a pass that stopped after its first page would strand the rest.
    const unfinished = await t.services.db
      .select()
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.runId, run.id),
          inArray(migrationRecordMaps.deferredStatus, ['PENDING', 'FAILED']),
        ),
      );
    expect(unfinished, 'every deferred lookup was resolved').toHaveLength(0);
  }, 300_000);

  it('does not re-read a page it has already finished', async () => {
    // The cursor is the source id, not the status the pass is about to change. Keying on status
    // would re-select a row the pass had just marked FAILED and never terminate, which is the
    // failure this asserts cannot happen: the run reaches a terminal state at all.
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Paging terminates ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'dtx_office'],
    });
    await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, { batchSize: 1 });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
    expect(['COMPLETED', 'COMPLETED_WITH_ERRORS']).toContain(run.status);
    expect(run.processed).toBe(run.total);
  }, 300_000);
});
