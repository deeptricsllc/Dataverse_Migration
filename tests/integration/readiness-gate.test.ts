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

    it('warns that an interruption will need a person, rather than blocking', async () => {
      /**
       * What this finding became when the architecture was fixed.
       *
       * It used to be a blocker: resume would create duplicates for this configuration. It cannot any
       * more — an intent row precedes every write, reconciliation settles what it can, and where nothing
       * can identify a record the run stops rather than guessing. So the finding is now a warning about
       * who has to do what if the run is interrupted, which is the thing that is still true.
       *
       * Leaving the old blocker in place after fixing the cause would be the product crying wolf.
       */
      const envs = await api.get<EnvironmentDto[]>('/api/environments');
      const sqlSource = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)');
      expect(sqlSource, 'the demo workspace has a SQL source').toBeTruthy();

      const tables = await api.get<{ logicalName: string }[]>(`/api/environments/${sqlSource!.id}/tables`);
      const plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: `Readiness cross ${Date.now()}`,
        sourceEnvironmentId: sqlSource!.id,
        targetEnvironmentId: uat.id,
        tables: [tables[0]!.logicalName],
      });
      await forceResumeGap(plan.id);

      const readiness = await assess(plan.id);
      expect(
        readiness.findings.some((f) => f.code === 'RESUME_CANNOT_RECOVER_INTERRUPTION'),
        'the old blocker is gone, not merely downgraded in place',
      ).toBe(false);
      const finding = readiness.findings.find((f) => f.code === 'RESUME_NEEDS_MANUAL_RECONCILIATION');
      expect(finding, 'and the narrower, still-true finding is there').toBeTruthy();
      expect(finding!.severity).toBe('WARNING');
      expect(finding!.explanation, 'saying plainly that no data is at risk').toMatch(/No data is at risk/i);
      expect(finding!.recommendation).toMatch(/alternate key or a business key/i);
    }, 300_000);

    it('has no overridable blocker to offer, and that is the honest state', async () => {
      /**
       * The override mechanism exists and nothing currently uses it.
       *
       * Every plan-validation blocker is non-overridable — each means a mapping or a dependency the
       * migration needs and does not have — and the one finding that *was* overridable stopped being a
       * blocker when the crash-consistency protocol made it untrue. Inventing an overridable blocker to
       * keep the happy path exercised would be worse than saying so.
       *
       * The refusal paths below are what protect the mechanism until something legitimately needs it.
       */
      const envs = await api.get<EnvironmentDto[]>('/api/environments');
      const sqlSource = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
      const tables = await api.get<{ logicalName: string }[]>(`/api/environments/${sqlSource.id}/tables`);
      const plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: `Readiness overridable ${Date.now()}`,
        sourceEnvironmentId: sqlSource.id,
        targetEnvironmentId: uat.id,
        tables: [tables[0]!.logicalName],
      });
      await forceResumeGap(plan.id);
      const readiness = await assess(plan.id);
      const overridable = readiness.findings.filter(
        (f) => f.severity === 'BLOCKER' && f.overridability === 'OVERRIDABLE_WITH_EXPLICIT_ACKNOWLEDGEMENT',
      );
      expect(overridable, 'nothing is currently overridable').toEqual([]);
      // Every blocker that does exist says it cannot be run past.
      for (const blocker of readiness.findings.filter((f) => f.severity === 'BLOCKER')) {
        expect(blocker.overridability, `${blocker.code}`).toBe('NON_OVERRIDABLE');
      }
    }, 300_000);

    it('refuses to override a non-overridable blocker, and says why', async () => {
      const envs = await api.get<EnvironmentDto[]>('/api/environments');
      const sqlSource = envs.find((e) => e.displayName === 'Legacy SQL Server (Demo)')!;
      const tables = await api.get<{ logicalName: string }[]>(`/api/environments/${sqlSource.id}/tables`);
      const plan = await api.post<MigrationPlanDto>('/api/plans', {
        name: `Readiness refuse ${Date.now()}`,
        sourceEnvironmentId: sqlSource.id,
        targetEnvironmentId: uat.id,
        tables: [tables[0]!.logicalName],
      });
      const readiness = await assess(plan.id);
      const blocker = readiness.findings.find((f) => f.severity === 'BLOCKER');
      expect(blocker, 'a cross-provider plan has a blocker to try this against').toBeTruthy();

      const res = await t.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/readiness/override`,
        payload: {
          code: blocker!.code,
          object: blocker!.object?.name ?? null,
          reason: 'Trying to run past something that makes the migration impossible.',
        },
        headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
      });
      expect(res.statusCode, 'refused').toBeGreaterThanOrEqual(400);
      expect(res.body, 'and the refusal explains that running is not possible').toMatch(
        /cannot be overridden|not possible/i,
      );
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
