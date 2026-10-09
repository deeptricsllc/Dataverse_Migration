import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeXlsx } from '../../server/src/lib/xlsx';
import type { AnalysisRunDto, EnvironmentDto, ProjectDto } from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * A connection is not a dataset, at every door and at every moment.
 *
 * The failure this exists for, reported from QA: somebody created an analysis project, added a
 * SharePoint connection, chose no file, and pressed Analyse. The run was accepted — HTTP 200,
 * QUEUED — started in the worker, and failed with
 *
 *     None of the requested tables exist in this source
 *
 * Every word of which is wrong for what happened. No tables were requested; the person requested
 * nothing. The source has no tables; it has files, none of which were chosen. And it arrived as a
 * failed run rather than as a refusal at the moment of pressing the button, with nothing to do next.
 *
 * `resolveDataset` already existed and said exactly the right thing. It was wired into
 * `addSource` and not into `ProjectService.create`, so a project created *with* an empty
 * connection — the path the new-project form takes, and the path in the report — never asked the
 * question. Nor did `AnalysisService.create`, so even a project built correctly could be emptied
 * afterwards and still queue a run that could not succeed.
 *
 * One rule, every door, and again at the moment of running.
 */
describe('an analysis of a connection with nothing selected', () => {
  let t: TestApp;
  let api: ApiClient;
  let workbook: string;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    workbook = writeXlsx([
      {
        name: 'Customers',
        columns: [{ header: 'customer_number' }, { header: 'customer_name' }],
        rows: Array.from({ length: 12 }, (_, i) => [`CUST-${1000 + i}`, `Name ${i}`]),
      },
    ]).toString('base64');
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  const emptyConnection = (displayName: string) =>
    api.post<EnvironmentDto>('/api/staged-sources', { displayName, kind: 'UPLOAD' }, 201);

  /** What the person is told, as one string, whichever shape the error came back in. */
  const refusalText = (refusal: unknown) => JSON.stringify(refusal);

  it('cannot become a project’s source when it holds nothing', async () => {
    const source = await emptyConnection(`Nothing chosen ${Date.now()}`);
    /*
     * The reported path. `addSource` had this check; `create` did not, which is the whole defect.
     */
    const refusal = await api.post(
      '/api/projects',
      { name: `Nothing selected ${Date.now()}`, kind: 'ANALYSIS', sourceEnvironmentId: source.id },
      400,
    );
    const text = refusalText(refusal);
    expect(text, 'it says the connection holds nothing').toMatch(/contains no files/i);
    expect(text, 'and what to do about it').toMatch(/add a file/i);
    // Never the engine's own vocabulary.
    expect(text).not.toMatch(/requested tables/i);
  }, 60_000);

  it('cannot be added to an existing project when it holds nothing', async () => {
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `Add later ${Date.now()}`,
      kind: 'ANALYSIS',
    });
    const source = await emptyConnection(`Added later ${Date.now()}`);
    const refusal = await api.post(`/api/projects/${project.id}/sources`, { environmentId: source.id }, 400);
    expect(refusalText(refusal)).toMatch(/contains no files/i);
  }, 60_000);

  /**
   * The case the second guard exists for.
   *
   * Adding and running are different moments, and the answer can change between them. A check that
   * only runs when the dataset is added passes for a project that cannot work.
   */
  it('refuses to run when the content was removed after the project was built', async () => {
    const source = await emptyConnection(`Emptied later ${Date.now()}`);
    await api.post(`/api/staged-sources/${source.id}/import`, {
      filename: 'Customers.xlsx',
      contentBase64: workbook,
    });
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `Emptied ${Date.now()}`,
      kind: 'ANALYSIS',
      sourceEnvironmentId: source.id,
    });
    // The file is taken away again, which a person can do from the connection screen.
    await api.del(`/api/staged-sources/${source.id}/tables/customers`, undefined, 204);

    const refusal = await api.post(`/api/projects/${project.id}/analyses`, {}, 400);
    expect(refusalText(refusal), 'refused at the moment it is asked for').toMatch(/contains no files/i);

    const runs = await api.get<AnalysisRunDto[]>(`/api/projects/${project.id}/analyses`);
    expect(runs, 'and nothing was queued to fail later').toHaveLength(0);
  }, 120_000);

  it('still analyses a connection that does hold something', async () => {
    // The point is not to refuse everything. A chosen file is a dataset and runs as one.
    const source = await emptyConnection(`Has a file ${Date.now()}`);
    await api.post(`/api/staged-sources/${source.id}/import`, {
      filename: 'Customers.xlsx',
      contentBase64: workbook,
    });
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `Has data ${Date.now()}`,
      kind: 'ANALYSIS',
      sourceEnvironmentId: source.id,
    });
    const run = await api.post<AnalysisRunDto>(`/api/projects/${project.id}/analyses`, {});
    expect(run.status).toBe('QUEUED');

    const worker = t.services.createWorker();
    await worker.drain(180_000);
    await worker.stop();

    const done = await api.get<AnalysisRunDto>(`/api/analyses/${run.id}`);
    expect(done.status, done.errorMessage ?? '').toBe('COMPLETED');
    expect(done.totals.tables, 'the one table that was chosen').toBe(1);
    expect(done.totals.records).toBe(12);
  }, 300_000);
});
