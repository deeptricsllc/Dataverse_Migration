import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ProjectDto,
  RunFailureSummaryDto,
} from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Deliberate failures, caused the way a real migration causes them.
 *
 * Nothing here is a fixture. Each scenario is a configuration a person could build — a child table without
 * its parent, a target that refuses the account, a field mapped onto a column that cannot hold it — and the
 * failures are whatever the engine and the target actually produce. A failure experience proved against
 * invented error rows proves that the UI renders, which is not the thing in doubt.
 *
 * What is asserted is the evidence a consultant needs: which dataset, which cause, how many, whether
 * another attempt could succeed, and whether anything was written.
 */
describe('failures the engine actually produces', () => {
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
  });
  afterAll(async () => {
    await t?.close();
  });

  const migrate = async (name: string, tables: string[], target = uat) => {
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `${name} ${Date.now()}`,
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: target.id,
    });
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: target.id,
      projectId: project.id,
      tables,
    });
    return { project, plan };
  };

  const execute = async (plan: MigrationPlanDto, expectStatus = 200) => {
    const current = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const run = await api.post<MigrationRunDto>(
      `/api/plans/${plan.id}/execute`,
      {
        confirmSourceName: current.sourceEnvironment.displayName,
        confirmTargetName: current.targetEnvironment.displayName,
        acknowledgeWarnings: true,
      },
      expectStatus,
    );
    if (expectStatus !== 200) return run;
    const worker = t.services.createWorker();
    await worker.drain(180_000);
    await worker.stop();
    return api.get<MigrationRunDto>(`/api/runs/${run.id}`);
  };

  const failures = (runId: string) => api.get<RunFailureSummaryDto>(`/api/runs/${runId}/failures`);

  /**
   * A child table without its parent.
   *
   * The most common real failure in a migration: somebody migrates Contacts before Accounts, and every
   * lookup has nothing to point at. The engine records it per record, with the table that was missing.
   */
  it('records an unresolved lookup when the referenced table is not in scope', async () => {
    const { plan } = await migrate('Contacts without accounts', ['contact']);
    const run = await execute(plan);

    const summary = await failures(run.id);
    expect(summary.runId).toBe(run.id);
    const contacts = summary.datasets.find((d) => d.logicalName === 'contact')!;
    expect(contacts.attempted).toBeGreaterThan(0);

    /*
     * Either the lookups were left unresolved as a deferred reference, or the records failed outright.
     * Both are legitimate engine behaviour; what must be true is that nothing claims a clean result.
     */
    const lookup = [...contacts.categories, ...contacts.warnings].find((c) => c.code.startsWith('LOOKUP'));
    expect(lookup, 'the cause is recorded, not inferred').toBeTruthy();
    expect(lookup!.label, 'a code this product defines gets a label').not.toBe(lookup!.code);
    expect(lookup!.meaning).toBeTruthy();
    expect(lookup!.action).toBeTruthy();
    expect(lookup!.records).toBeGreaterThan(0);

    /*
     * The finding that made this scenario worth running.
     *
     * Every contact was written, so the run is COMPLETED with zero failures — which is true. Three
     * hundred of them lost the reference to the account they belonged to, and the engine recorded each
     * one. A report that showed only failures would describe this run as clean, and somebody would sign
     * it off. The warnings are counted separately and are never folded into the failure total.
     */
    expect(contacts.warnings.length, 'dropped references are reported').toBeGreaterThan(0);
    expect(summary.warnings).toBeGreaterThan(0);
    expect(summary.failed, 'a warning is not a failure').toBe(0);
    // The run's own total and the per-dataset totals describe the same records.
    const totalFailed = summary.datasets.reduce((n, d) => n + d.failed, 0);
    expect(totalFailed).toBe(summary.failed);
  });

  /**
   * A target that refuses the account.
   *
   * This is a run-level failure, not a record-level one, and the difference matters: no record was
   * attempted, so a failure count of zero is the truth and the run still must not read as a success.
   */
  it('refuses to build a migration against a target that will not answer', async () => {
    const envs = await api.get<EnvironmentDto[]>('/api/environments');
    const refusing = envs.find((e) => e.displayName === 'DeepTrics Production');
    if (!refusing) return;

    const project = await api.post<ProjectDto>('/api/projects', {
      name: `Into a refusing target ${Date.now()}`,
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: refusing.id,
    });

    /*
     * The failure happens earlier than a run: building the configuration reads the target's schema, and a
     * target that refuses the account cannot be read. That is the right place for it to fail — there is
     * nothing to plan against — and the message is the one the target gave rather than a generic refusal.
     */
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/plans',
      payload: {
        sourceEnvironmentId: dev.id,
        targetEnvironmentId: refusing.id,
        projectId: project.id,
        tables: ['dtx_region'],
      } as never,
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(403);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('DATAVERSE_FORBIDDEN');
    expect(error.message).toContain('not a member of the organization');

    // And no run exists, because nothing was ever started.
    const runs = await api.get<{ id: string }[]>(`/api/projects/${project.id}/migration/runs`);
    expect(runs).toHaveLength(0);
  });

  /** A clean run still produces evidence, and the summary says there is nothing to review. */
  it('reports a clean run as having no failed records', async () => {
    // A table with no outbound lookups, so nothing can be left behind.
    const { plan } = await migrate('Clean run', ['dtx_applicationconfig']);
    const run = await execute(plan);

    const summary = await failures(run.id);
    expect(summary.failed).toBe(0);
    expect(summary.retryable).toBe(0);
    expect(summary.permanent).toBe(0);
    const region = summary.datasets.find((d) => d.logicalName === 'dtx_applicationconfig')!;
    expect(region.categories).toHaveLength(0);
    expect(region.warnings, 'a clean run carried everything across').toHaveLength(0);
    expect(region.written).toBe(region.attempted);
    expect(region.omittedReferences, 'and nothing was left behind').toBe(0);
    // Counting the run as complete requires that nothing is in doubt.
    expect(summary.unresolved).toBe(0);

    /*
     * And it is still reported as clean.
     *
     * The failure mode of an outcome model that counts omitted references is a product that calls every
     * run degraded, which teaches people the result line is noise. A dataset with no outbound lookups has
     * nothing to omit, and says so.
     */
    expect(run.omittedReferences).toBe(0);
    expect(run.status).toBe('COMPLETED');
    expect(run.entities.find((e) => e.logicalName === 'dtx_applicationconfig')!.deferredIncomplete).toBe(0);
  });

  /**
   * Unresolved is not failed.
   *
   * The distinction the whole duplicate-prevention model rests on: a record the engine could not account
   * for is neither a success nor a failure, and the summary keeps the two apart.
   */
  it('keeps unresolved records out of the failed count', async () => {
    const { plan } = await migrate('Accounts and contacts', ['account', 'contact']);
    const run = await execute(plan);
    const summary = await failures(run.id);

    for (const dataset of summary.datasets) {
      /*
       * Every record a dataset attempted is in exactly one of these columns. A table a reader cannot add
       * up is a table they check against something else, and the row read "4 attempted, 2 written" with
       * nothing accounting for the other two.
       */
      expect(
        dataset.written + dataset.alreadyCurrent + dataset.failed + dataset.skipped + dataset.unresolved,
      ).toBe(dataset.attempted);
      // A dataset never reports more failures than the records it tried.
      expect(dataset.failed).toBeLessThanOrEqual(dataset.attempted);
    }
    expect(summary.unresolved).toBe(run.unresolved);
    expect(summary.failed).toBe(run.failed);
  });

  /** Retryable is the engine's classification, recorded when the failure happened. */
  it('splits failures into retryable and permanent from what was recorded', async () => {
    const { plan } = await migrate('Classification', ['contact']);
    const run = await execute(plan);
    const summary = await failures(run.id);

    expect(summary.retryable + summary.permanent).toBe(
      summary.datasets.reduce((n, d) => n + d.categories.reduce((m, c) => m + c.records, 0), 0),
    );
    for (const dataset of summary.datasets) {
      for (const category of dataset.categories) {
        expect(typeof category.retryable).toBe('boolean');
      }
    }
  });
});
