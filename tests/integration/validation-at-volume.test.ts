import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import { accountedFor } from '../../shared/run-metrics';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/** The batch size the validation service compares in. Mirrored here on purpose, not imported: a
 * change to it should make this test's intent visible rather than silently follow. */
const COMPARISON_BATCH = 500;
/** Enough to cross the batch boundary more than once, and small enough to run in seconds. */
const EXTRA_OFFICES = 1_400;

/**
 * Validation of a table larger than one batch.
 *
 * The point is not that the numbers come out right — the small-table tests cover that — but that
 * nothing in the path grows with the table. Validation used to load every identity row for the
 * table, every source record, every target record and every difference before reporting anything,
 * so a report on ten million records needed four copies of ten million things in memory. The
 * feature worked on every table small enough not to need it.
 *
 * So this test watches the sizes of the requests the service makes, not only its answers. A single
 * read of more than one batch means the bound is gone, whatever the totals say.
 */
describe('validation at volume', () => {
  let t: TestApp;
  let api: ApiClient;
  let report: ValidationRunDto;
  let run: MigrationRunDto;
  /** The largest number of records asked for in one read, across both sides. */
  let widestRead = 0;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const worker = t.services.createWorker();
    const session = await api.demoLogin();
    const organizationId = session.user.organization.id;

    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

    // A region every office can point at, so the lookups resolve and the reference pass has work.
    const [region] = await t.services.db
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
    expect(region, 'the demo source has a region to look up').toBeTruthy();

    const rows = Array.from({ length: EXTRA_OFFICES }, (_, i) => {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      return {
        organizationId,
        environmentKey: 'demo-dev',
        logicalName: 'dtx_office',
        recordId: id,
        data: {
          dtx_officeid: id,
          dtx_name: `Volume Office ${i}`,
          dtx_city: `City ${i % 97}`,
          dtx_regionid: { logicalName: 'dtx_region', id: region!.recordId, name: 'Region' },
          dtx_openedon: '2024-06-01T00:00:00Z',
          dtx_headcount: (i % 40) + 1,
        },
      };
    });
    for (let i = 0; i < rows.length; i += 200) {
      await t.services.db.insert(demoRecords).values(rows.slice(i, i + 200));
    }

    // Watch every read either side is asked to perform.
    const factory = t.services.connections as unknown as {
      forEnvironment: (...args: unknown[]) => Promise<{ retrieveByIds: (...a: unknown[]) => unknown }>;
    };
    const original = factory.forEnvironment.bind(factory);
    factory.forEnvironment = async (...args: unknown[]) => {
      const conn = await original(...args);
      const retrieve = conn.retrieveByIds.bind(conn);
      conn.retrieveByIds = (table: unknown, ids: unknown, columns: unknown) => {
        if (Array.isArray(ids)) widestRead = Math.max(widestRead, ids.length);
        return retrieve(table, ids, columns);
      };
      return conn;
    };

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Volume ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'dtx_office'],
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(600_000);
    run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);

    const validation = await api.post<ValidationRunDto>('/api/validations', {
      migrationRunId: started.id,
      depth: 'FULL',
    });
    await worker.drain(600_000);
    report = await api.get<ValidationRunDto>(`/api/validations/${validation.id}`);
    await worker.stop();
  }, 900_000);

  afterAll(async () => {
    await t.close();
  });

  it('examines a table several batches long, and reports full coverage for it', () => {
    const office = report.entities.find((e) => e.logicalName === 'dtx_office')!;
    expect(office.checkedRecords, 'more than one batch of records').toBeGreaterThan(COMPARISON_BATCH * 2);
    expect(office.coverage?.mode, 'FULL depth over every record').toBe('FULL');
    expect(office.coverage!.examined).toBe(office.coverage!.eligible);
    expect(office.outcome, 'and it validates clean').toBe('PASS');
  });

  it('never reads more than one batch at a time', () => {
    // The assertion the refactor exists for. Before it, this number was the size of the table.
    expect(widestRead, 'the widest single read').toBeGreaterThan(0);
    expect(widestRead, `read ${widestRead} records in one request`).toBeLessThanOrEqual(COMPARISON_BATCH);
  });

  it('keeps the arithmetic intact across batch boundaries', () => {
    const office = report.entities.find((e) => e.logicalName === 'dtx_office')!;
    // A record is matched, missing or differing — never counted twice because a batch ended.
    expect(office.matched + office.missing + office.different).toBe(office.checkedRecords);
    expect(office.failedInRun).toBe(0);
    expect(office.brokenReferences, 'every lookup resolved, batch by batch').toBe(0);
    // And the run and the report still agree, which is the invariant the metrics work exists for.
    expect(accountedFor(office.accounting!)).toBe(
      run.entities.find((e) => e.logicalName === 'dtx_office')!.processed,
    );
  });
});
