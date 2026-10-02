import { PRODUCT_VERSION } from '../../shared/product';

/**
 * Which build produced this.
 *
 * The question this answers is the one that gets asked when something is wrong: "the validation report
 * is incorrect" is unanswerable without knowing which build wrote it. A report, an evidence package and
 * a bug description that cannot be tied to a commit cost a day each time.
 *
 * Two audiences, and they get different amounts:
 *
 *   - **Anyone**, through `/api/health`: the version and which deployment this is. Enough to tell a QA
 *     deployment from a production one and to see that a deploy landed.
 *   - **A signed-in user**, through `/api/settings`: the commit as well. A commit identifier for a
 *     private repository is not a secret, but it is not useful to a stranger either, so it sits behind
 *     the session rather than in front of it.
 *
 * Every evidence package records the full identity, because a package outlives the deployment that
 * produced it and "which build made this" is exactly the question somebody will ask of an artifact
 * from six months ago.
 */

/** The commit, from whichever variable the platform building this happens to set. */
function resolveCommit(env: NodeJS.ProcessEnv): string | null {
  const raw =
    env.BUILD_COMMIT ??
    env.RAILWAY_GIT_COMMIT_SHA ??
    env.GIT_COMMIT ??
    env.COMMIT_SHA ??
    env.SOURCE_VERSION ??
    env.VERCEL_GIT_COMMIT_SHA ??
    null;
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  // Twelve characters identify a commit without implying the whole hash is meaningful to a reader.
  return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed.slice(0, 12) : null;
}

/** A readable branch name, where the builder provides one. Never a URL or a token. */
function resolveBranch(env: NodeJS.ProcessEnv): string | null {
  const raw = env.BUILD_BRANCH ?? env.RAILWAY_GIT_BRANCH ?? env.GIT_BRANCH ?? null;
  if (!raw) return null;
  const trimmed = raw.trim();
  return /^[\w.\-/]{1,120}$/.test(trimmed) ? trimmed : null;
}

/**
 * Which deployment this is, for a human reading a page or a log line.
 *
 * Derived from the host rather than configured, so it cannot disagree with reality: a deployment that
 * says "production" in a variable and serves a QA hostname is worse than one that says nothing. The
 * host is already public — the browser typed it — so naming it reveals nothing.
 */
function resolveDeployment(appBaseUrl: string, nodeEnv: string): string {
  let host: string;
  try {
    host = new URL(appBaseUrl).hostname.toLowerCase();
  } catch {
    return nodeEnv;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return 'local';
  // The first label of the hostname is what distinguishes one deployment from another in practice.
  const label = host.split('.')[0] ?? host;
  if (/-?qa$|^qa-/.test(label)) return 'qa';
  if (/-?staging$|^staging-/.test(label)) return 'staging';
  return label;
}

export interface BuildIdentity {
  /** The application version, from package.json by way of `shared/product.ts`. */
  version: string;
  /** The commit this was built from, shortened. Null when the builder did not say. */
  commit: string | null;
  branch: string | null;
  /** Which deployment this is, derived from the hostname it serves. */
  deployment: string;
  /** Node's own environment setting, which decides several safety defaults. */
  nodeEnv: string;
  /** When the process started. Not the build time, and labelled so it is not read as one. */
  startedAt: string;
}

const STARTED_AT = new Date().toISOString();

export function buildIdentity(
  config: { APP_BASE_URL: string; NODE_ENV: string },
  env: NodeJS.ProcessEnv = process.env,
): BuildIdentity {
  return {
    version: PRODUCT_VERSION,
    commit: resolveCommit(env),
    branch: resolveBranch(env),
    deployment: resolveDeployment(config.APP_BASE_URL, config.NODE_ENV),
    nodeEnv: config.NODE_ENV,
    startedAt: STARTED_AT,
  };
}

/** What anybody may see: enough to tell deployments apart and to see that a deploy landed. */
export function publicBuildIdentity(identity: BuildIdentity): {
  version: string;
  deployment: string;
} {
  return { version: identity.version, deployment: identity.deployment };
}

/** One line for a log or a report. Contains nothing a hostname does not already reveal. */
export function describeBuild(identity: BuildIdentity): string {
  const parts = [`v${identity.version}`, identity.deployment];
  if (identity.commit)
    parts.push(identity.branch ? `${identity.branch}@${identity.commit}` : identity.commit);
  return parts.join(' · ');
}
