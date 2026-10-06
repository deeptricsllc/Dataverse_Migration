import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationErrorDto,
  MigrationPlanDto,
  MigrationRunDto,
  RetrySafetyDto,
  RunFailureSummaryDto,
  RunRecordDetailDto,
} from '../../shared/domain';
import { DataverseError } from '../../server/src/dataverse/errors';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The failure classes a migration actually produces, each caused on purpose.
 *
 * Every scenario here is either a configuration a person could build or a refusal a target could give, and
 * the failure is whatever the engine and the target do about it. Nothing is a hand-made error row: a failure
 * experience proved against invented data proves the components render, which is not the thing in doubt.
 *
 * Where the product **prevents** a class of failure before a run exists, that is recorded as the outcome
 * rather than worked around. A failure that cannot happen is better than a failure that is reported well.
 */
describe('the failure classes a migration produces', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let organizationId: string;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  /** Set to make the target refuse the next write outright, the way a real validation rule does. */
  let refuseWrites = 0;

  beforeEach(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    refuseWrites = 0;

    /*
     * A target that refuses records, injected at the connector.
     *
     * This exists for one scenario only: a definite refusal from the target, which no configuration of a
     * simulated target produces because the simulation has no duplicate-detection or business rules. It is
     * test-only, deterministic, and the refusal travels the real execution path — the engine classifies it,
     * records it and reports it exactly as it would a refusal from a real Dataverse.
     */
    const factory = t.services.connections as unknown as {
      connectorFor: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const original = factory.connectorFor.bind(factory);
    factory.connectorFor = async (...args: unknown[]) => {
      const conn = await original(...args);
      if (String((args[0] as { id?: string })?.id ?? '') !== uat.id) return conn;
      const create = conn['createRecord'] as (...a: unknown[]) => Promise<string>;
      conn['createRecord'] = async (...a: unknown[]) => {
        if (refuseWrites > 0) {
          refuseWrites--;
          throw new DataverseError(
            'DUPLICATE_RECORD',
            'A record with this name already exists. Duplicate detection rule: Accounts with the same name.',
            400,
          );
        }
        return create.apply(conn, a);
      };
      return conn;
    };
  }, 120_000);

  afterEach(async () => {
    await worker.stop();
    await t?.close();
  });

  const plan = async (tables: string[]) =>
    api.post<MigrationPlanDto>('/api/plans', {
      name: `Injection ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables,
    });
  const execute = async (planId: string, expectStatus = 200) => {
    const current = await api.get<MigrationPlanDto>(`/api/plans/${planId}`);
    const started = await api.post<MigrationRunDto>(
      `/api/plans/${planId}/execute`,
      {
        confirmSourceName: current.sourceEnvironment.displayName,
        confirmTargetName: current.targetEnvironment.displayName,
        acknowledgeWarnings: true,
      },
      expectStatus,
    );
    if (expectStatus !== 200) return started;
    await worker.drain(300_000);
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };
  const failures = (runId: string) => api.get<RunFailureSummaryDto>(`/api/runs/${runId}/failures`);
  const errors = (runId: string, query = '') =>
    api.get<{ items: MigrationErrorDto[]; total: number }>(`/api/runs/${runId}/errors${query}`);

  /**
   * A. A value that cannot become what the target column holds.
   *
   * An office's name mapped onto its headcount: text into a number. The interesting question is not how the
   * failure reads but whether it is allowed to become a run at all — and it is not. The mapping is refused
   * when it is made, naming both columns and both types:
   *
   *     Cannot map dtx_name to dtx_headcount: String cannot be converted to Integer
   *
   * **Prevented before execution**, which is a better outcome than a well-reported failure: nobody starts a
   * migration, nothing is written, and the person is told at the moment they made the decision rather than
   * an hour into a run. The branches below exist because the product's answer is what is under test, not an
   * assumption about it, and a weaker answer would still have to be a stated one.
   */
  it('A: a value that cannot convert into the target column', async () => {
    const created = await plan(['dtx_office']);
    const full = await api.get<MigrationPlanDto>(`/api/plans/${created.id}`);
    const entity = full.entities.find((e) => e.logicalName === 'dtx_office')!;
    const { mappings } = await api.get<{
      mappings: { id: string; sourceField: string; targetField: string | null }[];
    }>(`/api/plans/${created.id}/entities/${entity.id}/mappings`);
    const name = mappings.find((m) => m.sourceField === 'dtx_name')!;
    expect(name, 'the office name is a mapped source column').toBeTruthy();

    // Point the office's name at the headcount column: text into a number.
    const response = await t.app.inject({
      method: 'PATCH',
      url: `/api/plans/${created.id}/mappings/${name.id}`,
      payload: { action: 'MAP', targetField: 'dtx_headcount' } as never,
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });

    /*
     * Whatever the product does here, it must not be silent. Either the mapping is refused, or the plan
     * reports it as a blocker, or the records fail with the conversion named. All three are acceptable; a
     * run that reports a clean result is not.
     */
    if (response.statusCode >= 400) {
      // Prevented before execution, and the message names the conversion rather than the field alone.
      const message = (response.json() as { error: { message: string } }).error.message;
      expect(message).toContain('dtx_name');
      expect(message).toContain('dtx_headcount');
      expect(message, 'and which conversion is impossible').toMatch(/cannot be converted/i);

      // And the plan is unchanged, so nothing could be run against a mapping that was refused.
      const unchanged = await api.get<{
        mappings: { sourceField: string; targetField: string | null }[];
      }>(`/api/plans/${created.id}/entities/${entity.id}/mappings`);
      expect(unchanged.mappings.find((m) => m.sourceField === 'dtx_name')!.targetField).not.toBe(
        'dtx_headcount',
      );
      return;
    }

    const afterMapping = await api.get<MigrationPlanDto>(`/api/plans/${created.id}`);
    const blocker = afterMapping.issues.find((i) => i.severity === 'BLOCKER');
    if (blocker) {
      // Also prevented before execution: the plan will not run until the mapping is corrected.
      expect(afterMapping.blockerCount).toBeGreaterThan(0);
      await execute(created.id, 409);
      return;
    }

    // Otherwise it reaches the engine, and every record that cannot convert is reported as failed.
    const run = await execute(created.id);
    expect(run.status).not.toBe('COMPLETED');
    const summary = await failures(run.id);
    expect(summary.failed + summary.warnings, 'the conversion is reported, not swallowed').toBeGreaterThan(0);
  }, 900_000);

  /**
   * B and D. Two source records that claim the same identity, which is a permanent failure.
   *
   * Matching on a business key and then giving two source records the same value for it. No number of
   * attempts resolves this: the source data has to change, or the key has to. So it is also the proof that
   * a permanent failure is reported as permanent, and excluded from a retry.
   */
  it('B/D: two source records with the same identity key fail permanently', async () => {
    // Two offices with the same name, which is what the business key will be built on.
    await t.services.db.insert(demoRecords).values(
      ['dup-office-1', 'dup-office-2'].map((id) => ({
        organizationId,
        environmentKey: 'demo-dev',
        logicalName: 'dtx_office',
        recordId: id,
        data: { dtx_officeid: id, dtx_name: 'Duplicate Office', dtx_city: 'Leeds', dtx_headcount: 11 },
      })),
    );

    const created = await plan(['dtx_office']);
    const full = await api.get<MigrationPlanDto>(`/api/plans/${created.id}`);
    const entity = full.entities.find((e) => e.logicalName === 'dtx_office')!;
    await api.patch(`/api/plans/${created.id}/entities/${entity.id}`, {
      matchStrategy: 'BUSINESS_KEY',
      businessKeyFields: ['dtx_name'],
      alternateKey: null,
    });

    const run = await execute(created.id);
    expect(run.failed, 'the second record claiming the identity is not written').toBeGreaterThan(0);

    const summary = await failures(run.id);
    const duplicate = summary.datasets
      .flatMap((d) => d.categories)
      .find((c) => c.code === 'DUPLICATE_SOURCE_KEY')!;
    expect(duplicate, 'the cause is recorded as its own category').toBeTruthy();
    expect(duplicate.label).toBe('Duplicate identity key in the source');
    expect(duplicate.retryable, 'no further attempt resolves it').toBe(false);
    expect(summary.permanent).toBeGreaterThan(0);

    /*
     * And the record it names is the one that lost. Which record wins is the engine's business; which one
     * failed, and why, is what a consultant has to be able to read.
     */
    const page = await errors(run.id, '?code=DUPLICATE_SOURCE_KEY');
    const failed = page.items[0]!;
    expect(failed.sourceRecordId).toBeTruthy();
    expect(failed.message).toContain('same key');
    const detail = await api.get<RunRecordDetailDto>(
      `/api/runs/${run.id}/records/${failed.entity}/${encodeURIComponent(failed.sourceRecordId!)}`,
    );
    expect(detail.outcome).toBe('FAILED');
    expect(detail.targetId, 'and it is not in the target').toBeNull();

    /*
     * And the retry assessment says what another attempt would do about it.
     *
     * Not "excluded": the attempt does read this record again and write it again, and gets the same refusal
     * unless the source data or the key changed in between — which is exactly what somebody does between
     * attempts. Listing it as excluded produced a card that said it would act on three records directly
     * above three excluded, which was the same three records in contradictory sentences.
     */
    const safety = await api.get<RetrySafetyDto>(`/api/runs/${run.id}/retry-safety`);
    expect(safety.safe, 'the record is one an attempt acts on').toBeGreaterThan(0);
    expect(safety.reason, 'with the caution that it will be refused again').toMatch(
      /another attempt repeats unless the source or the configuration has changed/,
    );
    expect(
      safety.excluded.some((e) => e.reason.includes('unable to succeed')),
      'and it is not also counted as untouched',
    ).toBe(false);
  }, 900_000);

  /**
   * D. A definite refusal from the target.
   *
   * The other permanent failure, and the one that comes from outside the product. A duplicate-detection rule
   * refusing a record is a clear "no" — the record is not in the target, nothing is in doubt, and another
   * attempt gets the same answer.
   */
  it('D: a target that refuses a record reports a permanent failure, not an unknown one', async () => {
    refuseWrites = 2;
    const created = await plan(['dtx_region']);
    const run = await execute(created.id);

    expect(run.failed, 'the refused records are failures').toBe(2);
    expect(run.unresolved, 'and not in doubt: the target answered').toBe(0);

    const summary = await failures(run.id);
    const refusal = summary.datasets
      .flatMap((d) => d.categories)
      .find((c) => c.code.startsWith('DUPLICATE_RECORD'))!;
    expect(refusal, 'the target’s own code is the category').toBeTruthy();
    expect(refusal.retryable, 'a refusal is not a transient failure').toBe(false);

    /*
     * The message the target gave, kept word for word. The product's own wording explains the category; only
     * this text can say which rule refused the record, and paraphrasing it loses the part somebody searches
     * the target's documentation for.
     */
    const page = await errors(run.id, '?kind=permanent');
    const error = page.items.find((e) => e.errorCode.startsWith('DUPLICATE_RECORD'))!;
    expect(error.message).toContain('Duplicate detection rule');
    expect(error.httpStatus, 'and what the target answered with').toBe(400);
  }, 900_000);

  /**
   * E. A transient failure, which another attempt does resolve.
   *
   * The counterpart to the two above, and the distinction the retry assessment rests on. A region that is
   * not in the target yet is a required reference an office cannot resolve — nothing is written, and the next
   * attempt writes it once the regions are there.
   */
  it('E: a reference that is not in the target yet is retryable', async () => {
    const created = await plan(['dtx_office']);
    const run = await execute(created.id);

    expect(run.failed).toBeGreaterThan(0);
    const summary = await failures(run.id);
    const lookup = summary.datasets.flatMap((d) => d.categories).find((c) => c.code === 'LOOKUP_UNRESOLVED')!;
    expect(lookup.retryable, 'nothing was written, so another attempt can write it').toBe(true);
    expect(summary.retryable).toBeGreaterThan(0);
    expect(summary.permanent).toBe(0);

    const safety = await api.get<RetrySafetyDto>(`/api/runs/${run.id}/retry-safety`);
    expect(safety.state).toBe('SAFE_TO_RETRY');
    expect(safety.safe).toBe(run.failed);
  }, 900_000);
});
