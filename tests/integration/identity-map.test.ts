import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Record identity: lookups in a later run resolve through earlier runs' identity maps, and maps
 * pointing at target records that no longer exist are not trusted (explicit failure instead).
 */
describe('record identity mapping across runs', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  let worker: ReturnType<TestApp['services']['createWorker']>;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  async function migrate(tables: string[]) {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables,
    });
    expect(plan.blockerCount).toBe(0);
    const run = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(120_000);
    return api.get<MigrationRunDto>(`/api/runs/${run.id}`);
  }

  it('resolves required lookups to records created by an earlier run', async () => {
    const regions = await migrate(['dtx_region']);
    expect(regions.status).toBe('COMPLETED');
    // Offices require a region; regions are not part of this plan.
    const offices = await migrate(['dtx_office']);
    expect(offices.entities[0]).toMatchObject({ created: 15, failed: 0 });
    // Offices were not in the first plan, so region.headoffice could not resolve: reported, left empty.
    const warnings = await api.get(`/api/runs/${regions.id}/errors?severity=WARNING`);
    expect(warnings.total).toBe(6);
    expect(warnings.items[0]).toMatchObject({ errorCode: 'LOOKUP_UNRESOLVED', field: 'dtx_headofficeid' });
  });

  it('does not trust stale identity maps and fails clearly', async () => {
    // Remove regions and offices from the target behind the platform's back.
    for (const table of ['dtx_region', 'dtx_office']) {
      await t.services.db
        .delete(demoRecords)
        .where(and(eq(demoRecords.environmentKey, 'demo-uat'), eq(demoRecords.logicalName, table)));
    }
    const offices = await migrate(['dtx_office']);
    expect(offices.entities[0]).toMatchObject({ created: 0, failed: 15 });
    const errors = await api.get(`/api/runs/${offices.id}/errors?severity=ERROR`);
    expect(
      errors.items.every(
        (e: { errorCode: string; retryable: boolean }) => e.errorCode === 'LOOKUP_UNRESOLVED' && e.retryable,
      ),
    ).toBe(true);
  });
});
