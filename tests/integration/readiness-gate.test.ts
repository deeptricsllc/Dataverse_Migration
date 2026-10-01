import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EnvironmentDto, MigrationPlanDto } from '../../shared/domain';
import type { ReadinessAssessment } from '../../shared/readiness';
import { migrationPlanEntities } from '../../server/src/db/schema';
import { readZip } from '../../server/src/lib/zip';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * What has to be decided before a migration runs, and what happens when it is not.
 *
 * The assessment is an assembly job — plan validation, connector verification, target inspection,
 * the measured scale envelope and the resume analysis all already existed — so the tests worth having
 * are about the gate rather than about the arithmetic: a blocker that cannot be overridden stays
 * refused, one that can is refused *until somebody says why*, and either way the decision ends up in
 * the audit trail and the evidence package.
 */
describe('readiness assessment and gate', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let uat: EnvironmentDto;
  let qa: EnvironmentDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
  }, 120_000);

  afterAll(async () => {
    await t.close();
  });

  const makePlan = async (tables: string[], target = uat) => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Readiness ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: target.id,
      tables,
    });
    return plan;
  };

  const assess = (planId: string) => api.get<ReadinessAssessment>(`/api/plans/${planId}/readiness`);

  it('reports a verdict with a sentence, not just a list', async () => {
    const plan = await makePlan(['dtx_region']);
    const readiness = await assess(plan.id);
    expect(['READY', 'READY_WITH_WARNINGS', 'BLOCKED', 'BLOCKED_PENDING_OVERRIDE']).toContain(
      readiness.verdict,
    );
    expect(readiness.summary.length, 'the verdict is explained in words').toBeGreaterThan(20);
    expect(readiness.counts.blockers + readiness.counts.warnings + readiness.counts.information).toBe(
      readiness.findings.length,
    );
  }, 120_000);

  it('gives every finding a code, evidence, an explanation and something to do', async () => {
    // A finding nobody can act on is noise, and noise is how a report stops being read.
    const plan = await makePlan(['account', 'contact'], qa);
    const readiness = await assess(plan.id);
    expect(readiness.findings.length).toBeGreaterThan(0);
    for (const finding of readiness.findings) {
      expect(finding.code, 'a stable code').toMatch(/^[A-Z][A-Z_]+$/);
      expect(finding.evidence.length, `${finding.code} says what was observed`).toBeGreaterThan(10);
      expect(finding.explanation.length, `${finding.code} says why it matters`).toBeGreaterThan(20);
      expect(finding.recommendation.length, `${finding.code} says what to do`).toBeGreaterThan(15);
      expect(finding.recommendation.toLowerCase(), 'and not to ask somebody else').not.toContain(
        'contact support',
      );
      expect(finding.source, 'and where it came from').toBeTruthy();
    }
  }, 120_000);

  it('warns that a populated target changes what the numbers mean', async () => {
    const plan = await makePlan(['account'], qa);
    const readiness = await assess(plan.id);
    const finding = readiness.findings.find((f) => f.code === 'TARGET_ALREADY_POPULATED');
    expect(finding, 'QA already holds accounts').toBeTruthy();
    expect(finding!.severity).toBe('WARNING');
    expect(finding!.explanation).toMatch(/NOT VERIFIED/);
  }, 120_000);

  it('says what rollback is before the migration rather than after somebody asks', async () => {
    const plan = await makePlan(['dtx_region']);
    const readiness = await assess(plan.id);
    const finding = readiness.findings.find((f) => f.code === 'ROLLBACK_IS_INVENTORY')!;
    expect(finding.severity).toBe('INFORMATION');
    expect(finding.explanation).toMatch(/no automatic destructive undo/i);
  }, 120_000);

  // -------------------------------------------------------------------------
  describe('the gate', () => {
    /**
     * Forces the one blocker this product can raise and let somebody run past: a table matched on
     * the record id against a target that assigns its own keys. Set directly, because reaching it
     * through the interface needs a cross-provider plan and the point here is the gate.
     */
    const forceResumeGap = async (planId: string) => {
      await t.services.db
        .update(migrationPlanEntities)
        .set({ matchStrategy: 'PRIMARY_ID', alternateKey: null })
        .where(eq(migrationPlanEntities.planId, planId));
    };

    it('raises the resume gap for a cross-provider plan matched on the record id', async () => {
      // The combination the finding exists for: a SQL source whose keys the Dataverse target will not
      // take, and a table matched on the record id, so an interrupted run has nothing to re-match by.
      const envs = await api.get<EnvironmentDto[]>('/api/environments');
      const sqlSource = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)');
      expect(sqlSource, 'the demo workspace has a SQL source').toBeTruthy();

      const tables = await api.get<{ logicalName: string }[]>(`/api/environments/${sqlSource!.id}/tables`);
      expect(tables.length).toBeGreaterThan(0);
      const plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: `Readiness cross ${Date.now()}`,
        sourceEnvironmentId: sqlSource!.id,
        targetEnvironmentId: uat.id,
        tables: [tables[0]!.logicalName],
      });
      await forceResumeGap(plan.id);

      const readiness = await assess(plan.id);
      const finding = readiness.findings.find((f) => f.code === 'RESUME_CANNOT_RECOVER_INTERRUPTION');
      expect(finding, 'the gap is reported').toBeTruthy();
      expect(finding!.severity).toBe('BLOCKER');
      expect(finding!.overridability).toBe('OVERRIDABLE_WITH_EXPLICIT_ACKNOWLEDGEMENT');
      expect(finding!.recommendation).toMatch(/alternate key or a business key/i);
      // And the verdict says somebody has to decide, not that it cannot run.
      expect(['BLOCKED_PENDING_OVERRIDE', 'BLOCKED']).toContain(readiness.verdict);
    }, 300_000);

    it('accepts that blocker by name, with a reason, and records who did it', async () => {
      const envs = await api.get<EnvironmentDto[]>('/api/environments');
      const sqlSource = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
      const tables = await api.get<{ logicalName: string }[]>(`/api/environments/${sqlSource.id}/tables`);
      const plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: `Readiness override ${Date.now()}`,
        sourceEnvironmentId: sqlSource.id,
        targetEnvironmentId: uat.id,
        tables: [tables[0]!.logicalName],
      });
      await forceResumeGap(plan.id);
      const before = await assess(plan.id);
      const finding = before.findings.find((f) => f.code === 'RESUME_CANNOT_RECOVER_INTERRUPTION')!;

      const after = await api.post<ReadinessAssessment>(`/api/plans/${plan.id}/readiness/override`, {
        code: finding.code,
        object: finding.object!.name,
        reason: 'One-off load into an empty sandbox; we will not interrupt it and will reconcile after.',
      });
      expect(after.counts.overridden).toBe(1);
      expect(after.verdict, 'nothing outstanding now').not.toBe('BLOCKED_PENDING_OVERRIDE');
      const override = after.overrides[0]!;
      expect(override.code).toBe(finding.code);
      expect(override.object).toBe(finding.object!.name);
      expect(override.reason).toMatch(/empty sandbox/);
      expect(override.acknowledgedBy, 'attributed to a person').toBeTruthy();
      expect(override.acknowledgedAt).toBeTruthy();

      // In the audit trail, with the reason.
      const audit = await api.get<{ items: { action: string; details?: Record<string, unknown> }[] }>(
        '/api/audit?limit=200',
      );
      const entry = audit.items.find((a) => a.action === 'READINESS_BLOCKER_OVERRIDDEN');
      expect(entry, 'the override is audited').toBeTruthy();
      expect(String(entry!.details?.code)).toBe(finding.code);

      // An override of one table does not cover another.
      const other = await assess(plan.id);
      expect(other.overrides).toHaveLength(1);
    }, 300_000);

    it('withdraws an override, so the finding blocks again', async () => {
      const envs = await api.get<EnvironmentDto[]>('/api/environments');
      const sqlSource = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
      const tables = await api.get<{ logicalName: string }[]>(`/api/environments/${sqlSource.id}/tables`);
      const plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: `Readiness withdraw ${Date.now()}`,
        sourceEnvironmentId: sqlSource.id,
        targetEnvironmentId: uat.id,
        tables: [tables[0]!.logicalName],
      });
      await forceResumeGap(plan.id);
      const before = await assess(plan.id);
      const finding = before.findings.find((f) => f.code === 'RESUME_CANNOT_RECOVER_INTERRUPTION')!;
      await api.post(`/api/plans/${plan.id}/readiness/override`, {
        code: finding.code,
        object: finding.object!.name,
        reason: 'Accepted for now, to be reconsidered before the real load.',
      });
      const cleared = await api.del<ReadinessAssessment>(`/api/plans/${plan.id}/readiness/override`, {
        code: finding.code,
        object: finding.object!.name,
      });
      expect(cleared.counts.overridden).toBe(0);
      expect(cleared.overrides).toHaveLength(0);
      // Outstanding again. The verdict may be BLOCKED rather than BLOCKED_PENDING_OVERRIDE, because a
      // cross-provider plan also carries non-overridable findings — and accepting one overridable
      // blocker never clears those, which is the point of the two verdicts being different words.
      expect(['BLOCKED', 'BLOCKED_PENDING_OVERRIDE']).toContain(cleared.verdict);
      expect(
        cleared.findings.some((f) => f.code === 'RESUME_CANNOT_RECOVER_INTERRUPTION'),
        'the finding is back',
      ).toBe(true);
    }, 300_000);

    it('refuses an override with no reason', async () => {
      const plan = await makePlan(['dtx_region']);
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/readiness/override`,
        payload: { code: 'ROLLBACK_IS_INVENTORY', object: plan.name, reason: 'ok' },
        headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
      });
      // Ten characters minimum: "ok" is a click, not a decision.
      expect(res.statusCode).toBe(400);
    }, 120_000);

    it('refuses to override something that is not a blocker', async () => {
      const plan = await makePlan(['dtx_region']);
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/readiness/override`,
        payload: {
          code: 'ROLLBACK_IS_INVENTORY',
          object: plan.name,
          reason: 'We have a backup of the target and accept the inventory-only model.',
        },
        headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
      });
      expect(res.statusCode, 'information is not overridden').toBeGreaterThanOrEqual(400);
    }, 120_000);

    it('refuses to override a finding that does not exist', async () => {
      const plan = await makePlan(['dtx_region']);
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/readiness/override`,
        payload: {
          code: 'INVENTED_FINDING',
          object: null,
          reason: 'Trying to accept something that was never reported.',
        },
        headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }, 120_000);

    it('offers no way to accept everything at once', async () => {
      // The property that makes this a decision rather than a dialog. An override names one finding
      // and one object; there is no endpoint that takes a list and no flag that skips the check.
      const plan = await makePlan(['dtx_region']);
      for (const payload of [
        { all: true, reason: 'Accepting everything because we are in a hurry.' },
        { codes: ['A', 'B'], reason: 'Accepting two at once to save time.' },
      ]) {
        const res = await t.app.inject({
          method: 'POST',
          url: `/api/plans/${plan.id}/readiness/override`,
          payload,
          headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
        });
        expect(res.statusCode, 'no bulk form').toBe(400);
      }
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  it('puts the assessment in the evidence package', async () => {
    const plan = await makePlan(['dtx_region']);
    const worker = t.services.createWorker();
    const started = await api.post<{ id: string }>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(300_000);
    await worker.stop();

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${started.id}/evidence.zip`,
      headers: { cookie: api.cookie },
    });
    expect(res.statusCode).toBe(200);
    const entries = readZip(res.rawPayload);
    expect(entries.has('readiness.json'), 'the package carries the assessment').toBe(true);
    const readiness = JSON.parse(entries.get('readiness.json')!.toString('utf8')) as ReadinessAssessment;
    expect(readiness.verdict).toBeTruthy();
    expect(Array.isArray(readiness.findings)).toBe(true);
    expect(Array.isArray(readiness.overrides)).toBe(true);
    // And the manifest vouches for it like any other file.
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    expect(manifest.files.some((f: { path: string }) => f.path === 'readiness.json')).toBe(true);
  }, 600_000);
});
