import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationErrorDto,
  MigrationPlanDto,
  MigrationRunDto,
  ProjectDto,
  RunFailureSummaryDto,
  RunRecordDetailDto,
} from '../../shared/domain';
import { correctionFor } from '../../shared/failure-categories';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * From a run to one record, through what the engine recorded.
 *
 * A failure report that stops at "270 records failed" tells a consultant the size of the problem and
 * nothing about the problem. These are the steps between that number and a record they can act on: which
 * dataset, which cause, which record, what the record is, and where the correction is made.
 *
 * Every assertion here is against a run produced by the engine. A drilldown proved against invented error
 * rows proves the components render, which is not the thing in doubt.
 */
describe('a failure can be followed to one record', () => {
  let t: TestApp;
  let api: ApiClient;
  let run: MigrationRunDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `Drilldown ${Date.now()}`,
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    // Contacts without accounts: three hundred records, each losing its parent reference.
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      projectId: project.id,
      tables: ['contact'],
    });
    const current = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: current.sourceEnvironment.displayName,
      confirmTargetName: current.targetEnvironment.displayName,
      acknowledgeWarnings: true,
    });
    const worker = t.services.createWorker();
    await worker.drain(180_000);
    await worker.stop();
    run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  });
  afterAll(async () => {
    await t?.close();
  });

  const errors = (query = '') =>
    api.get<{ items: MigrationErrorDto[]; total: number }>(`/api/runs/${run.id}/errors${query}`);

  /** Step one: the run knows which project it belongs to, so a failure can lead to the fix. */
  it('carries the project, so a failure has somewhere to lead', () => {
    expect(run.projectId).toBeTruthy();
  });

  /** Step two: the run's datasets and the causes recorded in each. */
  it('groups the causes by dataset', async () => {
    const summary = await api.get<RunFailureSummaryDto>(`/api/runs/${run.id}/failures`);
    const contacts = summary.datasets.find((d) => d.logicalName === 'contact')!;
    const cause = [...contacts.categories, ...contacts.warnings].find((c) => c.code === 'LOOKUP_UNRESOLVED')!;
    expect(cause.label, 'named, not just coded').toBe('Lookup not resolved');
    expect(cause.records).toBeGreaterThan(0);
  });

  /** Step three: every row carries what its code means and whether another attempt could succeed. */
  it('describes each failure rather than only naming its code', async () => {
    const page = await errors();
    expect(page.total).toBeGreaterThan(0);
    for (const e of page.items) {
      expect(e.category.code).toBe(e.errorCode);
      if (e.category.known) {
        expect(e.category.label).not.toBe(e.errorCode);
        expect(e.category.meaning).toBeTruthy();
        expect(e.category.action).toBeTruthy();
      }
      expect(typeof e.retryable).toBe('boolean');
    }
  });

  /**
   * The attempt is recorded on the failure, not inferred from the run.
   *
   * A retry history that attributed every failure to the run's current attempt would describe the second
   * attempt's state as though it had always been true.
   */
  it('records which attempt each failure belongs to', async () => {
    const page = await errors();
    expect(page.items.every((e) => e.runAttempt === 1)).toBe(true);
    const filtered = await errors('?attempt=1');
    expect(filtered.total).toBe(page.total);
    const other = await errors('?attempt=2');
    expect(other.total, 'there was no second attempt').toBe(0);
  });

  /** Filtering happens on the server, and narrows. */
  it('filters by dataset, cause and severity without fetching the run', async () => {
    const all = await errors();
    const byCause = await errors('?code=LOOKUP_UNRESOLVED');
    expect(byCause.total).toBeGreaterThan(0);
    expect(byCause.total).toBeLessThanOrEqual(all.total);
    expect(byCause.items.every((e) => e.errorCode === 'LOOKUP_UNRESOLVED')).toBe(true);

    const byDataset = await errors('?entity=contact');
    expect(byDataset.items.every((e) => e.entity === 'contact')).toBe(true);

    const warnings = await errors('?severity=WARNING');
    expect(warnings.items.every((e) => e.severity === 'WARNING')).toBe(true);

    const nothing = await errors('?code=A_CODE_THIS_RUN_DID_NOT_PRODUCE');
    expect(nothing.total).toBe(0);
  });

  /**
   * One record, found by its identifier.
   *
   * The question a consultant arrives with is about a record somebody named in a spreadsheet, not about
   * row 4,812 of a list.
   */
  it('finds every failure for one record by its source identifier', async () => {
    const first = (await errors()).items.find((e) => e.sourceRecordId)!;
    const found = await errors(`?sourceRecordId=${encodeURIComponent(first.sourceRecordId!)}`);
    expect(found.total).toBeGreaterThan(0);
    expect(found.items.every((e) => e.sourceRecordId === first.sourceRecordId)).toBe(true);
  });

  /**
   * Paging is stable.
   *
   * Error rows written in one batch share a timestamp to the millisecond. Ordered on the timestamp alone
   * the database may return them in any order it likes, so a reader paging through a list sees some rows
   * twice and never sees others — and the ones they never see are the ones nobody fixes.
   */
  it('pages without showing a row twice or skipping one', async () => {
    const total = (await errors()).total;
    expect(total, 'enough rows for more than one page').toBeGreaterThan(60);
    const seen: string[] = [];
    for (let offset = 0; offset < total; offset += 50) {
      const page = await errors(`?limit=50&offset=${offset}`);
      seen.push(...page.items.map((e) => e.id));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size, 'no row appears twice').toBe(total);

    // And the same page, asked for twice, is the same page.
    const a = await errors('?limit=50&offset=50');
    const b = await errors('?limit=50&offset=50');
    expect(a.items.map((e) => e.id)).toEqual(b.items.map((e) => e.id));
  });

  /** A page is a page. A caller cannot ask for the whole run and filter it in the browser. */
  it('caps a page rather than returning the run', async () => {
    const huge = await api.get<{ items: MigrationErrorDto[]; total: number }>(
      `/api/runs/${run.id}/errors?limit=100000`,
      400,
    );
    expect(huge).toBeTruthy();
  });

  /**
   * The record itself: what it is, and what happened to it.
   *
   * Assembled from the identity map and the error rows. There is no live read of the source here — a
   * failure screen that opened a connection to the source would fail exactly when the source is what is
   * broken, and would read records the reader may not be entitled to.
   */
  it('shows one record with the evidence the engine recorded', async () => {
    const first = (await errors()).items.find((e) => e.sourceRecordId)!;
    const detail = await api.get<RunRecordDetailDto>(
      `/api/runs/${run.id}/records/${first.entity}/${encodeURIComponent(first.sourceRecordId!)}`,
    );
    expect(detail.sourceId).toBe(first.sourceRecordId);
    expect(detail.entity).toBe('contact');
    expect(detail.displayName, 'named as the dataset is named').toBeTruthy();
    expect(detail.runAttempt).toBe(1);

    // The identity, and the reference the failure is about.
    const labels = detail.evidence.map((e) => e.label);
    expect(labels).toContain('Source record');
    expect(labels).toContain('Record in target');
    expect(detail.evidence.find((e) => e.label === 'Source record')!.value).toBe(first.sourceRecordId);

    /*
     * Every failure recorded against this record, so the detail does not describe one cause while the
     * record has three.
     */
    expect(detail.errors.length).toBeGreaterThan(0);
    expect(detail.errors.every((e) => e.sourceRecordId === first.sourceRecordId)).toBe(true);

    // The record was written. That is the whole point of this run's outcome.
    expect(detail.targetId, 'the contact is in the target').toBeTruthy();
    expect(detail.outcome).toBe('CREATED');
  });

  /** A record identifier that is not in this run is not found, rather than returning an empty shell. */
  it('does not invent a record that this run never saw', async () => {
    await api.get(`/api/runs/${run.id}/records/contact/00000000-0000-0000-0000-000000000000`, 404);
  });

  /**
   * Where the correction is made.
   *
   * A dropped reference is fixed by adding the referenced table to the migration. That is a screen in this
   * product, so the failure offers it.
   */
  it('names the place that fixes the failure, for the causes where one exists', () => {
    expect(correctionFor('LOOKUP_UNRESOLVED')).toEqual({
      target: 'SOURCE_DATA',
      label: 'Add the referenced table',
    });
  });

  /**
   * And offers nothing where nothing in the configuration is wrong.
   *
   * A button that leads to an unrelated screen costs the person the trip and teaches them not to trust the
   * next one.
   */
  it('offers no correction for a failure the configuration cannot fix', () => {
    for (const code of ['THROTTLED', 'TIMEOUT', 'NETWORK', 'SERVER_ERROR']) {
      expect(correctionFor(code), code).toBeNull();
    }
  });
});
