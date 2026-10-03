import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { demoRecords, migrationRecordMaps } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * What crash safety costs.
 *
 * The protocol adds one statement per batch — the intent rows — and one column read on resume. The
 * question the decision needed answering was whether that is 2%, 20% or 10×, and the only honest way to
 * find out is to migrate the same records twice: once with the intents written, once with that step
 * skipped, on the same machine in the same process.
 *
 * Off by default, because it takes minutes and proves nothing about correctness:
 *
 *   MEASURE_SCALE=1 npx vitest run tests/scale/crash-overhead.scale.test.ts --testTimeout=1800000
 *
 * Writes `evidence/crash-overhead.json`. What it measures is this platform's own bookkeeping against the
 * simulated target: a real connector's latency dwarfs all of it, which is the point — if the overhead is
 * small against an in-process target it is invisible against a network one.
 */
const ENABLED = !!process.env.MEASURE_SCALE;
const RECORDS = Number(process.env.CRASH_OVERHEAD_RECORDS ?? 4000);

describe.skipIf(!ENABLED)('crash-safety overhead', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let organizationId: string;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  const measurements: Record<string, unknown>[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

    // A table big enough for the per-batch cost to be measurable rather than noise.
    const rows = Array.from({ length: RECORDS }, (_, i) => {
      const id = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
      return {
        organizationId,
        environmentKey: 'demo-dev',
        logicalName: 'dtx_office',
        recordId: id,
        data: {
          dtx_officeid: id,
          dtx_name: `Overhead Office ${i}`,
          dtx_city: `City ${i % 80}`,
          dtx_headcount: (i % 50) + 1,
        },
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      await t.services.db.insert(demoRecords).values(rows.slice(i, i + 500));
    }
  }, 600_000);

  afterAll(async () => {
    if (measurements.length > 0) {
      mkdirSync('evidence', { recursive: true });
      writeFileSync(
        'evidence/crash-overhead.json',
        `${JSON.stringify(
          {
            measuredAt: new Date().toISOString(),
            host: `${os.platform()} ${os.arch()}, ${os.cpus().length} cpus`,
            node: process.version,
            records: RECORDS,
            target:
              'the simulated environment, in process — so this is the platform’s own cost and nothing else',
            proves:
              'What the write-ahead intent costs in database statements, wall clock and rows, on this host, against an in-process target.',
            doesNotProve:
              'Anything about a real target. A network round trip per record is orders of magnitude larger than any of this, so the proportional cost against a real connector is smaller than measured here, not larger.',
            measurements,
          },
          null,
          2,
        )}\n`,
      );
    }
    await worker.stop();
    await t.close();
  });

  const migrateOnce = async (label: string, skipIntents: boolean) => {
    /**
     * The comparison needs the *same* work done twice, so the second run goes into a fresh workspace's
     * worth of target rows. Simpler: clear the target table between runs, which is what a first
     * migration into an empty target looks like either way.
     */
    for (const table of ['dtx_office', 'dtx_region']) {
      await t.services.db
        .delete(demoRecords)
        .where(
          and(
            eq(demoRecords.organizationId, organizationId),
            eq(demoRecords.environmentKey, 'demo-uat'),
            eq(demoRecords.logicalName, table),
          ),
        );
    }

    // Count the statements the identity map receives, by wrapping the engine's two writers.
    const engine = t.services.engine as unknown as Record<string, unknown>;
    const realIntents = engine['persistIntents'] as (...a: unknown[]) => Promise<void>;
    const realResults = engine['persistResults'] as (...a: unknown[]) => Promise<void>;
    let intentStatements = 0;
    let resultStatements = 0;
    engine['persistIntents'] = async (...a: unknown[]) => {
      intentStatements++;
      // `skipIntents` measures the cost of the protocol by removing exactly the step it added.
      if (skipIntents) return;
      return realIntents.apply(engine, a);
    };
    engine['persistResults'] = async (...a: unknown[]) => {
      resultStatements++;
      return realResults.apply(engine, a);
    };

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Overhead ${label} ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'dtx_office'],
    });
    await api.patch(`/api/plans/${plan.id}/options`, { batchSize: 200 });
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const run = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(1_800_000);
    const elapsed = performance.now() - started;
    const heapAfter = process.memoryUsage().heapUsed;
    const final = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);

    engine['persistIntents'] = realIntents;
    engine['persistResults'] = realResults;

    const identityRows = await t.services.db
      .select({ sourceId: migrationRecordMaps.sourceId })
      .from(migrationRecordMaps)
      .where(eq(migrationRecordMaps.runId, final.id));

    return {
      label,
      intentsWritten: !skipIntents,
      status: final.status,
      processed: final.processed,
      created: final.created,
      seconds: Math.round(elapsed) / 1000,
      recordsPerSecond: Math.round(final.processed / (elapsed / 1000)),
      intentStatements,
      resultStatements,
      identityMapStatementsPerRecord:
        Math.round(
          ((skipIntents ? resultStatements : intentStatements + resultStatements) / final.processed) * 1000,
        ) / 1000,
      identityRows: identityRows.length,
      heapGrowthMb: Math.round(((heapAfter - heapBefore) / 1024 / 1024) * 10) / 10,
    };
  };

  it('measures the same migration with and without the intent step', async () => {
    // Without first, so the protocol is not advantaged by a warm cache.
    const without = await migrateOnce('without write-ahead intent', true);
    const with_ = await migrateOnce('with write-ahead intent', false);
    measurements.push(without, with_);

    // Both did the same work.
    expect(with_.processed, 'the same records both times').toBe(without.processed);
    expect(with_.created).toBe(without.created);

    const overhead = (with_.seconds - without.seconds) / without.seconds;
    measurements.push({
      label: 'overhead',
      wallClockRatio: Math.round((with_.seconds / without.seconds) * 1000) / 1000,
      wallClockPercent: Math.round(overhead * 1000) / 10,
      extraStatementsPerRecord:
        Math.round((with_.identityMapStatementsPerRecord - without.identityMapStatementsPerRecord) * 1000) /
        1000,
      note: `${with_.intentStatements} extra statement(s) across ${with_.processed} records: one per batch, not one per record.`,
    });

    // The claim the design rests on: per batch, not per record.
    expect(
      with_.intentStatements,
      'one intent statement per batch, far fewer than one per record',
    ).toBeLessThan(with_.processed / 10);
    // And a sanity bound rather than a performance target: anything near 2x would mean the design is
    // wrong, not that the machine was busy.
    expect(overhead, `wall clock overhead was ${Math.round(overhead * 100)}%`).toBeLessThan(1);
  }, 1_800_000);
});
