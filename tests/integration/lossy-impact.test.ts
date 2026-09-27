import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  LossyRecordDto,
  LossyTransformationDto,
  MigrationPlanDto,
  PreflightRunDto,
  TransformationRule,
} from '../../shared/domain';
import { demoRecords } from '../../server/src/db/schema';
import type { RequestContext } from '../../server/src/services/context';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * What the acknowledgement screen promises: this many records will actually lose something.
 *
 * The number is measured, and where it comes from is part of the answer — a bounded sample can
 * only report a floor, so it is labelled an estimate, while a completed preflight looked at every
 * record and is preferred over any estimate from then on.
 */
describe('lossy transformation impact', () => {
  let t: TestApp;
  let api: ApiClient;
  let ctx: RequestContext;
  let dev: EnvironmentDto;
  let qa: EnvironmentDto;
  let plan: MigrationPlanDto;

  /** Every contact in the demo source, so the expected counts come from the data, not a guess. */
  const sourceContacts = async () => {
    const rows = await t.services.db
      .select()
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, 'demo-dev'), eq(demoRecords.logicalName, 'contact')));
    return rows.map((r) => r.data as Record<string, string | null>);
  };

  const entity = () => plan.entities.find((e) => e.logicalName === 'contact')!;

  const mappingId = async (sourceField: string) => {
    const { mappings } = await api.get<{ mappings: { id: string; sourceField: string }[] }>(
      `/api/plans/${plan.id}/entities/${entity().id}/mappings`,
    );
    return mappings.find((m) => m.sourceField === sourceField)!.id;
  };

  const setPipeline = async (sourceField: string, rules: TransformationRule[]) => {
    plan = await api.patch<MigrationPlanDto>(
      `/api/plans/${plan.id}/mappings/${await mappingId(sourceField)}/transformations`,
      { rules },
    );
  };

  const lossyFor = async (field: string) => {
    const all = await api.get<LossyTransformationDto[]>(`/api/plans/${plan.id}/lossy-transformations`);
    return all.find((l) => l.field === field)!;
  };

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    ctx = {
      userId: session.user.id,
      organizationId: session.user.organization.id,
      role: 'ADMIN',
      isDemoOrg: true,
      displayName: session.user.displayName ?? 'demo',
      requestId: 'test',
      platformOperator: false,
    };
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;

    plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Contacts with a shorter name column',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['contact'],
    });
    // A first name cut to four characters, and a secured national ID cut to six.
    await setPipeline('firstname', [{ kind: 'TRUNCATE', length: 4 }]);
    await setPipeline('dtx_nationalid', [{ kind: 'TRUNCATE', length: 6 }]);
  });
  afterAll(async () => {
    await t.close();
  });

  // ---------------------------------------------------------------------------

  it('labels a count from a bounded scan as sampled rather than presenting it as exact', async () => {
    const measured = await t.services.transformations.lossyTransformations(ctx, plan.id, { scanLimit: 3 });
    const firstname = measured.find((l) => l.field === 'firstname')!;

    expect(firstname.basis).toBe('SAMPLED');
    expect(firstname.fromPreflight).toBe(false);
    expect(firstname.examined).toBe(3);
    // A floor: it cannot exceed what was looked at, and it is not the whole table.
    expect(firstname.affected).toBeLessThanOrEqual(3);
    expect((await sourceContacts()).length).toBeGreaterThan(3);
  });

  it('counts the affected records exactly during a full preflight', async () => {
    const worker = t.services.createWorker();
    const started = await api.post<PreflightRunDto>(`/api/plans/${plan.id}/preflight`);
    await worker.drain(180_000);
    await worker.stop();
    const preflight = await api.get<PreflightRunDto>(`/api/preflight/${started.id}`);
    expect(preflight.status).toBe('COMPLETED');

    const contacts = await sourceContacts();
    const expectedNames = contacts.filter((c) => (c.firstname ?? '').length > 4).length;
    const expectedIds = contacts.filter((c) => (c.dtx_nationalid ?? '').length > 6).length;
    expect(expectedNames).toBeGreaterThan(0);
    expect(expectedIds).toBeGreaterThan(0);

    const impact = new Map(preflight.lossyImpact.map((i) => [i.key, i]));
    expect(impact.get('contact.firstname:TRUNCATE')!.affected).toBe(expectedNames);
    expect(impact.get('contact.dtx_nationalid:TRUNCATE')!.affected).toBe(expectedIds);
    // Not every record: the contacts whose name already fits are untouched.
    expect(expectedNames).toBeLessThan(contacts.length);
  });

  it('prefers the exact preflight count over any estimate', async () => {
    // Even asked for the smallest possible sample, the acknowledgement reports the preflight.
    const measured = await t.services.transformations.lossyTransformations(ctx, plan.id, { scanLimit: 1 });
    const firstname = measured.find((l) => l.field === 'firstname')!;
    const contacts = await sourceContacts();

    expect(firstname.fromPreflight).toBe(true);
    expect(firstname.basis).toBe('EXACT');
    expect(firstname.examined).toBe(contacts.length);
    expect(firstname.affected).toBe(contacts.filter((c) => (c.firstname ?? '').length > 4).length);
    expect(firstname.maxSourceLength).toBe(
      Math.max(...contacts.map((c) => (c.firstname ?? '').length).filter((n) => n > 4)),
    );
    // The same numbers reach the acknowledgement screen through the API it actually calls.
    const overApi = await lossyFor('firstname');
    expect(overApi).toMatchObject({
      affected: firstname.affected,
      examined: firstname.examined,
      basis: 'EXACT',
      fromPreflight: true,
      targetField: 'firstname',
      targetTable: 'contact',
      targetMaxLength: 4,
    });
  });

  it('lists and exports the affected records without unmasking a secured column', async () => {
    const secured = await lossyFor('dtx_nationalid');
    const drill = await api.get<{ items: LossyRecordDto[]; total: number }>(
      `/api/plans/${plan.id}/lossy-records?key=${encodeURIComponent(secured.key)}&limit=500`,
    );
    expect(drill.items.length).toBeGreaterThan(0);
    for (const row of drill.items) {
      expect(row.field).toBe('dtx_nationalid');
      // The value never leaves the server, not even to explain what was cut from it.
      expect(row.originalValue).toBe('•••• (secured column)');
      expect(row.transformedValue).toBe('•••• (secured column)');
      expect(row.loss).toMatch(/characters truncated to 6/);
      expect(row.sourceRecordId).toBeTruthy();
    }

    const csv = await t.app.inject({
      method: 'GET',
      url: `/api/plans/${plan.id}/lossy-records.csv?key=${encodeURIComponent(secured.key)}`,
      headers: { cookie: api.cookie },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(
      'Table,Record ID,Field,Original value,Transformed value,Transformation,Loss description',
    );
    expect(csv.body).toContain('•••• (secured column)');
    expect(csv.body).not.toMatch(/NID-\d/);
    // Anything a spreadsheet would execute is neutralised before it reaches the file.
    for (const cell of csv.body.split(/\r\n|,/)) {
      expect(cell.replace(/^"/, '').startsWith('=')).toBe(false);
    }

    // The unsecured field is not masked: the drill-down is only useful if it shows real values.
    const names = await api.get<{ items: LossyRecordDto[] }>(
      `/api/plans/${plan.id}/lossy-records?key=${encodeURIComponent((await lossyFor('firstname')).key)}&limit=5`,
    );
    expect(names.items[0].originalValue).not.toContain('••••');
    expect(names.items[0].transformedValue).toHaveLength(4);
  });
});
