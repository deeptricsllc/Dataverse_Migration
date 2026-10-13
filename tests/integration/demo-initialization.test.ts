import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import type { DemoSetupStatusDto } from '../../shared/domain';
import { DataverseError } from '../../server/src/dataverse/errors';
import { environments, migrationRuns, organizations, projects } from '../../server/src/db/schema';
import type { RequestContext } from '../../server/src/services/context';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Whether a demo workspace that fails to set itself up can say so, and be fixed in place.
 *
 * The defect, seen on deployed QA: a sign-in produced a workspace with no worked examples, reporting
 * "not ready, not building" for ever. The build had read the environment list, found one of the four
 * simulated environments missing, logged a line and returned. Nothing recorded that it had given up,
 * so nothing could start it again — and because each evaluator sign-in creates its own organization,
 * the only way out was to sign out and abandon the workspace.
 *
 * Two separate faults, and both are tested here rather than reasoned about:
 *
 *   1. The build inferred that discovery had finished from a non-empty list. Discovery inserts the
 *      environments one at a time, so a list read during another request's discovery returns some of
 *      them.
 *   2. A build that gave up left no trace and had no way back.
 */
describe('a demo workspace that cannot set itself up', () => {
  let t: TestApp;
  let api: ApiClient;
  let ctx: RequestContext;
  let worker: ReturnType<TestApp['services']['createWorker']>;

  beforeEach(async () => {
    /*
     * Worked examples on, automatic building off. `DEMO_SCENARIOS` is what makes the status endpoint
     * answer for real rather than short-circuiting; `RUN_WORKER` is what makes sign-in start a build on
     * its own, and leaving that on would race every test here against an arrival it did not ask for.
     * The worker is still started below — that is a factory call, not the flag.
     */
    t = await createTestApp({ DEMO_SCENARIOS: 'true', RUN_WORKER: 'false' });
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    ctx = {
      userId: session.user.id,
      organizationId: session.user.organization.id,
      role: 'ADMIN',
      isDemoOrg: true,
      displayName: session.user.displayName,
      requestId: 'demo-initialization-test',
      platformOperator: false,
    };
    // The worked examples are built by running two real migrations, so something has to run them.
    worker = t.services.createWorker();
    await worker.start();
  }, 120_000);

  afterEach(async () => {
    await worker?.stop();
    await t?.close();
  });

  const scenarios = () => t.services.demoScenarios;
  const envs = () => t.services.environments as unknown as Record<string, unknown>;
  const status = () => api.get<DemoSetupStatusDto>('/api/demo/status');
  const activeProjects = () =>
    t.services.db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.organizationId, ctx.organizationId), eq(projects.status, 'ACTIVE')));
  const runs = () =>
    t.services.db
      .select({ id: migrationRuns.id })
      .from(migrationRuns)
      .where(eq(migrationRuns.organizationId, ctx.organizationId));

  /**
   * The race, reproduced as a state rather than as a stub.
   *
   * Discovery inserts the simulated environments one at a time, so a read taken while another request is
   * discovering returns some of them. That state is built here directly — every environment removed but
   * one — because it is a state the database can genuinely be in, and a test that stubbed a method would
   * only prove the stub.
   *
   * The old build read the list, found it non-empty, concluded discovery had already happened, failed its
   * four-name check and returned. Nothing was recorded and the workspace stayed empty. The build now asks
   * discovery directly and uses what discovery returns, so a half-written list is no longer something it
   * can be misled by.
   */
  it('builds from a workspace whose environment list is incomplete', async () => {
    // Populate, then take all but one away: exactly what a half-finished discovery leaves behind.
    await t.services.environments.discover(ctx);
    const before = await t.services.db
      .select({ id: environments.id, name: environments.displayName })
      .from(environments)
      .where(eq(environments.organizationId, ctx.organizationId));
    expect(before.length, 'there were environments to remove').toBeGreaterThan(1);
    const keep = before.find((e) => e.name === 'DeepTrics Development')!;
    await t.services.db
      .delete(environments)
      .where(and(eq(environments.organizationId, ctx.organizationId), ne(environments.id, keep.id)));
    const partial = await t.services.db
      .select({ name: environments.displayName })
      .from(environments)
      .where(eq(environments.organizationId, ctx.organizationId));
    expect(
      partial.map((e) => e.name),
      'the workspace really is half-written',
    ).toEqual(['DeepTrics Development']);

    await scenarios().ensure(ctx);

    const after = await status();
    expect(after.ready, 'an incomplete list no longer decides the outcome').toBe(true);
    expect(after.status).toBe('READY');
  }, 300_000);

  /**
   * Discovery that fails and then recovers, inside one attempt.
   *
   * The bounded retry: each attempt re-runs the real operation and re-checks the real condition. There is
   * nothing to sleep and hope for — discovery either answers with every environment or throws.
   */
  it('recovers when discovery fails once and then works', async () => {
    const real = envs().discover as (c: RequestContext) => Promise<unknown[]>;
    let calls = 0;
    envs().discover = async (c: RequestContext) => {
      calls++;
      if (calls === 1) throw new DataverseError('NETWORK', 'Injected: discovery is not available yet', 0);
      return real.call(t.services.environments, c);
    };
    try {
      await scenarios().ensure(ctx);
    } finally {
      envs().discover = real;
    }

    expect(calls, 'it asked again rather than giving up').toBeGreaterThan(1);
    const after = await status();
    expect(after.ready).toBe(true);
    expect(after.status).toBe('READY');
    expect(after.detail).toBeNull();
  }, 300_000);

  /** And what it built is there: both projects, and a run for each. */
  it('leaves the worked examples in the workspace it built them for', async () => {
    await scenarios().ensure(ctx);

    const names = (await activeProjects()).map((p) => p.name).sort();
    expect(names).toEqual(['Customer Migration: Data Quality Issues', 'Customer Migration: Successful']);
    expect((await runs()).length, 'a migration was actually run for each').toBeGreaterThanOrEqual(2);

    const after = await status();
    expect(after.ready).toBe(true);
    expect(after.canRetry, 'nothing to retry once it is there').toBe(false);
  }, 300_000);

  /** Asking again for a workspace that is already built changes nothing. */
  it('does not build a second copy when initialization is repeated', async () => {
    await scenarios().ensure(ctx);
    const projectsBefore = (await activeProjects()).length;
    const runsBefore = (await runs()).length;

    await scenarios().ensure(ctx);
    await scenarios().retry(ctx);

    expect((await activeProjects()).length, 'no duplicate projects').toBe(projectsBefore);
    expect((await runs()).length, 'and no second set of runs').toBe(runsBefore);
  }, 300_000);

  /**
   * Discovery that never works.
   *
   * The state the whole change exists for. It has to be visible, it has to say why, and it has to be
   * something the same organization can try again.
   */
  it('records a failure that never worked, with the reason, and offers a retry', async () => {
    const real = envs().discover as (c: RequestContext) => Promise<unknown[]>;
    envs().discover = async () => {
      throw new DataverseError('NETWORK', 'Injected: the simulated environments are unreachable', 0);
    };
    try {
      await scenarios().ensure(ctx);
    } finally {
      envs().discover = real;
    }

    const failed = await status();
    expect(failed.status).toBe('FAILED');
    expect(failed.ready, 'and it does not claim to be ready').toBe(false);
    expect(failed.building, 'nor that something is still working on it').toBe(false);
    expect(failed.detail, 'with the reason it recorded').toContain('unreachable');
    expect(failed.canRetry).toBe(true);
    expect(failed.attempts).toBeGreaterThan(0);

    // The failure is recorded on the organization, so it survives the process that wrote it.
    const [org] = await t.services.db
      .select({ status: organizations.demoSetupStatus, detail: organizations.demoSetupDetail })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));
    expect(org!.status).toBe('FAILED');
    expect(org!.detail).toBeTruthy();
    expect(await activeProjects(), 'and nothing half-built was left behind').toHaveLength(0);
  }, 300_000);

  /**
   * And the way out, without signing out.
   *
   * The same organization, through the endpoint the screen uses. Before this, a failed workspace needed
   * a new sign-in, which meant a different organization and losing whatever was in the old one.
   */
  it('retries in place, for the same organization, through the API', async () => {
    const real = envs().discover as (c: RequestContext) => Promise<unknown[]>;
    envs().discover = async () => {
      throw new DataverseError('NETWORK', 'Injected: the simulated environments are unreachable', 0);
    };
    await scenarios()
      .ensure(ctx)
      .catch(() => {});
    envs().discover = real;

    expect((await status()).status).toBe('FAILED');

    const recovered = await api.post<DemoSetupStatusDto>('/api/demo/retry-setup', {});
    expect(recovered.ready, 'the workspace that failed is the one that is now ready').toBe(true);
    expect(recovered.status).toBe('READY');

    // Same organization, and the examples are in it.
    const session = await api.get<{ user: { organization: { id: string } } }>('/api/auth/session');
    expect(session.user.organization.id).toBe(ctx.organizationId);
    expect((await activeProjects()).length).toBe(2);
  }, 300_000);

  /**
   * Several sign-ins at once, into one workspace.
   *
   * The named team sign-in puts everybody in the same organization, so this is a real arrival pattern and
   * not a contrived one. One build should run; the rest should wait for it and find it done.
   */
  it('builds once when several arrivals ask at the same time', async () => {
    const results = await Promise.all([
      scenarios().ensure(ctx),
      scenarios().ensure(ctx),
      scenarios().ensure(ctx),
      scenarios().ensure(ctx),
      scenarios().ensure(ctx),
    ]);
    expect(results).toHaveLength(5);

    const names = (await activeProjects()).map((p) => p.name).sort();
    expect(names, 'one of each, not five').toEqual([
      'Customer Migration: Data Quality Issues',
      'Customer Migration: Successful',
    ]);
    // Two stories, two runs. Five concurrent callers must not produce ten.
    expect((await runs()).length).toBe(2);

    const [org] = await t.services.db
      .select({ attempts: organizations.demoSetupAttempts })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));
    expect(org!.attempts, 'one attempt, not five').toBe(1);
  }, 300_000);

  /** A workspace that has not been asked to build yet is pending, not failed and not ready. */
  it('reports a workspace that has not started as pending', async () => {
    const before = await status();
    expect(before.status).toBe('PENDING');
    expect(before.ready).toBe(false);
    expect(before.building).toBe(false);
    expect(before.detail, 'nothing has failed, so there is nothing to explain').toBeNull();
    expect(before.canRetry).toBe(true);
  });
});
