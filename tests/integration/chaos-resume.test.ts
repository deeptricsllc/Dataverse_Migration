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
import { FINISHED_WITH_OMISSIONS, ApiClient, createTestApp, type TestApp } from '../helpers';

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
    it('leaves an intent row for every record it was about to write', async () => {
      /**
       * The window that used to be invisible.
       *
       * Target writes happen record by record; the identity map used to be written once per batch,
       * afterwards. A run that died between them left records in the customer's target that this
       * platform had no row for at all — and resume, seeing no row, created them again.
       *
       * Now an intent row exists before the write. It proves nothing about whether the write committed,
       * which is the point: it turns "no evidence" into "this record is in doubt".
       */
      injection = { operation: 'createRecord', failWriteNumber: 4, kind: 'fatal' };
      const run = await startMigration(['dtx_region'], 100);

      // An interrupted run says something is in doubt rather than "failed", because some of its writes
      // may have landed. Whether a retry can settle it is the retry gate's decision, not the status's.
      expect(run.status, 'the run stopped and says something is unsettled').toBe('NEEDS_RECONCILIATION');
      const created = written.filter((w) => w.operation === 'createRecord');
      expect(created.length, 'records reached the target before the failure').toBeGreaterThan(0);

      const maps = await identityRows(run.id, 'dtx_region');
      expect(maps.length, 'every record it was about to write has a row').toBeGreaterThan(0);
      const intents = maps.filter((m) => m.writeState === 'INTENDED' || m.writeState === 'CONFIRMED');
      expect(intents.length, 'and each row records whether we know what happened').toBe(maps.length);
      for (const row of maps) {
        expect(row.intendedOperation, 'the row says what the write was going to be').toBe('CREATE');
        expect(row.reconcileEvidence, 'and what could identify it afterwards').toBeTruthy();
      }
    }, 300_000);

    it('reconciles the intents on resume instead of writing them again', async () => {
      injection = { operation: 'createRecord', failWriteNumber: 4, kind: 'fatal' };
      const run = await startMigration(['dtx_region'], 100);
      const orphaned = written.filter((w) => w.operation === 'createRecord').map((w) => w.id);
      expect(orphaned.length, 'something was written without being confirmed').toBeGreaterThan(0);

      injection = {};
      written = [];
      calls = { createRecord: 0, updateRecord: 0 };
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);

      expect(resumed.status, 'the resumed attempt finished').toBe(FINISHED_WITH_OMISSIONS);
      expect(resumed.attempt, 'as a second attempt of the same run').toBe(2);
      expect(resumed.unresolved, 'with nothing left unresolved').toBe(0);

      const maps = await identityRows(run.id, 'dtx_region');
      expect(new Set(maps.map((m) => m.sourceId)).size, 'one row per source record').toBe(maps.length);
      expect(new Set(maps.map((m) => m.targetId)).size, 'one target per source record').toBe(maps.length);
      expect(
        maps.every((m) => m.writeState === 'CONFIRMED'),
        'and every one of them is confirmed',
      ).toBe(true);
      // The records the first attempt wrote were found, not created a second time.
      const recreated = written.filter((w) => w.operation === 'createRecord' && orphaned.includes(w.id));
      expect(recreated.length, 'nothing was created twice').toBe(0);
      const reconciled = maps.filter((m) => m.reconcileNote?.includes('did commit'));
      expect(reconciled.length, 'and the ones recovered say how they were found').toBeGreaterThan(0);
    }, 600_000);

    it('does not duplicate when the target assigned the key — it stops instead', async () => {
      /**
       * The P0, and what replaced it.
       *
       * With `PRIMARY_ID` matching against a target that assigns its own keys and a table with no unique
       * key, nothing can identify an orphaned record. This used to create it again and report COMPLETED
       * with zero failures. Now the run stops: the records are marked RECONCILIATION_REQUIRED, the run
       * is NEEDS_RECONCILIATION, and the target is left exactly as the failure left it.
       */
      const regions = await startMigration(['dtx_region'], 100);
      expect(regions.status).toBe(FINISHED_WITH_OMISSIONS);

      const factory = t.services.connections as unknown as {
        connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
      };
      const outer = factory.connectorFor.bind(factory);
      factory.connectorFor = async (...args: unknown[]) => {
        const conn = await outer(...args);
        if (String((args[0] as { id?: string })?.id ?? '') === uat.id) {
          conn['capabilities'] = {
            ...(conn['capabilities'] as object),
            supportsClientGeneratedIds: false,
          };
        }
        return conn;
      };

      injection = { operation: 'createRecord', failWriteNumber: 3, kind: 'fatal' };
      written = [];
      calls = { createRecord: 0, updateRecord: 0 };
      const run = await startMigration(['dtx_office'], 100, 'PRIMARY_ID');
      const orphaned = written.filter((w) => w.operation === 'createRecord').map((w) => w.id);
      expect(orphaned.length, 'records were written before the failure').toBeGreaterThan(0);
      const beforeResume = await targetCount('dtx_office');

      // The run refuses to finish, and refuses to be retried, rather than guessing.
      const stopped = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
      expect(stopped.status, 'neither completed nor failed').toBe('NEEDS_RECONCILIATION');
      expect(stopped.unresolved, 'and it says how many records are in doubt').toBeGreaterThan(0);

      const refused = await t.app.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/retry`,
        payload: {},
        headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
      });
      expect(refused.statusCode, 'a retry is refused while records are in doubt').toBe(409);
      expect(refused.body, 'and says why, and where the list is').toMatch(
        /reconciled by hand|could create a second copy/i,
      );

      // The platform names exactly what a person has to look at.
      const awaiting = await api.get<{
        total: number;
        items: { logicalName: string; sourceId: string; evidence: string; note: string | null }[];
      }>(`/api/runs/${run.id}/reconciliation`);
      expect(awaiting.total, 'the records are listed').toBeGreaterThan(0);
      for (const item of awaiting.items) {
        expect(item.evidence, 'each one says why it cannot be resolved automatically').toBe('NONE');
      }

      // And the target was not touched again: no duplicate, which is the whole point.
      const afterStopping = await targetCount('dtx_office');
      expect(afterStopping, 'not one record was created a second time').toBe(beforeResume);
      expect(written.filter((w) => w.operation === 'createRecord').length).toBe(orphaned.length);

      // --- a person looks, and says what they found -------------------------
      /**
       * What the manual drill does, done here against the simulated target's own storage.
       *
       * Not "assume they are all there": the awaiting list contains both records the first attempt wrote
       * and records it never reached, and telling them apart is exactly the work that cannot be
       * automated. Each source record's name is read from the source and looked for in the target, which
       * is what somebody with a SQL console would do.
       */
      injection = {};
      written = [];
      calls = { createRecord: 0, updateRecord: 0 };
      const { demoRecords: demo } = await import('../../server/src/db/schema');
      const sourceRows = await t.services.db
        .select()
        .from(demo)
        .where(
          and(
            eq(demo.organizationId, organizationId),
            eq(demo.environmentKey, 'demo-dev'),
            eq(demo.logicalName, 'dtx_office'),
          ),
        );
      const targetRows = await t.services.db
        .select()
        .from(demo)
        .where(
          and(
            eq(demo.organizationId, organizationId),
            eq(demo.environmentKey, 'demo-uat'),
            eq(demo.logicalName, 'dtx_office'),
          ),
        );
      const resolutions = awaiting.items.map((item) => {
        const source = sourceRows.find((r) => r.recordId.toLowerCase() === item.sourceId.toLowerCase());
        const name = (source?.data as { dtx_name?: string } | undefined)?.dtx_name;
        const inTarget = targetRows.find(
          (r) => (r.data as { dtx_name?: string }).dtx_name === name && name !== undefined,
        );
        return inTarget
          ? {
              logicalName: item.logicalName,
              sourceId: item.sourceId,
              found: 'PRESENT' as const,
              targetId: inTarget.recordId,
              note: `Queried the target directly and found one record named ${name}.`,
            }
          : {
              logicalName: item.logicalName,
              sourceId: item.sourceId,
              found: 'ABSENT' as const,
              note: `Queried the target directly; no record named ${name ?? '(unknown)'} is there.`,
            };
      });
      expect(
        resolutions.filter((r) => r.found === 'PRESENT').length,
        'some of the records in doubt really were written',
      ).toBe(orphaned.length);
      await api.post(`/api/runs/${run.id}/reconcile`, { resolutions });
      const settled = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
      expect(settled.unresolved, 'nothing is in doubt any more').toBe(0);
      expect(settled.status, 'and the run is retryable again').not.toBe('NEEDS_RECONCILIATION');

      // --- and then it finishes --------------------------------------------
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);
      const finished = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
      expect(finished.status).toBe('COMPLETED');
      expect(finished.unresolved).toBe(0);

      const maps = await identityRows(run.id, 'dtx_office');
      expect(new Set(maps.map((m) => m.targetId)).size, 'one target record per source record').toBe(
        maps.length,
      );
      const finalCount = await targetCount('dtx_office');
      expect(finalCount, 'the target holds exactly one record per source record').toBe(maps.length);
    }, 900_000);

    it('keeps the arithmetic true across both attempts', async () => {
      injection = { operation: 'createRecord', failWriteNumber: 4, kind: 'fatal' };
      const run = await startMigration(['dtx_region'], 100);
      injection = {};
      calls = { createRecord: 0, updateRecord: 0 };
      await api.post(`/api/runs/${run.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);

      // The run's figures are the run's, not the last attempt's, and the six outcomes still add up.
      expect(accountedFor(resumed)).toBe(resumed.processed);
      expect(writtenByRun(resumed)).toBe(resumed.created + resumed.updated);
      const maps = await identityRows(run.id, 'dtx_region');
      expect(accountedFor(resumed), 'the counters agree with the identity map').toBe(maps.length);
      expect(resumed.failed, 'nothing is still failed after a clean resume').toBe(0);
      expect(resumed.unresolved, 'and nothing is still unresolved').toBe(0);
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
      expect(first.status, 'something is in doubt after an interruption').toBe('NEEDS_RECONCILIATION');

      const afterFirst = await identityRows(first.id, 'account');
      const writtenFirst = written.filter((w) => w.operation === 'createRecord').length;
      /**
       * Every record the run touched has a row, and each row says whether we know what happened to it.
       *
       * This used to assert that only *whole batches* were claimed, because the identity map was written
       * once per batch and the in-flight batch left nothing at all. The intent rows are the change: the
       * batch that was interrupted is now described rather than invisible.
       */
      const confirmed = afterFirst.filter((m) => m.writeState === 'CONFIRMED');
      const inDoubt = afterFirst.filter((m) => m.writeState === 'INTENDED');
      expect(confirmed.length, 'the writes that completed are confirmed').toBeGreaterThan(0);
      expect(confirmed.length + inDoubt.length, 'and every row is one or the other').toBe(afterFirst.length);
      expect(confirmed.length, 'no more confirmed than actually reached the target').toBeLessThanOrEqual(
        writtenFirst,
      );
      for (const row of confirmed) {
        expect(row.targetId, 'a confirmed record has a target identifier').toBeTruthy();
      }
      for (const row of inDoubt) {
        expect(row.outcome, 'a record in doubt is counted as neither written nor failed').toBe('UNRESOLVED');
      }

      // What attempt one claimed, and what it wrote without claiming. The second group is the
      // orphaned window and resume is expected to touch it again; the first must be left alone.
      const claimed = new Set(confirmed.map((m) => m.targetId));
      const orphaned = written
        .filter((w) => w.operation === 'createRecord' && !claimed.has(w.id))
        .map((w) => w.id);

      injection = {};
      written = [];
      await api.post(`/api/runs/${first.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${first.id}`);
      expect(resumed.status).toBe(FINISHED_WITH_OMISSIONS);

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
      expect(first.status).toBe(FINISHED_WITH_OMISSIONS);
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
      expect(second.status, 'the interrupted update leaves the record in doubt').toBe('NEEDS_RECONCILIATION');
      expect(written.filter((w) => w.operation === 'updateRecord').length, 'nothing was updated').toBe(0);

      injection = {};
      written = [];
      await api.post(`/api/runs/${second.id}/retry`, {});
      await worker.drain(300_000);
      const resumed = await api.get<MigrationRunDto>(`/api/runs/${second.id}`);

      expect(resumed.status).toBe(FINISHED_WITH_OMISSIONS);
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

      // The deferred pass only issues updates, which are idempotent, so nothing it leaves behind is in
      // doubt: this is a plain failure and a plain retry.
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

      expect(resumed.status).toBe(FINISHED_WITH_OMISSIONS);
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
      expect(run.status).toBe(FINISHED_WITH_OMISSIONS);

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
