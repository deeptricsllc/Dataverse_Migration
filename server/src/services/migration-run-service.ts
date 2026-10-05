import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { isUnresolved, needsHumanReconciliation, UNRESOLVED_WRITE_STATES } from '../../../shared/write-state';
import { refreshRunCounters } from './run-counters';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import {
  DEFAULT_PLAN_OPTIONS,
  needsTypedConfirmation,
  type MigrationErrorDto,
  type MigrationRunDto,
  type MigrationRunListItemDto,
  type RecordMapDto,
  type RollbackPreviewDto,
  type RunFailureSummaryDto,
  type RunTrigger,
} from '../../../shared/domain';
import { describeFailureCode } from '../../../shared/failure-categories';
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
      if (!['COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION'].includes(run.status)) {
        throw conflict(
          `Retry is available for failed, cancelled or partially failed runs (current: ${run.status})`,
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
      /** PRESENT: it is in the target. ABSENT: it is not, so the write never happened. */
      found: 'PRESENT' | 'ABSENT';
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
      await this.db
        .update(migrationRecordMaps)
        .set({
          // PRESENT means the write did happen, so the record was created by this run and is now known.
          // ABSENT means it did not, so the record is a plain failure the next attempt will try again.
          outcome: r.found === 'PRESENT' ? 'CREATED' : 'FAILED',
          writeState: r.found === 'PRESENT' ? 'CONFIRMED' : null,
          targetId: r.found === 'PRESENT' ? (r.targetId ?? null) : null,
          reconcileNote: `Resolved by ${ctx.displayName}: ${r.found === 'PRESENT' ? 'found in the target' : 'not in the target'}. ${r.note}`,
          updatedAt: new Date(),
        })
        .where(eq(migrationRecordMaps.id, row.id));
      resolved++;
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
      .select({ run: migrationRuns, src, tgt, planName: migrationPlans.name, user: users.displayName })
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
        startedAt: e.startedAt?.toISOString() ?? null,
        completedAt: e.completedAt?.toISOString() ?? null,
      })),
      errorCount: Number(severityCounts.find((s) => s.severity === 'ERROR')?.n ?? 0),
      warningCount: Number(severityCounts.find((s) => s.severity === 'WARNING')?.n ?? 0),
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
      .select({ run: migrationRuns, src, tgt, planName: migrationPlans.name, user: users.displayName })
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

  async errors(
    ctx: RequestContext,
    runId: string,
    filter: {
      entity?: string;
      kind?: 'all' | 'retryable' | 'permanent';
      severity?: 'ERROR' | 'WARNING';
      includeResolved?: boolean;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: MigrationErrorDto[]; total: number }> {
    await this.loadRun(ctx.organizationId, runId);
    const conditions = [eq(migrationErrors.runId, runId)];
    if (filter.entity) conditions.push(eq(migrationErrors.logicalName, filter.entity));
    if (filter.kind === 'retryable') conditions.push(eq(migrationErrors.retryable, true));
    if (filter.kind === 'permanent') conditions.push(eq(migrationErrors.retryable, false));
    if (filter.severity) conditions.push(eq(migrationErrors.severity, filter.severity));
    if (!filter.includeResolved) conditions.push(eq(migrationErrors.resolved, false));
    const [total] = await this.db
      .select({ n: count() })
      .from(migrationErrors)
      .where(and(...conditions));
    const rows = await this.db
      .select()
      .from(migrationErrors)
      .where(and(...conditions))
      .orderBy(desc(migrationErrors.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((e) => ({
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
      })),
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
    if (!['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(run.status)) {
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
