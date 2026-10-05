import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeXlsx } from '../../server/src/lib/xlsx';
import type {
  AnalysisAssessmentDto,
  EnvironmentDto,
  ProjectDto,
  StagedPreviewDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Adding real data, as a product rather than as configuration.
 *
 * The rule these tests hold down is the one in §2 of the domain: **a dataset is concrete content**, and the
 * user's word for it is the name of a sheet or a table — `Customers` — never the name of the thing that
 * carries it. Two consequences, and both were wrong before:
 *
 *   - a workbook is not a table, so its sheets are chosen rather than all taken;
 *   - a file source holding four tables is four datasets, not one row called `extract.xlsx`.
 *
 * Tested at the API because that is the contract. A checkbox the user did not tick is a courtesy; a sheet
 * the server imported anyway is data in an analysis that nobody asked for.
 */

/** A workbook shaped like a real one: three sheets worth analysing and two that are not data. */
function customerMigrationWorkbook(): Buffer {
  const people = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => [`${prefix}-${1000 + i}`, `Name ${i}`, `person${i}@example.com`]);
  return writeXlsx([
    {
      name: 'Customers',
      columns: [{ header: 'customer_number' }, { header: 'customer_name' }, { header: 'email' }],
      rows: people(40, 'CUST'),
    },
    {
      name: 'Contacts',
      columns: [{ header: 'contact_number' }, { header: 'contact_name' }, { header: 'email' }],
      rows: people(30, 'CONT'),
    },
    {
      name: 'Orders',
      columns: [{ header: 'order_number' }, { header: 'customer_number' }, { header: 'total' }],
      rows: Array.from({ length: 60 }, (_, i) => [`ORD-${2000 + i}`, `CUST-${1000 + (i % 40)}`, `${i * 10}`]),
    },
    { name: 'Instructions', columns: [{ header: 'step' }], rows: [['Export monthly'], ['Send to IT']] },
    { name: 'Lookup Notes', columns: [{ header: 'note' }], rows: [['AU = Australia']] },
  ]);
}

describe('a workbook is not a table', () => {
  let t: TestApp;
  let api: ApiClient;
  let workbook: string;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    workbook = customerMigrationWorkbook().toString('base64');
  });
  afterAll(async () => {
    await t?.close();
  });

  const upload = async (displayName: string) =>
    api.post<EnvironmentDto>('/api/staged-sources', { displayName, kind: 'UPLOAD' }, 201);

  const importInto = (id: string, sheets?: string[]) =>
    api.post<{ tables: { logicalName: string; displayName: string }[] }>(`/api/staged-sources/${id}/import`, {
      filename: 'CustomerMigration.xlsx',
      contentBase64: workbook,
      ...(sheets ? { sheets } : {}),
    });

  it('previews every sheet with an identifier a selection can name', async () => {
    const preview = await api.post<StagedPreviewDto>('/api/staged-sources/preview', {
      filename: 'CustomerMigration.xlsx',
      contentBase64: workbook,
    });
    expect(preview.tables.map((table) => table.sheet)).toEqual([
      'Customers',
      'Contacts',
      'Orders',
      'Instructions',
      'Lookup Notes',
    ]);
    // What the preview is for: the shape is known before anything is stored.
    const customers = preview.tables.find((table) => table.sheet === 'Customers')!;
    expect(customers.rowCount).toBe(40);
    expect(customers.columnCount).toBe(3);
    expect(customers.keyColumn).toBe('customer_number');
  });

  it('imports only the sheets that were chosen', async () => {
    const source = await upload('Customer migration workbook');
    const result = await importInto(source.id, ['Customers', 'Contacts', 'Orders']);

    expect(result.tables).toHaveLength(3);
    const stored = await api.get<{ logicalName: string }[]>(`/api/staged-sources/${source.id}/tables`);
    const names = stored.map((table) => table.logicalName).sort();
    expect(names).toEqual(['contacts', 'customers', 'orders']);
    // The two sheets that are not data were not imported, so they cannot appear in an analysis.
    expect(names).not.toContain('instructions');
    expect(names).not.toContain('lookup_notes');
  });

  it('names a chosen sheet exactly as it would have been named anyway', async () => {
    /*
     * Naming must not depend on the selection. If taking one sheet of five named its table after the file
     * instead of the sheet, re-importing the same workbook with everything selected would create a second
     * table rather than replacing the first — so a correction would silently double the data.
     */
    const all = await upload('Everything');
    await importInto(all.id);
    const one = await upload('Just orders');
    await importInto(one.id, ['Orders']);

    const everything = await api.get<{ logicalName: string }[]>(`/api/staged-sources/${all.id}/tables`);
    const justOrders = await api.get<{ logicalName: string }[]>(`/api/staged-sources/${one.id}/tables`);
    expect(justOrders.map((table) => table.logicalName)).toEqual(['orders']);
    expect(everything.map((table) => table.logicalName)).toContain('orders');
  });

  it('takes the whole workbook when no selection is given', async () => {
    const source = await upload('No selection');
    const result = await importInto(source.id);
    // Five sheets, three of them data: the other two are reported as skipped rather than silently dropped.
    expect(
      result.tables.length + (await api.get<unknown[]>(`/api/staged-sources/${source.id}/tables`)).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it('refuses a sheet the workbook does not have, and says which it has', async () => {
    const source = await upload('Wrong sheet');
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/staged-sources/${source.id}/import`,
      payload: { filename: 'CustomerMigration.xlsx', contentBase64: workbook, sheets: ['Customerz'] },
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(400);
    const message = (res.json() as { error: { message: string } }).error.message;
    expect(message).toContain('no sheet called "Customerz"');
    expect(message).toContain('"Customers"');
  });
});

describe('a dataset is the data, not the thing that carries it', () => {
  let t: TestApp;
  let api: ApiClient;
  let project: ProjectDto;
  let source: EnvironmentDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    project = await api.post<ProjectDto>('/api/projects', { name: 'Dataset granularity', kind: 'ANALYSIS' });
    source = await api.post<EnvironmentDto>(
      '/api/staged-sources',
      { displayName: 'CustomerMigration.xlsx', kind: 'UPLOAD' },
      201,
    );
    await api.post(`/api/staged-sources/${source.id}/import`, {
      filename: 'CustomerMigration.xlsx',
      contentBase64: customerMigrationWorkbook().toString('base64'),
      sheets: ['Customers', 'Contacts', 'Orders'],
    });
    await api.post(`/api/projects/${project.id}/sources`, { environmentId: source.id });
  });
  afterAll(async () => {
    await t?.close();
  });

  const assessment = () => api.get<AnalysisAssessmentDto>(`/api/projects/${project.id}/assessment`);

  it('reports three datasets from one upload, each with its own shape', async () => {
    const [dataset] = (await assessment()).datasets;
    expect(dataset!.objects.map((o) => o.displayName).sort()).toEqual(['Contacts', 'Customers', 'Orders']);

    const customers = dataset!.objects.find((o) => o.displayName === 'Customers')!;
    expect(customers.recordCount).toBe(40);
    expect(customers.columnCount).toBe(3);
    // Which sheet of which file, so "where did this come from" is answerable from the list itself.
    expect(customers.sheetName).toBe('Customers');
    expect(customers.origin).toBe('CustomerMigration.xlsx');
    expect(customers.analysed, 'nothing has been analysed yet').toBe(false);
  });

  it('renames a dataset without changing what it is', async () => {
    await api.request('PATCH', `/api/staged-sources/${source.id}/tables/orders`, {
      displayName: 'Sales orders',
    });
    const [dataset] = (await assessment()).datasets;
    const renamed = dataset!.objects.find((o) => o.logicalName === 'orders')!;
    expect(renamed.displayName).toBe('Sales orders');
    // The identity an import replaces by and a run refers to is untouched.
    expect(renamed.logicalName).toBe('orders');
    expect(renamed.recordCount).toBe(60);

    const audit = await api.get<{ items: { action: string; details: Record<string, unknown> }[] }>(
      '/api/audit',
    );
    const entry = audit.items.find((row) => row.action === 'DATASET_RENAMED');
    expect(entry, 'renaming is recorded').toBeTruthy();
    expect(entry!.details).toMatchObject({ from: 'Orders', to: 'Sales orders' });
  });

  it('refuses to rename a dataset that does not exist', async () => {
    await api.request(
      'PATCH',
      `/api/staged-sources/${source.id}/tables/nonexistent`,
      { displayName: 'X' },
      404,
    );
  });

  it('removes one dataset and leaves the others alone', async () => {
    await api.request('DELETE', `/api/staged-sources/${source.id}/tables/contacts`, undefined, 204);
    const [dataset] = (await assessment()).datasets;
    expect(dataset!.objects.map((o) => o.logicalName).sort()).toEqual(['customers', 'orders']);

    const audit = await api.get<{ items: { action: string; details: Record<string, unknown> }[] }>(
      '/api/audit',
    );
    const entry = audit.items.find((row) => row.action === 'STAGED_SOURCE_TABLE_REMOVED');
    expect(entry, 'removing data is recorded').toBeTruthy();
    expect(entry!.details).toMatchObject({ logicalName: 'contacts', rows: 30 });
  });

  /**
   * A connection in a project with nothing selected from it.
   *
   * The server already refuses to add one — that invariant is tested in `product-invariants.test.ts`. This
   * is the other half: if such a row somehow exists, the assessment must report it as holding nothing
   * rather than as a dataset of zero records, which would read as "we looked and found nothing".
   */
  it('reports a connection holding nothing as holding nothing', async () => {
    const empty = await api.post<EnvironmentDto>(
      '/api/staged-sources',
      { displayName: 'Nothing in here', kind: 'UPLOAD' },
      201,
    );
    await api.post(`/api/projects/${project.id}/sources`, { environmentId: empty.id }, 400);

    const { datasets } = await assessment();
    expect(datasets.map((d) => d.environmentId)).not.toContain(empty.id);
  });
});

describe('a database is not a dataset either', () => {
  let t: TestApp;
  let api: ApiClient;
  let sql: EnvironmentDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    // Discovery is what puts the simulated legacy database in the workspace.
    await api.post<EnvironmentDto[]>('/api/environments/discover');
    const envs = await api.get<EnvironmentDto[]>('/api/environments');
    sql = envs.find((e) => e.connectionType === 'SQL_SERVER')!;
    expect(sql, 'the demo workspace has a simulated SQL Server').toBeTruthy();
  });
  afterAll(async () => {
    await t?.close();
  });

  const project = (name: string) => api.post<ProjectDto>('/api/projects', { name, kind: 'ANALYSIS' });
  const assessment = (id: string) => api.get<AnalysisAssessmentDto>(`/api/projects/${id}/assessment`);

  it('offers the tables of the database so a choice can be made', async () => {
    const tables = await api.get<{ logicalName: string; sqlSchema?: string | null }[]>(
      `/api/environments/${sql.id}/tables`,
    );
    expect(tables.length).toBeGreaterThan(3);
    expect(tables.map((x) => x.logicalName)).toContain('dbo.Customer');
    // More than one schema, which is why the chooser groups them.
    expect(new Set(tables.map((x) => x.sqlSchema)).size).toBeGreaterThan(1);
  });

  it('adds only the tables that were chosen', async () => {
    const p = await project('Two tables of many');
    await api.post(`/api/projects/${p.id}/sources`, {
      environmentId: sql.id,
      objects: ['dbo.Customer', 'config.Region'],
    });

    const [dataset] = (await assessment(p.id)).datasets;
    expect(dataset!.objects.map((o) => o.logicalName).sort()).toEqual(['config.Region', 'dbo.Customer']);
    // Nothing has counted them, so nothing claims to know how big they are.
    expect(dataset!.objects.every((o) => o.recordCount === null)).toBe(true);
    expect(dataset!.objects.every((o) => o.analysed === false)).toBe(true);
  });

  it('refuses a table the database does not have, and says so before anything is created', async () => {
    const p = await project('Table that is not there');
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/sources`,
      payload: { environmentId: sql.id, objects: ['dbo.Customer', 'dbo.Nonexistent'] },
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(400);
    const message = (res.json() as { error: { message: string } }).error.message;
    expect(message).toContain('dbo.Nonexistent');
    expect(message).not.toContain('dbo.Customer');

    // Nothing was added: a refused request must not half-succeed.
    expect((await assessment(p.id)).datasets).toHaveLength(0);
  });

  it('still takes the whole database when nothing is chosen', async () => {
    /*
     * The meaning every project created before this existed has, and must keep. An upgrade that silently
     * narrowed an existing project's scope would change an analysis nobody asked to change.
     */
    const p = await project('Everything in it');
    await api.post(`/api/projects/${p.id}/sources`, { environmentId: sql.id });
    const [dataset] = (await assessment(p.id)).datasets;
    expect(dataset!.objects, 'nothing is listed until a run has looked').toHaveLength(0);
  });

  it('analyses only the chosen tables', async () => {
    const p = await project('Scoped analysis');
    await api.post(`/api/projects/${p.id}/sources`, {
      environmentId: sql.id,
      objects: ['config.Region'],
    });
    await api.post(`/api/projects/${p.id}/analyse`, { all: true });

    /*
     * The analysis is queued rather than run inline, which is correct — the request returns before the
     * work does. Here the test does what the worker does in production.
     */
    const worker = t.services.createWorker();
    await worker.drain(120_000);
    await worker.stop();

    const [dataset] = (await assessment(p.id)).datasets;
    expect(dataset!.state).toBe('ANALYSED');
    /*
     * The selection is a fact about the work, not a label on a screen. Analysing the whole database
     * because one table was chosen would read as "we analysed your data" and mean something else.
     */
    expect(dataset!.objects.map((o) => o.logicalName)).toEqual(['config.Region']);
    expect(dataset!.tables).toBe(1);
    expect(dataset!.objects[0]!.recordCount, 'now it has been counted').toBeGreaterThan(0);
    expect(dataset!.objects[0]!.analysed).toBe(true);
  });
});

/**
 * The SharePoint integrity test.
 *
 * The behaviour this exists to make impossible, observed on the build before the reset:
 *
 *   create a SharePoint connection   -> HTTP 201
 *   select no site, list or file     -> nothing
 *   add it to a project as a dataset -> HTTP 200      ← accepted
 *   analyse                          -> HTTP 200      ← accepted
 *   … asynchronously …               -> FAILED
 *
 * Authenticating to SharePoint is not choosing a list. A connection that holds nothing is not a dataset,
 * and every door into the product has to agree about that — including the ones a browser never opens,
 * because a disabled button is a courtesy and the API is the contract.
 */
describe('a SharePoint connection that holds nothing', () => {
  let t: TestApp;
  let api: ApiClient;
  let connection: EnvironmentDto;
  let project: ProjectDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    connection = await api.post<EnvironmentDto>(
      '/api/staged-sources',
      { displayName: 'Claims Operations', kind: 'SHAREPOINT' },
      201,
    );
    project = await api.post<ProjectDto>('/api/projects', {
      name: 'SharePoint integrity',
      kind: 'ANALYSIS',
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  const call = (method: 'POST' | 'GET', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      payload: payload as never,
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });

  it('is created successfully, because authenticating is a thing that can succeed', async () => {
    expect(connection.id).toBeTruthy();
    expect(connection.connectionType).toBe('SHAREPOINT');
  });

  it('is refused as a dataset, in words that name the choice nobody has made', async () => {
    const res = await call('POST', `/api/projects/${project.id}/sources`, {
      environmentId: connection.id,
    });
    expect(res.statusCode).toBe(400);
    const message = (res.json() as { error: { message: string } }).error.message;
    expect(message).toContain('No content is selected');
    // Not a malfunction — a next step.
    expect(message).toContain('Select a list, library or file');
  });

  it('is refused the same way by a direct API call that skips the screen entirely', async () => {
    /*
     * The same request, made the way a script would. There is no second path: the rule lives in the
     * domain, so there is nowhere to make this request from where it is accepted.
     */
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sources`,
      payload: { environmentId: connection.id } as never,
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(400);
  });

  it('cannot be analysed, and no empty analysis is produced by trying', async () => {
    const res = await call('POST', `/api/projects/${project.id}/analyse`, { all: true });
    expect(res.statusCode).toBe(400);

    const assessment = await api.get<AnalysisAssessmentDto>(`/api/projects/${project.id}/assessment`);
    /*
     * The negative claim that matters. Nothing may be created by asking for the impossible: no run, no
     * readiness, no findings, no "0 tables / 0 records" presented as an assessment of data that is not
     * there.
     */
    expect(assessment.datasets).toHaveLength(0);
    expect(assessment.runs).toHaveLength(0);
    expect(assessment.findings).toHaveLength(0);
    expect(assessment.readiness.score).toBeNull();
  });

  it('becomes a dataset the moment it actually holds content, and not before', async () => {
    /*
     * Content arrives here by import rather than by Graph, because a tenant is not available to this
     * test — but the rule under test is not about where the rows came from. It is that the connection
     * was refused while it held nothing and accepted once it held something.
     */
    const csv = 'claim_number,status\r\nCLM-1,Open\r\nCLM-2,Closed';
    const imported = await call('POST', `/api/staged-sources/${connection.id}/import`, {
      filename: 'Claims.csv',
      contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
    });
    expect(imported.statusCode).toBe(200);

    const accepted = await call('POST', `/api/projects/${project.id}/sources`, {
      environmentId: connection.id,
    });
    expect(accepted.statusCode, 'the selection is what makes it a dataset').toBe(200);

    const assessment = await api.get<AnalysisAssessmentDto>(`/api/projects/${project.id}/assessment`);
    expect(assessment.datasets).toHaveLength(1);
    expect(assessment.datasets[0]!.objects.map((o) => o.displayName)).toEqual(['Claims']);
  });
});

describe('browsing a Microsoft connection needs a Microsoft sign-in, and says so', () => {
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

  it('explains what is missing rather than failing obscurely', async () => {
    const connection = await api.post<EnvironmentDto>(
      '/api/staged-sources',
      { displayName: 'Finance SharePoint', kind: 'SHAREPOINT' },
      201,
    );
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/staged-sources/${connection.id}/sites`,
      headers: { cookie: api.cookie },
    });
    /*
     * A demo workspace has no Microsoft token, so this cannot work — and the one thing that must not
     * happen is a blank list, which would read as "your tenant has no sites".
     */
    expect(res.statusCode).toBe(400);
    const message = (res.json() as { error: { message: string } }).error.message;
    expect(message).toContain('Microsoft sign-in');
  });
});
