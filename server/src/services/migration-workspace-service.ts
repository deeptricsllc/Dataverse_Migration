import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  MigrationProjectStatus,
  MigrationWorkspaceDto,
  MigrationRunStatus,
} from '../../../shared/domain';
import type { ReadinessFinding } from '../../../shared/readiness';
import type { AppDb } from '../db/client';
import { environments, migrationPlanEntities, migrationPlans, migrationRuns, projects } from '../db/schema';
import { notFound } from '../lib/errors';
import { decideWriteScope, type WriteScopeConfig } from '../write-scope';
import type { RequestContext } from './context';
import { envRef } from './env-ref';
import type { PlanningService } from './planning-service';
import type { ReadinessService } from './readiness-service';

/**
 * One migration project, answered in one object.
 *
 * The screen this feeds has thirty seconds to say what is being moved, from where, to where, how much of
 * it, whether it is safe to run, what is stopping it, what happened last time, and what to do next. The
 * previous product could answer those only by walking nine pages, four of them query-string steps of a
 * fifth — so the answer to "are we ready" was "I completed step 6", which is not the same question.
 *
 * Everything here is derived on read from evidence that already exists: the project's two ends, its plan,
 * the readiness service's verdict, the latest run. Nothing is stored, so nothing can drift out of step
 * with the thing it describes — and no second opinion about readiness is invented beside the first.
 */
export class MigrationWorkspaceService {
  constructor(
    private readonly config: WriteScopeConfig,
    private readonly db: AppDb,
    private readonly planning: PlanningService,
    private readonly readiness: ReadinessService,
    private readonly logger: Logger,
  ) {}

  async forProject(ctx: RequestContext, projectId: string): Promise<MigrationWorkspaceDto> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)));
    if (!project) throw notFound('Project');

    const [source, target] = await Promise.all([
      this.environment(project.sourceEnvironmentId),
      this.environment(project.targetEnvironmentId),
    ]);

    /**
     * The project's current configuration.
     *
     * The most recently updated plan, because a migration project is one body of work and the plan is
     * how that work is stored rather than a thing the user creates and names. A project that already
     * holds several keeps all of them; the others stay reachable through the runs attached to them.
     */
    const [planRow] = await this.db
      .select()
      .from(migrationPlans)
      .where(
        and(eq(migrationPlans.projectId, projectId), eq(migrationPlans.organizationId, ctx.organizationId)),
      )
      .orderBy(desc(migrationPlans.updatedAt))
      .limit(1);

    let plan: MigrationWorkspaceDto['plan'] = null;
    let readiness: MigrationWorkspaceDto['readiness'] = null;

    if (planRow) {
      const entities = await this.db
        .select({ sourceCount: migrationPlanEntities.sourceCount })
        .from(migrationPlanEntities)
        .where(eq(migrationPlanEntities.planId, planRow.id));
      /*
       * Counted where they have been counted, and null where they have not. A migration of four million
       * records that reports "0 records" because nothing has looked yet is worse than one that says
       * nothing, because zero is an answer and somebody will plan around it.
       */
      const counted = entities.filter((e) => typeof e.sourceCount === 'number');
      plan = {
        id: planRow.id,
        datasets: entities.length,
        records: counted.length ? counted.reduce((n, e) => n + (e.sourceCount ?? 0), 0) : null,
        blockers: planRow.issues.filter((i) => i.severity === 'BLOCKER').length,
        warnings: planRow.issues.filter((i) => i.severity === 'WARNING').length,
        updatedAt: planRow.updatedAt.toISOString(),
      };

      /*
       * The readiness service's verdict, not a second one. It already assembles plan validation, the
       * connector verification matrix, target state, resume capability, measured scale and rollback
       * reality into one answer, and the one thing worse than no verdict is two that disagree.
       *
       * Assessing revalidates against live metadata and can fail when a connection is unreachable. A
       * workspace that will not open because a database is asleep is a worse product than one that opens
       * and says it could not assess, so the failure is swallowed deliberately and reported as "not
       * assessed" by the absence of a verdict.
       */
      try {
        const assessment = await this.readiness.assess(ctx, planRow.id);
        plan.blockers = assessment.counts.blockers;
        plan.warnings = assessment.counts.warnings;
        readiness = {
          verdict: assessment.verdict,
          summary: assessment.summary,
          blockers: assessment.counts.blockers,
          warnings: assessment.counts.warnings,
          top: topFindings(assessment.findings),
        };
      } catch (err) {
        this.logger.warn(
          { projectId, planId: planRow.id, err },
          'Readiness could not be assessed for the workspace',
        );
      }
    }

    const runs = planRow
      ? await this.db
          .select()
          .from(migrationRuns)
          .where(eq(migrationRuns.planId, planRow.id))
          .orderBy(desc(migrationRuns.createdAt))
      : [];
    const latest = runs[0];
    const lastRun: MigrationWorkspaceDto['lastRun'] = latest
      ? {
          id: latest.id,
          status: latest.status as MigrationRunStatus,
          attempt: latest.attempt,
          startedAt: latest.startedAt?.toISOString() ?? null,
          finishedAt: latest.completedAt?.toISOString() ?? null,
          succeeded: latest.created + latest.updated + latest.unchanged,
          failed: latest.failed,
          skipped: latest.skipped,
          total: latest.total,
        }
      : null;

    /*
     * What the destination can do, from the same function that refuses the write rather than from a
     * second opinion about it. Two guards that disagree is how a migration gets planned against a target
     * that turns it down at the last step.
     */
    let targetCapability: MigrationWorkspaceDto['targetCapability'] = null;
    if (project.targetEnvironmentId) {
      const [row] = await this.db
        .select()
        .from(environments)
        .where(eq(environments.id, project.targetEnvironmentId));
      if (row) {
        const decision = decideWriteScope(this.config, {
          provider: row.provider,
          url: row.url,
          apiUrl: row.apiUrl,
          environmentType: row.environmentType,
          displayName: row.displayName,
        });
        targetCapability = {
          writable: decision.allowed,
          reason: decision.message,
          simulated: decision.reason === 'SIMULATED_ENVIRONMENT',
        };
      }
    }

    const status = projectStatus({ source, target, plan, readiness, lastRun });
    return {
      projectId: project.id,
      projectName: project.name,
      description: project.description,
      status,
      source,
      target,
      targetCapability,
      plan,
      readiness,
      lastRun,
      runCount: runs.length,
      nextAction: nextAction({ status, source, target, plan, readiness, lastRun }),
    };
  }

  private async environment(id: string | null) {
    if (!id) return null;
    const [row] = await this.db.select().from(environments).where(eq(environments.id, id));
    return row ? envRef(row) : null;
  }

  /** Every run of this project, newest first, across whichever plans it has held. */
  async runs(ctx: RequestContext, projectId: string) {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)));
    if (!project) throw notFound('Project');

    const planIds = (
      await this.db
        .select({ id: migrationPlans.id })
        .from(migrationPlans)
        .where(eq(migrationPlans.projectId, projectId))
    ).map((p) => p.id);
    if (!planIds.length) return [];

    const rows = await this.db
      .select()
      .from(migrationRuns)
      .where(inArray(migrationRuns.planId, planIds))
      .orderBy(desc(migrationRuns.createdAt));
    return rows.map((r) => ({
      id: r.id,
      status: r.status as MigrationRunStatus,
      attempt: r.attempt,
      total: r.total,
      succeeded: r.created + r.updated + r.unchanged,
      failed: r.failed,
      skipped: r.skipped,
      unresolved: r.unresolved,
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.completedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** The project's current configuration, for the sections that work on it. */
  async currentPlan(ctx: RequestContext, projectId: string) {
    const [planRow] = await this.db
      .select({ id: migrationPlans.id })
      .from(migrationPlans)
      .where(
        and(eq(migrationPlans.projectId, projectId), eq(migrationPlans.organizationId, ctx.organizationId)),
      )
      .orderBy(desc(migrationPlans.updatedAt))
      .limit(1);
    return planRow ? this.planning.get(ctx, planRow.id) : null;
  }
}

/** The few findings worth putting on an overview, worst first. */
function topFindings(findings: ReadinessFinding[]): ReadinessFinding[] {
  const rank = { BLOCKER: 0, WARNING: 1, INFORMATION: 2 } as const;
  return [...findings].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)).slice(0, 3);
}

interface StatusInput {
  source: MigrationWorkspaceDto['source'];
  target: MigrationWorkspaceDto['target'];
  plan: MigrationWorkspaceDto['plan'];
  readiness: MigrationWorkspaceDto['readiness'];
  lastRun: MigrationWorkspaceDto['lastRun'];
}

/**
 * What state this migration is in, described as work rather than as progress.
 *
 * Deliberately not a step number. "Step 6 of 9" is a fact about the product; a person planning a weekend
 * cutover is asking whether it is blocked, and by what.
 */
function projectStatus(input: StatusInput): MigrationProjectStatus {
  const { source, target, plan, readiness, lastRun } = input;
  if (lastRun && (lastRun.status === 'RUNNING' || lastRun.status === 'QUEUED')) return 'RUNNING';
  if (!source || !plan || plan.datasets === 0) return 'DRAFT';
  if (!target) return 'DRAFT';
  if (lastRun?.status === 'COMPLETED') return 'COMPLETED';
  if (
    lastRun &&
    ['COMPLETED_WITH_WARNINGS', 'COMPLETED_WITH_ERRORS', 'FAILED', 'NEEDS_RECONCILIATION'].includes(
      lastRun.status,
    )
  ) {
    return 'COMPLETED_WITH_ISSUES';
  }
  if (!readiness) return 'PREPARING';
  if (readiness.verdict === 'BLOCKED' || readiness.verdict === 'BLOCKED_PENDING_OVERRIDE') return 'BLOCKED';
  return 'READY';
}

/**
 * The one thing to do next.
 *
 * Named as an action a person can take, never as a stage they are at. This is the sentence that replaces
 * the progress stepper, and it is the only part of the overview that tells somebody what to do rather
 * than what is true.
 */
function nextAction(
  input: StatusInput & { status: MigrationProjectStatus },
): MigrationWorkspaceDto['nextAction'] {
  const { status, source, target, plan, readiness, lastRun } = input;
  if (status === 'RUNNING') {
    return { kind: 'WATCH_RUN', label: 'Watch this run', detail: 'A migration is running.' };
  }
  if (!source || !plan || plan.datasets === 0) {
    return {
      kind: 'ADD_SOURCE_DATA',
      label: 'Add source data',
      detail: 'Select the data to move.',
    };
  }
  if (!target) {
    return {
      kind: 'CHOOSE_DESTINATION',
      label: 'Choose destination',
      detail: 'Select the system to write to. Mapping needs a target.',
    };
  }
  if (lastRun && lastRun.failed > 0) {
    return {
      kind: 'REVIEW_FAILURES',
      label: `Review ${lastRun.failed.toLocaleString()} failed records`,
      detail: 'The last run finished with failures. Each failure lists its reason.',
    };
  }
  /*
   * Nothing failed, and the data is not what the source said. The failure list is empty, so pointing at
   * it would send somebody to a screen with nothing on it; the work is in the omitted references.
   */
  if (lastRun?.status === 'COMPLETED_WITH_WARNINGS') {
    return {
      kind: 'REVIEW_OMITTED_REFERENCES',
      label: 'Review what was not carried across',
      detail: 'Every record was written. Some references are missing in the target.',
    };
  }
  if (lastRun?.status === 'COMPLETED') {
    return {
      kind: 'VALIDATE',
      label: 'Validate this run',
      detail: 'Reconcile the target against the source for this run.',
    };
  }
  if (!readiness) {
    return {
      kind: 'PREPARE',
      label: 'Prepare migration',
      detail: 'Readiness is not assessed. Preparation checks the mapping, the target and the load order.',
    };
  }
  if (readiness.blockers > 0) {
    return {
      kind: 'RESOLVE_BLOCKERS',
      label: `Resolve ${readiness.blockers} blocker${readiness.blockers === 1 ? '' : 's'}`,
      detail: 'The server refuses to run a migration with blockers.',
    };
  }
  if (readiness.warnings > 0) {
    return {
      kind: 'REVIEW_WARNINGS',
      label: `Review ${readiness.warnings} warning${readiness.warnings === 1 ? '' : 's'}`,
      detail: 'No blockers found. Review the warnings before you start.',
    };
  }
  return {
    kind: 'EXECUTE',
    label: 'Start migration',
    detail: 'No blockers found. Run the preflight to see what the migration will write.',
  };
}
