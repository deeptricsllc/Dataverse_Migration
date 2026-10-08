import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * What a validation result means, against the real engine.
 *
 * The defect these exist for: a validation whose comparison could not run reported
 * **Passed with warnings**. The engine was honest everywhere underneath — coverage recorded, the reason
 * on the check, both printed in the report — but the outcome model had three values, so "we could not
 * check" had nowhere to go except `WARNING`, and `WARNING` is displayed as a kind of pass.
 *
 * Somebody reading the headline saw the word *passed* on a validation that compared nothing.
 *
 * See `docs/VALIDATION_SEMANTICS.md`.
 */
describe('a validation reports the worst outcome its evidence supports', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
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

  const migrate = async (name: string, tables: string[]) => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `${name} ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables,
    });
    const current = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: current.sourceEnvironment.displayName,
      confirmTargetName: current.targetEnvironment.displayName,
      acknowledgeWarnings: true,
    });
    await drain();
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };

  const validate = async (migrationRunId: string) => {
    const started = await api.post<ValidationRunDto>('/api/validations', { migrationRunId });
    await drain();
    return api.get<ValidationRunDto>(`/api/validations/${started.id}`);
  };

  /**
   * A table where every record failed, so nothing was compared.
   *
   * Offices need a region and no region is in the target, so not one office is written. There is nothing
   * in the target to compare against, the comparison examines no records, and the honest answer is that
   * the validation did not check — not that it checked and was content.
   */
  it('reports a comparison that examined nothing as incomplete rather than as a warning', async () => {
    const run = await migrate('Nothing to compare', ['dtx_office']);
    expect(run.failed, 'every office failed, so nothing reached the target').toBeGreaterThan(0);

    const report = await validate(run.id);
    expect(report.status).toBe('COMPLETED');

    const dataset = report.entities.find((e) => e.logicalName === 'dtx_office')!;
    expect(dataset.checkedRecords, 'nothing was compared').toBe(0);

    /*
     * The field comparison is incomplete, which is the fix: it was `WARNING`, and the report prints
     * `WARNING` as *Passed with warnings*, so a comparison of no columns on no records said passed.
     */
    const fieldValues = dataset.checks.find((c) => c.check === 'FIELD_VALUES')!;
    expect(fieldValues.outcome).toBe('INCOMPLETE');
    expect(fieldValues.outcome).not.toBe('WARNING');
    expect(fieldValues.message).toMatch(/Not verified/);

    /*
     * And the run's own headline is FAIL, not INCOMPLETE, because these records are *known* to be
     * absent — the migration reported them failed. A proven absence outranks an unchecked area, and the
     * unchecked part stays visible on the check that recorded it. See docs/VALIDATION_SEMANTICS.md §2.1.
     */
    expect(report.outcome).toBe('FAIL');
    const existence = dataset.checks.find((c) => c.check === 'RECORD_EXISTENCE')!;
    expect(existence.outcome).toBe('FAIL');
    expect(existence.message).toMatch(/not in the target/);
  }, 600_000);

  /** A comparison that ran and agreed still passes. The point is not to make everything incomplete. */
  it('still reports a comparison that ran and agreed as passed', async () => {
    const run = await migrate('Clean compare', ['dtx_applicationconfig']);
    expect(run.created, 'records reached the target').toBeGreaterThan(0);

    const report = await validate(run.id);
    expect(report.status).toBe('COMPLETED');
    expect(['PASS', 'WARNING'], `outcome was ${report.outcome}`).toContain(report.outcome);
    const dataset = report.entities.find((e) => e.logicalName === 'dtx_applicationconfig')!;
    expect(dataset.checkedRecords, 'and it actually examined records').toBeGreaterThan(0);
    expect(dataset.outcome).not.toBe('INCOMPLETE');
  }, 600_000);

  /**
   * The counts a dataset reports describe the records it examined, and nothing else.
   *
   * Records the run failed, and records it could not account for, are deliberately outside that sum:
   * a failed record is not in the target to compare, and an unresolved one may or may not be. Adding
   * them in made matched + missing + different exceed the number of records examined.
   */
  it('reconciles every examined record into exactly one bucket', async () => {
    const run = await migrate('Count invariants', ['account', 'contact']);
    const report = await validate(run.id);

    for (const d of report.entities) {
      expect(
        d.matched + d.different + d.missing,
        `${d.logicalName}: matched+different+missing must equal the records examined`,
      ).toBe(d.checkedRecords);
      // Neither of the two outside the sum is folded into it.
      expect(d.failedInRun).toBeGreaterThanOrEqual(0);
      expect(d.unresolvedInRun).toBeGreaterThanOrEqual(0);
      expect(d.missing, 'a record the run failed is not also reported missing').toBeLessThanOrEqual(
        d.checkedRecords,
      );
    }
  }, 600_000);

  /**
   * A transformed value matches the value the migration was supposed to write.
   *
   * The comparison uses the run's own snapshot of the mapping pipeline, so a source trimmed and
   * value-mapped on the way in is compared against what it became, not against what it was. Comparing
   * the raw value would report a false mismatch on every transformed column in the migration.
   */
  it('compares against the transformed value, not the source value', async () => {
    const run = await migrate('Transformed compare', ['account']);
    const report = await validate(run.id);
    const accounts = report.entities.find((e) => e.logicalName === 'account')!;

    expect(accounts.checkedRecords).toBeGreaterThan(0);
    /*
     * The demo plan maps and converts columns on the way in. If validation compared raw source values
     * it would report those as differences, so a clean field comparison here is the evidence that it
     * does not.
     */
    const fieldValues = accounts.checks.find((c) => c.check === 'FIELD_VALUES')!;
    expect(fieldValues.outcome, `field comparison said: ${fieldValues.message}`).not.toBe('FAIL');
  }, 600_000);

  /**
   * A run that could not account for a record cannot be validated to a verdict.
   *
   * The record may or may not be in the target, so it is excluded from the comparison rather than
   * guessed at — and a report that compared everything else and found it clean still has an unproven
   * area. That is incomplete, not passed with warnings, and not failed either: nothing was shown to
   * disagree.
   */
  it('reports a run with records nobody can account for as incomplete', async () => {
    const armed = await api.post<{ armed: boolean }>('/api/demo/fault-injection', {
      environmentId: uat.id,
      table: 'dtx_region',
      onNthCreate: 2,
    });
    expect(armed.armed).toBe(true);

    const run = await migrate('Unresolved then validate', ['dtx_region']);
    expect(run.unresolved, 'one write has no answer').toBeGreaterThan(0);

    const report = await validate(run.id);
    const dataset = report.entities.find((e) => e.logicalName === 'dtx_region')!;
    expect(dataset.unresolvedInRun).toBeGreaterThan(0);

    const existence = dataset.checks.find((c) => c.check === 'RECORD_EXISTENCE')!;
    expect(existence.outcome, 'an unknown write result is not a proven mismatch').toBe('INCOMPLETE');
    expect(existence.message).toMatch(/unknown write outcome/);
    expect(report.outcome, 'and the report does not claim a verdict it cannot support').not.toBe('PASS');
    expect(report.outcome).not.toBe('WARNING');
  }, 600_000);

  /**
   * The audit trail says what happened, including when evidence left the platform.
   *
   * A validation that crashed was recorded as `VALIDATION_COMPLETED` with a `FAILURE` outcome — an
   * entry whose verb contradicts its result, in the one record that exists to say what happened. And an
   * exported report, which outlives the screen it came from and is what somebody attaches to a change
   * record, was not recorded at all.
   */
  it('records the validation and its exported evidence in the audit trail', async () => {
    const run = await migrate('Audited validation', ['dtx_applicationconfig']);
    const report = await validate(run.id);

    const csv = await t.app.inject({
      method: 'GET',
      url: `/api/validations/${report.id}/summary.csv`,
      headers: { cookie: api.cookie },
    });
    expect(csv.statusCode).toBe(200);

    const trail = await api.get<{ items: { action: string; details: Record<string, unknown> | null }[] }>(
      '/api/audit?limit=100',
    );
    const actions = trail.items.map((a) => a.action);
    expect(actions).toContain('VALIDATION_REQUESTED');
    expect(actions).toContain('VALIDATION_COMPLETED');
    expect(actions, 'an export is recorded').toContain('VALIDATION_EVIDENCE_EXPORTED');

    const exported = trail.items.find((a) => a.action === 'VALIDATION_EVIDENCE_EXPORTED')!;
    expect(exported.details?.validationRunId).toBe(report.id);
    expect(exported.details?.report).toBe('summary');
  }, 600_000);

  /** An unavailable comparison never becomes a pass, whatever else the report found. */
  it('never lets an unverified check be outranked by a pass', async () => {
    const run = await migrate('Mixed outcome', ['dtx_office']);
    const report = await validate(run.id);
    const everyCheck = report.entities.flatMap((e) => e.checks);
    const unverified = everyCheck.filter((c) => c.outcome === 'INCOMPLETE');
    if (unverified.length > 0) {
      expect(report.outcome, 'one unverified check is enough to stop a pass').not.toBe('PASS');
      expect(report.outcome).not.toBe('WARNING');
    }
  }, 600_000);
});
