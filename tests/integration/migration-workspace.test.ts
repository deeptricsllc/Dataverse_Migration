import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationWorkspaceDto,
  ProjectDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * A migration is a body of work that belongs to a project, not a position in a nine-step wizard.
 *
 * The invariants here are the ones the old model could not hold. Source and target were application-wide,
 * so "which migration is this configured for" had no answer; readiness lived on a page you reached by
 * pressing Continue four times, so "are we ready" was answered with "I completed step 6"; and scope was
 * chosen once, at step 3, so adding a table later meant starting again.
 *
 * Every assertion is made at the API, because that is the contract. A workspace that shows a blocker and
 * an API that executes anyway is not a safety model, it is a screen.
 */
describe('a migration project owns its own migration', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  let qa: EnvironmentDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
  });
  afterAll(async () => {
    await t?.close();
  });

  const migrationProject = (name: string, body: Record<string, unknown> = {}) =>
    api.post<ProjectDto>('/api/projects', { name, kind: 'MIGRATION', ...body });

  const workspace = (projectId: string) =>
    api.get<MigrationWorkspaceDto>(`/api/projects/${projectId}/migration`);

  it('is empty rather than broken when it has just been made', async () => {
    const project = await migrationProject(`Empty migration ${Date.now()}`);
    const w = await workspace(project.id);

    expect(w.status, 'a new migration is a draft, not "step 1 incomplete"').toBe('DRAFT');
    expect(w.source).toBeNull();
    expect(w.target).toBeNull();
    expect(w.plan, 'nothing is configured yet').toBeNull();
    expect(w.readiness, 'nothing has been assessed, and nothing pretends to have been').toBeNull();
    expect(w.lastRun).toBeNull();
    // The one thing to do next, named as an action rather than as a stage.
    expect(w.nextAction.kind).toBe('ADD_SOURCE_DATA');
  });

  it('keeps its two ends on itself, not on the application', async () => {
    const a = await migrationProject(`Ends A ${Date.now()}`, {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    const b = await migrationProject(`Ends B ${Date.now()}`, {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
    });

    /*
     * Two migrations, open at the same time, with different destinations. Under the model this replaces
     * there was one application-wide target, so this was not expressible — and a banner above every
     * screen told you which environment was "the target" while you were reading an audit log.
     */
    expect((await workspace(a.id)).target!.id).toBe(uat.id);
    expect((await workspace(b.id)).target!.id).toBe(qa.id);
    expect((await workspace(a.id)).source!.id).toBe(dev.id);
  });

  it('says what the destination can do, from the guard that would refuse the write', async () => {
    const project = await migrationProject(`Capability ${Date.now()}`, {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    const w = await workspace(project.id);
    expect(w.targetCapability).not.toBeNull();
    // The demo environments are simulated, and the workspace says so rather than implying a real write.
    expect(w.targetCapability!.simulated).toBe(true);
    expect(w.targetCapability!.reason).toMatch(/simulated/i);
  });

  it('reports scope, readiness and a next action once it is configured', async () => {
    const project = await migrationProject(`Configured ${Date.now()}`, {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      projectId: project.id,
      tables: ['account', 'contact'],
    });

    const w = await workspace(project.id);
    expect(w.plan).not.toBeNull();
    expect(w.plan!.datasets).toBe(2);
    expect(w.readiness, 'the readiness service answers, rather than a second opinion').not.toBeNull();
    expect(['READY', 'BLOCKED', 'PREPARING']).toContain(w.status);
    // Whatever the verdict, the next action is something to do rather than somewhere you are.
    expect(w.nextAction.label.length).toBeGreaterThan(0);
    expect(w.nextAction.detail.length).toBeGreaterThan(0);
  });
});

describe('scope changes without the work starting again', () => {
  let t: TestApp;
  let api: ApiClient;
  let project: ProjectDto;
  let plan: MigrationPlanDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    project = await api.post<ProjectDto>('/api/projects', {
      name: `Growing scope ${Date.now()}`,
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      projectId: project.id,
      tables: ['account', 'contact'],
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('adds a table and keeps the work already done on the others', async () => {
    const before = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const accountBefore = before.entities.find((e) => e.logicalName === 'account')!;
    // Something settled on the existing table, so there is work to lose.
    expect(accountBefore.targetLogicalName).toBe('account');

    const after = await api.put<MigrationPlanDto>(`/api/plans/${plan.id}/tables`, {
      tables: ['account', 'contact', 'product'],
    });

    expect(after.entities).toHaveLength(3);
    const accountAfter = after.entities.find((e) => e.logicalName === 'account')!;
    /*
     * The identity of the existing entity survives. A person who adds a fourth table after mapping three
     * has not asked to start again, and a rebuild that dropped and recreated every row would silently
     * discard their field mappings with it.
     */
    expect(accountAfter.id).toBe(accountBefore.id);
    expect(accountAfter.targetLogicalName).toBe(accountBefore.targetLogicalName);
    expect(accountAfter.matchStrategy).toBe(accountBefore.matchStrategy);
  });

  it('removes a table without disturbing the rest', async () => {
    const after = await api.put<MigrationPlanDto>(`/api/plans/${plan.id}/tables`, {
      tables: ['account', 'contact'],
    });
    expect(after.entities.map((e) => e.logicalName).sort()).toEqual(['account', 'contact']);
  });

  it('is reachable as the current configuration of the project', async () => {
    const current = await api.get<MigrationPlanDto>(`/api/projects/${project.id}/migration/plan`);
    expect(current.id).toBe(plan.id);
  });
});

describe('a blocker is a refusal, not a red badge', () => {
  let t: TestApp;
  let api: ApiClient;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('refuses to execute a plan with no tables, however the request is made', async () => {
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `Nothing selected ${Date.now()}`,
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      projectId: project.id,
      tables: [],
    });

    /*
     * Straight at the API, the way a script would, skipping every screen. The rule lives in the domain,
     * so there is nowhere to make this request from where it is accepted.
     */
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/plans/${plan.id}/execute`,
      payload: { confirmSourceName: dev.displayName, confirmTargetName: uat.displayName } as never,
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);

    // And nothing was created by asking: no run, and the workspace still says there is nothing to run.
    const w = await api.get<MigrationWorkspaceDto>(`/api/projects/${project.id}/migration`);
    expect(w.lastRun).toBeNull();
    expect(w.runCount).toBe(0);
  });
});
