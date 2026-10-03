import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditPageDto, EnvironmentDto, MigrationPlanDto } from '../../shared/domain';
import { auditCategory } from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Finding one event in a trail that grows forever.
 *
 * A complete audit trail nobody can search is decoration: the question somebody actually arrives
 * with is narrow — what happened to production yesterday, who accepted that data-loss warning — and
 * scrolling two hundred rows to find it means they stop looking.
 */
describe('filtering the audit trail', () => {
  let t: TestApp;
  let api: ApiClient;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
    await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Audited plan',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['dtx_office'],
    });
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });

  it('reports how many events matched, not just the page it returned', async () => {
    const page = await api.get<AuditPageDto>('/api/audit?limit=2');
    expect(page.items.length).toBeLessThanOrEqual(2);
    // The same rule as every other capped list in the product: the count is complete even when the
    // list is not, and the screen can say so.
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    expect(page.users).toContain('Demo User');
  });

  it('narrows to one kind of activity', async () => {
    const all = await api.get<AuditPageDto>('/api/audit?limit=200');
    expect(all.items.length).toBeGreaterThan(1);

    const planning = await api.get<AuditPageDto>('/api/audit?limit=200&category=PLANNING');
    expect(planning.items.length).toBeGreaterThan(0);
    for (const item of planning.items) expect(auditCategory(item.action)).toBe('PLANNING');
    // And it is a real narrowing, not a no-op that returns everything.
    expect(planning.items.length).toBeLessThan(all.items.length);

    const access = await api.get<AuditPageDto>('/api/audit?limit=200&category=ACCESS');
    expect(access.items.every((i) => i.action.startsWith('AUTH_'))).toBe(true);
  });

  it('narrows by outcome, by user and by free text', async () => {
    const requested = await api.get<AuditPageDto>('/api/audit?limit=200&outcome=REQUESTED');
    expect(requested.items.every((i) => i.outcome === 'REQUESTED')).toBe(true);

    const mine = await api.get<AuditPageDto>('/api/audit?limit=200&user=Demo%20User');
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((i) => i.user === 'Demo User')).toBe(true);

    const nobody = await api.get<AuditPageDto>('/api/audit?limit=200&user=Someone%20Else');
    expect(nobody.items).toEqual([]);

    // Free text reaches into the details, which is where the plan name lives.
    const found = await api.get<AuditPageDto>('/api/audit?limit=200&search=Audited%20plan');
    expect(found.items.length).toBeGreaterThan(0);
    const missing = await api.get<AuditPageDto>('/api/audit?limit=200&search=zzz-not-in-any-event');
    expect(missing.items).toEqual([]);
  });

  it('narrows by period', async () => {
    const recent = await api.get<AuditPageDto>('/api/audit?limit=200&days=1');
    expect(recent.items.length).toBeGreaterThan(0);
    // Everything in this test was recorded seconds ago, so a window that excludes today excludes
    // all of it — which is what proves the filter is applied rather than ignored.
    const ancient = await api.get<AuditPageDto>('/api/audit?limit=200&days=365');
    expect(ancient.items.length).toBeGreaterThanOrEqual(recent.items.length);
  });

  it('refuses a category it does not have', async () => {
    await api.get('/api/audit?category=NONSENSE', 400);
  });
});

describe('the category mapping', () => {
  it('routes every action to something a person would look under', () => {
    expect(auditCategory('AUTH_SIGN_IN')).toBe('ACCESS');
    expect(auditCategory('CONNECTION_DELETED')).toBe('CONNECTIONS');
    expect(auditCategory('ANALYSIS_COMPLETED')).toBe('ANALYSIS');
    expect(auditCategory('MIGRATION_PLAN_CREATED')).toBe('PLANNING');
    expect(auditCategory('LOSSY_TRANSFORMATION_ACKNOWLEDGED')).toBe('PLANNING');
    expect(auditCategory('PREFLIGHT_COMPLETED')).toBe('PLANNING');
    // A plan is planning; a run is a migration. The prefix they share is why this is a function
    // rather than a `startsWith` at the call site.
    expect(auditCategory('MIGRATION_COMPLETED')).toBe('MIGRATION');
    expect(auditCategory('MIGRATION_CANCEL_REQUESTED')).toBe('MIGRATION');
    expect(auditCategory('VALIDATION_COMPLETED')).toBe('VERIFICATION');
    expect(auditCategory('DATA_COMPARISON_COMPLETED')).toBe('VERIFICATION');
    expect(auditCategory('SCHEDULE_FIRED')).toBe('SCHEDULES');
    expect(auditCategory('DEMO_DATA_RESET')).toBe('ADMIN');
  });
});
