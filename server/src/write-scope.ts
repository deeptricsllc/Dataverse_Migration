import { classifyEnvironment } from '../../shared/domain';

/**
 * Which environments this deployment may write to, and why.
 *
 * ## The problem this solves
 *
 * `REAL_TENANT_READ_ONLY` is one boolean for the whole deployment. That is the right default and the
 * wrong granularity for the thing people actually need to do: prove a migration works by running one,
 * into one sandbox, without opening writes to everything else the signed-in user can reach.
 *
 * Before this existed, certifying a single sandbox meant setting `REAL_TENANT_READ_ONLY=false`, which
 * permitted writes to **every real environment that identity has a role in** — including Production in
 * the same tenant. The only remaining guard was `requireAdminForProductionTarget`, and the person doing
 * the certification is an administrator of their own workspace, so they pass it. One mis-selected target
 * and a certification run writes to production. That is not a safety model, it is a near miss waiting for
 * its occasion.
 *
 * ## The model
 *
 * `CERTIFICATION_WRITE_ENVIRONMENTS` names, explicitly, the environments that may be written to while the
 * deployment is otherwise read-only. Every rule below fails closed:
 *
 * - **Unset is today's behavior, exactly.** No list means every real write is refused, with the message
 *   it has always had. Nothing about an existing deployment changes by upgrading.
 * - **Being on the list is necessary, not sufficient.** A listed environment is still refused unless
 *   `classifyEnvironment` returns `NON_PRODUCTION`. Production cannot be opened by listing it, and
 *   neither can an environment whose type we could not read — which is the case that matters, because
 *   an unclassified environment is the one most likely to be production.
 * - **It only ever narrows.** The list is consulted when `REAL_TENANT_READ_ONLY` is true. It cannot grant
 *   anything that flag does not already deny, so it is not a second way to turn writes on.
 * - **It is not a bypass, because it is not quiet.** The decision carries its reason; the audit trail
 *   records which environment was permitted and under which rule; the settings and operator reports name
 *   the scope. A permission nobody can see is the thing this is meant to prevent.
 *
 * Both guards consult this: the one that refuses to queue a run, and the one in the Dataverse client that
 * refuses the HTTP request. They have to agree, which is why the decision lives in one function rather
 * than being spelled out twice.
 */

/** Why a write was permitted or refused. Carried into the audit trail, never flattened to a boolean. */
export type WriteScopeReason =
  | 'WRITES_ENABLED'
  | 'SIMULATED_ENVIRONMENT'
  | 'CERTIFICATION_SCOPE'
  | 'READ_ONLY_DEPLOYMENT'
  | 'NOT_IN_CERTIFICATION_SCOPE'
  | 'PRODUCTION_OR_UNCLASSIFIED';

export interface WriteScopeDecision {
  allowed: boolean;
  reason: WriteScopeReason;
  /** Customer-facing. Says what was refused and what would change it; never names a variable. */
  message: string;
}

/** The part of an environment this decision depends on. Deliberately small, so tests state it in full. */
export interface WriteScopeTarget {
  provider: string | null;
  url: string | null;
  apiUrl?: string | null;
  environmentType: string | null;
  displayName?: string | null;
}

export interface WriteScopeConfig {
  REAL_TENANT_READ_ONLY: boolean;
  /** Normalized by `loadConfig`: lowercased, trailing slashes stripped, empties dropped. */
  certificationWriteEnvironments: readonly string[];
}

/** Trailing slashes and case are not meaningful in a Dataverse environment URL; neither should decide this. */
export const normalizeEnvironmentKey = (value: string | null | undefined): string =>
  (value ?? '').trim().toLowerCase().replace(/\/+$/, '');

/**
 * A simulated environment holds no tenant data, so the switch that protects a real tenant does not
 * disable it. This mirrors the long-standing behavior in the connector factory rather than inventing it.
 */
const isSimulated = (provider: string | null) => provider === 'demo' || provider === 'demosql';

export function decideWriteScope(config: WriteScopeConfig, target: WriteScopeTarget): WriteScopeDecision {
  if (isSimulated(target.provider)) {
    return {
      allowed: true,
      reason: 'SIMULATED_ENVIRONMENT',
      message: 'This is a simulated environment. It holds no tenant data.',
    };
  }
  if (!config.REAL_TENANT_READ_ONLY) {
    return { allowed: true, reason: 'WRITES_ENABLED', message: 'This deployment permits writes.' };
  }

  const scope = config.certificationWriteEnvironments;
  const name = target.displayName ?? 'this environment';
  if (scope.length === 0) {
    return {
      allowed: false,
      reason: 'READ_ONLY_DEPLOYMENT',
      message:
        'This deployment is in read-only certification mode. Every write to a real environment is refused.',
    };
  }

  // Either form may be the one that was listed: discovery returns an application URL and a web API URL,
  // and the connector addresses the environment by whichever it has.
  const keys = [normalizeEnvironmentKey(target.url), normalizeEnvironmentKey(target.apiUrl)].filter(Boolean);
  /**
   * Both sides normalized here, although `loadConfig` already normalizes the list.
   *
   * Doing it twice costs nothing and removes a correctness dependency on every caller that ever
   * constructs this config. The failure it prevents is quiet: a trailing slash on a listed URL would
   * refuse the environment it was meant to approve, and somebody would go looking for the reason in
   * Dataverse permissions.
   */
  const listed = scope.map(normalizeEnvironmentKey).some((entry) => entry !== '' && keys.includes(entry));
  if (!listed) {
    return {
      allowed: false,
      reason: 'NOT_IN_CERTIFICATION_SCOPE',
      message:
        `This deployment is in read-only certification mode, and ${name} is not one of the environments ` +
        'approved to receive writes. Every write to it is refused.',
    };
  }

  /**
   * The rule that makes the list safe to use.
   *
   * `classifyEnvironment` returns UNKNOWN for a type it does not recognize and for a missing one, and
   * both are refused here along with PRODUCTION. Listing an environment is a statement that it is
   * disposable; this is the check that the environment agrees.
   */
  const classification = classifyEnvironment(target.environmentType);
  if (classification !== 'NON_PRODUCTION') {
    return {
      allowed: false,
      reason: 'PRODUCTION_OR_UNCLASSIFIED',
      message:
        `${name} is approved to receive writes, but it is ` +
        (classification === 'PRODUCTION' ? 'a production environment' : 'not classified as non-production') +
        '. Controlled certification writes are permitted to sandbox, developer, trial and test ' +
        'environments only, so every write to it is refused.',
    };
  }

  return {
    allowed: true,
    reason: 'CERTIFICATION_SCOPE',
    message: `${name} is approved for controlled certification writes, and is non-production.`,
  };
}

/** What the settings and operator reports say, so the scope is never invisible state. */
export function describeWriteScope(config: WriteScopeConfig) {
  return {
    realTenantReadOnly: config.REAL_TENANT_READ_ONLY,
    certificationWriteEnvironments: [...config.certificationWriteEnvironments],
    /**
     * Spelled out because "read-only: true, and also these three may be written" is a sentence somebody
     * will otherwise have to assemble from two fields and an assumption.
     */
    summary: !config.REAL_TENANT_READ_ONLY
      ? 'Writes are permitted to every environment this deployment can reach.'
      : config.certificationWriteEnvironments.length === 0
        ? 'Read-only: every write to a real environment is refused.'
        : `Read-only, except for ${config.certificationWriteEnvironments.length} environment(s) approved for controlled certification writes. Production and unclassified environments are refused even when approved.`,
  };
}
