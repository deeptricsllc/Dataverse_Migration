import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto, RetrySafetyDto } from '../../shared/domain';
import { disarmAll } from '../../server/src/dataverse/demo/fault-injection';
import { demoRecords, migrationRecordMaps } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The deliberate failure, and the fence around it.
 *
 * A write that commits and whose answer never arrives is caused by a network, not by a plan, so no
 * configuration produces it. Without a way to cause one, the reconciliation screens could only ever be
 * demonstrated by writing the state into the database — which proves the components render rather than that
 * the product works, and is a fixture dressed as evidence.
 *
 * This asserts both halves: that arming it produces the genuine state, through the real engine, and that it
 * cannot be reached by anybody who should not have it.
 */
describe('a deliberate failure, armed by hand, against simulated data', () => {
  let t: TestApp;
  let api: ApiClient;
  let organizationId: string;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;

  beforeEach(async () => {
    disarmAll();
    t = await createTestApp();
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
  }, 120_000);
  afterEach(async () => {
    disarmAll();
    await t?.close();
  });

  const migrate = async (tables: string[]) => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Armed ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables,
    });
    const current = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: current.sourceEnvironment.displayName,
      confirmTargetName: current.targetEnvironment.displayName,
      acknowledgeWarnings: true,
    });
    const worker = t.services.createWorker();
    await worker.drain(300_000);
    await worker.stop();
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };

  /**
   * The state, caused rather than written.
   *
   * The record is inserted — every validation and duplicate check having run — and then the call throws as
   * though the answer were lost. The engine classifies it as ambiguous, which is what makes it unresolved:
   * a timeout tells you nothing about whether the write committed.
   */
  it('produces a record in the target that the run cannot account for', async () => {
    const armed = await api.post<{ armed: boolean; table: string; onNthCreate: number }>(
      '/api/demo/fault-injection',
      { environmentId: uat.id, table: 'dtx_region', onNthCreate: 2 },
    );
    expect(armed.armed).toBe(true);
    expect(armed.onNthCreate).toBe(2);

    const run = await migrate(['dtx_region']);

    // Neither complete nor failed, because the outcome of one write is unknown.
    expect(run.status).toBe('NEEDS_RECONCILIATION');
    expect(run.unresolved).toBe(1);
    expect(run.failed, 'an unknown result is not a failure').toBe(0);

    // And the record really is in the target. That is what makes retrying it dangerous.
    const inTarget = await t.services.db
      .select({ recordId: demoRecords.recordId })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, 'dtx_region'),
        ),
      );
    const maps = await t.services.db
      .select()
      .from(migrationRecordMaps)
      .where(and(eq(migrationRecordMaps.runId, run.id), eq(migrationRecordMaps.logicalName, 'dtx_region')));
    const unresolved = maps.filter((m) => m.writeState && m.writeState !== 'CONFIRMED');
    expect(unresolved).toHaveLength(1);
    expect(inTarget.length, 'the write landed').toBeGreaterThanOrEqual(maps.length - 1);

    // The reconciliation workspace names it, with what would identify it.
    const outstanding = await api.get<{ total: number; items: { sourceId: string; evidence: string }[] }>(
      `/api/runs/${run.id}/reconciliation`,
    );
    expect(outstanding.total).toBe(1);
    expect(outstanding.items[0]!.sourceId).toBe(unresolved[0]!.sourceId);

    // And the retry assessment has something to say about it rather than offering a plain retry.
    const safety = await api.get<RetrySafetyDto>(`/api/runs/${run.id}/retry-safety`);
    expect(safety.state === 'RECONCILE_FIRST' || safety.safe > 0).toBe(true);
  }, 900_000);

  /** It fires once. A fault left armed would break the next run somebody started for an unrelated reason. */
  it('disarms itself after it fires', async () => {
    await api.post('/api/demo/fault-injection', {
      environmentId: uat.id,
      table: 'dtx_region',
      onNthCreate: 1,
    });
    const first = await migrate(['dtx_region']);
    expect(first.unresolved).toBe(1);

    const second = await migrate(['dtx_applicationconfig']);
    expect(second.unresolved, 'the next run is untouched').toBe(0);
    expect(second.status).toBe('COMPLETED');
  }, 900_000);

  /**
   * And the fence.
   *
   * A simulated environment only, in a workspace of simulated environments, by an administrator. There is no
   * path from this route to a customer's tenant.
   */
  it('refuses an environment with no simulated Dataverse behind it', async () => {
    const envs = await api.get<EnvironmentDto[]>('/api/environments');
    const sql = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
    expect(sql, 'the demo workspace has a SQL connection in it').toBeTruthy();
    await api.post(
      '/api/demo/fault-injection',
      { environmentId: sql.id, table: 'dtx_region', onNthCreate: 1 },
      403,
    );
  });

  it('refuses an environment in another workspace', async () => {
    await api.post(
      '/api/demo/fault-injection',
      { environmentId: '00000000-0000-0000-0000-000000000000', table: 'dtx_region', onNthCreate: 1 },
      403,
    );
  });
});
