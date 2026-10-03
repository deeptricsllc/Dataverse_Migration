import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto, ProjectDto } from '../../shared/domain';
import { WORKSPACE_ROLES, type WorkspaceRole } from '../../shared/authorization';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * What each role may actually do, asked of the API rather than of the interface.
 *
 * A hidden button is not authorization. Everything here is a direct request with a valid session
 * and a valid CSRF token, which is exactly what somebody who opened the developer tools would send,
 * and the only thing standing between them and the action is the server.
 *
 * The important property is not that the listed routes are refused — it is that *anything* mutating
 * is refused by default. The model is enforced before any handler runs, so a route added tomorrow
 * is closed to a validator and an auditor without anybody remembering to close it. The last test
 * here is the one that checks that.
 */
describe('role boundaries', () => {
  let t: TestApp;
  let admin: ApiClient;
  /** One signed-in client per role, all in the same workspace. */
  const clients = new Map<WorkspaceRole, ApiClient>();
  const owned = { projectId: '', planId: '', runId: '', envId: '', targetId: '', connectionId: '' };

  beforeAll(async () => {
    t = await createTestApp();
    admin = new ApiClient(t.app);
    const session = await admin.demoLogin();
    const organizationId = session.user.organization.id;

    const envs = await admin.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    owned.envId = dev.id;
    owned.targetId = uat.id;

    const project = await admin.post<ProjectDto>('/api/projects', {
      name: 'Role boundaries',
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    owned.projectId = project.id;
    const plan = await admin.post<MigrationPlanDto>('/api/plans', {
      name: 'Role boundaries plan',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region'],
      projectId: project.id,
    });
    owned.planId = plan.id;
    const worker = t.services.createWorker();
    const started = await admin.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    await worker.stop();
    owned.runId = started.id;

    // A signed-in user per role, each a real session in the same workspace.
    const { users, sessions } = await import('../../server/src/db/schema');
    const { sha256 } = await import('../../server/src/lib/crypto');
    for (const role of WORKSPACE_ROLES) {
      const [user] = await t.services.db
        .insert(users)
        .values({
          organizationId,
          externalId: `role-${role}`,
          authProvider: 'demo',
          displayName: role,
          role,
        })
        .returning();
      const token = `token-${role}`;
      await t.services.db.insert(sessions).values({
        id: sha256(token),
        userId: user!.id,
        csrfToken: `csrf-${role}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const api = new ApiClient(t.app);
      api.cookie = `dvm_session=${token}`;
      api.csrf = `csrf-${role}`;
      clients.set(role, api);
    }
  }, 300_000);

  afterAll(async () => {
    await t.close();
  });

  /** A raw request with a valid session and CSRF token: the status is the point. */
  const as = (
    role: WorkspaceRole,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ) =>
    t.app.inject({
      method,
      url,
      payload: body as never,
      headers: {
        cookie: clients.get(role)!.cookie,
        ...(method === 'GET' ? {} : { 'x-csrf-token': clients.get(role)!.csrf }),
      },
    });

  /** Everything an auditor and a validator must not be able to do. */
  const MUTATIONS: [string, 'POST' | 'PATCH' | 'DELETE', string, unknown][] = [
    ['create a connection', 'POST', '/api/connections', { displayName: 'x', connectionType: 'FILE' }],
    ['delete a connection', 'DELETE', '/api/connections/00000000-0000-0000-0000-000000000001', undefined],
    ['create a project', 'POST', '/api/projects', { name: 'nope', kind: 'ANALYSIS' }],
    ['rename a project', 'PATCH', '/api/projects/{project}', { name: 'renamed' }],
    ['archive a project', 'POST', '/api/projects/{project}/archive', {}],
    ['change plan options', 'PATCH', '/api/plans/{plan}/options', { conflictStrategy: 'SYNC' }],
    [
      'start a migration',
      'POST',
      '/api/plans/{plan}/execute',
      { acknowledgeWarnings: true, confirmed: true },
    ],
    ['cancel a run', 'POST', '/api/runs/{run}/cancel', {}],
    ['re-run failures', 'POST', '/api/runs/{run}/retry', {}],
    ['reset the workspace', 'POST', '/api/demo/reset', {}],
    ['discover connections', 'POST', '/api/environments/discover', {}],
  ];

  const fill = (url: string) =>
    url.replace('{project}', owned.projectId).replace('{plan}', owned.planId).replace('{run}', owned.runId);

  it('refuses an auditor every change, including ones with no button', async () => {
    for (const [what, method, url, body] of MUTATIONS) {
      const res = await as('READ_ONLY', method, fill(url), body);
      expect(res.statusCode, `an auditor must not ${what} (got ${res.statusCode})`).toBe(403);
      // And the refusal says what the role is for, not merely that it failed.
      expect(res.body).toMatch(/auditor/i);
    }
  });

  it('refuses a validator everything except running a validation', async () => {
    for (const [what, method, url, body] of MUTATIONS) {
      const res = await as('VALIDATOR', method, fill(url), body);
      expect(res.statusCode, `a validator must not ${what} (got ${res.statusCode})`).toBe(403);
    }
    // The one change the role exists to make. Not 403 — it may fail for other reasons, and that is
    // a different question from whether the role was allowed to try.
    const validation = await as('VALIDATOR', 'POST', '/api/validations', {
      migrationRunId: owned.runId,
    });
    expect(validation.statusCode, 'a validator may validate').not.toBe(403);
  });

  it('lets an operator do the work, but not the things that outlive it', async () => {
    const ok = await as('MIGRATION_OPERATOR', 'PATCH', `/api/projects/${owned.projectId}`, {
      name: 'operator renamed this',
    });
    expect(ok.statusCode, 'an operator may change a project').toBe(200);

    for (const [what, method, url] of [
      ['reset the workspace', 'POST', '/api/demo/reset'],
      ['delete a connection', 'DELETE', `/api/connections/${owned.envId}`],
    ] as const) {
      const res = await as('MIGRATION_OPERATOR', method, url, {});
      expect(res.statusCode, `an operator must not ${what}`).toBe(403);
    }
  });

  it('lets every role read what it is there to read', async () => {
    for (const role of WORKSPACE_ROLES) {
      for (const url of [
        '/api/projects',
        '/api/runs',
        '/api/validations',
        '/api/audit',
        `/api/runs/${owned.runId}`,
        // The evidence package is the auditor's whole reason for being here.
        `/api/runs/${owned.runId}/evidence.zip`,
      ]) {
        const res = await as(role, 'GET', url);
        expect(res.statusCode, `${role} should be able to read ${url}`).toBe(200);
      }
    }
  });

  it('closes a route nobody has thought about yet', async () => {
    // The property that makes this a model rather than a list. An unknown mutating path falls
    // through to the default permission, so it is refused for the read-only roles before any
    // handler exists to defend itself — and a 404 would be the wrong answer, because it would mean
    // authorization had not been consulted.
    for (const role of ['READ_ONLY', 'VALIDATOR'] as const) {
      const res = await as(role, 'POST', '/api/some-route-added-next-week', {});
      expect(res.statusCode, `${role} is refused before routing`).toBe(403);
    }
  });
});
