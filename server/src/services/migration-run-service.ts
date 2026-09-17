import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import {
  DEFAULT_PLAN_OPTIONS,
  type MigrationErrorDto,
  type MigrationRunDto,
  type MigrationRunListItemDto,
  type RecordMapDto,
  type RollbackPreviewDto,
} from '../../../shared/domain';
import type { AppDb } from '../db/client';
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
import type { JobQueue } from '../jobs/queue';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import type { PlanningService } from './planning-service';
import type { RunPlanSnapshot } from './run-snapshot';

const envRef = (e: { id: string; displayName: string; url: string }) => ({
  id: e.id,
  displayName: e.displayName,
  url: e.url,
});
const ACTIVE = ['QUEUED', 'RUNNING', 'PAUSED'];

export class MigrationRunService {
  constructor(
    private readonly db: AppDb,
    private readonly planning: PlanningService,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async start(
    ctx: RequestContext,
    planId: string,
    input: { confirmSourceName: string; confirmTargetName: string; acknowledgeWarnings: boolean },
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
    if (
      input.confirmSourceName.trim() !== plan.sourceEnvironment.displayName ||
      input.confirmTargetName.trim() !== plan.targetEnvironment.displayName
    ) {
      throw badRequest('Environment confirmation does not match the plan source and target names');
    }
    if (plan.warningCount > 0 && !input.acknowledgeWarnings) {
      throw badRequest(`Acknowledge the ${plan.warningCount} warning(s) before executing`);
    }
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

    const entityRows = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, planId))
      .orderBy(asc(migrationPlanEntities.orderIndex));
    const mappingRows = await this.db
      .select()
      .from(fieldMappings)
      .where(
        inArray(
          fieldMappings.planEntityId,
          entityRows.map((e) => e.id),
        ),
      );
    const snapshot: RunPlanSnapshot = {
      entities: entityRows.map((e) => ({
        logicalName: e.logicalName,
        displayName: e.displayName,
        orderIndex: e.orderIndex,
        matchStrategy: e.matchStrategy,
        alternateKey: e.alternateKey,
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
        executedByUserId: ctx.userId,
      })
      .returning();
    await this.db.insert(migrationRunEntities).values(
      entityRows.map((e) => ({
        runId: run.id,
        logicalName: e.logicalName,
        displayName: e.displayName,
        orderIndex: e.orderIndex,
        total: e.sourceCount ?? 0,
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
      requestId: ctx.requestId,
      details: {
        planId,
        tables: entityRows.map((e) => e.logicalName),
        conflictStrategy: plan.options.conflictStrategy,
        bypassCustomBusinessLogic: plan.options.bypassCustomBusinessLogic,
        acknowledgedWarnings: plan.warningCount,
      },
    });
    this.logger.info({ migrationRunId: run.id, planId, requestId: ctx.requestId }, 'Migration run queued');
    return this.get(ctx, run.id);
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
    const auditBase = {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      sourceEnvironmentId: run.sourceEnvironmentId,
      targetEnvironmentId: run.targetEnvironmentId,
      runId,
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
      await this.requeue(ctx, runId, false);
      await this.audit.record({ ...auditBase, action: 'MIGRATION_RESUMED', outcome: 'REQUESTED' });
    } else {
      if (!['COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(run.status)) {
        throw conflict(
          `Retry is available for failed, cancelled or partially failed runs (current: ${run.status})`,
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
      options: { ...DEFAULT_PLAN_OPTIONS, ...r.options },
      currentEntity: r.currentEntity,
      total: r.total,
      processed: r.processed,
      created: r.created,
      updated: r.updated,
      unchanged: r.unchanged,
      skipped: r.skipped,
      failed: r.failed,
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
        updatedAt: m.updatedAt.toISOString(),
      })),
    };
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
