import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ComparisonRunDto,
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  TableDiff,
  ValidationRunDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

describe('end-to-end workflow (DEMO MODE, API level)', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let qa: EnvironmentDto;
  let worker: ReturnType<TestApp['services']['createWorker']>;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('rejects unauthenticated access', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/environments' });
    expect(res.statusCode).toBe(401);
  });

  it('signs in with the demo account', async () => {
    const session = await api.demoLogin();
    expect(session.user.organization.isDemo).toBe(true);
    expect(session.user.role).toBe('ADMIN');
  });

  it('rejects state-changing requests without CSRF token', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/environments/discover', headers: { cookie: api.cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('discovers environments and tests connections', async () => {
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    expect(envs.map((e) => e.displayName)).toEqual(
      expect.arrayContaining(['DeepTrics Development', 'DeepTrics QA', 'DeepTrics UAT', 'DeepTrics Production']),
    );
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
    const prod = envs.find((e) => e.displayName === 'DeepTrics Production')!;
    expect((await api.post<EnvironmentDto>(`/api/environments/${dev.id}/test`)).connectionStatus).toBe('CONNECTED');
    expect((await api.post<EnvironmentDto>(`/api/environments/${qa.id}/test`)).connectionStatus).toBe('CONNECTED');
    const failed = await api.post<EnvironmentDto>(`/api/environments/${prod.id}/test`);
    expect(failed.connectionStatus).toBe('FAILED');
    expect(failed.connectionMessage).toContain('not a member');
  });

  it('stores the workspace and refuses identical source and target', async () => {
    await api.put('/api/workspace', { sourceEnvironmentId: dev.id, targetEnvironmentId: dev.id }, 400);
    const ws = await api.put('/api/workspace', { sourceEnvironmentId: dev.id, targetEnvironmentId: qa.id });
    expect(ws.source.id).toBe(dev.id);
    expect(ws.target.id).toBe(qa.id);
  });

  let comparisonId: string;
  it('analyzes schemas and classifies differences', async () => {
    const run = await api.post<ComparisonRunDto>('/api/comparisons', { sourceEnvironmentId: dev.id, targetEnvironmentId: qa.id });
    await worker.drain();
    const done = await api.get<ComparisonRunDto>(`/api/comparisons/${run.id}`);
    expect(done.status).toBe('COMPLETED');
    comparisonId = run.id;
    const tables = await api.get<TableDiff[]>(`/api/comparisons/${run.id}/tables`);
    const byName = new Map(tables.map((x) => [x.logicalName, x]));
    expect(byName.get('dtx_legacyimport')!.status).toBe('SOURCE_ONLY');
    expect(byName.get('dtx_auditnote')!.status).toBe('TARGET_ONLY');
    expect(byName.get('product')!.status).toBe('INCOMPATIBLE');
    expect(byName.get('product')!.columns.find((c) => c.logicalName === 'dtx_warrantymonths')!.status).toBe('INCOMPATIBLE');
    expect(byName.get('account')!.status).toBe('DIFFERENT');
    expect(byName.get('account')!.columns.find((c) => c.logicalName === 'dtx_tier')!.status).toBe('SOURCE_ONLY');
    expect(byName.get('contact')!.columns.find((c) => c.logicalName === 'dtx_preferredchannel')!.status).toBe('TARGET_ONLY');
    expect(byName.get('dtx_office')!.status).toBe('MATCH');
    expect(done.summary!.sourceOnly).toBeGreaterThan(0);
  });

  let plan: MigrationPlanDto;
  it('creates a plan with dependency order, cycles and mappings', async () => {
    const candidates = await api.get(`/api/migration/candidates?sourceEnvironmentId=${dev.id}&targetEnvironmentId=${qa.id}`);
    const account = candidates.find((c: { logicalName: string }) => c.logicalName === 'account');
    expect(account.sourceCount).toBe(120);
    expect(account.targetCount).toBe(15);

    plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['account', 'contact', 'dtx_region', 'dtx_office', 'dtx_applicationconfig', 'product'],
    });
    expect(plan.comparisonRunId).toBe(comparisonId);
    const order = plan.dependencyAnalysis!.order;
    expect(order.indexOf('dtx_region')).toBeLessThan(order.indexOf('dtx_office'));
    expect(order.indexOf('dtx_region')).toBeLessThan(order.indexOf('account'));
    expect(order.indexOf('account')).toBeLessThan(order.indexOf('contact'));
    expect(plan.dependencyAnalysis!.cycles.every((c) => c.resolvable)).toBe(true);
    const deferred = plan.dependencyAnalysis!.cycles.flatMap((c) => c.deferredEdges.map((e) => `${e.from}.${e.attribute}`));
    expect(deferred).toEqual(expect.arrayContaining(['account.parentaccountid', 'account.primarycontactid', 'dtx_region.dtx_headofficeid']));
    expect(plan.blockerCount).toBe(0);
    expect(plan.issues.some((i) => i.code === 'SERVER_SIDE_LOGIC')).toBe(true);
    const product = plan.entities.find((e) => e.logicalName === 'product')!;
    expect(product.matchStrategy).toBe('ALTERNATE_KEY');
    expect(product.mappingSummary.INCOMPATIBLE).toBe(1);

    const mappings = await api.get(`/api/plans/${plan.id}/entities/${plan.entities.find((e) => e.logicalName === 'account')!.id}/mappings`);
    const tier = mappings.mappings.find((m: { sourceField: string }) => m.sourceField === 'dtx_tier');
    expect(tier.status).toBe('UNMAPPED');
    expect(mappings.mappings.find((m: { sourceField: string }) => m.sourceField === 'ownerid').status).toBe('IGNORED');
  });

  it('blocks execution when a blocker exists and without confirmation', async () => {
    const withLegacy = await api.put<MigrationPlanDto>(`/api/plans/${plan.id}/tables`, {
      tables: [...plan.entities.map((e) => e.logicalName), 'dtx_legacyimport'],
    });
    expect(withLegacy.issues.some((i) => i.severity === 'BLOCKER' && i.code === 'TABLE_MISSING_IN_TARGET')).toBe(true);
    await api.post(`/api/plans/${plan.id}/execute`, { confirmSourceName: 'DeepTrics Development', confirmTargetName: 'DeepTrics QA', acknowledgeWarnings: true }, 409);
    plan = await api.put<MigrationPlanDto>(`/api/plans/${plan.id}/tables`, { tables: plan.entities.map((e) => e.logicalName) });
    expect(plan.blockerCount).toBe(0);
    await api.post(`/api/plans/${plan.id}/execute`, { confirmSourceName: 'Wrong', confirmTargetName: 'DeepTrics QA', acknowledgeWarnings: true }, 400);
  });

  let run: MigrationRunDto;
  it('executes the migration with per-record failures, lookups and two passes', async () => {
    run = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: 'DeepTrics Development',
      confirmTargetName: 'DeepTrics QA',
      acknowledgeWarnings: true,
    });
    expect(run.status).toBe('QUEUED');
    await worker.drain(120_000);
    run = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    expect(run.status).toBe('COMPLETED_WITH_ERRORS');
    const e = (n: string) => run.entities.find((x) => x.logicalName === n)!;
    // Pre-existing QA accounts are skipped; accounts with website > 100 chars or industry 7 fail.
    expect(e('account').skipped).toBe(15);
    expect(e('account').failed).toBeGreaterThan(0);
    expect(e('account').created + e('account').skipped + e('account').failed).toBe(120);
    // Products: 5 key-matched existing (different ids) are skipped, 35 created.
    expect(e('product').skipped).toBe(5);
    expect(e('product').created).toBe(35);
    // Config: routing rules value too long for QA (500 chars).
    expect(e('dtx_applicationconfig').failed).toBe(1);
    expect(e('dtx_office').created).toBe(15);
    expect(e('dtx_region').deferredResolved).toBeGreaterThan(0);
    expect(e('account').deferredResolved).toBeGreaterThan(0);

    const errors = await api.get(`/api/runs/${run.id}/errors?severity=ERROR`);
    expect(errors.total).toBe(run.failed);
    expect(errors.items.some((x: { errorCode: string }) => x.errorCode.startsWith('VALIDATION'))).toBe(true);
    const retryable = await api.get(`/api/runs/${run.id}/errors?kind=retryable&severity=ERROR`);
    expect(retryable.items.every((x: { retryable: boolean }) => x.retryable)).toBe(true);

    const records = await api.get(`/api/runs/${run.id}/records?entity=account&outcome=CREATED&limit=5`);
    expect(records.items[0].targetId).toBe(records.items[0].sourceId);
  });

  it('retries safely without duplicating data', async () => {
    const before = run;
    await api.post(`/api/runs/${run.id}/retry`);
    await worker.drain(120_000);
    const after = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    expect(after.attempt).toBe(2);
    expect(after.created).toBe(before.created);
    expect(after.failed).toBe(before.failed);
  });

  it('previews rollback impact without executing deletions', async () => {
    const preview = await api.get(`/api/runs/${run.id}/rollback-preview`);
    expect(preview.executionStatus).toBe('NOT_YET_SUPPORTED');
    expect(preview.entities.find((x: { entity: string }) => x.entity === 'account').created).toBe(run.entities.find((x) => x.logicalName === 'account')!.created);
    expect(preview.deletionOrder[preview.deletionOrder.length - 1]).toBe(run.entities[0].logicalName);
  });

  let validation: ValidationRunDto;
  it('validates source vs target after migration', async () => {
    validation = await api.post<ValidationRunDto>('/api/validations', { migrationRunId: run.id });
    await worker.drain(120_000);
    validation = await api.get<ValidationRunDto>(`/api/validations/${validation.id}`);
    expect(validation.status).toBe('COMPLETED');
    expect(validation.outcome).toBe('FAIL');
    const office = validation.entities.find((x) => x.logicalName === 'dtx_office')!;
    expect(office.outcome).toBe('PASS');
    expect(office.matched).toBe(15);
    const account = validation.entities.find((x) => x.logicalName === 'account')!;
    expect(account.missing).toBeGreaterThan(0);
    expect(account.brokenReferences).toBe(0);
    const diffs = await api.get(`/api/validations/${validation.id}/differences?entity=account&type=PRE_EXISTING_DIFFERENCE`);
    expect(diffs.total).toBeGreaterThan(0);
    expect(diffs.items.some((d: { field: string }) => d.field === 'telephone1')).toBe(true);
    const contact = validation.entities.find((x) => x.logicalName === 'contact')!;
    const nationalId = await api.get(`/api/validations/${validation.id}/differences?entity=contact`);
    for (const d of nationalId.items.filter((x: { field: string }) => x.field === 'dtx_nationalid')) {
      expect(d.sourceValue).toContain('secured');
    }
    expect(contact.checks.find((c) => c.check === 'FIELD_VALUES')).toBeTruthy();
  });

  it('keeps data isolated between organizations (IDOR protection)', async () => {
    const t2 = await createTestApp();
    try {
      // A different database represents another tenant; ids from this tenant must 404 there.
      const other = new ApiClient(t2.app);
      await other.demoLogin();
      await other.get(`/api/runs/${run.id}`, 404);
      await other.get(`/api/validations/${validation.id}`, 404);
      await other.get(`/api/plans/${plan.id}`, 404);
    } finally {
      await t2.close();
    }
    // Same database, another organization.
    const { organizations, users, sessions } = await import('../../server/src/db/schema');
    const { sha256 } = await import('../../server/src/lib/crypto');
    const db = t.services.db;
    const [org] = await db.insert(organizations).values({ name: 'Other Corp', entraTenantId: '00000000-0000-0000-0000-000000000001' }).returning();
    const [user] = await db
      .insert(users)
      .values({ organizationId: org.id, externalId: 'other', authProvider: 'microsoft', displayName: 'Other', role: 'ADMIN' })
      .returning();
    await db.insert(sessions).values({ id: sha256('other-token'), userId: user.id, csrfToken: 'x', expiresAt: new Date(Date.now() + 3600_000) });
    const intruder = new ApiClient(t.app);
    intruder.cookie = 'dvm_session=other-token';
    intruder.csrf = 'x';
    await intruder.get(`/api/runs/${run.id}`, 404);
    await intruder.get(`/api/plans/${plan.id}`, 404);
    await intruder.get(`/api/validations/${validation.id}`, 404);
    await intruder.post(`/api/runs/${run.id}/retry`, {}, 404);
    await intruder.post(`/api/environments/${dev.id}/test`, {}, 404);
    expect(await intruder.get('/api/runs')).toEqual([]);
  });

  it('records an audit trail and dashboard data', async () => {
    const audit = await api.get('/api/audit');
    const actions = new Set(audit.map((a: { action: string }) => a.action));
    for (const a of ['AUTH_SIGN_IN', 'ENVIRONMENTS_DISCOVERED', 'ENVIRONMENT_CONNECTION_TESTED', 'COMPARISON_REQUESTED', 'MIGRATION_PLAN_CREATED', 'MIGRATION_EXECUTION_REQUESTED', 'MIGRATION_RETRY_REQUESTED', 'VALIDATION_REQUESTED']) {
      expect(actions.has(a)).toBe(true);
    }
    const dash = await api.get('/api/dashboard');
    expect(dash.migrationRuns.total).toBe(1);
    expect(dash.validationRuns.fail).toBe(1);
    expect(dash.lastComparison.id).toBe(comparisonId);
  });
});
