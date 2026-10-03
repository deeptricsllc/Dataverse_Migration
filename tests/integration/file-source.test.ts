import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AnalysisRunDto,
  EnvironmentDto,
  ProjectDto,
  StagedImportResultDto,
  StagedTableDto,
} from '../../shared/domain';
import { writeXlsx } from '../../server/src/lib/xlsx';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * A spreadsheet as a source, end to end: created, imported, discovered, profiled and read.
 *
 * The point of the exercise is that everything after the import is the ordinary platform. A file
 * arrives with no schema and every value as text; once it is staged, analysis, profiling and mapping
 * treat it like any other source — and, crucially, refuse to treat it as a target.
 */
describe('CSV, Excel and XML as a source', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let source: EnvironmentDto;

  const csv = [
    'Customer Export 2026',
    '',
    // `legacy_code` is empty in every row: the column an extract carries because the report always
    // had it, which is exactly what an analysis should point out before anyone maps it.
    'customer_id,company_name,employees,credit_limit,is_active,signed_on,region,notes,legacy_code',
    'C-001,Acme Industries,120,25000.50,yes,2024-03-01,North,,',
    'C-002,"Globex, Inc.",4,1000,no,2025-11-14,South,"said ""hello""",',
    'C-003,Initech,N/A,0,yes,2023-07-22,North,legacy,',
    'C-004,Umbrella,88,,YES,2026-01-05,,,',
  ].join('\r\n');

  const upload = (filename: string, content: Buffer | string) =>
    api.post<StagedImportResultDto>(`/api/staged-sources/${source.id}/import`, {
      filename,
      contentBase64: Buffer.isBuffer(content)
        ? content.toString('base64')
        : Buffer.from(content, 'utf8').toString('base64'),
    });

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    source = await api.post<EnvironmentDto>(
      '/api/staged-sources',
      { displayName: 'Customer extracts', kind: 'UPLOAD' },
      201,
    );
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  // ---------------------------------------------------------------------------

  it('creates a source that needs no host, port or credential', () => {
    expect(source).toMatchObject({ connectionType: 'FILE', displayName: 'Customer extracts' });
    expect(source.sql).toBeNull();
    // It can never be a migration target, and says so rather than being quietly unusable.
    expect(source.capabilities.supportsWrite).toBe(false);
    expect(source.capabilities.supportsRead).toBe(true);
  });

  it('imports a CSV, finding the header under the title line', async () => {
    const result = await upload('Customer Export (2026).csv', csv);
    expect(result.tables).toHaveLength(1);
    expect(result.totalRows).toBe(4);

    const [table] = result.tables;
    expect(table.logicalName).toBe('customer_export_2026');
    expect(table.rowCount).toBe(4);
    // A key-shaped column that is unique and never empty identifies the row.
    expect(table.keyColumn).toBe('customer_id');
    expect(table.keyIsSynthetic).toBe(false);

    const byName = new Map(table.columns.map((c) => [c.name, c]));
    expect(byName.get('employees')!.type).toBe('Integer'); // N/A counts as empty, not as text
    expect(byName.get('credit_limit')!.type).toBe('Decimal');
    expect(byName.get('is_active')!.type).toBe('Boolean');
    expect(byName.get('signed_on')!.type).toBe('DateTime');
    expect(byName.get('company_name')!.type).toBe('String');
    // The reasoning is reported, so the inference is inspectable rather than magic.
    expect(byName.get('employees')!.reason).toMatch(/whole number/);
    expect(byName.get('notes')!.blanks).toBe(2);
    // A column with nothing in it at all is typed as text, because text accepts whatever arrives.
    expect(byName.get('legacy_code')!.reason).toMatch(/no values/);
  });

  it('reads the rows back through the connector, with quoting intact', async () => {
    const env = await t.services.environments.getInOrganization(
      (await api.get<{ user: { organization: { id: string } } }>('/api/auth/session')).user.organization.id,
      source.id,
    );
    const conn = await t.services.connections.connectorFor(env, 'test', {});
    const meta = await conn.getTable('customer_export_2026');

    expect((await conn.countRecords(meta)).count).toBe(4);
    // Exact, always: the rows are in the platform's own database, so there is no estimate to give.
    expect((await conn.countRecords(meta)).approximate).toBe(false);

    const records = [];
    for await (const page of conn.queryRecords(meta, [], { pageSize: 2 })) records.push(...page);
    expect(records).toHaveLength(4);
    expect(records[0].id).toBe('C-001');

    const globex = records[1];
    // A comma inside a quoted field is part of the value, and a doubled quote is one quote.
    expect(globex.values.company_name).toBe('Globex, Inc.');
    expect(globex.values.notes).toBe('said "hello"');
    // Where the whole column agreed on a type, the value arrives as that type.
    expect(globex.values.employees).toBe(4);
    expect(globex.values.is_active).toBe(false);
    expect(records[0].values.is_active).toBe(true);
    // A blank is null, not an empty string pretending to be a value.
    expect(records[3].values.credit_limit).toBeNull();

    // Reading only some columns returns only those.
    const narrow = [];
    for await (const page of conn.queryRecords(meta, ['company_name'], { pageSize: 10 })) {
      narrow.push(...page);
    }
    expect(Object.keys(narrow[0].values)).toEqual(['company_name']);
  });

  it('refuses to be written to, rather than failing obscurely later', async () => {
    const env = await t.services.environments.getInOrganization(
      (await api.get<{ user: { organization: { id: string } } }>('/api/auth/session')).user.organization.id,
      source.id,
    );
    const conn = await t.services.connections.connectorFor(env, 'test', {});
    const meta = await conn.getTable('customer_export_2026');
    const writeOptions = { bypassCustomBusinessLogic: false, suppressFlowTriggers: false };
    await expect(conn.createRecord(meta, { values: {} }, writeOptions)).rejects.toThrow(
      /do not support create/i,
    );
    await expect(conn.updateRecord(meta, 'C-001', { values: {} }, writeOptions)).rejects.toThrow(
      /do not support update/i,
    );
    // Marked a view, which is how the planner already refuses to offer something as a target.
    expect(meta.isView).toBe(true);
  });

  it('imports a workbook as one table per sheet, and says which it skipped', async () => {
    const book = writeXlsx([
      {
        name: 'Customers',
        columns: [{ header: 'id' }, { header: 'name' }],
        rows: [
          ['1', 'Acme'],
          ['2', 'Globex'],
        ],
      },
      {
        name: 'Regions',
        columns: [{ header: 'code' }, { header: 'label' }],
        rows: [['N', 'North']],
      },
      // A tab with a header and nothing under it is normal in a real export.
      { name: 'Notes', columns: [{ header: 'heading' }], rows: [] },
    ]);
    const result = await upload('reference.xlsx', book);
    expect(result.tables.map((x) => x.logicalName).sort()).toEqual(['customers', 'regions']);
    expect(result.skipped).toEqual([{ name: 'Notes', reason: 'no header row with values beneath it' }]);
    expect(result.tables.find((x) => x.logicalName === 'customers')!.sheetName).toBe('Customers');
  });

  it('replaces a table on re-import instead of duplicating it', async () => {
    const before = await api.get<StagedTableDto[]>(`/api/staged-sources/${source.id}/tables`);
    expect(before.map((x) => x.logicalName)).toContain('customer_export_2026');

    // Two snapshots concatenated are not a bigger snapshot.
    const again = await upload('Customer Export (2026).csv', csv);
    expect(again.tables[0].rowCount).toBe(4);
    const after = await api.get<StagedTableDto[]>(`/api/staged-sources/${source.id}/tables`);
    expect(after.filter((x) => x.logicalName === 'customer_export_2026')).toHaveLength(1);
    expect(after.length).toBe(before.length);
  });

  it('analyses a spreadsheet the same way it analyses a database', async () => {
    const project = await api.post<ProjectDto>('/api/projects', {
      name: 'What is in the extract',
      kind: 'ANALYSIS',
      sourceEnvironmentId: source.id,
    });
    const started = await api.post<AnalysisRunDto>(`/api/projects/${project.id}/analyses`, {
      tables: ['customer_export_2026'],
      full: true,
    });
    await worker.drain(180_000);
    const run = await api.get<AnalysisRunDto>(`/api/analyses/${started.id}`);

    expect(run.status).toBe('COMPLETED');
    // Every row of a known-size table: nothing here is an estimate.
    expect(run.basis).toBe('EXACT');
    const table = run.tables.find((x) => x.logicalName === 'customer_export_2026')!;
    expect(table.recordCount).toBe(4);
    expect(table.examined).toBe(4);
    // The column that is empty in every row is found, which is the whole reason to analyse an
    // extract before mapping it — and the key column is NOT reported empty just because a connector
    // returns it as the record's id rather than among its values.
    expect(table.emptyColumns).toEqual(['legacy_code']);
  });

  it('removes an imported table and its rows together', async () => {
    await api.request('DELETE', `/api/staged-sources/${source.id}/tables/regions`, undefined, 204);
    const after = await api.get<StagedTableDto[]>(`/api/staged-sources/${source.id}/tables`);
    expect(after.map((x) => x.logicalName)).not.toContain('regions');
  });

  it('imports an XML extract as a table, and types its columns like any other source', async () => {
    // XML is how most legacy systems export. Before this it was read as delimited text, which
    // produced a one-column table of markup that then profiled and migrated like real data.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<orders>
  <order ref="ORD-1" channel="web">
    <customer>Acme Industries</customer>
    <placed>2026-01-04</placed>
    <total>1250.75</total>
    <shipping><city>Leeds</city><country>UK</country></shipping>
  </order>
  <order ref="ORD-2" channel="phone">
    <customer>Globex</customer>
    <placed>2026-02-11</placed>
    <total>99</total>
    <shipping><city>Derby</city><country>UK</country></shipping>
  </order>
  <order ref="ORD-3" channel="web">
    <customer>Initech</customer>
    <placed>2026-03-02</placed>
    <total>480.10</total>
    <shipping><city>Hull</city><country>UK</country></shipping>
  </order>
</orders>`;
    const result = await upload('orders.xml', xml);
    expect(result.tables).toHaveLength(1);

    const [table] = result.tables;
    expect(table.logicalName).toBe('orders');
    // Named after the file, like a CSV. The element that became the rows is shown beside it.
    expect(table.displayName).toBe('orders');
    expect(table.sheetName).toBe('<order> elements');
    expect(table.rowCount).toBe(3);
    const byName = new Map(table.columns.map((c) => [c.name, c]));
    // Attributes, leaf elements and a nested path each become a column.
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining(['ref', 'channel', 'customer', 'placed', 'total', 'shipping_city']),
    );
    // Typing is the same inference every other source gets, so the values really did arrive as
    // values rather than as markup.
    expect(byName.get('total')!.type).toBe('Decimal');
    expect(byName.get('placed')!.type).toBe('DateTime');
    expect(byName.get('customer')!.type).toBe('String');
    // The attribute that is unique and never empty identifies the row.
    expect(table.keyColumn).toBe('ref');
    expect(table.keyIsSynthetic).toBe(false);
  });

  it('reads XML rows back through the connector with their values intact', async () => {
    const env = await t.services.environments.getInOrganization(
      (await api.get<{ user: { organization: { id: string } } }>('/api/auth/session')).user.organization.id,
      source.id,
    );
    const conn = await t.services.connections.connectorFor(env, 'test', {});
    // Named after the file, the same rule a CSV follows; the record element becomes the display name.
    const meta = await conn.getTable('orders');
    const records = [];
    for await (const page of conn.queryRecords(meta, ['customer', 'shipping_city'], { pageSize: 50 })) {
      records.push(...page);
    }
    expect(records).toHaveLength(3);
    // The key column arrives as the record's id, the same as it does for a CSV.
    expect(records[0].id).toBe('ORD-1');
    // An attribute, a leaf element and a nested element all arrive as ordinary values.
    expect(records[0].values).toMatchObject({ customer: 'Acme Industries', shipping_city: 'Leeds' });
    expect(records[2].values.shipping_city).toBe('Hull');
    await conn.dispose?.();
  });

  it('analyses an XML extract the same way it analyses a database', async () => {
    const project = await api.post<ProjectDto>('/api/projects', {
      name: 'Legacy order extract',
      kind: 'ANALYSIS',
      sourceEnvironmentId: source.id,
    });
    const run = await api.post<AnalysisRunDto>(`/api/projects/${project.id}/analyses`, {
      tables: ['orders'],
      full: true,
    });
    await worker.drain(120_000);
    const done = await api.get<AnalysisRunDto>(`/api/analyses/${run.id}`);
    expect(done.status, done.errorMessage ?? '').toBe('COMPLETED');
    const [analysed] = done.tables;
    expect(analysed.recordCount).toBe(3);
    // Every record was read, so the figures are exact rather than a floor.
    expect(analysed.basis).toBe('EXACT');
  }, 180_000);

  it('refuses an XML file with a document type declaration', async () => {
    // A DOCTYPE is how entity expansion gets in. No data extract needs one.
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [ <!ENTITY lol "lol"> ]>
<rows><row><a>&lol;</a></row><row><a>b</a></row></rows>`;
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/staged-sources/${source.id}/import`,
      payload: { filename: 'bomb.xml', contentBase64: Buffer.from(bomb).toString('base64') } as never,
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/document type declaration/);
  });

  it('says what an import overwrote, and flags when a different file took the name', async () => {
    // The table name is its identity: importing over it deletes the rows that were there. That is
    // right for a snapshot and wrong to do silently, and the dangerous case is two different files
    // resolving to one name.
    const first = await upload('monthly.csv', 'id,name\n1,Acme\n2,Globex\n3,Initech');
    expect(first.replaced).toEqual([]);
    expect(first.tables[0].rowCount).toBe(3);

    // The same file again: ordinary, and still reported.
    const again = await upload('monthly.csv', 'id,name\n1,Acme');
    expect(again.replaced).toHaveLength(1);
    expect(again.replaced[0]).toMatchObject({
      logicalName: 'monthly',
      previousRows: 3,
      previousSourceRef: 'monthly.csv',
    });

    // A different file whose name normalises to the same table. The rows from the first are gone,
    // and the result names the file they came from.
    const collision = await upload('Monthly.CSV', 'id,name\n9,Umbrella');
    expect(collision.replaced).toHaveLength(1);
    expect(collision.replaced[0].previousSourceRef).toBe('monthly.csv');
    expect(collision.replaced[0].previousSourceRef).not.toBe('Monthly.CSV');
  });

  it('names an XML table after the file, not after the record element', async () => {
    // Deliberate. Every monthly orders export holds <order>, so naming the table after the element
    // would make two unrelated extracts overwrite each other. The element is shown beside the
    // table instead, because which element became the rows is the one non-obvious decision here.
    const xml = '<orders><order ref="A"><n>1</n></order><order ref="B"><n>2</n></order></orders>';
    const jan = await upload('orders-jan.xml', xml);
    const feb = await upload('orders-feb.xml', xml);
    expect(jan.tables[0].logicalName).toBe('orders_jan');
    expect(feb.tables[0].logicalName).toBe('orders_feb');
    // Neither replaced the other.
    expect(feb.replaced).toEqual([]);
    expect(jan.tables[0].displayName).toBe('orders-jan');
    expect(jan.tables[0].sheetName).toBe('<order> elements');
  });

  it('shows a table imported after the source was already used', async () => {
    // The bug this pins: the table catalogue is cached with a time-to-live, and importing a file
    // did not drop it. A source that had already been listed or analysed therefore kept answering
    // with the tables it held at that moment — a newly imported table was invisible, and asking for
    // it by name came back "none of the requested tables exist in this source".
    const env = await t.services.environments.getInOrganization(
      (await api.get<{ user: { organization: { id: string } } }>('/api/auth/session')).user.organization.id,
      source.id,
    );
    const conn = await t.services.connections.connectorFor(env, 'test', {});

    // Warm the cache, the way listing tables or running an analysis does.
    const before = await t.services.metadata.getCatalog(env.id, conn);
    expect(before.some((table) => table.logicalName === 'late_arrival')).toBe(false);

    await upload('late_arrival.csv', 'id,name\n1,Acme\n2,Globex');

    const after = await t.services.metadata.getCatalog(env.id, conn);
    expect(after.some((table) => table.logicalName === 'late_arrival')).toBe(true);

    // And removing a table takes it back out, rather than leaving a catalogue entry that leads to
    // a table which is no longer there.
    await api.request('DELETE', `/api/staged-sources/${source.id}/tables/late_arrival`, undefined, 204);
    const removed = await t.services.metadata.getCatalog(env.id, conn);
    expect(removed.some((table) => table.logicalName === 'late_arrival')).toBe(false);
    await conn.dispose?.();
  });

  it('says what it cannot read, rather than importing nonsense', async () => {
    await api.request(
      'POST',
      `/api/staged-sources/${source.id}/import`,
      { filename: 'notes.txt', contentBase64: Buffer.from('just a sentence.').toString('base64') },
      400,
    );
    await api.request(
      'POST',
      `/api/staged-sources/${source.id}/import`,
      { filename: 'empty.csv', contentBase64: Buffer.from('').toString('base64') },
      400,
    );
    // A real binary is not a spreadsheet and is told so.
    await api.request(
      'POST',
      `/api/staged-sources/${source.id}/import`,
      {
        filename: 'photo.png',
        contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('base64'),
      },
      400,
    );
    // Formats that are text but are not tables are named, rather than being read as one column.
    for (const [filename, body] of [
      ['data.json', '{"rows":[{"a":1}]}'],
      ['page.html', '<!DOCTYPE html><html><body>hi</body></html>'],
    ] as const) {
      await api.request(
        'POST',
        `/api/staged-sources/${source.id}/import`,
        { filename, contentBase64: Buffer.from(body).toString('base64') },
        400,
      );
    }
  });

  it('will not import into a live database connection', async () => {
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const sqlDemo = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
    await api.request(
      'POST',
      `/api/staged-sources/${sqlDemo.id}/import`,
      { filename: 'x.csv', contentBase64: Buffer.from('a,b\n1,2').toString('base64') },
      400,
    );
  });
});
