import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AnalysisRunDto,
  EnvironmentDto,
  MigrationPlanDto,
  MigrationScheduleDto,
  ProjectDto,
} from '../../shared/domain';
import { writeXlsx } from '../../server/src/lib/xlsx';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Nothing belonging to one organization is reachable from another.
 *
 * The existing isolation test covered the original routes and stopped there, which is exactly how a
 * cross-tenant hole reached the newest code: `POST /api/plans/:id/mapping-workbook` never checked that
 * the plan belonged to the caller, and its dry-run preview happily described another organization's
 * tables, columns and current target mappings. A read is as much a breach as a write, and an "is this
 * column in the plan?" answer is an enumeration oracle.
 *
 * So this walks every route added since, as an intruder. Each assertion is 404 or 403 — never a body.
 */
describe('tenant isolation across every route', () => {
  let t: TestApp;
  /** The organization that owns everything. */
  let owner: ApiClient;
  /** A second organization in the same database, signed in as its own user. */
  let intruder: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;

  const owned = {
    projectId: '',
    analysisProjectId: '',
    analysisId: '',
    planId: '',
    scheduleId: '',
    stagedId: '',
    comparisonProjectId: '',
    comparisonId: '',
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = new ApiClient(t.app);
    worker = t.services.createWorker();
    await owner.demoLogin();
    const envs = await owner.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;

    // --- everything the owner has -------------------------------------------
    const analysisProject = await owner.post<ProjectDto>('/api/projects', {
      name: 'Owner analysis',
      kind: 'ANALYSIS',
      sourceEnvironmentId: dev.id,
    });
    owned.analysisProjectId = analysisProject.id;
    const analysis = await owner.post<AnalysisRunDto>(`/api/projects/${analysisProject.id}/analyses`, {
      tables: ['dtx_office'],
      full: true,
    });
    await worker.drain(180_000);
    owned.analysisId = analysis.id;

    const migrationProject = await owner.post<ProjectDto>('/api/projects', {
      name: 'Owner migration',
      kind: 'MIGRATION',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
    });
    owned.projectId = migrationProject.id;

    const plan = await owner.post<MigrationPlanDto>('/api/plans', {
      name: 'Owner plan',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['account'],
      projectId: migrationProject.id,
    });
    owned.planId = plan.id;

    const schedule = await owner.post<MigrationScheduleDto>(`/api/plans/${plan.id}/schedules`, {
      cron: '0 3 * * *',
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
    });
    owned.scheduleId = schedule.id;

    const comparisonProject = await owner.post<ProjectDto>('/api/projects', {
      name: 'Owner reconciliation',
      kind: 'COMPARISON',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
    });
    owned.comparisonProjectId = comparisonProject.id;
    const comparison = await owner.post<{ id: string }>(
      `/api/projects/${comparisonProject.id}/data-comparisons`,
      {
        pairs: [
          {
            leftTable: 'account',
            rightTable: 'account',
            key: [{ left: 'accountid', right: 'accountid' }],
            fields: [{ left: 'name', right: 'name' }],
          },
        ],
      },
    );
    owned.comparisonId = comparison.id;
    await worker.drain(180_000);

    const staged = await owner.post<EnvironmentDto>(
      '/api/staged-sources',
      { displayName: 'Owner extracts', kind: 'UPLOAD' },
      201,
    );
    owned.stagedId = staged.id;
    await owner.post(`/api/staged-sources/${staged.id}/import`, {
      filename: 'owner.csv',
      contentBase64: Buffer.from('id,secret_label\n1,confidential\n2,private', 'utf8').toString('base64'),
    });

    // --- a second organization, in the same database -------------------------
    const { organizations, users, sessions } = await import('../../server/src/db/schema');
    const { sha256 } = await import('../../server/src/lib/crypto');
    const [org] = await t.services.db
      .insert(organizations)
      .values({ name: 'Intruder Ltd', entraTenantId: '00000000-0000-0000-0000-0000000000ff' })
      .returning();
    const [user] = await t.services.db
      .insert(users)
      .values({
        organizationId: org.id,
        externalId: 'intruder',
        authProvider: 'microsoft',
        displayName: 'Intruder',
        // An ADMIN of the other organization on purpose: isolation must not depend on the role.
        role: 'ADMIN',
      })
      .returning();
    const token = 'intruder-token';
    await t.services.db.insert(sessions).values({
      id: sha256(token),
      userId: user.id,
      csrfToken: 'intruder-csrf',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    intruder = new ApiClient(t.app);
    intruder.cookie = `dvm_session=${token}`;
    intruder.csrf = 'intruder-csrf';
    // The session really does work, so a 404 later means "not yours" rather than "not signed in".
    const session = await intruder.get<{ user: { organization: { name: string } } }>('/api/auth/session');
    expect(session.user.organization.name).toBe('Intruder Ltd');
  });

  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  // ---------------------------------------------------------------------------

  it('cannot read another organization projects, analyses or their exports', async () => {
    await intruder.get(`/api/projects/${owned.projectId}`, 404);
    await intruder.get(`/api/projects/${owned.analysisProjectId}/analyses`, 404);
    await intruder.get(`/api/projects/${owned.analysisProjectId}/plans`, 404);
    await intruder.get(`/api/projects/${owned.analysisProjectId}/source-tables`, 404);
    await intruder.get(`/api/analyses/${owned.analysisId}`, 404);
    await intruder.get(`/api/analyses/${owned.analysisId}/findings`, 404);
    await intruder.get(`/api/analyses/${owned.analysisId}/tables/dtx_office`, 404);
    await intruder.get(`/api/analyses/${owned.analysisId}/tables.csv`, 404);
    await intruder.get(`/api/analyses/${owned.analysisId}/findings.csv`, 404);
    await intruder.get(`/api/analyses/${owned.analysisId}/columns.csv`, 404);
    await intruder.get(`/api/analyses/${owned.analysisId}/mapping.xlsx`, 404);
    // And its own list shows nothing of the owner's.
    expect(await intruder.get<ProjectDto[]>('/api/projects')).toEqual([]);
  });

  it('cannot change or archive another organization project', async () => {
    await intruder.request('PATCH', `/api/projects/${owned.projectId}`, { name: 'Taken' }, 404);
    await intruder.request('POST', `/api/projects/${owned.projectId}/archive`, {}, 404);
    await intruder.request('POST', `/api/projects/${owned.analysisProjectId}/analyses`, {}, 404);
    // The owner's project is untouched.
    expect((await owner.get<ProjectDto>(`/api/projects/${owned.projectId}`)).name).toBe('Owner migration');
  });

  it("cannot read another organization's plan through the mapping workbook", async () => {
    // The hole this test exists for. A dry run returned a preview built entirely from the victim's
    // plan: its tables, its columns and its current target mappings, plus an existence oracle for
    // every table and column name an attacker cared to guess.
    const sheet = writeXlsx([
      {
        name: 'Field mapping',
        columns: [{ header: 'Source table' }, { header: 'Source field' }, { header: 'Target field' }],
        rows: [['account', 'name', 'name']],
      },
    ]);
    await intruder.request(
      'POST',
      `/api/plans/${owned.planId}/mapping-workbook`,
      { contentBase64: sheet.toString('base64') },
      404,
    );
    // And with apply, which took the same path.
    await intruder.request(
      'POST',
      `/api/plans/${owned.planId}/mapping-workbook`,
      { contentBase64: sheet.toString('base64'), apply: true },
      404,
    );
    await intruder.get(`/api/plans/${owned.planId}/mapping.xlsx`, 404);
  });

  it('cannot read another organization comparison, its differences or its exports', async () => {
    // A comparison result is a record-by-record account of somebody's data: the key of every row
    // that differs, and the values on both sides. There is no weaker version of this to leak.
    await intruder.get(`/api/projects/${owned.comparisonProjectId}/data-comparisons`, 404);
    await intruder.get(`/api/projects/${owned.comparisonProjectId}/data-comparison-suggestions`, 404);
    await intruder.get(`/api/data-comparisons/${owned.comparisonId}`, 404);
    await intruder.get(`/api/data-comparisons/${owned.comparisonId}/differences`, 404);
    await intruder.get(`/api/data-comparisons/${owned.comparisonId}/differences.csv`, 404);
    await intruder.get(`/api/data-comparisons/${owned.comparisonId}/summary.csv`, 404);
    await intruder.request(
      'POST',
      `/api/projects/${owned.comparisonProjectId}/data-comparisons`,
      {
        pairs: [
          {
            leftTable: 'account',
            rightTable: 'account',
            key: [{ left: 'accountid', right: 'accountid' }],
            fields: [],
          },
        ],
      },
      404,
    );
    // The owner's own result is still readable, so these 404s mean "not yours" and nothing else.
    expect((await owner.get<{ id: string }>(`/api/data-comparisons/${owned.comparisonId}`)).id).toBe(
      owned.comparisonId,
    );
  });

  it('cannot see or fire another organization schedule', async () => {
    await intruder.get(`/api/schedules/${owned.scheduleId}`, 404);
    await intruder.get(`/api/schedules/${owned.scheduleId}/history`, 404);
    await intruder.get(`/api/plans/${owned.planId}/schedules`, 404);
    await intruder.request('PATCH', `/api/schedules/${owned.scheduleId}`, { enabled: false }, 404);
    await intruder.request('POST', `/api/schedules/${owned.scheduleId}/trigger`, {}, 404);
    await intruder.request('DELETE', `/api/schedules/${owned.scheduleId}`, undefined, 404);
    // Still there, still enabled.
    const still = await owner.get<MigrationScheduleDto>(`/api/schedules/${owned.scheduleId}`);
    expect(still.enabled).toBe(true);
  });

  it('cannot read or delete another organization imported data', async () => {
    await intruder.get(`/api/staged-sources/${owned.stagedId}/tables`, 404);
    await intruder.request(
      'POST',
      `/api/staged-sources/${owned.stagedId}/import`,
      { filename: 'x.csv', contentBase64: Buffer.from('a,b\n1,2').toString('base64') },
      404,
    );
    await intruder.request('DELETE', `/api/staged-sources/${owned.stagedId}/tables/owner`, undefined, 404);
    // The owner's rows are intact, and the intruder never saw the values.
    const tables = await owner.get<{ logicalName: string; rowCount: number }[]>(
      `/api/staged-sources/${owned.stagedId}/tables`,
    );
    expect(tables[0].rowCount).toBe(2);
  });

  it('cannot reach the owner plan through any of the plan routes', async () => {
    await intruder.get(`/api/plans/${owned.planId}`, 404);
    await intruder.get(`/api/plans/${owned.planId}/lossy-transformations`, 404);
    await intruder.get(`/api/plans/${owned.planId}/lossy-records`, 404);
    await intruder.get(`/api/plans/${owned.planId}/preflight`, 404);
    await intruder.request('POST', `/api/plans/${owned.planId}/preflight`, {}, 404);
    await intruder.request('POST', `/api/plans/${owned.planId}/data-quality`, {}, 404);
    await intruder.request(
      'POST',
      `/api/plans/${owned.planId}/execute`,
      {
        confirmSourceName: 'DeepTrics Development',
        confirmTargetName: 'DeepTrics QA',
        acknowledgeWarnings: true,
      },
      404,
    );
  });
});
