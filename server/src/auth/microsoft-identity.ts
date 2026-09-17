import {
  ConfidentialClientApplication,
  CryptoProvider,
  InteractionRequiredAuthError,
  LogLevel,
  type AuthenticationResult,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import { tokenCaches, users } from '../db/schema';
import { SecretBox } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { scrubSecrets } from '../logger';

/**
 * Dataverse resource scopes.
 *
 * Microsoft documents `<resource>/.default` for confidential clients and
 * `<resource>/user_impersonation` for public clients, and the official Global Discovery sample
 * builds the scope as `<resource>//user_impersonation` (the resource URI carries a trailing
 * slash). Rather than guessing which form a tenant accepts, we try the documented candidates in
 * order and remember the one that worked per resource.
 * https://learn.microsoft.com/power-apps/developer/data-platform/authenticate-oauth
 * https://learn.microsoft.com/entra/identity-platform/scopes-oidc
 */
export const scopeCandidates = (resourceUrl: string): string[] => {
  const base = resourceUrl.replace(/\/+$/, '');
  return [
    `${base}/.default`,
    `${base}//.default`,
    `${base}/user_impersonation`,
    `${base}//user_impersonation`,
  ];
};

/** Scope requested interactively at sign-in. `.default` cannot be combined with OIDC scopes. */
export const discoveryScope = (discoveryUrl: string) =>
  `${discoveryUrl.replace(/\/+$/, '')}/user_impersonation`;
/** Delegated scope for a specific Dataverse environment (first candidate; see scopeCandidates). */
export const dataverseScope = (environmentUrl: string) => scopeCandidates(environmentUrl)[0];
export const POWER_PLATFORM_SCOPE = 'https://service.powerapps.com//.default';

export interface SignInResult {
  tenantId: string;
  objectId: string;
  homeAccountId: string;
  displayName: string;
  email: string | null;
  nonce: string | undefined;
  serializedCache: string;
}

/**
 * Wraps MSAL (authorization code + PKCE, confidential client). Refresh tokens live only inside
 * the MSAL cache, which is AES-GCM encrypted per user in the database and never sent to the
 * browser or written to logs.
 */
export class MicrosoftIdentityService {
  /** Resource URL -> scope form accepted by this tenant. */
  private static readonly resourceScopes = new Map<string, string>();
  private readonly box: SecretBox;
  private readonly crypto = new CryptoProvider();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDb,
    private readonly logger: Logger,
  ) {
    this.box = new SecretBox(config.sessionSecret, 'msal-token-cache');
  }

  get enabled() {
    return this.config.microsoftEnabled;
  }

  private client(cachePlugin?: ICachePlugin) {
    if (!this.config.ENTRA_CLIENT_ID || !this.config.ENTRA_CLIENT_SECRET) {
      throw new AppError(503, 'MICROSOFT_NOT_CONFIGURED', 'Microsoft sign-in is not configured');
    }
    return new ConfidentialClientApplication({
      auth: {
        clientId: this.config.ENTRA_CLIENT_ID,
        clientSecret: this.config.ENTRA_CLIENT_SECRET,
        authority: `${this.config.ENTRA_AUTHORITY_HOST.replace(/\/+$/, '')}/${this.config.ENTRA_TENANT_ID}`,
      },
      cache: cachePlugin ? { cachePlugin } : undefined,
      system: {
        loggerOptions: {
          piiLoggingEnabled: false,
          logLevel: LogLevel.Warning,
          loggerCallback: (level, message) => {
            if (level <= LogLevel.Warning) this.logger.warn({ component: 'msal' }, scrubSecrets(message));
          },
        },
      },
    });
  }

  async generatePkce() {
    return this.crypto.generatePkceCodes();
  }

  async getAuthCodeUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    return this.client().getAuthCodeUrl({
      scopes: [
        'openid',
        'profile',
        'email',
        'offline_access',
        discoveryScope(this.config.DATAVERSE_DISCOVERY_URL),
      ],
      redirectUri: this.config.redirectUri,
      state: params.state,
      nonce: params.nonce,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
      prompt: 'select_account',
      responseMode: 'query' as never,
    });
  }

  async redeemCode(code: string, codeVerifier: string): Promise<SignInResult> {
    let serializedCache = '';
    const capture: ICachePlugin = {
      beforeCacheAccess: async () => {},
      afterCacheAccess: async (ctx: TokenCacheContext) => {
        if (ctx.cacheHasChanged) serializedCache = ctx.tokenCache.serialize();
      },
    };
    let result: AuthenticationResult;
    try {
      result = await this.client(capture).acquireTokenByCode({
        code,
        codeVerifier,
        redirectUri: this.config.redirectUri,
        scopes: [discoveryScope(this.config.DATAVERSE_DISCOVERY_URL)],
      });
    } catch (err) {
      this.logger.warn(
        { err: { name: (err as Error).name, message: scrubSecrets((err as Error).message) } },
        'Microsoft sign-in failed',
      );
      throw new AppError(401, 'MICROSOFT_SIGN_IN_FAILED', 'Microsoft sign-in failed. Please try again.');
    }
    const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
    const account = result.account;
    if (!account || typeof claims.oid !== 'string' || typeof claims.tid !== 'string') {
      throw new AppError(
        401,
        'MICROSOFT_SIGN_IN_FAILED',
        'Sign-in response did not include an organizational identity',
      );
    }
    return {
      tenantId: claims.tid,
      objectId: claims.oid,
      homeAccountId: account.homeAccountId,
      displayName: (claims.name as string) ?? account.name ?? account.username,
      email: (claims.preferred_username as string) ?? (claims.email as string) ?? account.username ?? null,
      nonce: claims.nonce as string | undefined,
      serializedCache,
    };
  }

  async saveCache(userId: string, serialized: string) {
    if (!serialized) return;
    const encryptedCache = this.box.encrypt(serialized);
    await this.db
      .insert(tokenCaches)
      .values({ userId, encryptedCache })
      .onConflictDoUpdate({ target: tokenCaches.userId, set: { encryptedCache, updatedAt: new Date() } });
  }

  private userCachePlugin(userId: string): ICachePlugin {
    return {
      beforeCacheAccess: async (ctx) => {
        const [row] = await this.db.select().from(tokenCaches).where(eq(tokenCaches.userId, userId));
        if (row) {
          try {
            ctx.tokenCache.deserialize(this.box.decrypt(row.encryptedCache));
          } catch {
            this.logger.warn({ userId }, 'Token cache could not be decrypted; re-authentication required');
          }
        }
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) await this.saveCache(userId, ctx.tokenCache.serialize());
      },
    };
  }

  /**
   * Acquires a token for a Dataverse resource, trying the documented scope forms in order and
   * caching the one the tenant accepts. Refresh tokens are not bound to a resource, so the same
   * sign-in can produce tokens for discovery and for each environment.
   * https://learn.microsoft.com/entra/identity-platform/refresh-tokens
   */
  async getResourceToken(userId: string, resourceUrl: string): Promise<string> {
    const cached = MicrosoftIdentityService.resourceScopes.get(resourceUrl);
    const candidates = cached ? [cached] : scopeCandidates(resourceUrl);
    let lastError: unknown;
    for (const scope of candidates) {
      try {
        const token = await this.getAccessToken(userId, [scope]);
        MicrosoftIdentityService.resourceScopes.set(resourceUrl, scope);
        return token;
      } catch (err) {
        lastError = err;
        // Only a scope/consent problem is worth retrying with a different form.
        if (err instanceof AppError && err.code !== 'REAUTH_REQUIRED') throw err;
        this.logger.debug({ resourceUrl, scope }, 'Scope form rejected; trying the next documented form');
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AppError(401, 'REAUTH_REQUIRED', 'Could not obtain a Dataverse access token');
  }

  /** Acquires a delegated access token for the user silently (refreshing when needed). */
  async getAccessToken(userId: string, scopes: string[]): Promise<string> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user?.msalHomeAccountId) {
      throw new AppError(401, 'REAUTH_REQUIRED', 'Microsoft session not found. Sign in again.');
    }
    const client = this.client(this.userCachePlugin(userId));
    const account = await client.getTokenCache().getAccountByHomeId(user.msalHomeAccountId);
    if (!account) throw new AppError(401, 'REAUTH_REQUIRED', 'Microsoft session expired. Sign in again.');
    try {
      const result = await client.acquireTokenSilent({ account, scopes });
      if (!result?.accessToken)
        throw new AppError(401, 'REAUTH_REQUIRED', 'Could not obtain an access token');
      return result.accessToken;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const consent = err instanceof InteractionRequiredAuthError;
      this.logger.warn(
        { userId, scopes, errorName: (err as Error).name, message: scrubSecrets((err as Error).message) },
        'Silent token acquisition failed',
      );
      throw new AppError(
        401,
        'REAUTH_REQUIRED',
        consent
          ? 'Additional consent or sign-in is required for this environment. Sign in again.'
          : 'Could not obtain a Microsoft access token. Sign in again.',
      );
    }
  }

  logoutUrl(): string {
    const post = encodeURIComponent(this.config.APP_BASE_URL);
    return `${this.config.ENTRA_AUTHORITY_HOST.replace(/\/+$/, '')}/${this.config.ENTRA_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`;
  }
}
