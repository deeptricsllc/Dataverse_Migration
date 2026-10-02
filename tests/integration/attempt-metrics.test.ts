import { afterEach, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { accountedFor } from '../../shared/run-metrics';
import { DataverseError } from '../../server/src/dataverse/errors';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Two kinds of number, kept apart.
 *
 * Run totals are what somebody signs for: every source record, counted exactly once, under one outcome.
 * Attempt figures are execution history: which attempt is answerable for the state each record is now
 * in. The question these cases exist to answer is the one the brief asks — "the first run failed, what
 * did the second one actually do" — without producing a figure larger than the data, which is what
 * summing activity across attempts would give.
 */
describe('per-attempt metrics', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  /** A target connector that fails fatally on the Nth create, which is the shape of a dead process. */
  async function appWithFailureAt(failAt: { n: number | null }) {
    const app = await createTestApp();
    const api = new ApiClient(app.app);
    const worker = app.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

    const factory = app.services.connections as unknown as {
      connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const original = factory.connectorFor.bind(factory);
    let writes = 0;
    factory.connectorFor = async (...args: unknown[]) => {
      const conn = await original(...args);
      const inner = conn.createRecord as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof inner !== 'function') return conn;
      if (String((args[0] as { id?: string })?.id ?? '') === dev.id) return conn;
      conn.createRecord = async (...a: unknown[]) => {
        writes++;
        if (failAt.n !== null && writes === failAt.n) {
          throw new DataverseError('AUTH_REQUIRED', 'Injected fatal failure', 401);
        }
        return inner.apply(conn, a);
      };
      return conn;
    };
    return { app, api, worker, dev, uat };
  }

  it('attributes every record to one attempt, so the attempts add up to the run', async () => {
    const failAt: { n: number | null } = { n: 4 };
    const { app, api, worker, dev, uat } = await appWithFailureAt(failAt);
    t = app;

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Attempts ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region'],
    });
    await api.patch(`/api/plans/${plan.id}/options`, { batchSize: 2 });

    // --- attempt 1, interrupted --------------------------------------------
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const interrupted = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
    expect(interrupted.status, 'the first attempt did not finish').not.toBe('COMPLETED');

    const afterOne = await api.get(`/api/runs/${started.id}/attempts`);
    expect(afterOne.attempts.length, 'one attempt so far').toBe(1);
    expect(afterOne.attempts[0].attempt).toBe(1);

    // --- attempt 2, which finishes it --------------------------------------
    failAt.n = null;
    await api.post(`/api/runs/${started.id}/retry`, {});
    await worker.drain(180_000);
    const finished = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.attempt).toBeGreaterThan(1);

    const result = await api.get(`/api/runs/${started.id}/attempts`);

    /**
     * The claim. Each record belongs to exactly one attempt, so the attempts sum to the run totals —
     * not approximately, exactly. Summing activity instead would exceed the number of records, which is
     * the mistake this design avoids by construction rather than by arithmetic afterwards.
     */
    const sum = (field: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed' | 'unresolved') =>
      result.attempts.reduce((n: number, a: Record<string, number>) => n + a[field]!, 0);

    expect(sum('created')).toBe(finished.created);
    expect(sum('updated')).toBe(finished.updated);
    expect(sum('unchanged')).toBe(finished.unchanged);
    expect(sum('skipped')).toBe(finished.skipped);
    expect(sum('failed')).toBe(finished.failed);
    expect(sum('unresolved')).toBe(finished.unresolved);

    const everything =
      sum('created') + sum('updated') + sum('unchanged') + sum('skipped') + sum('failed') + sum('unresolved');
    expect(everything, 'and no record is counted twice').toBe(accountedFor(finished));
    expect(everything).toBe(finished.total);

    // --- and it answers the question it exists for -------------------------
    expect(result.attempts.length, 'both attempts are listed separately').toBeGreaterThanOrEqual(2);
    const second = result.attempts.find((a: { attempt: number }) => a.attempt === 2)!;
    expect(second, 'attempt 2 has its own row').toBeTruthy();
    expect(
      second.created + second.updated + second.unchanged + second.skipped,
      'the second attempt did the work the first one did not',
    ).toBeGreaterThan(0);

    // Nothing is left unattributed in a run this product wrote from the start.
    expect(result.someRecordsPredateAttemptTracking).toBe(false);
    expect(result.attempts.every((a: { attempt: number | null }) => a.attempt !== null)).toBe(true);

    // The run's own totals travel with it, so the two can be reconciled on one screen.
    expect(result.run.total).toBe(finished.total);
    expect(result.run.created).toBe(finished.created);

    // And the distinction is stated rather than left for the reader to infer.
    expect(result.means).toMatch(/final accountability/i);
    expect(result.means).toMatch(/execution history/i);
    expect(result.means, 'including what it cannot show').toMatch(/not separately visible/i);
  }, 600_000);

  it('reports one attempt for a run that needed only one', async () => {
    const { app, api, worker, dev, uat } = await appWithFailureAt({ n: null });
    t = app;
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Single ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region'],
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
    const result = await api.get(`/api/runs/${started.id}/attempts`);

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].attempt).toBe(1);
    expect(result.attempts[0].created).toBe(run.created);
    expect(result.attempts[0].firstRecordAt, 'when it started touching records').toBeTruthy();
    expect(result.attempts[0].lastRecordAt).toBeTruthy();
    expect(new Date(result.attempts[0].lastRecordAt).getTime()).toBeGreaterThanOrEqual(
      new Date(result.attempts[0].firstRecordAt).getTime(),
    );
  }, 600_000);

  it('is refused to somebody from another workspace, like the run itself', async () => {
    const { app, api, worker, dev, uat } = await appWithFailureAt({ n: null });
    t = app;
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Isolation ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region'],
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);

    // A second demo visitor, who gets their own workspace and must not see this run's attempts.
    const stranger = new ApiClient(app.app);
    await stranger.demoLogin();
    const res = await app.app.inject({
      method: 'GET',
      url: `/api/runs/${started.id}/attempts`,
      headers: { cookie: stranger.cookie },
    });
    expect([403, 404]).toContain(res.statusCode);
  }, 600_000);
});
