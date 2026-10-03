import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ComparisonDifferenceDto,
  ComparisonSuggestionDto,
  DataComparisonDto,
  DataComparisonListItemDto,
  EnvironmentDto,
  ProjectDto,
} from '../../shared/domain';
import { and, eq } from 'drizzle-orm';
import { demoRecords } from '../../server/src/db/schema';
import { totalsReconcile } from '../../server/src/services/data-comparison';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Comparison and validation, end to end.
 *
 * The product already validated a migration against the run that performed it. This is the same
 * question asked without a migration in the middle: here are two datasets, do they agree? It is
 * sold on its own, so it has to stand on its own — including when the answer is "your key is not
 * unique and I will not pretend otherwise".
 */

/** Runs the queued job to completion, then reads the result. The test app has no worker of its own. */
const runToCompletion = async (
  worker: ReturnType<TestApp['services']['createWorker']>,
  read: () => Promise<DataComparisonDto>,
): Promise<DataComparisonDto> => {
  await worker.drain(180_000);
  return read();
};

describe('a comparison project', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let qa: EnvironmentDto;
  let project: ProjectDto;
  let worker: ReturnType<TestApp['services']['createWorker']>;

  beforeAll(async () => {
    t = await createTestApp();
    worker = t.services.createWorker();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
    project = await api.post<ProjectDto>('/api/projects', {
      name: 'Monthly reconciliation',
      kind: 'COMPARISON',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
    });
  }, 120_000);
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('has two sides and neither of them is a target', () => {
    expect(project.kind).toBe('COMPARISON');
    expect(project.sourceEnvironment?.id).toBe(dev.id);
    expect(project.targetEnvironment?.id).toBe(qa.id);
  });

  it('may compare one connection against itself, unlike a migration', async () => {
    // Comparing a staging table against the live one inside a single database is an ordinary
    // thing to want, and nothing here writes, so the rule that protects migrations does not apply.
    const sameSide = await api.post<ProjectDto>('/api/projects', {
      name: 'Within one database',
      kind: 'COMPARISON',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: dev.id,
    });
    expect(sameSide.targetEnvironment?.id).toBe(dev.id);
    // A migration from an environment into itself remains refused.
    await api.request(
      'POST',
      '/api/projects',
      { name: 'Nope', kind: 'MIGRATION', sourceEnvironmentId: dev.id, targetEnvironmentId: dev.id },
      400,
    );
  });

  it('proposes pairings, and never proposes a key it cannot stand behind', async () => {
    const suggestions = await api.get<ComparisonSuggestionDto[]>(
      `/api/projects/${project.id}/data-comparison-suggestions`,
    );
    expect(suggestions.length).toBeGreaterThan(0);
    const account = suggestions.find((s) => s.leftTable === 'account')!;
    expect(account).toBeDefined();
    expect(account.rightTable).toBe('account');
    expect(account.keyProposed).toBe(true);
    expect(account.fields.length).toBeGreaterThan(0);
    // A proposal explains itself; a suggestion nobody can evaluate is just an instruction.
    expect(account.rationale).toMatch(/Matching on/);
    // The key is never also compared as a value: it would differ on exactly zero records.
    for (const k of account.key) expect(account.fields.some((f) => f.left === k.left)).toBe(false);
    // Anything without a usable key says so rather than guessing.
    for (const s of suggestions) {
      if (!s.keyProposed) expect(s.rationale).toMatch(/choose the one that identifies a record/);
    }
  }, 120_000);

  it('refuses to run without a key, because there is nothing to match on', async () => {
    await api.request(
      'POST',
      `/api/projects/${project.id}/data-comparisons`,
      { pairs: [{ leftTable: 'account', rightTable: 'account', key: [], fields: [] }] },
      400,
    );
  });

  it('reconciles two datasets and its own totals add up', async () => {
    const created = await api.post<DataComparisonDto>(`/api/projects/${project.id}/data-comparisons`, {
      name: 'Accounts, dev against QA',
      pairs: [
        {
          leftTable: 'account',
          rightTable: 'account',
          key: [{ left: 'accountid', right: 'accountid' }],
          fields: [
            { left: 'name', right: 'name' },
            { left: 'telephone1', right: 'telephone1' },
          ],
        },
      ],
    });
    expect(created.status).toBe('QUEUED');

    const run = await runToCompletion(worker, () =>
      api.get<DataComparisonDto>(`/api/data-comparisons/${created.id}`),
    );
    expect(run.errorMessage).toBeNull();
    expect(run.status).toBe('COMPLETED');
    expect(run.tables).toHaveLength(1);

    const table = run.tables[0];
    // The identity from the DTO's own documentation, checked against a real run rather than a
    // fixture: no record can be counted twice or vanish between reading and reporting.
    expect(totalsReconcile(table)).toBe(true);
    expect(totalsReconcile(run.totals)).toBe(true);
    expect(table.leftRecords).toBeGreaterThan(0);

    // Every check the screen shows is either a pass or says what is wrong.
    for (const check of table.checks) expect(check.message.length).toBeGreaterThan(0);
    expect(table.checks.some((c) => c.check === 'ROW_COUNT')).toBe(true);
    expect(table.checks.some((c) => c.check === 'RECORD_EXISTENCE')).toBe(true);
    expect(table.comparedFields).toHaveLength(2);
  }, 180_000);

  it('refuses to call a comparison that compared nothing a success', async () => {
    // Keyed on a column that is empty on one side, so no record there can be matched. The numbers
    // are then all zero — and zeroes read as "all clear" unless something says otherwise.
    //
    // This is not hypothetical: the first run of this feature keyed on the primary id, every
    // connector returns that as the record id rather than as a value, and so every record on both
    // sides was excluded. The report said "every record appears on both sides", and passed.
    const created = await api.post<DataComparisonDto>(`/api/projects/${project.id}/data-comparisons`, {
      name: 'A key that identifies nothing',
      pairs: [
        {
          leftTable: 'account',
          rightTable: 'account',
          key: [{ left: 'parentaccountid', right: 'parentaccountid' }],
          fields: [{ left: 'name', right: 'name' }],
        },
      ],
    });
    const run = await runToCompletion(worker, () =>
      api.get<DataComparisonDto>(`/api/data-comparisons/${created.id}`),
    );
    expect(run.status).toBe('COMPLETED');
    const table = run.tables[0];
    expect(table.matched).toBe(0);
    expect(table.outcome).toBe('FAIL');
    const nothing = table.checks.find((c) => c.message.startsWith('Nothing was compared'));
    expect(nothing, JSON.stringify(table.checks)).toBeDefined();
    // And it names the key, so the person knows which choice to revisit.
    expect(nothing!.message).toContain('parentaccountid');
    expect(nothing!.message).toContain('says nothing about whether the data agrees');
    // Nothing anywhere in the result claims the two sides agree.
    expect(table.checks.some((c) => c.message === 'Every record appears on both sides')).toBe(false);
  }, 120_000);

  it('lists the differences it found, and exports them', async () => {
    const [latest] = await api.get<DataComparisonListItemDto[]>(
      `/api/projects/${project.id}/data-comparisons`,
    );
    const { rows, total } = await api.get<{ rows: ComparisonDifferenceDto[]; total: number }>(
      `/api/data-comparisons/${latest.id}/differences`,
    );
    expect(total).toBe(rows.length);
    for (const row of rows) {
      expect(row.keyValue.length).toBeGreaterThan(0);
      // A value difference names its field and shows both sides; a record that exists on one side
      // only has no field to name. Anything else is a row nobody can act on.
      if (row.differenceType === 'VALUE_DIFFERS') expect(row.field).not.toBeNull();
      else expect(row.field).toBeNull();
    }

    const csv = await t.app.inject({
      method: 'GET',
      url: `/api/data-comparisons/${latest.id}/differences.csv`,
      headers: { cookie: api.cookie },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split('\n')[0]).toContain('Left value');

    const summary = await t.app.inject({
      method: 'GET',
      url: `/api/data-comparisons/${latest.id}/summary.csv`,
      headers: { cookie: api.cookie },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.body).toContain('Columns only on the left');
  }, 120_000);

  it('reports a difference when the data actually differs, naming the field', async () => {
    // Change one record on one side only, then compare again. The point is not that a difference
    // appears — it is that the difference names the right record and the right column.
    const rows = await t.services.db
      .select()
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, 'demo-qa'), eq(demoRecords.logicalName, 'account')));
    expect(rows.length).toBeGreaterThan(0);
    const target = rows[0];
    const original = String((target.data as Record<string, unknown>).name ?? '');
    await t.services.db
      .update(demoRecords)
      .set({ data: { ...(target.data as Record<string, unknown>), name: 'Renamed by a test' } })
      .where(
        and(
          eq(demoRecords.environmentKey, target.environmentKey),
          eq(demoRecords.logicalName, target.logicalName),
          eq(demoRecords.recordId, target.recordId),
        ),
      );

    const created = await api.post<DataComparisonDto>(`/api/projects/${project.id}/data-comparisons`, {
      name: 'After the edit',
      pairs: [
        {
          leftTable: 'account',
          rightTable: 'account',
          key: [{ left: 'accountid', right: 'accountid' }],
          fields: [{ left: 'name', right: 'name' }],
        },
      ],
    });
    const run = await runToCompletion(worker, () =>
      api.get<DataComparisonDto>(`/api/data-comparisons/${created.id}`),
    );
    expect(run.status).toBe('COMPLETED');
    expect(run.totals.different).toBeGreaterThan(0);
    expect(totalsReconcile(run.totals)).toBe(true);

    const { rows: diffs } = await api.get<{ rows: ComparisonDifferenceDto[] }>(
      `/api/data-comparisons/${created.id}/differences?type=VALUE_DIFFERS`,
    );
    const renamed = diffs.find((d) => d.rightValue === 'Renamed by a test');
    expect(renamed, 'the edited record should be reported').toBeDefined();
    expect(renamed!.field).toBe('name');
    expect(renamed!.leftValue).toBe(original);
    // The key identifies which record, so somebody can go and look at it.
    expect(renamed!.keyValue.toLowerCase()).toContain(target.recordId.toLowerCase());
  }, 180_000);
});
