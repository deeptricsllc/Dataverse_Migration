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
 * What a run's result means.
 *
 * Its own file, with its own target, because the thing under test is what the *first* migration of a
 * table reports. A second migration of the same records finds them already there and writes nothing,
 * which is a different scenario — asserted at the end of this file, because it is also a real one.
 *
 * The run this exists for: three hundred contacts into a target with no accounts in it. Every write
 * succeeded, the engine recorded every dropped parent reference, and the run reported
 * `Completed · Succeeded 300 · Failed 0`. Accurate in every number and wrong as a statement about the
 * migration. See `docs/MIGRATION_OUTCOME_SEMANTICS.md`.
 */
describe('a run reports the worst outcome its evidence supports', () => {
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

  const migrate = async (name: string, tables: string[]) => {
    const project = await api.post<ProjectDto>('/api/projects', {
      name: `${name} ${Date.now()}`,
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
    });
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      projectId: project.id,
      tables,
    });
    const current = await api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: current.sourceEnvironment.displayName,
      confirmTargetName: current.targetEnvironment.displayName,
      acknowledgeWarnings: true,
    });
    const worker = t.services.createWorker();
    await worker.drain(180_000);
    await worker.stop();
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };

  /**
   * The run that this gate turned on.
   *
   * Contacts without the accounts they belong to. Nothing is injected and nothing is stubbed: this is a
   * configuration a person builds by migrating a child table first, which is the most common mistake in
   * a real migration.
   */
  it('reports a run that wrote every record and dropped their references as completed with warnings', async () => {
    const run = await migrate('Contacts without accounts', ['contact']);

    // The transport succeeded, in every number the old result line was built from.
    expect(run.failed, 'no record failed').toBe(0);
    expect(run.unresolved, 'nothing is in doubt').toBe(0);
    expect(run.created + run.updated, 'every contact was written').toBeGreaterThan(0);
    expect(run.created + run.updated).toBe(run.total);

    // And the outcome says what happened to the data, which is not the same thing.
    expect(run.omittedReferences, 'the dropped references are counted').toBeGreaterThan(0);
    expect(run.status).toBe('COMPLETED_WITH_WARNINGS');

    // The failure summary reads different tables and must not disagree with the result line.
    const summary = await api.get<RunFailureSummaryDto>(`/api/runs/${run.id}/failures`);
    expect(summary.failed, 'an omitted reference is not a failure').toBe(0);
    expect(summary.warnings).toBeGreaterThan(0);
    const contacts = summary.datasets.find((d) => d.logicalName === 'contact')!;
    expect(contacts.warnings.some((w) => w.code.startsWith('LOOKUP'))).toBe(true);

    /*
     * The consequence that matters more than the label: the plan is not finished. The next person reads
     * `EXECUTED` as the work being done, and this run did not carry the data across.
     */
    const plan = await api.get<MigrationPlanDto>(`/api/plans/${run.planId}`);
    expect(plan.status, 'a plan that lost references is not executed').not.toBe('EXECUTED');

    /*
     * And it is retryable, which is why the status exists rather than being a relabelled `COMPLETED`. The
     * way out is to add the missing dataset and run again; a refusal here would leave a fresh migration
     * over data already in the target as the only route forward.
     */
    const retried = await api.post<MigrationRunDto>(`/api/runs/${run.id}/retry`, {});
    expect(retried.attempt).toBe(run.attempt + 1);

    /*
     * Attempt 2 runs here rather than being left queued, because one migration at a time per target is
     * enforced and a queued attempt would block everything after it. That rule is the reason this is
     * drained and not abandoned.
     */
    const second = t.services.createWorker();
    await second.drain(180_000);
    await second.stop();
    const after = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    expect(after.attempt, 'the attempt that ran is the one the retry created').toBe(2);
    /*
     * And it is still incomplete, because nothing was fixed between the attempts. A retry of the same
     * configuration against the same target cannot find the accounts that are still not there, and the
     * product does not report a better outcome for having tried twice.
     */
    expect(after.status).toBe('COMPLETED_WITH_WARNINGS');
    expect(after.omittedReferences).toBeGreaterThan(0);
  });

  /**
   * A run with nothing to omit still reads as clean.
   *
   * The failure mode of an outcome model that counts omitted references is a product that calls every run
   * degraded, which teaches people the result line is noise.
   */
  it('reports a run with nothing to omit as completed', async () => {
    const run = await migrate('Nothing to omit', ['dtx_applicationconfig']);
    expect(run.omittedReferences).toBe(0);
    expect(run.failed).toBe(0);
    expect(run.status).toBe('COMPLETED');
    const plan = await api.get<MigrationPlanDto>(`/api/plans/${run.planId}`);
    expect(plan.status).toBe('EXECUTED');
  });

  /**
   * The fix, and the proof it worked.
   *
   * Migrating accounts alongside contacts gives every parent reference something to point at. This is the
   * corrective action the failure screen names, carried out against a target that has not seen either
   * table, with the outcome compared against the run that did not have it.
   */
  it('carries the references once the referenced dataset is in scope', async () => {
    /*
     * Its own deployment, because the comparison has to be between two *first* migrations. Re-migrating
     * contacts into a target that already holds them matches every record and writes nothing, so a
     * before-and-after inside one target would be comparing a write against a match.
     */
    const fresh = await createTestApp();
    try {
      const freshApi = new ApiClient(fresh.app);
      await freshApi.demoLogin();
      const envs = await freshApi.post<EnvironmentDto[]>('/api/environments/discover');
      const s = envs.find((e) => e.displayName === 'DeepTrics Development')!;
      const tgt = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
      const project = await freshApi.post<ProjectDto>('/api/projects', {
        name: `Accounts and contacts ${Date.now()}`,
        kind: 'MIGRATION',
        sourceEnvironmentId: s.id,
        targetEnvironmentId: tgt.id,
      });
      const plan = await freshApi.post<MigrationPlanDto>('/api/plans', {
        sourceEnvironmentId: s.id,
        targetEnvironmentId: tgt.id,
        projectId: project.id,
        /*
         * The whole chain, because fixing one omission reveals the next.
         *
         * Adding `account` carries every contact's parent reference and then drops each account's
         * `dtx_regionid`, because `dtx_region` is not in scope either — and `dtx_region` points at
         * `dtx_office`. That is the product working: it names the next thing that was not carried across
         * rather than reporting a clean result once the first one is dealt with.
         */
        tables: ['dtx_office', 'dtx_region', 'account', 'contact'],
      });
      const current = await freshApi.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
      const started = await freshApi.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
        confirmSourceName: current.sourceEnvironment.displayName,
        confirmTargetName: current.targetEnvironment.displayName,
        acknowledgeWarnings: true,
      });
      const worker = fresh.services.createWorker();
      await worker.drain(180_000);
      await worker.stop();
      const run = await freshApi.get<MigrationRunDto>(`/api/runs/${started.id}`);

      /*
       * The same contacts, the same engine, the referenced datasets added. This is the corrective action
       * the failure screen names, carried out, and the outcome it produces.
       */
      expect(run.created + run.updated).toBeGreaterThan(0);
      expect(run.failed).toBe(0);
      expect(run.omittedReferences, 'every reference was carried').toBe(0);
      expect(run.status).toBe('COMPLETED');
      /*
       * Including the ones the second pass sets. Accounts reference each other, so the plan defers that
       * lookup to break the cycle; a hundred of them are resolved on the second pass, and none are left
       * incomplete.
       */
      const accounts = run.entities.find((e) => e.logicalName === 'account')!;
      expect(accounts.deferredResolved).toBeGreaterThan(0);
      expect(accounts.deferredIncomplete).toBe(0);
      expect(accounts.deferredFailed).toBe(0);
      expect(accounts.deferredPending, 'nothing was left waiting').toBe(0);
      const after = await freshApi.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
      expect(after.status, 'and now the plan is finished').toBe('EXECUTED');
    } finally {
      await fresh.close();
    }
  });

  /**
   * `Succeeded 0 · Skipped 300`.
   *
   * The second report this gate was called on. Three hundred records, nothing stated about whether the
   * target holds the right data, under a word — `Succeeded` — that was `created + updated + unchanged`
   * and so put a record the engine wrote beside one it only compared.
   *
   * The counters are kept apart because the engine records which is which, and the result line names each
   * one for what it is. The one thing that is not done is renaming the skipped records as succeeded.
   */
  it('keeps a matched record apart from a written one', async () => {
    await migrate('First pass', ['dtx_applicationconfig']);
    const second = await migrate('Second pass', ['dtx_applicationconfig']);

    expect(second.created + second.updated, 'nothing was written the second time').toBe(0);
    expect(second.skipped + second.unchanged).toBe(second.total);
    // Not promoted to a success, and not reported as a failure either.
    expect(second.failed).toBe(0);
    expect(second.omittedReferences).toBe(0);
  });
});
