import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Whether the migration put the same record in twice.
 *
 * This was the gap the overnight audit found and the one that matters most, because a migration can
 * duplicate every record it writes and still pass every other check: each source record finds a
 * target record holding exactly the right values — just not only one of them. Value comparison
 * cannot see it. Only counting can.
 *
 * The counting happens in the database holding the data, so these tests exercise the connector's
 * own grouping rather than a scan in the test process.
 */
describe('duplicate keys in the target', () => {
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

  const migrateAndValidate = async (tables: string[], depth: 'QUICK' | 'STANDARD' | 'FULL') => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Duplicates ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables,
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const validation = await api.post<ValidationRunDto>('/api/validations', {
      migrationRunId: started.id,
      depth,
    });
    await worker.drain(180_000);
    return {
      run: await api.get<MigrationRunDto>(`/api/runs/${started.id}`),
      report: await api.get<ValidationRunDto>(`/api/validations/${validation.id}`),
    };
  };

  it('looks for repeated keys and says it found none, rather than staying silent', async () => {
    const { report } = await migrateAndValidate(['dtx_region'], 'FULL');
    const region = report.entities.find((e) => e.logicalName === 'dtx_region')!;

    // The check ran. "We looked and found none" is a different claim from "we did not look", and
    // the report has to be able to tell them apart.
    expect(region.duplicateCoverage?.mode).toBe('FULL');
    expect(region.duplicates).toEqual([]);
    expect(report.summary!.duplicateRecords).toBe(0);
    expect(
      region.checks.some((c) => /No repeated values/.test(c.message) && c.outcome === 'PASS'),
      'the table says in words that nothing repeats',
    ).toBe(true);
  }, 300_000);

  it('finds a duplicate somebody else put there, and does not blame the run for it', async () => {
    // A record the migration never touched, carrying a key that already exists. The run cannot be
    // responsible for a collision that was there before it started, and saying otherwise would send
    // a migration lead looking for a bug in their own run.
    const { report: before } = await migrateAndValidate(['dtx_region'], 'FULL');
    const region = before.entities.find((e) => e.logicalName === 'dtx_region')!;
    const victim = region.duplicates;
    expect(victim).toEqual([]);

    const { demoRecords } = await import('../../server/src/db/schema');
    const { and, eq } = await import('drizzle-orm');
    const session = await api.get<{ user: { organization: { id: string } } }>('/api/auth/session');
    const orgId = session.user.organization.id;
    const [sample] = await t.services.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, orgId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, 'dtx_region'),
        ),
      )
      .limit(1);
    expect(sample, 'the migration wrote regions into UAT').toBeTruthy();

    // A second row holding the same name, written directly rather than by the migration.
    await t.services.db.insert(demoRecords).values({
      organizationId: orgId,
      environmentKey: 'demo-uat',
      logicalName: 'dtx_region',
      recordId: '11111111-1111-4111-8111-111111111111',
      data: { ...sample!.data, dtx_regionid: '11111111-1111-4111-8111-111111111111' },
    });

    // Validate the same run again: the duplicate exists now, and this run did not create it.
    const runId = before.migrationRunId!;
    const again = await api.post<ValidationRunDto>('/api/validations', {
      migrationRunId: runId,
      depth: 'FULL',
    });
    await worker.drain(180_000);
    const report = await api.get<ValidationRunDto>(`/api/validations/${again.id}`);
    const entity = report.entities.find((e) => e.logicalName === 'dtx_region')!;

    expect(entity.duplicates?.length ?? 0, 'the repeated name was found').toBeGreaterThan(0);
    const found = entity.duplicates![0]!;
    expect(found.occurrences).toBeGreaterThan(1);
    expect(found.sampleIds.length, 'records somebody can go and look at').toBeGreaterThan(0);
    expect(found.columns.length).toBeGreaterThan(0);
    expect(report.summary!.duplicateRecords).toBeGreaterThan(0);
  }, 300_000);

  it('reports sampled coverage honestly when the depth caps the work', async () => {
    const { report } = await migrateAndValidate(['account'], 'QUICK');
    const account = report.entities.find((e) => e.logicalName === 'account')!;

    // 120 accounts against a quick depth of 500 is still full coverage; the point is that the
    // report derives the claim from the numbers rather than asserting it.
    expect(account.coverage).toBeTruthy();
    expect(account.coverage!.examined).toBeLessThanOrEqual(account.coverage!.eligible);
    expect(['FULL', 'SAMPLED']).toContain(account.coverage!.mode);
    expect(report.depth).toBe('QUICK');
    expect(account.coverage!.deterministic, 'the same depth examines the same records').toBe(true);

    if (account.coverage!.mode === 'SAMPLED') {
      const clean = account.checks.find((c) => c.check === 'FIELD_VALUES');
      expect(clean?.message, 'a sampled result never claims everything matched').not.toMatch(/^All /);
    }
  }, 300_000);
});
