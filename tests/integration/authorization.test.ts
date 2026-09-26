import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationScheduleDto } from '../../shared/domain';
import { users } from '../../server/src/db/schema';
import { requireAdmin, requireAdminForProductionTarget } from '../../server/src/services/authorization';
import type { RequestContext } from '../../server/src/services/context';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Who may do what.
 *
 * The role was on every request and checked in two places, so in practice any member could delete a
 * connection and its stored credential, or create a schedule that writes to production unattended.
 *
 * The policy is deliberately narrow: members are the people who do the work, so membership is enough
 * to plan, analyse, preflight and migrate to a sandbox. What needs an administrator is the small set
 * of actions whose consequences outlive the task — writing to production, writing unattended, and
 * destroying configuration other people depend on. These tests pin both halves: what is refused, and
 * just as importantly what is still allowed.
 */

const ctxWith = (role: 'ADMIN' | 'MEMBER'): RequestContext => ({
  userId: 'u',
  organizationId: 'o',
  role,
  isDemoOrg: false,
  displayName: 'Test',
  requestId: 'r',
});

describe('the policy itself', () => {
  it('lets an administrator through, and names what a member cannot do', () => {
    expect(() => requireAdmin(ctxWith('ADMIN'), 'Deleting a connection')).not.toThrow();
    expect(() => requireAdmin(ctxWith('MEMBER'), 'Deleting a connection')).toThrow(/needs an administrator/);
    // The refusal says what was refused rather than just "forbidden".
    expect(() => requireAdmin(ctxWith('MEMBER'), 'Firing a schedule')).toThrow(/firing a schedule/i);
  });

  it('lets a member migrate to a sandbox but not to production', () => {
    const member = ctxWith('MEMBER');
    expect(() =>
      requireAdminForProductionTarget(member, { environmentType: 'Sandbox', displayName: 'QA' }, 'Migrating'),
    ).not.toThrow();
    expect(() =>
      requireAdminForProductionTarget(
        member,
        { environmentType: 'Developer', displayName: 'Dev' },
        'Migrating',
      ),
    ).not.toThrow();
    expect(() =>
      requireAdminForProductionTarget(
        member,
        { environmentType: 'Production', displayName: 'Live CRM' },
        'Migrating',
      ),
    ).toThrow(/production environment/);
  });

  it('treats an unclassified target as production, not as a sandbox', () => {
    // A hand-configured database carries no classification. "We could not tell" has to mean "assume
    // it matters" — the alternative makes every SQL target implicitly non-production, which is exactly
    // backwards for the one kind of target nobody labelled.
    expect(() =>
      requireAdminForProductionTarget(
        ctxWith('MEMBER'),
        { environmentType: null, displayName: 'sql01/BILLING' },
        'Migrating',
      ),
    ).toThrow(/not classified as non-production/);
    // An administrator is unaffected either way.
    expect(() =>
      requireAdminForProductionTarget(
        ctxWith('ADMIN'),
        { environmentType: null, displayName: 'sql01/BILLING' },
        'Migrating',
      ),
    ).not.toThrow();
  });
});

describe('the policy over the API', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let qa: EnvironmentDto;
  let plan: MigrationPlanDto;
  let scheduleId: string;

  /** Demotes the signed-in demo user, so the same session becomes a member. */
  const asMember = async () => {
    await t.services.db.update(users).set({ role: 'MEMBER' }).where(eq(users.role, 'ADMIN'));
  };
  const asAdmin = async () => {
    await t.services.db.update(users).set({ role: 'ADMIN' }).where(eq(users.role, 'MEMBER'));
  };

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
    plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Authorization',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['dtx_office'],
    });
    const schedule = await api.post<MigrationScheduleDto>(`/api/plans/${plan.id}/schedules`, {
      cron: '0 4 * * *',
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
    });
    scheduleId = schedule.id;
  });
  afterAll(async () => {
    await t.close();
  });

  it('refuses a member the actions that outlive the task', async () => {
    await asMember();
    try {
      // A standing grant to write unattended.
      await api.request(
        'POST',
        `/api/plans/${plan.id}/schedules`,
        {
          cron: '0 5 * * *',
          confirmSourceName: dev.displayName,
          confirmTargetName: qa.displayName,
        },
        403,
      );
      await api.request('PATCH', `/api/schedules/${scheduleId}`, { enabled: false }, 403);
      await api.request('POST', `/api/schedules/${scheduleId}/trigger`, {}, 403);
      await api.request('DELETE', `/api/schedules/${scheduleId}`, undefined, 403);
      // Destroying a stored credential and other people's configuration.
      const sqlConn = (await api.get<EnvironmentDto[]>('/api/environments')).find(
        (e) => e.connectionType !== 'DATAVERSE',
      );
      if (sqlConn) await api.request('DELETE', `/api/connections/${sqlConn.id}`, undefined, 403);
      // Resetting the demo data, which was already restricted.
      await api.request('POST', '/api/demo/reset', {}, 403);
    } finally {
      await asAdmin();
    }
  });

  it('still lets a member do the work', async () => {
    await asMember();
    try {
      // Everything a migration team actually does day to day stays open.
      await api.get(`/api/plans/${plan.id}`);
      await api.get('/api/projects');
      await api.get(`/api/plans/${plan.id}/schedules`);
      await api.get(`/api/plans/${plan.id}/lossy-transformations`);
      await api.post('/api/projects', {
        name: 'Member project',
        kind: 'ANALYSIS',
        sourceEnvironmentId: dev.id,
      });
      // And reading a schedule is not the same as changing one.
      await api.get(`/api/schedules/${scheduleId}`);
    } finally {
      await asAdmin();
    }
  });

  it('lets an administrator do all of it', async () => {
    const created = await api.post<MigrationScheduleDto>(`/api/plans/${plan.id}/schedules`, {
      cron: '0 6 * * *',
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
    });
    await api.patch(`/api/schedules/${created.id}`, { enabled: false });
    await api.request('DELETE', `/api/schedules/${created.id}`, undefined, 204);
  });
});
