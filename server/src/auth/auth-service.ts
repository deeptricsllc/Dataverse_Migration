import { and, eq, isNull, lt, sql } from 'drizzle-orm';
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
      },
    };
  }

  async destroySession(sessionId: string) {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async purgeExpired() {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    await this.db.delete(authRequests).where(lt(authRequests.expiresAt, new Date()));
  }

  // ---------------------------------------------------------------------------
  // Demo sign-in
  // ---------------------------------------------------------------------------

  async demoSignIn(requestId: string): Promise<string> {
    if (!this.config.DEMO_MODE) throw new AppError(404, 'NOT_FOUND', 'Demo mode is disabled');
    let [org] = await this.db
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
    const [user] = await this.db
      .insert(users)
      .values({
        organizationId: org.id,
        externalId: 'demo-user',
        authProvider: 'demo',
        email: 'demo.user@deeptrics.demo',
        displayName: 'Demo User',
        role: 'ADMIN',
        lastLoginAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [users.organizationId, users.externalId],
        set: { lastLoginAt: new Date() },
      })
      .returning();
    await seedDemoData(this.db);
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
    if (result.nonce !== pending.nonce) {
      this.logger.warn({ requestId }, 'Microsoft sign-in nonce mismatch');
      throw new AppError(400, 'INVALID_NONCE', 'Sign-in validation failed. Please try again.');
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
