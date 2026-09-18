import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  LossyTransformationDto,
  MigrationPlanDto,
  MigrationRunDto,
  PreflightRunDto,
  PreviewRecordDto,
  TableProfileDto,
  TransformationRule,
  TransformPreviewDto,
  ValidationRunDto,
} from '../../shared/domain';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The contract this whole feature rests on: preview, preflight, migration and validation agree,
 * because they run the same engine over the same rules.
 *
 * The scenario is the real one — a legacy SQL database whose names are padded, whose emails are
 * mixed-case and blank, and whose flags are Y/N — migrated into Dataverse.
 */
describe('transformation pipeline: profile, clean, preflight, migrate, validate', () => {
  let t: TestApp;
  let api: ApiClient;
  let sqlConn: EnvironmentDto;
  let qa: EnvironmentDto;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let plan: MigrationPlanDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    sqlConn = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;

    plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Clean the legacy customers',
      sourceEnvironmentId: sqlConn.id,
      targetEnvironmentId: qa.id,
      tables: ['dbo.Customer'],
    });
    plan = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, {
      conflictStrategy: 'SYNC',
    });
    plan = await api.patch<MigrationPlanDto>(
      `/api/plans/${plan.id}/entities/${entityOf(plan).id}/object-mapping`,
      { targetLogicalName: 'account', status: 'CONFIRMED' },
    );
    await mapField('CustomerName', 'name');
    await mapField('CustomerNumber', 'accountnumber');
    await mapField('Email', 'emailaddress1');
    plan = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/entities/${entityOf(plan).id}`, {
      matchStrategy: 'BUSINESS_KEY',
      alternateKey: null,
      businessKeyFields: ['accountnumber'],
    });
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  const entityOf = (p: MigrationPlanDto) => p.entities.find((e) => e.logicalName === 'dbo.Customer')!;

  const mappingId = async (sourceField: string) => {
    const { mappings } = await api.get<{ mappings: { id: string; sourceField: string }[] }>(
      `/api/plans/${plan.id}/entities/${entityOf(plan).id}/mappings`,
    );
    return mappings.find((m) => m.sourceField === sourceField)!.id;
  };

  const mapField = async (sourceField: string, targetField: string) => {
    plan = await api.patch<MigrationPlanDto>(
      `/api/plans/${plan.id}/mappings/${await mappingId(sourceField)}`,
      {
        action: 'MAP',
        targetField,
      },
    );
  };

  const setPipeline = async (sourceField: string, rules: TransformationRule[]) => {
    plan = await api.patch<MigrationPlanDto>(
      `/api/plans/${plan.id}/mappings/${await mappingId(sourceField)}/transformations`,
      { rules },
    );
  };

  const runPreflight = async () => {
    const started = await api.post<PreflightRunDto>(`/api/plans/${plan.id}/preflight`);
    await worker.drain(180_000);
    return api.get<PreflightRunDto>(`/api/preflight/${started.id}`);
  };

  const execute = async () => {
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: sqlConn.displayName,
      confirmTargetName: qa.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };

  const accounts = () =>
    t.services.db
      .select()
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, 'demo-qa'), eq(demoRecords.logicalName, 'account')));

  // ---------------------------------------------------------------------------

  it('profiles the source and finds the problems before anything is migrated', async () => {
    const profile = await api.post<TableProfileDto>(
      `/api/plans/${plan.id}/entities/${entityOf(plan).id}/profile`,
      { full: true },
    );
    expect(profile.basis).toBe('EXACT');
    expect(profile.totalRecords).toBe(26);

    const name = profile.fields.find((f) => f.field === 'CustomerName')!;
    // Padded names are visible as a statistic, not as a surprise during migration.
    expect(name.whitespaceCount).toBeGreaterThan(0);
    const email = profile.fields.find((f) => f.field === 'Email')!;
    expect(email.nullCount).toBeGreaterThan(0);
    expect(email.blankCount).toBeGreaterThan(0);

    // The target requires a name, and one source record has only whitespace.
    const missing = [...profile.issues, ...profile.fields.flatMap((f) => f.issues)].find(
      (i) => i.code === 'REQUIRED_VALUE_MISSING' || i.code === 'BLANK_VALUE',
    );
    expect(missing).toBeTruthy();
  });

  it('previews a pipeline over real values before it is saved', async () => {
    const preview = await api.post<TransformPreviewDto>(
      `/api/plans/${plan.id}/mappings/${await mappingId('Email')}/preview`,
      { rules: [{ kind: 'TRIM' }, { kind: 'LOWERCASE' }, { kind: 'EMPTY_TO_NULL' }] },
    );
    expect(preview.previewed).toBeGreaterThan(3);
    const mixedCase = preview.rows.find((r) => r.sourceValue?.includes('EXAMPLE.COM'));
    expect(mixedCase).toBeTruthy();
    expect(mixedCase!.transformedValue).toBe(mixedCase!.sourceValue!.trim().toLowerCase());
    // A blank string becomes null, and the preview says which rules did it.
    const blank = preview.rows.find((r) => r.sourceValue === '');
    expect(blank?.transformedValue).toBeNull();
    expect(blank?.applied.map((a) => a.kind)).toContain('EMPTY_TO_NULL');
  });

  it('shows a record-level before and after', async () => {
    await setPipeline('CustomerName', [{ kind: 'TRIM' }]);
    await setPipeline('Email', [{ kind: 'TRIM' }, { kind: 'LOWERCASE' }, { kind: 'EMPTY_TO_NULL' }]);

    const preview = await api.get<PreviewRecordDto[]>(
      `/api/plans/${plan.id}/entities/${entityOf(plan).id}/preview?limit=10`,
    );
    const padded = preview.find((r) => r.fields.some((f) => f.field === 'CustomerName' && f.applied.length));
    expect(padded).toBeTruthy();
    const nameField = padded!.fields.find((f) => f.field === 'CustomerName')!;
    expect(nameField.sourceValue).not.toBe(nameField.transformedValue);
    expect(nameField.transformedValue).toBe(nameField.sourceValue!.trim());
    // Nothing exists in the target yet.
    expect(padded!.action).toBe('CREATE');
  });

  it('blocks the records a transformation cannot rescue', async () => {
    const preflight = await runPreflight();
    const blocked = await api.get<{ items: { reasonCode: string; reason: string }[] }>(
      `/api/preflight/${preflight.id}/records?action=BLOCKED`,
    );
    // The whitespace-only name becomes null after TRIM, and the target requires a name.
    expect(blocked.items.some((b) => b.reasonCode === 'REQUIRED_VALUE_MISSING')).toBe(true);
    expect(preflight.totals.blocked).toBeGreaterThan(0);
    expect(preflight.totals.create).toBeGreaterThan(20);
  });

  it('migrates the transformed values', async () => {
    const run = await execute();
    expect(['COMPLETED', 'COMPLETED_WITH_ERRORS']).toContain(run.status);
    expect(run.created).toBeGreaterThan(20);

    const written = (await accounts()).filter((r) =>
      String((r.data as Record<string, string>).accountnumber ?? '').startsWith('CUST-'),
    );
    // Not one migrated name carries the source padding.
    expect(
      written.every(
        (r) => (r.data as Record<string, string>).name?.trim() === (r.data as Record<string, string>).name,
      ),
    ).toBe(true);
    // Emails are lowercase, and a blank source email became a real null.
    const emails = written.map((r) => (r.data as Record<string, string | null>).emailaddress1);
    expect(emails.some((e) => e === null)).toBe(true);
    expect(emails.every((e) => e === null || e === e.toLowerCase())).toBe(true);
  });

  it('reports UNCHANGED and writes nothing when only the raw source differs cosmetically', async () => {
    // The source still holds "  Northwind Industries 1  "; the target holds the trimmed value.
    // The comparison is between the TRANSFORMED source and the target, so nothing differs.
    const before = await accounts();
    const preflight = await runPreflight();
    expect(preflight.totals.unchanged).toBeGreaterThan(20);
    expect(preflight.totals.create).toBe(0);
    expect(preflight.totals.update).toBe(0);

    const run = await execute();
    expect(run.created).toBe(0);
    expect(run.updated).toBe(0);
    expect(run.unchanged).toBeGreaterThan(20);

    const after = await accounts();
    expect(JSON.stringify(after.map((r) => r.data))).toBe(JSON.stringify(before.map((r) => r.data)));
  });

  it('updates exactly one field when the transformed value actually changes', async () => {
    const [row] = await t.services.db
      .select()
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, 'demo-sql'), eq(demoRecords.logicalName, 'dbo.Customer')));
    const data = row.data as Record<string, unknown>;
    // A cosmetic-only change: more padding around the same name. Nothing should be written.
    await t.services.db
      .update(demoRecords)
      .set({ data: { ...data, CustomerName: `    ${String(data.CustomerName).trim()}    ` } })
      .where(
        and(
          eq(demoRecords.environmentKey, 'demo-sql'),
          eq(demoRecords.logicalName, 'dbo.Customer'),
          eq(demoRecords.recordId, row.recordId),
        ),
      );
    let preflight = await runPreflight();
    expect(preflight.totals.update).toBe(0);

    // A real change: a different name.
    await t.services.db
      .update(demoRecords)
      .set({ data: { ...data, CustomerName: '  Renamed In Legacy  ' } })
      .where(
        and(
          eq(demoRecords.environmentKey, 'demo-sql'),
          eq(demoRecords.logicalName, 'dbo.Customer'),
          eq(demoRecords.recordId, row.recordId),
        ),
      );
    preflight = await runPreflight();
    expect(preflight.totals.update).toBe(1);
    const updates = await api.get<{ items: { changes: { field: string; sourceValue: string | null }[] }[] }>(
      `/api/preflight/${preflight.id}/records?action=UPDATE`,
    );
    const changes = updates.items[0].changes.filter((c) => c.field === 'name');
    // The preflight reports the TRANSFORMED value, which is what will be written.
    expect(changes[0].sourceValue).toBe('Renamed In Legacy');

    const run = await execute();
    expect(run.updated).toBe(1);
    expect(run.created).toBe(0);
    const written = await accounts();
    expect(written.some((r) => (r.data as Record<string, string>).name === 'Renamed In Legacy')).toBe(true);
  });

  it('validates the transformed source against the target', async () => {
    // /api/runs returns the list newest first.
    const runs = await api.get<{ id: string }[]>('/api/runs');
    const validation = await api.post<ValidationRunDto>('/api/validations', { migrationRunId: runs[0].id });
    await worker.drain(180_000);
    const report = await api.get<ValidationRunDto>(`/api/validations/${validation.id}`);
    expect(report.status).toBe('COMPLETED');
    const customers = report.entities.find((e) => e.logicalName === 'dbo.Customer')!;
    // Raw source values still carry padding; comparing those would report every record as
    // different. Comparing the transformed values matches.
    expect(customers.different).toBe(0);
    expect(customers.matched).toBeGreaterThan(20);
  });

  it('requires a lossy transformation to be acknowledged before it can run', async () => {
    await setPipeline('CustomerName', [{ kind: 'TRIM' }, { kind: 'TRUNCATE', length: 10 }]);
    const lossy = await api.get<LossyTransformationDto[]>(`/api/plans/${plan.id}/lossy-transformations`);
    expect(lossy).toHaveLength(1);
    expect(lossy[0]).toMatchObject({ field: 'CustomerName', kind: 'TRUNCATE' });

    await api.request(
      'POST',
      `/api/plans/${plan.id}/execute`,
      {
        confirmSourceName: sqlConn.displayName,
        confirmTargetName: qa.displayName,
        acknowledgeWarnings: true,
      },
      400,
    );

    plan = await api.post<MigrationPlanDto>(`/api/plans/${plan.id}/lossy-transformations/acknowledge`, {
      accepted: lossy.map((l) => l.key),
    });
    expect(plan.options.lossyAcknowledgement?.accepted).toEqual(lossy.map((l) => l.key));

    const run = await execute();
    expect(['COMPLETED', 'COMPLETED_WITH_ERRORS']).toContain(run.status);
    // Every MIGRATED name now fits the configured limit. The QA environment also holds accounts
    // that were there before this migration; those are not ours to judge.
    const migrated = (await accounts()).filter((r) =>
      String((r.data as Record<string, string>).accountnumber ?? '').startsWith('CUST-'),
    );
    expect(migrated.length).toBeGreaterThan(20);
    expect(migrated.every((r) => ((r.data as Record<string, string>).name ?? '').length <= 10)).toBe(true);
  });

  it('exports the data quality findings', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/plans/${plan.id}/data-quality.csv`,
      headers: { cookie: api.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.startsWith('﻿')).toBe(true);
    expect(res.body.split('\r\n')[0]).toContain('Severity,Category,Source Connection,Source Table');
    expect(res.body).toContain('dbo.Customer');
  });
});
