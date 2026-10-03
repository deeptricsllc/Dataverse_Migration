import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationRunDto, ProjectDto, ValidationRunDto } from '../../shared/domain';
import { accountedFor, writtenByRun } from '../../shared/run-metrics';
import { DEMO_PROBLEM_PROJECT, DEMO_SUCCESS_PROJECT } from '../../server/src/services/demo-scenario-service';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The demo a prospective customer opens.
 *
 * It exists to answer one question — does this product actually work — so the thing under test is
 * that the answer is produced by running a migration, not by writing a row that says PASS. If the
 * engine stopped migrating correctly, this test fails rather than the demo quietly continuing to
 * claim success.
 *
 * The problem story is deliberately not asserted to fail in a particular way. Its job is to be a
 * real migration of contradictory data; pinning it to an exact failure count would turn the fixture
 * into the assertion and hide the day the platform stops noticing.
 */
describe('the demo proves the product works', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let projects: ProjectDto[];

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const session = await api.get<{
      user: { id: string; displayName: string; organization: { id: string } };
    }>('/api/auth/session');
    const ctx = {
      userId: session.user.id,
      organizationId: session.user.organization.id,
      role: 'ADMIN' as const,
      isDemoOrg: true,
      displayName: session.user.displayName,
      requestId: 'test',
      platformOperator: false,
    };
    // The build enqueues a job and then waits for it, so the worker has to be running throughout —
    // the same way it runs in the server process that triggers this on sign-in.
    await worker.start();
    await t.services.demoScenarios.ensure(ctx);
    await worker.drain(60_000);
    projects = await api.get<ProjectDto[]>('/api/projects');
  }, 300_000);

  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('builds a successful migration whose validation actually passes', async () => {
    const project = projects.find((p) => p.name === DEMO_SUCCESS_PROJECT);
    expect(project).toBeTruthy();

    const plans = await api.get<{ id: string }[]>(`/api/projects/${project!.id}/plans`);
    expect(plans.length).toBe(1);

    const runs = await api.get<{ id: string }[]>('/api/runs?limit=100');
    const detailed = await Promise.all(runs.map((i) => api.get<MigrationRunDto>(`/api/runs/${i.id}`)));
    const run = detailed.find((r) => r.planId === plans[0]!.id);
    expect(run, 'the plan was executed, not merely created').toBeTruthy();

    // Executed for real: records were written, none failed, and the status says so.
    expect(run!.status).toBe('COMPLETED');
    expect(run!.failed).toBe(0);
    expect(writtenByRun(run!)).toBeGreaterThan(0);
    expect(run!.created).toBe(run!.processed);

    const validation = await api.get<ValidationRunDto>(`/api/validations/${run!.latestValidationRunId}`);
    expect(validation.status).toBe('COMPLETED');
    // The claim the whole demo rests on.
    expect(validation.outcome, 'the successful story validates clean').toBe('PASS');
    expect(validation.summary!.missingRecords).toBe(0);
    expect(validation.summary!.differentRecords).toBe(0);
    expect(validation.summary!.brokenReferences).toBe(0);

    // And the two screens agree, which is the invariant the metrics fix exists for.
    const accounting = validation.summary!.accounting!;
    expect(writtenByRun(accounting)).toBe(run!.created + run!.updated);
    expect(accountedFor(accounting)).toBe(run!.processed);
  });

  it('builds a second migration that runs into the problems in the data', async () => {
    const project = projects.find((p) => p.name === DEMO_PROBLEM_PROJECT);
    expect(project, 'the problem story exists beside the clean one').toBeTruthy();
    const plans = await api.get<{ id: string; blockerCount: number }[]>(`/api/projects/${project!.id}/plans`);
    expect(plans.length).toBe(1);
    // Configured to the point where it can run: a plan a person could not execute would be a
    // screenshot of a blocked form, not a demonstration of a migration.
    expect(plans[0]!.blockerCount).toBe(0);
  });

  it('is built once, however many times somebody signs in', async () => {
    const before = (await api.get<ProjectDto[]>('/api/projects')).length;
    await api.post('/api/auth/demo-login', {});
    await api.post('/api/auth/demo-login', {});
    const after = await api.get<ProjectDto[]>('/api/projects');
    expect(after.length).toBe(before);
    expect(after.filter((p) => p.name === DEMO_SUCCESS_PROJECT).length).toBe(1);
  });
});
