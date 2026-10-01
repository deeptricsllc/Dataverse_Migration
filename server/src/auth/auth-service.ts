import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { SessionUser } from '../../../shared/domain';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import { authRequests, organizations, sessions, users } from '../db/schema';
import { seedDemoData } from '../dataverse/factory';
import { SecretBox, randomToken, sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import type { AuditService } from '../services/audit-service';
import type { MicrosoftIdentityService } from './microsoft-identity';

export const SESSION_COOKIE = 'dvm_session';
const DEMO_ORG_NAME = 'DeepTrics (Demo)';
/** An evaluator's own workspace. The suffix is there so somebody can tell two of them apart. */
const EVALUATOR_ORG_NAME = 'Demo workspace';

export interface ResolvedSession {
  sessionId: string;
  csrfToken: string;
  user: SessionUser;
}

/** Only allow relative in-app redirects (prevents open redirects). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return '/';
  return value;
}

export class AuthService {
  private readonly box: SecretBox;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDb,
    private readonly identity: MicrosoftIdentityService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {
    this.box = new SecretBox(config.sessionSecret, 'oauth-state');
  }

  async createSession(
    userId: string,
    userAgent: string | undefined,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3600_000);
    await this.db.insert(sessions).values({
      id: sha256(token),
      userId,
      csrfToken: randomToken(24),
      expiresAt,
      userAgent: userAgent?.slice(0, 300) ?? null,
    });
    return { token, expiresAt };
  }

  async resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length > 200) return null;
    const [row] = await this.db
      .select({ session: sessions, user: users, org: organizations })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(eq(sessions.id, sha256(token)));
    if (!row) return null;
    if (row.session.expiresAt.getTime() < Date.now()) {
      await this.db.delete(sessions).where(eq(sessions.id, row.session.id));
      return null;
    }
    if (row.org.isDemo && !this.config.DEMO_MODE) return null;
    if (Date.now() - row.session.lastSeenAt.getTime() > 60_000) {
      await this.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.session.id));
    }
    return {
      sessionId: row.session.id,
      csrfToken: row.session.csrfToken,
      user: {
        id: row.user.id,
        displayName: row.user.displayName,
        email: row.user.email,
        role: row.user.role,
        organization: { id: row.org.id, name: row.org.name, isDemo: row.org.isDemo },
        authProvider: row.user.authProvider,
        // Not stored on the row: ADMIN_EMAILS is deployment configuration, and someone removed from
        // it should stop being an operator on their next request rather than on their next sign-in.
        platformOperator: Boolean(
          row.user.email && this.config.adminEmails.includes(row.user.email.toLowerCase()),
        ),
      },
    };
  }

  async destroySession(sessionId: string) {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async purgeExpired() {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    await this.db.delete(authRequests).where(lt(authRequests.expiresAt, new Date()));
    await this.purgeExpiredDemoWorkspaces();
  }

  /**
   * Removes evaluator workspaces nobody is coming back to.
   *
   * Every demo sign-in creates an organization, so without this they accumulate for as long as the
   * deployment runs — each carrying its own copy of the simulated data, its projects, its runs and
   * its audit trail. A workspace is expired once it is older than the window and has no session
   * that is still valid, which means nobody is in it: deleting one with a live session would log
   * somebody out in the middle of an evaluation.
   *
   * Deletion cascades from `organizations`, which is why every table that holds customer data
   * references it with `onDelete: 'cascade'`. A real organization is never touched; `isDemo` is the
   * whole point of that predicate.
   */
  async purgeExpiredDemoWorkspaces(): Promise<number> {
    const hours = this.config.DEMO_WORKSPACE_TTL_HOURS;
    if (hours <= 0) return 0;
    const cutoff = new Date(Date.now() - hours * 3_600_000);
    const stale = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.isDemo, true), lt(organizations.createdAt, cutoff)));
    if (stale.length === 0) return 0;

    const live = await this.db
      .select({ organizationId: users.organizationId })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          sql`${sessions.expiresAt} > now()`,
          inArray(
            users.organizationId,
            stale.map((o) => o.id),
          ),
        ),
      );
    const occupied = new Set(live.map((r) => r.organizationId));
    const removable = stale.filter((o) => !occupied.has(o.id)).map((o) => o.id);
    if (removable.length === 0) return 0;

    await this.db.delete(organizations).where(inArray(organizations.id, removable));
    this.logger.info({ count: removable.length, ttlHours: hours }, 'Expired demo workspaces removed');
    return removable.length;
  }

  // ---------------------------------------------------------------------------
  // Demo sign-in
  // ---------------------------------------------------------------------------

  /**
   * Signing in to a demo workspace. There are two, and the name decides which.
   *
   * **No name — an evaluator.** A workspace of their own, created here and belonging to nobody
   * else. Prospects used to land in one shared organization and meet whatever the last visitor had
   * been doing, including the records they had migrated into the simulated target. Signing out and
   * back in gives a fresh one: the browser session carries the workspace.
   *
   * **A name — a tester on a team.** The shared user-acceptance workspace, where seeing each
   * other's work is the point. Half of what testers are asked to evaluate is the audit trail, and a
   * trail where every entry says "Demo User" cannot answer the question it exists to answer, so the
   * name makes them a distinct person inside that one organization.
   *
   * The split is this blunt on purpose. It needs no extra control on the sign-in page, and the page
   * says which one a visitor is choosing rather than leaving them to find out.
   */
  async demoSignIn(requestId: string, displayName?: string): Promise<string> {
    if (!this.config.DEMO_MODE) throw new AppError(404, 'NOT_FOUND', 'Demo mode is disabled');
    // A name identifies the person for the whole life of the demo organization, so it is
    // normalised: "Priya Raman", "priya raman" and " Priya  Raman " are one tester, not three.
    const name = (displayName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

    let org: typeof organizations.$inferSelect | undefined;
    if (name) {
      // The shared team workspace. Found by the same three conditions it is created with, so a
      // second tester joins the first one's workspace rather than starting a parallel one.
      [org] = await this.db
        .select()
        .from(organizations)
        .where(
          and(
            eq(organizations.isDemo, true),
            eq(organizations.name, DEMO_ORG_NAME),
            isNull(organizations.entraTenantId),
          ),
        );
      if (!org)
        [org] = await this.db.insert(organizations).values({ name: DEMO_ORG_NAME, isDemo: true }).returning();
    } else {
      // An evaluator's own workspace. The isolation boundary is the organization, which every
      // query in the product already filters on, rather than a second one invented for the demo.
      [org] = await this.db
        .insert(organizations)
        .values({ name: `${EVALUATOR_ORG_NAME} ${randomToken(3).toUpperCase()}`, isDemo: true })
        .returning();
    }
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const externalId = slug ? `demo-user:${slug}` : 'demo-user';
    const [user] = await this.db
      .insert(users)
      .values({
        organizationId: org.id,
        externalId,
        authProvider: 'demo',
        email: slug ? `${slug}@deeptrics.demo` : 'demo.user@deeptrics.demo',
        displayName: name || 'Demo User',
        role: 'ADMIN',
        lastLoginAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [users.organizationId, users.externalId],
        // The name can be corrected by signing in again with it spelled properly.
        set: { lastLoginAt: new Date(), displayName: name || 'Demo User' },
      })
      .returning();
    // This workspace's own copy of the simulated data.
    await seedDemoData(this.db, org.id, { logger: this.logger });
    await this.audit.record({
      organizationId: org.id,
      userId: user.id,
      action: 'AUTH_SIGN_IN',
      outcome: 'SUCCESS',
      requestId,
      details: { provider: 'demo' },
    });
    return user.id;
  }

  // ---------------------------------------------------------------------------
  // Microsoft sign-in (authorization code + PKCE)
  // ---------------------------------------------------------------------------

  async beginMicrosoftSignIn(returnTo: string): Promise<string> {
    const { verifier, challenge } = await this.identity.generatePkce();
    const state = randomToken(24);
    const nonce = randomToken(16);
    await this.db.insert(authRequests).values({
      state,
      encryptedVerifier: this.box.encrypt(verifier),
      nonce,
      returnTo: safeReturnTo(returnTo),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return this.identity.getAuthCodeUrl({ state, nonce, codeChallenge: challenge });
  }

  async completeMicrosoftSignIn(
    params: { code: string; state: string },
    requestId: string,
  ): Promise<{ userId: string; returnTo: string }> {
    // Single-use state: delete and read atomically.
    const [pending] = await this.db
      .delete(authRequests)
      .where(eq(authRequests.state, params.state))
      .returning();
    if (!pending || pending.expiresAt.getTime() < Date.now()) {
      throw new AppError(
        400,
        'INVALID_STATE',
        'The sign-in request expired or is invalid. Please try again.',
      );
    }
    const result = await this.identity.redeemCode(params.code, this.box.decrypt(pending.encryptedVerifier));
    // The nonce claim is echoed in the id_token when we send one. Microsoft documents it as
    // required for the hybrid flow; validate whenever it is present.
    // https://learn.microsoft.com/entra/identity-platform/id-tokens
    if (result.nonce !== undefined && result.nonce !== pending.nonce) {
      this.logger.warn({ requestId }, 'Microsoft sign-in nonce mismatch');
      throw new AppError(400, 'INVALID_NONCE', 'Sign-in validation failed. Please try again.');
    }
    if (result.nonce === undefined) {
      this.logger.warn(
        { requestId },
        'Identity provider returned no nonce claim; PKCE and state still validated',
      );
    }
    const tenantId = result.tenantId.toLowerCase();
    if (this.config.allowedTenantIds.length && !this.config.allowedTenantIds.includes(tenantId)) {
      this.logger.warn({ requestId, tenantId }, 'Sign-in from a tenant that is not allowed');
      throw new AppError(403, 'TENANT_NOT_ALLOWED', 'Your organization is not enabled for this application.');
    }

    const domain = result.email?.split('@')[1];
    let [org] = await this.db.select().from(organizations).where(eq(organizations.entraTenantId, tenantId));
    if (!org) {
      [org] = await this.db
        .insert(organizations)
        .values({ name: domain ?? `Tenant ${tenantId.slice(0, 8)}`, entraTenantId: tenantId })
        .onConflictDoNothing()
        .returning();
      if (!org)
        [org] = await this.db.select().from(organizations).where(eq(organizations.entraTenantId, tenantId));
    }
    const [{ n: existingUsers }] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.organizationId, org.id));
    const isAdmin =
      Number(existingUsers) === 0 ||
      (result.email ? this.config.adminEmails.includes(result.email.toLowerCase()) : false);
    const [user] = await this.db
      .insert(users)
      .values({
        organizationId: org.id,
        externalId: result.objectId,
        authProvider: 'microsoft',
        email: result.email,
        displayName: result.displayName,
        role: isAdmin ? 'ADMIN' : 'MEMBER',
        msalHomeAccountId: result.homeAccountId,
        lastLoginAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [users.organizationId, users.externalId],
        set: {
          email: result.email,
          displayName: result.displayName,
          msalHomeAccountId: result.homeAccountId,
          lastLoginAt: new Date(),
          ...(isAdmin ? { role: 'ADMIN' as const } : {}),
        },
      })
      .returning();
    await this.identity.saveCache(user.id, result.serializedCache);
    await this.audit.record({
      organizationId: org.id,
      userId: user.id,
      action: 'AUTH_SIGN_IN',
      outcome: 'SUCCESS',
      requestId,
      details: { provider: 'microsoft' },
    });
    return { userId: user.id, returnTo: pending.returnTo ?? '/' };
  }
}
