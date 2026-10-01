import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessRequestDto, AuthConfigDto } from '../../shared/domain';
import { accessRequests } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The public sign-up path.
 *
 * `POST /api/access-requests` is the only route in the product an unauthenticated stranger may
 * write to, and `GET` on the same path returns every name and email address that has ever been
 * submitted. Those two facts together are the reason this file exists: the exemption that lets the
 * POST through must not also let the GET through, and the GET must not be readable by an
 * administrator of some customer organization who happens to be signed in.
 */

describe('submitting a request', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  /** A browser with no session and no CSRF token — which is the whole point. */
  const submit = (payload: unknown) =>
    t.app.inject({ method: 'POST', url: '/api/access-requests', payload: payload as never });

  const stored = () => t.services.db.select().from(accessRequests);

  it('accepts an anonymous request with no session and no CSRF token', async () => {
    const res = await submit({
      name: 'Dana Whitfield',
      email: 'Dana.Whitfield@Contoso.com',
      company: 'Contoso',
      useCase: 'A legacy CRM into Dataverse, about 2M rows.',
    });
    expect(res.statusCode).toBe(202);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    // Normalised, so "the same person" means the same row tomorrow.
    expect(rows[0].email).toBe('dana.whitfield@contoso.com');
    expect(rows[0].submissions).toBe(1);
  });

  it('tells the caller nothing about what it stored', async () => {
    const res = await submit({ name: 'Dana Whitfield', email: 'dana.whitfield@contoso.com' });
    // The identical answer for a new address and one already in the table: anything else is an
    // enumeration oracle for a form on the open internet.
    expect(res.json()).toEqual({ received: true });
  });

  it('counts a second ask instead of duplicating the person', async () => {
    await submit({
      name: 'Dana Whitfield',
      email: 'dana.whitfield@contoso.com',
      useCase: 'Still interested — now 40 tables.',
    });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].submissions).toBeGreaterThan(1);
    expect(rows[0].useCase).toContain('40 tables');
  });

  it('drops what the honeypot catches, without saying so', async () => {
    const before = (await stored()).length;
    const res = await submit({
      name: 'Definitely A Person',
      email: 'bot@spam-farm.net',
      website: 'https://buy-things.example',
    });
    expect(res.statusCode).toBe(202);
    expect((await stored()).length).toBe(before);
  });

  it('refuses an address it could not reply to, and a field longer than the column', async () => {
    const bad = await submit({ name: 'X', email: 'not-an-address' });
    expect(bad.statusCode).toBe(400);
    const huge = await submit({ name: 'X', email: 'x@contoso.com', useCase: 'a'.repeat(5000) });
    expect(huge.statusCode).toBe(400);
    const nameless = await submit({ name: '   ', email: 'x@contoso.com' });
    expect(nameless.statusCode).toBe(400);
  });

  it('does not keep the address that every smoke test uses', async () => {
    await submit({ name: 'Test', email: 'someone@example.com' });
    const rows = await stored();
    expect(rows.map((r) => r.email)).not.toContain('someone@example.com');
  });
});

describe('reading requests', () => {
  let t: TestApp;
  let api: ApiClient;
  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    await t.app.inject({
      method: 'POST',
      url: '/api/access-requests',
      payload: { name: 'Dana Whitfield', email: 'dana@contoso.com' } as never,
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('refuses an anonymous GET on the path whose POST is public', async () => {
    // The exemption is `POST /api/access-requests`, not `/api/access-requests`. Exempting the path
    // would have published every name and email address in the table.
    const res = await t.app.inject({ method: 'GET', url: '/api/access-requests' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an administrator who administers an organization rather than the deployment', async () => {
    // The demo user is an ADMIN. That is authority over their own organization's migrations; it is
    // not authority over other people's contact details.
    await api.request('GET', '/api/access-requests', undefined, 403);
    await api.request(
      'PATCH',
      '/api/access-requests/00000000-0000-0000-0000-000000000000',
      {
        handled: true,
      },
      403,
    );
  });
});

describe('reading requests as an operator of this deployment', () => {
  let t: TestApp;
  let api: ApiClient;
  beforeAll(async () => {
    // ADMIN_EMAILS is what makes somebody an operator, and it is deployment configuration rather
    // than anything a user can grant themselves.
    t = await createTestApp({ ADMIN_EMAILS: 'demo.user@deeptrics.demo' });
    api = new ApiClient(t.app);
    await api.demoLogin();
    await t.app.inject({
      method: 'POST',
      url: '/api/access-requests',
      payload: { name: 'Dana Whitfield', email: 'dana@contoso.com', company: 'Contoso' } as never,
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('lists them, and marks one handled', async () => {
    const list = await api.get<AccessRequestDto[]>('/api/access-requests');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: 'dana@contoso.com', company: 'Contoso', handledAt: null });

    await api.patch(`/api/access-requests/${list[0].id}`, { handled: true });
    const after = await api.get<AccessRequestDto[]>('/api/access-requests');
    expect(after[0].handledAt).not.toBeNull();
    expect(after[0].handledBy).toBe('Demo User');
  });

  it('reopens a handled request when the same person asks again', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/access-requests',
      payload: { name: 'Dana Whitfield', email: 'dana@contoso.com' } as never,
    });
    const after = await api.get<AccessRequestDto[]>('/api/access-requests');
    // Otherwise a follow-up from somebody we closed out disappears from the list entirely.
    expect(after[0].handledAt).toBeNull();
    expect(after[0].submissions).toBe(2);
  });
});

describe('what the landing page is told', () => {
  it('offers sign-up only when an unknown tenant would actually get in', async () => {
    // Configuring Microsoft sign-in and nothing else no longer admits the world. It used to: the
    // rule was "refuse if an allow-list excludes you", which with no list means "admit everybody",
    // so a deployment became an open beta because nobody set a variable. Advertising sign-up here
    // would now send visitors into a dead end, so it does not.
    const gated = await createTestApp({ ENTRA_CLIENT_ID: 'id', ENTRA_CLIENT_SECRET: 'secret' });
    const gatedConfig = (await gated.app.inject({ url: '/api/auth/config' })).json<AuthConfigDto>();
    expect(gatedConfig).toMatchObject({ microsoftEnabled: true, signUpEnabled: false });
    await gated.close();

    // Opening up is a deliberate setting, and then sign-up is worth advertising.
    const open = await createTestApp({
      ENTRA_CLIENT_ID: 'id',
      ENTRA_CLIENT_SECRET: 'secret',
      ACCESS_MODE: 'OPEN_BETA',
    });
    const openConfig = (await open.app.inject({ url: '/api/auth/config' })).json<AuthConfigDto>();
    expect(openConfig).toMatchObject({ microsoftEnabled: true, signUpEnabled: true });
    await open.close();

    // An allow-list is the gated case with names on it: known tenants in, strangers out, and no
    // invitation on the landing page either way.
    const closed = await createTestApp({
      ENTRA_CLIENT_ID: 'id',
      ENTRA_CLIENT_SECRET: 'secret',
      ALLOWED_TENANT_IDS: '11111111-1111-1111-1111-111111111111',
    });
    const closedConfig = (await closed.app.inject({ url: '/api/auth/config' })).json<AuthConfigDto>();
    expect(closedConfig).toMatchObject({ microsoftEnabled: true, signUpEnabled: false });
    await closed.close();
  });

  it('publishes a contact address only when the deployment was given one', async () => {
    const none = await createTestApp();
    expect(
      (await none.app.inject({ url: '/api/auth/config' })).json<AuthConfigDto>().contactEmail,
    ).toBeNull();
    await none.close();

    const set = await createTestApp({ CONTACT_EMAIL: 'hello@deeptrics.com' });
    expect((await set.app.inject({ url: '/api/auth/config' })).json<AuthConfigDto>().contactEmail).toBe(
      'hello@deeptrics.com',
    );
    await set.close();
  });
});
