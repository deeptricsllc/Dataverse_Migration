import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { auditEvents, environmentAccess, environments } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The guard that decides whether a run may be queued, now that it can say yes.
 *
 * `tests/unit/write-scope.test.ts` establishes the decision itself. This file is about the wiring in
 * `MigrationRunService.assertWritesAllowed`, which changed shape: it used to be able only to refuse, and
 * it can now permit — which is a new code path in a safety guard, and an unexercised permit path in a
 * safety guard is the worst kind of untested line.
 *
 * Three things are asserted here that the unit tests structurally cannot see:
 *
 *   1. the guard looks up the *target* environment and asks about that one;
 *   2. a refusal is on the audit trail as `READ_ONLY_WRITE_BLOCKED`, with the reason;
 *   3. a permission is on the audit trail as `CERTIFICATION_WRITE_PERMITTED`, naming the environment —
 *      so a deployment can never claim it was read-only across a window in which it wrote.
 *
 * It calls `assertWritesAllowed` directly. Reaching it through `POST /api/plans/:id/execute` would need a
 * plan built from metadata, and metadata for a `provider: 'dataverse'` row means reaching real Dataverse,
 * which is the thing this suite must not do. The alternative — a plan fixture assembled by hand — would
 * test the fixture as much as the guard. So the seam is named honestly instead of disguised.
 */

const SANDBOX = 'https://certsandbox.crm.dynamics.com';
const PRODUCTION = 'https://live.crm.dynamics.com';
const UNCLASSIFIED = 'https://mystery.crm.dynamics.com';

type Guard = {
  assertWritesAllowed: (
    ctx: Record<string, unknown>,
    targetEnvironmentId: string,
    action: string,
  ) => Promise<void>;
};

describe('controlled certification write scope, at the queue-time guard', () => {
  let t: TestApp;
  let ctx: Record<string, unknown>;
  const ids: Record<string, string> = {};

  /** A deployment that is read-only everywhere except one named sandbox. */
  const bootWith = async (scope: string | undefined) => {
    t = await createTestApp({
      REAL_TENANT_READ_ONLY: 'true',
      ...(scope === undefined ? {} : { CERTIFICATION_WRITE_ENVIRONMENTS: scope }),
    });
    const api = new ApiClient(t.app);
    const session = await api.demoLogin();
    const organizationId = session.user.organization.id;
    const userId = session.user.id;
    ctx = {
      organizationId,
      userId,
      displayName: session.user.displayName,
      role: 'ADMIN',
      isDemoOrg: false,
      platformOperator: false,
      requestId: 'write-scope-test',
    };

    // Real environment rows, provider 'dataverse', so the guard is deciding about the kind of
    // environment it exists to protect rather than about a simulated one it always exempts.
    const make = async (key: string, displayName: string, url: string, environmentType: string | null) => {
      const [row] = await t.database.db
        .insert(environments)
        .values({
          organizationId,
          provider: 'dataverse',
          displayName,
          url,
          apiUrl: url.replace('//', '//api.'),
          environmentType,
        })
        .returning();
      await t.database.db
        .insert(environmentAccess)
        .values({ userId, environmentId: row!.id, lastSeenAt: new Date() });
      ids[key] = row!.id;
    };
    await make('sandbox', 'Certification Sandbox', SANDBOX, 'Sandbox');
    await make('production', 'Live', PRODUCTION, 'Production');
    await make('unclassified', 'Mystery', UNCLASSIFIED, null);
  };

  const guard = () => t.services.runs as unknown as Guard;

  const latestAudit = async (action: string) => {
    const rows = await t.database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, action))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    return rows[0] ?? null;
  };

  afterEach(async () => {
    await t?.close();
  });

  describe('with no certification scope', () => {
    beforeEach(() => bootWith(undefined));

    it('refuses the sandbox, exactly as it did before this setting existed', async () => {
      await expect(guard().assertWritesAllowed(ctx, ids.sandbox!, 'EXECUTE')).rejects.toMatchObject({
        statusCode: 403,
        code: 'REAL_TENANT_READ_ONLY',
      });
      const event = await latestAudit('READ_ONLY_WRITE_BLOCKED');
      expect(event, 'the refusal must be on the audit trail').toBeTruthy();
      expect((event!.details as { reason?: string }).reason).toBe('READ_ONLY_DEPLOYMENT');
    });

    it('records nothing as permitted', async () => {
      await guard()
        .assertWritesAllowed(ctx, ids.sandbox!, 'EXECUTE')
        .catch(() => {});
      expect(await latestAudit('CERTIFICATION_WRITE_PERMITTED')).toBeNull();
    });
  });

  describe('with the sandbox in scope', () => {
    beforeEach(() => bootWith(SANDBOX));

    it('permits the sandbox, and says so on the audit trail', async () => {
      await expect(guard().assertWritesAllowed(ctx, ids.sandbox!, 'EXECUTE')).resolves.toBeUndefined();
      const event = await latestAudit('CERTIFICATION_WRITE_PERMITTED');
      expect(event, 'a permitted write under a read-only deployment must be recorded').toBeTruthy();
      expect(event!.outcome).toBe('SUCCESS');
      expect(event!.targetEnvironmentId).toBe(ids.sandbox);
      expect((event!.details as { environmentType?: string }).environmentType).toBe('Sandbox');
    });

    /**
     * The property the whole mechanism rests on. Opening one sandbox must not open anything else, and
     * the guard must be asking about the target it was handed rather than about the deployment.
     */
    it('still refuses every other environment', async () => {
      for (const key of ['production', 'unclassified']) {
        await expect(
          guard().assertWritesAllowed(ctx, ids[key]!, 'EXECUTE'),
          `${key} must stay refused`,
        ).rejects.toMatchObject({ code: 'REAL_TENANT_READ_ONLY' });
      }
      expect((await latestAudit('READ_ONLY_WRITE_BLOCKED'))!.details).toMatchObject({
        reason: 'NOT_IN_CERTIFICATION_SCOPE',
      });
    });

    it('guards resume and retry too, not only execute', async () => {
      for (const action of ['RESUME', 'RETRY']) {
        await expect(
          guard().assertWritesAllowed(ctx, ids.production!, action),
          `${action} must be guarded`,
        ).rejects.toMatchObject({ code: 'REAL_TENANT_READ_ONLY' });
      }
    });
  });

  describe('with production itself in scope', () => {
    beforeEach(() => bootWith(`${PRODUCTION},${UNCLASSIFIED},${SANDBOX}`));

    /**
     * Somebody will paste a production URL into this list. The list must not be the only thing between
     * that and a write, which is why being listed is necessary and not sufficient.
     */
    it('refuses production anyway, and records why', async () => {
      await expect(guard().assertWritesAllowed(ctx, ids.production!, 'EXECUTE')).rejects.toMatchObject({
        code: 'REAL_TENANT_READ_ONLY',
      });
      const event = await latestAudit('READ_ONLY_WRITE_BLOCKED');
      expect((event!.details as { reason?: string }).reason).toBe('PRODUCTION_OR_UNCLASSIFIED');
    });

    it('refuses an environment whose type it could not read, for the same reason', async () => {
      await expect(guard().assertWritesAllowed(ctx, ids.unclassified!, 'EXECUTE')).rejects.toMatchObject({
        code: 'REAL_TENANT_READ_ONLY',
      });
      expect((await latestAudit('READ_ONLY_WRITE_BLOCKED'))!.details).toMatchObject({
        reason: 'PRODUCTION_OR_UNCLASSIFIED',
      });
    });

    it('still permits the sandbox that is also listed', async () => {
      await expect(guard().assertWritesAllowed(ctx, ids.sandbox!, 'EXECUTE')).resolves.toBeUndefined();
    });
  });

  describe('the refusal message', () => {
    beforeEach(() => bootWith(SANDBOX));

    /** A prospect reads these. No variable names, no stack traces, no internal instructions. */
    it('explains what was refused without naming a configuration variable', async () => {
      const err = await guard()
        .assertWritesAllowed(ctx, ids.production!, 'EXECUTE')
        .catch((e: Error) => e);
      const message = (err as { message: string }).message;
      expect(message).toContain('read-only certification mode');
      expect(message).toContain('Live');
      expect(message).not.toContain('CERTIFICATION_WRITE_ENVIRONMENTS');
      expect(message).not.toContain('REAL_TENANT_READ_ONLY');
    });
  });
});
