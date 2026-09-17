import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

describe('run control: pause, resume, cancel, retry', () => {
  let t: TestApp;
  let api: ApiClient;
  let plan: MigrationPlanDto;
  let worker: ReturnType<TestApp['services']['createWorker']>;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;
    plan = await api.post<MigrationPlanDto>('/api/plans', {
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'dtx_office'],
    });
  });
  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  const execute = () =>
    api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: 'DeepTrics Development',
      confirmTargetName: 'DeepTrics UAT',
      acknowledgeWarnings: true,
    });

  it('pauses before work starts and resumes to completion', async () => {
    const run = await execute();
    // Only one active run per target.
    await api.post(
      `/api/plans/${plan.id}/execute`,
      {
        confirmSourceName: 'DeepTrics Development',
        confirmTargetName: 'DeepTrics UAT',
        acknowledgeWarnings: true,
      },
      409,
    );
    await api.post(`/api/runs/${run.id}/pause`);
    await worker.drain();
    let current = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    expect(current.status).toBe('PAUSED');
    expect(current.created).toBe(0);
    await api.post(`/api/runs/${run.id}/retry`, {}, 409);
    await api.post(`/api/runs/${run.id}/resume`);
    await worker.drain();
    current = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    expect(current.status).toBe('COMPLETED');
    expect(current.created).toBe(21);
    await api.post(`/api/runs/${run.id}/cancel`, {}, 409);
  });

  it('cancels a queued run and can resume the remaining work', async () => {
    const run = await execute();
    const cancelled = await api.post<MigrationRunDto>(`/api/runs/${run.id}/cancel`);
    expect(cancelled.status).toBe('CANCELLED');
    await worker.drain();
    expect((await api.get<MigrationRunDto>(`/api/runs/${run.id}`)).status).toBe('CANCELLED');
    await api.post(`/api/runs/${run.id}/retry`);
    await worker.drain();
    const resumed = await api.get<MigrationRunDto>(`/api/runs/${run.id}`);
    // Everything already exists in the target from the previous run: skipped, never duplicated.
    expect(resumed).toMatchObject({ status: 'COMPLETED', created: 0, skipped: 21, attempt: 2 });
  });
});

describe('Microsoft sign-in endpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      ENTRA_CLIENT_ID: '00000000-0000-0000-0000-00000000abcd',
      ENTRA_CLIENT_SECRET: 'not-a-real-secret',
      ENTRA_TENANT_ID: 'organizations',
      APP_BASE_URL: 'http://localhost:3000',
    });
  });
  afterAll(() => t.close());

  it('advertises Microsoft sign-in and redirects with PKCE, state and nonce', async () => {
    const config = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(config.json()).toEqual({
      microsoftEnabled: true,
      demoEnabled: true,
      realTenantReadOnly: false,
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/login?returnTo=/compare' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe('https://login.microsoftonline.com');
    expect(location.pathname).toBe('/organizations/oauth2/v2.0/authorize');
    const p = location.searchParams;
    expect(p.get('client_id')).toBe('00000000-0000-0000-0000-00000000abcd');
    expect(p.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBeTruthy();
    expect(p.get('state')).toBeTruthy();
    expect(p.get('nonce')).toBeTruthy();
    expect(p.get('scope')).toContain('https://globaldisco.crm.dynamics.com/user_impersonation');
    expect(p.get('scope')).toContain('offline_access');
    expect(location.toString()).not.toContain('not-a-real-secret');
  });

  it('rejects callbacks with unknown state and surfaces provider errors safely', async () => {
    const bad = await t.app.inject({ method: 'GET', url: '/api/auth/callback?code=abc&state=unknown' });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers.location).toMatch(/^\/login\?error=/);
    expect(bad.headers['set-cookie']).toBeUndefined();
    const denied = await t.app.inject({ method: 'GET', url: '/api/auth/callback?error=access_denied' });
    expect(decodeURIComponent(denied.headers.location as string)).toContain('Consent was declined');
  });

  it('blocks open redirects in returnTo', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/login?returnTo=//evil.example' });
    expect(res.statusCode).toBe(302);
    const { safeReturnTo } = await import('../../server/src/auth/auth-service');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('/runs/1')).toBe('/runs/1');
  });
});
