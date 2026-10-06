import { and, asc, count, countDistinct, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  isUnresolved,
  needsHumanReconciliation,
  RECONCILE_FINDING_NOTES,
  UNRESOLVED_WRITE_STATES,
  type ReconcileFinding,
} from '../../../shared/write-state';
import { refreshRunCounters } from './run-counters';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import {
  DEFAULT_PLAN_OPTIONS,
  needsTypedConfirmation,
  TERMINAL_RUN_STATUSES,
  type ErrorFilter,
  type MigrationErrorDto,
  type MigrationRunDto,
  type MigrationRunListItemDto,
  type MigrationRunStatus,
  type RecordMapDto,
  type RecordOutcome,
  type RollbackPreviewDto,
  type RetrySafetyDto,
  type RunRecordDetailDto,
  type RunFailureSummaryDto,
  type RunTrigger,
} from '../../../shared/domain';
import { describeFailureCode, MATERIAL_WARNING_CODES } from '../../../shared/failure-categories';
import type { AppDb } from '../db/client';
import { decideWriteScope } from '../write-scope';
import {
  environments,
  fieldMappings,
  migrationErrors,
  migrationPlanEntities,
  migrationPlans,
  migrationRecordMaps,
  migrationRunEntities,
  migrationRuns,
  users,
  validationRuns,
} from '../db/schema';
import type { AppConfig } from '../config';
import type { JobQueue } from '../jobs/queue';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { requireAdminForProductionTarget } from './authorization';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import type { EnvironmentService } from './environment-service';
import type { PlanningService } from './planning-service';
import type { ReadinessService } from './readiness-service';
import type { TransformationService } from './transformation/transformation-service';
import type { RunPlanSnapshot } from './run-snapshot';
import { envRef } from './env-ref';

const ACTIVE = ['QUEUED', 'RUNNING', 'PAUSED'];

/**
 * Run states a further attempt applies to.
 *
 * `COMPLETED_WITH_WARNINGS` is here, and that is the point of the status existing. A run that dropped
 * three hundred references because the referenced table was not in the plan is fixed by adding the table
 * and running again; the second pass picks up every record it left incomplete. Refusing a retry would
 * leave a fresh migration over data already in the target as the only way forward.
 *
 * Read by the retry gate and by the assessment the UI shows, so the button and the server cannot disagree
 * about what is permitted.
 */
const RETRYABLE_STATUSES: readonly string[] = [
  'COMPLETED_WITH_WARNINGS',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
  'NEEDS_RECONCILIATION',
];

export class MigrationRunService {
  constructor(
    private readonly db: AppDb,
    private readonly config: AppConfig,
    private readonly planning: PlanningService,
    private readonly transformations: TransformationService,
    private readonly environmentsSvc: EnvironmentService,
    private readonly readiness: ReadinessService,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  /**
   * Refuses anything that would write to a real Dataverse environment while the deployment is
   * in read-only certification mode. The Dataverse client refuses too; this gives the user a
   * clear error before a run is even queued.
   */
  private async assertWritesAllowed(ctx: RequestContext, targetEnvironmentId: string, action: string) {
    // A member may migrate to a sandbox; production takes someone accountable for it. Checked before
    // the read-only switch so the answer is about who you are, not about how this deployment is
    // configured.
    const env = await this.environmentsSvc.getInOrganization(ctx.organizationId, targetEnvironmentId);
    requireAdminForProductionTarget(
      ctx,
      env,
      action === 'EXECUTE' ? 'Migrating' : `${action[0]}${action.slice(1).toLowerCase()}ing`,
    );
    if (!this.config.REAL_TENANT_READ_ONLY) return;
    const target = await this.environmentsSvc.getInOrganization(ctx.organizationId, targetEnvironmentId);
    /**
     * Every real target, not only Dataverse. A SQL target used to be accepted and queued, with the
     * refusal arriving later per statement inside the connector — so the data was safe but the run
     * history and the audit trail both said the attempt was allowed.
     *
     * The same decision the Dataverse client will make, made here first so the person is told before a
     * run exists rather than after it fails. The two must agree; that is why there is one function.
     */
    const scope = decideWriteScope(this.config, target);
    if (scope.allowed) {
      if (scope.reason === 'CERTIFICATION_SCOPE') {
        /**
         * A permitted write under a read-only deployment is the single most important thing in this
         * audit trail. It is recorded as its own action, with the environment, so "we were read-only"
         * can never be claimed for a window in which something was written.
         */
        await this.audit.record({
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          action: 'CERTIFICATION_WRITE_PERMITTED',
          outcome: 'SUCCESS',
          targetEnvironmentId,
          requestId: ctx.requestId,
          details: {
            action,
            environmentType: target.environmentType,
            displayName: target.displayName,
            reason: scope.reason,
          },
        });
      }
      return;
    }
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'READ_ONLY_WRITE_BLOCKED',
      outcome: 'FAILURE',
      targetEnvironmentId,
      requestId: ctx.requestId,
      details: { action, reason: scope.reason, environmentType: target.environmentType },
    });
    throw new AppError(403, 'REAL_TENANT_READ_ONLY', scope.message);
  }

  /**
   * The plan a schedule is about to be built against, validated the same way a run validates it.
   * Exposed so the schedule can capture the confirmed environment names at creation time.
   */
  async planForSchedule(ctx: RequestContext, planId: string) {
    return this.planning.get(ctx, planId);
  }

  async start(
    ctx: RequestContext,
    planId: string,
    input: {
      confirmSourceName?: string;
      confirmTargetName?: string;
      /** Explicit confirmation, for a target where typing the name is not required. */
      confirmed?: boolean;
      acknowledgeWarnings: boolean;
    },
    /**
     * Why this run is starting. A scheduled or triggered run takes the identical path — every gate
     * below applies — and only records who asked and, for an incremental run, where to read from.
     */
    meta: {
      trigger?: RunTrigger;
      scheduleId?: string | null;
      incremental?: { field: string; since: string | null } | null;
    } = {},
  ): Promise<MigrationRunDto> {
    // Always re-validate against current metadata before writing anything.
    const plan = await this.planning.revalidate(ctx, planId);
    if (plan.entities.length === 0) throw badRequest('The plan has no tables');
    if (plan.blockerCount > 0) {
      throw new AppError(
        409,
        'PLAN_HAS_BLOCKERS',
        `The plan has ${plan.blockerCount} unresolved blocker(s)`,
        plan.issues.filter((i) => i.severity === 'BLOCKER'),
      );
    }
    /**
     * The readiness gate.
     *
     * Plan validation above refuses what cannot work. This refuses what *can* work and should not
     * happen by accident: a table whose resume path cannot recover an interruption, a connector
     * capability the matrix says is absent. Each one is accepted individually, by name, with a reason
     * — there is no form of this that accepts a list, because a button that dismisses six findings is
     * a button nobody read.
     */
    const readiness = await this.readiness.assess(ctx, planId);
    if (readiness.verdict === 'BLOCKED' || readiness.verdict === 'BLOCKED_PENDING_OVERRIDE') {
      const accepted = new Set(readiness.overrides.map((o) => `${o.code}::${o.object ?? ''}`));
      const outstanding = readiness.findings.filter(
        (f) => f.severity === 'BLOCKER' && !accepted.has(`${f.code}::${f.object?.name ?? ''}`),
      );
      throw new AppError(409, 'READINESS_BLOCKED', readiness.summary, outstanding);
    }
    // The gate scales with the consequence: see `needsTypedConfirmation`. Production still means
    // typing the name; a sandbox means an explicit, deliberate click that named the target.
    const typedMatches =
      input.confirmSourceName?.trim() === plan.sourceEnvironment.displayName &&
      input.confirmTargetName?.trim() === plan.targetEnvironment.displayName;
    if (needsTypedConfirmation(plan.targetEnvironment)) {
      if (!typedMatches) {
        throw badRequest(
          `${plan.targetEnvironment.displayName} is a production environment, or one this deployment could not classify. Type its name exactly to confirm.`,
        );
      }
    } else if (!typedMatches && input.confirmed !== true) {
      throw badRequest('Confirm the target environment before executing');
    }
    if (plan.warningCount > 0 && !input.acknowledgeWarnings) {
      throw badRequest(`Acknowledge the ${plan.warningCount} warning(s) before executing`);
    }
    // A transformation that discards information has to be accepted deliberately, and the
    // acceptance has to name the exact rules: adding another lossy rule afterwards invalidates it.
    const lossy = await this.transformations.lossyTransformations(ctx, planId);
    if (lossy.length) {
      const accepted = new Set(plan.options.lossyAcknowledgement?.accepted ?? []);
      const unaccepted = lossy.filter((l) => !accepted.has(l.key));
      if (unaccepted.length) {
        throw badRequest(
          `Acknowledge the ${unaccepted.length} transformation(s) that discard data before executing: ${unaccepted
            .map((l) => `${l.field} (${l.kind})`)
            .join(', ')}`,
        );
      }
    }
    await this.assertWritesAllowed(ctx, plan.targetEnvironment.id, 'EXECUTE');
    const [active] = await this.db
      .select({ id: migrationRuns.id })
      .from(migrationRuns)
      .where(
        and(
          eq(migrationRuns.organizationId, ctx.organizationId),
          eq(migrationRuns.targetEnvironmentId, plan.targetEnvironment.id),
          inArray(migrationRuns.status, ACTIVE),
        ),
      );
    if (active)
      throw conflict('Another migration is already active against this target environment', {
        runId: active.id,
      });

    const snapshot = await this.buildSnapshot(planId);
    const [run] = await this.db
      .insert(migrationRuns)
      .values({
        organizationId: ctx.organizationId,
        planId,
        sourceEnvironmentId: plan.sourceEnvironment.id,
        targetEnvironmentId: plan.targetEnvironment.id,
        status: 'QUEUED',
        options: plan.options,
        planSnapshot: snapshot,
        /**
         * What was predicted, kept with the run that was predicted about. This is the first half of the
         * chain a buyer follows — predicted risk, actual outcome, validation evidence — and it only works
         * if the prediction is the one that was made before the work rather than one made afterwards.
         */
        readinessSnapshot: readiness,
        trigger: meta.trigger ?? 'MANUAL',
        scheduleId: meta.scheduleId ?? null,
        // Where an incremental run starts reading. Null means "everything", which is also what the
        // first run of an incremental schedule does.
        watermark: meta.incremental?.since ?? null,
        incremental: meta.incremental ?? null,
        executedByUserId: ctx.userId,
      })
      .returning();
    const planEntities = await this.db
      .select({
        logicalName: migrationPlanEntities.logicalName,
        sourceCount: migrationPlanEntities.sourceCount,
      })
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, planId));
    const sourceCounts = new Map(planEntities.map((e) => [e.logicalName, e.sourceCount ?? 0]));
    await this.db.insert(migrationRunEntities).values(
      snapshot.entities.map((e) => ({
        runId: run.id,
        logicalName: e.logicalName,
        displayName: e.displayName,
        orderIndex: e.orderIndex,
        total: sourceCounts.get(e.logicalName) ?? 0,
      })),
    );
    await this.queue.enqueue('MIGRATION', ctx.organizationId, run.id);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'MIGRATION_EXECUTION_REQUESTED',
      outcome: 'REQUESTED',
      sourceEnvironmentId: plan.sourceEnvironment.id,
      targetEnvironmentId: plan.targetEnvironment.id,
      runId: run.id,
      // Which migration this was. Environments alone were the old model's way of saying it, and they
      // cannot distinguish two migrations between the same pair of systems.
      projectId: plan.projectId,
      requestId: ctx.requestId,
      details: {
        planId,
        trigger: meta.trigger ?? 'MANUAL',
        scheduleId: meta.scheduleId ?? null,
        incremental: meta.incremental ?? null,
        tables: snapshot.entities.map((e) => e.logicalName),
        conflictStrategy: plan.options.conflictStrategy,
        bypassCustomBusinessLogic: plan.options.bypassCustomBusinessLogic,
        acknowledgedWarnings: plan.warningCount,
        // The run records which lossy transformations were accepted, and by whom.
        lossyTransformations: lossy.map((l) => l.key),
        lossyAcknowledgement: plan.options.lossyAcknowledgement,
      },
    });
    this.logger.info({ migrationRunId: run.id, planId, requestId: ctx.requestId }, 'Migration run queued');
    return this.get(ctx, run.id);
  }

  /**
   * The immutable plan description a run (or a preflight) executes against. Both use this, so a
   * dry run analyses exactly what the migration would do.
   */
  async buildSnapshot(planId: string): Promise<RunPlanSnapshot> {
    const entityRows = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, planId))
      .orderBy(asc(migrationPlanEntities.orderIndex));
    const mappingRows = entityRows.length
      ? await this.db
          .select()
          .from(fieldMappings)
          .where(
            inArray(
              fieldMappings.planEntityId,
              entityRows.map((e) => e.id),
            ),
          )
      : [];
    return {
      entities: entityRows.map((e) => ({
        logicalName: e.logicalName,
        displayName: e.displayName,
        // Older plans predate table mapping: their target is the source name.
        targetLogicalName: e.targetLogicalName ?? e.logicalName,
        orderIndex: e.orderIndex,
        matchStrategy: e.matchStrategy,
        alternateKey: e.alternateKey,
        businessKeyFields: e.businessKeyFields ?? [],
        mappings: mappingRows
          .filter(
            (m) =>
              m.planEntityId === e.id &&
              (m.status === 'AUTO_MAPPED' || m.status === 'MANUAL') &&
              m.targetField,
          )
          .map((m) => ({
            sourceField: m.sourceField,
            targetField: m.targetField!,
            isLookup: m.isLookup,
            deferredTargets: m.deferredTargets,
            transformations: m.transformations,
            transform: m.transform,
            choiceMap: m.choiceMap,
          })),
        audit: e.audit ?? {
          ownerField: null,
          createdOnField: null,
          createdByField: null,
          modifiedByField: null,
          overriddenCreatedOnField: null,
          touchField: null,
        },
      })),
    };
  }

  private async loadRun(organizationId: string, runId: string) {
    const [run] = await this.db
      .select()
      .from(migrationRuns)
      .where(and(eq(migrationRuns.id, runId), eq(migrationRuns.organizationId, organizationId)));
    if (!run) throw notFound('Migration run');
    return run;
  }

  async control(
    ctx: RequestContext,
    runId: string,
    action: 'cancel' | 'pause' | 'resume' | 'retry',
  ): Promise<MigrationRunDto> {
    const run = await this.loadRun(ctx.organizationId, runId);
    const [ofPlan] = await this.db
      .select({ projectId: migrationPlans.projectId })
      .from(migrationPlans)
      .where(eq(migrationPlans.id, run.planId));
    const auditBase = {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      sourceEnvironmentId: run.sourceEnvironmentId,
      targetEnvironmentId: run.targetEnvironmentId,
      runId,
      projectId: ofPlan?.projectId ?? null,
      requestId: ctx.requestId,
    };
    if (action === 'cancel') {
      if (run.status === 'QUEUED' || run.status === 'PAUSED') {
        await this.db
          .update(migrationRuns)
          .set({ status: 'CANCELLED', cancelRequested: true, completedAt: new Date() })
          .where(eq(migrationRuns.id, runId));
      } else if (run.status === 'RUNNING') {
        await this.db.update(migrationRuns).set({ cancelRequested: true }).where(eq(migrationRuns.id, runId));
      } else {
        throw conflict(`Cannot cancel a run in status ${run.status}`);
      }
      await this.audit.record({ ...auditBase, action: 'MIGRATION_CANCEL_REQUESTED', outcome: 'REQUESTED' });
    } else if (action === 'pause') {
      if (run.status !== 'RUNNING' && run.status !== 'QUEUED')
        throw conflict(`Cannot pause a run in status ${run.status}`);
      await this.db.update(migrationRuns).set({ pauseRequested: true }).where(eq(migrationRuns.id, runId));
      await this.audit.record({ ...auditBase, action: 'MIGRATION_PAUSE_REQUESTED', outcome: 'REQUESTED' });
    } else if (action === 'resume') {
      if (run.status !== 'PAUSED') throw conflict(`Cannot resume a run in status ${run.status}`);
      await this.assertWritesAllowed(ctx, run.targetEnvironmentId, 'RESUME');
      await this.requeue(ctx, runId, false);
      await this.audit.record({ ...auditBase, action: 'MIGRATION_RESUMED', outcome: 'REQUESTED' });
    } else {
      await this.assertWritesAllowed(ctx, run.targetEnvironmentId, 'RETRY');
      if (!RETRYABLE_STATUSES.includes(run.status)) {
        throw conflict(
          `Retry is available for failed, cancelled or incomplete runs (current: ${run.status})`,
        );
      }
      /**
       * A retry is refused exactly when another attempt cannot settle what is outstanding.
       *
       * A record in doubt with something that could identify it is resolved by the next attempt asking
       * the target. A record with nothing to identify it cannot be resolved by any number of attempts,
       * and retrying it is the one action that could create a second copy — so the retry is refused and
       * the records are named instead.
       */
      const outstanding = await this.db
        .select({
          logicalName: migrationRecordMaps.logicalName,
          sourceId: migrationRecordMaps.sourceId,
          writeState: migrationRecordMaps.writeState,
          evidence: migrationRecordMaps.reconcileEvidence,
        })
        .from(migrationRecordMaps)
        .where(
          and(
            eq(migrationRecordMaps.runId, runId),
            inArray(migrationRecordMaps.writeState, [...UNRESOLVED_WRITE_STATES]),
          ),
        );
      const needHuman = outstanding.filter((r) => needsHumanReconciliation(r.writeState, r.evidence));
      if (needHuman.length > 0) {
        throw conflict(
          `${needHuman.length} record(s) must be reconciled by hand before this run can continue: a write may have been applied and nothing in the target can identify the record. Retrying could create a second copy. See /api/runs/${runId}/reconciliation for the list.`,
          needHuman.slice(0, 50).map((r) => ({ table: r.logicalName, sourceId: r.sourceId })),
        );
      }
      const [active] = await this.db
        .select({ id: migrationRuns.id })
        .from(migrationRuns)
        .where(
          and(
            eq(migrationRuns.targetEnvironmentId, run.targetEnvironmentId),
            inArray(migrationRuns.status, ACTIVE),
          ),
        );
      if (active) throw conflict('Another migration is already active against this target environment');
      /*
       * And refused when there is nothing for an attempt to do.
       *
       * Last, so that the specific refusals above keep their own wording: a run blocked on records nobody
       * can account for needs to be told that, with the records named, rather than told there is nothing to
       * do. This is the remaining case — a run whose records are all written, carrying references no further
       * attempt can set. Without it a retry would re-read the whole source, match every record, change
       * nothing, and report a second attempt that achieved nothing.
       *
       * The page reads `retrySafety` to decide whether to offer the control. A rule enforced in one of the
       * two places is not enforced, so both read the same assessment.
       */
      const assessment = await this.retrySafety(ctx, runId);
      if (assessment.safe === 0 && assessment.state === 'NOTHING_TO_RETRY') {
        throw conflict(assessment.reason, { excluded: assessment.excluded } as never);
      }
      await this.requeue(ctx, runId, true);
      await this.audit.record({
        ...auditBase,
        action: 'MIGRATION_RETRY_REQUESTED',
        outcome: 'REQUESTED',
        details: { attempt: run.attempt + 1 },
      });
    }
    return this.get(ctx, runId);
  }

  /**
   * Records what a person found when they looked in the target.
   *
   * The way out of `NEEDS_RECONCILIATION`. The platform stopped because a write may have been applied
   * and nothing it can query would settle it; the only remaining evidence is somebody opening the target
   * and looking. This is where what they saw is written down — per record, with the identifier when they
   * found one — and it is audited, because it is a human assertion about data rather than a measurement.
   *
   * Deliberately not a bulk "assume they are all fine" button. Each record is named. A person who
   * resolves four hundred records has looked at four hundred records, or has made a decision they are
   * accountable for either way.
   */
  async reconcile(
    ctx: RequestContext,
    runId: string,
    resolutions: {
      logicalName: string;
      sourceId: string;
      /**
       * What the person found when they looked in the target.
       *
       * Four answers, because a person who opened the target and could not tell has to be able to say so.
       * `PRESENT` and `ABSENT` were the only two, and a binary forces uncertain evidence into a claim —
       * which is the same defect as a run reporting a clean result because nothing failed.
       *
       * `UNCLEAR` and `MULTIPLE` leave the record unresolved on purpose. The note is kept, so the next
       * person starts from what the last one saw rather than from nothing.
       */
      found: ReconcileFinding;
      /** The target's identifier, required when the record is present. */
      targetId?: string | null;
      /** How they determined it, in their words, for the evidence package. */
      note: string;
    }[],
  ): Promise<MigrationRunDto> {
    const run = await this.loadRun(ctx.organizationId, runId);
    if (run.status !== 'NEEDS_RECONCILIATION') {
      throw conflict(`This run is ${run.status} and has nothing awaiting reconciliation`);
    }
    let resolved = 0;
    for (const r of resolutions) {
      if (r.found === 'PRESENT' && !r.targetId) {
        throw badRequest(
          `${r.logicalName} ${r.sourceId}: a record reported as present needs the identifier it has in the target, so the identity map can point at it.`,
        );
      }
      const [row] = await this.db
        .select({ id: migrationRecordMaps.id, writeState: migrationRecordMaps.writeState })
        .from(migrationRecordMaps)
        .where(
          and(
            eq(migrationRecordMaps.runId, runId),
            eq(migrationRecordMaps.logicalName, r.logicalName),
            eq(migrationRecordMaps.sourceId, r.sourceId.toLowerCase()),
          ),
        );
      if (!row) throw badRequest(`${r.logicalName} ${r.sourceId} is not a record of this run`);
      if (!isUnresolved(row.writeState)) continue; // already settled; saying so twice changes nothing

      /*
       * Only an answer that settles the record changes its state.
       *
       * PRESENT means the write did happen, so the record was created by this run and is now known.
       * ABSENT means it did not, so the record is a plain failure the next attempt will try again.
       *
       * UNCLEAR and MULTIPLE settle nothing, and must not pretend to. The record keeps its write state,
       * the run stays in reconciliation, and the retry stays refused — which is right, because the thing
       * that made a retry dangerous is still true. What is recorded is that somebody looked, and what
       * they saw.
       */
      const settles = r.found === 'PRESENT' || r.found === 'ABSENT';
      await this.db
        .update(migrationRecordMaps)
        .set({
          ...(settles
            ? {
                outcome: r.found === 'PRESENT' ? ('CREATED' as const) : ('FAILED' as const),
                writeState: r.found === 'PRESENT' ? ('CONFIRMED' as const) : null,
                targetId: r.found === 'PRESENT' ? (r.targetId ?? null) : null,
              }
            : {}),
          reconcileNote: `${RECONCILE_FINDING_NOTES[r.found]} by ${ctx.displayName}. ${r.note}`,
          updatedAt: new Date(),
        })
        .where(eq(migrationRecordMaps.id, row.id));
      if (settles) resolved++;
    }

    // The counters are derived, so they are rebuilt rather than adjusted.
    await refreshRunCounters(this.db, runId);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'MIGRATION_RECONCILED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: run.sourceEnvironmentId,
      targetEnvironmentId: run.targetEnvironmentId,
      runId,
      requestId: ctx.requestId,
      details: {
        resolved,
        present: resolutions.filter((r) => r.found === 'PRESENT').length,
        absent: resolutions.filter((r) => r.found === 'ABSENT').length,
        // Recorded because an audit trail that counted only the settled ones would show a reconciliation
        // that achieved nothing as a reconciliation that never happened.
        unclear: resolutions.filter((r) => r.found === 'UNCLEAR').length,
        multiple: resolutions.filter((r) => r.found === 'MULTIPLE').length,
      },
    });

    // Once nothing is outstanding the run is retryable again, and says so.
    const [remaining] = await this.db
      .select({ n: count() })
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.runId, runId),
          inArray(migrationRecordMaps.writeState, [...UNRESOLVED_WRITE_STATES]),
        ),
      );
    if (Number(remaining?.n ?? 0) === 0) {
      await this.db
        .update(migrationRuns)
        .set({ status: 'COMPLETED_WITH_ERRORS', updatedAt: new Date() })
        .where(eq(migrationRuns.id, runId));
    }
    return this.get(ctx, runId);
  }

  /** The records a person has to look at, with everything known about each one. */
  async awaitingReconciliation(ctx: RequestContext, runId: string) {
    await this.loadRun(ctx.organizationId, runId);
    const rows = await this.db
      .select()
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.runId, runId),
          inArray(migrationRecordMaps.writeState, [...UNRESOLVED_WRITE_STATES]),
        ),
      )
      .orderBy(asc(migrationRecordMaps.logicalName), asc(migrationRecordMaps.sourceId));
    return {
      total: rows.length,
      items: rows.map((r) => ({
        logicalName: r.logicalName,
        sourceId: r.sourceId,
        targetId: r.targetId,
        intendedOperation: r.intendedOperation,
        writeState: r.writeState,
        evidence: r.reconcileEvidence,
        note: r.reconcileNote,
        attempts: r.attempts,
      })),
    };
  }

  private async requeue(ctx: RequestContext, runId: string, newAttempt: boolean) {
    await this.db
      .update(migrationRuns)
      .set({
        status: 'QUEUED',
        cancelRequested: false,
        pauseRequested: false,
        completedAt: null,
        errorMessage: null,
        // Retries run on the authority of the user who requested them.
        executedByUserId: ctx.userId,
        ...(newAttempt ? { attempt: sql`${migrationRuns.attempt} + 1` } : {}),
        updatedAt: new Date(),
      })
      .where(eq(migrationRuns.id, runId));
    await this.queue.enqueue('MIGRATION', ctx.organizationId, runId);
  }

  async get(ctx: Pick<RequestContext, 'organizationId'>, runId: string): Promise<MigrationRunDto> {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const [row] = await this.db
      .select({
        run: migrationRuns,
        src,
        tgt,
        planName: migrationPlans.name,
        projectId: migrationPlans.projectId,
        user: users.displayName,
      })
      .from(migrationRuns)
      .innerJoin(src, eq(src.id, migrationRuns.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, migrationRuns.targetEnvironmentId))
      .innerJoin(migrationPlans, eq(migrationPlans.id, migrationRuns.planId))
      .leftJoin(users, eq(users.id, migrationRuns.executedByUserId))
      .where(and(eq(migrationRuns.id, runId), eq(migrationRuns.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Migration run');
    const entities = await this.db
      .select()
      .from(migrationRunEntities)
      .where(eq(migrationRunEntities.runId, runId))
      .orderBy(asc(migrationRunEntities.orderIndex));
    const severityCounts = await this.db
      .select({ severity: migrationErrors.severity, n: count() })
      .from(migrationErrors)
      .where(and(eq(migrationErrors.runId, runId), eq(migrationErrors.resolved, false)))
      .groupBy(migrationErrors.severity);
    /**
     * Records per dataset that lost something, read from the error rows the engine wrote at the time.
     *
     * Read here, and not taken from the dataset's own `deferredIncomplete` counter, because that counter
     * does not exist for runs that finished before it was added. Those runs recorded the same warnings —
     * the rows are there — so this is the number that is true for every run, old or new, and it is also
     * what decides whether a zero in the counter means `none` or `not recorded`.
     */
    const [problemRecords] = await this.db
      .select({ n: countDistinct(migrationErrors.sourceRecordId) })
      .from(migrationErrors)
      .where(and(eq(migrationErrors.runId, runId), eq(migrationErrors.resolved, false)));
    const omittedPerDataset = await this.db
      .select({ logicalName: migrationErrors.logicalName, n: countDistinct(migrationErrors.sourceRecordId) })
      .from(migrationErrors)
      .where(
        and(
          eq(migrationErrors.runId, runId),
          eq(migrationErrors.severity, 'WARNING'),
          eq(migrationErrors.resolved, false),
          inArray(migrationErrors.errorCode, [...MATERIAL_WARNING_CODES]),
        ),
      )
      .groupBy(migrationErrors.logicalName);
    const [latestValidation] = await this.db
      .select({ id: validationRuns.id })
      .from(validationRuns)
      .where(eq(validationRuns.migrationRunId, runId))
      .orderBy(desc(validationRuns.createdAt))
      .limit(1);
    const r = row.run;
    return {
      id: r.id,
      planId: r.planId,
      projectId: row.projectId,
      planName: row.planName,
      status: r.status as MigrationRunDto['status'],
      phase: r.phase,
      sourceEnvironment: envRef(row.src),
      targetEnvironment: envRef(row.tgt),
      transformationMetrics: row.run.transformationMetrics ?? null,
      options: { ...DEFAULT_PLAN_OPTIONS, ...r.options },
      currentEntity: r.currentEntity,
      total: r.total,
      processed: r.processed,
      created: r.created,
      updated: r.updated,
      unchanged: r.unchanged,
      skipped: r.skipped,
      failed: r.failed,
      unresolved: r.unresolved,
      entities: entities.map((e) => ({
        id: e.id,
        logicalName: e.logicalName,
        displayName: e.displayName,
        orderIndex: e.orderIndex,
        status: e.status as MigrationRunDto['entities'][number]['status'],
        total: e.total,
        processed: e.processed,
        created: e.created,
        updated: e.updated,
        unchanged: e.unchanged,
        skipped: e.skipped,
        failed: e.failed,
        unresolved: e.unresolved,
        deferredPending: e.deferredPending,
        deferredResolved: e.deferredResolved,
        deferredFailed: e.deferredFailed,
        deferredIncomplete: e.deferredIncomplete,
        startedAt: e.startedAt?.toISOString() ?? null,
        completedAt: e.completedAt?.toISOString() ?? null,
      })),
      errorCount: Number(severityCounts.find((s) => s.severity === 'ERROR')?.n ?? 0),
      warningCount: Number(severityCounts.find((s) => s.severity === 'WARNING')?.n ?? 0),
      recordsWithProblems: Number(problemRecords?.n ?? 0),
      // Summed from the same per-dataset evidence the datasets report, so the two can never disagree.
      omittedReferences: omittedPerDataset.reduce((n, o) => n + Number(o.n), 0),
      errorMessage: r.errorMessage,
      cancelRequested: r.cancelRequested,
      pauseRequested: r.pauseRequested,
      attempt: r.attempt,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdBy: row.user ?? null,
      latestValidationRunId: latestValidation?.id ?? null,
    };
  }

  async list(ctx: Pick<RequestContext, 'organizationId'>, limit = 50): Promise<MigrationRunListItemDto[]> {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const rows = await this.db
      .select({
        run: migrationRuns,
        src,
        tgt,
        planName: migrationPlans.name,
        projectId: migrationPlans.projectId,
        user: users.displayName,
      })
      .from(migrationRuns)
      .innerJoin(src, eq(src.id, migrationRuns.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, migrationRuns.targetEnvironmentId))
      .innerJoin(migrationPlans, eq(migrationPlans.id, migrationRuns.planId))
      .leftJoin(users, eq(users.id, migrationRuns.executedByUserId))
      .where(eq(migrationRuns.organizationId, ctx.organizationId))
      .orderBy(desc(migrationRuns.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map((r) => ({
      id: r.run.id,
      planName: r.planName,
      status: r.run.status as MigrationRunListItemDto['status'],
      sourceEnvironment: envRef(r.src),
      targetEnvironment: envRef(r.tgt),
      total: r.run.total,
      processed: r.run.processed,
      failed: r.run.failed,
      createdAt: r.run.createdAt.toISOString(),
      completedAt: r.run.completedAt?.toISOString() ?? null,
      createdBy: r.user ?? null,
    }));
  }

  /**
   * Where this run's failures are concentrated, and what caused them.
   *
   * A flat list of eighteen thousand errors answers "which records failed" and nothing else. The first
   * question after a run is "what went wrong", and the answer is a small number of causes with very
   * uneven counts — six thousand of one thing and four of another. That shape is in the data already:
   * every error carries the code the engine recorded for it.
   *
   * Grouped by dataset and by code, counted, and nothing else. No category is invented, no message is
   * parsed, and a code this product does not define is reported as itself.
   */
  async failureSummary(ctx: RequestContext, runId: string): Promise<RunFailureSummaryDto> {
    const run = await this.loadRun(ctx.organizationId, runId);
    const entities = await this.db
      .select()
      .from(migrationRunEntities)
      .where(eq(migrationRunEntities.runId, runId))
      .orderBy(asc(migrationRunEntities.orderIndex));

    const grouped = await this.db
      .select({
        logicalName: migrationErrors.logicalName,
        errorCode: migrationErrors.errorCode,
        field: migrationErrors.field,
        retryable: migrationErrors.retryable,
        severity: migrationErrors.severity,
        n: sql<number>`count(*)::int`,
        message: sql<string>`min(${migrationErrors.message})`,
        example: sql<string>`min(${migrationErrors.sourceRecordId})`,
      })
      .from(migrationErrors)
      .where(eq(migrationErrors.runId, runId))
      .groupBy(
        migrationErrors.logicalName,
        migrationErrors.errorCode,
        migrationErrors.field,
        migrationErrors.retryable,
        migrationErrors.severity,
      );

    /*
     * Warnings are kept, and kept apart.
     *
     * A run that writes every record and drops three hundred lookups on the way reports COMPLETED with
     * zero failures, because no record failed — which is true, and on its own it is the wrong impression.
     * The engine records those as warnings against the record they belong to. They are not failures and
     * are never counted as such; they are the difference between "it worked" and "it worked, and here is
     * what it could not carry across".
     */
    const describe = (g: (typeof grouped)[number]) => {
      const described = describeFailureCode(g.errorCode);
      return {
        code: g.errorCode,
        label: described.label,
        meaning: described.meaning,
        action: described.action,
        known: described.known,
        field: g.field,
        retryable: g.retryable,
        records: Number(g.n),
        exampleRecordId: g.example ?? null,
        exampleMessage: g.message ?? null,
      };
    };

    const datasets = entities.map((entity) => {
      const mine = grouped.filter((g) => g.logicalName === entity.logicalName && g.severity === 'ERROR');
      const theirWarnings = grouped
        .filter((g) => g.logicalName === entity.logicalName && g.severity === 'WARNING')
        .map(describe)
        .sort((a, b) => b.records - a.records);
      const categories = mine
        .map((g) => {
          const described = describeFailureCode(g.errorCode);
          return {
            code: g.errorCode,
            label: described.label,
            meaning: described.meaning,
            action: described.action,
            known: described.known,
            field: g.field,
            retryable: g.retryable,
            records: Number(g.n),
            exampleRecordId: g.example ?? null,
            exampleMessage: g.message ?? null,
          };
        })
        .sort((a, b) => b.records - a.records);
      return {
        logicalName: entity.logicalName,
        displayName: entity.displayName,
        attempted: entity.total,
        succeeded: entity.created + entity.updated + entity.unchanged,
        failed: entity.failed,
        skipped: entity.skipped,
        unresolved: entity.unresolved,
        categories,
        warnings: theirWarnings,
      };
    });

    return {
      runId,
      status: run.status as RunFailureSummaryDto['status'],
      attempt: run.attempt,
      failed: run.failed,
      unresolved: run.unresolved,
      datasets,
      /*
       * Retryable is the engine's own classification, recorded per error when it happened. It is not a
       * judgement made now: whether another attempt could succeed depends on what the target said at the
       * time, and nothing here re-decides it.
       */
      retryable: grouped
        .filter((g) => g.severity === 'ERROR' && g.retryable)
        .reduce((n, g) => n + Number(g.n), 0),
      permanent: grouped
        .filter((g) => g.severity === 'ERROR' && !g.retryable)
        .reduce((n, g) => n + Number(g.n), 0),
      warnings: grouped.filter((g) => g.severity === 'WARNING').reduce((n, g) => n + Number(g.n), 0),
    };
  }

  /**
   * The filter for a failure list, built once.
   *
   * Shared by the paged list and by the export, because an export that honoured a different set of filters
   * from the list it was taken from is the most quietly damaging thing this screen could do: the file looks
   * right and describes a different problem from the one the person was working on.
   */
  private errorConditions(runId: string, filter: ErrorFilter) {
    const conditions = [eq(migrationErrors.runId, runId)];
    if (filter.entity) conditions.push(eq(migrationErrors.logicalName, filter.entity));
    if (filter.kind === 'retryable') conditions.push(eq(migrationErrors.retryable, true));
    if (filter.kind === 'permanent') conditions.push(eq(migrationErrors.retryable, false));
    if (filter.severity) conditions.push(eq(migrationErrors.severity, filter.severity));
    if (filter.code) conditions.push(eq(migrationErrors.errorCode, filter.code));
    if (filter.attempt !== undefined) conditions.push(eq(migrationErrors.runAttempt, filter.attempt));
    if (filter.sourceRecordId) conditions.push(eq(migrationErrors.sourceRecordId, filter.sourceRecordId));
    if (!filter.includeResolved) conditions.push(eq(migrationErrors.resolved, false));
    return conditions;
  }

  /**
   * The same failures, as pages, for an export that must not be capped.
   *
   * Walked by keyset on the primary key rather than by offset: `OFFSET 2000000` makes the database count two
   * million rows it then discards, and the last page of a large export is the slowest one exactly when it
   * matters most. A capped export answers a different question from the one somebody asked, and a TRUNCATED
   * line at the bottom does not make it the right answer.
   */
  async *errorPages(
    ctx: Pick<RequestContext, 'organizationId'>,
    runId: string,
    filter: ErrorFilter,
    pageSize = 1_000,
  ): AsyncGenerator<MigrationErrorDto[]> {
    await this.loadRun(ctx.organizationId, runId);
    const size = Math.max(1, Math.min(pageSize, 5_000));
    const scope = and(...this.errorConditions(runId, filter))!;
    const targets = await this.targetTables(runId);
    let cursor: string | null = null;
    for (;;) {
      const rows = await this.db
        .select()
        .from(migrationErrors)
        .where(cursor === null ? scope : and(scope, gt(migrationErrors.id, cursor)))
        .orderBy(asc(migrationErrors.id))
        .limit(size);
      if (rows.length === 0) return;
      yield rows.map((e) => this.toErrorDto(e, targets));
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < size) return;
    }
  }

  async errors(
    ctx: RequestContext,
    runId: string,
    filter: {
      entity?: string;
      kind?: 'all' | 'retryable' | 'permanent';
      severity?: 'ERROR' | 'WARNING';
      /** One recorded cause, as the summary's categories name it. */
      code?: string;
      /** One attempt of this run. Rows with no recorded attempt are excluded, not guessed at. */
      attempt?: number;
      /** A source record identifier. Matched exactly: a prefix search over millions of rows is a scan. */
      sourceRecordId?: string;
      includeResolved?: boolean;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: MigrationErrorDto[]; total: number }> {
    await this.loadRun(ctx.organizationId, runId);
    const conditions = this.errorConditions(runId, filter);
    const [total] = await this.db
      .select({ n: count() })
      .from(migrationErrors)
      .where(and(...conditions));
    const rows = await this.db
      .select()
      .from(migrationErrors)
      .where(and(...conditions))
      /*
       * Stable, which `createdAt` alone is not. Rows written in the same batch share a timestamp to the
       * millisecond, so an ordering on it alone lets the database return them in any order it likes — and
       * a paged list whose order changes between pages shows some rows twice and others not at all.
       */
      .orderBy(desc(migrationErrors.createdAt), asc(migrationErrors.id))
      .limit(filter.limit)
      .offset(filter.offset);
    const targets = await this.targetTables(runId);
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((e) => this.toErrorDto(e, targets)),
    };
  }

  /**
   * Source table -> target table for this run's plan.
   *
   * Read once per page rather than per row. Null where the plan maps a table onto one of the same name,
   * which is every Dataverse-to-Dataverse pair, and the UI then shows the one name it has.
   */
  private async targetTables(runId: string): Promise<Map<string, string | null>> {
    const rows = await this.db
      .select({
        logicalName: migrationPlanEntities.logicalName,
        targetLogicalName: migrationPlanEntities.targetLogicalName,
      })
      .from(migrationPlanEntities)
      .innerJoin(migrationRuns, eq(migrationRuns.planId, migrationPlanEntities.planId))
      .where(eq(migrationRuns.id, runId));
    return new Map(
      rows.map((r) => [
        r.logicalName,
        r.targetLogicalName && r.targetLogicalName !== r.logicalName ? r.targetLogicalName : null,
      ]),
    );
  }

  private toErrorDto(
    e: typeof migrationErrors.$inferSelect,
    targets: Map<string, string | null>,
  ): MigrationErrorDto {
    return {
      id: e.id,
      entity: e.logicalName,
      sourceRecordId: e.sourceRecordId,
      operation: e.operation as MigrationErrorDto['operation'],
      severity: e.severity,
      errorCode: e.errorCode,
      message: e.message,
      retryable: e.retryable,
      field: e.field,
      attempts: e.attempts,
      resolved: e.resolved,
      createdAt: e.createdAt.toISOString(),
      httpStatus: e.httpStatus,
      runAttempt: e.runAttempt,
      targetTable: targets.get(e.logicalName) ?? null,
      category: describeFailureCode(e.errorCode),
    };
  }

  /**
   * Whether another attempt of this run is safe, and exactly what it would act on.
   *
   * Eight questions decide this, and none of them are shown. A person looking at a failed run is asking
   * one thing — can I run this again without making it worse — and a screen that answered by listing the
   * considerations would be making them do the reasoning.
   *
   * What is asked, in the order that decides the answer:
   *
   *   1. Is the run in a state a further attempt applies to at all?
   *   2. Is another run holding this target?
   *   3. Is any record in doubt with nothing in the target that could identify it?
   *   4. Is any record in doubt with something that could — a preserved id, an alternate key?
   *   5. Which failures did the engine record as able to succeed on another attempt?
   *   6. Which did it record as unable to?
   *   7. Which records are written but carrying less than their source record did?
   *   8. Is there anything left for an attempt to do?
   *
   * Three and four are the ones that matter. A record that may be in the target with nothing to identify
   * it is re-created by the next attempt, which is the one failure the whole write-state protocol exists
   * to prevent — so the answer is reconciliation, not a retry, and the server refuses it either way.
   */
  async retrySafety(ctx: Pick<RequestContext, 'organizationId'>, runId: string): Promise<RetrySafetyDto> {
    const run = await this.loadRun(ctx.organizationId, runId);

    // 3 and 4: records in doubt, split by whether anything could settle them without a person.
    const inDoubt = await this.db
      .select({
        writeState: migrationRecordMaps.writeState,
        evidence: migrationRecordMaps.reconcileEvidence,
      })
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.runId, runId),
          inArray(migrationRecordMaps.writeState, [...UNRESOLVED_WRITE_STATES]),
        ),
      );
    const needsPerson = inDoubt.filter((r) => needsHumanReconciliation(r.writeState, r.evidence)).length;

    /*
     * 5 and 6: failures, counted per record rather than per row. One record can carry several errors, and
     * a retry acts on records — a count of rows would promise to retry more records than exist.
     *
     * These two split the exclusions. What an attempt would *act on* is counted from the run's own counters
     * below, not from here: an error row can be marked resolved while its record is still outstanding, and a
     * prediction built on the error rows refused resumes the engine would have completed.
     */
    const failureGroups = await this.db
      .select({
        retryable: migrationErrors.retryable,
        records: countDistinct(migrationErrors.sourceRecordId),
      })
      .from(migrationErrors)
      .where(
        and(
          eq(migrationErrors.runId, runId),
          eq(migrationErrors.severity, 'ERROR'),
          eq(migrationErrors.resolved, false),
        ),
      )
      .groupBy(migrationErrors.retryable);
    const countOf = (retryable: boolean) =>
      Number(failureGroups.find((g) => g.retryable === retryable)?.records ?? 0);
    // Recorded for the wording of the exclusions. `waiting` above is what decides whether an attempt runs.
    void countOf(true);
    const permanentFailures = countOf(false);

    /*
     * 7: records written with a reference omitted, split by whether a further attempt would do anything
     * about it.
     *
     * The engine's own classification decides, not the fact that a reference is missing. A reference the
     * plan deferred is set by the next attempt's second pass. A reference dropped when the record was first
     * prepared is not: the record is written, so the next attempt matches it and leaves it alone, and the
     * reference stays empty however many attempts are made. Counting those as safe would promise work that
     * will not happen.
     */
    const omittedGroups = await this.db
      .select({
        retryable: migrationErrors.retryable,
        records: countDistinct(migrationErrors.sourceRecordId),
      })
      .from(migrationErrors)
      .where(
        and(
          eq(migrationErrors.runId, runId),
          eq(migrationErrors.severity, 'WARNING'),
          eq(migrationErrors.resolved, false),
          inArray(migrationErrors.errorCode, [...MATERIAL_WARNING_CODES]),
        ),
      )
      .groupBy(migrationErrors.retryable);
    const omittedOf = (retryable: boolean) =>
      Number(omittedGroups.find((g) => g.retryable === retryable)?.records ?? 0);
    const omittedRetryable = omittedOf(true);
    const omittedPermanent = omittedOf(false);

    /*
     * 8: records the run never reached.
     *
     * A cancelled run's remaining work is not a failure and not in doubt — those records simply have no row
     * yet. They are the whole point of resuming a cancelled run, so leaving them out would make the
     * assessment refuse the one thing somebody cancels a run in order to do later.
     *
     * A run cancelled before it read anything is the case that cannot be counted: its totals are zero
     * because nothing was counted, not because there is nothing to do. So the work waiting is unknown
     * rather than none, which is a different answer and leads to a different one here.
     */
    const neverStarted = run.processed === 0 && run.total === 0;
    const unreached = Math.max(0, run.total - run.processed);

    /*
     * References the next attempt's second pass would set, from the per-dataset counters.
     *
     * A deferred reference that is still pending, incomplete or failed is work the second pass of a further
     * attempt does. This is read from the counters rather than from the error rows for the same reason as
     * the failures above.
     */
    const [deferred] = await this.db
      .select({
        outstanding: sql<number>`coalesce(sum(${migrationRunEntities.deferredPending} + ${migrationRunEntities.deferredIncomplete} + ${migrationRunEntities.deferredFailed}), 0)`,
      })
      .from(migrationRunEntities)
      .where(eq(migrationRunEntities.runId, runId));

    /*
     * What a further attempt would act on, from the counters the engine maintains.
     *
     * Every record it would touch is in one of these: lost, in doubt, never reached, or carrying a deferred
     * reference that is not set. Records written with a reference dropped before the write are deliberately
     * not here — an attempt matches them and leaves them alone — and they appear under `excluded` instead.
     */
    const waiting =
      run.failed + run.unresolved + unreached + Number(deferred?.outstanding ?? 0) + omittedRetryable;
    // The ones a person has to settle are in `run.unresolved` already, and an attempt must not act on them.
    const safe = Math.max(0, waiting - needsPerson);
    const workWaiting = waiting > 0 || neverStarted;
    const excluded: RetrySafetyDto['excluded'] = [];
    if (permanentFailures > 0) {
      excluded.push({
        reason: 'The engine recorded these failures as unable to succeed on another attempt.',
        records: permanentFailures,
      });
    }
    if (omittedPermanent > 0) {
      excluded.push({
        reason:
          'These records are in the target without a reference the source gave them. A further attempt ' +
          'matches them and leaves them alone. Migrate the referenced dataset, then run a migration that ' +
          'updates records that already match.',
        records: omittedPermanent,
      });
    }
    if (needsPerson > 0) {
      excluded.push({
        reason: 'Nothing in the target can identify these records. Somebody has to look.',
        records: needsPerson,
      });
    }

    const base = { runId, attempt: run.attempt, safe, excluded, needsReconciliation: needsPerson };

    /*
     * 8 first, for a run that is finished and has nothing waiting.
     *
     * Asked before the status, because the two answers read very differently and only one of them is true
     * of a run that carried everything. `COMPLETED` is not a retryable status, so a check on the status
     * alone told somebody that a further attempt "does not apply to a run in this state" — which is
     * accurate and sounds like a refusal. There is nothing to refuse.
     */
    if (!workWaiting && needsPerson === 0 && !ACTIVE.includes(run.status)) {
      return {
        ...base,
        state: 'NOTHING_TO_RETRY',
        reason: 'Nothing in this run is waiting for another attempt.',
        allowed: false,
      };
    }

    // 1: a run that is still going, or one no attempt applies to.
    if (!RETRYABLE_STATUSES.includes(run.status)) {
      return {
        ...base,
        state: 'RETRY_BLOCKED',
        reason: ACTIVE.includes(run.status)
          ? 'This run has not finished. A further attempt starts after it does.'
          : 'A further attempt does not apply to a run in this state.',
        allowed: false,
      };
    }

    // 2: one migration at a time per target, which the gate enforces and this must not contradict.
    const [active] = await this.db
      .select({ id: migrationRuns.id })
      .from(migrationRuns)
      .where(
        and(
          eq(migrationRuns.targetEnvironmentId, run.targetEnvironmentId),
          inArray(migrationRuns.status, ACTIVE),
        ),
      );
    if (active) {
      return {
        ...base,
        state: 'RETRY_BLOCKED',
        reason: 'Another migration is running against this target. One runs at a time.',
        allowed: false,
      };
    }

    // 3: the state that makes a retry dangerous rather than merely useless.
    if (needsPerson > 0) {
      return {
        ...base,
        state: 'RECONCILE_FIRST',
        reason:
          `${needsPerson.toLocaleString()} records may be in the target with nothing that identifies them. ` +
          'Another attempt would write them again. Reconcile them first.',
        allowed: false,
      };
    }

    return {
      ...base,
      state: 'SAFE_TO_RETRY',
      reason: neverStarted
        ? `This run was stopped before it read any records. Attempt ${run.attempt + 1} starts from the beginning.`
        : `Attempt ${run.attempt + 1} would act on ${safe.toLocaleString()} records. ` +
          (excluded.length
            ? `${excluded.reduce((n, e) => n + e.records, 0).toLocaleString()} are excluded.`
            : 'None are excluded.'),
      allowed: true,
    };
  }

  /**
   * One record, and everything recorded about what happened to it.
   *
   * Assembled from the identity map and the error rows, and from nothing else. There is no live read of
   * the source record here, deliberately: a failure screen that opens a connection to the source to
   * decorate a row would fail exactly when the source is the thing that is broken, would read records the
   * person may not be entitled to see, and would make a list of a thousand failures a thousand calls.
   *
   * So the evidence is what the engine wrote down while it ran. Where that does not include a value, the
   * value is absent and the UI says `Not recorded`. It is a smaller answer than a source read would give
   * and it is one that is always true.
   */
  async recordDetail(
    ctx: Pick<RequestContext, 'organizationId'>,
    runId: string,
    entity: string,
    sourceId: string,
  ): Promise<RunRecordDetailDto> {
    // Authorization, and a 404 for a run in another organization before anything else is read.
    await this.loadRun(ctx.organizationId, runId);
    const [map] = await this.db
      .select()
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.runId, runId),
          eq(migrationRecordMaps.logicalName, entity),
          eq(migrationRecordMaps.sourceId, sourceId),
        ),
      );
    const errorRows = await this.db
      .select()
      .from(migrationErrors)
      .where(
        and(
          eq(migrationErrors.runId, runId),
          eq(migrationErrors.logicalName, entity),
          eq(migrationErrors.sourceRecordId, sourceId),
        ),
      )
      .orderBy(desc(migrationErrors.createdAt), asc(migrationErrors.id));
    /*
     * A record with errors and no identity-map row is a real state, not a missing one: the engine refused
     * it before it wrote anything, so there is nothing in the map to find. Reporting that as "not found"
     * would hide the failure the person came here to read.
     */
    if (!map && errorRows.length === 0) throw notFound('Record');
    const targets = await this.targetTables(runId);
    const [dataset] = await this.db
      .select({ displayName: migrationRunEntities.displayName })
      .from(migrationRunEntities)
      .where(and(eq(migrationRunEntities.runId, runId), eq(migrationRunEntities.logicalName, entity)));

    /*
     * The evidence a person needs to recognise the record and see what the failure names — not every
     * column. A failure screen that dumped the whole record would put source data on a page about an
     * error, which is both more than the question needs and more than the reader may be entitled to.
     */
    const evidence: RunRecordDetailDto['evidence'] = [
      { label: 'Source record', value: sourceId, field: null },
      { label: 'Record in target', value: map?.targetId ?? null, field: null },
      { label: 'Matched by', value: map?.matchMethod ?? null, field: null },
    ];
    const deferred = map?.deferredLookups ?? {};
    for (const [field, lookup] of Object.entries(deferred)) {
      evidence.push({
        label: `Reference in ${field}`,
        value: `${lookup.logicalName} ${lookup.id}`,
        field,
      });
    }
    // A field a failure names, where the record map holds no value for it. The field is evidence itself.
    for (const field of new Set(errorRows.map((e) => e.field).filter((f): f is string => !!f))) {
      if (!(field in deferred)) evidence.push({ label: `Value in ${field}`, value: null, field });
    }

    return {
      runId,
      runAttempt: map?.runAttempt ?? null,
      entity,
      displayName: dataset?.displayName ?? entity,
      targetTable: targets.get(entity) ?? null,
      sourceId,
      targetId: map?.targetId ?? null,
      outcome: (map?.outcome ?? 'FAILED') as RecordOutcome,
      matchMethod: map?.matchMethod ?? null,
      writeState: map?.writeState ?? null,
      deferredStatus: map?.deferredStatus ?? null,
      evidence,
      errors: errorRows.map((e) => this.toErrorDto(e, targets)),
      updatedAt: map?.updatedAt.toISOString() ?? null,
    };
  }

  async records(
    ctx: RequestContext,
    runId: string,
    filter: {
      entity?: string;
      outcome?: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED';
      limit: number;
      offset: number;
    },
  ): Promise<{ items: RecordMapDto[]; total: number }> {
    await this.loadRun(ctx.organizationId, runId);
    const conditions = [eq(migrationRecordMaps.runId, runId)];
    if (filter.entity) conditions.push(eq(migrationRecordMaps.logicalName, filter.entity));
    if (filter.outcome) conditions.push(eq(migrationRecordMaps.outcome, filter.outcome));
    const [total] = await this.db
      .select({ n: count() })
      .from(migrationRecordMaps)
      .where(and(...conditions));
    const rows = await this.db
      .select()
      .from(migrationRecordMaps)
      .where(and(...conditions))
      .orderBy(asc(migrationRecordMaps.logicalName), asc(migrationRecordMaps.sourceId))
      .limit(filter.limit)
      .offset(filter.offset);
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((m) => ({
        entity: m.logicalName,
        sourceId: m.sourceId,
        targetId: m.targetId,
        outcome: m.outcome,
        matchMethod: m.matchMethod,
        deferredStatus: m.deferredStatus,
        writeState: m.writeState ?? null,
        recoveryEvidence: m.reconcileEvidence ?? null,
        recoveryNote: m.reconcileNote ?? null,
        updatedAt: m.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * The same records, as pages, for an export that must not be capped.
   *
   * Walked by keyset on `(logicalName, sourceId)` — the identity map's own unique index — rather than
   * by offset, because `OFFSET 2000000` makes the database count two million rows it then discards,
   * and the last page of a large export is the slowest one exactly when it matters most.
   */
  async *recordPages(
    ctx: RequestContext,
    runId: string,
    filter: {
      entity?: string;
      outcome?: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED';
      pageSize?: number;
    } = {},
  ): AsyncGenerator<RecordMapDto[]> {
    await this.loadRun(ctx.organizationId, runId);
    const size = Math.max(1, Math.min(filter.pageSize ?? 1000, 5000));
    const conditions = [eq(migrationRecordMaps.runId, runId)];
    if (filter.entity) conditions.push(eq(migrationRecordMaps.logicalName, filter.entity));
    if (filter.outcome) conditions.push(eq(migrationRecordMaps.outcome, filter.outcome));
    const scope = and(...conditions)!;
    type Row = typeof migrationRecordMaps.$inferSelect;
    let cursor: { logicalName: string; sourceId: string } | null = null;
    for (;;) {
      const rows: Row[] = await this.db
        .select()
        .from(migrationRecordMaps)
        .where(
          cursor === null
            ? scope
            : and(
                scope,
                gt(
                  sql`(${migrationRecordMaps.logicalName}, ${migrationRecordMaps.sourceId})`,
                  sql`(${cursor.logicalName}, ${cursor.sourceId})`,
                ),
              ),
        )
        .orderBy(asc(migrationRecordMaps.logicalName), asc(migrationRecordMaps.sourceId))
        .limit(size);
      if (rows.length === 0) return;
      yield rows.map((m) => ({
        entity: m.logicalName,
        sourceId: m.sourceId,
        targetId: m.targetId,
        outcome: m.outcome,
        matchMethod: m.matchMethod,
        deferredStatus: m.deferredStatus,
        writeState: m.writeState ?? null,
        recoveryEvidence: m.reconcileEvidence ?? null,
        recoveryNote: m.reconcileNote ?? null,
        updatedAt: m.updatedAt.toISOString(),
      }));
      const last = rows[rows.length - 1]!;
      cursor = { logicalName: last.logicalName, sourceId: last.sourceId };
      if (rows.length < size) return;
    }
  }

  /**
   * Rollback foundation: an impact preview built from the identity map. Execution is deliberately
   * not offered yet — deleting target data is only safe with before-images, reference checks and
   * change detection, which are not in this version.
   */
  async rollbackPreview(ctx: RequestContext, runId: string): Promise<RollbackPreviewDto> {
    const run = await this.get(ctx, runId);
    const grouped = await this.db
      .select({
        logicalName: migrationRecordMaps.logicalName,
        outcome: migrationRecordMaps.outcome,
        n: count(),
      })
      .from(migrationRecordMaps)
      .where(eq(migrationRecordMaps.runId, runId))
      .groupBy(migrationRecordMaps.logicalName, migrationRecordMaps.outcome);
    const get = (t: string, o: string) =>
      Number(grouped.find((g) => g.logicalName === t && g.outcome === o)?.n ?? 0);
    const entities = run.entities.map((e) => ({
      entity: e.logicalName,
      displayName: e.displayName,
      created: get(e.logicalName, 'CREATED'),
      updated: get(e.logicalName, 'UPDATED'),
      skipped: get(e.logicalName, 'SKIPPED'),
      failed: get(e.logicalName, 'FAILED'),
    }));
    const warnings: string[] = [];
    if (entities.some((e) => e.updated > 0)) {
      warnings.push(
        'Records UPDATED by this run cannot be restored: previous values (before-images) were not captured.',
      );
    }
    warnings.push(
      'Created records may have been modified or referenced by other records in the target since the run.',
    );
    warnings.push('Deleting records can trigger cascade deletes and plug-ins in the target environment.');
    if (!TERMINAL_RUN_STATUSES.has(run.status as MigrationRunStatus)) {
      warnings.push('The run is still active; the inventory is incomplete.');
    }
    return {
      runId,
      executionSupported: false,
      executionStatus: 'NOT_YET_SUPPORTED',
      reason:
        'Automated rollback execution is not yet supported. Use the created-record inventory to review what this run created in the target.',
      entities,
      deletionOrder: [...run.entities].sort((a, b) => b.orderIndex - a.orderIndex).map((e) => e.logicalName),
      warnings,
    };
  }
}
