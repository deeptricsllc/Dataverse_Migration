import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoRecords, migrationRecordMaps } from '../../server/src/db/schema';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * A simulated target that changed after the run, and the fence around the thing that changes it.
 *
 * What a validation exists to catch is data that stopped matching: a value edited by hand, a
 * reference repointed by an integration, a record deleted by somebody tidying up. None of that can
 * be caused by configuring a migration, so without a way to cause it the screens that report it
 * could only be demonstrated by writing rows into the database — a fixture dressed as evidence.
 *
 * Both halves are asserted here: that the change produces a genuine finding through the real
 * comparison, and that the route cannot be reached by anybody who should not have it.
 */
describe('a simulated target edited outside a migration', () => {
  let t: TestApp;
  let api: ApiClient;
  let organizationId: string;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  let runId: string;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Drift ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'dtx_office'],
    });
    const current = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const run = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: current.sourceEnvironment.displayName,
      confirmTargetName: current.targetEnvironment.displayName,
      acknowledgeWarnings: true,
    });
    runId = run.id;
    const worker = t.services.createWorker();
    await worker.drain(300_000);
    await worker.stop();
  }, 600_000);

  afterAll(async () => {
    await t?.close();
  });

  const validate = async () => {
    const started = await api.post<ValidationRunDto>('/api/validations', { migrationRunId: runId });
    const worker = t.services.createWorker();
    await worker.drain(300_000);
    await worker.stop();
    return api.get<ValidationRunDto>(`/api/validations/${started.id}`);
  };

  const mapsFor = (logicalName: string) =>
    t.database.db
      .select()
      .from(migrationRecordMaps)
      .where(and(eq(migrationRecordMaps.runId, runId), eq(migrationRecordMaps.logicalName, logicalName)));

  it('changes the record it names, and nothing else', async () => {
    const offices = (await mapsFor('dtx_office')).filter((m) => m.targetId);
    expect(offices.length).toBeGreaterThan(1);
    const victim = offices[0]!.targetId!;

    const before = await t.database.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, 'dtx_office'),
        ),
      );

    const result = await api.post<{ changed: boolean }>('/api/demo/target-edit', {
      environmentId: uat.id,
      table: 'dtx_office',
      recordId: victim,
      set: { dtx_name: 'Renamed in the target' },
    });
    expect(result.changed).toBe(true);

    const after = await t.database.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, 'dtx_office'),
        ),
      );
    expect(after.length, 'no record was added or removed').toBe(before.length);
    const changed = after.find((r) => r.recordId === victim)!;
    expect(changed.data['dtx_name']).toBe('Renamed in the target');
    // The other columns on that record are untouched, which is what makes the finding readable.
    const original = before.find((r) => r.recordId === victim)!;
    expect(changed.data['dtx_code']).toBe(original.data['dtx_code']);
  }, 600_000);

  it('produces a field mismatch the real comparison finds', async () => {
    const report = await validate();
    const dataset = report.entities.find((e) => e.logicalName === 'dtx_office')!;
    expect(dataset.different, 'the one record that was edited').toBe(1);
    expect(dataset.outcome).toBe('FAIL');
    expect(dataset.findings?.VALUE_MISMATCH, 'one finding, on one column').toBe(1);

    const found = await api.get<{ items: { field: string | null; targetValue: string | null }[] }>(
      `/api/validations/${report.id}/differences?limit=50&type=VALUE_MISMATCH`,
    );
    const diff = found.items.find((x) => x.field === 'dtx_name')!;
    expect(diff, 'the edited column is named').toBeTruthy();
    expect(diff.targetValue).toBe('Renamed in the target');
  }, 600_000);

  it('produces a relationship mismatch when a reference is repointed', async () => {
    const offices = (await mapsFor('dtx_office')).filter((m) => m.targetId);
    const regions = (await mapsFor('dtx_region')).filter((m) => m.targetId);
    expect(regions.length).toBeGreaterThan(1);
    const office = offices[1]!.targetId!;
    const other = regions[regions.length - 1]!.targetId!;

    await api.post('/api/demo/target-edit', {
      environmentId: uat.id,
      table: 'dtx_office',
      recordId: office,
      set: { dtx_regionid: { logicalName: 'dtx_region', id: other } },
    });

    const report = await validate();
    const found = await api.get<{ items: { field: string | null; outcome: string }[] }>(
      `/api/validations/${report.id}/differences?limit=50&type=LOOKUP_MISMATCH`,
    );
    const diff = found.items.find((x) => x.field === 'dtx_regionid');
    expect(diff, 'a record in the target with the wrong parent').toBeTruthy();
    expect(diff!.outcome, 'which is not a successful validation').toBe('FAIL');
  }, 600_000);

  it('produces a missing record when the target record is removed', async () => {
    const offices = (await mapsFor('dtx_office')).filter((m) => m.targetId);
    const victim = offices[2]!;
    await api.post('/api/demo/target-edit', {
      environmentId: uat.id,
      table: 'dtx_office',
      recordId: victim.targetId,
      remove: true,
    });

    const report = await validate();
    const dataset = report.entities.find((e) => e.logicalName === 'dtx_office')!;
    expect(dataset.missing).toBe(1);
    // Validation's own finding, not the run's: the run said it wrote this record.
    expect(dataset.failedInRun).toBe(0);
    expect(dataset.findings?.MISSING_IN_TARGET).toBe(1);
    expect(dataset.matched + dataset.different + dataset.missing).toBe(dataset.checkedRecords);
  }, 600_000);

  it('records the change in the audit trail, without copying the value into it', async () => {
    const trail = await api.get<{ items: { action: string; details: Record<string, unknown> }[] }>(
      '/api/audit?limit=100',
    );
    const edits = trail.items.filter((a) => a.action === 'DEMO_TARGET_EDITED');
    expect(edits.length, 'every change is recorded').toBeGreaterThan(0);
    expect(edits[0]!.details.table).toBe('dtx_office');
    /*
     * The column names, not the values. A value here is data somebody put in a column, and an audit
     * trail is read by people who are not entitled to the record's contents.
     */
    const serialised = JSON.stringify(edits);
    expect(serialised).not.toContain('Renamed in the target');
  }, 120_000);

  // --- the fence ------------------------------------------------------------

  it('refuses an environment with no simulated data behind it', async () => {
    const envs = await api.get<EnvironmentDto[]>('/api/environments');
    const sql = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
    expect(sql, 'the demo workspace has a SQL connection in it').toBeTruthy();
    await api.post(
      '/api/demo/target-edit',
      { environmentId: sql.id, table: 'dtx_region', recordId: 'x', set: {} },
      403,
    );
  });

  it('refuses an environment in another workspace', async () => {
    await api.post(
      '/api/demo/target-edit',
      {
        environmentId: '00000000-0000-0000-0000-000000000000',
        table: 'dtx_region',
        recordId: 'x',
        set: {},
      },
      403,
    );
  });

  it('refuses a record that is not there, rather than creating one', async () => {
    await api.post(
      '/api/demo/target-edit',
      { environmentId: uat.id, table: 'dtx_region', recordId: 'not-a-record', set: { dtx_name: 'x' } },
      404,
    );
  });
});
