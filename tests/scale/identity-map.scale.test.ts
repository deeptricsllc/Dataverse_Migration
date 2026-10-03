import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, count, eq, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createDatabase, type Database } from '../../server/src/db/client';
import {
  environments,
  migrationPlans,
  migrationRecordMaps,
  migrationRuns,
  organizations,
} from '../../server/src/db/schema';
import { DEFAULT_PLAN_OPTIONS } from '../../shared/domain';

/**
 * What the platform's own bookkeeping costs as a table grows.
 *
 * Not a benchmark of anybody's database. The connectors talk to a real server over a real driver and
 * that server's speed is its own; this measures the part the platform is responsible for — the
 * identity map it writes for every record, the pages it reads back, the memory it holds while doing
 * it. Those are the costs that decide whether ten million records is a long wait or an
 * impossibility, and they are the only ones this process can honestly report.
 *
 * Off by default, because it takes minutes and proves nothing about correctness:
 *
 *   MEASURE_SCALE=1 npx vitest run tests/scale --testTimeout=1800000
 *   MEASURE_SCALE=1 SCALE_SIZES=10000,50000,200000 npx vitest run tests/scale
 *
 * It writes `evidence/scale-measurements.json`, which is what `docs/SCALE_ENVELOPE.md` cites. Every
 * figure there is a measurement at a stated size on stated hardware; extrapolating past them is the
 * reader's judgement, and the document says where that judgement stops.
 */
const ENABLED = !!process.env.MEASURE_SCALE;
const SIZES = (process.env.SCALE_SIZES ?? '10000,50000')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
/** The page size validation and the second passes use. */
const PAGE = 500;
const INSERT_BATCH = 500;
/** Above this, loading the whole map for comparison is a liability rather than a data point. */
const WHOLE_MAP_LIMIT = 200_000;

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const perSecond = (n: number, ms: number) => Math.round(n / (ms / 1000));

interface Measurement {
  records: number;
  writeSeconds: number;
  writeRatePerSecond: number;
  countMilliseconds: number;
  pagedReadSeconds: number;
  pagedReadRatePerSecond: number;
  pagedReadPages: number;
  pagedReadPeakHeapMb: number;
  wholeMapSeconds: number | null;
  wholeMapHeapMb: number | null;
}

describe.skipIf(!ENABLED)('identity map at scale', () => {
  let database: Database;
  const measurements: Measurement[] = [];
  /** Real parents, because the identity map's foreign keys and indexes are part of what is measured. */
  const parents = { organizationId: '', runId: '', sourceEnvironmentId: '', targetEnvironmentId: '' };

  beforeAll(async () => {
    database = await createDatabase({
      databaseUrl: process.env.TEST_DATABASE_URL || undefined,
      pgliteDataDir: 'memory://',
    });
    await database.migrate('server/drizzle');
    const db = database.db;
    const [org] = await db.insert(organizations).values({ name: 'Scale measurement' }).returning();
    parents.organizationId = org!.id;
    const env = (name: string) =>
      db
        .insert(environments)
        .values({
          organizationId: org!.id,
          provider: 'demo',
          displayName: name,
          url: `https://scale.invalid/${name}`,
        })
        .returning();
    const [source] = await env('source');
    const [target] = await env('target');
    parents.sourceEnvironmentId = source!.id;
    parents.targetEnvironmentId = target!.id;
    const [plan] = await db
      .insert(migrationPlans)
      .values({
        organizationId: org!.id,
        name: 'Scale measurement',
        sourceEnvironmentId: source!.id,
        targetEnvironmentId: target!.id,
        options: DEFAULT_PLAN_OPTIONS,
      })
      .returning();
    const [run] = await db
      .insert(migrationRuns)
      .values({
        organizationId: org!.id,
        planId: plan!.id,
        sourceEnvironmentId: source!.id,
        targetEnvironmentId: target!.id,
        options: DEFAULT_PLAN_OPTIONS,
        planSnapshot: { entities: [] } as never,
      })
      .returning();
    parents.runId = run!.id;
  }, 300_000);

  afterAll(async () => {
    if (measurements.length > 0) {
      mkdirSync('evidence', { recursive: true });
      writeFileSync(
        'evidence/scale-measurements.json',
        `${JSON.stringify(
          {
            measuredAt: new Date().toISOString(),
            store: process.env.TEST_DATABASE_URL
              ? 'a real PostgreSQL server'
              : 'PGlite, the platform database embedded in the process',
            host: `${os.platform()} ${os.arch()}, ${os.cpus().length} cpus, ${mb(os.totalmem())} MB`,
            node: process.version,
            pageSize: PAGE,
            proves:
              'How the platform’s own bookkeeping behaves as a table grows, at these sizes, on this host.',
            doesNotProve:
              'Anything about a customer’s source or target. Read and write throughput against Dataverse, SQL Server or any other real system is that system’s, and it is usually the slower half.',
            measurements,
          },
          null,
          2,
        )}\n`,
      );
    }
    await database?.close?.();
  });

  for (const size of SIZES) {
    it(`handles ${size.toLocaleString()} records without growing with them`, async () => {
      const db = database.db;
      const runId = parents.runId;
      const logicalName = `scale_probe_${size}`;
      const common = { ...parents, logicalName };

      // --- writing the identity map ----------------------------------------
      const writeStart = performance.now();
      for (let written = 0; written < size; written += INSERT_BATCH) {
        const rows = [];
        for (let i = written; i < Math.min(written + INSERT_BATCH, size); i++) {
          rows.push({
            ...common,
            sourceId: `s-${String(i).padStart(12, '0')}`,
            targetId: randomUUID(),
            // A realistic mix, so the grouped count has more than one row to return.
            outcome:
              i % 97 === 0 ? ('FAILED' as const) : i % 13 === 0 ? ('SKIPPED' as const) : ('CREATED' as const),
          });
        }
        await db.insert(migrationRecordMaps).values(rows);
      }
      const writeMs = performance.now() - writeStart;

      const scope = and(
        eq(migrationRecordMaps.runId, runId),
        eq(migrationRecordMaps.logicalName, logicalName),
      )!;

      // --- the counts every screen shows -----------------------------------
      const countStart = performance.now();
      const grouped = await db
        .select({ outcome: migrationRecordMaps.outcome, n: count() })
        .from(migrationRecordMaps)
        .where(scope)
        .groupBy(migrationRecordMaps.outcome);
      const countMs = performance.now() - countStart;
      expect(grouped.length, 'more than one outcome, so the grouping is real').toBeGreaterThan(1);
      expect(grouped.reduce((n, g) => n + Number(g.n), 0)).toBe(size);

      // --- reading it back the way validation does --------------------------
      global.gc?.();
      const beforeRead = process.memoryUsage().heapUsed;
      let peakRead = beforeRead;
      const readStart = performance.now();
      let cursor: string | null = null;
      let pages = 0;
      let seen = 0;
      for (;;) {
        const page = await db
          .select({
            sourceId: migrationRecordMaps.sourceId,
            targetId: migrationRecordMaps.targetId,
            outcome: migrationRecordMaps.outcome,
          })
          .from(migrationRecordMaps)
          .where(cursor === null ? scope : and(scope, gt(migrationRecordMaps.sourceId, cursor)))
          .orderBy(asc(migrationRecordMaps.sourceId))
          .limit(PAGE);
        if (page.length === 0) break;
        pages++;
        seen += page.length;
        peakRead = Math.max(peakRead, process.memoryUsage().heapUsed);
        cursor = page[page.length - 1]!.sourceId;
        if (page.length < PAGE) break;
      }
      const readMs = performance.now() - readStart;
      expect(seen, 'the keyset walk saw every row exactly once').toBe(size);

      // --- what it replaced, for comparison --------------------------------
      // Reported so the difference is a number rather than an assertion.
      let wholeMs: number | null = null;
      let wholeMb: number | null = null;
      if (size <= WHOLE_MAP_LIMIT) {
        global.gc?.();
        const before = process.memoryUsage().heapUsed;
        const start = performance.now();
        const all = await db.select().from(migrationRecordMaps).where(scope);
        wholeMs = Math.round(performance.now() - start) / 1000;
        wholeMb = mb(process.memoryUsage().heapUsed - before);
        expect(all.length).toBe(size);
      }

      await db.delete(migrationRecordMaps).where(scope);

      measurements.push({
        records: size,
        writeSeconds: Math.round(writeMs) / 1000,
        writeRatePerSecond: perSecond(size, writeMs),
        countMilliseconds: Math.round(countMs),
        pagedReadSeconds: Math.round(readMs) / 1000,
        pagedReadRatePerSecond: perSecond(seen, readMs),
        pagedReadPages: pages,
        pagedReadPeakHeapMb: mb(peakRead - beforeRead),
        wholeMapSeconds: wholeMs,
        wholeMapHeapMb: wholeMb,
      });
    }, 1_800_000);
  }

  it('shows the paged read not growing with the table', () => {
    expect(measurements.length, 'at least two sizes were measured').toBeGreaterThan(1);
    const [smallest, largest] = [measurements[0]!, measurements[measurements.length - 1]!];
    const factor = largest.records / smallest.records;
    // The claim the envelope rests on: time grows with the table, memory does not. Generous bounds,
    // because this runs on whatever machine happens to be free — the shape is the finding, not the
    // constant.
    expect(largest.pagedReadPeakHeapMb).toBeLessThan(
      Math.max(smallest.pagedReadPeakHeapMb * (factor / 2), 64),
    );
  });
});
