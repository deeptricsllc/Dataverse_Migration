import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto } from '../../shared/domain';
import { classifyEnvironment, needsTypedConfirmation } from '../../shared/domain';
import { environments } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * How hard it is to confirm a write, and why that is not uniform.
 *
 * Typing the target's name is a good gate and a bad habit. Asked for on every run into a sandbox —
 * an environment that exists to be written to — it becomes muscle memory, and muscle memory is
 * exactly what you do not want on the one occasion the name is not the one you expected. So the
 * friction scales with the consequence.
 *
 * These tests pin both halves, because the risk of this change is that the production gate quietly
 * follows the sandbox one.
 */

describe('the rule itself', () => {
  it('asks for the name everywhere a mistake would be expensive', () => {
    expect(needsTypedConfirmation({ environmentClass: 'PRODUCTION' })).toBe(true);
    // Unclassified counts as production, for the same reason it does in the authorization policy:
    // "we could not tell" has to mean "assume it matters".
    expect(needsTypedConfirmation({ environmentClass: 'UNKNOWN' })).toBe(true);
    expect(needsTypedConfirmation({ environmentClass: 'NON_PRODUCTION' })).toBe(false);
  });
});

describe('executing a plan', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let qa: EnvironmentDto;
  let plan: MigrationPlanDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
    // EnvironmentDto carries the raw type; the class is derived from it wherever it is needed.
    expect(classifyEnvironment(qa.environmentType)).toBe('NON_PRODUCTION');
    plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Confirmation',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['dtx_office'],
    });
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });

  it('accepts a deliberate confirmation for a non-production target', async () => {
    const run = await api.post(`/api/plans/${plan.id}/execute`, {
      confirmed: true,
      acknowledgeWarnings: true,
    });
    expect(run).toHaveProperty('id');
  }, 60_000);

  it('still refuses a request that confirmed nothing at all', async () => {
    // The click is the confirmation, so its absence has to mean something. An empty body must not
    // execute a migration.
    await api.request('POST', `/api/plans/${plan.id}/execute`, { acknowledgeWarnings: true }, 400);
  });

  it('refuses a click once the target is production, and says why', async () => {
    // The same plan and the same person: only the target's classification changed.
    await t.services.db
      .update(environments)
      .set({ environmentType: 'Production' })
      .where(eq(environments.id, qa.id));
    try {
      const refused = await t.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/execute`,
        payload: { confirmed: true, acknowledgeWarnings: true } as never,
        headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
      });
      expect(refused.statusCode).toBe(400);
      // The refusal has to explain what changed, or it reads as a bug.
      expect(refused.json().error.message).toContain(qa.displayName);
      expect(refused.json().error.message).toMatch(/type its name/i);

      // A near-miss is not close enough.
      await api.request(
        'POST',
        `/api/plans/${plan.id}/execute`,
        { confirmSourceName: dev.displayName, confirmTargetName: 'Deeptrics qa', acknowledgeWarnings: true },
        400,
      );
    } finally {
      await t.services.db
        .update(environments)
        .set({ environmentType: 'Sandbox' })
        .where(eq(environments.id, qa.id));
    }
  }, 60_000);

  it('demands the exact name for a target nobody classified', async () => {
    // A hand-configured SQL connection carries no environment type at all.
    await t.services.db.update(environments).set({ environmentType: null }).where(eq(environments.id, qa.id));
    try {
      await api.request(
        'POST',
        `/api/plans/${plan.id}/execute`,
        { confirmed: true, acknowledgeWarnings: true },
        400,
      );
    } finally {
      await t.services.db
        .update(environments)
        .set({ environmentType: 'Sandbox' })
        .where(eq(environments.id, qa.id));
    }
  });
});

describe('executing into production', () => {
  let t: TestApp;
  let api: ApiClient;

  it('runs when the name is typed exactly', async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
    await t.services.db
      .update(environments)
      .set({ environmentType: 'Production' })
      .where(eq(environments.id, qa.id));
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Production cutover',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['dtx_office'],
    });

    const run = await api.post(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
      acknowledgeWarnings: true,
    });
    expect(run).toHaveProperty('id');
    await t.close();
  }, 180_000);
});

describe('creating a schedule', () => {
  let t: TestApp;
  let api: ApiClient;
  let plan: MigrationPlanDto;
  let qaId = '';

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
    qaId = qa.id;
    plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Scheduled',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['dtx_office'],
    });
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });

  it('follows the same rule as a manual run', async () => {
    const created = await api.post(`/api/plans/${plan.id}/schedules`, {
      cron: '0 4 * * *',
      confirmed: true,
    });
    expect(created).toHaveProperty('id');
    // Nothing confirmed at all is still refused.
    await api.request('POST', `/api/plans/${plan.id}/schedules`, { cron: '0 5 * * *' }, 400);

    // A schedule writes unattended and repeatedly, so a production target is the case this gate
    // exists for: it must not have been relaxed along with the manual one.
    await t.services.db
      .update(environments)
      .set({ environmentType: 'Production' })
      .where(eq(environments.id, qaId));
    try {
      await api.request(
        'POST',
        `/api/plans/${plan.id}/schedules`,
        { cron: '0 6 * * *', confirmed: true },
        400,
      );
    } finally {
      await t.services.db
        .update(environments)
        .set({ environmentType: 'Sandbox' })
        .where(eq(environments.id, qaId));
    }
  }, 60_000);
});
