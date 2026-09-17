import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  PrincipalMappingSummaryDto,
  ValidationRunDto,
} from '../../shared/domain';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

describe('ownership/audit preservation, sync strategy and exports', () => {
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

  const demoRow = async (env: string, table: string, id: string) => {
    const [row] = await t.services.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.environmentKey, env),
          eq(demoRecords.logicalName, table),
          eq(demoRecords.recordId, id),
        ),
      );
    return row?.data as Record<string, { id: string } | string | null> | undefined;
  };

  let mapping: PrincipalMappingSummaryDto;
  it('matches users across environments even though their ids differ', async () => {
    mapping = await api.post<PrincipalMappingSummaryDto>('/api/principal-mappings/refresh', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      refreshDirectory: true,
    });
    const priya = mapping.mappings.find((m) => m.source.name === 'Priya Patel')!;
    expect(priya.status).toBe('AUTO_MATCHED');
    expect(priya.matchMethod).toBe('ENTRA_OBJECT_ID');
    // Different record ids for the same person: exactly why the map exists.
    expect(priya.target!.id).not.toBe(priya.source.id);
    // Users without Entra ids still match on login/email.
    expect(mapping.mappings.find((m) => m.source.name === 'Aisha Haddad')!.matchMethod).toBe('LOGIN');
    // The Development-only service account has nothing to map to.
    const legacy = mapping.mappings.find((m) => m.source.name === 'Legacy Integration Account')!;
    expect(legacy.status).toBe('UNMATCHED');
    expect(mapping.counts.unmatched).toBe(1);

    // Two target users share this display name, so the platform refuses to choose one.
    const jordan = mapping.mappings.find((m) => m.source.name === 'Jordan Lee')!;
    expect(jordan.status).toBe('AMBIGUOUS');
    expect(jordan.target).toBeNull();
    expect(jordan.candidates).toHaveLength(2);
    expect(mapping.counts.ambiguous).toBe(1);

    // A human can still resolve it explicitly.
    const resolved = await api.put('/api/principal-mappings', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      logicalName: 'systemuser',
      sourceId: jordan.source.id,
      targetId: jordan.candidates[0].id,
    });
    expect(resolved.status).toBe('MANUAL');

    const check = await api.post('/api/principal-mappings/impersonation-check', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    expect(check.canImpersonate).toBe(true);
  });

  let plan: MigrationPlanDto;
  let run: MigrationRunDto;
  it('migrates owner, created on and created by using the mapped users', async () => {
    plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'dtx_office'],
    });
    // STRICT is the default: the unmapped Development service account blocks the plan rather than
    // having its records silently reassigned.
    const strict = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, {
      conflictStrategy: 'SYNC',
      auditPolicy: 'PRESERVE_ATTRIBUTION',
    });
    expect(strict.options.userResolutionPolicy).toBe('STRICT');
    expect(strict.issues.map((i) => i.code)).toContain('PRINCIPALS_UNRESOLVED_STRICT');
    expect(strict.blockerCount).toBeGreaterThan(0);

    // FALLBACK requires an explicitly chosen identity; the executing user is never assumed.
    const noFallback = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, {
      userResolutionPolicy: 'FALLBACK',
    });
    expect(noFallback.issues.map((i) => i.code)).toContain('FALLBACK_NOT_CONFIGURED');

    const fallbackUser = mapping.targetPrincipals.systemuser.find((p) => !p.disabled)!;
    plan = await api.patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, {
      fallbackPrincipal: { logicalName: 'systemuser', id: fallbackUser.id, name: fallbackUser.name },
    });
    expect(plan.blockerCount).toBe(0);
    expect(plan.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'PRINCIPALS_FALLBACK',
        'AUDIT_IMPERSONATION',
        'MODIFIED_ON_NOT_PRESERVABLE',
        'AUDIT_EXTRA_WRITE',
        'SYNC_STRATEGY',
      ]),
    );

    run = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    run = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    expect(run.status).toBe('COMPLETED');
    expect(run.created).toBe(21);

    // Compare one office record end to end.
    const mapFor = (sourceUserId: string) =>
      mapping.mappings.find((m) => m.source.id === sourceUserId)?.target?.id ?? null;
    const offices = (await api.get(`/api/runs/${run.id}/records?entity=dtx_office&limit=50`)).items;
    let sourceRow!: Record<string, { id: string } | string | null>;
    let targetRow!: Record<string, { id: string } | string | null>;
    for (const candidate of offices) {
      const src = (await demoRow('demo-dev', 'dtx_office', candidate.sourceId))!;
      if (!mapFor((src.ownerid as { id: string }).id)) continue; // owner not mapped: covered below
      sourceRow = src;
      targetRow = (await demoRow('demo-uat', 'dtx_office', candidate.targetId))!;
      break;
    }
    expect(sourceRow).toBeDefined();

    expect(targetRow.createdon).toBe(sourceRow.createdon); // backdated via overriddencreatedon
    const sourceOwner = (sourceRow.ownerid as { id: string }).id;
    const targetOwner = (targetRow.ownerid as { id: string }).id;
    expect(targetOwner).toBe(mapFor(sourceOwner));
    expect(targetOwner).not.toBe(sourceOwner);
    const sourceCreatedBy = (sourceRow.createdby as { id: string }).id;
    expect((targetRow.createdby as { id: string }).id).toBe(mapFor(sourceCreatedBy));
    const sourceModifiedBy = (sourceRow.modifiedby as { id: string }).id;
    expect((targetRow.modifiedby as { id: string }).id).toBe(mapFor(sourceModifiedBy));
    // modifiedon is always the migration time: Dataverse does not allow writing it.
    expect(targetRow.modifiedon).not.toBe(sourceRow.modifiedon);

    // Records owned by the unmapped account use the configured fallback identity, and every
    // substitution is reported: an ownership substitution is never hidden.
    const warnings = await api.get(`/api/runs/${run.id}/errors?severity=WARNING`);
    expect(
      warnings.items.some((w: { errorCode: string }) => w.errorCode === 'PRINCIPAL_FALLBACK_APPLIED'),
    ).toBe(true);
  });

  it('sync leaves identical records untouched and updates only what changed', async () => {
    const before = await demoRow(
      'demo-uat',
      'dtx_region',
      (await api.get(`/api/runs/${run.id}/records?entity=dtx_region&limit=1`)).items[0].targetId,
    );

    const second = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const done = await api.get<MigrationRunDto>(`/api/runs/${second.id}`);
    expect(done.status).toBe('COMPLETED');
    expect(done.unchanged).toBe(21);
    expect(done.updated).toBe(0);
    expect(done.created).toBe(0);

    // Nothing was written, so the target audit stamps are untouched.
    const regionRecord = (await api.get(`/api/runs/${run.id}/records?entity=dtx_region&limit=1`)).items[0];
    const after = await demoRow('demo-uat', 'dtx_region', regionRecord.targetId);
    expect(after!.modifiedon).toBe(before!.modifiedon);

    // Change one source record: only that record is updated on the next run.
    const sourceRegion = await demoRow('demo-dev', 'dtx_region', regionRecord.sourceId);
    await t.services.db
      .update(demoRecords)
      .set({ data: { ...sourceRegion, dtx_name: 'Renamed in source' } })
      .where(
        and(
          eq(demoRecords.environmentKey, 'demo-dev'),
          eq(demoRecords.logicalName, 'dtx_region'),
          eq(demoRecords.recordId, regionRecord.sourceId),
        ),
      );
    const third = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const delta = await api.get<MigrationRunDto>(`/api/runs/${third.id}`);
    expect(delta.updated).toBe(1);
    expect(delta.unchanged).toBe(20);
    expect((await demoRow('demo-uat', 'dtx_region', regionRecord.targetId))!.dtx_name).toBe(
      'Renamed in source',
    );
  });

  it('exports issues, errors, records, comparisons and differences as CSV', async () => {
    const validation = await api.post<ValidationRunDto>('/api/validations', { migrationRunId: run.id });
    await worker.drain(180_000);

    const csv = async (url: string) => {
      const res = await t.app.inject({ method: 'GET', url, headers: { cookie: api.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(String(res.headers['content-disposition'])).toMatch(/attachment; filename=".+\.csv"/);
      return res.body;
    };

    const records = await csv(`/api/runs/${run.id}/records.csv`);
    expect(records.startsWith('﻿')).toBe(true);
    expect(records).toContain('Table,Source id,Target id,Outcome');
    expect(records.split('\r\n').length).toBeGreaterThan(21);

    expect(await csv(`/api/runs/${run.id}/errors.csv?severity=WARNING`)).toContain(
      'PRINCIPAL_FALLBACK_APPLIED',
    );
    expect(await csv(`/api/plans/${plan.id}/issues.csv`)).toContain('MODIFIED_ON_NOT_PRESERVABLE');
    expect(await csv(`/api/validations/${validation.id}/summary.csv`)).toContain('dtx_office');
    expect(await csv(`/api/validations/${validation.id}/differences.csv`)).toContain('Source value');
    expect(
      await csv(`/api/principal-mappings.csv?sourceEnvironmentId=${dev.id}&targetEnvironmentId=${uat.id}`),
    ).toContain('Priya Patel');

    const comparison = await api.post('/api/comparisons', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    await worker.drain(180_000);
    expect(await csv(`/api/comparisons/${comparison.id}/tables.csv`)).toContain(
      'Table,Display name,Table status',
    );
  });

  it('validates the preserved ownership and audit fields', async () => {
    const validation = await api.post<ValidationRunDto>('/api/validations', { migrationRunId: run.id });
    await worker.drain(180_000);
    const report = await api.get<ValidationRunDto>(`/api/validations/${validation.id}`);
    const office = report.entities.find((e) => e.logicalName === 'dtx_office')!;
    // Owner / created by / created on are compared through the principal map and match.
    expect(office.different).toBe(0);
    expect(office.checks.find((c) => c.check === 'FIELD_VALUES')!.outcome).toBe('PASS');
  });
});
