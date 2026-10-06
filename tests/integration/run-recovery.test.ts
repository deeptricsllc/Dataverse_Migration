import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  EnvironmentDto,
  MigrationErrorDto,
  MigrationPlanDto,
  MigrationRunDto,
  ProjectDto,
  RetrySafetyDto,
  RunFailureSummaryDto,
  RunRecordDetailDto,
} from '../../shared/domain';
import { correctionFor } from '../../shared/failure-categories';
import { demoRecords, migrationRecordMaps } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Failure, then fix, then proof that the fix worked.
 *
 * A recovery that cannot be demonstrated is not a recovery. This walks the whole path a consultant walks,
 * through the product's own API at every step: a run that loses records, the screens that say which records
 * and why, the place the product sends them to fix it, the fix, a second attempt, and then the two questions
 * that matter afterwards — is the outcome better, and is there exactly one record in the target for each
 * record in the source.
 *
 * Nothing is injected. The failure is the most common mistake in a real migration: migrating a child table
 * before its parent. Offices are used rather than contacts because an office's region is a *required*
 * reference, so the records fail outright and a further attempt genuinely writes them. A contact's parent
 * account is optional, so the contact is written without it and no further attempt of that run will ever
 * set it — a different outcome with a different fix, proved in `run-outcome.test.ts`.
 */
describe('a failure can be fixed, and the fix can be proved', () => {
  let t: TestApp;
  let api: ApiClient;
  let organizationId: string;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  let plan: MigrationPlanDto;
  let first: MigrationRunDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  const drain = async () => {
    const worker = t.services.createWorker();
    await worker.drain(300_000);
    await worker.stop();
  };
  const execute = async (planId: string) => {
    const current = await api.get<MigrationPlanDto>(`/api/plans/${planId}`);
    const started = await api.post<MigrationRunDto>(`/api/plans/${planId}/execute`, {
      confirmSourceName: current.sourceEnvironment.displayName,
      confirmTargetName: current.targetEnvironment.displayName,
      acknowledgeWarnings: true,
    });
    await drain();
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };
  const targetRecords = async (table: string) =>
    t.services.db
      .select({ recordId: demoRecords.recordId })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-uat'),
          eq(demoRecords.logicalName, table),
        ),
      );
  const sourceRecords = async (table: string) =>
    t.services.db
      .select({ recordId: demoRecords.recordId })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.organizationId, organizationId),
          eq(demoRecords.environmentKey, 'demo-dev'),
          eq(demoRecords.logicalName, table),
        ),
      );

  /**
   * Steps 1 and 2: a run that writes every record and does not carry the data across, reported as such.
   */
  it('1–2: runs, and reports that it did not carry the data across', async () => {
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `Recovery ${Date.now()}`,
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      projectId: project.id,
      tables: ['dtx_office'],
    });
    first = await execute(plan.id);

    // Every office needs a region, and no region is in the target. Not one record lands.
    expect(first.failed, 'the records are not in the target').toBeGreaterThan(0);
    expect(first.created + first.updated).toBe(0);
    expect(first.status).toBe('COMPLETED_WITH_ERRORS');
  }, 900_000);

  /** Step 3: which dataset, which cause, how many — without reading a log. */
  it('3: names the dataset, the cause and the count', async () => {
    const summary = await api.get<RunFailureSummaryDto>(`/api/runs/${first.id}/failures`);
    const offices = summary.datasets.find((d) => d.logicalName === 'dtx_office')!;
    const cause = offices.categories.find((c) => c.code === 'LOOKUP_UNRESOLVED')!;
    expect(cause.label).toBe('Lookup not resolved');
    expect(cause.meaning).toBe('The referenced record does not exist in the target.');
    expect(cause.records).toBeGreaterThan(0);
    expect(cause.field, 'and the field it could not set').toBe('dtx_regionid');
    expect(cause.retryable, 'another attempt can succeed, because nothing was written').toBe(true);
  });

  /** Step 4: one record, with the evidence the engine recorded about it. */
  it('4: opens one record and shows what was recorded about it', async () => {
    const page = await api.get<{ items: MigrationErrorDto[] }>(
      `/api/runs/${first.id}/errors?code=LOOKUP_UNRESOLVED&limit=1`,
    );
    const error = page.items[0]!;
    const detail = await api.get<RunRecordDetailDto>(
      `/api/runs/${first.id}/records/${error.entity}/${encodeURIComponent(error.sourceRecordId!)}`,
    );
    expect(detail.outcome).toBe('FAILED');
    expect(detail.targetId, 'the record is not in the target').toBeNull();
    expect(detail.errors.some((e) => e.errorCode === 'LOOKUP_UNRESOLVED')).toBe(true);
    expect(detail.evidence.find((e) => e.label === 'Source record')!.value).toBe(error.sourceRecordId);
    expect(detail.runAttempt).toBe(1);
    // The field the failure names is evidence in its own right, even with no value recorded for it.
    expect(detail.evidence.some((e) => e.field === 'dtx_regionid')).toBe(true);
  });

  /** Step 5: the product names where this is fixed, and it is a place that changes the outcome. */
  it('5: sends the reader to the datasets, which is what fixes it', () => {
    const correction = correctionFor('LOOKUP_UNRESOLVED')!;
    expect(correction.target).toBe('SOURCE_DATA');
    expect(correction.label).toBe('Add the referenced table');
  });

  /**
   * Step 6: the correction, made through the API the screen uses.
   *
   * And the constraint it runs into, which is worth stating because it decides what step 8 can be. A run
   * holds an immutable copy of the plan taken when it started, so that a migration stays reproducible and a
   * later plan edit cannot rewrite what an earlier run did. Adding a dataset therefore does not add it to
   * the run that already finished: carrying it needs a new run of the corrected plan. A further attempt of
   * the old run still helps, because once the referenced records are in the target its lookups resolve —
   * which is what steps 8 to 10 demonstrate.
   */
  it('6: adds the referenced dataset to the migration, and runs it', async () => {
    const updated = await api.put<MigrationPlanDto>(`/api/plans/${plan.id}/tables`, {
      tables: ['dtx_region', 'dtx_office'],
    });
    expect(updated.entities.map((e) => e.logicalName).sort()).toEqual(['dtx_office', 'dtx_region']);

    /*
     * And a run of the corrected configuration, which is what carries the new dataset. A run holds an
     * immutable copy of the plan taken when it started — so that a migration stays reproducible and a later
     * plan edit cannot rewrite what an earlier run did — which means the regions reach the target through a
     * new run rather than through a further attempt of the old one.
     */
    const corrected = await execute(plan.id);
    expect(corrected.id, 'a new run, not the old one').not.toBe(first.id);
    expect(corrected.failed, 'and this one carries both datasets').toBe(0);
    expect(corrected.status).toBe('COMPLETED');
  }, 900_000);

  /** Step 7: the retry is reassessed against the configuration as it is now. */
  it('7: reassesses whether another attempt is safe, and how much it would do', async () => {
    const safety = await api.get<RetrySafetyDto>(`/api/runs/${first.id}/retry-safety`);
    expect(safety.state).toBe('SAFE_TO_RETRY');
    expect(safety.allowed).toBe(true);
    expect(safety.safe, 'the failed offices, which another attempt can now write').toBeGreaterThan(0);
    expect(safety.needsReconciliation).toBe(0);
    expect(safety.reason).toContain('Attempt 2');
    expect(safety.reason).toContain(safety.safe.toLocaleString());
  });

  /**
   * Steps 8, 9 and 10: a second attempt of the run that failed, and a better outcome.
   *
   * The regions are in the target now. So this attempt — working from the same offices-only snapshot it
   * always had — resolves the reference it could not resolve the first time and writes the records it lost,
   * which is exactly what "another attempt can succeed" was recorded to mean.
   */
  it('8–10: runs a second attempt and reaches a better outcome', async () => {
    const lostBefore = first.failed;
    await api.post(`/api/runs/${first.id}/retry`, {});
    await drain();
    const second = await api.get<MigrationRunDto>(`/api/runs/${first.id}`);

    expect(second.attempt, 'the same run, a further attempt').toBe(2);
    expect(second.failed, 'fewer records are missing than before').toBeLessThan(lostBefore);
    expect(second.failed, 'and in this case none are').toBe(0);
    /*
     * The records are accounted for, and not by this attempt creating them: the corrected run put the
     * offices in the target first, so this attempt finds and matches them. Which is the right behaviour and
     * the whole reason a retry is safe — two runs covering the same records leave one record each, not two.
     */
    expect(second.created + second.updated + second.unchanged + second.skipped).toBe(second.total);
    expect(second.status).toBe('COMPLETED');
  }, 900_000);

  /**
   * Step 11: the first attempt is still there.
   *
   * A retry that rewrote the history of the attempt before it would destroy the only account of what the
   * first one did. Somebody auditing a migration a month later is reading exactly this.
   */
  it('11: preserves what the first attempt did', async () => {
    const lineage = await api.get<{
      attempt: number;
      attempts: {
        attempt: number | null;
        recordsWithProblems: number | null;
        created: number;
        failed: number;
        unresolved: number;
      }[];
      someRecordsPredateAttemptTracking: boolean;
    }>(`/api/runs/${first.id}/attempts`);

    expect(lineage.attempt).toBe(2);
    const one = lineage.attempts.find((a) => a.attempt === 1);
    expect(one, 'attempt 1 is still in the history').toBeTruthy();

    /*
     * What attempt 1 recorded, which attempt 2 cannot overwrite.
     *
     * The outcome columns tell a different story: the identity map holds one row per record, so every
     * office attempt 1 lost now belongs to attempt 2, and attempt 1's created and failed counts read as
     * zero. That is the design — each record belongs to exactly one attempt, so the attempts sum to the run
     * without counting anything twice — and the reason attempt 1 does not simply vanish from the history is
     * the problems it recorded at the time.
     */
    expect(one!.recordsWithProblems, 'and what it found at the time').toBeGreaterThan(0);

    /*
     * The failures of the first attempt are still attributed to it, which is what the recorded attempt on
     * each error row is for. A history that attributed everything to the current attempt would describe
     * the second attempt's state as though it had always been true.
     */
    const history = await api.get<{ total: number }>(
      `/api/runs/${first.id}/errors?attempt=1&includeResolved=true`,
    );
    expect(history.total, 'the failures attempt 1 recorded are still attributed to it').toBeGreaterThan(0);

    /*
     * And they no longer count as outstanding, which is the other half of being honest about them. A
     * failure the next attempt fixed is history, so the default view — what is wrong with this run now —
     * does not list it, and asking for the history is how it is read.
     */
    const outstanding = await api.get<{ total: number }>(`/api/runs/${first.id}/errors?attempt=1`);
    expect(outstanding.total, 'but none of them are still outstanding').toBe(0);
  });

  /**
   * Step 12: exactly one record in the target for each record in the source.
   *
   * The question the whole exercise exists to answer, counted in the target's own storage rather than
   * through the product's report. A report that agrees with itself is not evidence.
   */
  it('12: leaves exactly one target record per source record, with no duplicates', async () => {
    for (const table of ['dtx_region', 'dtx_office']) {
      const source = await sourceRecords(table);
      const target = await targetRecords(table);
      expect(target.length, `${table}: one target record per source record`).toBe(source.length);
      expect(new Set(target.map((r) => r.recordId)).size, `${table}: no duplicates`).toBe(target.length);
    }

    // And the identity map holds exactly one row per source record, with no record claimed twice.
    const maps = await t.services.db
      .select({ logicalName: migrationRecordMaps.logicalName, sourceId: migrationRecordMaps.sourceId })
      .from(migrationRecordMaps)
      .where(eq(migrationRecordMaps.runId, first.id));
    const keys = maps.map((m) => `${m.logicalName}:${m.sourceId}`);
    expect(new Set(keys).size, 'one identity row per source record').toBe(keys.length);
  }, 300_000);
});
