import { and, count, eq, ne } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AppDb } from '../db/client';
import { users } from '../db/schema';
import { WORKSPACE_ROLES, normaliseRole, type WorkspaceRole } from '../../../shared/authorization';
import { AppError, badRequest, notFound } from '../lib/errors';
import { requireAdmin } from './authorization';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';

/**
 * Who is in this workspace, and what each of them may do.
 *
 * This exists because the roles did not. Four workspace roles were defined, enforced on every request and
 * covered by tests — and there was no way to assign one. A workspace's first member became `ADMIN` because
 * they were first, everybody after them became `MIGRATION_OPERATOR`, and nothing in the product could
 * change either. `VALIDATOR` and `READ_ONLY` existed in the type system and could not be reached.
 *
 * A permission model nobody can configure is not a permission model; it is two hard-coded roles with extra
 * names. So: a list anybody in the workspace may read, and a change only an administrator may make.
 *
 * Two guards, and both of them are about the failure that cannot be undone from inside the product:
 *
 *   - **Nobody changes their own role.** An administrator who demotes themselves has locked the workspace,
 *     and there is no support tool to unlock it.
 *   - **The last administrator stays.** Demoting the only remaining one is the same lockout by a different
 *     route, so it is refused with the reason rather than permitted and regretted.
 */

export interface TeamMemberDto {
  id: string;
  displayName: string;
  email: string | null;
  role: WorkspaceRole;
  /** What the row stored, before normalisation. `MEMBER` predates the four roles. */
  storedRole: string;
  lastLoginAt: string | null;
  createdAt: string;
  authProvider: string;
  /** True for the person asking, so the interface can refuse to let them change it. */
  isYou: boolean;
  /** True when this is the only administrator left, so the interface can say why it is fixed. */
  isLastAdmin: boolean;
}

export class TeamService {
  constructor(
    private readonly db: AppDb,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  /**
   * The workspace's members.
   *
   * Readable by anybody in it, deliberately: knowing who else can see your data is not privileged
   * information, and a read-only member who cannot tell who to ask for access has been given a dead end.
   */
  async list(ctx: RequestContext): Promise<TeamMemberDto[]> {
    const rows = await this.db.select().from(users).where(eq(users.organizationId, ctx.organizationId));
    const admins = rows.filter((r) => normaliseRole(r.role) === 'ADMIN');
    return rows
      .map((r) => ({
        id: r.id,
        displayName: r.displayName,
        email: r.email,
        role: normaliseRole(r.role),
        storedRole: r.role,
        lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        authProvider: r.authProvider,
        isYou: r.id === ctx.userId,
        isLastAdmin: normaliseRole(r.role) === 'ADMIN' && admins.length === 1,
      }))
      .sort((a, b) => {
        // Administrators first, then by name: the list answers "who do I ask" before "who else is here".
        if (a.role !== b.role) return a.role === 'ADMIN' ? -1 : b.role === 'ADMIN' ? 1 : 0;
        return a.displayName.localeCompare(b.displayName);
      });
  }

  /** Changes somebody's role. Administrators only, and never their own. */
  async setRole(ctx: RequestContext, userId: string, role: WorkspaceRole): Promise<TeamMemberDto[]> {
    requireAdmin(ctx, 'change a role');
    if (!(WORKSPACE_ROLES as readonly string[]).includes(role)) {
      throw badRequest(`${role} is not a role in this workspace`);
    }
    if (userId === ctx.userId) {
      /**
       * Refused even when it would be harmless, because the harmful case and the harmless one look
       * identical at the moment of the click and only one of them is recoverable.
       */
      throw badRequest(
        'You cannot change your own role. Ask another administrator, so a workspace cannot be locked by one person.',
      );
    }

    const [target] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId)));
    if (!target) throw notFound('That person');

    const current = normaliseRole(target.role);
    if (current === role) return this.list(ctx);

    if (current === 'ADMIN' && role !== 'ADMIN') {
      const [others] = await this.db
        .select({ n: count() })
        .from(users)
        .where(
          and(eq(users.organizationId, ctx.organizationId), ne(users.id, userId), eq(users.role, 'ADMIN')),
        );
      if (Number(others?.n ?? 0) === 0) {
        throw new AppError(
          409,
          'LAST_ADMIN',
          'This is the only administrator in the workspace. Make somebody else an administrator first, or nobody will be able to change a role again.',
        );
      }
    }

    await this.db.update(users).set({ role }).where(eq(users.id, userId));
    this.logger.info({ userId, from: current, to: role }, 'Workspace role changed');
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'TEAM_ROLE_CHANGED',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      // Who, by whom, from what to what. The three things an auditor asks about a permission change.
      details: { subject: userId, subjectEmail: target.email, from: current, to: role },
    });
    return this.list(ctx);
  }
}
