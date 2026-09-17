import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DiagnosticsReportDto,
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  PreflightRecordDto,
  PreflightRunDto,
} from '../../shared/domain';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The dry run must describe exactly what execution would do, and must never write. These tests
 * follow the same records through preflight -> execute -> preflight and assert both.
 */
describe('preflight dry run, no-op guarantee, remediation package and diagnostics', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let plan: MigrationPlanDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'dtx_office'],
    });
    plan = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, {
      conflictStrategy: 'SYNC',
    });
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  const targetRowCount = async (logicalName: string) =>
    (
      await t.services.db
        .select()
        .from(demoRecords)
        .where(and(eq(demoRecords.environmentKey, 'demo-uat'), eq(demoRecords.logicalName, logicalName)))
    ).length;

  const runPreflight = async () => {
    const started = await api.post<PreflightRunDto>(`/api/plans/${plan.id}/preflight`);
    await worker.drain(180_000);
    const done = await api.get<PreflightRunDto>(`/api/preflight/${started.id}`);
    expect(done.status).toBe('COMPLETED');
    return done;
  };

  it('classifies every record as CREATE before anything is migrated, and writes nothing', async () => {
    const before = await targetRowCount('dtx_region');
    const pf = await runPreflight();

    expect(pf.totals.sourceRecords).toBe(21);
    expect(pf.totals.create).toBe(21);
    expect(pf.totals.update).toBe(0);
    expect(pf.totals.unchanged).toBe(0);
    expect(pf.totals.conflict).toBe(0);
    expect(pf.totals.blocked).toBe(0);
    expect(pf.entities.map((e) => e.logicalName).sort()).toEqual(['dtx_office', 'dtx_region']);
    // Every table states how its records are matched.
    expect(pf.entities.every((e) => /record id|alternate key|business key/.test(e.matchDescription))).toBe(
      true,
    );

    // The dry run is read-only: the target is untouched.
    expect(await targetRowCount('dtx_region')).toBe(before);
  });

  it('matches the migration it predicted', async () => {
    const run = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const done = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    expect(done.status).toBe('COMPLETED');
    expect(done.created).toBe(21);
  });

  it('reports 21 unchanged and zero writes when source and target are identical', async () => {
    const pf = await runPreflight();
    expect(pf.totals.unchanged).toBe(21);
    expect(pf.totals.create).toBe(0);
    expect(pf.totals.update).toBe(0);

    const unchanged = await api.get<{ items: PreflightRecordDto[]; total: number }>(
      `/api/preflight/${pf.id}/records?action=UNCHANGED&limit=100`,
    );
    expect(unchanged.total).toBe(21);
    expect(unchanged.items.every((r) => r.changes.every((c) => c.action === 'UNCHANGED'))).toBe(true);
    expect(unchanged.items.every((r) => r.targetRecordId)).toBe(true);
  });

  it('reports exactly one update, with the field-level change, after one source edit', async () => {
    const [row] = await t.services.db
      .select()
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, 'demo-dev'), eq(demoRecords.logicalName, 'dtx_region')));
    const data = row.data as Record<string, unknown>;
    await t.services.db
      .update(demoRecords)
      .set({ data: { ...data, dtx_name: 'Renamed for preflight' } })
      .where(
        and(
          eq(demoRecords.environmentKey, 'demo-dev'),
          eq(demoRecords.logicalName, 'dtx_region'),
          eq(demoRecords.recordId, row.recordId),
        ),
      );

    const pf = await runPreflight();
    expect(pf.totals.update).toBe(1);
    expect(pf.totals.unchanged).toBe(20);
    expect(pf.totals.create).toBe(0);

    const updates = await api.get<{ items: PreflightRecordDto[] }>(
      `/api/preflight/${pf.id}/records?action=UPDATE`,
    );
    const change = updates.items[0].changes.find((c) => c.field === 'dtx_name')!;
    expect(change.sourceValue).toBe('Renamed for preflight');
    expect(change.targetValue).toBe(data.dtx_name);
    expect(change.action).toBe('SET');
    // Only the column that differs is proposed for the PATCH.
    expect(updates.items[0].changes.filter((c) => c.action !== 'UNCHANGED')).toHaveLength(1);
  });

  it('exports the preflight and the remediation package as Excel-safe CSV', async () => {
    const pf = await api.get<PreflightRunDto>(`/api/plans/${plan.id}/preflight`);
    const csv = async (url: string) => {
      const res = await t.app.inject({ method: 'GET', url, headers: { cookie: api.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      return res.body;
    };

    const preflightCsv = await csv(`/api/preflight/${pf.id}/records.csv?action=UPDATE`);
    expect(preflightCsv.startsWith('﻿')).toBe(true); // UTF-8 BOM for Excel
    expect(preflightCsv).toContain('Source value,Target value');
    expect(preflightCsv).toContain('Renamed for preflight');

    const packageCsv = await csv(`/api/plans/${plan.id}/issues-package.csv`);
    expect(packageCsv.split('\r\n')[0]).toBe(
      '﻿Severity,Category,Table,Source Record ID,Record Name,Field,Source Value,Target Value,Issue,Resolution,Suggested Action',
    );
    expect(packageCsv).toContain('Proposed update');
  });

  it('runs read-only diagnostics and never tests write permission', async () => {
    await api.put('/api/workspace', { sourceEnvironmentId: dev.id, targetEnvironmentId: uat.id });
    const report = await api.post<DiagnosticsReportDto>('/api/diagnostics', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    const byKey = new Map(report.checks.map((c) => [c.key, c]));
    expect(byKey.get('authentication')!.status).toBe('PASS');
    expect(byKey.get('sourceConnection')!.status).toBe('PASS');
    expect(byKey.get('targetConnection')!.status).toBe('PASS');
    expect(byKey.get('metadata')!.status).toBe('PASS');
    expect(byKey.get('records')!.status).toBe('PASS');
    expect(byKey.get('users')!.status).toBe('PASS');
    expect(byKey.get('write')!.status).toBe('NOT_TESTED');
    // No check may leak a token.
    expect(JSON.stringify(report)).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}/);
  });
});

describe('REAL_TENANT_READ_ONLY deployment', () => {
  it('reports read-only mode to the client so the banner can be shown', async () => {
    const t = await createTestApp({ REAL_TENANT_READ_ONLY: 'true' });
    const api = new ApiClient(t.app);
    await api.demoLogin();
    try {
      const session = await api.get<{ realTenantReadOnly: boolean }>('/api/auth/session');
      expect(session.realTenantReadOnly).toBe(true);
      const settings = await api.get<{ safety: { realTenantReadOnly: boolean } }>('/api/settings');
      expect(settings.safety.realTenantReadOnly).toBe(true);
      const authConfig = await api.get<{ realTenantReadOnly: boolean }>('/api/auth/config');
      expect(authConfig.realTenantReadOnly).toBe(true);
      const diagnostics = await api.post<DiagnosticsReportDto>('/api/diagnostics', {});
      expect(diagnostics.mode.realTenantReadOnly).toBe(true);
      expect(diagnostics.checks.find((c) => c.key === 'write')!.message).toContain('REAL_TENANT_READ_ONLY');
    } finally {
      await t.close();
    }
  });
});
