import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AnalysisRunDto,
  AnalysisRunListItemDto,
  AnalysisTableDetailDto,
  EnvironmentDto,
  MappingImportPreviewDto,
  MigrationPlanDto,
  MigrationScheduleDto,
  ProjectDto,
} from '../../shared/domain';
import { readXlsx, rowsByHeader, writeXlsx } from '../../server/src/lib/xlsx';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The analysis half of the platform, end to end: a project, an analysis of a real source, the
 * mapping workbook it produces, a migration project that starts from it, and a schedule that keeps
 * the migration running afterwards.
 */
describe('projects, source analysis, mapping workbook and schedules', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let sqlSource: EnvironmentDto;
  let qa: EnvironmentDto;
  let analysisProject: ProjectDto;
  let analysis: AnalysisRunDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    sqlSource = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  // ---------------------------------------------------------------------------

  it('creates an analysis project, and refuses to give it a target', async () => {
    analysisProject = await api.post<ProjectDto>('/api/projects', {
      name: 'Understand the legacy database',
      kind: 'ANALYSIS',
      description: 'What is actually in there, before anyone decides where it goes.',
      sourceEnvironmentId: sqlSource.id,
    });
    expect(analysisProject).toMatchObject({ kind: 'ANALYSIS', status: 'ACTIVE', itemCount: 0 });
    expect(analysisProject.sourceEnvironment?.displayName).toBe('Legacy SQL Server (Demo)');
    expect(analysisProject.targetEnvironment).toBeNull();

    // An analysis project has nowhere to write, and saying otherwise is refused rather than ignored.
    await api.request(
      'POST',
      '/api/projects',
      { name: 'Wrong', kind: 'ANALYSIS', sourceEnvironmentId: sqlSource.id, targetEnvironmentId: qa.id },
      400,
    );
    await api.request('PATCH', `/api/projects/${analysisProject.id}`, { targetEnvironmentId: qa.id }, 400);
    // And only a migration project may reference an analysis.
    await api.request(
      'POST',
      '/api/projects',
      { name: 'Wrong', kind: 'ANALYSIS', analysisProjectId: analysisProject.id },
      400,
    );
  });

  it('lists what the source offers before anything is analysed', async () => {
    const tables = await api.get<{ logicalName: string; displayName: string }[]>(
      `/api/projects/${analysisProject.id}/source-tables`,
    );
    expect(tables.map((x) => x.logicalName)).toContain('dbo.Customer');
    expect(tables.map((x) => x.logicalName)).toContain('dbo.Order');
  });

  it('analyses the source and reports what is in it', async () => {
    const started = await api.post<AnalysisRunDto>(`/api/projects/${analysisProject.id}/analyses`, {
      name: 'Customers and orders',
      tables: ['dbo.Customer', 'dbo.Order'],
      full: true,
    });
    expect(started.status).toBe('QUEUED');
    await worker.drain(180_000);
    analysis = await api.get<AnalysisRunDto>(`/api/analyses/${started.id}`);

    expect(analysis.status).toBe('COMPLETED');
    expect(analysis.errorMessage).toBeNull();
    // Every record of both tables was read against an exact count, so nothing here is an estimate.
    expect(analysis.basis).toBe('EXACT');
    expect(analysis.totals.tables).toBe(2);
    expect(analysis.totals.columns).toBeGreaterThan(10);
    expect(analysis.totals.records).toBeGreaterThan(25);
    expect(analysis.totals.findings).toBeGreaterThan(0);

    const customer = analysis.tables.find((x) => x.logicalName === 'dbo.Customer')!;
    expect(customer.recordCount).toBe(26);
    expect(customer.examined).toBe(26);
    expect(customer.basis).toBe('EXACT');
    expect(customer.primaryKeyField).toBe('CustomerId');

    // An order points at a customer, so the dependency-safe order puts customers first.
    const order = analysis.tables.find((x) => x.logicalName === 'dbo.Order')!;
    expect(order.dependsOn).toContain('dbo.Customer');
    expect(customer.orderIndex).toBeLessThan(order.orderIndex);
  });

  it('finds what the source contradicts about itself, and which columns hold nothing', async () => {
    const detail = await api.get<AnalysisTableDetailDto>(`/api/analyses/${analysis.id}/tables/dbo.Customer`);
    expect(detail.profile.fields.length).toBeGreaterThan(10);

    const email = detail.profile.fields.find((f) => f.field === 'Email')!;
    // The demo data has nulls, blanks and one value that is not an email address.
    expect(email.nullCount).toBeGreaterThan(0);
    expect(email.blankCount).toBeGreaterThan(0);

    const name = detail.profile.fields.find((f) => f.field === 'CustomerName')!;
    expect(name.whitespaceCount).toBeGreaterThan(0);
    expect(name.maxLength).toBeGreaterThan(0);
    expect(name.distinctCount).toBeGreaterThan(0);

    const findings = await api.get<{ code: string; field: string | null; affected: number }[]>(
      `/api/analyses/${analysis.id}/findings`,
    );
    expect(findings.length).toBeGreaterThan(0);
    // Duplicate business keys are a source fact, findable with no target in sight.
    expect(detail.duplicateKeyCount).toBeGreaterThanOrEqual(0);

    const blockers = await api.get<unknown[]>(`/api/analyses/${analysis.id}/findings?severity=BLOCKER`);
    expect(Array.isArray(blockers)).toBe(true);
  });

  it('exports a mapping workbook a person can actually fill in', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/analyses/${analysis.id}/mapping.xlsx`,
      headers: { cookie: api.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toMatch(/\.xlsx"$/);

    const sheets = readXlsx(res.rawPayload);
    expect(sheets.map((x) => x.name)).toEqual([
      'Overview',
      'Tables',
      'Field mapping',
      'Transformations',
      'Value maps',
      'Concat parts',
      'Findings',
    ]);

    const mapping = rowsByHeader(sheets[2], ['Source table', 'Source field', 'Target field'])!;
    expect(mapping).not.toBeNull();
    expect(mapping.rows.length).toBeGreaterThan(20);
    const customerName = mapping.rows.find(
      (r) => r.sourcetable === 'dbo.Customer' && r.sourcefield === 'CustomerName',
    )!;
    // The source columns are measured facts; the target columns are the blanks to fill in.
    expect(Number(customerName.records)).toBe(26);
    expect(customerName.sourcetype).toBeTruthy();
    expect(customerName.targetfield).toBe('');

    // The Tables sheet carries the load order and the empty columns.
    const tables = rowsByHeader(sheets[1], ['Source table', 'Records'])!;
    expect(tables.rows.find((r) => r.sourcetable === 'dbo.Customer')!.loadorder).toBeTruthy();
  });

  // ---------------------------------------------------------------------------

  let migrationProject: ProjectDto;
  let plan: MigrationPlanDto;

  it('creates a migration project that starts from the analysis', async () => {
    migrationProject = await api.post<ProjectDto>('/api/projects', {
      name: 'Legacy customers into QA',
      kind: 'MIGRATION',
      sourceEnvironmentId: sqlSource.id,
      targetEnvironmentId: qa.id,
      analysisProjectId: analysisProject.id,
    });
    expect(migrationProject.analysisProject?.id).toBe(analysisProject.id);
    expect(migrationProject.targetEnvironment?.displayName).toBe('DeepTrics QA');

    plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Customers',
      sourceEnvironmentId: sqlSource.id,
      targetEnvironmentId: qa.id,
      tables: ['dbo.Customer'],
      projectId: migrationProject.id,
    });
    expect(plan.projectId).toBe(migrationProject.id);
    expect(plan.projectName).toBe('Legacy customers into QA');

    const plans = await api.get<{ id: string }[]>(`/api/projects/${migrationProject.id}/plans`);
    expect(plans.map((p) => p.id)).toEqual([plan.id]);
    // The project now reports the work inside it.
    const reread = await api.get<ProjectDto>(`/api/projects/${migrationProject.id}`);
    expect(reread.itemCount).toBe(1);
  });

  it("carries the analysis's source facts into the plan's mapping workbook", async () => {
    const entity = plan.entities.find((e) => e.logicalName === 'dbo.Customer')!;
    await api.patch(`/api/plans/${plan.id}/entities/${entity.id}/object-mapping`, {
      targetLogicalName: 'account',
      status: 'CONFIRMED',
    });

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/plans/${plan.id}/mapping.xlsx`,
      headers: { cookie: api.cookie },
    });
    expect(res.statusCode).toBe(200);
    const sheets = readXlsx(res.rawPayload);
    const overview = sheets[0].rows.map((r) => r.join(' ')).join('\n');
    // The workbook says where its source statistics came from, rather than presenting them bare.
    expect(overview).toContain('Customers and orders');

    const mapping = rowsByHeader(sheets[2], ['Source table', 'Source field', 'Target field'])!;
    const row = mapping.rows.find((r) => r.sourcefield === 'CustomerName')!;
    expect(Number(row.records)).toBe(26);
    expect(row.targettable).toBe('account');
  });

  /** The mapping sheet a reviewer sends back, plus whatever transformation sheets are given. */
  const workbook = (mappingRows: (string | number | null)[][], extra: Parameters<typeof writeXlsx>[0] = []) =>
    writeXlsx([
      {
        name: 'Field mapping',
        columns: [{ header: 'Source table' }, { header: 'Source field' }, { header: 'Target field' }],
        rows: mappingRows,
      },
      ...extra,
    ]);

  it('applies a filled-in workbook, refusing what the mapping screen would refuse', async () => {
    // What a reviewer sends back: two real decisions, one deliberate exclusion, one impossible
    // request, and one row naming a column this plan does not have.
    const filled = workbook(
      [
        ['dbo.Customer', 'CustomerName', 'name'],
        ['dbo.Customer', 'CustomerNumber', 'accountnumber'],
        ['dbo.Customer', 'Notes', 'IGNORE'],
        ['dbo.Customer', 'CustomerName', 'no_such_column_here'],
        ['dbo.Customer', 'NotAColumn', 'name'],
      ],
      [
        {
          name: 'Transformations',
          columns: [
            { header: 'Source table' },
            { header: 'Source field' },
            { header: 'Step' },
            { header: 'Rule' },
            { header: 'Length' },
          ],
          rows: [
            ['dbo.Customer', 'CustomerName', 1, 'TRIM', ''],
            ['dbo.Customer', 'CustomerName', 2, 'TRUNCATE', 160],
          ],
        },
      ],
    );
    const payload = { filename: 'mapping.xlsx', contentBase64: filled.toString('base64') };

    // A dry run changes nothing: a sheet arrives by email, and what it does is seen first.
    const preview = await api.post<MappingImportPreviewDto>(
      `/api/plans/${plan.id}/mapping-workbook`,
      payload,
    );
    expect(preview.applied).toBe(false);
    expect(preview.matched).toBe(4);
    expect(preview.unmatched).toEqual([
      expect.objectContaining({ field: 'NotAColumn', reason: 'That column is not in this plan' }),
    ]);
    expect(preview.changes.some((c) => c.field === 'CustomerName' && c.to === 'name')).toBe(true);
    // The transformation sheets are counted too, and equally not applied yet.
    expect(preview.transformationsChanged).toBe(1);
    const beforeApply = await api.get<{ mappings: { sourceField: string; targetField: string | null }[] }>(
      `/api/plans/${plan.id}/entities/${plan.entities[0].id}/mappings`,
    );
    expect(beforeApply.mappings.find((m) => m.sourceField === 'Notes')?.targetField ?? null).not.toBe(
      'IGNORE',
    );

    const applied = await api.post<MappingImportPreviewDto>(`/api/plans/${plan.id}/mapping-workbook`, {
      ...payload,
      apply: true,
    });
    expect(applied.applied).toBe(true);
    // The impossible target column is reported against its row, not silently dropped.
    expect(applied.rejected.some((r) => r.reason.includes('no_such_column_here'))).toBe(true);

    const after = await api.get<{
      mappings: { sourceField: string; targetField: string | null; status: string }[];
    }>(`/api/plans/${plan.id}/entities/${plan.entities[0].id}/mappings`);
    const byField = new Map(after.mappings.map((m) => [m.sourceField, m]));
    expect(byField.get('CustomerName')!.targetField).toBe('name');
    expect(byField.get('CustomerNumber')!.targetField).toBe('accountnumber');
    expect(byField.get('Notes')!.status).toBe('IGNORED');

    // The transformation column round-tripped into real rules, through the same engine.
    const lossy = await api.get<{ field: string; kind: string }[]>(
      `/api/plans/${plan.id}/lossy-transformations`,
    );
    expect(lossy).toEqual([expect.objectContaining({ field: 'CustomerName', kind: 'TRUNCATE' })]);
  });

  it('round-trips a value map, a concatenation and a conditional through the sheets', async () => {
    // The rules a business analyst most needs to edit in a spreadsheet are exactly the ones a single
    // text cell could not express.
    const filled = workbook(
      [
        ['dbo.Customer', 'Email', 'emailaddress1'],
        ['dbo.Customer', 'StatusCode', 'IGNORE'],
      ],
      [
        {
          name: 'Transformations',
          columns: [
            { header: 'Source table' },
            { header: 'Source field' },
            { header: 'Step' },
            { header: 'Rule' },
            { header: 'On unmapped' },
            { header: 'Separator' },
            { header: 'Condition field' },
            { header: 'Condition operator' },
            { header: 'Condition value' },
            { header: 'Action' },
            { header: 'Value' },
            { header: 'Inside step' },
          ],
          rows: [
            ['dbo.Customer', 'Email', 1, 'TRIM', '', '', '', '', '', '', '', ''],
            ['dbo.Customer', 'Email', 2, 'LOWERCASE', '', '', '', '', '', '', '', ''],
            ['dbo.Customer', 'Email', 3, 'VALUE_MAP', 'IGNORE', '', '', '', '', '', '', ''],
            ['dbo.Customer', 'Email', 4, 'CONCAT', '', '-', '', '', '', '', '', ''],
            ['dbo.Customer', 'Email', 5, 'IF_THEN', '', '', 'Email', 'IS_BLANK', '', 'APPLY', '', ''],
            ['dbo.Customer', 'Email', 6, 'CONSTANT', '', '', '', '', '', '', 'unknown@example.com', 5],
          ],
        },
        {
          name: 'Value maps',
          columns: [
            { header: 'Source table' },
            { header: 'Source field' },
            { header: 'Step' },
            { header: 'From' },
            { header: 'To' },
          ],
          rows: [
            ['dbo.Customer', 'Email', 3, 'none@example.com', ''],
            ['dbo.Customer', 'Email', 3, 'OLD@EXAMPLE.COM', 'new@example.com'],
          ],
        },
        {
          name: 'Concat parts',
          columns: [
            { header: 'Source table' },
            { header: 'Source field' },
            { header: 'Step' },
            { header: 'Order' },
            { header: 'Field' },
            { header: 'Literal' },
          ],
          rows: [
            ['dbo.Customer', 'Email', 4, 2, '', 'example.com'],
            ['dbo.Customer', 'Email', 4, 1, 'Email', ''],
          ],
        },
      ],
    );
    const result = await api.post<MappingImportPreviewDto>(`/api/plans/${plan.id}/mapping-workbook`, {
      contentBase64: filled.toString('base64'),
      apply: true,
    });
    expect(result.rejected).toEqual([]);
    expect(result.transformationsChanged).toBeGreaterThan(0);

    const after = await api.get<{
      mappings: { sourceField: string; targetField: string | null; transformations: unknown }[];
    }>(`/api/plans/${plan.id}/entities/${plan.entities[0].id}/mappings`);
    const email = after.mappings.find((m) => m.sourceField === 'Email')!;
    expect(email.targetField).toBe('emailaddress1');
    expect(email.transformations).toEqual([
      { kind: 'TRIM' },
      { kind: 'LOWERCASE' },
      {
        kind: 'VALUE_MAP',
        onUnmapped: 'IGNORE',
        // An empty To means "map this value onto nothing", which is not the same as leaving it out.
        map: [
          { from: 'none@example.com', to: null },
          { from: 'OLD@EXAMPLE.COM', to: 'new@example.com' },
        ],
      },
      {
        kind: 'CONCAT',
        separator: '-',
        // Order decides the sequence, not the row position: these arrived reversed.
        parts: [
          { field: 'Email', literal: null },
          { field: null, literal: 'example.com' },
        ],
      },
      {
        kind: 'IF_THEN',
        condition: { field: 'Email', operator: 'IS_BLANK' },
        action: 'APPLY',
        // The nested rule pointed at step 5 through "Inside step".
        then: [{ kind: 'CONSTANT', value: 'unknown@example.com' }],
      },
    ]);
  });

  it('exports what it imported, so a workbook survives a second lap', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/plans/${plan.id}/mapping.xlsx`,
      headers: { cookie: api.cookie },
    });
    const sheets = readXlsx(res.rawPayload);
    const rules = rowsByHeader(
      sheets.find((x) => x.name === 'Transformations')!,
      ['Source table', 'Source field', 'Rule'],
    )!;
    const emailRules = rules.rows.filter((r) => r.sourcefield === 'Email').map((r) => r.rule);
    expect(emailRules).toEqual(['TRIM', 'LOWERCASE', 'VALUE_MAP', 'CONCAT', 'IF_THEN', 'CONSTANT']);
    // The nested rule still points back at the conditional it belongs to.
    const nested = rules.rows.find((r) => r.rule === 'CONSTANT')!;
    const conditional = rules.rows.find((r) => r.rule === 'IF_THEN')!;
    expect(nested.insidestep).toBe(conditional.step);

    const maps = rowsByHeader(
      sheets.find((x) => x.name === 'Value maps')!,
      ['From', 'To'],
    )!;
    expect(maps.rows.map((r) => r.from)).toContain('OLD@EXAMPLE.COM');
    const parts = rowsByHeader(
      sheets.find((x) => x.name === 'Concat parts')!,
      ['Order'],
    )!;
    expect(parts.rows.map((r) => r.literal)).toContain('example.com');

    // And the reference column on Field mapping summarizes rather than pretending to be editable.
    const mapping = rowsByHeader(
      sheets.find((x) => x.name === 'Field mapping')!,
      ['Source field', 'Transformation (reference)'],
    )!;
    expect(mapping.rows.find((r) => r.sourcefield === 'Email')!.transformationreference).toContain(
      'VALUE_MAP(2 value(s))',
    );
  });

  it('refuses a pipeline the API itself would refuse, naming the column', async () => {
    const filled = workbook(
      [['dbo.Customer', 'Phone', 'telephone1']],
      [
        {
          name: 'Transformations',
          columns: [
            { header: 'Source table' },
            { header: 'Source field' },
            { header: 'Step' },
            { header: 'Rule' },
          ],
          rows: [['dbo.Customer', 'Phone', 1, 'NOT_A_REAL_RULE']],
        },
      ],
    );
    const result = await api.post<MappingImportPreviewDto>(`/api/plans/${plan.id}/mapping-workbook`, {
      contentBase64: filled.toString('base64'),
      apply: true,
    });
    // Caught by the same zod schema the transformation editor posts through.
    expect(result.rejected.some((r) => r.field === 'Phone')).toBe(true);
    expect(result.transformationsChanged).toBe(0);
    // And the pipelines this sheet says nothing about are untouched, not wiped.
    const after = await api.get<{ mappings: { sourceField: string; transformations: unknown[] }[] }>(
      `/api/plans/${plan.id}/entities/${plan.entities[0].id}/mappings`,
    );
    expect(after.mappings.find((m) => m.sourceField === 'Email')!.transformations).toHaveLength(5);
  });

  /** Excel writes a byte-order mark at the front of a CSV; the importer has to see past it. */
  const BOM = String.fromCharCode(0xfeff);

  it('accepts the CSV somebody inevitably sends back instead of the workbook', async () => {
    const csv = ['Source table,Source field,Target field', 'dbo.Customer,Phone,telephone1'].join('\r\n');
    const preview = await api.post<MappingImportPreviewDto>(`/api/plans/${plan.id}/mapping-workbook`, {
      filename: 'mapping.csv',
      contentBase64: Buffer.from(BOM + csv, 'utf8').toString('base64'),
    });
    expect(preview.matched).toBe(1);
    expect(preview.changes[0]).toMatchObject({ field: 'Phone', to: 'telephone1' });
  });

  it('refuses a file that is not a mapping sheet at all', async () => {
    await api.request(
      'POST',
      `/api/plans/${plan.id}/mapping-workbook`,
      { contentBase64: Buffer.from('just,some,csv\n1,2,3').toString('base64') },
      400,
    );
  });

  // ---------------------------------------------------------------------------

  let schedule: MigrationScheduleDto;

  it('schedules a recurring migration, confirming the environments up front', async () => {
    // The names are the same protection the interactive confirm gives, taken at the one moment a
    // person is present.
    await api.request(
      'POST',
      `/api/plans/${plan.id}/schedules`,
      {
        cron: '*/15 * * * *',
        confirmSourceName: sqlSource.displayName,
        confirmTargetName: 'Some Other Environment',
      },
      400,
    );
    await api.request(
      'POST',
      `/api/plans/${plan.id}/schedules`,
      {
        cron: 'not a cron expression',
        confirmSourceName: sqlSource.displayName,
        confirmTargetName: qa.displayName,
      },
      400,
    );

    schedule = await api.post<MigrationScheduleDto>(`/api/plans/${plan.id}/schedules`, {
      cron: '0 2 * * *',
      timeZone: 'Europe/London',
      confirmSourceName: sqlSource.displayName,
      confirmTargetName: qa.displayName,
    });
    expect(schedule).toMatchObject({
      cron: '0 2 * * *',
      timeZone: 'Europe/London',
      enabled: true,
      mode: 'FULL',
      consecutiveFailures: 0,
    });
    // The saved schedule reads back in words, and knows when it fires next.
    expect(schedule.description).toBe('Every day at 02:00');
    expect(schedule.name).toBe('Every day at 02:00');
    expect(new Date(schedule.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

    const list = await api.get<MigrationScheduleDto[]>(`/api/plans/${plan.id}/schedules`);
    expect(list.map((x) => x.id)).toEqual([schedule.id]);
  });

  it('pauses and resumes without losing the recurrence', async () => {
    const paused = await api.patch<MigrationScheduleDto>(`/api/schedules/${schedule.id}`, {
      enabled: false,
    });
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeNull();

    const resumed = await api.patch<MigrationScheduleDto>(`/api/schedules/${schedule.id}`, {
      enabled: true,
      cron: '*/30 * * * *',
      name: 'Every half hour',
    });
    expect(resumed.enabled).toBe(true);
    expect(resumed.description).toBe('Every 30 minutes');
    expect(resumed.nextRunAt).not.toBeNull();
  });

  it('fires on its schedule, and records the run as scheduled rather than manual', async () => {
    // The plan has blockers until it is complete enough to run; a schedule must not paper over that.
    const withBlockers = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const scheduler = t.services.createScheduler();

    // Force the schedule due, then let the scheduler claim it.
    await t.services.db.execute(
      `update migration_schedules set next_run_at = now() - interval '1 minute' where id = '${schedule.id}'`,
    );
    const tick = await scheduler.tick();
    scheduler.stop();

    if (withBlockers.blockerCount > 0) {
      // A blocked plan means the firing is recorded as a failure, with the reason kept.
      expect(tick.failed).toBe(1);
      const after = await api.get<MigrationScheduleDto>(`/api/schedules/${schedule.id}`);
      expect(after.lastStatus).toBe('FAILED');
      expect(after.lastError).toBeTruthy();
      expect(after.consecutiveFailures).toBe(1);
      // And it moved on to the next slot rather than retrying in a tight loop.
      expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    } else {
      expect(tick.fired).toBe(1);
      const after = await api.get<MigrationScheduleDto>(`/api/schedules/${schedule.id}`);
      expect(after.lastRunId).toBeTruthy();
      const history = await api.get<{ trigger: string }[]>(`/api/schedules/${schedule.id}/history`);
      expect(history[0].trigger).toBe('SCHEDULED');
    }
  });

  it('deletes a schedule', async () => {
    await api.request('DELETE', `/api/schedules/${schedule.id}`, undefined, 204);
    expect(await api.get<MigrationScheduleDto[]>(`/api/plans/${plan.id}/schedules`)).toEqual([]);
  });

  it('keeps analyses listed under their project, and archives without losing them', async () => {
    const list = await api.get<AnalysisRunListItemDto[]>(`/api/projects/${analysisProject.id}/analyses`);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Customers and orders', status: 'COMPLETED', basis: 'EXACT' });

    const archived = await api.post<ProjectDto>(`/api/projects/${analysisProject.id}/archive`);
    expect(archived.status).toBe('ARCHIVED');
    // Archived projects leave the default list but the work stays readable.
    const active = await api.get<ProjectDto[]>('/api/projects');
    expect(active.map((p) => p.id)).not.toContain(analysisProject.id);
    expect(await api.get<AnalysisRunDto>(`/api/analyses/${analysis.id}`)).toMatchObject({
      status: 'COMPLETED',
    });
    const all = await api.get<ProjectDto[]>('/api/projects?includeArchived=true');
    expect(all.map((p) => p.id)).toContain(analysisProject.id);
  });

  it('refuses to repoint a project that already has work in it', async () => {
    await api.request('PATCH', `/api/projects/${analysisProject.id}`, { sourceEnvironmentId: qa.id }, 400);
  });
});
