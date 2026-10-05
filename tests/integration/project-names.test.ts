import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * A project name has to mean one project.
 *
 * Three projects called `Test_Analysis` could be created in one workspace, and a name that refers to three
 * things refers to none: navigation, exports, audit entries, run history and any support conversation all
 * become ambiguous at the same moment, and nothing in the product can tell you which `Test_Analysis` an
 * export came from.
 *
 * These cases cover the four ways a duplicate could arrive — creating, renaming, un-archiving, and two
 * requests racing — because a rule enforced on only the first of those is enforced most of the time, which
 * for an identifier is the same as not at all.
 */

describe('project names are unique per workspace', () => {
  let t: TestApp;
  let api: ApiClient;
  let organizationId: string;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
  });

  afterAll(async () => {
    await t?.close();
  });

  const create = (name: string, expect_ = 200) =>
    api.post<{ id: string; name: string }>('/api/projects', { name, kind: 'ANALYSIS' }, expect_);

  /** The body of a refusal, parsed, so the message can be read rather than guessed at. */
  const refusal = async (name: string) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name, kind: 'ANALYSIS' },
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    return { status: res.statusCode, body: res.json() as { error: { code: string; message: string } } };
  };

  it('accepts the first project of a given name', async () => {
    const project = await create('Customer Migration');
    expect(project.name).toBe('Customer Migration');
  });

  it('refuses a second project with the same name, and says which name', async () => {
    const { status, body } = await refusal('Customer Migration');
    expect(status).toBe(409);
    expect(body.error.message).toBe('A project named "Customer Migration" already exists in this workspace.');
  });

  /**
   * The point of the rule is that a person can tell two projects apart. Casing does not help them do
   * that, so it does not create a distinct name.
   */
  it('refuses a name that differs only in casing or surrounding space', async () => {
    for (const name of ['customer migration', 'CUSTOMER MIGRATION', '  Customer Migration  ']) {
      const { status } = await refusal(name);
      expect(status, `"${name}" should collide`).toBe(409);
    }
  });

  it('never shows the database constraint to the caller', async () => {
    const { body } = await refusal('Customer Migration');
    const text = JSON.stringify(body);
    expect(text).not.toContain('projects_org_active_name_unique');
    expect(text).not.toContain('duplicate key');
    expect(text).not.toContain('violates');
    expect(text).not.toContain('23505');
  });

  it('allows a different name', async () => {
    const project = await create('Supplier Migration');
    expect(project.id).toBeTruthy();
  });

  it('refuses renaming one project onto another project’s name', async () => {
    const [supplier] = await t.database.db
      .select()
      .from(projects)
      .where(eq(projects.name, 'Supplier Migration'));
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/projects/${supplier!.id}`,
      payload: { name: 'Customer Migration' },
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(409);
  });

  it('allows renaming a project to the name it already has', async () => {
    const [supplier] = await t.database.db
      .select()
      .from(projects)
      .where(eq(projects.name, 'Supplier Migration'));
    // Comparing against itself would otherwise make saving an unchanged form fail.
    await api.patch(`/api/projects/${supplier!.id}`, { name: 'Supplier Migration' });
  });

  /**
   * Archiving must not reserve a name forever. A team that archives "Q3 Migration" and starts a fresh one
   * next quarter is doing an ordinary thing, and refusing it would push them to "Q3 Migration 2".
   */
  it('frees the name once a project is archived, and refuses to bring it back onto a taken one', async () => {
    const reusable = await create('Quarterly Load');
    await api.post(`/api/projects/${reusable.id}/archive`);

    const replacement = await create('Quarterly Load');
    expect(replacement.id).not.toBe(reusable.id);

    // The archived project cannot come back: the replacement took its name while it was away. This is
    // the case a check written only for `create` would miss entirely.
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/projects/${reusable.id}`,
      payload: { status: 'ACTIVE' },
      headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
    });
    expect(res.statusCode).toBe(409);
  });

  /**
   * The race the pre-check cannot win.
   *
   * Both requests read "no project has this name" before either inserts, so without the unique index both
   * would succeed. Fired together rather than in sequence, because a sequential pair proves only that the
   * cheap check works.
   */
  it('lets exactly one of two simultaneous creates through', async () => {
    const attempts = Array.from({ length: 6 }, () =>
      t.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Concurrent Assessment', kind: 'ANALYSIS' },
        headers: { cookie: api.cookie, 'x-csrf-token': api.csrf },
      }),
    );
    const results = await Promise.all(attempts);
    const created = results.filter((r) => r.statusCode === 200);
    const refused = results.filter((r) => r.statusCode === 409);

    expect(created, 'exactly one create may win').toHaveLength(1);
    expect(refused, 'every other attempt must be refused, and refused the same way').toHaveLength(
      attempts.length - 1,
    );
    for (const r of refused) {
      expect((r.json() as { error: { message: string } }).error.message).toContain(
        'already exists in this workspace',
      );
    }

    // And the database agrees, which is the claim that actually matters.
    const rows = await t.database.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, organizationId));
    expect(rows.filter((p) => p.name === 'Concurrent Assessment' && p.status === 'ACTIVE')).toHaveLength(1);
  });

  it('scopes uniqueness to the workspace, not the whole deployment', async () => {
    // A second workspace is a different team. Their project names are their own business.
    const other = new ApiClient(t.app);
    await other.demoLogin();
    const theirs = await other.post<{ id: string }>('/api/projects', {
      name: 'Customer Migration',
      kind: 'ANALYSIS',
    });
    expect(theirs.id).toBeTruthy();
  });
});
