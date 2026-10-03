import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import { accountedFor, writtenByRun } from '../../shared/run-metrics';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The run and the validation report must tell the same story about the same migration.
 *
 * They did not. Validation counted every identity-map row that was not FAILED as a record it had
 * migrated, which swept in the records the run had deliberately left alone. A second run over the
 * same table therefore produced a run page reading "created 0, updated 0, skipped 28" beside a
 * validation report reading "28 migrated — written by the run being validated". Both pages were
 * describing the same thirty records.
 *
 * This runs the migration twice on purpose, because the second run is the one that skips, and
 * compares the two screens' numbers against each other rather than against a hard-coded total.
 */
describe('the run and its validation report agree', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let dev: EnvironmentDto;
  let qa: EnvironmentDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  const migrate = async (tables: string[]): Promise<MigrationRunDto> => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Agreement ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables,
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    return api.get<MigrationRunDto>(`/api/runs/${started.id}`);
  };

  const validate = async (run: MigrationRunDto): Promise<ValidationRunDto> => {
    const started = await api.post<ValidationRunDto>('/api/validations', { migrationRunId: run.id });
    await worker.drain(180_000);
    return api.get<ValidationRunDto>(`/api/validations/${started.id}`);
  };

  it('reports the same created, updated, skipped and failed counts on both screens', async () => {
    const tables = ['dtx_office'];
    const first = await migrate(tables);
    // The second run finds its own work already in the target, which is what produces skips.
    const second = await migrate(tables);
    const report = await validate(second);

    expect(report.status).toBe('COMPLETED');
    const accounting = report.summary!.accounting!;
    expect(accounting, 'the report records what the run did with each record').toBeTruthy();

    // Every bucket, against the run's own counters. Not a spot check: if any single one drifts the
    // two screens are describing different migrations again.
    expect(accounting.created).toBe(second.created);
    expect(accounting.updated).toBe(second.updated);
    expect(accounting.unchanged).toBe(second.unchanged);
    expect(accounting.skipped).toBe(second.skipped);
    expect(accounting.failed).toBe(second.failed);
    expect(accountedFor(accounting)).toBe(second.processed);

    // The headline figure the report leads with.
    expect(writtenByRun(accounting)).toBe(second.created + second.updated);

    // And the specific lie: a skipped record is never counted as written.
    if (second.skipped > 0) {
      expect(writtenByRun(accounting), 'records the run skipped are not records the run wrote').toBeLessThan(
        accountedFor(accounting),
      );
      expect(writtenByRun(accounting)).toBe(second.created + second.updated);
    }

    // The first run put the records there, so it must show a write the second one does not.
    expect(first.created + first.updated).toBeGreaterThan(0);
  });

  it('never reports more written than the run processed', async () => {
    // A cheap invariant that holds for every run, whatever the mix of outcomes.
    const run = await migrate(['dtx_office']);
    const report = await validate(run);
    const accounting = report.summary!.accounting!;
    expect(writtenByRun(accounting)).toBeLessThanOrEqual(accountedFor(accounting));
    expect(accountedFor(accounting)).toBeLessThanOrEqual(run.total);
  });
});
