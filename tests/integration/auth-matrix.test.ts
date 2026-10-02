import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AppError } from '../../server/src/lib/errors';
import { authRequests, organizations, users } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The authentication matrix, from the identity provider's answer to the role the request runs under.
 *
 * **What is real here and what is not.** Everything from `completeMicrosoftSignIn` inwards is the
 * product's own code, unmodified: the single-use state, the nonce comparison, the admission gate, the
 * organization resolved by tenant id, the user resolved by object id, the role, the session cookie,
 * and every authorization decision afterwards. What is simulated is exactly one thing — the claims
 * Microsoft would have returned. `redeemCode` is replaced with a function that hands back a chosen
 * tenant id, object id and email, because redeeming a real authorization code needs Microsoft and a
 * real secret, neither of which belongs in CI.
 *
 * So these cases prove our boundary behaves correctly *given* a verified identity. They do not prove
 * that Microsoft verified it. That part is proven by the configuration matrix in
 * `tests/unit/auth-configuration.test.ts`, by the authorize URL assertions in
 * `tests/integration/sign-in-paths.test.ts`, and ultimately only by signing in against a real
 * directory — which is recorded in docs/MICROSOFT_SETUP.md rather than asserted here.
 *
 * The nonce is read from the row the product itself wrote, so the comparison is a real comparison
 * rather than one both sides skip.
 */

const DIRECTORY_A = '0eca5595-e632-4812-8f30-2b25ca91f1ff';
const DIRECTORY_B = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = '00000000-0000-0000-0000-00000000abcd';

interface Identity {
  tenantId: string;
  objectId: string;
  email: string | null;
  displayName?: string;
}

let t: TestApp;

/** A deployment with Microsoft sign-in configured. Admission is whatever the case asks for. */
async function deployment(overrides: Record<string, string> = {}) {
  t = await createTestApp({
    ENTRA_CLIENT_ID: CLIENT_ID,
    ENTRA_CLIENT_SECRET: 'not-a-real-secret',
    ENTRA_TENANT_ID: DIRECTORY_A,
    APP_BASE_URL: 'https://migrate.example.com',
    ACCESS_MODE: 'GATED',
    ALLOWED_TENANT_IDS: DIRECTORY_A,
    ...overrides,
  });
  return t;
}

/**
 * Drives one whole sign-in: the product issues the state and nonce, the identity provider is
 * simulated, and the product completes it. Returns the user id, or throws what the product threw.
 */
async function signIn(identity: Identity): Promise<string> {
  const url = await t.services.auth.beginMicrosoftSignIn('/');
  const state = new URL(url).searchParams.get('state')!;
  const [pending] = await t.services.db.select().from(authRequests).where(eq(authRequests.state, state));

  t.services.identity.redeemCode = async () => ({
    tenantId: identity.tenantId,
    objectId: identity.objectId,
    homeAccountId: `${identity.objectId}.${identity.tenantId}`,
    displayName: identity.displayName ?? 'Simulated User',
    email: identity.email,
    // The nonce the product itself issued, so its own check is exercised rather than bypassed.
    nonce: pending!.nonce,
    serializedCache: '{}',
  });

  const { userId } = await t.services.auth.completeMicrosoftSignIn(
    { code: 'a-simulated-authorization-code', state },
    'test-request',
  );
  return userId;
}

/** A browser-equivalent client for a signed-in user. */
async function clientFor(userId: string): Promise<ApiClient> {
  const session = await t.services.auth.createSession(userId, 'vitest');
  const api = new ApiClient(t.app);
  api.cookie = `dvm_session=${session.token}`;
  const res = await t.app.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { cookie: api.cookie },
  });
  api.csrf = res.json().csrfToken;
  return api;
}

const expectRefusal = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
};

afterEach(async () => {
  await t?.close();
  t = undefined as unknown as TestApp;
});

describe('authentication matrix', () => {
  // 1 ------------------------------------------------------------------------
  it('case 1: a listed directory signs in, and gets a workspace of its own', async () => {
    await deployment();
    const userId = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-first-person',
      email: 'first@contoso.com',
      displayName: 'First Person',
    });

    const api = await clientFor(userId);
    const session = await api.get('/api/auth/session');
    expect(session.user.organization.id).toBeTruthy();
    expect(session.user.email).toBe('first@contoso.com');
    expect(session.user.authProvider).toBe('microsoft');
    // The organization is keyed on the verified tenant id, not on the email domain.
    const [org] = await t.services.db
      .select()
      .from(organizations)
      .where(eq(organizations.entraTenantId, DIRECTORY_A));
    expect(org.id).toBe(session.user.organization.id);
  });

  // 2 ------------------------------------------------------------------------
  it('case 2: an authenticated but unlisted directory is refused, and leaves nothing behind', async () => {
    await deployment({ ALLOWED_TENANT_IDS: DIRECTORY_A });

    await expectRefusal(
      signIn({ tenantId: DIRECTORY_B, objectId: 'oid-outsider', email: 'someone@other.example' }),
      'TENANT_NOT_ALLOWED',
    );

    // The refusal happens before any workspace exists. A tenant we turned away must not be able to
    // leave an organization row behind simply by trying — otherwise a later change of mind, or a
    // bug, would find a half-built workspace waiting.
    const orgs = await t.services.db
      .select()
      .from(organizations)
      .where(eq(organizations.entraTenantId, DIRECTORY_B));
    expect(orgs).toEqual([]);
    const everyone = await t.services.db.select().from(users);
    expect(everyone.filter((u) => u.externalId === 'oid-outsider')).toEqual([]);
  });

  // 3 ------------------------------------------------------------------------
  it('case 3: GATED with an empty allow list refuses everybody, including the obvious tenant', async () => {
    await deployment({ ALLOWED_TENANT_IDS: '' });

    // Even the directory this deployment authenticates against is refused, because admission is a
    // separate decision and nobody made it. This is the second half of the QA failure.
    await expectRefusal(
      signIn({ tenantId: DIRECTORY_A, objectId: 'oid-a', email: 'a@contoso.com' }),
      'TENANT_NOT_ALLOWED',
    );
    await expectRefusal(
      signIn({ tenantId: DIRECTORY_B, objectId: 'oid-b', email: 'b@other.example' }),
      'TENANT_NOT_ALLOWED',
    );
  });

  // 4 ------------------------------------------------------------------------
  it('case 4: with no client configuration there is no sign-in to start, and no half-built flow', async () => {
    t = await createTestApp(); // ENTRA_* empty, demo sign-in only

    const config = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(config.json().microsoftEnabled).toBe(false);
    const login = await t.app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(login.statusCode).toBe(404);

    // And nothing was written on the way to refusing: no state row to be replayed later.
    expect(await t.services.db.select().from(authRequests)).toEqual([]);
  });

  // 5 ------------------------------------------------------------------------
  it('case 5: the second person from a directory joins the existing workspace as a member', async () => {
    await deployment();
    const firstId = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-founder',
      email: 'founder@contoso.com',
    });
    const secondId = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-colleague',
      email: 'colleague@contoso.com',
    });

    expect(secondId).not.toBe(firstId);
    const first = await clientFor(firstId).then((c) => c.get('/api/auth/session'));
    const second = await clientFor(secondId).then((c) => c.get('/api/auth/session'));

    // One organization, resolved rather than recreated.
    expect(second.user.organization.id).toBe(first.user.organization.id);
    const orgs = await t.services.db
      .select()
      .from(organizations)
      .where(eq(organizations.entraTenantId, DIRECTORY_A));
    expect(orgs).toHaveLength(1);

    // The first person administers it; the second does not inherit that by arriving.
    expect(first.user.role).toBe('ADMIN');
    expect(second.user.role).not.toBe('ADMIN');
  });

  // 6 ------------------------------------------------------------------------
  it('case 6: a returning person is the same user, not a second one, and keeps their role', async () => {
    await deployment();
    const firstVisit = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-returning',
      email: 'returning@contoso.com',
      displayName: 'Returning Person',
    });
    // Demoted between visits, to prove the role is not reset by signing in again.
    await t.services.db.update(users).set({ role: 'VALIDATOR' }).where(eq(users.id, firstVisit));

    const secondVisit = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-returning',
      email: 'returning@contoso.com',
      displayName: 'Returning Person (renamed)',
    });

    expect(secondVisit).toBe(firstVisit);
    const rows = await t.services.db.select().from(users).where(eq(users.externalId, 'oid-returning'));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('VALIDATOR');
    expect(rows[0].lastLoginAt).toBeTruthy();
  });

  // 7 ------------------------------------------------------------------------
  it('case 7: the role comes from the workspace, and operator status from the deployment', async () => {
    await deployment({ ADMIN_EMAILS: 'operator@contoso.com' });

    // Signed in second, so being an operator is not a side effect of being first.
    const memberId = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-member',
      email: 'member@contoso.com',
    });
    const operatorId = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-operator',
      email: 'operator@contoso.com',
    });

    const member = await clientFor(memberId).then((c) => c.get('/api/auth/session'));
    const operator = await clientFor(operatorId).then((c) => c.get('/api/auth/session'));

    expect(member.user.platformOperator).toBe(false);
    expect(operator.user.platformOperator).toBe(true);
    // Being an operator of the deployment is not the same as administering a workspace: the member
    // was first, so the member is the administrator here.
    expect(member.user.role).toBe('ADMIN');

    const memberApi = await clientFor(memberId);
    const operatorApi = await clientFor(operatorId);
    await memberApi.get('/api/platform/auth-configuration', 403);
    await operatorApi.get('/api/platform/auth-configuration', 200);
  });

  // 8 ------------------------------------------------------------------------
  it('case 8: one directory cannot see another directory’s work', async () => {
    await deployment({ ALLOWED_TENANT_IDS: `${DIRECTORY_A},${DIRECTORY_B}` });
    const aId = await signIn({ tenantId: DIRECTORY_A, objectId: 'oid-a', email: 'a@contoso.com' });
    const bId = await signIn({ tenantId: DIRECTORY_B, objectId: 'oid-b', email: 'b@fabrikam.com' });

    const a = await clientFor(aId);
    const b = await clientFor(bId);

    const aSession = await a.get('/api/auth/session');
    const bSession = await b.get('/api/auth/session');
    expect(aSession.user.organization.id).not.toBe(bSession.user.organization.id);

    const project = await a.post('/api/projects', { name: 'Contoso migration', kind: 'MIGRATION' });

    // A's project is A's. Not listed, and not readable by id even when the id is known.
    const bList = await b.get('/api/projects');
    const bItems = Array.isArray(bList) ? bList : bList.items;
    expect(bItems.map((p: { id: string }) => p.id)).not.toContain(project.id);

    const direct = await t.app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}`,
      headers: { cookie: b.cookie },
    });
    expect([403, 404]).toContain(direct.statusCode);
    expect(direct.body).not.toContain('Contoso migration');

    // And A can still read it, so the isolation is isolation and not a broken read.
    expect((await a.get(`/api/projects/${project.id}`)).name).toBe('Contoso migration');
  });

  // 9 ------------------------------------------------------------------------
  it('case 9: a request with no session, a forged one, or an expired one is refused', async () => {
    await deployment();
    const userId = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-session',
      email: 'session@contoso.com',
    });
    const real = await clientFor(userId);

    const noCookie = await t.app.inject({ method: 'GET', url: '/api/projects' });
    expect(noCookie.statusCode).toBe(401);

    const forged = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: 'dvm_session=not-a-token-anybody-issued' },
    });
    expect(forged.statusCode).toBe(401);

    // A real session, then destroyed: the cookie stops working rather than outliving the session.
    const session = await t.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: real.cookie },
    });
    expect(session.json().user).toBeTruthy();
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: real.cookie, 'x-csrf-token': real.csrf },
    });
    const after = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: real.cookie },
    });
    expect(after.statusCode).toBe(401);

    // A write with a valid session but no CSRF token is refused too.
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'No CSRF', kind: 'MIGRATION' },
      headers: { cookie: (await clientFor(userId)).cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  // 10 -----------------------------------------------------------------------
  it('case 10: a read-only member may read everything and change nothing', async () => {
    await deployment();
    const adminId = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-admin',
      email: 'admin@contoso.com',
    });
    const readerId = await signIn({
      tenantId: DIRECTORY_A,
      objectId: 'oid-reader',
      email: 'reader@contoso.com',
    });
    await t.services.db.update(users).set({ role: 'READ_ONLY' }).where(eq(users.id, readerId));

    const admin = await clientFor(adminId);
    const reader = await clientFor(readerId);
    const project = await admin.post('/api/projects', { name: 'Readable', kind: 'MIGRATION' });

    // Reading is the whole point of the role.
    expect((await reader.get('/api/auth/session')).user.role).toBe('READ_ONLY');
    expect((await reader.get(`/api/projects/${project.id}`)).name).toBe('Readable');

    // Writing is refused, and the refusal says what the role cannot do rather than failing obscurely.
    const create = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Should not exist', kind: 'MIGRATION' },
      headers: { cookie: reader.cookie, 'x-csrf-token': reader.csrf },
    });
    expect(create.statusCode).toBe(403);
    await reader.patch(`/api/projects/${project.id}`, { name: 'Renamed by a reader' }, 403);

    // And nothing changed.
    expect((await admin.get(`/api/projects/${project.id}`)).name).toBe('Readable');
    const all = await admin.get('/api/projects');
    const items = Array.isArray(all) ? all : all.items;
    expect(items.map((p: { name: string }) => p.name)).not.toContain('Should not exist');
  });
});

describe('what the simulated identity provider does not prove', () => {
  it('still refuses a sign-in whose nonce does not match the one issued', async () => {
    /**
     * The one check the simulation could silently disable, so it is asserted directly: if the stub
     * returns somebody else's nonce, the product must refuse. Without this, every case above would
     * pass with the nonce comparison deleted.
     */
    await deployment();
    const url = await t.services.auth.beginMicrosoftSignIn('/');
    const state = new URL(url).searchParams.get('state')!;

    t.services.identity.redeemCode = async () => ({
      tenantId: DIRECTORY_A,
      objectId: 'oid-nonce',
      homeAccountId: 'oid-nonce.tenant',
      displayName: 'Nonce Mismatch',
      email: 'nonce@contoso.com',
      nonce: 'a-nonce-this-deployment-never-issued',
      serializedCache: '{}',
    });

    await expect(
      t.services.auth.completeMicrosoftSignIn({ code: 'code', state }, 'test-request'),
    ).rejects.toMatchObject({ code: 'INVALID_NONCE' });
  });

  it('refuses a state that has already been spent, so a callback cannot be replayed', async () => {
    await deployment();
    const url = await t.services.auth.beginMicrosoftSignIn('/');
    const state = new URL(url).searchParams.get('state')!;
    const [pending] = await t.services.db.select().from(authRequests).where(eq(authRequests.state, state));
    t.services.identity.redeemCode = async () => ({
      tenantId: DIRECTORY_A,
      objectId: 'oid-replay',
      homeAccountId: 'oid-replay.tenant',
      displayName: 'Replay',
      email: 'replay@contoso.com',
      nonce: pending!.nonce,
      serializedCache: '{}',
    });

    await t.services.auth.completeMicrosoftSignIn({ code: 'code', state }, 'test-request');
    // The same callback again: the state was single-use, so there is nothing left to redeem.
    await expect(
      t.services.auth.completeMicrosoftSignIn({ code: 'code', state }, 'test-request'),
    ).rejects.toBeInstanceOf(AppError);
  });
});
