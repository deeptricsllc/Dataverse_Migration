import { afterEach, describe, expect, it } from 'vitest';
import { SIGN_IN_FAILURES } from '../../shared/sign-in-failures';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The sign-in paths as the deployment actually serves them.
 *
 * `tests/unit/auth-configuration.test.ts` says what a configuration means. This says what the
 * running server does with it: who may read the configuration, and what a visitor is handed when a
 * sign-in fails. The second half exists because a prospect reading an internal instruction is a
 * worse outcome than a prospect who simply cannot get in.
 */

/** demoSignIn with no name always produces this address, so it can be made an operator. */
const DEMO_EMAIL = 'demo.user@deeptrics.demo';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('the sign-in configuration endpoint', () => {
  it('is refused to an ordinary user, in a sentence that names nothing internal', async () => {
    t = await createTestApp();
    const api = new ApiClient(t.app);
    await api.demoLogin();

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/platform/auth-configuration',
      headers: { cookie: api.cookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toMatch(/ENTRA_|ALLOWED_TENANT_IDS|ACCESS_MODE|AADSTS/);
  });

  it('is refused to someone who is not signed in at all', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/platform/auth-configuration' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('tells an operator what will be refused, without repeating a secret', async () => {
    const secret = 'integration-test-client-secret-value';
    t = await createTestApp({
      ADMIN_EMAILS: DEMO_EMAIL,
      ENTRA_CLIENT_ID: '69bc3659-2653-41e5-a4b7-c56676945265',
      ENTRA_CLIENT_SECRET: secret,
      APP_BASE_URL: 'https://migrate.example.com',
      // The QA deployment's configuration: an authority that resolves the user's own directory, and
      // GATED admission with nobody listed.
    });
    const api = new ApiClient(t.app);
    await api.demoLogin();

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/platform/auth-configuration',
      headers: { cookie: api.cookie },
    });

    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.authority.directory).toBe('organizations');
    expect(report.authority.resolvesHomeDirectoryOfUser).toBe(true);
    expect(report.admission.admitsNobody).toBe(true);
    expect(report.findings.map((f: { code: string }) => f.code)).toContain('GATED_WITH_EMPTY_ALLOW_LIST');
    expect(report.anySignInPossible).toBe(true); // demo sign-in is on in tests
    expect(res.body).not.toContain(secret);
    expect(report.clientIdentity.secretPresent).toBe(true);
  });
});

describe('the authority is the deployment’s, never a customer’s from the allow list', () => {
  it('sends authentication to ENTRA_TENANT_ID even when other directories are admitted', async () => {
    /**
     * The failure this rules out: solving gated access by sending authentication wherever the allow
     * list happens to point. That would ask one customer's directory to vouch for another
     * customer's user. Here the authority and the allow list name *different* directories on
     * purpose, and the authorize URL the browser is actually redirected to must contain only the
     * authority.
     */
    const AUTHORITY_DIRECTORY = '0eca5595-e632-4812-8f30-2b25ca91f1ff';
    const ADMITTED_DIRECTORY = '11111111-2222-4333-8444-555555555555';
    t = await createTestApp({
      ENTRA_CLIENT_ID: '00000000-0000-0000-0000-00000000abcd',
      ENTRA_CLIENT_SECRET: 'not-a-real-secret',
      ENTRA_TENANT_ID: AUTHORITY_DIRECTORY,
      ALLOWED_TENANT_IDS: `${ADMITTED_DIRECTORY},99999999-8888-4777-8666-555544443333`,
      ACCESS_MODE: 'GATED',
      APP_BASE_URL: 'https://migrate.example.com',
    });

    const res = await t.app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);

    expect(new URL(location).pathname).toBe(`/${AUTHORITY_DIRECTORY}/oauth2/v2.0/authorize`);
    expect(location).not.toContain(ADMITTED_DIRECTORY);
    expect(location).not.toContain('99999999-8888-4777-8666-555544443333');
    expect(location).not.toContain('not-a-real-secret');
  });
});

describe('what a visitor is handed when a sign-in fails', () => {
  it('turns a declined consent into a code, not into Microsoft’s own words', async () => {
    t = await createTestApp();
    const res = await t.app.inject({
      method: 'GET',
      url:
        '/api/auth/callback?error=access_denied&error_description=' +
        encodeURIComponent(
          'AADSTS65004: User declined to consent to access the app. Trace ID: 1234. Set ENTRA_CLIENT_ID.',
        ),
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=ACCESS_DENIED');
    // The description Microsoft sent is logged and does not travel to the browser.
    expect(res.headers.location).not.toMatch(/AADSTS|ENTRA_|Trace ID/);
  });

  it('turns an expired or replayed sign-in into EXPIRED without a lookup succeeding', async () => {
    t = await createTestApp();
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/callback?code=an-authorization-code&state=a-state-nobody-issued',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=EXPIRED');
  });

  it('turns a callback with nothing in it into INCOMPLETE', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/callback' });
    expect(res.headers.location).toBe('/login?error=INCOMPLETE');
  });

  it('never redirects with a sentence, so a crafted link cannot choose the wording', async () => {
    t = await createTestApp();
    const crafted = encodeURIComponent('Your account is locked. Call 0800 555 0199.');
    const res = await t.app.inject({ method: 'GET', url: `/api/auth/callback?error=${crafted}` });

    // Whatever arrives, what leaves is one of the codes we defined.
    const location = String(res.headers.location);
    const code = new URL(location, 'https://example.com').searchParams.get('error')!;
    expect(code in SIGN_IN_FAILURES).toBe(true);
    expect(location).not.toContain('0800');
  });
});

describe('when Microsoft sign-in is not configured', () => {
  it('offers no sign-in link and refuses the route rather than half-starting a flow', async () => {
    t = await createTestApp(); // ENTRA_* empty
    const config = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(config.json().microsoftEnabled).toBe(false);

    const login = await t.app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(login.statusCode).toBe(404);
    expect(login.body).not.toMatch(/ENTRA_|README|Railway/);
  });
});
