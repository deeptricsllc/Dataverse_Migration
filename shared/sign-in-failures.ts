/**
 * What a person is told when a sign-in does not complete.
 *
 * Two rules, and they are the whole reason this file exists rather than a string at each throw site.
 *
 * The first is that a prospect never reads our internals. Not a variable name, not `AADSTS…`, not a
 * redirect URI, not a stack, not the name of the host this runs on. Somebody evaluating the product
 * learns that they cannot get in and what to do about it; the person who can fix it learns the rest
 * from the deployment log, where the tenant id and the configuration findings already go.
 *
 * The second is that the browser is told a *code*, not a sentence. The callback used to redirect to
 * `/login?error=<message>` and the page rendered whatever arrived. React escapes it, so nothing
 * could be injected — but anyone could send a prospect a link to our own domain that displayed a
 * sentence of their choosing under a "Sign-in failed" heading, which is a phishing surface for the
 * cost of a query string. A closed set of codes cannot say anything we did not write.
 *
 * An unrecognised code reads as the generic failure, so an older deployment and a newer page, or the
 * reverse, degrade to something true rather than to a blank callout.
 */
export const SIGN_IN_FAILURES = {
  /** The person declined consent, or an administrator has not granted it. */
  ACCESS_DENIED:
    'Access was declined. If your organization requires administrator approval, ask them to grant it and try again.',
  /** Microsoft redirected back without an authorization code: a cancelled or expired attempt. */
  INCOMPLETE: 'That sign-in did not finish. Please try again.',
  /** The one-time state was missing, reused, or past its expiry — usually a stale tab. */
  EXPIRED: 'That sign-in link had expired. Please try again.',
  /** State or nonce did not match what we issued. Rare, and worth a fresh attempt from the page. */
  VALIDATION_FAILED: 'We could not verify that sign-in. Please start again from this page.',
  /** Authenticated successfully, and this deployment does not admit that organization. */
  ORGANIZATION_NOT_ENABLED:
    'Your organization is not enabled for this environment yet. Request access and we will set it up.',
  /** Anything else. Deliberately says nothing about what went wrong. */
  FAILED: 'Sign-in failed. Please try again, or request access and we will help.',
} as const;

export type SignInFailureCode = keyof typeof SIGN_IN_FAILURES;

/** Maps the error a sign-in threw to the code the browser is given. */
export function signInFailureCode(errorCode: string | undefined): SignInFailureCode {
  switch (errorCode) {
    case 'INVALID_STATE':
      return 'EXPIRED';
    case 'INVALID_NONCE':
      return 'VALIDATION_FAILED';
    case 'TENANT_NOT_ALLOWED':
      return 'ORGANIZATION_NOT_ENABLED';
    case 'access_denied':
      return 'ACCESS_DENIED';
    default:
      return 'FAILED';
  }
}

/** What to render. Unknown input reads as the generic failure rather than as nothing. */
export function signInFailureMessage(code: string | null | undefined): string {
  if (code && code in SIGN_IN_FAILURES) return SIGN_IN_FAILURES[code as SignInFailureCode];
  return SIGN_IN_FAILURES.FAILED;
}
