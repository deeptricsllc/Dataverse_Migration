import type { AppConfig } from '../config';

/**
 * What this deployment's sign-in configuration actually means, and who it will refuse.
 *
 * Three decisions are routinely spoken about as if they were one, and conflating any two of them
 * produces a failure that looks like somebody else's bug:
 *
 *   Client identity  which application Microsoft is being asked about — ENTRA_CLIENT_ID and its
 *                    secret. Nothing else identifies the application.
 *   Authority        which directory Microsoft authenticates *against* — ENTRA_TENANT_ID under
 *                    ENTRA_AUTHORITY_HOST. This is a question put to Microsoft, and it is answered
 *                    before any request reaches this product.
 *   Admission        which directories this product accepts once Microsoft has answered —
 *                    ACCESS_MODE and ALLOWED_TENANT_IDS. This is our decision, taken afterwards, on
 *                    a tenant id that has already been authenticated.
 *
 * An admission list is never an authority. Sending authentication to a directory because it appears
 * on an allow list would mean asking one customer's directory to vouch for another customer's user.
 * The two live in separate fields here, are derived from separate variables, and a test asserts that
 * changing the allow list cannot move the authority.
 *
 * The findings exist because both ways this went wrong on the QA deployment were invisible until
 * somebody tried to sign in, and both were plainly visible in the configuration:
 *
 *   - A single-tenant application registration reached through the `organizations` authority. That
 *     authority resolves the *signing-in user's* home directory, so Microsoft looks for the
 *     application in the user's directory, does not find it, and answers AADSTS700016 on its own
 *     page. No request reaches this product, so nothing this product renders can improve that page.
 *     The only remedy is to not deploy into that state.
 *   - GATED admission with nobody on the allow list. Microsoft succeeds, and then this product
 *     refuses every person who signs in — correctly, and unhelpfully.
 *
 * So the configuration is described at startup, in the operator's language, where somebody can act
 * on it. These messages name environment variables deliberately: they go to the deployment log and
 * to an operator-only endpoint. Nothing here is ever rendered to a visitor — a prospect who cannot
 * sign in gets a sentence about asking for access, never a variable name, and
 * `tests/unit/auth-configuration.test.ts` holds that line.
 */

/** A directory id is a GUID. Anything else on an allow list can never match one. */
const DIRECTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Microsoft's own directory for personal accounts. No work or school account is in it. */
const PERSONAL_ACCOUNT_DIRECTORY = '9188040d-6c67-4c5b-b112-36a304b66dad';

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export type AuthFindingSeverity =
  /** Somebody will be refused who is meant to get in, and the configuration alone proves it. */
  | 'BLOCKS_SIGN_IN'
  /** Likely wrong, or right but worth saying out loud. */
  | 'WARNING'
  /** A deliberate choice, recorded so that it is a choice rather than an accident. */
  | 'INFO';

export interface AuthConfigFinding {
  code: string;
  severity: AuthFindingSeverity;
  /** For the operator. May name variables; no visitor ever reads it. */
  message: string;
  /** What to change. Never a secret value — only which variable holds one. */
  remedy: string;
}

export type AuthorityKind =
  /** A named directory: its own accounts, and the guests invited into it. */
  | 'DIRECTORY'
  /** `organizations` — any work or school account, resolved to the user's home directory. */
  | 'ANY_WORK_OR_SCHOOL'
  /** `common` — the above, plus personal accounts. */
  | 'ANY_ACCOUNT'
  /** `consumers` — personal accounts only. */
  | 'PERSONAL_ONLY'
  /** A verified domain, which names one directory as surely as its GUID does. */
  | 'DOMAIN'
  /** Not a GUID, not a placeholder, not domain-shaped. Microsoft will not resolve it. */
  | 'UNRECOGNISED';

export interface AuthConfigurationReport {
  clientIdentity: {
    /** Both halves present. Either one alone silently disables Microsoft sign-in. */
    configured: boolean;
    clientIdPresent: boolean;
    secretPresent: boolean;
  };
  authority: {
    /** The authority URL sent to Microsoft. Contains no secret. */
    url: string;
    directory: string;
    kind: AuthorityKind;
    /**
     * True when Microsoft decides which directory to use from the user rather than from this
     * deployment. This is the property that turns a single-tenant registration into AADSTS700016
     * for everyone outside the application's own directory.
     */
    resolvesHomeDirectoryOfUser: boolean;
  };
  admission: {
    mode: AppConfig['ACCESS_MODE'];
    allowedDirectories: string[];
    /** True only under OPEN_BETA. GATED with an empty list admits nobody, not everybody. */
    admitsAnyDirectory: boolean;
    admitsNobody: boolean;
  };
  redirect: {
    uri: string;
    /** False when ENTRA_REDIRECT_URI was set explicitly rather than derived from APP_BASE_URL. */
    derived: boolean;
    matchesAppBaseUrl: boolean;
  };
  signInMethods: { microsoft: boolean; demo: boolean };
  findings: AuthConfigFinding[];
  /** False when the configuration proves that nobody at all can complete a sign-in. */
  anySignInPossible: boolean;
}

function classifyAuthority(directory: string): AuthorityKind {
  const value = directory.trim().toLowerCase();
  if (value === 'organizations') return 'ANY_WORK_OR_SCHOOL';
  if (value === 'common') return 'ANY_ACCOUNT';
  if (value === 'consumers') return 'PERSONAL_ONLY';
  if (DIRECTORY_ID.test(value)) return 'DIRECTORY';
  // A verified domain is a legitimate authority and names exactly one directory.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return 'DOMAIN';
  return 'UNRECOGNISED';
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Describes the configuration and lists what it will refuse. Pure: it reads configuration and
 * reaches nothing, so it runs at startup before the first request and inside a unit test alike.
 */
export function describeAuthConfiguration(config: AppConfig): AuthConfigurationReport {
  const findings: AuthConfigFinding[] = [];
  const add = (f: AuthConfigFinding) => findings.push(f);

  const clientIdPresent = Boolean(config.ENTRA_CLIENT_ID);
  const secretPresent = Boolean(config.ENTRA_CLIENT_SECRET);
  const microsoft = config.microsoftEnabled;
  const demo = config.DEMO_MODE;

  const directory = config.ENTRA_TENANT_ID.trim();
  const kind = classifyAuthority(directory);
  const resolvesHomeDirectoryOfUser = kind === 'ANY_WORK_OR_SCHOOL' || kind === 'ANY_ACCOUNT';
  const authorityUrl = `${config.ENTRA_AUTHORITY_HOST.replace(/\/+$/, '')}/${directory}`;

  const allowed = config.allowedTenantIds;
  const admitsAnyDirectory = config.ACCESS_MODE === 'OPEN_BETA';
  const admitsNobody = config.ACCESS_MODE === 'GATED' && allowed.length === 0;

  const appBaseHost = hostOf(config.APP_BASE_URL);
  const redirectHost = hostOf(config.redirectUri);

  // --- client identity ------------------------------------------------------
  if (clientIdPresent !== secretPresent) {
    add({
      code: 'ENTRA_HALF_CONFIGURED',
      severity: 'WARNING',
      message:
        `Microsoft sign-in is switched off because only half of the credential pair is set: ` +
        `ENTRA_CLIENT_ID is ${clientIdPresent ? 'set' : 'missing'} and ENTRA_CLIENT_SECRET is ` +
        `${secretPresent ? 'set' : 'missing'}. The sign-in button will not appear.`,
      remedy: 'Set both ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET, or unset both to run on demo sign-in alone.',
    });
  }

  // --- authority ------------------------------------------------------------
  if (microsoft && resolvesHomeDirectoryOfUser) {
    add({
      code: 'AUTHORITY_RESOLVES_USER_HOME_DIRECTORY',
      severity: 'WARNING',
      message:
        `The authority is ${authorityUrl}, so Microsoft chooses the directory from whoever is signing ` +
        'in rather than from this deployment. If the application registration is single-tenant, every ' +
        'user whose home directory is not the registration’s own is refused by Microsoft with ' +
        'AADSTS700016 ("Application with identifier ... was not found in the directory ..."), on ' +
        'Microsoft’s own page, before any request reaches this product.',
      remedy:
        'Set ENTRA_TENANT_ID to the directory id that owns the application registration (Entra admin ' +
        'centre → App registrations → the application → Directory (tenant) ID). Keep a home-directory ' +
        'authority only if the registration’s audience is multi-tenant and each customer directory has ' +
        'granted admin consent.',
    });
  }
  if (microsoft && (kind === 'PERSONAL_ONLY' || directory.toLowerCase() === PERSONAL_ACCOUNT_DIRECTORY)) {
    add({
      code: 'AUTHORITY_IS_PERSONAL_ACCOUNTS_ONLY',
      severity: 'BLOCKS_SIGN_IN',
      message:
        `The authority is ${authorityUrl}, which authenticates personal Microsoft accounts only. This ` +
        'product migrates data held in work and school directories, so no account that can reach a ' +
        'Dataverse environment can sign in through it.',
      remedy: 'Set ENTRA_TENANT_ID to a work or school directory id.',
    });
  }
  if (microsoft && kind === 'UNRECOGNISED') {
    add({
      code: 'AUTHORITY_NOT_RECOGNISED',
      severity: 'BLOCKS_SIGN_IN',
      message:
        `ENTRA_TENANT_ID is "${directory}", which is neither a directory id (a GUID), nor a verified ` +
        'domain, nor one of organizations / common / consumers. Microsoft will not resolve this ' +
        'authority and every sign-in will fail at Microsoft.',
      remedy: 'Set ENTRA_TENANT_ID to the directory id that owns the application registration.',
    });
  }

  // --- admission ------------------------------------------------------------
  if (microsoft && admitsNobody) {
    add({
      code: 'GATED_WITH_EMPTY_ALLOW_LIST',
      severity: 'BLOCKS_SIGN_IN',
      message:
        'Microsoft sign-in is configured and ACCESS_MODE is GATED, but ALLOWED_TENANT_IDS names no ' +
        'directory. Microsoft will authenticate people successfully and this product will then refuse ' +
        'every one of them. GATED with an empty list admits nobody — it does not admit everybody.',
      remedy:
        'Set ALLOWED_TENANT_IDS to the comma-separated directory ids permitted to sign in, or set ' +
        'ACCESS_MODE=OPEN_BETA if this deployment is genuinely meant to be open.',
    });
  }
  for (const entry of allowed) {
    if (!DIRECTORY_ID.test(entry)) {
      add({
        code: 'ALLOW_LIST_ENTRY_IS_NOT_A_DIRECTORY_ID',
        severity: 'WARNING',
        message:
          `ALLOWED_TENANT_IDS contains "${entry}", which is not a directory id. Admission compares the ` +
          'tenant id Microsoft returns, which is always a GUID, so this entry can never match and that ' +
          'organization can never sign in.',
        remedy:
          'Replace it with the directory id (a GUID). A domain name identifies a directory to a person ' +
          'but not to this comparison.',
      });
    }
  }
  if (admitsAnyDirectory && allowed.length > 0) {
    add({
      code: 'ALLOW_LIST_HAS_NO_EFFECT',
      severity: 'INFO',
      message:
        `ACCESS_MODE is OPEN_BETA, so the ${allowed.length} directory id(s) in ALLOWED_TENANT_IDS ` +
        'change nothing: any work or school directory is admitted.',
      remedy: 'Set ACCESS_MODE=GATED for the list to be enforced.',
    });
  }
  if (admitsAnyDirectory && config.NODE_ENV === 'production') {
    add({
      code: 'OPEN_TO_ANY_DIRECTORY',
      severity: 'WARNING',
      message:
        'ACCESS_MODE is OPEN_BETA in production: anyone with a work or school account can sign in, and ' +
        'a workspace is created for their directory on first sign-in.',
      remedy: 'Intended for an open beta. Set ACCESS_MODE=GATED to admit named directories only.',
    });
  }

  // --- redirect -------------------------------------------------------------
  if (microsoft && appBaseHost && redirectHost && appBaseHost !== redirectHost) {
    add({
      code: 'REDIRECT_URI_HOST_DIFFERS_FROM_APP_BASE_URL',
      severity: 'WARNING',
      message:
        `The redirect URI points at ${redirectHost} while APP_BASE_URL points at ${appBaseHost}. ` +
        'Sign-in will leave this deployment and land on the other host, if Microsoft accepts it at all.',
      remedy: 'Unset ENTRA_REDIRECT_URI to derive it from APP_BASE_URL, or correct whichever is wrong.',
    });
  }
  if (microsoft && config.NODE_ENV === 'production' && !config.redirectUri.startsWith('https://')) {
    add({
      code: 'REDIRECT_URI_NOT_HTTPS',
      severity: 'WARNING',
      message:
        `The redirect URI is ${config.redirectUri}. Microsoft requires https for anything but ` +
        'localhost, and an authorization code would cross the network in clear text.',
      remedy: 'Serve the deployment over https and set APP_BASE_URL accordingly.',
    });
  }

  // --- operability ----------------------------------------------------------
  if (config.adminEmails.length === 0) {
    add({
      code: 'NO_PLATFORM_OPERATOR',
      severity: 'WARNING',
      message:
        'ADMIN_EMAILS is empty, so nobody is a platform operator: access requests, alert tests and this ' +
        'configuration report have no audience. The first person to sign in from a directory still ' +
        'administers that one workspace.',
      remedy: 'Set ADMIN_EMAILS to the comma-separated addresses that operate this deployment.',
    });
  }
  for (const entry of config.adminEmails) {
    if (!EMAIL.test(entry)) {
      add({
        code: 'ADMIN_EMAIL_IS_NOT_AN_ADDRESS',
        severity: 'WARNING',
        message:
          `ADMIN_EMAILS contains "${entry}", which is not an email address, so it will never match a ` +
          'signed-in user.',
        remedy: 'Correct the entry. Matching is on the address Microsoft returns, lower-cased.',
      });
    }
  }
  if (demo && microsoft) {
    add({
      code: 'DEMO_SIGN_IN_ALSO_AVAILABLE',
      severity: 'INFO',
      message:
        'DEMO_MODE is on alongside Microsoft sign-in, so an anonymous visitor can create a demo ' +
        'workspace without authenticating. Admission does not apply to that path.',
      remedy: 'Set DEMO_MODE=false for a deployment where every visitor must authenticate.',
    });
  }

  const microsoftUsable = microsoft && !findings.some((f) => f.severity === 'BLOCKS_SIGN_IN');

  return {
    clientIdentity: { configured: microsoft, clientIdPresent, secretPresent },
    authority: { url: authorityUrl, directory, kind, resolvesHomeDirectoryOfUser },
    admission: { mode: config.ACCESS_MODE, allowedDirectories: allowed, admitsAnyDirectory, admitsNobody },
    redirect: {
      uri: config.redirectUri,
      derived: !config.ENTRA_REDIRECT_URI,
      matchesAppBaseUrl: Boolean(appBaseHost && redirectHost && appBaseHost === redirectHost),
    },
    signInMethods: { microsoft, demo },
    findings,
    anySignInPossible: microsoftUsable || demo,
  };
}

/**
 * The startup lines. One summary, then one line per finding, worst first — so an operator reading a
 * deployment log sees "nobody can sign in" without expanding anything.
 */
export function formatAuthConfiguration(report: AuthConfigurationReport): string[] {
  const order: AuthFindingSeverity[] = ['BLOCKS_SIGN_IN', 'WARNING', 'INFO'];
  const sorted = [...report.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const methods = [
    report.signInMethods.microsoft ? 'Microsoft' : null,
    report.signInMethods.demo ? 'demo' : null,
  ].filter(Boolean);
  const admission = report.admission.admitsAnyDirectory
    ? 'any work or school directory'
    : report.admission.admitsNobody
      ? 'no directory (the allow list is empty)'
      : `${report.admission.allowedDirectories.length} named directory/ies`;
  return [
    `Sign-in: ${methods.length > 0 ? methods.join(' + ') : 'nothing configured'}; ` +
      `authority ${report.authority.url} (${report.authority.kind}); ` +
      `admission ${report.admission.mode}, ${admission}; redirect ${report.redirect.uri}`,
    ...sorted.map((f) => `[${f.severity}] ${f.code}: ${f.message} — ${f.remedy}`),
  ];
}
