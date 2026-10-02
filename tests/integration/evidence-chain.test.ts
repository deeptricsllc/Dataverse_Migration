import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import type { ReadinessAssessment } from '../../shared/readiness';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Following one problem through every stage that saw it.
 *
 * The chain a buyer asks about, and the brief's own worked example:
 *
 *   Readiness:   website may exceed the target's 100 characters
 *   Migration:   records fail because of the length
 *   Validation:  those records are absent
 *   Evidence:    the same issue, traceable through the package
 *
 * Each stage already recorded what it saw, in its own vocabulary. Nothing joined them, so a reader had
 * three lists and a hypothesis. These cases check the join, and — just as importantly — check that it
 * does not invent a relationship where the stages have nothing in common.
 */
describe('the evidence chain', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let run: MigrationRunDto;
  let assessment: ReadinessAssessment;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;

    // `websiteurl` holds 200 characters in Development and 100 in QA.
    const { demoRecords } = await import('../../server/src/db/schema');
    const session = await api.get<{ user: { organization: { id: string } } }>('/api/auth/session');
    await t.services.db.insert(demoRecords).values({
      organizationId: session.user.organization.id,
      environmentKey: 'demo-dev',
      logicalName: 'account',
      recordId: '00000000-0000-4000-9000-00000000dddd',
      data: {
        accountid: '00000000-0000-4000-9000-00000000dddd',
        name: 'Chain Test Account',
        accountnumber: 'CHAIN-001',
        websiteurl: `https://example.com/${'y'.repeat(140)}`,
      },
    });

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Chain ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['account'],
    });
    assessment = await api.get<ReadinessAssessment>(`/api/plans/${plan.id}/readiness`);
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(300_000);
    run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);

    const v = await api.post<ValidationRunDto>('/api/validations', {
      migrationRunId: run.id,
      depth: 'FULL',
    });
    await worker.drain(300_000);
    await api.get<ValidationRunDto>(`/api/validations/${v.id}`);
  }, 600_000);

  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('records the prediction that was made, not one made afterwards', async () => {
    /**
     * The evidence package used to re-assess the plan when the package was built and describe the result
     * as "the pre-migration assessment". It was not: the target is populated by the run itself, so a
     * finding like TARGET_ALREADY_POPULATED means something different afterwards, and a reader following
     * predicted risk to actual outcome was handed the wrong half of the chain.
     */
    const chain = await api.get(`/api/runs/${run.id}/chain`);
    expect(chain.predictionWasRecorded, 'the assessment was kept with the run').toBe(true);

    const predicted = chain.links
      .filter((l: { predictedBy: string | null }) => l.predictedBy)
      .map((l: { predictedBy: string }) => l.predictedBy);
    // Every finding the plan had before the run is in the chain.
    for (const finding of assessment.findings) {
      expect(predicted, finding.code).toContain(finding.code);
    }
  }, 300_000);

  it('joins the stages that saw the same column, and says that is what it did', async () => {
    const chain = await api.get(`/api/runs/${run.id}/chain`);

    const link = chain.links.find(
      (l: { predictedBy: string | null; column: string | null }) =>
        l.predictedBy === 'SCHEMA_MAXLENGTH' && l.column === 'websiteurl',
    );
    expect(link, 'the narrow column is a link in the chain').toBeTruthy();
    expect(link.table).toBe('account');
    expect(link.severity).toBe('WARNING');

    const stages = link.stages.map((s: { stage: string }) => s.stage);
    expect(stages[0], 'the prediction comes first').toBe('READINESS');
    expect(stages, 'and the run that met it').toContain('MIGRATION');

    const migration = link.stages.find((s: { stage: string }) => s.stage === 'MIGRATION');
    expect(migration.records, 'how many records it affected').toBeGreaterThan(0);
    expect(migration.examples.length, 'and which ones, so somebody can go and look').toBeGreaterThan(0);

    // The join is on a name, and the report says so rather than implying a recorded relationship.
    expect(link.confidence).toBe('MATCHED_ON_COLUMN');
    expect(chain.means).toMatch(/strong inference, not a recorded relationship/i);
  }, 300_000);

  it('does not invent a link for a finding with nothing specific to join on', async () => {
    /**
     * A finding about a whole table, or about the plan, has nothing precise enough to match a
     * record-level error against. Attaching records to it would put the wrong records under the wrong
     * prediction, which is worse than leaving the row with one stage.
     */
    const chain = await api.get(`/api/runs/${run.id}/chain`);
    // Predictions without a column. The filter has to say "predicted" as well as "no column", because an
    // unmatched migration or validation row also has no column and is a different case, below.
    const planWide = chain.links.filter(
      (l: { column: string | null; predictedBy: string | null }) =>
        l.column === null && l.predictedBy !== null,
    );
    expect(planWide.length, 'there are findings about more than one column').toBeGreaterThan(0);
    for (const link of planWide) {
      expect(link.stages, `${link.predictedBy} invented downstream stages`).toHaveLength(1);
      expect(link.confidence).toBe('RECORDED');
    }
  }, 300_000);

  it('shows a failure no prediction accounts for, rather than dropping it', async () => {
    /**
     * The most interesting row available: a failure readiness did not foresee is exactly where the
     * assessment has a gap, and a chain that only showed predicted problems would hide it.
     */
    const chain = await api.get(`/api/runs/${run.id}/chain`);
    const unmatched = chain.links.filter((l: { confidence: string }) => l.confidence === 'UNMATCHED');
    // This run has validation differences on columns no finding named, so there is something to show.
    expect(unmatched.length).toBeGreaterThan(0);
    for (const link of unmatched) {
      expect(link.predictedBy).toBeNull();
      expect(link.stages.length).toBe(1);
      expect(['MIGRATION', 'VALIDATION']).toContain(link.stages[0].stage);
    }
    expect(chain.means).toMatch(/where the assessment has a gap/i);
  }, 300_000);

  it('puts the same prediction in the evidence package', async () => {
    const zip = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${run.id}/evidence.zip`,
      headers: { cookie: api.cookie },
    });
    expect(zip.statusCode).toBe(200);
    const { readZip } = await import('../../server/src/lib/zip');
    const files = readZip(Buffer.from(zip.rawPayload));
    const readiness = JSON.parse(files.get('readiness.json')!.toString('utf8')) as ReadinessAssessment;

    // The same codes the plan had before the run, not a fresh assessment of a now-populated target.
    expect(new Set(readiness.findings.map((f) => f.code))).toEqual(
      new Set(assessment.findings.map((f) => f.code)),
    );

    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
      files: { path: string; describes: string }[];
    };
    const record = manifest.files.find((f) => f.path === 'readiness.json')!;
    expect(record.describes, 'and the package says which document this is').toMatch(
      /recorded before the work started/i,
    );
  }, 300_000);
});
