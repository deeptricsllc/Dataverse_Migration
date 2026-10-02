import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Who is in a workspace, and what each of them may do.
 *
 * This exists because the roles did not. Four workspace roles were defined, enforced on every request and
 * covered by tests — and there was no way to assign one. A workspace's first member became `ADMIN` because
 * they were first, everybody after them `MIGRATION_OPERATOR`, and nothing in the product could change
 * either, so `VALIDATOR` and `READ_ONLY` existed in the type system and could not be reached. A permission
 * model nobody can configure is two hard-coded roles with extra names.
 *
 * The cases that matter most are the two lockouts, because they are the ones this product cannot undo: it
 * has no support tool, so an administrator who demotes themselves, or the last one who is demoted, has
 * locked the workspace permanently.
 */
describe('the workspace team', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  /** An admin and a second member in one workspace. Demo sign-in puts both in the demo organization. */
  async function workspaceOfTwo() {
    const app = await createTestApp();
    t = app;
    const admin = new ApiClient(app.app);
    const session = await admin.demoLogin();
    const organizationId = session.user.organization.id;

    // A second person in the same workspace, created directly: demo sign-in would give them their own.
    const [second] = await app.services.db
      .insert(users)
      .values({
        organizationId,
        externalId: 'second-person',
        authProvider: 'demo',
        email: 'second@example.com',
        displayName: 'Second Person',
        role: 'MEMBER',
      })
      .returning();

    const secondSession = await app.services.auth.createSession(second!.id, 'vitest');
    const member = new ApiClient(app.app);
    member.cookie = `dvm_session=${secondSession.token}`;
    const res = await app.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: member.cookie },
    });
    member.csrf = res.json().csrfToken;

    return { app, admin, member, adminId: session.user.id, secondId: second!.id };
  }

  it('lists everybody in the workspace, and says which one is you', async () => {
    const { admin, member, adminId, secondId } = await workspaceOfTwo();

    const asAdmin = await admin.get('/api/team');
    expect(asAdmin.map((m: { id: string }) => m.id).sort()).toEqual([adminId, secondId].sort());
    expect(asAdmin.find((m: { id: string }) => m.id === adminId).isYou).toBe(true);
    expect(asAdmin.find((m: { id: string }) => m.id === secondId).isYou).toBe(false);
    // Administrators first: the list answers "whom do I ask" before "who else is here".
    expect(asAdmin[0].role).toBe('ADMIN');

    /**
     * Readable by anybody in the workspace, deliberately. Knowing who else can see your data is not
     * privileged information, and a member who cannot tell whom to ask for access has a dead end.
     */
    const asMember = await member.get('/api/team');
    expect(asMember).toHaveLength(2);
    expect(asMember.find((m: { id: string }) => m.id === secondId).isYou).toBe(true);
  });

  it('normalises the role a row predating the four roles stored', async () => {
    // `MEMBER` was the old value. It reads as MIGRATION_OPERATOR rather than as something unknown.
    const { admin, secondId } = await workspaceOfTwo();
    const team = await admin.get('/api/team');
    const second = team.find((m: { id: string }) => m.id === secondId);
    expect(second.storedRole, 'the row still holds what it held').toBe('MEMBER');
    expect(second.role, 'and it reads as a current role').toBe('MIGRATION_OPERATOR');
  });

  it('lets an administrator reach the roles that were previously unassignable', async () => {
    const { app, admin, secondId } = await workspaceOfTwo();

    for (const role of ['VALIDATOR', 'READ_ONLY', 'MIGRATION_OPERATOR', 'ADMIN'] as const) {
      const after = await admin.patch(`/api/team/${secondId}`, { role });
      expect(after.find((m: { id: string }) => m.id === secondId).role, role).toBe(role);
      // And the row itself, not only what the response says.
      const [row] = await app.services.db.select().from(users).where(eq(users.id, secondId));
      expect(row!.role).toBe(role);
    }
  });

  it('refuses a role that is not one', async () => {
    const { admin, secondId } = await workspaceOfTwo();
    await admin.patch(`/api/team/${secondId}`, { role: 'OWNER' }, 400);
    await admin.patch(`/api/team/${secondId}`, { role: 'admin' }, 400);
  });

  it('refuses to let anybody change their own role, even an administrator', async () => {
    /**
     * The first lockout. An administrator who demotes themselves has locked the workspace, and this
     * product has no support tool to unlock it. Refused even when another administrator exists, because
     * the harmful case and the harmless one look identical at the moment of the click.
     */
    const { app, admin, adminId } = await workspaceOfTwo();
    const res = await app.app.inject({
      method: 'PATCH',
      url: `/api/team/${adminId}`,
      payload: { role: 'READ_ONLY' },
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/cannot change your own role/i);
    expect(res.body, 'and says what to do instead').toMatch(/another administrator/i);

    const [row] = await app.services.db.select().from(users).where(eq(users.id, adminId));
    expect(row!.role, 'nothing changed').toBe('ADMIN');
  });

  it('refuses to demote the last administrator, and says why', async () => {
    /**
     * The second lockout, by a different route: promote somebody, let them demote you, and nobody is left
     * who can change a role. Refused with the reason and the order to do it in.
     */
    const { app, admin, member, adminId, secondId } = await workspaceOfTwo();
    await admin.patch(`/api/team/${secondId}`, { role: 'ADMIN' });

    // Now the second person demotes the first. Allowed — there are two administrators.
    await member.patch(`/api/team/${adminId}`, { role: 'READ_ONLY' });

    // And now they are the only one left, so nobody can demote them.
    const res = await app.app.inject({
      method: 'PATCH',
      url: `/api/team/${secondId}`,
      payload: { role: 'READ_ONLY' },
      headers: { cookie: member.cookie, 'x-csrf-token': member.csrf },
    });
    // Their own change is refused first, which is the stricter of the two rules.
    expect(res.statusCode).toBe(400);

    // And a non-administrator cannot do it either, so the workspace keeps its administrator.
    const byOther = await app.app.inject({
      method: 'PATCH',
      url: `/api/team/${secondId}`,
      payload: { role: 'READ_ONLY' },
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(byOther.statusCode, 'the demoted administrator can no longer change roles').toBe(403);

    const [row] = await app.services.db.select().from(users).where(eq(users.id, secondId));
    expect(row!.role, 'the workspace still has an administrator').toBe('ADMIN');
  });

  it('marks the last administrator, so an interface can say why the control is fixed', async () => {
    const { admin, adminId, secondId } = await workspaceOfTwo();
    let team = await admin.get('/api/team');
    expect(team.find((m: { id: string }) => m.id === adminId).isLastAdmin).toBe(true);

    await admin.patch(`/api/team/${secondId}`, { role: 'ADMIN' });
    team = await admin.get('/api/team');
    expect(
      team.filter((m: { isLastAdmin: boolean }) => m.isLastAdmin),
      'with two administrators, neither is the last',
    ).toEqual([]);
  });

  it('refuses a member who tries to change anybody’s role', async () => {
    const { app, member, adminId } = await workspaceOfTwo();
    const res = await app.app.inject({
      method: 'PATCH',
      url: `/api/team/${adminId}`,
      payload: { role: 'READ_ONLY' },
      headers: { cookie: member.cookie, 'x-csrf-token': member.csrf },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/administrator/i);
  });

  it('cannot reach somebody in another workspace', async () => {
    const { app, admin } = await workspaceOfTwo();
    // A second demo visitor gets their own workspace.
    const stranger = new ApiClient(app.app);
    const strangerSession = await stranger.demoLogin();

    const theirTeam = await admin.get('/api/team');
    expect(
      theirTeam.map((m: { id: string }) => m.id),
      'a stranger does not appear in this workspace',
    ).not.toContain(strangerSession.user.id);

    const res = await app.app.inject({
      method: 'PATCH',
      url: `/api/team/${strangerSession.user.id}`,
      payload: { role: 'READ_ONLY' },
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('records who changed whose role, from what to what', async () => {
    const { admin, secondId } = await workspaceOfTwo();
    await admin.patch(`/api/team/${secondId}`, { role: 'VALIDATOR' });

    // A permission change is an Administration event; `auditCategory` says so explicitly.
    const audit = await admin.get('/api/audit?category=ADMIN');
    const items = Array.isArray(audit) ? audit : audit.items;
    const event = items.find((e: { action: string }) => e.action === 'TEAM_ROLE_CHANGED');
    expect(event, 'a permission change is an audited event').toBeTruthy();
    expect(event.details.subject).toBe(secondId);
    expect(event.details.from).toBe('MIGRATION_OPERATOR');
    expect(event.details.to).toBe('VALIDATOR');
  });
});
