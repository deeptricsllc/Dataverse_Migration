import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto, RetrySafetyDto } from '../../shared/domain';
import { DataverseError } from '../../server/src/dataverse/errors';
import { demoRecords, migrationRecordMaps } from '../../server/src/db/schema';
import { ApiClient, createTestApp, FINISHED_WITH_OMISSIONS, type TestApp } from '../helpers';

/**
 * Whether running it again is safe, and the way out when it is not.
 *
 * A retry is the one action in this product that can put a second copy of a customer's record in their
 * target. So the question is answered before the control is offered, the answer is exact about what the
 * next attempt would act on, and in the state where repeating a write could duplicate a record there is no
 * control at all — and the server refuses it regardless of what any page shows.
 *
 * The dangerous state is produced the way it happens: the target commits a record and the answer is lost,
 * to a target that assigns its own keys, so nothing in it can identify the record afterwards. Nothing here
 * is a fixture.
 */
describe('whether another attempt is safe', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let organizationId: string;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  let injectLostAnswerOnCall: number | null = null;
  let calls = 0;

  beforeEach(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    injectLostAnswerOnCall = null;
    calls = 0;

    const factory = t.services.connections as unknown as {
      connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const original = factory.connectorFor.bind(factory);
    factory.connectorFor = async (...args: unknown[]) => {
      const conn = await original(...args);
      if (String((args[0] as { id?: string })?.id ?? '') !== uat.id) return conn;
      /*
       * A target that assigns its own keys. With no client-generated id and no alternate key, a record
       * whose answer was lost cannot be found again by asking — which is what makes the retry unsafe
       * rather than merely uncertain.
       */
      conn['capabilities'] = { ...(conn['capabilities'] as object), supportsClientGeneratedIds: false };
      const create = conn['createRecord'] as (...a: unknown[]) => Promise<string>;
      conn['createRecord'] = async (...a: unknown[]) => {
        /*
         * Which call this is, captured before the write rather than read after it. The engine writes four
         * records at a time, so by the time an await resolves the shared counter has moved on — and a
         * condition checked afterwards fires for whichever call happens to be last, or for none.
         */
        const n = ++calls;
        const fire = injectLostAnswerOnCall !== null && n === injectLostAnswerOnCall;
        const id = await create.apply(conn, a);
        // The record is in the target. The answer never arrives.
        if (fire) {
          throw new DataverseError('TIMEOUT', 'Injected: the target committed and the answer was lost', 408);
        }
        return id;
      };
      return conn;
    };
  }, 120_000);

  afterEach(async () => {
    await worker.stop();
    await t?.close();
  });

  const migrate = async (tables: string[]) => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Retry safety ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables,
    });
    const full = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    for (const e of full.entities) {
      await api.patch(`/api/plans/${plan.id}/entities/${e.id}`, {
        matchStrategy: 'PRIMARY_ID',
        alternateKey: null,
      });
    }
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(300_000);
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };

  const safety = (runId: string) => api.get<RetrySafetyDto>(`/api/runs/${runId}/retry-safety`);
  const rows = (runId: string, table: string) =>
    t.services.db
      .select()
      .from(migrationRecordMaps)
      .where(and(eq(migrationRecordMaps.runId, runId), eq(migrationRecordMaps.logicalName, table)));
  const targetCount = async (table: string) =>
    (
      await t.services.db
        .select({ recordId: demoRecords.recordId })
        .from(demoRecords)
        .where(
          and(
            eq(demoRecords.organizationId, organizationId),
            eq(demoRecords.environmentKey, 'demo-uat'),
            eq(demoRecords.logicalName, table),
          ),
        )
    ).length;

  /**
   * A run that carried everything has nothing to retry, and that is not the same as being unsafe.
   *
   * The two must read differently. A product that said "retry blocked" about a clean run would teach
   * people that the words mean nothing.
   */
  it('says there is nothing to retry rather than that a retry is unsafe', async () => {
    const run = await migrate(['dtx_applicationconfig']);
    expect(run.status).toBe('COMPLETED');
    const s = await safety(run.id);
    expect(s.state).toBe('NOTHING_TO_RETRY');
    expect(s.allowed).toBe(false);
    expect(s.safe).toBe(0);
    expect(s.needsReconciliation).toBe(0);
  });

  /**
   * A retry is not offered for records a retry cannot change.
   *
   * These regions are in the target without their head office, because `dtx_office` is not in the plan. The
   * records are written, so a further attempt reads the source again, matches each region and leaves it
   * alone — the reference stays empty however many attempts are made. The engine used to record this warning
   * as able to succeed on another attempt, which reached this assessment and promised work that would not
   * happen.
   *
   * So the answer is that nothing is waiting, and the records are listed as excluded with the correction
   * that does work: migrate the referenced dataset, then run a migration that updates records that match.
   */
  it('does not offer an attempt that would match every record and change nothing', async () => {
    const run = await migrate(['dtx_region']);
    expect(run.status).toBe(FINISHED_WITH_OMISSIONS);
    expect(run.omittedReferences).toBeGreaterThan(0);

    const s = await safety(run.id);
    expect(s.state).toBe('NOTHING_TO_RETRY');
    expect(s.allowed).toBe(false);
    expect(s.safe).toBe(0);
    expect(s.needsReconciliation).toBe(0);
    const omitted = s.excluded.find((e) => e.reason.includes('without a reference the source gave them'))!;
    expect(omitted, 'the records are accounted for, not silently dropped from the assessment').toBeTruthy();
    expect(omitted.records).toBe(run.omittedReferences);
    expect(omitted.reason, 'and the correction that does work is named').toContain(
      'updates records that already match',
    );

    // And the server refuses it, so the two cannot disagree about what is available.
    const refused = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/retry`,
      payload: {},
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(refused.statusCode).toBe(409);
  });

  /**
   * And it is offered, with an exact count, for records an attempt can write.
   *
   * Offices without regions fail outright — the reference is required, so nothing is written — and that is
   * the case another attempt genuinely fixes once the regions are there.
   */
  it('states exactly how many records the next attempt would act on', async () => {
    const run = await migrate(['dtx_office']);
    expect(run.failed, 'the records are not in the target').toBeGreaterThan(0);
    const s = await safety(run.id);
    expect(s.state).toBe('SAFE_TO_RETRY');
    expect(s.allowed).toBe(true);
    expect(s.attempt).toBe(run.attempt);
    expect(s.safe, 'the records the next attempt acts on').toBe(run.failed);
    expect(s.reason).toContain(`Attempt ${run.attempt + 1}`);
    expect(s.reason).toContain(s.safe.toLocaleString());
    expect(s.needsReconciliation).toBe(0);
  });

  /**
   * The eight steps, in order, over a record that may be in the target with nothing to identify it.
   *
   * This is the proof that the recovery path works, not a test that the components render.
   */
  it('refuses the retry, reconciles by identity, then allows only what is proven safe', async () => {
    // Regions first, so an office's required region lookup resolves.
    await migrate(['dtx_region']);

    // 1. A write that committed and whose answer was lost.
    injectLostAnswerOnCall = 2;
    calls = 0;
    const run = await migrate(['dtx_office']);
    const inTargetAfterCrash = await targetCount('dtx_office');

    // 2. The run is unresolved, not complete and not failed.
    expect(run.status).toBe('NEEDS_RECONCILIATION');
    expect(run.unresolved).toBeGreaterThan(0);
    expect(run.failed, 'an unknown result is not a failure').toBe(0);

    // 3. A retry is not offered, and the assessment says why in terms of the records.
    const blocked = await safety(run.id);
    expect(blocked.state).toBe('RECONCILE_FIRST');
    expect(blocked.allowed, 'no control is offered').toBe(false);
    expect(blocked.needsReconciliation).toBeGreaterThan(0);
    expect(blocked.reason).toContain('Another attempt would write them again');
    expect(blocked.excluded.some((e) => e.reason.includes('Somebody has to look'))).toBe(true);

    // 4. And the server refuses it, whatever a page might show.
    const refused = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/retry`,
      payload: {},
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(refused.statusCode).toBe(409);
    expect(await targetCount('dtx_office'), 'not one record written again').toBe(inTargetAfterCrash);

    // 5. The reconciliation workspace names the records and what would identify each one.
    const outstanding = await api.get<{
      total: number;
      items: { logicalName: string; sourceId: string; evidence: string | null; writeState: string }[];
    }>(`/api/runs/${run.id}/reconciliation`);
    expect(outstanding.total).toBeGreaterThan(0);
    const record = outstanding.items[0]!;
    expect(record.evidence, 'nothing identifies it, which is why a person is needed').toBe('NONE');

    /*
     * 6. Somebody looks and cannot tell. The record stays unresolved, the note is kept, and the retry
     *    stays refused — because the thing that made it dangerous is still true.
     */
    await api.post(`/api/runs/${run.id}/reconcile`, {
      resolutions: [
        {
          logicalName: record.logicalName,
          sourceId: record.sourceId,
          found: 'UNCLEAR',
          note: 'Searched the target by name and city. Two candidates, neither conclusive.',
        },
      ],
    });
    const stillBlocked = await safety(run.id);
    expect(stillBlocked.state, 'an inconclusive look settles nothing').toBe('RECONCILE_FIRST');
    expect(stillBlocked.allowed).toBe(false);
    const afterUnclear = (await rows(run.id, 'dtx_office')).find((r) => r.sourceId === record.sourceId)!;
    expect(afterUnclear.writeState, 'the record is still in doubt').not.toBe('CONFIRMED');
    expect(afterUnclear.reconcileNote, 'and what they saw is kept').toContain('could not tell');

    // 7. Then somebody finds it, with the identifier it has in the target.
    const inTarget = await t.services.db
      .select({ recordId: demoRecords.recordId })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, 'dtx_office'),
        ),
      );
    for (const item of outstanding.items) {
      await api.post(`/api/runs/${run.id}/reconcile`, {
        resolutions: [
          {
            logicalName: item.logicalName,
            sourceId: item.sourceId,
            found: 'PRESENT',
            targetId: inTarget[0]!.recordId,
            note: 'Found in the target by its name and city, and the identifier recorded.',
          },
        ],
      });
    }

    // 8. Only now is a retry allowed, and the evidence of the first look is still there.
    const settled = await safety(run.id);
    expect(settled.needsReconciliation).toBe(0);
    expect(settled.state).not.toBe('RECONCILE_FIRST');
    const final = (await rows(run.id, 'dtx_office')).find((r) => r.sourceId === record.sourceId)!;
    expect(final.writeState).toBe('CONFIRMED');
    expect(final.targetId).toBeTruthy();
    expect(final.reconcileNote, 'the account of how it was settled is kept').toContain('Found in the target');
  }, 900_000);

  /**
   * More than one match is a finding, not an answer.
   *
   * A duplicate is already in the target. Nothing here can decide which record is the right one, so the
   * record stays unresolved and the retry stays refused.
   */
  it('leaves a record unresolved when more than one target record matches', async () => {
    await migrate(['dtx_region']);
    injectLostAnswerOnCall = 2;
    calls = 0;
    const run = await migrate(['dtx_office']);
    expect(run.status).toBe('NEEDS_RECONCILIATION');

    const outstanding = await api.get<{ items: { logicalName: string; sourceId: string }[] }>(
      `/api/runs/${run.id}/reconciliation`,
    );
    const record = outstanding.items[0]!;
    await api.post(`/api/runs/${run.id}/reconcile`, {
      resolutions: [
        {
          logicalName: record.logicalName,
          sourceId: record.sourceId,
          found: 'MULTIPLE',
          note: 'Two offices in the target with this name and city. Which one is correct is not clear.',
        },
      ],
    });

    const s = await safety(run.id);
    expect(s.state).toBe('RECONCILE_FIRST');
    expect(s.allowed).toBe(false);
    const row = (await rows(run.id, 'dtx_office')).find((r) => r.sourceId === record.sourceId)!;
    expect(row.writeState, 'not promoted to confirmed').not.toBe('CONFIRMED');
    expect(row.targetId, 'and no target record is claimed').toBeNull();
    expect(row.reconcileNote).toContain('More than one matching record');
  }, 900_000);

  /** A record reported as present without the identifier it has in the target is refused. */
  it('refuses a present record with no target identifier', async () => {
    await migrate(['dtx_region']);
    injectLostAnswerOnCall = 2;
    calls = 0;
    const run = await migrate(['dtx_office']);
    const outstanding = await api.get<{ items: { logicalName: string; sourceId: string }[] }>(
      `/api/runs/${run.id}/reconciliation`,
    );
    const record = outstanding.items[0]!;
    /*
     * Without the identifier the identity map has nothing to point at, so the next attempt would write the
     * record again — the duplicate the whole protocol exists to prevent.
     */
    await api.post(
      `/api/runs/${run.id}/reconcile`,
      {
        resolutions: [
          {
            logicalName: record.logicalName,
            sourceId: record.sourceId,
            found: 'PRESENT',
            note: 'I am sure I saw it there somewhere.',
          },
        ],
      },
      400,
    );
  }, 900_000);
});
