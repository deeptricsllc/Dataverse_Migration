import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, ProjectDto } from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The product's hard rules, enforced where they cannot be argued with.
 *
 * These are domain tests, not UI tests, and the difference is the point. A disabled button is a courtesy;
 * the API is the contract. Every rule here was written because the contract accepted something it could
 * not honour, and the user met the consequence later, in the vocabulary of a failure.
 *
 * The one that started it, probed on the build before this change:
 *
 *   connection created                -> HTTP 201, nothing imported
 *   add it to a project as a dataset  -> HTTP 200      ← accepted
 *   POST /analyse                     -> HTTP 200      ← accepted
 *   … asynchronously …
 *   dataset state                     -> FAILED
 *
 * A request that cannot succeed should be refused when it is made, and refused in words that name the
 * choice the person has not made yet rather than reporting a defect.
 */

const body = (res: { json: () => unknown }) => res.json() as { error?: { code: string; message: string } };

describe('a connection is not a dataset', () => {
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

  const call = (method: 'POST' | 'GET' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      payload: payload as never,
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });

  /** A connection that authenticates and holds nothing: the SharePoint and empty-upload case. */
  const emptyConnection = async (displayName: string, kind = 'UPLOAD') =>
    (await call('POST', '/api/staged-sources', { displayName, kind })).json() as EnvironmentDto;

  const analysisProject = (name: string) => api.post<ProjectDto>('/api/projects', { name, kind: 'ANALYSIS' });

  it('refuses to add a connection that holds nothing as a dataset', async () => {
    const connection = await emptyConnection('Empty file source');
    const project = await analysisProject('Invariant: empty file source');

    const res = await call('POST', `/api/projects/${project.id}/sources`, {
      environmentId: connection.id,
    });
    expect(res.statusCode).toBe(400);
    // The message names the missing choice, not a malfunction.
    expect(body(res).error!.message).toContain('has no files in it yet');
    expect(body(res).error!.message).toContain('Add a file to it');
  });

  it('refuses a SharePoint connection with nothing selected, and says what to choose', async () => {
    const connection = await emptyConnection('Finance SharePoint', 'SHAREPOINT');
    const project = await analysisProject('Invariant: empty SharePoint');

    const res = await call('POST', `/api/projects/${project.id}/sources`, {
      environmentId: connection.id,
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error!.message).toContain('no content has been selected');
    expect(body(res).error!.message).toContain('Choose the list, library or file');
  });

  it('refuses to analyse a project that has no datasets', async () => {
    const project = await analysisProject('Invariant: nothing to analyse');
    const res = await call('POST', `/api/projects/${project.id}/analyse`, { all: true });

    expect(res.statusCode).toBe(400);
    expect(body(res).error!.message).toContain('no datasets yet');
  });

  /**
   * The whole failure mode in one case: nothing may be created by asking for the impossible. No run, no
   * readiness, no findings, no "0 tables / 0 records" presented as an assessment.
   */
  it('creates no analysis, no run and no readiness when there is nothing to analyse', async () => {
    const project = await analysisProject('Invariant: no empty assessment');
    await call('POST', `/api/projects/${project.id}/analyse`, { all: true });

    const assessment = (await call('GET', `/api/projects/${project.id}/assessment`)).json() as {
      datasets: unknown[];
      runs: unknown[];
      findings: unknown[];
      readiness: { score: number | null };
    };
    expect(assessment.runs, 'no run was created').toHaveLength(0);
    expect(assessment.findings, 'no findings were invented').toHaveLength(0);
    expect(assessment.readiness.score, 'no readiness was produced').toBeNull();
  });

  it('accepts the same connection once it actually holds data', async () => {
    const connection = await emptyConnection('Filled file source');
    const project = await analysisProject('Invariant: filled source');

    const refused = await call('POST', `/api/projects/${project.id}/sources`, {
      environmentId: connection.id,
    });
    expect(refused.statusCode, 'empty to begin with').toBe(400);

    const csv = 'customer_number,company\r\nCUST-1,Acme\r\nCUST-2,Globex';
    const imported = await call('POST', `/api/staged-sources/${connection.id}/import`, {
      filename: 'Customers.csv',
      contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
    });
    expect(imported.statusCode).toBe(200);

    const accepted = await call('POST', `/api/projects/${project.id}/sources`, {
      environmentId: connection.id,
    });
    expect(accepted.statusCode, 'the selection is what makes it a dataset').toBe(200);
  });
});

describe('source and target belong to a workflow, never to the application', () => {
  let t: TestApp;
  let api: ApiClient;
  let envs: EnvironmentDto[];

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('refuses a target on an analysis project', async () => {
    await api.post(
      '/api/projects',
      { name: 'Invariant: analysis has no target', kind: 'ANALYSIS', targetEnvironmentId: envs[0]!.id },
      400,
    );
  });

  it('refuses a dataset list on a migration or comparison project, which have fixed sides', async () => {
    for (const kind of ['MIGRATION', 'COMPARISON'] as const) {
      const project = await api.post<ProjectDto>('/api/projects', {
        name: `Invariant: fixed sides ${kind}`,
        kind,
      });
      await api.post(`/api/projects/${project.id}/sources`, { environmentId: envs[0]!.id }, 400);
    }
  });

  /**
   * A connection carries no role of its own.
   *
   * The old model let one be marked "the source" application-wide, which is why a source/target banner
   * could sit above Connections, Audit and everything else. Nothing in the domain reads such a mark; the
   * sides live on the project that has them.
   */
  it('exposes no endpoint that gives a connection a source or target role', async () => {
    const connection = envs[0]!;
    for (const path of [
      `/api/environments/${connection.id}/set-source`,
      `/api/environments/${connection.id}/set-target`,
      `/api/environments/${connection.id}/role`,
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: path,
        payload: {} as never,
        headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
      });
      expect(res.statusCode, `${path} must not exist`).toBe(404);
    }
  });
});
