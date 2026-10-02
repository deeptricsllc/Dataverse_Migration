import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { accountedFor, writtenByRun } from '../../shared/run-metrics';
import { isUnresolved } from '../../shared/write-state';
import { DataverseError } from '../../server/src/dataverse/errors';
import { demoRecords, migrationRecordMaps } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * A crash at every persistence boundary, and what the platform says afterwards.
 *
 * The boundaries, from `docs/CRASH_CONSISTENCY.md`:
 *
 *   before the target write · request sent, answer lost · target committed, answer lost ·
 *   committed and received, then death · death before the identity map · death before the counters ·
 *   mid-batch · during a retry · during the deferred pass
 *
 * Each one is injected deterministically rather than waited for, and the question asked afterwards is
 * never "did it finish" but "can every source record be accounted for exactly once". The target is
 * counted in its own storage rather than through the product's API, because a report that agrees with
 * itself is not evidence.
 *
 * What is simulated and what is real: the *process does not actually die*. A connector throws at the
 * chosen boundary and the engine unwinds, which leaves the database in the same state a death would —
 * the identity-map write for that batch never happens. What this cannot simulate is a death between two
 * statements of the same transaction, and there are none on this path: every write here is its own
 * statement. `tests/engines/crash.engine.test.ts` repeats the important cases against real servers.
 */

type Boundary =
  /** The write is never sent: the record is untouched in the target. */
  | 'BEFORE_WRITE'
  /** The server answers with a definite refusal. */
  | 'REJECTED'
  /** The request is sent, the target commits, and the answer is lost. */
  | 'COMMITTED_ANSWER_LOST'
  /** The answer arrives and the process dies before the identity map is written. */
  | 'AFTER_WRITE_BEFORE_MAP';

describe('crash matrix', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let organizationId: string;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;

  /** What actually reached the simulated target, recorded outside the product's own bookkeeping. */
  let committed: { table: string; id: string }[] = [];
  let injection: { boundary: Boundary; onCall: number; table?: string } | null = null;
  let calls = 0;
  /** Set to interrupt reconciliation itself: the lookup it depends on fails. */
  let failTargetReads = 0;

  beforeEach(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    committed = [];
    injection = null;
    calls = 0;
    failTargetReads = 0;

    const factory = t.services.connections as unknown as {
      connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const original = factory.connectorFor.bind(factory);
    factory.connectorFor = async (...args: unknown[]) => {
      const conn = await original(...args);
      const isTarget = String((args[0] as { id?: string })?.id ?? '') === uat.id;
      if (!isTarget) return conn;
      // Reconciliation asks the target whether a record is there. Failing that read is how the recovery
      // path itself is interrupted.
      const retrieve = conn['retrieveByIds'] as (...a: unknown[]) => Promise<unknown>;
      conn['retrieveByIds'] = async (...a: unknown[]) => {
        if (failTargetReads > 0) {
          failTargetReads--;
          throw new DataverseError('TIMEOUT', 'Injected: the lookup recovery depends on timed out', 408);
        }
        return retrieve.apply(conn, a);
      };
      const create = conn['createRecord'] as (...a: unknown[]) => Promise<string>;
      conn['createRecord'] = async (...a: unknown[]) => {
        const table = String((a[0] as { logicalName?: string })?.logicalName ?? '?');
        calls++;
        const fire =
          injection && calls === injection.onCall && (!injection.table || injection.table === table);
        if (fire && injection!.boundary === 'BEFORE_WRITE') {
          // Nothing is sent: the connector fails before touching the target.
          throw new DataverseError('NETWORK', 'Injected: connection lost before the request was sent', 0);
        }
        if (fire && injection!.boundary === 'REJECTED') {
          throw new DataverseError('VALIDATION', 'Injected: the target refused this record', 400);
        }
        const id = await create.apply(conn, a);
        committed.push({ table, id });
        if (fire && injection!.boundary === 'COMMITTED_ANSWER_LOST') {
          // The write committed; the answer never arrives. The hardest case, and the realistic one.
          throw new DataverseError('TIMEOUT', 'Injected: the target committed and the answer was lost', 408);
        }
        if (fire && injection!.boundary === 'AFTER_WRITE_BEFORE_MAP') {
          // The answer arrived and the process dies before the batch's identity rows are written.
          throw new DataverseError('AUTH_REQUIRED', 'Injected: process died after the write', 401);
        }
        return id;
      };
      return conn;
    };
  }, 120_000);

  afterEach(async () => {
    await worker.stop();
    await t.close();
  });

  const migrate = async (
    tables: string[],
    opts: { batchSize?: number; matchStrategy?: 'PRIMARY_ID' | 'ALTERNATE_KEY' | 'BUSINESS_KEY' } = {},
  ) => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Crash ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables,
    });
    await api.patch(`/api/plans/${plan.id}/options`, { batchSize: opts.batchSize ?? 100 });
    if (opts.matchStrategy) {
      const full = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
      for (const e of full.entities) {
        await api.patch(`/api/plans/${plan.id}/entities/${e.id}`, {
          matchStrategy: opts.matchStrategy,
          alternateKey: null,
        });
      }
    }
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(300_000);
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };

  const retry = async (runId: string) => {
    injection = null;
    calls = 0;
    committed = [];
    await api.post(`/api/runs/${runId}/retry`, {});
    await worker.drain(300_000);
    return api.get<MigrationRunDto>(`/api/runs/${runId}`);
  };

  const rows = (runId: string, table: string) =>
    t.services.db
      .select()
      .from(migrationRecordMaps)
      .where(and(eq(migrationRecordMaps.runId, runId), eq(migrationRecordMaps.logicalName, table)));

  /** The target counted in its own storage, never through the product's API. */
  const targetRows = async (table: string) =>
    t.services.db
      .select({ recordId: demoRecords.recordId, data: demoRecords.data })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, table),
        ),
      );

  const sourceCount = async (table: string) =>
    (
      await t.services.db
        .select({ recordId: demoRecords.recordId })
        .from(demoRecords)
        .where(
          and(
            eq(demoRecords.organizationId, organizationId),
            eq(demoRecords.environmentKey, 'demo-dev'),
            eq(demoRecords.logicalName, table),
          ),
        )
    ).length;

  /** The question every scenario ends with. */
  const accountForEveryRecord = async (run: MigrationRunDto, table: string) => {
    const identity = await rows(run.id, table);
    const target = await targetRows(table);
    const sources = await sourceCount(table);
    return {
      sources,
      identityRows: identity.length,
      targetRecords: target.length,
      distinctSources: new Set(identity.map((r) => r.sourceId)).size,
      distinctTargets: new Set(identity.filter((r) => r.targetId).map((r) => r.targetId)).size,
      unresolved: identity.filter((r) => isUnresolved(r.writeState)).length,
      confirmed: identity.filter((r) => r.writeState === 'CONFIRMED').length,
    };
  };

  // =========================================================================
  it('A — a connection lost before the write is still treated as unknown, on purpose', async () => {
    /**
     * The scenario that taught me something while writing it.
     *
     * "Crash before the target write" sounds like a distinct, safe case — nothing was sent, so nothing
     * can be in the target. But a client that loses its connection **cannot tell** whether the request
     * reached the server. From inside the engine this is indistinguishable from scenario C, and treating
     * it as "definitely not written" would be exactly the assumption that produced the original bug.
     *
     * So it is unresolved, and reconciliation settles it by asking the target. The cost of being
     * conservative here is one lookup; the cost of being wrong the other way is a duplicate record.
     */
    injection = { boundary: 'BEFORE_WRITE', onCall: 3, table: 'dtx_region' };
    const run = await migrate(['dtx_region']);
    const first = await rows(run.id, 'dtx_region');
    const unknown = first.filter((r) => r.writeState === 'UNKNOWN');
    expect(unknown.length, 'a lost connection is not assumed to mean "not written"').toBe(1);
    expect(unknown[0]!.outcome).toBe('UNRESOLVED');
    expect(unknown[0]!.targetId, 'and it claims no target record').toBeNull();
    // The injected record never reached the target; the others did. Reconciliation discovers that.
    const sources = await sourceCount('dtx_region');
    expect(committed.length, 'one record short: the one whose connection was lost').toBe(sources - 1);

    const resumed = await retry(run.id);
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.unresolved).toBe(0);
    const final = await accountForEveryRecord(resumed, 'dtx_region');
    expect(final.targetRecords).toBe(final.sources);
    expect(final.distinctTargets).toBe(final.identityRows);
  }, 600_000);

  // =========================================================================
  it('B — a definite refusal is a failure, and the retry is safe', async () => {
    injection = { boundary: 'REJECTED', onCall: 2, table: 'dtx_region' };
    const run = await migrate(['dtx_region']);
    const first = await rows(run.id, 'dtx_region');
    const failed = first.filter((r) => r.outcome === 'FAILED');
    expect(failed.length, 'the server said no, so the record failed').toBe(1);
    expect(failed[0]!.writeState, 'and nothing about it is uncertain').toBeNull();
    expect(failed[0]!.targetId, 'it claims no target record').toBeNull();

    // The target holds one fewer than the source, which the report says.
    const before = await targetRows('dtx_region');
    expect(before.length).toBe((await sourceCount('dtx_region')) - 1);

    const resumed = await retry(run.id);
    expect(resumed.status).toBe('COMPLETED');
    const final = await accountForEveryRecord(resumed, 'dtx_region');
    expect(final.targetRecords, 'exactly one record per source record').toBe(final.sources);
    expect(final.distinctTargets).toBe(final.identityRows);
  }, 600_000);

  // =========================================================================
  it('C — the target commits and the answer is lost: recovery does not duplicate', async () => {
    /**
     * The case the old engine got wrong without any crash at all. The write committed; the client never
     * heard. Calling that FAILED and retrying produced two records.
     */
    injection = { boundary: 'COMMITTED_ANSWER_LOST', onCall: 2, table: 'dtx_region' };
    const run = await migrate(['dtx_region']);

    const committedByTheTarget = committed.length;
    expect(committedByTheTarget, 'the record did reach the target').toBeGreaterThan(0);
    const first = await rows(run.id, 'dtx_region');
    const unknown = first.filter((r) => r.writeState === 'UNKNOWN');
    expect(unknown.length, 'and the platform says it does not know').toBe(1);
    expect(unknown[0]!.outcome, 'counted as neither written nor failed').toBe('UNRESOLVED');

    const resumed = await retry(run.id);
    expect(resumed.status, 'reconciliation settled it').toBe('COMPLETED');
    expect(resumed.unresolved).toBe(0);

    const final = await accountForEveryRecord(resumed, 'dtx_region');
    expect(final.targetRecords, 'one record per source record — nothing written twice').toBe(final.sources);
    expect(final.distinctTargets).toBe(final.identityRows);
    // And the recovered record says how it was found.
    const recovered = (await rows(resumed.id, 'dtx_region')).filter((r) =>
      r.reconcileNote?.includes('did commit'),
    );
    expect(recovered.length, 'the record that was already there was found, not created').toBe(1);
  }, 600_000);

  // =========================================================================
  it('D — a write confirmed then lost before the identity map does not duplicate', async () => {
    injection = { boundary: 'AFTER_WRITE_BEFORE_MAP', onCall: 3, table: 'dtx_region' };
    const run = await migrate(['dtx_region']);
    const writtenBeforeDeath = committed.length;
    expect(writtenBeforeDeath, 'records reached the target').toBeGreaterThan(0);

    const first = await rows(run.id, 'dtx_region');
    expect(first.length, 'every record it was about to write has an intent row').toBeGreaterThan(0);
    expect(
      first.every((r) => r.writeState === 'INTENDED' || r.writeState === 'CONFIRMED'),
      'each one says whether we know what happened',
    ).toBe(true);

    const resumed = await retry(run.id);
    expect(resumed.unresolved).toBe(0);
    const final = await accountForEveryRecord(resumed, 'dtx_region');
    expect(final.targetRecords, 'exactly one record per source record').toBe(final.sources);
    expect(final.distinctTargets).toBe(final.identityRows);
  }, 600_000);

  // =========================================================================
  it('E — counters are rebuilt from the identity map, so losing them costs nothing', async () => {
    const run = await migrate(['dtx_region']);
    expect(run.status).toBe('COMPLETED');

    // Corrupt the counters the way a crash between the identity-map write and the counter update would.
    const { migrationRuns } = await import('../../server/src/db/schema');
    await t.services.db
      .update(migrationRuns)
      .set({ created: 0, processed: 0, failed: 99, unresolved: 42 })
      .where(eq(migrationRuns.id, run.id));

    const { refreshRunCounters } = await import('../../server/src/services/run-counters');
    await refreshRunCounters(t.services.db, run.id);

    const rebuilt = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    const identity = await rows(run.id, 'dtx_region');
    expect(rebuilt.created, 'rebuilt from the rows themselves').toBe(
      identity.filter((r) => r.outcome === 'CREATED').length,
    );
    expect(rebuilt.failed).toBe(0);
    expect(rebuilt.unresolved).toBe(0);
    expect(accountedFor(rebuilt)).toBe(rebuilt.processed);
    expect(writtenByRun(rebuilt)).toBe(rebuilt.created + rebuilt.updated);
  }, 600_000);

  // =========================================================================
  it('F — a crash half way through a batch leaves every record explainable', async () => {
    injection = { boundary: 'AFTER_WRITE_BEFORE_MAP', onCall: 7, table: 'account' };
    const run = await migrate(['account'], { batchSize: 5 });

    const identity = await rows(run.id, 'account');
    // Every row says something definite about itself. Nothing is silent.
    for (const row of identity) {
      expect(['CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED', 'FAILED', 'UNRESOLVED']).toContain(row.outcome);
      if (row.outcome === 'UNRESOLVED') {
        expect(isUnresolved(row.writeState), `${row.sourceId} says it is in doubt`).toBe(true);
        expect(row.intendedOperation, 'and what it was going to do').toBeTruthy();
        expect(row.reconcileEvidence, 'and what could identify it').toBeTruthy();
      } else if (row.outcome === 'CREATED') {
        expect(row.writeState).toBe('CONFIRMED');
        expect(row.targetId).toBeTruthy();
      }
    }
    // The ones that reached the target are a subset of the ones with rows: nothing was written without
    // the platform having said it was about to.
    expect(identity.length, 'nothing reached the target unannounced').toBeGreaterThanOrEqual(
      committed.length,
    );

    const resumed = await retry(run.id);
    const final = await accountForEveryRecord(resumed, 'account');
    expect(final.distinctSources, 'one row per source record').toBe(final.identityRows);
    expect(final.distinctTargets, 'one target per accounted record').toBe(
      final.identityRows -
        final.unresolved -
        (await rows(resumed.id, 'account')).filter((r) => r.outcome === 'FAILED').length,
    );
  }, 900_000);

  // =========================================================================
  it('G — recovery is itself idempotent: crashing during it changes nothing', async () => {
    injection = { boundary: 'COMMITTED_ANSWER_LOST', onCall: 2, table: 'dtx_region' };
    const run = await migrate(['dtx_region']);
    const afterCrash = await rows(run.id, 'dtx_region');
    const unknownBefore = afterCrash.filter((r) => r.writeState === 'UNKNOWN').length;
    expect(unknownBefore).toBe(1);

    /**
     * Interrupt reconciliation itself, by failing the lookup it depends on.
     *
     * The property being checked is that an interrupted recovery leaves the rows it has not reached
     * exactly as it found them — no row half-settled, no row assumed. A recovery that guessed when its
     * own lookup failed would be the original bug wearing a different hat.
     */
    const targetBeforeRecovery = (await targetRows('dtx_region')).length;
    injection = null;
    calls = 0;
    failTargetReads = 50;
    await api.post(`/api/runs/${run.id}/retry`, {});
    await worker.drain(300_000);

    const afterInterrupted = await rows(run.id, 'dtx_region');
    const stillUnknown = afterInterrupted.filter((r) => isUnresolved(r.writeState));
    expect(stillUnknown.length, 'the record is still in doubt, not assumed either way').toBe(unknownBefore);
    expect(
      stillUnknown.every((r) => r.outcome === 'UNRESOLVED'),
      'and still counted as neither written nor failed',
    ).toBe(true);
    expect(
      (await targetRows('dtx_region')).length,
      'an interrupted recovery wrote nothing to the target',
    ).toBe(targetBeforeRecovery);

    // A second recovery, unobstructed, reaches the conclusion the first one could not.
    failTargetReads = 0;
    const resumed = await retry(run.id);
    expect(resumed.unresolved, 'settled the second time').toBe(0);
    const final = await accountForEveryRecord(resumed, 'dtx_region');
    expect(final.targetRecords, 'one record per source record after two recoveries').toBe(final.sources);
    expect(final.distinctTargets).toBe(final.identityRows);
  }, 900_000);

  // =========================================================================
  it('H — with no key and no evidence it stops, and does not insert again', async () => {
    // Regions first so an office's lookup resolves; offices have no alternate key.
    const regions = await migrate(['dtx_region']);
    expect(regions.status).toBe('COMPLETED');

    const factory = t.services.connections as unknown as {
      connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const outer = factory.connectorFor.bind(factory);
    factory.connectorFor = async (...args: unknown[]) => {
      const conn = await outer(...args);
      if (String((args[0] as { id?: string })?.id ?? '') === uat.id) {
        // A target that assigns its own keys: nothing can identify a record afterwards.
        conn['capabilities'] = { ...(conn['capabilities'] as object), supportsClientGeneratedIds: false };
      }
      return conn;
    };

    injection = { boundary: 'COMMITTED_ANSWER_LOST', onCall: 2, table: 'dtx_office' };
    calls = 0;
    committed = [];
    const run = await migrate(['dtx_office'], { matchStrategy: 'PRIMARY_ID' });
    const targetAfterCrash = (await targetRows('dtx_office')).length;

    expect(run.status, 'the run stops rather than guessing').toBe('NEEDS_RECONCILIATION');
    expect(run.unresolved).toBeGreaterThan(0);
    const stuck = (await rows(run.id, 'dtx_office')).filter(
      (r) => r.writeState === 'RECONCILIATION_REQUIRED' || r.writeState === 'UNKNOWN',
    );
    expect(stuck.length, 'the records nobody can resolve are named').toBeGreaterThan(0);
    for (const row of stuck) expect(row.reconcileEvidence).toBe('NONE');

    // A retry is refused outright.
    const refused = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/retry`,
      payload: {},
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(refused.statusCode).toBe(409);

    // And nothing more was written: the target is exactly as the crash left it.
    expect((await targetRows('dtx_office')).length, 'not one record inserted again').toBe(targetAfterCrash);
  }, 900_000);

  // =========================================================================
  it('I — after recovery the run finishes and the target holds exactly what it should', async () => {
    injection = { boundary: 'COMMITTED_ANSWER_LOST', onCall: 4, table: 'account' };
    const run = await migrate(['account'], { batchSize: 5 });
    expect(run.unresolved, 'something was left in doubt').toBeGreaterThan(0);

    const resumed = await retry(run.id);
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.unresolved).toBe(0);

    const final = await accountForEveryRecord(resumed, 'account');
    // The question this whole exercise exists to answer.
    expect(final.identityRows, 'every source record has exactly one row').toBe(final.sources);
    expect(final.distinctSources).toBe(final.sources);
    expect(final.targetRecords, 'and the target holds exactly one record for each').toBe(final.sources);
    expect(final.distinctTargets).toBe(final.sources);
    expect(final.confirmed, 'every one of them confirmed').toBe(final.sources);
    expect(accountedFor(resumed)).toBe(resumed.processed);
  }, 900_000);
});
