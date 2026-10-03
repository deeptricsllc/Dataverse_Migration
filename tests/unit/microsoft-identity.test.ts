import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { MicrosoftIdentityService } from '../../server/src/auth/microsoft-identity';
import { loadConfig } from '../../server/src/config';

/**
 * What this platform hands to MSAL, which is the one boundary the rest of the authentication tests cannot
 * see.
 *
 * `tests/integration/auth-matrix.test.ts` replaces `redeemCode` wholesale, because redeeming a real
 * authorization code needs Microsoft and a real secret. That is a reasonable thing to simulate and it is
 * documented as such — and it meant the ten cases there were structurally incapable of noticing that
 * `redeemCode` itself was broken.
 *
 * It was. The first real sign-in this product ever attempted failed like this:
 *
 *   MSAL: Authorization code response contains an ID Token nonce, but no expected nonce was supplied.
 *         Rejecting the response.
 *   ClientAuthError: nonce_mismatch
 *
 * The authorize request sent a nonce, so Microsoft echoed it in the id_token, and nothing told MSAL what
 * to compare it against. MSAL refused the whole response — correctly: a nonce nobody checks is a replay
 * protection that is not protecting anything.
 *
 * So these cases assert the shape of the request that leaves this platform, with MSAL itself replaced.
 * They cannot prove Microsoft accepts it. They can prove we stopped leaving out the field whose absence
 * made Microsoft's answer unusable.
 */

const config = () =>
  loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://migrate.example.com',
    SESSION_SECRET: 'a-test-session-secret-of-sufficient-length',
    DEMO_MODE: 'false',
    ENTRA_CLIENT_ID: 'ecf355ec-83f9-4be4-b937-5bf080e97379',
    ENTRA_CLIENT_SECRET: 'not-a-real-secret',
    ENTRA_TENANT_ID: '0eca5595-e632-4812-8f30-2b25ca91f1ff',
    ENTRA_AUTHORITY_HOST: undefined,
    ENTRA_REDIRECT_URI: undefined,
    ALLOWED_TENANT_IDS: '0eca5595-e632-4812-8f30-2b25ca91f1ff',
    ACCESS_MODE: undefined,
    ADMIN_EMAILS: 'operator@example.com',
  });

const silent = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

/** A stand-in for MSAL that records the request rather than making one. */
function identityWithFakeMsal() {
  const service = new MicrosoftIdentityService(config(), {} as never, silent);
  const seen: Record<string, unknown>[] = [];
  (service as unknown as { client: () => unknown }).client = () => ({
    acquireTokenByCode: async (request: Record<string, unknown>) => {
      seen.push(request);
      return {
        account: { homeAccountId: 'home.account', name: 'A Person', username: 'a@example.com' },
        idTokenClaims: {
          oid: '8a1a6720-6b3c-4086-a5ff-6764611e135c',
          tid: '0eca5595-e632-4812-8f30-2b25ca91f1ff',
          nonce: 'the-nonce-we-issued',
          preferred_username: 'a@example.com',
        },
      };
    },
  });
  return { service, seen };
}

describe('redeeming an authorization code', () => {
  it('supplies the nonce it issued, which is what MSAL refuses the response without', async () => {
    const { service, seen } = identityWithFakeMsal();
    await service.redeemCode('an-authorization-code', 'the-code-verifier', 'the-nonce-we-issued');

    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.nonce, 'the field whose absence broke the first real sign-in').toBe('the-nonce-we-issued');
    // And the rest of what the exchange needs, so a regression here is caught as precisely.
    expect(request.code).toBe('an-authorization-code');
    expect(request.codeVerifier, 'PKCE: the verifier for the challenge we sent').toBe('the-code-verifier');
    expect(request.redirectUri).toBe('https://migrate.example.com/api/auth/callback');
  });

  it('returns the identity Microsoft asserted, including the nonce for the caller’s own check', async () => {
    const { service } = identityWithFakeMsal();
    const result = await service.redeemCode('code', 'verifier', 'the-nonce-we-issued');

    expect(result.tenantId).toBe('0eca5595-e632-4812-8f30-2b25ca91f1ff');
    expect(result.objectId).toBe('8a1a6720-6b3c-4086-a5ff-6764611e135c');
    // The caller compares this against the row it wrote. MSAL checks the same thing against the token;
    // this is the second half, for a response that carries no nonce at all.
    expect(result.nonce).toBe('the-nonce-we-issued');
  });

  it('builds an authorize URL carrying the nonce that will have to come back', async () => {
    /**
     * The two halves have to agree. If this stops sending a nonce, `redeemCode` passing one would make
     * MSAL reject every response for the opposite reason — so the pair is asserted together.
     */
    const service = new MicrosoftIdentityService(config(), {} as never, silent);
    const url = new URL(
      await service.getAuthCodeUrl({
        state: 'the-state',
        nonce: 'the-nonce-we-issued',
        codeChallenge: 'a-challenge',
      }),
    );

    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe('/0eca5595-e632-4812-8f30-2b25ca91f1ff/oauth2/v2.0/authorize');
    expect(url.searchParams.get('nonce')).toBe('the-nonce-we-issued');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('code_challenge')).toBe('a-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBe('ecf355ec-83f9-4be4-b937-5bf080e97379');
    // Never in a URL the browser is handed.
    expect(url.search).not.toContain('not-a-real-secret');
  });
});
