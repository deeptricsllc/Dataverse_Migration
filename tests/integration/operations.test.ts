import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { jobs } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * What an operator is told while a pilot is running.
 *
 * The questions here are the ones somebody asks at two in the morning, so each check has to answer with
 * a verdict **and** the number it was derived from — a check that says OK while the number beside it says
 * otherwise is worse than no check. These cases drive the deployment into each state and read the answer
 * back.
 */
const DEMO_EMAIL = 'demo.user@deeptrics.demo';

describe('operational diagnostics', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let organizationId: string;

  beforeAll(async () => {
    t = await createTestApp({ ADMIN_EMAILS: DEMO_EMAIL });
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
  }, 180_000);
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  const report = () => api.get('/api/platform/operations');

  it('is operator-only, and says so without naming internals', async () => {
    const other = await createTestApp(); // nobody is an operator here
    try {
      const client = new ApiClient(other.app);
      await client.demoLogin();
      const res = await other.app.inject({
        method: 'GET',
        url: '/api/platform/operations',
        headers: { cookie: client.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toMatch(/DATABASE_URL|password|secret/i);
    } finally {
      await other.close();
    }
  });

  it('answers every question it claims to, with the number the verdict came from', async () => {
    const r = await report();

    expect(r.worst).toBeTruthy();
    expect(r.build.version, 'which build is answering').toBeTruthy();
    expect(r.checkedAt).toBeTruthy();

    // The questions the brief asks an operator to be able to answer.
    const keys = r.checks.map((c: { key: string }) => c.key);
    for (const key of [
      'DATABASE',
      'JOBS_RUNNING',
      'JOBS_STUCK',
      'QUEUE_BACKLOG',
      'RETRIES',
      'UNRESOLVED_WRITES',
      'STORAGE',
      'WORKSPACE_CLEANUP',
    ]) {
      expect(keys, key).toContain(key);
    }

    for (const check of r.checks) {
      expect(check.question, `${check.key} has no question`).toMatch(/\?$/);
      expect(['OK', 'ATTENTION', 'FAILING', 'UNKNOWN']).toContain(check.status);
      // The detail has to carry a figure, so the verdict can be disagreed with.
      expect(check.detail, `${check.key} gives no number`).toMatch(/\d/);
      // And anything that is not OK has to say what to do about it.
      if (check.status !== 'OK') {
        expect(check.action, `${check.key} is ${check.status} with no action`).toBeTruthy();
      }
    }

    // A healthy deployment with nothing running reports no attention anywhere.
    expect(r.checks.find((c: { key: string }) => c.key === 'DATABASE').status).toBe('OK');
  });

  it('notices a job that stopped heartbeating, which is what stuck looks like', async () => {
    const before = await report();
    expect(before.checks.find((c: { key: string }) => c.key === 'JOBS_STUCK').status).toBe('OK');

    // A job left RUNNING with an old heartbeat: the shape a worker that died leaves behind.
    await t.services.db.insert(jobs).values({
      organizationId,
      type: 'MIGRATION',
      targetId: '00000000-0000-4000-9000-000000000001',
      status: 'RUNNING',
      lockedBy: 'a-worker-that-is-gone',
      heartbeatAt: new Date(Date.now() - 10 * 60_000),
    });

    const after = await report();
    const stuck = after.checks.find((c: { key: string }) => c.key === 'JOBS_STUCK');
    expect(stuck.status).toBe('ATTENTION');
    expect(stuck.detail).toMatch(/1 job\(s\)/);
    expect(stuck.action, 'and says what it means').toMatch(/worker/i);
    expect(after.worst).toBe('ATTENTION');

    await t.services.db.delete(jobs).where(eq(jobs.lockedBy, 'a-worker-that-is-gone'));
    expect((await report()).checks.find((c: { key: string }) => c.key === 'JOBS_STUCK').status).toBe('OK');
  });

  it('notices a queue that is not moving', async () => {
    await t.services.db.insert(jobs).values({
      organizationId,
      type: 'VALIDATION',
      targetId: '00000000-0000-4000-9000-000000000002',
      status: 'QUEUED',
      createdAt: new Date(Date.now() - 60 * 60_000),
    });

    const backlog = (await report()).checks.find((c: { key: string }) => c.key === 'QUEUE_BACKLOG');
    expect(backlog.status).toBe('ATTENTION');
    expect(backlog.detail).toMatch(/waited \d+ minute/);

    await t.services.db.delete(jobs).where(eq(jobs.status, 'QUEUED'));
  });

  it('counts a real migration’s rows under storage, so growth is visible', async () => {
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    const before = await report();
    const storageBefore = before.checks.find((c: { key: string }) => c.key === 'STORAGE').detail;

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Operations ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region'],
    });
    await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);

    const after = await report();
    const storage = after.checks.find((c: { key: string }) => c.key === 'STORAGE');
    expect(storage.detail).not.toBe(storageBefore);
    expect(storage.detail).toMatch(/identity map [\d,]+ rows/);
    // Nothing is wrong with growth, so it is not an alarm — it is a reading to compare.
    expect(storage.status).toBe('OK');
    expect(storage.action, 'and says why there is no threshold').toMatch(/depends on what was migrated/i);

    // A completed run leaves nothing waiting for a person.
    const unresolved = after.checks.find((c: { key: string }) => c.key === 'UNRESOLVED_WRITES');
    expect(unresolved.status).toBe('OK');
    expect(unresolved.detail).toMatch(/0 record\(s\)/);
  }, 300_000);
});
