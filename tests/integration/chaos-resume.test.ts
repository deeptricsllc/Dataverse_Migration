import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import { accountedFor, writtenByRun } from '../../shared/run-metrics';
import { DataverseError } from '../../server/src/dataverse/errors';
import { migrationRecordMaps } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * What happens when a migration stops in the middle, and what happens when it starts again.
 *
 * Resume is the claim with the most riding on it and the least natural evidence: a run that
 * completes proves nothing about a run that does not. So failures here are injected at known points
 * rather than waited for — a connector that throws after exactly N writes, every time — and the
 * question asked afterwards is never "did it finish" but "does the target, the identity map, the
 * metrics and the audit trail all say the same thing".
 *
 * The injected error is one the engine treats as fatal, which is the closest a test can get to the
 * process dying: the batch stops where it is, and nothing downstream of the write runs. That matters
 * because the target write and the identity-map write are two systems, in that order, with no
 * transaction across them. Everything in `the identity-map boundary` below is about the window
 * between them.
 */

/** A connector wrapper that fails deterministically, and remembers what it did before failing. */
interface Injection {
  /** Fail the Nth call of this operation (1-based). 0 never fails. */
  failWriteNumber?: number;
  /** Fail only this many times, then behave normally. For transient-failure scenarios. */
  transientFailures?: number;
  /** Which operation to fail. */
  operation?: 'createRecord' | 'updateRecord';
  /** Thrown as fatal (aborts the run) or transient (retried, then recorded per record). */
  kind?: 'fatal' | 'transient';
}

describe('chaos: failure and resume', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let organizationId: string;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  /** Target writes that actually reached the simulated environment, in order. */
  let written: { operation: string; table: string; id: string | null }[] = [];
  let injection: Injection = {};
  let calls = { createRecord: 0, updateRecord: 0 };

  beforeEach(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    written = [];
    injection = {};
    calls = { createRecord: 0, updateRecord: 0 };

    // Every connector the engine builds for the target goes through here.
    const factory = t.services.connections as unknown as {
      connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const original = factory.connectorFor.bind(factory);
    factory.connectorFor = async (...args: unknown[]) => {
      const conn = await original(...args);
      for (const operation of ['createRecord', 'updateRecord'] as const) {
        const inner = conn[operation] as ((...a: unknown[]) => Promise<unknown>) | undefined;
        if (typeof inner !== 'function') continue;
        conn[operation] = async (...a: unknown[]) => {
          const isTarget = String((args[0] as { id?: string })?.id ?? '') !== dev.id;
          if (!isTarget) return inner.apply(conn, a);
          calls[operation]++;
          const shouldFail =
            injection.operation === operation &&
            ((injection.failWriteNumber !== undefined && calls[operation] === injection.failWriteNumber) ||
              (injection.transientFailures !== undefined && calls[operation] <= injection.transientFailures));
          if (shouldFail) {
            // AUTH_REQUIRED is what the engine treats as fatal: it stops the run rather than
            // marking one record failed, which is the shape of a process that died.
            throw injection.kind === 'transient'
              ? new DataverseError('THROTTLED', 'Injected transient failure', 429)
              : new DataverseError('AUTH_REQUIRED', 'Injected fatal failure', 401);
          }
          const result = await inner.apply(conn, a);
          written.push({
            operation,
            table: String((a[0] as { logicalName?: string })?.logicalName ?? '?'),
            id: operation === 'createRecord' ? String(result) : String(a[1]),
          });
          return result;
        };
      }
      return conn;
    };
  }, 120_000);

  afterEach(async () => {
    await worker.stop();
    await t.close();
  });

  const startMigration = async (
    tables: string[],
    batchSize = 100,
    matchStrategy?: 'PRIMARY_ID' | 'ALTERNATE_KEY' | 'BUSINESS_KEY',
    conflictStrategy?: 'SKIP_EXISTING' | 'SYNC',
  ) => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Chaos ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables,
    });
    await api.patch(`/api/plans/${plan.id}/options`, {
      batchSize,
      ...(conflictStrategy ? { conflictStrategy } : {}),
    });
    if (matchStrategy) {
      const full = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
      for (const entity of full.entities) {
        await api.patch(`/api/plans/${plan.id}/entities/${entity.id}`, { matchStrategy, alternateKey: null });
      }
    }
    const run = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(300_000);
    return api.get<MigrationRunDto>(`/api/runs/${run.id}`);
  };

  const identityRows = (runId: string, logicalName?: string) =>
    t.services.db
      .select()
      .from(migrationRecordMaps)
      .where(
        logicalName
          ? and(eq(migrationRecordMaps.runId, runId), eq(migrationRecordMaps.logicalName, logicalName))
          : eq(migrationRecordMaps.runId, runId),
      );

  /** Records actually in the simulated target, counted in its own storage rather than reported. */
  const targetCount = async (logicalName: string) => {
    const { demoRecords } = await import('../../server/src/db/schema');
    const rows = await t.services.db
      .select({ recordId: demoRecords.recordId })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, logicalName),
        ),
      );
    return rows.length;
  };

  // -------------------------------------------------------------------------
  // The boundary with no transaction across it
  // -------------------------------------------------------------------------
  describe('the identity-map boundary', () => {
    it('records what reached the target even when the run died before writing the map', async () => {
      // Target writes happen record by record; the identity map is written once per batch,
      // afterwards. A run that dies between them leaves records in the target that the platform has
      // no row for. This asserts the size of that window rather than assuming it is zero.
      injection = { operation: 'createRecord', failWriteNumber: 4, kind: 'fatal' };
      const run = await startMigration(['dtx_region'], 100);

      expect(run.status, 'the run stopped rather than carrying on').toBe('FAILED');
      // Records are written four at a time, so the exact number that lands before the injected
      // failure is a race. That some land is the point, and it is deterministic.
      const created = written.filter((w) => w.operation === 'createRecord');
      expect(created.length, 'records reached the target before the failure').toBeGreaterThan(0);
      expect(created.length, 'but not all of them').toBeLessThan(run.total);

      const maps = await identityRows(run.id, 'dtx_region');
      // The window, measured. If this is 0, every record written before the failure is invisible to
      // the platform; the next test is about whether that is recoverable.
      expect(maps.length, 'identity rows for a batch that never completed').toBe(0);
    }, 300_000);

    it('does not duplicate those records on resume, because the match strategy finds them', async () => {
      injection = { operation: 'createRecord', failWriteNumber: 4, kind: 'fatal' };
      const run = await startMigration(['dtx_region'], 100);
      const orphaned = written.filter((w) => w.operation === 'createRecord').map((w) => w.id);
      expect(orphaned.length, 'something was orphaned to recover from').toBeGreaterThan(0);

      // Resume with nothing injected: the records written before the failure are in the target and
      // unknown to the platform, which is exactly the state that could produce duplicates.
      injection = {};
      written = [];
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);

      expect(resumed.status, 'the resumed attempt finished').toBe('COMPLETED');
      expect(resumed.attempt, 'and it is recorded as a second attempt of the same run').toBe(2);

      // The three orphans were re-examined and matched, not created again.
      const createdOnResume = written.filter((w) => w.operation === 'createRecord').length;
      const maps = await identityRows(run.id, 'dtx_region');
      const bySource = new Map(maps.map((m) => [m.sourceId, m]));
      expect(maps.length, 'every source record has exactly one identity row').toBe(bySource.size);

      // The target holds one record per source record: no duplicates from the orphaned window.
      const targets = new Set(maps.map((m) => m.targetId));
      expect(targets.size, 'one target record per source record').toBe(maps.length);
      // And the three orphans are the ones that were re-matched rather than re-created.
      expect(createdOnResume + orphaned.length, 'every record accounted for once').toBe(maps.length);
    }, 600_000);

    it('creates a duplicate when the target assigned the key and nothing can match it', async () => {
      /**
       * The case the test above does not cover, and the one that matters.
       *
       * Resume recovers the orphaned window by *re-matching*: the identity map has no row, so the
       * configured match strategy has to find the target record another way. With ids preserved it
       * matches on the record id, which is why the test above passes.
       *
       * Take that away — a target that assigns its own key, PRIMARY_ID as the strategy, and a table
       * with no unique key of its own — and there is nothing left to match on. The target record
       * carries a key the platform never recorded and the source id matches nothing, so resume
       * creates it a second time. Nothing in the platform notices.
       *
       * This test states the size of that gap. It is not here to be made to pass.
       */
      // Regions first, cleanly, so an office's lookup resolves and the only variable is the office.
      const regions = await startMigration(['dtx_region'], 100);
      expect(regions.status).toBe('COMPLETED');

      const factory = t.services.connections as unknown as {
        connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
      };
      const outer = factory.connectorFor.bind(factory);
      factory.connectorFor = async (...args: unknown[]) => {
        const conn = await outer(...args);
        if (String((args[0] as { id?: string })?.id ?? '') === uat.id) {
          // A target that will not take a client-supplied key: an identity column, or Dataverse
          // when no id is sent.
          conn['capabilities'] = {
            ...(conn['capabilities'] as object),
            supportsClientGeneratedIds: false,
          };
        }
        return conn;
      };

      // Offices have no alternate key, so nothing in the target refuses a second copy.
      injection = { operation: 'createRecord', failWriteNumber: 3, kind: 'fatal' };
      written = [];
      // The injected counter counts every write this test has made, so it starts again here.
      calls = { createRecord: 0, updateRecord: 0 };
      const run = await startMigration(['dtx_office'], 100, 'PRIMARY_ID');
      const orphaned = written.filter((w) => w.operation === 'createRecord').map((w) => w.id);
      expect(orphaned.length, 'records were written and not claimed').toBeGreaterThan(0);
      expect(await identityRows(run.id, 'dtx_office'), 'nothing was claimed').toHaveLength(0);
      const afterFirst = await targetCount('dtx_office');
      expect(afterFirst, 'the target holds what was written').toBe(orphaned.length);

      injection = {};
      written = [];
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);

      const maps = await identityRows(run.id, 'dtx_office');
      const targetsNow = await targetCount('dtx_office');
      const unaccounted = targetsNow - maps.filter((m) => m.targetId).length;

      // The gap, as a number. Every one of these is a record in the customer's target that the
      // platform has no row for, created a second time by a resume that could not tell.
      expect(
        unaccounted,
        `target holds ${targetsNow} office(s); the platform accounts for ${maps.filter((m) => m.targetId).length}`,
      ).toBe(orphaned.length);
      // And the run reports success, which is what makes it dangerous rather than merely wrong.
      expect(resumed.status).toBe('COMPLETED');
      expect(resumed.failed).toBe(0);
      // Internally the platform is perfectly consistent. That is the whole problem.
      expect(new Set(maps.map((m) => m.targetId)).size).toBe(maps.length);
    }, 900_000);

    it('keeps the arithmetic true across both attempts', async () => {
      injection = { operation: 'createRecord', failWriteNumber: 4, kind: 'fatal' };
      const run = await startMigration(['dtx_region'], 100);
      injection = {};
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);

      // The run's figures are the run's, not the last attempt's: a record created in attempt one and
      // matched in attempt two is one record, counted once.
      expect(accountedFor(resumed)).toBe(resumed.processed);
      expect(writtenByRun(resumed)).toBe(resumed.created + resumed.updated);
      const maps = await identityRows(run.id, 'dtx_region');
      expect(accountedFor(resumed), 'the counters agree with the identity map').toBe(maps.length);
      expect(resumed.failed, 'nothing is still failed after a clean resume').toBe(0);
    }, 600_000);
  });

  // -------------------------------------------------------------------------
  // Failure part-way through a multi-batch table
  // -------------------------------------------------------------------------
  describe('failure during a batched migration', () => {
    it('claims only what it wrote, and resumes from what is left', async () => {
      // account has enough records in the demo source to span several batches at this size.
      injection = { operation: 'createRecord', failWriteNumber: 12, kind: 'fatal' };
      const first = await startMigration(['account'], 5);
      expect(first.status).toBe('FAILED');

      const afterFirst = await identityRows(first.id, 'account');
      const writtenFirst = written.filter((w) => w.operation === 'createRecord').length;
      // Complete batches were persisted; the batch that failed was not.
      expect(afterFirst.length, 'only completed batches are claimed').toBeLessThan(writtenFirst);
      expect(afterFirst.length % 5, 'and they are whole batches').toBe(0);
      for (const row of afterFirst) {
        expect(row.targetId, 'a claimed record has a target identifier').toBeTruthy();
      }

      // What attempt one claimed, and what it wrote without claiming. The second group is the
      // orphaned window and resume is expected to touch it again; the first must be left alone.
      const claimed = new Set(afterFirst.map((m) => m.targetId));
      const orphaned = written
        .filter((w) => w.operation === 'createRecord' && !claimed.has(w.id))
        .map((w) => w.id);

      injection = {};
      written = [];
      await api.post(`/api/runs/${first.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${first.id}`);
      expect(resumed.status).toBe('COMPLETED');

      const maps = await identityRows(first.id, 'account');
      // Resume did not touch a single record attempt one had already claimed. Orphans it may
      // re-match and update; claimed records it must not read or write again.
      /**
       * The property is "not re-migrated", not "not touched".
       *
       * Resume must not create a claimed record again. It may well *write* to one: the second pass
       * fills in lookups that could not be resolved on the first visit, and that is an update to a
       * record this run already owns. Asserting the stronger property failed here for exactly that
       * reason, which is worth keeping in writing — the deferred pass is supposed to come back.
       */
      const recreatedClaimed = written.filter((w) => w.operation === 'createRecord' && claimed.has(w.id));
      expect(recreatedClaimed.length, 'no claimed record was created a second time').toBe(0);

      // The orphans were recovered by matching rather than created a second time.
      const recreated = written.filter((w) => w.operation === 'createRecord' && orphaned.includes(w.id));
      expect(recreated.length, 'no orphan was created twice').toBe(0);
      expect(new Set(maps.map((m) => m.sourceId)).size, 'one row per source record').toBe(maps.length);
      expect(new Set(maps.map((m) => m.targetId)).size, 'one target per source record').toBe(maps.length);
    }, 900_000);

    it('agrees with the audit trail about what happened', async () => {
      injection = { operation: 'createRecord', failWriteNumber: 8, kind: 'fatal' };
      const run = await startMigration(['account'], 5);
      injection = {};
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);

      const audit = await api.get<{ items: { action: string; outcome: string }[] }>('/api/audit?limit=500');
      const actions = audit.items.map((e) => e.action);
      expect(actions, 'the retry is in the trail').toContain('MIGRATION_RETRY_REQUESTED');
      expect(actions.filter((a) => a === 'MIGRATION_RETRY_REQUESTED').length, 'once, for one retry').toBe(1);
      // And the run that produced it is still one run, not two.
      expect(
        actions.filter((a) => a === 'MIGRATION_EXECUTION_REQUESTED').length,
        'one migration was requested, however many attempts it took',
      ).toBe(1);
    }, 900_000);
  });

  // -------------------------------------------------------------------------
  // Failure while updating records that were already there
  // -------------------------------------------------------------------------
  describe('failure during update', () => {
    it('does not turn unchanged records into updates, or update them twice', async () => {
      // First migration: clean, so the target holds records this run wrote.
      const first = await startMigration(['dtx_region'], 100, undefined, 'SYNC');
      expect(first.status).toBe('COMPLETED');
      expect(first.created).toBeGreaterThan(0);

      // Change one source record so a second run has something real to update.
      const { demoRecords } = await import('../../server/src/db/schema');
      const [one] = await t.services.db
        .select()
        .from(demoRecords)
        .where(
          and(
            eq(demoRecords.organizationId, organizationId),
            eq(demoRecords.environmentKey, 'demo-dev'),
            eq(demoRecords.logicalName, 'dtx_region'),
          ),
        )
        .limit(1);
      await t.services.db
        .update(demoRecords)
        .set({ data: { ...(one!.data as object), dtx_name: 'Renamed for chaos' } })
        // The source only. The same record id exists in every simulated environment, and changing
        // all of them would leave source and target matching again — which is how this test first
        // reported six unchanged records and nothing to interrupt.
        .where(
          and(
            eq(demoRecords.organizationId, organizationId),
            eq(demoRecords.environmentKey, 'demo-dev'),
            eq(demoRecords.recordId, one!.recordId),
          ),
        );

      // Second migration into the same target, failing during the update pass.
      injection = { operation: 'updateRecord', failWriteNumber: 1, kind: 'fatal' };
      written = [];
      calls = { createRecord: 0, updateRecord: 0 };
      // SKIP_EXISTING is the default and never updates anything, so there would be nothing to
      // interrupt. SYNC is the setting a second pass over a populated target actually uses.
      const second = await startMigration(['dtx_region'], 100, undefined, 'SYNC');
      expect(second.status).toBe('FAILED');
      expect(written.filter((w) => w.operation === 'updateRecord').length, 'nothing was updated').toBe(0);

      injection = {};
      written = [];
      await api.post(`/api/runs/${second.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${second.id}`);

      expect(resumed.status).toBe('COMPLETED');
      // Exactly one record changed, so exactly one update: the rest are unchanged, not re-written.
      expect(written.filter((w) => w.operation === 'updateRecord').length).toBe(1);
      expect(resumed.updated, 'one update').toBe(1);
      expect(resumed.created, 'nothing created: they were all already there').toBe(0);
      expect(resumed.unchanged, 'the others are unchanged, not falsely updated').toBe(resumed.processed - 1);
      expect(accountedFor(resumed)).toBe(resumed.processed);
    }, 900_000);
  });

  // -------------------------------------------------------------------------
  // The second pass, interrupted
  // -------------------------------------------------------------------------
  describe('failure during deferred relationship resolution', () => {
    /**
     * Regions point at offices and offices point at regions, so one direction cannot be written on
     * the first visit: whichever table goes first has nothing to point at yet. Those lookups are
     * deferred and a second pass comes back for them, which makes this the one place where a record
     * is correct, complete and *still* waiting for something.
     *
     * Interrupting that pass is interesting precisely because the base records are already right.
     */
    it('leaves base records correct and the unresolved lookups visibly unresolved', async () => {
      // Every write in the first pass is a create; the deferred pass is the first thing to update.
      injection = { operation: 'updateRecord', failWriteNumber: 1, kind: 'fatal' };
      const run = await startMigration(['dtx_region', 'dtx_office'], 100);

      expect(run.status, 'the run stopped in the second pass').toBe('FAILED');
      const maps = await identityRows(run.id);
      // The base records got there: the interruption was after them.
      expect(maps.length, 'both tables were migrated').toBeGreaterThan(0);
      expect(
        maps.every((m) => m.outcome !== 'FAILED'),
        'no record failed',
      ).toBe(true);
      expect(
        maps.every((m) => m.targetId),
        'every record has a target',
      ).toBe(true);

      // And the work that did not happen is still marked as outstanding, not quietly dropped.
      const pending = maps.filter((m) => m.deferredStatus === 'PENDING');
      expect(pending.length, 'the unresolved lookups are still pending').toBeGreaterThan(0);
      expect(
        pending.every((m) => Object.keys(m.deferredLookups ?? {}).length > 0),
        'and each one still names the columns it is waiting on',
      ).toBe(true);
    }, 600_000);

    it('resolves them on resume without disturbing what was already resolved', async () => {
      injection = { operation: 'updateRecord', failWriteNumber: 1, kind: 'fatal' };
      const run = await startMigration(['dtx_region', 'dtx_office'], 100);
      const before = await identityRows(run.id);
      const targetsBefore = new Map(before.map((m) => [m.sourceId, m.targetId]));
      const pendingBefore = before.filter((m) => m.deferredStatus === 'PENDING').map((m) => m.sourceId);
      expect(pendingBefore.length).toBeGreaterThan(0);

      injection = {};
      written = [];
      calls = { createRecord: 0, updateRecord: 0 };
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);

      expect(resumed.status).toBe('COMPLETED');
      const after = await identityRows(run.id);
      // Nothing was created again: the second attempt only had lookups left to write.
      expect(written.filter((w) => w.operation === 'createRecord').length, 'no new records').toBe(0);
      // Every record kept the target it already had.
      for (const row of after) {
        expect(row.targetId, `${row.sourceId} kept its target`).toBe(targetsBefore.get(row.sourceId));
      }
      // And nothing is still waiting.
      expect(
        after.filter((m) => m.deferredStatus === 'PENDING'),
        'every lookup resolved',
      ).toHaveLength(0);
      expect(accountedFor(resumed)).toBe(resumed.processed);
    }, 900_000);

    it('reports a lookup that can never resolve as unresolved rather than as resolved', async () => {
      // Interrupt the second pass, then make the pass itself impossible: the deferred lookups stay
      // visible as outstanding instead of being written off.
      injection = { operation: 'updateRecord', failWriteNumber: 1, kind: 'fatal' };
      const run = await startMigration(['dtx_region', 'dtx_office'], 100);
      const pending = (await identityRows(run.id)).filter((m) => m.deferredStatus === 'PENDING');
      expect(pending.length).toBeGreaterThan(0);

      // A second attempt that also cannot write.
      injection = { operation: 'updateRecord', failWriteNumber: 1, kind: 'fatal' };
      calls = { createRecord: 0, updateRecord: 0 };
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);

      const after = await identityRows(run.id);
      const stillPending = after.filter((m) => m.deferredStatus === 'PENDING');
      expect(stillPending.length, 'still outstanding, not marked done').toBe(pending.length);
      expect(
        stillPending.every((m) => m.deferredStatus !== 'RESOLVED'),
        'nothing claims to be resolved',
      ).toBe(true);
    }, 900_000);
  });

  // -------------------------------------------------------------------------
  // A transient failure, which is a different thing from a crash
  // -------------------------------------------------------------------------
  describe('transient connector failure', () => {
    /**
     * Where the retry lives, and what happens past it.
     *
     * Automatic retry is the connector's, not the engine's: the Dataverse connector honours
     * Retry-After and the simulated one throttles every 97th write to exercise it, which the rest of
     * the suite covers. This test injects the failure *outside* that boundary — a throttle the
     * connector's own retry never sees — which is the shape of a transient fault that outlasts the
     * retry budget. What matters then is not that it succeeded, but that failing was safe.
     */
    it('turns an unretried transient failure into a failed record, not a lost one', async () => {
      injection = { operation: 'createRecord', transientFailures: 2, kind: 'transient' };
      const run = await startMigration(['dtx_region'], 100);

      // The run completes and says plainly that some records did not make it.
      expect(run.status).toBe('COMPLETED_WITH_ERRORS');
      expect(run.failed, 'the failures are counted, not swallowed').toBeGreaterThan(0);
      const maps = await identityRows(run.id, 'dtx_region');
      expect(maps.length, 'every record has a row either way').toBe(run.processed);
      const failedRows = maps.filter((m) => m.outcome === 'FAILED');
      expect(failedRows.length).toBe(run.failed);
      // A failed record claims no target, which is what keeps the next attempt safe.
      expect(failedRows.every((m) => m.targetId === null)).toBe(true);
      // The error is retryable and recorded, so somebody can act on it.
      const errors = await api.get<{ items: { retryable: boolean; code: string }[] }>(
        `/api/runs/${run.id}/errors?limit=50`,
      );
      expect(errors.items.length).toBeGreaterThan(0);
      expect(
        errors.items.some((e) => e.retryable),
        'recorded as retryable',
      ).toBe(true);
    }, 300_000);

    it('recovers those records on retry without touching the ones that succeeded', async () => {
      injection = { operation: 'createRecord', transientFailures: 2, kind: 'transient' };
      const run = await startMigration(['dtx_region'], 100);
      const before = await identityRows(run.id, 'dtx_region');
      const succeeded = new Set(before.filter((m) => m.targetId).map((m) => m.targetId));

      injection = {};
      written = [];
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);

      expect(resumed.status).toBe('COMPLETED');
      expect(resumed.failed, 'nothing is still failed').toBe(0);
      expect(written.filter((w) => succeeded.has(w.id)).length, 'the successes were left alone').toBe(0);
      const after = await identityRows(run.id, 'dtx_region');
      expect(new Set(after.map((m) => m.targetId)).size, 'one target per record').toBe(after.length);
      expect(accountedFor(resumed)).toBe(resumed.processed);
    }, 600_000);
  });

  // -------------------------------------------------------------------------
  // Validation stopped in the middle
  // -------------------------------------------------------------------------
  describe('interrupted validation', () => {
    it('cannot report PASS for a validation that did not finish', async () => {
      const run = await startMigration(['dtx_region'], 100);
      expect(run.status).toBe('COMPLETED');

      // Fail the target read the comparison depends on, so validation cannot finish.
      const factory = t.services.connections as unknown as {
        connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
      };
      const original = factory.connectorFor.bind(factory);
      factory.connectorFor = async (...args: unknown[]) => {
        const conn = await original(...args);
        const inner = conn['countRecords'] as (...a: unknown[]) => Promise<unknown>;
        conn['countRecords'] = async (...a: unknown[]) => {
          if (String((args[0] as { id?: string })?.id ?? '') === uat.id) {
            throw new DataverseError('AUTH_REQUIRED', 'Injected failure during validation', 401);
          }
          return inner.apply(conn, a);
        };
        return conn;
      };

      const started = await api.post<ValidationRunDto>('/api/validations', {
        migrationRunId: run.id,
        depth: 'FULL',
      });
      await worker.drain(300_000);
      const report = await api.get<ValidationRunDto>(`/api/validations/${started.id}`);

      // An unfinished validation has a state of its own, and it is not PASS.
      expect(report.status, 'the state says it did not complete').not.toBe('COMPLETED');
      expect(report.outcome, 'and there is no verdict to read as a pass').not.toBe('PASS');
    }, 300_000);
  });
});
