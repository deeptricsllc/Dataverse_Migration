import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditPageDto, ProjectDto } from '../../shared/domain';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Who a demo tester is.
 *
 * Several people testing the same deployment used to be one account: the same user id, the same
 * name, one shared history. For an anonymous demo that is right. For a user-acceptance test it is
 * not, because half of what testers are asked to evaluate is the audit trail, and a trail where
 * every entry says "Demo User" cannot answer the question it exists to answer.
 *
 * They still share an organization, deliberately. Testing together means seeing each other's work.
 */
describe('several people testing the same deployment', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const signIn = async (name?: string) => {
    const api = new ApiClient(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/demo-login',
      payload: (name ? { name } : {}) as never,
    });
    expect(res.statusCode).toBe(200);
    const raw = res.headers['set-cookie'];
    api.cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0];
    api.csrf = res.json().csrfToken;
    return { api, user: res.json().user };
  };

  it('keeps named testers apart while leaving them in one workspace', async () => {
    const priya = await signIn('Priya Raman');
    const sam = await signIn('Sam Okonkwo');

    expect(priya.user.displayName).toBe('Priya Raman');
    expect(sam.user.displayName).toBe('Sam Okonkwo');
    expect(priya.user.id).not.toBe(sam.user.id);
    // One organization: testing together means seeing each other's work.
    expect(priya.user.organization.id).toBe(sam.user.organization.id);

    const made = await priya.api.post<ProjectDto>('/api/projects', {
      name: 'Priya analysis',
      kind: 'ANALYSIS',
    });
    const seen = await sam.api.get<ProjectDto[]>('/api/projects');
    expect(seen.some((p) => p.id === made.id)).toBe(true);
  });

  it('is the same person on a second sign-in, however the name was typed', async () => {
    const first = await signIn('Priya Raman');
    const again = await signIn('  priya   raman ');
    // Otherwise a tester accumulates a new identity every morning and the trail fragments.
    expect(again.user.id).toBe(first.user.id);
    // And the name they typed most recently is the one shown.
    expect(again.user.displayName).toBe('priya raman');
  });

  it('records who did what, so the audit trail answers the question it is for', async () => {
    const dana = await signIn('Dana Whitfield');
    await dana.api.post('/api/projects', { name: 'Dana project', kind: 'ANALYSIS' });

    const page = await dana.api.get<AuditPageDto>('/api/audit?limit=200');
    const mine = page.items.filter((e) => e.user === 'Dana Whitfield');
    expect(mine.length).toBeGreaterThan(0);
    // Other testers are in the same trail and are distinguishable from her.
    // Sam, not Priya: the test above re-signed her in with a different spelling, which renames her.
    expect(page.users).toEqual(expect.arrayContaining(['Dana Whitfield', 'Sam Okonkwo']));
  });

  it('gives an anonymous visitor a workspace of their own', async () => {
    // The landing page's one-click demo is the prospect's path, and two prospects are two
    // evaluations. This used to return the same account both times, which is how one visitor met
    // the previous visitor's projects and the records they had migrated.
    const anon = await signIn();
    expect(anon.user.displayName).toBe('Demo User');
    const another = await signIn();
    expect(another.user.id, 'two visitors are two people').not.toBe(anon.user.id);
    expect(
      another.user.organization.id,
      'and two separate workspaces, which is what keeps their work apart',
    ).not.toBe(anon.user.organization.id);
  });

  it('keeps named testers in one workspace and anonymous visitors out of it', async () => {
    // The two paths, stated side by side so the distinction cannot be lost by accident: a name
    // means "I am a tester on this team", no name means "I am evaluating on my own".
    const one = await signIn('Ada Okafor');
    const two = await signIn('Ben Larsson');
    expect(one.user.organization.id, 'named testers share a workspace').toBe(two.user.organization.id);
    const visitor = await signIn();
    expect(visitor.user.organization.id, 'an anonymous visitor is not in it').not.toBe(
      one.user.organization.id,
    );
  });
});
