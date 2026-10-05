import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { PROJECT_KINDS, type ProjectDto, type ProjectKind, type ProjectStatus } from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { analysisRuns, dataComparisons, environments, migrationPlans, projects, users } from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import { envRef } from './env-ref';
import type { EnvironmentService } from './environment-service';

/**
 * Projects: the container everything else hangs off.
 *
 * The kind is not a label. An analysis project has a source and no target, and nothing it can do
 * writes anywhere; a migration project has both and carries every safety gate; a comparison project
 * has two sides and writes to neither. Keeping that distinction in one place means a screen can
 * never offer a write action on work that was only ever meant to look.
 */
/**
 * Kinds that have a second environment. A comparison's two sides are both read-only, so unlike a
 * migration it is allowed to point both at the same connection: comparing two tables inside one
 * database — a staging table against the live one — is an ordinary thing to want.
 */
const TWO_SIDED: ReadonlySet<ProjectKind> = new Set<ProjectKind>(['MIGRATION', 'COMPARISON']);

export class ProjectService {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async list(ctx: RequestContext, filter: { kind?: ProjectKind; includeArchived?: boolean } = {}) {
    const where = [eq(projects.organizationId, ctx.organizationId)];
    if (filter.kind) where.push(eq(projects.kind, filter.kind));
    if (!filter.includeArchived) where.push(eq(projects.status, 'ACTIVE'));
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(...where))
      .orderBy(desc(projects.updatedAt));
    return this.toDtos(rows);
  }

  async get(ctx: Pick<RequestContext, 'organizationId'>, projectId: string): Promise<ProjectDto> {
    const row = await this.row(ctx, projectId);
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  /** The row itself, for callers that need the environment ids rather than the DTO. */
  async row(ctx: Pick<RequestContext, 'organizationId'>, projectId: string) {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Project');
    return row;
  }

  /** The row, and a guarantee it is the kind the caller expects. */
  async ofKind(ctx: Pick<RequestContext, 'organizationId'>, projectId: string, kind: ProjectKind) {
    const row = await this.row(ctx, projectId);
    if (row.kind !== kind) {
      throw badRequest(
        `That is a ${row.kind.toLowerCase()} project; this action needs a ${kind.toLowerCase()} project`,
      );
    }
    return row;
  }

  /**
   * Refuses a name another active project in this workspace already has.
   *
   * Three projects called `Test_Analysis` used to be possible, which makes a project name useless as a
   * way to refer to anything: navigation, exports, audit entries, run history and a support conversation
   * all become ambiguous at once.
   *
   * This check exists for the message. It is not what makes the rule hold — two concurrent requests both
   * pass it before either has inserted — so there is also a partial unique index, and
   * `asFriendlyNameConflict` turns the race into the same sentence a person reads here. A product that
   * enforces a rule only in the service enforces it only most of the time.
   *
   * Comparison is case-insensitive: "Customer Migration" and "customer migration" are the same name to
   * the person who has to tell them apart, and that is the ambiguity being prevented.
   */
  private async assertNameAvailable(organizationId: string, name: string, exceptProjectId?: string) {
    const where = [
      eq(projects.organizationId, organizationId),
      eq(projects.status, 'ACTIVE'),
      sql`lower(${projects.name}) = lower(${name})`,
    ];
    if (exceptProjectId) where.push(ne(projects.id, exceptProjectId));
    const [clash] = await this.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(...where))
      .limit(1);
    if (clash) throw this.nameConflict(clash.name);
  }

  private nameConflict(name: string) {
    return conflict(`A project named "${name}" already exists in this workspace.`);
  }

  /**
   * Turns the unique-index violation into the message the pre-check would have given.
   *
   * Postgres `23505` is a unique violation. Letting it through would show somebody
   * `duplicate key value violates unique constraint "projects_org_active_name_unique"`, which names our
   * index and tells them nothing they can act on. Only this index is translated: any other unique
   * violation is a bug and must keep looking like one rather than being reported as a naming problem.
   */
  private asFriendlyNameConflict(err: unknown, name: string): unknown {
    const codes: string[] = [];
    let current: unknown = err;
    for (let depth = 0; current && depth < 6; depth += 1) {
      const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
      if (typeof e.code === 'string') codes.push(e.code);
      const text = `${typeof e.constraint === 'string' ? e.constraint : ''} ${typeof e.message === 'string' ? e.message : ''}`;
      if (codes.includes('23505') && text.includes('projects_org_active_name_unique')) {
        return this.nameConflict(name);
      }
      current = e.cause;
    }
    return err;
  }

  async create(
    ctx: RequestContext,
    input: {
      name: string;
      kind: ProjectKind;
      description?: string | null;
      sourceEnvironmentId?: string | null;
      targetEnvironmentId?: string | null;
      analysisProjectId?: string | null;
    },
  ): Promise<ProjectDto> {
    if (!PROJECT_KINDS.includes(input.kind)) throw badRequest('Unknown project kind');
    const name = input.name.trim();
    if (!name) throw badRequest('A project needs a name');

    const source = await this.resolveEnvironment(ctx, input.sourceEnvironmentId);
    const target = TWO_SIDED.has(input.kind)
      ? await this.resolveEnvironment(ctx, input.targetEnvironmentId)
      : null;
    if (input.kind === 'ANALYSIS' && input.targetEnvironmentId) {
      throw badRequest('An analysis project has no target: it only ever reads the source');
    }
    if (source && target && source.id === target.id && input.kind !== 'COMPARISON') {
      throw badRequest('The source and target cannot be the same environment');
    }
    const analysisProjectId = await this.resolveAnalysisReference(ctx, input.kind, input.analysisProjectId);
    await this.assertNameAvailable(ctx.organizationId, name);

    const inserted = await this.db
      .insert(projects)
      .values({
        organizationId: ctx.organizationId,
        name,
        kind: input.kind,
        description: input.description?.trim() || null,
        sourceEnvironmentId: source?.id ?? null,
        targetEnvironmentId: target?.id ?? null,
        analysisProjectId,
        createdByUserId: ctx.userId,
      })
      .returning()
      // The check above lost the race. Same sentence either way, so the caller cannot tell which of the
      // two paths refused them — and does not need to.
      .catch((err: unknown) => {
        throw this.asFriendlyNameConflict(err, name);
      });
    const [row] = inserted;

    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'PROJECT_CREATED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: source?.id ?? null,
      targetEnvironmentId: target?.id ?? null,
      requestId: ctx.requestId,
      details: { projectId: row.id, name, kind: input.kind, analysisProjectId },
    });
    this.logger.info({ projectId: row.id, kind: input.kind }, 'Project created');
    return this.get(ctx, row.id);
  }

  async update(
    ctx: RequestContext,
    projectId: string,
    patch: {
      name?: string;
      description?: string | null;
      sourceEnvironmentId?: string | null;
      targetEnvironmentId?: string | null;
      analysisProjectId?: string | null;
      status?: ProjectStatus;
    },
  ): Promise<ProjectDto> {
    const existing = await this.row(ctx, projectId);
    const next: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw badRequest('A project needs a name');
      next.name = name;
    }
    if (patch.description !== undefined) next.description = patch.description?.trim() || null;
    if (patch.status !== undefined) next.status = patch.status;

    /**
     * Renaming and un-archiving are the same hazard as creating.
     *
     * A rename can collide with another active project, and bringing an archived project back can collide
     * with the one that took its name while it was away — which is the case a check written only for
     * `create` would miss. Both are resolved against the name and status this update will leave behind,
     * excluding this project from the comparison so renaming something to what it is already called is not
     * a conflict with itself.
     */
    const resultingName = next.name ?? existing.name;
    const resultingStatus = next.status ?? existing.status;
    if (resultingStatus === 'ACTIVE' && (next.name !== undefined || next.status !== undefined)) {
      await this.assertNameAvailable(ctx.organizationId, resultingName, existing.id);
    }

    if (patch.sourceEnvironmentId !== undefined) {
      // Changing the source after an analysis has run would make the stored results describe a
      // database this project no longer points at.
      if (patch.sourceEnvironmentId !== existing.sourceEnvironmentId) await this.assertNoWork(existing.id);
      next.sourceEnvironmentId = (await this.resolveEnvironment(ctx, patch.sourceEnvironmentId))?.id ?? null;
    }
    if (patch.targetEnvironmentId !== undefined) {
      if (existing.kind === 'ANALYSIS' && patch.targetEnvironmentId) {
        throw badRequest('An analysis project has no target: it only ever reads the source');
      }
      next.targetEnvironmentId = (await this.resolveEnvironment(ctx, patch.targetEnvironmentId))?.id ?? null;
    }
    const source = next.sourceEnvironmentId ?? existing.sourceEnvironmentId;
    const target = next.targetEnvironmentId ?? existing.targetEnvironmentId;
    if (source && target && source === target && existing.kind !== 'COMPARISON') {
      throw badRequest('The source and target cannot be the same environment');
    }
    if (patch.analysisProjectId !== undefined) {
      next.analysisProjectId = await this.resolveAnalysisReference(
        ctx,
        existing.kind,
        patch.analysisProjectId,
      );
    }

    await this.db
      .update(projects)
      .set(next)
      .where(eq(projects.id, projectId))
      .catch((err: unknown) => {
        throw this.asFriendlyNameConflict(err, resultingName);
      });
    return this.get(ctx, projectId);
  }

  /** Archiving keeps the history: an analysis someone acted on must stay readable. */
  async archive(ctx: RequestContext, projectId: string): Promise<ProjectDto> {
    await this.row(ctx, projectId);
    await this.db
      .update(projects)
      .set({ status: 'ARCHIVED', updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'PROJECT_ARCHIVED',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { projectId },
    });
    return this.get(ctx, projectId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async resolveEnvironment(ctx: RequestContext, environmentId: string | null | undefined) {
    if (!environmentId) return null;
    // getAccessible is the gate: it refuses an environment this user may not use.
    return this.environmentsSvc.getAccessible(ctx, environmentId);
  }

  /** A migration project may point at an analysis project, and only at one of that kind. */
  private async resolveAnalysisReference(
    ctx: Pick<RequestContext, 'organizationId'>,
    kind: ProjectKind,
    analysisProjectId: string | null | undefined,
  ): Promise<string | null> {
    if (!analysisProjectId) return null;
    if (kind !== 'MIGRATION') {
      throw badRequest('Only a migration project can reference an analysis project');
    }
    const referenced = await this.row(ctx, analysisProjectId);
    if (referenced.kind !== 'ANALYSIS') throw badRequest('That project is not an analysis project');
    return referenced.id;
  }

  private async assertNoWork(projectId: string) {
    const [analyses] = await this.db
      .select({ n: count() })
      .from(analysisRuns)
      .where(eq(analysisRuns.projectId, projectId));
    const [plans] = await this.db
      .select({ n: count() })
      .from(migrationPlans)
      .where(eq(migrationPlans.projectId, projectId));
    const [comparisons] = await this.db
      .select({ n: count() })
      .from(dataComparisons)
      .where(eq(dataComparisons.projectId, projectId));
    if (Number(analyses?.n ?? 0) > 0 || Number(plans?.n ?? 0) > 0 || Number(comparisons?.n ?? 0) > 0) {
      throw badRequest(
        'This project already has work in it. Create a new project rather than repointing this one, so its results keep describing the system they came from.',
      );
    }
  }

  /** One round of lookups for the whole list, rather than per-row queries. */
  private async toDtos(rows: (typeof projects.$inferSelect)[]): Promise<ProjectDto[]> {
    if (rows.length === 0) return [];
    const envIds = [
      ...new Set(rows.flatMap((r) => [r.sourceEnvironmentId, r.targetEnvironmentId]).filter(Boolean)),
    ] as string[];
    const envRows = envIds.length
      ? await this.db.select().from(environments).where(inArray(environments.id, envIds))
      : [];
    const envs = new Map(envRows.map((e) => [e.id, envRef(e)]));

    const referencedIds = [...new Set(rows.map((r) => r.analysisProjectId).filter(Boolean))] as string[];
    const referenced = referencedIds.length
      ? await this.db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, referencedIds))
      : [];
    const referencedByIds = new Map(referenced.map((r) => [r.id, r]));

    const userIds = [...new Set(rows.map((r) => r.createdByUserId).filter(Boolean))] as string[];
    const userRows = userIds.length
      ? await this.db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const userNames = new Map(userRows.map((u) => [u.id, u.displayName]));

    const ids = rows.map((r) => r.id);
    const analysisCounts = await this.db
      .select({ projectId: analysisRuns.projectId, n: count() })
      .from(analysisRuns)
      .where(inArray(analysisRuns.projectId, ids))
      .groupBy(analysisRuns.projectId);
    const planCounts = await this.db
      .select({ projectId: migrationPlans.projectId, n: count() })
      .from(migrationPlans)
      .where(inArray(migrationPlans.projectId, ids))
      .groupBy(migrationPlans.projectId);
    const comparisonCounts = await this.db
      .select({ projectId: dataComparisons.projectId, n: count() })
      .from(dataComparisons)
      .where(inArray(dataComparisons.projectId, ids))
      .groupBy(dataComparisons.projectId);
    const counts = new Map<string, number>();
    for (const row of [...analysisCounts, ...planCounts, ...comparisonCounts]) {
      if (row.projectId) counts.set(row.projectId, Number(row.n));
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      description: r.description,
      status: r.status,
      sourceEnvironment: r.sourceEnvironmentId ? (envs.get(r.sourceEnvironmentId) ?? null) : null,
      targetEnvironment: r.targetEnvironmentId ? (envs.get(r.targetEnvironmentId) ?? null) : null,
      analysisProject: r.analysisProjectId ? (referencedByIds.get(r.analysisProjectId) ?? null) : null,
      itemCount: counts.get(r.id) ?? 0,
      createdBy: r.createdByUserId ? (userNames.get(r.createdByUserId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}
