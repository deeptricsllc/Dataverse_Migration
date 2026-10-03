import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ProjectDto,
  ValidationRunDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Two people evaluating the product at the same time must not meet each other.
 *
 * Every demo visitor used to arrive in one shared organization, and the simulated Dataverse and SQL
 * Server rows were keyed by environment alone — so they were shared too. A prospect who migrated
 * 441 records into the simulated UAT left them sitting there for the next prospect, whose "empty
 * target" was not empty and whose first migration reported most of its work as already done.
 *
 * The fix reuses the boundary the product already enforces on every query rather than inventing a
 * second one: a demo sign-in creates an organization. These tests are written as the second
 * evaluator trying to reach the first one's work, because a boundary nobody attacks is a boundary
 * nobody has tested.
 */
describe('one evaluator cannot see another', () => {
  let t: TestApp;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  /** Two demo sign-ins, as two browsers would produce. */
  let first: ApiClient;
  let second: ApiClient;
  let firstOrgId = '';
  let secondOrgId = '';

  const owned = { projectId: '', planId: '', runId: '', validationId: '', envId: '' };

  const orgIdOf = async (api: ApiClient) =>
    (await api.get<{ user: { organization: { id: string } } }>('/api/auth/session')).user.organization.id;

  beforeAll(async () => {
    t = await createTestApp();
    worker = t.services.createWorker();

    first = new ApiClient(t.app);
    await first.demoLogin();
    firstOrgId = await orgIdOf(first);

    second = new ApiClient(t.app);
    await second.demoLogin();
    secondOrgId = await orgIdOf(second);

    // The first evaluator does a real migration into the simulated UAT.
    const envs = await first.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    owned.envId = dev.id;

    const project = await first.post<ProjectDto>('/api/projects', {
      name: 'First evaluator migration',
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    owned.projectId = project.id;
    const plan = await first.post<MigrationPlanDto>('/api/plans', {
      name: 'First evaluator plan',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region'],
      projectId: project.id,
    });
    owned.planId = plan.id;
    const started = await first.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    owned.runId = started.id;
    const run = await first.get<MigrationRunDto>(`/api/runs/${started.id}`);
    expect(run.created, 'the first evaluator really did write records').toBeGreaterThan(0);

    const validation = await first.post<ValidationRunDto>('/api/validations', {
      migrationRunId: started.id,
    });
    await worker.drain(180_000);
    owned.validationId = validation.id;
  }, 300_000);

  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('gives each sign-in its own workspace', () => {
    expect(firstOrgId).toBeTruthy();
    expect(secondOrgId).toBeTruthy();
    expect(secondOrgId, 'two demo sign-ins are two workspaces').not.toBe(firstOrgId);
  });

  it('does not let one evaluator find the records another migrated', async () => {
    // The heart of it, asserted through behaviour rather than a count: the second evaluator runs
    // the same migration into the same simulated UAT. If the two workspaces shared the simulated
    // data, every record would already be there and the run would skip them. It creates them,
    // which is only possible if this workspace's UAT was empty.
    //
    // It also proves the source side is seeded per workspace: there is nothing to create unless
    // this evaluator has their own copy of Development's records.
    const envs = await second.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    const plan = await second.post<MigrationPlanDto>('/api/plans', {
      name: 'Second evaluator plan',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region'],
    });
    const started = await second.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const run = await second.get<MigrationRunDto>(`/api/runs/${started.id}`);

    const theirs = await first.get<MigrationRunDto>(`/api/runs/${owned.runId}`);
    expect(run.total, 'the same source rows are there for this evaluator too').toBe(theirs.total);
    expect(run.created, 'this evaluator migrated into their own empty target').toBe(theirs.created);
    expect(run.skipped, 'nothing was already there from the other evaluator').toBe(0);
  }, 300_000);

  /** Raw inject, because the helper throws on an unexpected status and the status is the point. */
  const asSecond = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) =>
    t.app.inject({
      method,
      url,
      payload: body as never,
      headers: {
        cookie: second.cookie,
        ...(method === 'GET' ? {} : { 'x-csrf-token': second.csrf }),
      },
    });

  it('refuses every attempt to read the other workspace by id', async () => {
    for (const url of [
      `/api/projects/${owned.projectId}`,
      `/api/projects/${owned.projectId}/plans`,
      `/api/plans/${owned.planId}`,
      `/api/runs/${owned.runId}`,
      `/api/runs/${owned.runId}/errors`,
      `/api/runs/${owned.runId}/records`,
      `/api/validations/${owned.validationId}`,
      `/api/validations/${owned.validationId}/differences`,
      `/api/environments/${owned.envId}/tables`,
    ]) {
      const res = await asSecond('GET', url);
      expect([403, 404], `${url} must not answer another workspace`).toContain(res.statusCode);
      // Never a body either: a 200 with an empty list is still an answer about somebody else's data.
      expect(res.body ?? '').not.toContain(owned.planId);
    }
  });

  it('refuses every attempt to change the other workspace', async () => {
    for (const [method, url, body] of [
      ['PATCH', `/api/projects/${owned.projectId}`, { name: 'Taken' }],
      ['POST', `/api/projects/${owned.projectId}/archive`, {}],
      ['PATCH', `/api/plans/${owned.planId}/options`, { conflictStrategy: 'SYNC' }],
      ['POST', `/api/plans/${owned.planId}/execute`, { acknowledgeWarnings: true, confirmed: true }],
      ['POST', `/api/runs/${owned.runId}/cancel`, {}],
      ['POST', '/api/validations', { migrationRunId: owned.runId }],
    ] as const) {
      const res = await asSecond(method, url, body);
      expect([400, 403, 404], `${method} ${url} must not act on another workspace`).toContain(res.statusCode);
    }
    // And the first evaluator's work is exactly as it was.
    const run = await first.get<MigrationRunDto>(`/api/runs/${owned.runId}`);
    expect(run.status).toBe('COMPLETED');
  });

  it('does not leak the other workspace through any listing', async () => {
    for (const url of ['/api/projects', '/api/plans', '/api/runs', '/api/validations', '/api/audit']) {
      const res = await asSecond('GET', url);
      expect(res.statusCode).toBe(200);
      for (const id of [owned.projectId, owned.planId, owned.runId, owned.validationId]) {
        expect(res.body, `${url} must not mention another workspace's ids`).not.toContain(id);
      }
    }
  });

  it('keeps the audit trail separate', async () => {
    // Both evaluators have run a migration by now, so the distinguishing fact is not whether the
    // action appears but whose run it describes.
    const mine = await second.get<{ items: { runId: string | null }[] }>('/api/audit?limit=200');
    expect(mine.items.some((e) => e.runId === owned.runId)).toBe(false);
    const theirs = await first.get<{ items: { runId: string | null }[] }>('/api/audit?limit=200');
    expect(theirs.items.some((e) => e.runId === owned.runId)).toBe(true);
  });

  it('removes an abandoned workspace but never one somebody is still in', async () => {
    const { organizations } = await import('../../server/src/db/schema');
    const { eq } = await import('drizzle-orm');
    // Age the second evaluator's workspace past the window. Its session is still valid, so it must
    // survive: expiring a workspace somebody is working in is worse than keeping the row.
    await t.services.db
      .update(organizations)
      .set({ createdAt: new Date(Date.now() - 1000 * 3_600_000) })
      .where(eq(organizations.id, secondOrgId));

    const removed = await t.services.auth.purgeExpiredDemoWorkspaces();
    expect(removed, 'a workspace with a live session is not removed').toBe(0);
    expect(await orgIdOf(second)).toBe(secondOrgId);

    // Once the session is gone, nobody is coming back to it.
    const { sessions, users } = await import('../../server/src/db/schema');
    const theirUsers = await t.services.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.organizationId, secondOrgId));
    for (const u of theirUsers) {
      await t.services.db.delete(sessions).where(eq(sessions.userId, u.id));
    }
    expect(await t.services.auth.purgeExpiredDemoWorkspaces()).toBe(1);
    const left = await t.services.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, secondOrgId));
    expect(left).toHaveLength(0);

    // The first evaluator, who is still signed in and whose workspace is recent, is untouched.
    expect(await orgIdOf(first)).toBe(firstOrgId);
  });
});
