import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto, PreflightRunDto } from '../../shared/domain';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Migrations INTO SQL: from Dataverse and from another SQL database.
 *
 * The same engine, planner and matcher run in both directions; only the connector differs. These
 * tests check the SQL-specific parts of writing — server-generated identity keys, deterministic
 * updates keyed on the primary key, and the zero-write guarantee.
 */
describe('migrations into SQL', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let legacySql: EnvironmentDto;
  let reportingSql: EnvironmentDto;
  let worker: ReturnType<TestApp['services']['createWorker']>;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    legacySql = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
    reportingSql = envs.find((e) => e.displayName === 'Reporting SQL Database (Demo)')!;
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  const rowsIn = (envKey: string, table: string) =>
    t.services.db
      .select()
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, envKey), eq(demoRecords.logicalName, table)));

  const mapField = async (plan: MigrationPlanDto, table: string, source: string, target: string) => {
    const entity = plan.entities.find((e) => e.logicalName === table)!;
    const { mappings } = await api.get<{ mappings: { id: string; sourceField: string }[] }>(
      `/api/plans/${plan.id}/entities/${entity.id}/mappings`,
    );
    const mapping = mappings.find((m) => m.sourceField === source)!;
    return api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/mappings/${mapping.id}`, {
      action: 'MAP',
      targetField: target,
    });
  };

  const execute = async (plan: MigrationPlanDto, from: EnvironmentDto, to: EnvironmentDto) => {
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: from.displayName,
      confirmTargetName: to.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };

  it('has a writable SQL target with no rows yet', async () => {
    expect(reportingSql).toBeDefined();
    expect(reportingSql.connectionType).toBe('SQL_SERVER');
    expect(reportingSql.capabilities.supportsWrite).toBe(true);
    expect((await rowsIn('demo-sql-target', 'config.Region')).length).toBe(0);
  });

  describe('Dataverse → SQL Server', () => {
    let plan: MigrationPlanDto;

    it('plans a Dataverse table into a SQL table', async () => {
      plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: 'Dataverse regions into SQL',
        sourceEnvironmentId: dev.id,
        targetEnvironmentId: reportingSql.id,
        tables: ['dtx_region'],
      });
      plan = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, {
        conflictStrategy: 'SYNC',
      });
      const entity = plan.entities.find((e) => e.logicalName === 'dtx_region')!;
      plan = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/entities/${entity.id}/object-mapping`, {
        targetLogicalName: 'config.Region',
        status: 'CONFIRMED',
      });
      plan = await mapField(plan, 'dtx_region', 'dtx_name', 'RegionName');
      plan = await mapField(plan, 'dtx_region', 'dtx_code', 'RegionCode');
      // A SQL identity key is assigned by the database, so records match on a business key.
      plan = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/entities/${entity.id}`, {
        matchStrategy: 'BUSINESS_KEY',
        alternateKey: null,
        businessKeyFields: ['RegionCode'],
      });
      expect(plan.blockerCount).toBe(0);
    });

    it('writes rows into SQL with server-generated keys', async () => {
      const source = await rowsIn('demo-dev', 'dtx_region');
      const run = await execute(plan, dev, reportingSql);
      expect(run.status).toBe('COMPLETED');
      expect(run.created).toBe(source.length);

      const written = await rowsIn('demo-sql-target', 'config.Region');
      expect(written.length).toBe(source.length);
      const first = written[0].data as Record<string, unknown>;
      // The key came from the database (an integer), not from the Dataverse GUID.
      expect(typeof first.RegionId).toBe('number');
      expect(String(first.RegionId)).not.toMatch(/-/);
      expect(typeof first.RegionName).toBe('string');
    });

    it('writes nothing on an identical second run', async () => {
      const before = await rowsIn('demo-sql-target', 'config.Region');
      const pf = await api.post<PreflightRunDto>(`/api/plans/${plan.id}/preflight`);
      await worker.drain(180_000);
      const preview = await api.get<PreflightRunDto>(`/api/preflight/${pf.id}`);
      expect(preview.totals.unchanged).toBe(before.length);
      expect(preview.totals.create).toBe(0);
      expect(preview.totals.update).toBe(0);

      const run = await execute(plan, dev, reportingSql);
      expect(run.created).toBe(0);
      expect(run.updated).toBe(0);
      expect(run.unchanged).toBe(before.length);
      const after = await rowsIn('demo-sql-target', 'config.Region');
      expect(JSON.stringify(after.map((r) => r.data))).toBe(JSON.stringify(before.map((r) => r.data)));
    });

    it('updates only the column that changed', async () => {
      const [row] = await rowsIn('demo-dev', 'dtx_region');
      const data = row.data as Record<string, unknown>;
      await t.services.db
        .update(demoRecords)
        .set({ data: { ...data, dtx_name: 'Renamed in Dataverse' } })
        .where(
          and(
            eq(demoRecords.environmentKey, 'demo-dev'),
            eq(demoRecords.logicalName, 'dtx_region'),
            eq(demoRecords.recordId, row.recordId),
          ),
        );
      const run = await execute(plan, dev, reportingSql);
      expect(run.updated).toBe(1);
      expect(run.created).toBe(0);
      const written = await rowsIn('demo-sql-target', 'config.Region');
      expect(
        written.some((r) => (r.data as Record<string, unknown>).RegionName === 'Renamed in Dataverse'),
      ).toBe(true);
    });
  });

  describe('SQL Server → SQL Server', () => {
    let plan: MigrationPlanDto;

    it('pairs identically named tables without asking', async () => {
      plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: 'Legacy SQL into reporting SQL',
        sourceEnvironmentId: legacySql.id,
        targetEnvironmentId: reportingSql.id,
        tables: ['dbo.Product'],
      });
      plan = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, {
        conflictStrategy: 'SYNC',
      });
      const entity = plan.entities.find((e) => e.logicalName === 'dbo.Product')!;
      // Same provider and the same name on both sides: nothing to confirm.
      expect(entity.objectMappingStatus).toBe('EXACT');
      expect(entity.targetLogicalName).toBe('dbo.Product');
      // The unique constraint on both sides is picked up automatically.
      expect(entity.matchStrategy).toBe('ALTERNATE_KEY');
      expect(plan.blockerCount).toBe(0);
    });

    it('copies rows, then writes nothing the second time', async () => {
      const source = await rowsIn('demo-sql', 'dbo.Product');
      const run = await execute(plan, legacySql, reportingSql);
      expect(run.status).toBe('COMPLETED');
      expect(run.created).toBe(source.length);
      const written = await rowsIn('demo-sql-target', 'dbo.Product');
      expect(written.length).toBe(source.length);

      const again = await execute(plan, legacySql, reportingSql);
      expect(again.created).toBe(0);
      expect(again.updated).toBe(0);
      expect(again.unchanged).toBe(source.length);
    });

    it('refuses to write a value the target column cannot hold', async () => {
      const [row] = await rowsIn('demo-sql', 'dbo.Product');
      const data = row.data as Record<string, unknown>;
      await t.services.db
        .update(demoRecords)
        .set({ data: { ...data, ProductName: 'x'.repeat(200) } })
        .where(
          and(
            eq(demoRecords.environmentKey, 'demo-sql'),
            eq(demoRecords.logicalName, 'dbo.Product'),
            eq(demoRecords.recordId, row.recordId),
          ),
        );
      const pf = await api.post<PreflightRunDto>(`/api/plans/${plan.id}/preflight`);
      await worker.drain(180_000);
      const preview = await api.get<PreflightRunDto>(`/api/preflight/${pf.id}`);
      // nvarchar(150) cannot hold 200 characters: reported before anything is written.
      expect(preview.totals.blocked).toBe(1);
      const blocked = await api.get<{ items: { reasonCode: string; reason: string }[] }>(
        `/api/preflight/${pf.id}/records?action=BLOCKED`,
      );
      expect(blocked.items[0].reason).toMatch(/150/);
    });
  });
});
