import { describe, expect, it } from 'vitest';
import {
  describeAuthConfiguration,
  formatAuthConfiguration,
  type AuthConfigurationReport,
} from '../../server/src/auth/auth-configuration';
import { loadConfig } from '../../server/src/config';
import { SIGN_IN_FAILURES, signInFailureCode, signInFailureMessage } from '../../shared/sign-in-failures';

/**
 * The authentication configuration matrix.
 *
 * Every case here is a deployment somebody could plausibly configure, including the two that the QA
 * deployment actually was. The point is not that the code parses variables — it is that a
 * configuration which will refuse somebody says so from the configuration alone, before anybody
 * tries to sign in and before any credential is involved.
 *
 * No case reaches Microsoft. These are statements about what the configuration means.
 */

/** A directory id shaped like a real one, so the GUID checks are exercised honestly. */
const DIRECTORY_A = '0eca5595-e632-4812-8f30-2b25ca91f1ff';
const DIRECTORY_B = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = '69bc3659-2653-41e5-a4b7-c56676945265';

/**
 * Builds a configuration with every authentication variable stated explicitly, so a variable that
 * happens to be set in the environment running the tests cannot change an answer.
 */
function configure(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://migrate.example.com',
    SESSION_SECRET: 'a-test-session-secret-of-sufficient-length',
    DEMO_MODE: 'false',
    ENTRA_CLIENT_ID: CLIENT_ID,
    ENTRA_CLIENT_SECRET: 'not-a-real-secret',
    ENTRA_TENANT_ID: undefined,
    ENTRA_AUTHORITY_HOST: undefined,
    ENTRA_REDIRECT_URI: undefined,
    ALLOWED_TENANT_IDS: undefined,
    ACCESS_MODE: undefined,
    ADMIN_EMAILS: 'operator@example.com',
    ...overrides,
  });
}

const describeFor = (overrides: Record<string, string | undefined> = {}) =>
  describeAuthConfiguration(configure(overrides));

const codes = (report: AuthConfigurationReport) => report.findings.map((f) => f.code);
const blockers = (report: AuthConfigurationReport) =>
  report.findings.filter((f) => f.severity === 'BLOCKS_SIGN_IN').map((f) => f.code);

describe('authentication configuration matrix', () => {
  // 1 ------------------------------------------------------------------------
  it('case 1: the QA deployment as it stood — reports both refusals, not one', () => {
    // ENTRA_TENANT_ID unset, ALLOWED_TENANT_IDS unset, ACCESS_MODE defaulted. This is exactly the
    // configuration that produced AADSTS700016 on Microsoft's page, with a second refusal waiting
    // behind it that nobody would have seen until the first was fixed.
    const report = describeFor();

    expect(report.authority.directory).toBe('organizations');
    expect(report.authority.kind).toBe('ANY_WORK_OR_SCHOOL');
    expect(report.authority.resolvesHomeDirectoryOfUser).toBe(true);
    expect(codes(report)).toContain('AUTHORITY_RESOLVES_USER_HOME_DIRECTORY');

    // The second refusal, found at the same time rather than after another deploy.
    expect(report.admission.admitsNobody).toBe(true);
    expect(blockers(report)).toContain('GATED_WITH_EMPTY_ALLOW_LIST');
    expect(report.anySignInPossible).toBe(false);
  });

  // 2 ------------------------------------------------------------------------
  it('case 2: a named directory with that directory admitted — nothing is blocked', () => {
    const report = describeFor({ ENTRA_TENANT_ID: DIRECTORY_A, ALLOWED_TENANT_IDS: DIRECTORY_A });

    expect(report.authority.kind).toBe('DIRECTORY');
    expect(report.authority.resolvesHomeDirectoryOfUser).toBe(false);
    expect(report.authority.url).toBe(`https://login.microsoftonline.com/${DIRECTORY_A}`);
    expect(report.admission.admitsNobody).toBe(false);
    expect(report.findings.filter((f) => f.severity !== 'INFO')).toEqual([]);
    expect(report.anySignInPossible).toBe(true);
  });

  // 3 ------------------------------------------------------------------------
  it('case 3: GATED with an empty allow list admits nobody, and does not quietly admit everybody', () => {
    const report = describeFor({ ENTRA_TENANT_ID: DIRECTORY_A, ACCESS_MODE: 'GATED' });

    expect(report.admission.admitsAnyDirectory).toBe(false);
    expect(report.admission.admitsNobody).toBe(true);
    const finding = report.findings.find((f) => f.code === 'GATED_WITH_EMPTY_ALLOW_LIST')!;
    expect(finding.severity).toBe('BLOCKS_SIGN_IN');
    expect(finding.message).toMatch(/admits nobody/);
  });

  // 4 ------------------------------------------------------------------------
  it('case 4: GATED with two directories admits exactly those two', () => {
    const report = describeFor({
      ENTRA_TENANT_ID: DIRECTORY_A,
      ALLOWED_TENANT_IDS: `${DIRECTORY_A}, ${DIRECTORY_B.toUpperCase()}`,
    });

    // Lower-cased on the way in, because the tenant id Microsoft returns is compared lower-cased.
    expect(report.admission.allowedDirectories).toEqual([DIRECTORY_A, DIRECTORY_B]);
    expect(report.admission.admitsAnyDirectory).toBe(false);
    expect(blockers(report)).toEqual([]);
  });

  // 5 ------------------------------------------------------------------------
  it('case 5: OPEN_BETA admits any directory, and says the allow list stopped mattering', () => {
    const report = describeFor({
      ENTRA_TENANT_ID: DIRECTORY_A,
      ACCESS_MODE: 'OPEN_BETA',
      ALLOWED_TENANT_IDS: DIRECTORY_A,
    });

    expect(report.admission.admitsAnyDirectory).toBe(true);
    expect(report.admission.admitsNobody).toBe(false);
    expect(codes(report)).toContain('ALLOW_LIST_HAS_NO_EFFECT');
    expect(blockers(report)).toEqual([]);
  });

  // 6 ------------------------------------------------------------------------
  it('case 6: a domain name on the allow list can never match, and is not mistaken for a directory', () => {
    // The natural thing to write, and it silently excludes the organization it was meant to admit.
    const report = describeFor({
      ENTRA_TENANT_ID: DIRECTORY_A,
      ALLOWED_TENANT_IDS: `contoso.com, ${DIRECTORY_A}`,
    });

    const finding = report.findings.find((f) => f.code === 'ALLOW_LIST_ENTRY_IS_NOT_A_DIRECTORY_ID')!;
    expect(finding.message).toContain('contoso.com');
    expect(finding.message).toMatch(/can never match/);
    // The valid entry still works, so the deployment is not blocked — only that one line is useless.
    expect(blockers(report)).toEqual([]);
  });

  // 7 ------------------------------------------------------------------------
  it('case 7: a personal-accounts authority blocks sign-in for a product that migrates directories', () => {
    for (const directory of ['consumers', '9188040d-6c67-4c5b-b112-36a304b66dad']) {
      const report = describeFor({ ENTRA_TENANT_ID: directory, ALLOWED_TENANT_IDS: DIRECTORY_A });
      expect(blockers(report), directory).toContain('AUTHORITY_IS_PERSONAL_ACCOUNTS_ONLY');
      expect(report.anySignInPossible, directory).toBe(false);
    }
  });

  // 8 ------------------------------------------------------------------------
  it('case 8: an authority Microsoft cannot resolve is a blocker, and a verified domain is not', () => {
    const nonsense = describeFor({ ENTRA_TENANT_ID: 'our-tenant', ALLOWED_TENANT_IDS: DIRECTORY_A });
    expect(nonsense.authority.kind).toBe('UNRECOGNISED');
    expect(blockers(nonsense)).toContain('AUTHORITY_NOT_RECOGNISED');

    const domain = describeFor({
      ENTRA_TENANT_ID: 'contoso.onmicrosoft.com',
      ALLOWED_TENANT_IDS: DIRECTORY_A,
    });
    expect(domain.authority.kind).toBe('DOMAIN');
    expect(domain.authority.resolvesHomeDirectoryOfUser).toBe(false);
    expect(blockers(domain)).toEqual([]);
  });

  // 9 ------------------------------------------------------------------------
  it('case 9: half a credential pair disables Microsoft sign-in, and says so instead of being silent', () => {
    // Allowed only because DEMO_MODE keeps a sign-in method available; loadConfig refuses otherwise.
    const report = describeFor({ ENTRA_CLIENT_SECRET: undefined, DEMO_MODE: 'true' });

    expect(report.clientIdentity.clientIdPresent).toBe(true);
    expect(report.clientIdentity.secretPresent).toBe(false);
    expect(report.clientIdentity.configured).toBe(false);
    expect(report.signInMethods.microsoft).toBe(false);
    expect(codes(report)).toContain('ENTRA_HALF_CONFIGURED');
    // Demo sign-in still works, so this is a warning about a missing button, not a dead deployment.
    expect(report.anySignInPossible).toBe(true);
  });

  // 10 -----------------------------------------------------------------------
  it('case 10: a redirect URI pointing at another host is reported before Microsoft rejects it', () => {
    const mismatched = describeFor({
      ENTRA_TENANT_ID: DIRECTORY_A,
      ALLOWED_TENANT_IDS: DIRECTORY_A,
      ENTRA_REDIRECT_URI: 'https://staging.example.net/api/auth/callback',
    });
    expect(mismatched.redirect.derived).toBe(false);
    expect(mismatched.redirect.matchesAppBaseUrl).toBe(false);
    expect(codes(mismatched)).toContain('REDIRECT_URI_HOST_DIFFERS_FROM_APP_BASE_URL');

    const derived = describeFor({ ENTRA_TENANT_ID: DIRECTORY_A, ALLOWED_TENANT_IDS: DIRECTORY_A });
    expect(derived.redirect.derived).toBe(true);
    expect(derived.redirect.uri).toBe('https://migrate.example.com/api/auth/callback');
    expect(derived.redirect.matchesAppBaseUrl).toBe(true);
  });

  // 11 -----------------------------------------------------------------------
  it('case 11: admission is never an authority — the allow list cannot move where we authenticate', () => {
    /**
     * The invariant the brief names: authentication authority and application tenant allow-listing
     * are different decisions. If a future change ever reached for the allow list to fill in an
     * authority, one customer's directory would be asked to vouch for another customer's user. This
     * holds the two apart by construction: the authority is identical across wildly different allow
     * lists, and listing a directory does not make it the authority.
     */
    const base = describeFor({ ENTRA_TENANT_ID: DIRECTORY_A, ALLOWED_TENANT_IDS: DIRECTORY_A });
    const manyListed = describeFor({
      ENTRA_TENANT_ID: DIRECTORY_A,
      ALLOWED_TENANT_IDS: `${DIRECTORY_B}, ${DIRECTORY_A}, 99999999-8888-4777-8666-555544443333`,
    });
    const otherListed = describeFor({ ENTRA_TENANT_ID: DIRECTORY_A, ALLOWED_TENANT_IDS: DIRECTORY_B });

    for (const report of [manyListed, otherListed]) {
      expect(report.authority.url).toBe(base.authority.url);
      expect(report.authority.directory).toBe(DIRECTORY_A);
    }

    // And with no authority configured, a populated allow list does not supply one.
    const noAuthority = describeFor({ ALLOWED_TENANT_IDS: DIRECTORY_B });
    expect(noAuthority.authority.directory).toBe('organizations');
    expect(noAuthority.authority.url).not.toContain(DIRECTORY_B);
  });

  // 12 -----------------------------------------------------------------------
  it('case 12: nothing a visitor can see names a variable, a secret, or Microsoft internals', () => {
    /**
     * The findings are deliberately specific about variables, because an operator has to act on
     * them. The rule is that they go to the log and to an operator-only endpoint and nowhere else.
     * What a refused visitor reads is the message on the admission gate, which is checked here
     * against the same vocabulary the findings are allowed to use.
     */
    const visitorMessages = [
      // Every sentence a failed sign-in can put in front of somebody, read from the map itself so
      // that adding a message without reading this rule fails here rather than in front of them.
      ...Object.values(SIGN_IN_FAILURES),
      // And the gate's own message, which the server throws.
      'Your organization is not enabled for this environment yet. Request access and we will set it up.',
    ];
    const forbidden = [
      'ENTRA_',
      'ALLOWED_TENANT_IDS',
      'ACCESS_MODE',
      'APP_BASE_URL',
      'ADMIN_EMAILS',
      'SESSION_SECRET',
      'DEMO_MODE',
      'AADSTS',
      'README',
      'Railway',
      'MSAL',
      'client_id',
      'client secret',
      'stack',
    ];
    for (const message of visitorMessages) {
      for (const term of forbidden) {
        expect(message.toLowerCase(), `visitor message leaked "${term}"`).not.toContain(term.toLowerCase());
      }
    }
  });

  // 13 -----------------------------------------------------------------------
  it('case 13: no finding repeats a secret value, only whether one is present', () => {
    const secret = 'super-secret-client-secret-value';
    const report = describeAuthConfiguration(
      configure({
        ENTRA_CLIENT_SECRET: secret,
        SESSION_SECRET: 'another-secret-session-value-long-enough',
        ENTRA_TENANT_ID: 'our-tenant',
      }),
    );
    const serialised = JSON.stringify(report) + formatAuthConfiguration(report).join('\n');

    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain('another-secret-session-value-long-enough');
    // Presence is reported; the value is not.
    expect(report.clientIdentity.secretPresent).toBe(true);

    // And the one finding that does discuss the secret names the variable without its value, which
    // is what lets an operator fix it without the log becoming a place secrets leak.
    const half = describeAuthConfiguration(configure({ ENTRA_CLIENT_SECRET: undefined, DEMO_MODE: 'true' }));
    const halfText = formatAuthConfiguration(half).join('\n');
    expect(halfText).toContain('ENTRA_CLIENT_SECRET');
    expect(halfText).toContain('ENTRA_CLIENT_SECRET is missing');
    expect(halfText).not.toContain(secret);
  });

  // 14 -----------------------------------------------------------------------
  it('case 14: the startup lines lead with the worst finding and read without expanding anything', () => {
    const lines = formatAuthConfiguration(describeFor());

    expect(lines[0]).toContain('authority https://login.microsoftonline.com/organizations');
    expect(lines[0]).toContain('admission GATED, no directory (the allow list is empty)');
    expect(lines[1]).toMatch(/^\[BLOCKS_SIGN_IN]/);
    // Warnings before notes, so the first thing read is the thing that stops somebody signing in.
    const severities = lines.slice(1).map((l) => l.slice(1, l.indexOf(']')));
    const rank = { BLOCKS_SIGN_IN: 0, WARNING: 1, INFO: 2 } as const;
    const ranks = severities.map((s) => rank[s as keyof typeof rank]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  // 15 -----------------------------------------------------------------------
  it('case 15: the browser is told a code, and an unknown code still reads as something true', () => {
    // What each throw site turns into. The gate's refusal is the one a prospect is most likely to
    // meet once authentication itself works, so it has to be the one that reads like an invitation.
    expect(signInFailureCode('TENANT_NOT_ALLOWED')).toBe('ORGANIZATION_NOT_ENABLED');
    expect(signInFailureCode('INVALID_STATE')).toBe('EXPIRED');
    expect(signInFailureCode('INVALID_NONCE')).toBe('VALIDATION_FAILED');
    expect(signInFailureCode('access_denied')).toBe('ACCESS_DENIED');
    // Anything we did not anticipate, including an MSAL error carrying Microsoft's own text.
    expect(signInFailureCode('AADSTS700016')).toBe('FAILED');
    expect(signInFailureCode(undefined)).toBe('FAILED');

    // A crafted link cannot put words on the page: an unrecognised code is the generic sentence.
    expect(signInFailureMessage('Call 0800 555 0199 to restore your account')).toBe(SIGN_IN_FAILURES.FAILED);
    expect(signInFailureMessage(null)).toBe(SIGN_IN_FAILURES.FAILED);
    expect(signInFailureMessage('ORGANIZATION_NOT_ENABLED')).toBe(SIGN_IN_FAILURES.ORGANIZATION_NOT_ENABLED);
  });

  // 16 -----------------------------------------------------------------------
  it('case 16: a deployment with no operator says so, because the findings would have no audience', () => {
    const none = describeFor({
      ENTRA_TENANT_ID: DIRECTORY_A,
      ALLOWED_TENANT_IDS: DIRECTORY_A,
      ADMIN_EMAILS: undefined,
    });
    expect(codes(none)).toContain('NO_PLATFORM_OPERATOR');

    const mistyped = describeFor({
      ENTRA_TENANT_ID: DIRECTORY_A,
      ALLOWED_TENANT_IDS: DIRECTORY_A,
      ADMIN_EMAILS: 'operator-at-example.com',
    });
    expect(codes(mistyped)).toContain('ADMIN_EMAIL_IS_NOT_AN_ADDRESS');
  });
});
