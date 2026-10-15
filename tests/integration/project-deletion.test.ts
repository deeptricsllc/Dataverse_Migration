import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EnvironmentDto, MigrationPlanDto, ProjectDto } from '../../shared/domain';
import { migrationPlans, projectSources, projects } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Deleting a project, and what deleting it is allowed to take with it.
 *
 * Archiving was the only way to get a project off the list, which is right for one somebody acted on
 * and wrong for one made by mistake. Delete exists now, and the interesting question is not whether
 * it removes the row -- it is where it stops.
 *
 * Two boundaries, and they pull in opposite directions. What the project *owned* has to go, or the
 * workspace accumulates orphaned sources and analysis nobody can reach. What the project *did* must
 * not: a migration that was carried out is a fact about the customer's data, and `migrationPlans`
 * holds its project with `on delete set null` precisely so the plan and the runs beneath it outlive
 * the project they were planned in. The same rule a deleted connection follows.
 *
 * This file exists because the endpoint shipped without it, which is how the second boundary gets
 * quietly lost in a later refactor.
 */

describe('deleting a project', () => {
  let t: TestApp;
  let api: ApiClient;
  let envs: EnvironmentDto[];

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    expect(envs.length, 'the demo workspace should offer datasets to point a project at').toBeGreaterThan(1);
  });

  afterAll(async () => {
    await t?.close();
  });

  const newAnalysis = (name: string) => api.post<ProjectDto>('/api/projects', { name, kind: 'ANALYSIS' });

  it('removes the project and the sources chosen for it', async () => {
    const project = await newAnalysis(`Deletable ${Date.now()}`);
    await api.post(`/api/projects/${project.id}/sources`, { environmentId: envs[0]!.id });

    const before = await t.database.db
      .select()
      .from(projectSources)
      .where(eq(projectSources.projectId, project.id));
    expect(before.length, 'the source was listed before the delete').toBe(1);

    await api.del(`/api/projects/${project.id}`);

    const rows = await t.database.db.select().from(projects).where(eq(projects.id, project.id));
    expect(rows.length, 'the project is gone').toBe(0);
    const after = await t.database.db
      .select()
      .from(projectSources)
      .where(eq(projectSources.projectId, project.id));
    expect(after.length, 'and its source listings went with it').toBe(0);
  });

  it('stops being readable through the API', async () => {
    const project = await newAnalysis(`Unreadable ${Date.now()}`);
    await api.del(`/api/projects/${project.id}`);
    await api.get(`/api/projects/${project.id}`, 404);
    const list = await api.get<ProjectDto[]>('/api/projects');
    expect(
      list.some((p) => p.id === project.id),
      'and it is off the list',
    ).toBe(false);
  });

  /**
   * The boundary that matters.
   *
   * A connection that a migration referenced is refused outright, because its settings are what the
   * run used. A project is different: it is where the planning happened, not part of what happened,
   * so the plan keeps its own record and loses only its pointer back.
   */
  it('leaves a migration plan standing, without its project', async () => {
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `Planned ${Date.now()}`,
      kind: 'MIGRATION',
    });
    // The two the demo workspace is built to migrate between; an arbitrary pair is not plannable.
    const source = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const target = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Plan of ${project.name}`,
      sourceEnvironmentId: source.id,
      targetEnvironmentId: target.id,
      tables: ['dtx_region'],
      projectId: project.id,
    });

    await api.del(`/api/projects/${project.id}`);

    const [kept] = await t.database.db.select().from(migrationPlans).where(eq(migrationPlans.id, plan.id));
    expect(kept, 'the plan outlived the project').toBeTruthy();
    expect(kept!.projectId, 'and no longer points at it').toBeNull();
    // Still readable, because a plan nobody can open is the same as a plan that was deleted.
    await api.get(`/api/plans/${plan.id}`);
  });

  it('refuses a project this workspace cannot see', async () => {
    // A well-formed id that belongs to nobody is the same answer as one belonging to someone else:
    // the organization filter runs before the row is found, so neither reveals that it exists.
    await api.del('/api/projects/00000000-0000-4000-8000-000000000000', undefined, 404);
  });

  it('leaves archiving alone, which is the reversible answer', async () => {
    const project = await newAnalysis(`Archivable ${Date.now()}`);
    const archived = await api.post<ProjectDto>(`/api/projects/${project.id}/archive`);
    expect(archived.status, 'archiving still works').toBe('ARCHIVED');
    const rows = await t.database.db.select().from(projects).where(eq(projects.id, project.id));
    expect(rows.length, 'and keeps the row').toBe(1);
  });
});
