import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type {
  EnvironmentDto,
  MigrationErrorDto,
  MigrationPlanDto,
  MigrationRunDto,
  RunFailureSummaryDto,
} from '../../shared/domain';
import { demoRecords, migrationErrors } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * A failure list at the size a real migration produces.
 *
 * A thousand failures is an ordinary morning on a mid-sized migration, and the behaviour that matters at that
 * size is not the layout. It is whether the server narrows the list or the browser does, whether paging
 * through it shows every row exactly once, and whether an export is the whole set or the first page of it.
 *
 * Every number below is measured rather than claimed. A test that asserted a list "scales" without timing
 * anything would be the same kind of statement as a run reporting a clean result because nothing failed.
 */
describe('a failure list at a thousand records and beyond', () => {
  let t: TestApp;
  let api: ApiClient;
  let organizationId: string;
  let run: MigrationRunDto;
  const SOURCE_RECORDS = 1_200;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

    /*
     * Twelve hundred offices, and no regions in the target. An office's region is a required reference, so
     * every one of them fails — a real failure from a real configuration, not a seeded error row.
     */
    await t.services.db.insert(demoRecords).values(
      Array.from({ length: SOURCE_RECORDS }, (_, i) => {
        const id = `bulk-office-${String(i).padStart(5, '0')}`;
        return {
          organizationId,
          environmentKey: 'demo-dev',
          logicalName: 'dtx_office',
          recordId: id,
          data: {
            dtx_officeid: id,
            dtx_name: `Bulk Office ${i}`,
            dtx_city: i % 2 ? 'Leeds' : 'Bristol',
            dtx_headcount: 10 + (i % 50),
            dtx_regionid: { id: `missing-region-${i % 7}`, logicalName: 'dtx_region' },
          },
        };
      }),
    );

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Bulk failures ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_office'],
    });
    const current = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: current.sourceEnvironment.displayName,
      confirmTargetName: current.targetEnvironment.displayName,
      acknowledgeWarnings: true,
    });
    const worker = t.services.createWorker();
    await worker.drain(600_000);
    await worker.stop();
    run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  }, 900_000);

  afterAll(async () => {
    await t?.close();
  });

  const errors = (query: string) =>
    api.get<{ items: MigrationErrorDto[]; total: number }>(`/api/runs/${run.id}/errors${query}`);
  const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const started = performance.now();
    const value = await fn();
    return { value, ms: performance.now() - started };
  };

  it('produced a failure set of at least a thousand records', () => {
    expect(run.failed).toBeGreaterThanOrEqual(1_000);
    expect(run.status).toBe('COMPLETED_WITH_ERRORS');
  });

  /** The summary groups the set rather than listing it: one row per cause, however many records. */
  it('summarises a thousand failures as a handful of causes', async () => {
    const { value: summary, ms } = await timed(() =>
      api.get<RunFailureSummaryDto>(`/api/runs/${run.id}/failures`),
    );
    const offices = summary.datasets.find((d) => d.logicalName === 'dtx_office')!;
    expect(offices.categories.length, 'a handful of causes, not a thousand rows').toBeLessThan(10);
    const cause = offices.categories.find((c) => c.code === 'LOOKUP_UNRESOLVED')!;
    expect(cause.records).toBeGreaterThanOrEqual(1_000);
    // Measured, and recorded as a measurement rather than as a claim about scale.
    expect(ms, `summary of ${run.failed} failures took ${Math.round(ms)}ms`).toBeLessThan(10_000);
  });

  /** A page is a page, and a caller cannot ask for the run instead. */
  it('refuses a request for the whole set', async () => {
    await api.get(`/api/runs/${run.id}/errors?limit=100000`, 400);
    await api.get(`/api/runs/${run.id}/errors?limit=5000`, 400);
    const page = await errors('?limit=50');
    expect(page.items).toHaveLength(50);
    expect(page.total, 'while still reporting how many there are').toBeGreaterThanOrEqual(1_000);
  });

  /**
   * Paging through the whole set shows every row exactly once.
   *
   * The failure this guards is not theoretical. Error rows written in one batch share a timestamp to the
   * millisecond, and ordered on the timestamp alone the database may return them in any order it likes — so
   * a reader paging through sees some rows twice and never sees others, and the ones they never see are the
   * ones nobody fixes.
   */
  it('pages through the whole set without repeating or skipping a row', async () => {
    const total = (await errors('?limit=1')).total;
    const seen: string[] = [];
    let slowest = 0;
    for (let offset = 0; offset < total; offset += 200) {
      const { value: page, ms } = await timed(() => errors(`?limit=200&offset=${offset}`));
      slowest = Math.max(slowest, ms);
      seen.push(...page.items.map((e) => e.id));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size, 'every row exactly once').toBe(total);
    expect(slowest, `the slowest page of ${total} took ${Math.round(slowest)}ms`).toBeLessThan(10_000);
  }, 300_000);

  /** And the same page asked for twice is the same page. */
  it('returns a stable page for the same request', async () => {
    const a = await errors('?limit=100&offset=600');
    const b = await errors('?limit=100&offset=600');
    expect(a.items.map((e) => e.id)).toEqual(b.items.map((e) => e.id));
  });

  /**
   * Filtering narrows on the server.
   *
   * Asserted by the count rather than by the rows: a filter applied in the browser would return the same
   * page of fifty whatever was asked for, and the total would not move.
   */
  it('filters on the server, which the totals prove', async () => {
    const all = await errors('?limit=1');
    const byCause = await errors('?limit=1&code=LOOKUP_UNRESOLVED');
    const byNothing = await errors('?limit=1&code=A_CODE_THIS_RUN_DID_NOT_PRODUCE');
    expect(byCause.total).toBeGreaterThan(0);
    expect(byCause.total).toBeLessThanOrEqual(all.total);
    expect(byNothing.total, 'a filter that matches nothing returns nothing').toBe(0);
    expect(byNothing.items).toHaveLength(0);

    // One record, out of twelve hundred, found by its identifier.
    const one = await errors('?limit=50&sourceRecordId=bulk-office-00777');
    expect(one.total).toBeGreaterThan(0);
    expect(one.items.every((e) => e.sourceRecordId === 'bulk-office-00777')).toBe(true);
  });

  /**
   * The export is the whole filtered set, not the page on screen.
   *
   * A consultant exports the list to work through it outside the product. An export capped at the page size
   * would be the most quietly damaging bug on this screen: the file looks right and is missing most of it.
   */
  it('exports the whole filtered set rather than the current page', async () => {
    const full = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${run.id}/errors.csv`,
      headers: { cookie: api.cookie },
    });
    expect(full.statusCode).toBe(200);
    const lines = full.body.trim().split('\n');
    const total = (await errors('?limit=1')).total;
    // Header, then one line per failure. Not fifty.
    expect(lines.length).toBeGreaterThan(1_000);
    expect(lines.length - 1, 'every row the list reports').toBe(total);

    /*
     * And the export honours the filters, because a file that silently contained more than the list the
     * person was looking at would describe a different problem from the one they were working on.
     */
    const filtered = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${run.id}/errors.csv?sourceRecordId=bulk-office-00777`,
      headers: { cookie: api.cookie },
    });
    const filteredLines = filtered.body.trim().split('\n');
    expect(filteredLines.length).toBeLessThan(lines.length);
    expect(filtered.body).toContain('bulk-office-00777');
  }, 300_000);

  /**
   * And the same questions at a hundred thousand rows.
   *
   * This one is about the query, and says so. The rows are written straight into the error table rather than
   * produced by a migration, because migrating a hundred thousand records through a simulated target takes
   * longer than a test should and would prove something this test is not asking about. What is asked is
   * whether paging and filtering still work on a table that size, which is a property of the query.
   */
  it('still pages and filters at a hundred thousand rows', async () => {
    const BULK = 100_000;
    const BATCH = 1_000;
    for (let i = 0; i < BULK; i += BATCH) {
      await t.services.db.insert(migrationErrors).values(
        Array.from({ length: BATCH }, (_, n) => ({
          runId: run.id,
          runAttempt: 1,
          logicalName: 'dtx_office',
          sourceRecordId: `synthetic-${i + n}`,
          operation: 'CREATE',
          severity: 'ERROR' as const,
          errorCode: 'SYNTHETIC_SCALE_CHECK',
          message: 'Written directly to measure the query, not produced by a migration.',
          retryable: false,
        })),
      );
    }
    const counted = await t.services.db
      .select({ n: sql<number>`count(*)` })
      .from(migrationErrors)
      .where(and(eq(migrationErrors.runId, run.id), eq(migrationErrors.errorCode, 'SYNTHETIC_SCALE_CHECK')));
    expect(Number(counted[0]?.n ?? 0)).toBe(BULK);

    // The first page, the last page, and a filter, each measured.
    const first = await timed(() => errors('?limit=50'));
    const deep = await timed(() => errors(`?limit=50&offset=${BULK - 50}`));
    const filter = await timed(() => errors('?limit=50&code=SYNTHETIC_SCALE_CHECK'));
    const identity = await timed(() => errors('?limit=50&sourceRecordId=synthetic-99999'));

    expect(first.value.total).toBeGreaterThan(BULK);
    expect(filter.value.total).toBe(BULK);
    expect(identity.value.total).toBe(1);
    expect(deep.value.items.length).toBeGreaterThan(0);

    /*
     * What the numbers were when this was written, so a later regression is visible as a change rather than
     * argued about: first page ~tens of ms, deep page and filters the same order of magnitude. The threshold
     * is deliberately loose — this runs on whatever machine CI gives it — and the point of asserting it at
     * all is that a query that started scanning the table would miss it by a factor, not by a margin.
     */
    for (const [name, result] of [
      ['first page', first],
      ['deep page', deep],
      ['filter by cause', filter],
      ['find by identity', identity],
    ] as const) {
      expect(result.ms, `${name} over ${BULK} rows took ${Math.round(result.ms)}ms`).toBeLessThan(15_000);
    }
  }, 900_000);
});
