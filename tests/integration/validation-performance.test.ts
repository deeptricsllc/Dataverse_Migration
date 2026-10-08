import { appendFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoRecords, validationDifferences, validationRuns } from '../../server/src/db/schema';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * How long a validation takes, and whether reading its result stays cheap as it grows.
 *
 * Two kinds of evidence, labelled as what they are:
 *
 *   - **End to end**, over a thousand records migrated and compared through the real engine. The
 *     numbers are wall-clock on one developer machine against PGlite, so they are an order of
 *     magnitude, not a benchmark. What is asserted is the shape: the work is linear in the records
 *     and nothing reads the whole table at once.
 *   - **Query level**, over a hundred thousand findings written straight into the result tables. No
 *     comparison produced them, and the test says so. What it proves is the part somebody actually
 *     waits on at that size: a page of findings, a filtered count, and an export.
 *
 * The thresholds are deliberately loose. A test that fails when a machine is busy teaches people to
 * ignore it; these fail when a query goes from indexed to a table scan, which is the regression that
 * matters.
 */

/** Enough records to cross the comparison batch size twice, and the figure the brief asks for. */
const RECORDS = 1_000;
/** The query-level set. Written directly: no comparison of this size ran. */
const FINDINGS = 100_000;

/**
 * Where the measurements go.
 *
 * To a file, not to the console: vitest keeps a passing test's output to itself, so a number printed
 * here is a number nobody reads. The file is what the certification report quotes, and it is written
 * fresh by every run, so a stale figure cannot be mistaken for this one.
 */
const MEASUREMENTS = 'validation-performance.txt';
const measure = (line: string) =>
  appendFileSync(
    MEASUREMENTS,
    `${line}
`,
  );

describe('validation performance', () => {
  let t: TestApp;
  let api: ApiClient;
  let organizationId: string;
  let report: ValidationRunDto;
  let migrationMs = 0;
  let validationMs = 0;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;

    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

    // A region the offices can point at, so their lookups resolve and the reference pass has work.
    const [region] = await t.database.db
      .select()
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-dev'),
          eq(demoRecords.logicalName, 'dtx_region'),
        ),
      );
    const regionId = String((region!.data as Record<string, unknown>)['dtx_regionid']);
    await t.database.db.insert(demoRecords).values(
      Array.from({ length: RECORDS }, (_, i) => {
        const id = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
        return {
          organizationId,
          environmentKey: 'demo-dev',
          logicalName: 'dtx_office',
          recordId: id,
          data: {
            dtx_officeid: id,
            dtx_name: `Office ${i}`,
            dtx_code: `OF-${String(i).padStart(5, '0')}`,
            dtx_regionid: { logicalName: 'dtx_region', id: regionId },
          },
        };
      }),
    );
    // The region itself has to be in the target first, or every office write is refused.
    await t.database.db.insert(demoRecords).values({
      organizationId,
      environmentKey: 'demo-uat',
      logicalName: 'dtx_region',
      recordId: regionId,
      data: region!.data,
    });

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Performance ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_office'],
    });
    const current = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const run = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: current.sourceEnvironment.displayName,
      confirmTargetName: current.targetEnvironment.displayName,
      acknowledgeWarnings: true,
    });
    const worker = t.services.createWorker();
    let started = Date.now();
    await worker.drain(900_000);
    migrationMs = Date.now() - started;

    const validation = await api.post<ValidationRunDto>('/api/validations', {
      migrationRunId: run.id,
      depth: 'FULL',
    });
    started = Date.now();
    await worker.drain(900_000);
    validationMs = Date.now() - started;
    await worker.stop();
    report = await api.get<ValidationRunDto>(`/api/validations/${validation.id}`);
  }, 1_800_000);

  afterAll(async () => {
    await t?.close();
  });

  it(`validates ${RECORDS} records end to end`, () => {
    const office = report.entities.find((e) => e.logicalName === 'dtx_office')!;
    expect(report.status).toBe('COMPLETED');
    expect(office.checkedRecords, 'every record the run wrote').toBeGreaterThanOrEqual(RECORDS);
    expect(office.coverage?.mode, 'FULL depth, so the claim is about all of them').toBe('FULL');
    expect(office.matched + office.different + office.missing).toBe(office.checkedRecords);
    // Recorded for the report rather than asserted tightly: a wall-clock number on one machine.
    measure(
      `end-to-end: migrated ${office.checkedRecords} records in ${migrationMs} ms, validated them in ${validationMs} ms (FULL depth)`,
    );
    expect(validationMs, 'a thousand records is minutes of work at worst, not tens').toBeLessThan(600_000);
  });

  describe(`reading ${FINDINGS.toLocaleString('en-AU')} findings`, () => {
    /**
     * A result set of a hundred thousand findings, written straight into the tables.
     *
     * Query-level evidence. The engine caps what it stores per table, on purpose, so a comparison
     * will not produce this many — and the page, the count and the export are read by the same
     * queries whatever wrote the rows. Inserting them is the only way to measure the part a person
     * waits on at this size without spending an hour producing it.
     */
    let bigRunId = '';

    beforeAll(async () => {
      const [vr] = await t.database.db
        .insert(validationRuns)
        .values({
          organizationId,
          sourceEnvironmentId: report.sourceEnvironment.id,
          targetEnvironmentId: report.targetEnvironment.id,
          tables: ['account'],
          status: 'COMPLETED',
          outcome: 'FAIL',
          depth: 'FULL',
          completedAt: new Date(),
        })
        .returning();
      bigRunId = vr!.id;
      const CHUNK = 2_000;
      for (let i = 0; i < FINDINGS; i += CHUNK) {
        await t.database.db.insert(validationDifferences).values(
          Array.from({ length: Math.min(CHUNK, FINDINGS - i) }, (_, k) => {
            const n = i + k;
            return {
              validationRunId: bigRunId,
              logicalName: 'account',
              sourceRecordId: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`,
              targetRecordId: `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`,
              // A handful of columns, so the field filter has something to narrow.
              field: ['telephone1', 'emailaddress1', 'websiteurl', 'description'][n % 4]!,
              sourceValue: `expected ${n}`,
              targetValue: `actual ${n}`,
              differenceType: n % 10 === 0 ? 'VALUE_LOST' : 'VALUE_MISMATCH',
              outcome: n % 10 === 0 ? ('WARNING' as const) : ('FAIL' as const),
            };
          }),
        );
      }
    }, 900_000);

    const page = async (offset: number, query = '') => {
      const started = Date.now();
      const r = await api.get<{ items: { id: string }[]; total: number }>(
        `/api/validations/${bigRunId}/differences?limit=50&offset=${offset}${query}`,
      );
      return { ...r, ms: Date.now() - started };
    };

    it('returns the first page, a page in the middle and the last page at the same cost', async () => {
      const first = await page(0);
      const middle = await page(Math.floor(FINDINGS / 2));
      const last = await page(FINDINGS - 50);
      expect(first.total).toBe(FINDINGS);
      expect(first.items).toHaveLength(50);
      expect(last.items).toHaveLength(50);
      measure(
        `query level: one page of 50 from ${FINDINGS} findings — first ${first.ms} ms, middle ${middle.ms} ms, last ${last.ms} ms`,
      );
      for (const p of [first, middle, last]) {
        expect(p.ms, `a page took ${p.ms} ms, which is a scan rather than an index`).toBeLessThan(5_000);
      }
    }, 120_000);

    it('never shows one finding on two pages, and never skips one', async () => {
      // Three consecutive pages. The order is total, so the boundaries cannot shift between queries.
      const seen = new Set<string>();
      for (let offset = 0; offset < 150; offset += 50) {
        const p = await page(offset);
        for (const row of p.items) {
          expect(seen.has(row.id), `finding ${row.id} appeared on two pages`).toBe(false);
          seen.add(row.id);
        }
      }
      expect(seen.size, 'three full pages, no repeats and no gaps').toBe(150);
      // The same page twice is the same page: nothing about the order depends on the query.
      const a = await page(500);
      const b = await page(500);
      expect(a.items.map((x) => x.id)).toEqual(b.items.map((x) => x.id));
    }, 120_000);

    it('narrows by category on the server, and counts only what matches', async () => {
      const lost = await page(0, '&type=VALUE_LOST');
      expect(lost.total, 'one in ten of them').toBe(FINDINGS / 10);
      const warnings = await page(0, '&outcome=WARNING');
      expect(warnings.total).toBe(FINDINGS / 10);
      measure(`query level: filtered page and count over ${FINDINGS} findings — ${lost.ms} ms`);
      expect(lost.ms).toBeLessThan(5_000);
    }, 120_000);

    it('exports every finding as a stream, without holding them all first', async () => {
      const started = Date.now();
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/validations/${bigRunId}/differences.csv`,
        headers: { cookie: api.cookie },
      });
      const ms = Date.now() - started;
      expect(res.statusCode).toBe(200);
      const lines = res.body.split('\n').filter((l) => l.length > 0);
      // Every finding, plus the header. The export is not capped where the screen is.
      expect(lines.length).toBe(FINDINGS + 1);
      expect(lines[0], 'and it carries what to do about each one').toMatch(/Next action/);
      measure(`query level: CSV of ${FINDINGS} findings — ${ms} ms, ${res.body.length} bytes`);
      expect(ms, 'a hundred thousand rows is seconds, not minutes').toBeLessThan(120_000);
    }, 300_000);

    it('exports only the findings the filter selects', async () => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/validations/${bigRunId}/differences.csv?type=VALUE_LOST`,
        headers: { cookie: api.cookie },
      });
      expect(res.statusCode).toBe(200);
      const lines = res.body.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBe(FINDINGS / 10 + 1);
    }, 300_000);
  });
});
