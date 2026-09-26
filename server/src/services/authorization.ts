import { classifyEnvironment, type EnvironmentClass } from '../../../shared/domain';
import { forbidden } from '../lib/errors';
import type { RequestContext } from './context';

/**
 * Who may do what.
 *
 * The role existed on every request and was checked in exactly two places, so in practice any member
 * could delete a connection and its stored credential, or create a schedule that writes to production
 * unattended. That is not a policy, it is an absence of one — and it is the first thing a security
 * reviewer asks about.
 *
 * The policy here is deliberately narrow, because a migration team is not an org chart: members are
 * the people who do the work, and locking them out of the work would just mean everyone becomes an
 * administrator. So membership is enough to plan, analyse, preflight and migrate. What needs an
 * administrator is the small set of actions whose consequences outlive the task:
 *
 * - **Writing to production.** A non-production target is where the work happens and mistakes are
 *   cheap. Production is the one place a mistake is not, so it takes someone accountable for it.
 * - **Unattended writing.** A schedule keeps writing when nobody is watching, so creating, changing
 *   or firing one is a standing grant rather than a single action.
 * - **Destroying configuration.** Deleting a connection destroys a stored credential and the
 *   configuration other people's plans depend on.
 *
 * Everything else stays open on purpose.
 */

/** Refuses anyone who is not an administrator, naming what they were trying to do. */
export function requireAdmin(ctx: RequestContext, action: string): void {
  if (ctx.role === 'ADMIN') return;
  throw forbidden(
    `${action} needs an administrator. You are signed in as a member, which can plan, analyse and migrate but cannot ${action.toLowerCase()}.`,
  );
}

/**
 * Refuses a member writing to production.
 *
 * `UNKNOWN` is treated as production. A hand-configured database carries no environment
 * classification, so "we could not tell" has to mean "assume it matters" — the alternative is that
 * every SQL target is implicitly non-production, which is precisely backwards.
 */
export function requireAdminForProductionTarget(
  ctx: RequestContext,
  target: { environmentType: string | null; displayName: string },
  action: string,
): void {
  if (ctx.role === 'ADMIN') return;
  const classification: EnvironmentClass = classifyEnvironment(target.environmentType);
  if (classification === 'NON_PRODUCTION') return;
  throw forbidden(
    `${action} to ${target.displayName} needs an administrator: it is ${
      classification === 'PRODUCTION' ? 'a production environment' : 'not classified as non-production'
    }. A member can migrate to a sandbox, development or test environment.`,
  );
}
