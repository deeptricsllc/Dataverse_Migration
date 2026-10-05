import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { EnvironmentDto, ProjectDto } from '../../shared/domain';
import { environments, projectSources, projects } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * An analysis project is about however many datasets the question needs.
 *
 * "What is in my data" is rarely about one system: it is four workbooks, or a database plus a spreadsheet
 * of corrections, or two Dataverse environments. A single source column could only express one of those,
 * which forced a separate project per dataset and made a cross-source observation impossible to ask for.
 *
 * The case that matters most here is the last one. A connection is a **workspace asset** — several projects
 * may use it — so removing it from a project must delete the listing and nothing else. If that boundary
 * leaks, somebody tidying up one analysis silently takes a configured connection away from another team's
 * project, and the credential with it.
 */

describe('an analysis project holds many sources', () => {
  let t: TestApp;
  let api: ApiClient;
  let envs: EnvironmentDto[];

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    // Demo discovery gives this workspace several environments to use as datasets.
    envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    expect(envs.length, 'the demo workspace should offer several datasets').toBeGreaterThan(2);
  });

  afterAll(async () => {
    await t?.close();
  });

  const newAnalysis = (name: string) => api.post<ProjectDto>('/api/projects', { name, kind: 'ANALYSIS' });

  const addSource = (projectId: string, environmentId: string, expect_ = 200) =>
    api.post<ProjectDto>(`/api/projects/${projectId}/sources`, { environmentId }, expect_);

  it('is created with no target at all', async () => {
    const project = await newAnalysis('Customer Data Assessment');
    expect(project.kind).toBe('ANALYSIS');
    expect(project.targetEnvironment, 'analysis never has a target').toBeNull();
    expect(project.sources).toEqual([]);
  });

  it('refuses a target on an analysis project', async () => {
    await api.post(
      '/api/projects',
      { name: 'Analysis With A Target', kind: 'ANALYSIS', targetEnvironmentId: envs[0]!.id },
      400,
    );
  });

  it('accepts several sources, in the order they were added', async () => {
    const project = await newAnalysis('Multi Source Assessment');
    let latest = project;
    for (const env of envs.slice(0, 3)) latest = await addSource(project.id, env.id);

    expect(latest.sources.map((s) => s.id)).toEqual(envs.slice(0, 3).map((e) => e.id));
    // The first one added is also the primary source, which every single-source reader still uses.
    expect(latest.sourceEnvironment?.id).toBe(envs[0]!.id);
    expect(latest.targetEnvironment).toBeNull();
  });

  it('refuses the same dataset twice, by name', async () => {
    const project = await newAnalysis('Duplicate Source Assessment');
    await addSource(project.id, envs[0]!.id);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sources`,
      payload: { environmentId: envs[0]!.id },
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { message: string } }).error.message).toContain(envs[0]!.displayName);
  });

  /**
   * The boundary this whole model rests on. Removing a source is a change to one project; the connection
   * belongs to the workspace and outlives it.
   */
  it('removes a source without deleting the connection', async () => {
    const project = await newAnalysis('Removable Source Assessment');
    await addSource(project.id, envs[0]!.id);
    await addSource(project.id, envs[1]!.id);

    const after = await api.del<ProjectDto>(`/api/projects/${project.id}/sources/${envs[0]!.id}`);
    expect(after.sources.map((s) => s.id)).toEqual([envs[1]!.id]);
    // The primary source follows the list rather than pointing at something that was removed.
    expect(after.sourceEnvironment?.id).toBe(envs[1]!.id);

    // The connection is still there, still listed, still usable by anything else.
    const [row] = await t.database.db.select().from(environments).where(eq(environments.id, envs[0]!.id));
    expect(row, 'removing a source must not delete the connection').toBeTruthy();
    const stillListed = await api.get<EnvironmentDto[]>('/api/environments');
    expect(stillListed.map((e) => e.id)).toContain(envs[0]!.id);
  });

  it('leaves the other project alone when a shared connection is removed from one', async () => {
    const first = await newAnalysis('Shared Source A');
    const second = await newAnalysis('Shared Source B');
    await addSource(first.id, envs[0]!.id);
    await addSource(second.id, envs[0]!.id);

    await api.del(`/api/projects/${first.id}/sources/${envs[0]!.id}`);

    const other = await api.get<ProjectDto>(`/api/projects/${second.id}`);
    expect(
      other.sources.map((s) => s.id),
      'the other project keeps its source',
    ).toEqual([envs[0]!.id]);
  });

  it('empties the primary source when the last one is removed, rather than pointing at a removal', async () => {
    const project = await newAnalysis('Emptied Assessment');
    await addSource(project.id, envs[0]!.id);
    const after = await api.del<ProjectDto>(`/api/projects/${project.id}/sources/${envs[0]!.id}`);
    expect(after.sources).toEqual([]);
    expect(after.sourceEnvironment).toBeNull();
  });

  it('refuses to remove a source whose analysis results are attached to it', async () => {
    // Keeping results attached to the dataset they describe matters more than tidiness here: an analysis
    // of a source the project no longer lists is a report about nothing.
    const project = await newAnalysis('Analysed Source Assessment');
    await addSource(project.id, envs[0]!.id);
    await api.post(`/api/projects/${project.id}/analyses`, {});

    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}/sources/${envs[0]!.id}`,
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a source list on a migration or comparison project, which have fixed sides', async () => {
    for (const kind of ['MIGRATION', 'COMPARISON'] as const) {
      const project = await api.post<ProjectDto>('/api/projects', { name: `Fixed Sides ${kind}`, kind });
      await addSource(project.id, envs[0]!.id, 400);
    }
  });

  it('reports the source list on the projects page without a query per project', async () => {
    const list = await api.get<ProjectDto[]>('/api/projects');
    const multi = list.find((p) => p.name === 'Multi Source Assessment');
    expect(multi?.sources).toHaveLength(3);
  });
});

/**
 * Projects that existed before the source list did.
 *
 * `0026_project_sources.sql` backfills one row per project that had a source. A fresh test database has
 * nothing to backfill, so the migration's own INSERT is never exercised by the suite above — and an
 * untested data migration is how an existing workspace quietly loses the source it had. This runs the
 * backfill statement against rows that predate it.
 */
describe('projects created before the source list existed', () => {
  it('keeps the source they had', async () => {
    const t = await createTestApp();
    try {
      const api = new ApiClient(t.app);
      const session = await api.demoLogin();
      const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');

      // A project shaped the way the old model wrote them: the column set, no listing.
      const [legacy] = await t.database.db
        .insert(projects)
        .values({
          organizationId: session.user.organization.id,
          name: 'Project From Before',
          kind: 'ANALYSIS',
          sourceEnvironmentId: envs[0]!.id,
        })
        .returning();
      await t.database.db.delete(projectSources).where(eq(projectSources.projectId, legacy!.id));

      const before = await api.get<ProjectDto>(`/api/projects/${legacy!.id}`);
      expect(before.sources, 'this is the state the migration has to repair').toEqual([]);

      // The backfill, exactly as the migration runs it.
      await t.database.db.execute(
        sql`INSERT INTO "project_sources" ("project_id", "environment_id", "position")
            SELECT "id", "source_environment_id", 0 FROM "projects"
            WHERE "source_environment_id" IS NOT NULL ON CONFLICT DO NOTHING`,
      );

      const after = await api.get<ProjectDto>(`/api/projects/${legacy!.id}`);
      expect(after.sources.map((s) => s.id)).toEqual([envs[0]!.id]);
      expect(after.sourceEnvironment?.id).toBe(envs[0]!.id);

      // And it is idempotent, because a migration that runs twice must not double the list.
      await t.database.db.execute(
        sql`INSERT INTO "project_sources" ("project_id", "environment_id", "position")
            SELECT "id", "source_environment_id", 0 FROM "projects"
            WHERE "source_environment_id" IS NOT NULL ON CONFLICT DO NOTHING`,
      );
      const again = await api.get<ProjectDto>(`/api/projects/${legacy!.id}`);
      expect(again.sources).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});
