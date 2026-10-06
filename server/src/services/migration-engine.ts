import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  DEFAULT_PLAN_OPTIONS,
  auditFlags,
  type AppliedTransformationDto,
  type PlanOptions,
  type RecordOperation,
  type RecordOutcome,
  type TransformationMetricsDto,
} from '../../../shared/domain';
import {
  EVIDENCE_LABELS,
  isUnresolved,
  UNRESOLVED_WRITE_STATES,
  verdictOf,
  type ReconciliationEvidence,
  type WriteState,
} from '../../../shared/write-state';
import { MATERIAL_WARNING_CODES } from '../../../shared/failure-categories';
import {
  isLookupValue,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
  type LookupValue,
  type TableMetadata,
} from '../../../shared/metadata';
import type { AppDb } from '../db/client';
import { refreshRunCounters } from './run-counters';
import {
  migrationErrors,
  migrationPlans,
  migrationRecordMaps,
  migrationRunEntities,
  migrationRuns,
  migrationSchedules,
} from '../db/schema';
import { DataverseError, toDataverseError } from '../dataverse/errors';
import type { ConnectionFactory } from '../dataverse/factory';
import type { DataverseConnection, WriteOptions } from '../dataverse/types';
import { newerThanWatermark } from '../dataverse/types';
import { AppError, errorMessage } from '../lib/errors';
import type { AlertEvent } from './alert-service';
import type { AuditService } from './audit-service';
import type { EnvironmentService } from './environment-service';
import type { MetadataService } from './metadata-service';
import type { PrincipalService } from './principal-service';
import type { RunPlanSnapshot } from './run-snapshot';
import { RecordMatcher } from './record-matcher';
import { decideAction, prepareRecord, type PlannedAction, type PreparedRecord } from './record-planner';

type RunRow = typeof migrationRuns.$inferSelect;
type SnapshotEntity = RunPlanSnapshot['entities'][number];

interface RecordError {
  operation: RecordOperation;
  severity: 'ERROR' | 'WARNING';
  code: string;
  message: string;
  field?: string | null;
  retryable: boolean;
  httpStatus?: number | null;
  attempts?: number;
}

interface RecordResult {
  sourceId: string;
  /** What the transformation engine did to this record, for the run's aggregate metrics. */
  transformations?: { applied: AppliedTransformationDto[]; lossyFields: string[] } | null;
  outcome: RecordOutcome;
  /**
   * Whether we know this happened. Null for outcomes that write nothing — an unchanged or skipped
   * record has no write to be uncertain about.
   */
  writeState?: WriteState | null;
  /** What the write was going to be, kept so reconciliation knows what to look for. */
  intendedOperation?: 'CREATE' | 'UPDATE' | null;
  targetId: string | null;
  matchMethod: string | null;
  deferred: Record<string, LookupValue> | null;
  /** Pass 3 work: re-stamp modifiedby as the mapped source user. */
  audit: { modifiedById: string; field: string; value: FieldValue } | null;
  /** Ownership/audit fields where the fallback identity was substituted. */
  fallbacks: string[];
  errors: RecordError[];
}

/** Issues the planner found while preparing a record become per-record error rows. */
function toRecordErrors(prepared: PreparedRecord): RecordError[] {
  return prepared.issues.map((i) => ({
    operation: i.code === 'VALUE_CONVERSION' ? ('CREATE' as const) : ('RESOLVE_PRINCIPAL' as const),
    severity: i.severity,
    code: i.code,
    field: i.field ?? null,
    message: i.message,
    retryable: i.retryable,
  }));
}

/** Target columns to read for comparison: mapped columns plus the ownership column. */
function compareColumns(options: PlanOptions, entity: SnapshotEntity): string[] {
  const columns = entity.mappings.map((m) => m.targetField);
  if (auditFlags(options.auditPolicy).owner && entity.audit.ownerField) columns.push(entity.audit.ownerField);
  return [...new Set(columns)];
}

class RunInterrupted extends Error {
  constructor(public readonly reason: 'CANCELLED' | 'PAUSED') {
    super(reason);
  }
}

class FatalRunError extends Error {}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const SUCCESS_OUTCOMES = ['CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED'] as const;

/** Source audit columns to read when ownership / audit preservation is enabled. */
function auditSourceColumns(options: PlanOptions, entity: SnapshotEntity): string[] {
  const a = entity.audit;
  const flags = auditFlags(options.auditPolicy);
  const columns: (string | null)[] = [
    flags.owner ? a.ownerField : null,
    flags.createdOn ? a.createdOnField : null,
    flags.createdBy ? a.createdByField : null,
    flags.modifiedBy ? a.modifiedByField : null,
  ];
  return columns.filter((c): c is string => Boolean(c));
}

/** Errors that stop the whole run (authentication/authorization), not a single record. */
function isFatal(err: unknown): boolean {
  if (err instanceof AppError) return err.statusCode === 401 || err.statusCode === 403;
  if (err instanceof DataverseError) return err.code === 'AUTH_REQUIRED';
  return false;
}

function toRecordError(err: unknown, operation: RecordOperation): RecordError {
  const e = toDataverseError(err);
  return {
    operation,
    severity: 'ERROR',
    code: e.platformCode ? `${e.code}:${e.platformCode}` : e.code,
    message: e.message,
    retryable: e.retryable,
    httpStatus: e.status ?? null,
    attempts: (e as DataverseError & { attempts?: number }).attempts ?? 1,
  };
}

/**
 * Executes migration runs: dependency-ordered, batched, resumable and idempotent.
 *
 * PASS 1 creates/updates records per table in dependency order, resolving lookups through the
 * record identity map (this run, then earlier runs for the same environment pair, then existing
 * target records by id). Lookups on circular dependencies are deferred.
 * PASS 2 sets deferred lookups on the records created in PASS 1.
 */
/** The one thing this service needs from the alerting path. */
interface Alerts {
  notify(event: AlertEvent): Promise<void>;
}

export class MigrationEngine {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly alerts: Alerts,
  ) {}

  /**
   * Moves a schedule's watermark forward.
   *
   * Never backwards: a run that started earlier but finished later must not rewind a schedule past
   * what a later run already covered, or records would be migrated twice.
   */
  private async recordScheduleWatermark(scheduleId: string, watermark: string): Promise<void> {
    await this.db
      .update(migrationSchedules)
      .set({ lastWatermark: watermark, updatedAt: new Date() })
      .where(
        and(
          eq(migrationSchedules.id, scheduleId),
          or(isNull(migrationSchedules.lastWatermark), lt(migrationSchedules.lastWatermark, watermark)),
        ),
      );
  }

  async execute(runId: string, heartbeat: () => Promise<void> = async () => {}): Promise<void> {
    const [run] = await this.db.select().from(migrationRuns).where(eq(migrationRuns.id, runId));
    if (!run || !['QUEUED', 'RUNNING'].includes(run.status)) return;
    const log = this.logger.child({ migrationRunId: runId, organizationId: run.organizationId });
    await this.db
      .update(migrationRuns)
      .set({
        status: 'RUNNING',
        startedAt: run.startedAt ?? new Date(),
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(migrationRuns.id, runId));
    log.info({ attempt: run.attempt }, 'Migration run started');

    try {
      if (!run.executedByUserId) throw new FatalRunError('Run has no executing user');
      const source = await this.environmentsSvc.getInOrganization(
        run.organizationId,
        run.sourceEnvironmentId,
      );
      const target = await this.environmentsSvc.getInOrganization(
        run.organizationId,
        run.targetEnvironmentId,
      );
      // `maxRetries + 1` attempts: the option is how many times to retry, and the policy counts the
      // first try as one of its attempts.
      const attempts = { maxAttempts: (run.options.maxRetries ?? DEFAULT_PLAN_OPTIONS.maxRetries) + 1 };
      const sConn = await this.connections.connectorFor(
        source,
        run.executedByUserId,
        { migrationRunId: runId },
        attempts,
      );
      const tConn = await this.connections.connectorFor(
        target,
        run.executedByUserId,
        { migrationRunId: runId },
        attempts,
      );
      const options: PlanOptions = { ...DEFAULT_PLAN_OPTIONS, ...run.options };
      const writeOptions: WriteOptions = {
        bypassCustomBusinessLogic: options.bypassCustomBusinessLogic,
        suppressFlowTriggers: options.suppressFlowTriggers,
      };
      const snapshot = run.planSnapshot;
      const entities = [...snapshot.entities].sort((a, b) => a.orderIndex - b.orderIndex);

      // Metadata for migrated tables and every table referenced by a mapped lookup.
      const names = entities.map((e) => e.logicalName);
      const sourceMeta = await this.metadata.getTables(source.id, sConn, names, { refresh: true });
      const targetCatalog = await this.metadata.getCatalog(target.id, tConn, true);

      // Source table -> target table. A lookup pointing at a source table is resolved against
      // whichever target table that source table migrates into, which is what makes a SQL
      // foreign key land on the right Dataverse lookup.
      const targetTableFor = new Map<string, string>(
        entities.map((e) => [e.logicalName, e.targetLogicalName]),
      );
      const referenced = new Set<string>();
      for (const e of entities) {
        const mapped = targetTableFor.get(e.logicalName);
        if (mapped) referenced.add(mapped);
        const s = sourceMeta.get(e.logicalName);
        for (const m of e.mappings.filter((x) => x.isLookup)) {
          for (const t of s?.attributes.find((a) => a.logicalName === m.sourceField)?.targets ?? []) {
            // A lookup may point at a platform table (systemuser) that is not migrated: then the
            // referenced name is the same in both systems.
            referenced.add(targetTableFor.get(t) ?? t);
          }
        }
      }
      const targetMeta = await this.metadata.getTables(
        target.id,
        tConn,
        [...referenced].filter((n) => targetCatalog.some((c) => c.logicalName === n)),
        { refresh: true },
      );

      // Users/teams/business units keep different ids per environment: resolve them through
      // the principal map, which also drives ownership and created-by preservation.
      const principalMap = await this.principals.resolutionMap(
        run.organizationId,
        run.sourceEnvironmentId,
        run.targetEnvironmentId,
      );
      const ctx: ExecContext = {
        run,
        log,
        sConn,
        tConn,
        options,
        writeOptions,
        sourceMeta,
        targetMeta,
        targetTableFor,
        // Record ids only mean the same thing in both systems when both are the same kind of
        // system. Between providers a source id is never assumed to exist in the target.
        sameProvider: source.connectionType === target.connectionType,
        metrics: {
          recordsTransformed: 0,
          valuesTransformed: 0,
          lossyValues: 0,
          defaultsApplied: 0,
          nullConversions: 0,
          valueMappings: 0,
          failures: 0,
          byKind: {},
        },
        incremental: run.incremental ?? null,
        watermark: { value: run.watermark ?? null },
        heartbeat,
        lookupCache: new Map(principalMap),
        principalMap,
        principalObjectIds: await this.principals.targetObjectIds(run.targetEnvironmentId),
        matcher: new RecordMatcher(this.db, tConn, {
          organizationId: run.organizationId,
          sourceEnvironmentId: run.sourceEnvironmentId,
          targetEnvironmentId: run.targetEnvironmentId,
          runId: run.id,
        }),
      };

      await this.db.update(migrationRuns).set({ phase: 'PASS_1' }).where(eq(migrationRuns.id, runId));
      for (const entity of entities) {
        await this.checkControl(runId);
        await this.migrateEntity(ctx, entity);
      }

      await this.db
        .update(migrationRuns)
        .set({ phase: 'PASS_2_DEFERRED_LOOKUPS', currentEntity: null })
        .where(eq(migrationRuns.id, runId));
      for (const entity of entities) {
        await this.checkControl(runId);
        await this.resolveDeferred(ctx, entity);
      }

      if (auditFlags(options.auditPolicy).modifiedBy) {
        await this.db
          .update(migrationRuns)
          .set({ phase: 'PASS_3_AUDIT', currentEntity: null })
          .where(eq(migrationRuns.id, runId));
        for (const entity of entities) {
          await this.checkControl(runId);
          await this.stampModifiedBy(ctx, entity);
        }
      }

      await this.refreshCounters(runId);
      const [final] = await this.db.select().from(migrationRuns).where(eq(migrationRuns.id, runId));
      const [deferredFailed] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(migrationRecordMaps)
        .where(and(eq(migrationRecordMaps.runId, runId), eq(migrationRecordMaps.deferredStatus, 'FAILED')));
      /**
       * A whole table can fail without a single record failing: the table is missing in the source or
       * target, or the source read itself failed. Those paths write an error and mark the table
       * FAILED, but never produce a FAILED record, so a run that lost an entire table used to be
       * stamped COMPLETED — with the plan marked EXECUTED and the audit trail recording success. For
       * a migration tool that is the worst possible lie, so the table statuses are counted too.
       */
      const [failedEntities] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(migrationRunEntities)
        .where(and(eq(migrationRunEntities.runId, runId), eq(migrationRunEntities.status, 'FAILED')));
      const failedTables = Number(failedEntities?.n ?? 0);
      // And any unresolved error of ERROR severity, so a future failure path that writes an error
      // without producing a failed record cannot slip through either.
      const [unresolved] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(migrationErrors)
        .where(
          and(
            eq(migrationErrors.runId, runId),
            eq(migrationErrors.severity, 'ERROR'),
            eq(migrationErrors.resolved, false),
          ),
        );
      /**
       * Records whose write outcome nobody knows.
       *
       * Counted from the identity map rather than from the counters, because this is the one number the
       * run's status must not be wrong about. A run with any of these cannot be `COMPLETED`: see
       * `canCompleteRun`.
       */
      const [unresolvedWrites] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(migrationRecordMaps)
        .where(
          and(
            eq(migrationRecordMaps.runId, runId),
            inArray(migrationRecordMaps.writeState, [...UNRESOLVED_WRITE_STATES]),
          ),
        );
      const stillUnresolved = Number(unresolvedWrites?.n ?? 0);
      /**
       * Records written with a reference omitted, and warnings that mean the data differs.
       *
       * Counted because a run whose every write succeeded can still have failed to carry the data
       * across, and the outcome has to say so. Neither of these is a failure and neither is counted as
       * one; they decide between `COMPLETED` and `COMPLETED_WITH_WARNINGS`, nothing further.
       */
      const [incomplete] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(migrationRecordMaps)
        .where(
          and(eq(migrationRecordMaps.runId, runId), eq(migrationRecordMaps.deferredStatus, 'INCOMPLETE')),
        );
      const [materialWarnings] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(migrationErrors)
        .where(
          and(
            eq(migrationErrors.runId, runId),
            eq(migrationErrors.severity, 'WARNING'),
            eq(migrationErrors.resolved, false),
            inArray(migrationErrors.errorCode, [...MATERIAL_WARNING_CODES]),
          ),
        );
      /**
       * Neither completed nor failed, when something is still in doubt.
       *
       * `NEEDS_RECONCILIATION` says "something has to be settled", which is true whether the next attempt
       * can settle it by asking the target or a person has to look. Which of those it is decides whether
       * a retry is allowed, and that lives in the retry gate rather than in the status — one word for one
       * state, and the gate reads the records to decide what to permit.
       */
      const status = decideRunStatus({
        failedRecords: final.failed,
        deferredFailed: Number(deferredFailed?.n ?? 0),
        failedTables,
        unresolvedErrors: Number(unresolved?.n ?? 0),
        unresolvedWrites: stillUnresolved,
        deferredIncomplete: Number(incomplete?.n ?? 0),
        materialWarnings: Number(materialWarnings?.n ?? 0),
      });
      /*
       * Three different questions, which one boolean used to answer for all of them.
       *
       * Whether the plan is done, whether somebody must be told, and whether the audit trail records a
       * failure are not the same question, and a run that wrote every record while dropping every
       * reference answers them differently: the plan is not done, somebody must be told, and the
       * operation did not fail.
       */
      const carriedEverything = status === 'COMPLETED';
      const hadErrors = status === 'COMPLETED_WITH_ERRORS' || status === 'NEEDS_RECONCILIATION';
      const omittedReferences = Number(incomplete?.n ?? 0) + Number(materialWarnings?.n ?? 0);
      if (stillUnresolved > 0) {
        log.error(
          { unresolvedWrites: stillUnresolved },
          'Run cannot be completed: the outcome of some writes is unknown',
        );
      }
      await this.db
        .update(migrationRuns)
        .set({
          status,
          phase: 'DONE',
          currentEntity: null,
          completedAt: new Date(),
          updatedAt: new Date(),
          transformationMetrics: ctx.metrics,
          // Only a run that finished may advance the watermark. A failed run leaves it where it was,
          // so the records it never processed are read again next time instead of being skipped.
          watermark: ctx.watermark.value,
        })
        .where(eq(migrationRuns.id, runId));
      // The schedule starts its next run from here.
      if (run.scheduleId && ctx.watermark.value) {
        await this.recordScheduleWatermark(run.scheduleId, ctx.watermark.value);
      }
      // A plan is only "executed" when the run it produced actually carried everything. Marking it
      // executed after a table was lost tells the next person the work is done.
      await this.db
        .update(migrationPlans)
        .set({ status: carriedEverything ? 'EXECUTED' : 'PLANNED' })
        .where(eq(migrationPlans.id, run.planId));
      this.metadata.invalidateCounts(target.id);
      // A run that lost records or tables is exactly what somebody needs to hear about, and the
      // person who started it may have gone home. A clean run announces nothing.
      // A run that omitted references is exactly what somebody needs to hear about, failure or not.
      if (!carriedEverything) {
        await this.alerts.notify({
          kind: 'RUN_ENDED_BADLY',
          runId,
          target: target.displayName,
          status,
          failed: final.failed,
          error: null,
        });
      }
      await this.audit.record({
        organizationId: run.organizationId,
        userId: run.executedByUserId,
        action: 'MIGRATION_COMPLETED',
        /*
         * The operation, not the data quality. A run with omitted references did what it was asked to do
         * and did not fail; `details.status` below carries which outcome it reached, and
         * `omittedReferences` carries how much was left behind, so the audit row stands on its own.
         */
        outcome: hadErrors ? 'FAILURE' : 'SUCCESS',
        sourceEnvironmentId: run.sourceEnvironmentId,
        targetEnvironmentId: run.targetEnvironmentId,
        runId,
        details: {
          status,
          omittedReferences,
          created: final.created,
          updated: final.updated,
          skipped: final.skipped,
          failed: final.failed,
        },
      });
      log.info(
        {
          status,
          created: final.created,
          updated: final.updated,
          skipped: final.skipped,
          failed: final.failed,
        },
        'Migration run finished',
      );
    } catch (err) {
      if (err instanceof RunInterrupted) {
        await this.refreshCounters(runId);
        await this.db
          .update(migrationRuns)
          .set({
            status: err.reason,
            currentEntity: null,
            completedAt: err.reason === 'CANCELLED' ? new Date() : null,
            pauseRequested: false,
            updatedAt: new Date(),
          })
          .where(eq(migrationRuns.id, runId));
        await this.db
          .update(migrationRunEntities)
          .set({ status: 'PENDING' })
          .where(and(eq(migrationRunEntities.runId, runId), eq(migrationRunEntities.status, 'RUNNING')));
        log.warn({ reason: err.reason }, 'Migration run interrupted');
        return;
      }
      const message =
        err instanceof AppError || err instanceof FatalRunError ? err.message : errorMessage(err);
      log.error({ error: message }, 'Migration run failed');
      await this.refreshCounters(runId).catch(() => undefined);
      /**
       * A run that stopped with records in doubt is not a failed run.
       *
       * `FAILED` tells the reader the work did not happen and invites a retry. Here some of it may have
       * happened, and whether a retry is safe depends on the records rather than on the status — so the
       * status says what is true ("something is in doubt") and the retry gate decides what to permit.
       */
      const [blocked] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(migrationRecordMaps)
        .where(
          and(
            eq(migrationRecordMaps.runId, runId),
            inArray(migrationRecordMaps.writeState, [...UNRESOLVED_WRITE_STATES]),
          ),
        )
        .catch(() => [{ n: 0 }]);
      const needsReconciliation = Number(blocked?.n ?? 0) > 0;
      await this.db
        .update(migrationRuns)
        .set({
          status: needsReconciliation ? 'NEEDS_RECONCILIATION' : 'FAILED',
          errorMessage: message.slice(0, 2000),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(migrationRuns.id, runId));
      await this.audit.record({
        organizationId: run.organizationId,
        userId: run.executedByUserId,
        action: 'MIGRATION_COMPLETED',
        outcome: 'FAILURE',
        sourceEnvironmentId: run.sourceEnvironmentId,
        targetEnvironmentId: run.targetEnvironmentId,
        runId,
        details: { status: 'FAILED', error: message },
      });
    }
  }

  private async checkControl(runId: string) {
    const [r] = await this.db
      .select({ cancel: migrationRuns.cancelRequested, pause: migrationRuns.pauseRequested })
      .from(migrationRuns)
      .where(eq(migrationRuns.id, runId));
    if (r?.cancel) throw new RunInterrupted('CANCELLED');
    if (r?.pause) throw new RunInterrupted('PAUSED');
  }

  // ---------------------------------------------------------------------------
  // PASS 1
  // ---------------------------------------------------------------------------

  private async migrateEntity(ctx: ExecContext, entity: SnapshotEntity) {
    const { run, log } = ctx;
    const [runEntity] = await this.db
      .select()
      .from(migrationRunEntities)
      .where(
        and(eq(migrationRunEntities.runId, run.id), eq(migrationRunEntities.logicalName, entity.logicalName)),
      );
    const s = ctx.sourceMeta.get(entity.logicalName);
    const t = ctx.targetMeta.get(entity.targetLogicalName);
    const elog = log.child({ entity: entity.logicalName });

    await this.db
      .update(migrationRuns)
      .set({ currentEntity: entity.logicalName, updatedAt: new Date() })
      .where(eq(migrationRuns.id, run.id));
    await this.db
      .update(migrationRunEntities)
      .set({ status: 'RUNNING', startedAt: runEntity.startedAt ?? new Date(), completedAt: null })
      .where(eq(migrationRunEntities.id, runEntity.id));
    elog.info('Entity migration started');

    if (!s || !t) {
      await this.persistErrors(run.id, entity.logicalName, null, [
        {
          operation: 'READ',
          severity: 'ERROR',
          code: 'TABLE_UNAVAILABLE',
          message: !s
            ? `Table ${entity.logicalName} is not available in the source connection`
            : `Target table ${entity.targetLogicalName} is not available in the target connection`,
          retryable: false,
        },
      ]);
      await this.db
        .update(migrationRunEntities)
        .set({ status: 'FAILED', completedAt: new Date() })
        .where(eq(migrationRunEntities.id, runEntity.id));
      return;
    }

    const total = await ctx.sConn.countRecords(s).catch(() => ({ count: 0, approximate: true }));
    await this.db
      .update(migrationRunEntities)
      .set({ total: total.count })
      .where(eq(migrationRunEntities.id, runEntity.id));

    /**
     * What a resume has already done, asked a page at a time.
     *
     * This used to load every identity row for the table into a Map before reading a single
     * record, so resuming a five-million-row migration started by holding five million entries in
     * memory — on the one path that only runs when a large migration has already failed once.
     *
     * The lookup is on `(runId, logicalName, sourceId)`, which is the table's unique index, so a
     * page costs one indexed probe. On a first attempt there is nothing to resume, and the count
     * below means those runs do not pay for the question at all.
     */
    const [prior] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(migrationRecordMaps)
      .where(
        and(eq(migrationRecordMaps.runId, run.id), eq(migrationRecordMaps.logicalName, entity.logicalName)),
      );
    const hasPriorWork = Number(prior?.n ?? 0) > 0;
    // Before anything is read from the source, settle what the last attempt left in doubt.
    if (hasPriorWork) await this.reconcileUnresolved(ctx, entity, t, runEntity.id);
    const alreadyHandled = async (
      ids: string[],
    ): Promise<Map<string, { outcome: RecordOutcome; writeState: WriteState | null }>> => {
      if (!hasPriorWork || ids.length === 0) return new Map();
      /**
       * Identifiers are stored lowercased, so they have to be looked up that way.
       *
       * `persistResults` writes `sourceId.toLowerCase()` — right for a GUID, where case means nothing —
       * and this compared the source's own casing against it. For a GUID source that returns lowercase
       * it happened to match; for a file keyed on `DRILL-00001`, or a Dataverse tenant returning
       * uppercase GUIDs, nothing matched and **every already-migrated record was processed again**.
       *
       * No duplicate resulted, because the matcher lowercases its own lookup and found the record — but
       * the conflict rules then recorded it as SKIPPED, overwriting the CREATED row. A destructive drill
       * on deployed QA killed the process after 3,000 records and the run came back reporting that it
       * had created 6 of them.
       */
      const wanted = ids.map((id) => id.toLowerCase());
      const rows = await this.db
        .select({
          sourceId: migrationRecordMaps.sourceId,
          outcome: migrationRecordMaps.outcome,
          writeState: migrationRecordMaps.writeState,
        })
        .from(migrationRecordMaps)
        .where(
          and(
            eq(migrationRecordMaps.runId, run.id),
            eq(migrationRecordMaps.logicalName, entity.logicalName),
            inArray(migrationRecordMaps.sourceId, wanted),
          ),
        );
      return new Map(
        rows.map((r) => [r.sourceId.toLowerCase(), { outcome: r.outcome, writeState: r.writeState }]),
      );
    };

    const sourceColumns = [
      ...entity.mappings.map((m) => m.sourceField),
      ...auditSourceColumns(ctx.options, entity),
    ];
    const pageSize = Math.max(1, Math.min(ctx.options.batchSize, 500));
    // An incremental run asks the source for changed records only. The watermark column is read
    // alongside the mapped ones so the run can report how far it got.
    const watermarkField = ctx.incremental?.field ?? null;
    const readColumns =
      watermarkField && !sourceColumns.includes(watermarkField)
        ? [...sourceColumns, watermarkField]
        : sourceColumns;
    try {
      for await (const page of ctx.sConn.queryRecords(s, readColumns, {
        pageSize,
        since: ctx.incremental?.since ? { field: ctx.incremental.field, value: ctx.incremental.since } : null,
      })) {
        if (watermarkField) observeWatermark(ctx.watermark, page, watermarkField);
        await this.checkControl(run.id);
        const handled = await alreadyHandled(page.map((r) => r.id));
        /**
         * What to process, and the one record this must never pick up.
         *
         * A record whose write outcome is unresolved may already be in the target, so re-processing it
         * could create a second copy. Reconciliation runs before this and resolves what it can; anything
         * still unresolved here is excluded, and the completeness check at the end of the run refuses to
         * call the run finished while any remain.
         *
         * This is the line that was the bug: it used to re-process anything marked FAILED, and an
         * ambiguous write was marked FAILED.
         */
        const pending = page.filter((r) => {
          const prior = handled.get(r.id.toLowerCase());
          if (!prior) return true;
          if (isUnresolved(prior.writeState)) return false;
          return prior.outcome === 'FAILED';
        });
        if (pending.length === 0) continue;
        const results = await this.processBatch(ctx, entity, s, t, pending);
        this.countTransformations(ctx, results);
        await this.persistResults(run, entity.logicalName, results);
        await this.refreshCounters(run.id, runEntity.id);
        await ctx.heartbeat();
        if (ctx.options.stopOnFirstError && results.some((r) => r.outcome === 'FAILED')) {
          throw new FatalRunError(
            `Stopped on first error in ${entity.logicalName} (stopOnFirstError enabled)`,
          );
        }
      }
    } catch (err) {
      if (err instanceof RunInterrupted || err instanceof FatalRunError || isFatal(err)) throw err;
      // Failure reading the source: record it and continue with other tables.
      const re = toRecordError(err, 'READ');
      elog.error({ errorCode: re.code }, 'Entity read failed');
      await this.persistErrors(run.id, entity.logicalName, null, [re]);
      await this.refreshCounters(run.id, runEntity.id);
      await this.db
        .update(migrationRunEntities)
        .set({ status: 'FAILED', completedAt: new Date() })
        .where(eq(migrationRunEntities.id, runEntity.id));
      return;
    }

    const [counts] = await this.db
      .select()
      .from(migrationRunEntities)
      .where(eq(migrationRunEntities.id, runEntity.id));
    await this.db
      .update(migrationRunEntities)
      .set({ status: counts.failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', completedAt: new Date() })
      .where(eq(migrationRunEntities.id, runEntity.id));
    elog.info(
      { created: counts.created, updated: counts.updated, skipped: counts.skipped, failed: counts.failed },
      'Entity migration finished',
    );
  }

  /**
   * One batch: decide everything, record what we are about to write, write it, record what happened.
   *
   * The order is the protocol. Deciding and writing used to be interleaved per record, so a crash
   * between a target write and the identity-map write at the end of the batch left records in the
   * customer's database that this platform had no row for — and resume, seeing no row, created them
   * again. Now an intent row exists before the write, so a crash leaves evidence that the record was
   * attempted, which is what reconciliation needs.
   *
   * An intent proves nothing about whether the write committed. That is the point: it turns "no
   * evidence at all" into "this record is in doubt", and a record in doubt is never written again.
   */
  /**
   * Settles the records a previous attempt left in doubt, before this one reads anything.
   *
   * A row left `INTENDED` means the write was started and the answer was lost. The record may be in the
   * target or it may not, and the only way to find out is to ask — using evidence that identifies the
   * record *uniquely*. A name is not evidence. Two records that look alike are not the same record.
   *
   * Three outcomes per row:
   *
   *   found in the target      → CONFIRMED, and the outcome becomes what the intent said
   *   definitely not there     → the write never committed, so the row is cleared and the record is
   *                              processed normally this time
   *   no usable evidence       → RECONCILIATION_REQUIRED. The table stops. Nobody guesses.
   *
   * Idempotent on purpose: running it twice reaches the same conclusion, and a crash part way through
   * leaves the rows it has not reached exactly as it found them. Scenario G of the chaos matrix is this
   * property.
   */
  private async reconcileUnresolved(
    ctx: ExecContext,
    entity: SnapshotEntity,
    t: TableMetadata,
    runEntityId: string,
  ): Promise<void> {
    const scope = and(
      eq(migrationRecordMaps.runId, ctx.run.id),
      eq(migrationRecordMaps.logicalName, entity.logicalName),
      inArray(migrationRecordMaps.writeState, ['INTENDED', 'UNKNOWN']),
    )!;
    const rows = await this.db
      .select()
      .from(migrationRecordMaps)
      .where(scope)
      .orderBy(asc(migrationRecordMaps.sourceId));
    if (rows.length === 0) return;

    const elog = this.logger.child({ runId: ctx.run.id, entity: entity.logicalName });
    elog.warn({ unresolved: rows.length }, 'Reconciling records whose write outcome is unknown');

    let confirmed = 0;
    let cleared = 0;
    let stuck = 0;
    for (const row of rows) {
      const evidence = (row.reconcileEvidence ?? 'NONE') as ReconciliationEvidence;
      const operation = row.intendedOperation ?? 'CREATE';

      /**
       * An update needs no search.
       *
       * It already knew which target record it was changing, so the record exists either way and the
       * only question is whether the new values landed. Re-applying the same values to the same primary
       * key is idempotent, so the safe answer is to let it be written again.
       */
      if (operation === 'UPDATE' && row.targetId) {
        await this.resolveRow(row.id, {
          outcome: 'FAILED',
          writeState: null,
          note: 'An update whose outcome was unknown is safe to repeat: the same values on the same record leave the target as the first attempt did.',
        });
        cleared++;
        continue;
      }

      const found = await this.findIntendedRecord(ctx, entity, t, row, evidence);
      if (found === 'NO_EVIDENCE') {
        await this.resolveRow(row.id, {
          outcome: 'UNRESOLVED',
          writeState: 'RECONCILIATION_REQUIRED',
          note: `The write may have been applied and nothing in ${t.logicalName} can identify this record: the target assigns its own key and no unique key is mapped. Whether it committed cannot be determined automatically.`,
        });
        stuck++;
        continue;
      }
      if (found) {
        await this.resolveRow(row.id, {
          outcome: operation === 'UPDATE' ? 'UPDATED' : 'CREATED',
          writeState: 'CONFIRMED',
          targetId: found,
          note: `Found in the target by ${EVIDENCE_LABELS[evidence]}, so the write did commit before the answer was lost.`,
        });
        confirmed++;
      } else {
        await this.resolveRow(row.id, {
          outcome: 'FAILED',
          writeState: null,
          note: `Not in the target, searched by ${EVIDENCE_LABELS[evidence]}, so the write did not commit. Safe to process again.`,
        });
        cleared++;
      }
    }

    await this.refreshCounters(ctx.run.id, runEntityId);
    elog.warn({ confirmed, cleared, needsHuman: stuck }, 'Reconciliation finished');
    if (stuck > 0) {
      /**
       * Stop, rather than migrate the rest and report a number nobody can trust.
       *
       * A table with records in this state cannot be completed: the run has no way to know whether it
       * created them. Continuing would produce a COMPLETED run whose record count is unknowable, which
       * is exactly the outcome this protocol exists to prevent.
       */
      throw new FatalRunError(
        `${stuck} record(s) in ${entity.logicalName} need reconciliation by hand: a write may have been applied and nothing in the target can identify the record. Nothing further will be written to this table. See the run's records for the list.`,
      );
    }
  }

  /** Writes a reconciliation conclusion. One row, one statement, no batching: this path is rare. */
  private async resolveRow(
    id: string,
    resolution: { outcome: RecordOutcome; writeState: WriteState | null; targetId?: string; note: string },
  ): Promise<void> {
    const [row] = await this.db
      .update(migrationRecordMaps)
      .set({
        outcome: resolution.outcome,
        writeState: resolution.writeState,
        ...(resolution.targetId ? { targetId: resolution.targetId } : {}),
        reconcileNote: resolution.note,
        updatedAt: new Date(),
      })
      .where(eq(migrationRecordMaps.id, id))
      .returning({
        runId: migrationRecordMaps.runId,
        logicalName: migrationRecordMaps.logicalName,
        sourceId: migrationRecordMaps.sourceId,
      });
    /**
     * A record found in the target no longer has an outstanding error.
     *
     * The timeout that made it uncertain was recorded as an unresolved error, and an unresolved error of
     * ERROR severity keeps the run out of `COMPLETED` — correctly, while the question is open. Once
     * reconciliation has answered it, leaving the error outstanding would report a problem that has been
     * settled.
     */
    if (row && resolution.writeState === 'CONFIRMED') {
      await this.db
        .update(migrationErrors)
        .set({ resolved: true })
        .where(
          and(
            eq(migrationErrors.runId, row.runId),
            eq(migrationErrors.logicalName, row.logicalName),
            eq(migrationErrors.sourceRecordId, row.sourceId),
            eq(migrationErrors.severity, 'ERROR'),
          ),
        );
    }
  }

  /**
   * Asks the target whether an intended record is there.
   *
   * Returns the target identifier when it is, `false` when it definitively is not, and `NO_EVIDENCE`
   * when the question cannot be asked at all — which is a different answer from "no" and must never be
   * collapsed into one.
   */
  private async findIntendedRecord(
    ctx: ExecContext,
    entity: SnapshotEntity,
    t: TableMetadata,
    row: typeof migrationRecordMaps.$inferSelect,
    evidence: ReconciliationEvidence,
  ): Promise<string | false | 'NO_EVIDENCE'> {
    switch (evidence) {
      case 'RECORDED_TARGET_ID': {
        if (!row.targetId) return 'NO_EVIDENCE';
        const [found] = await ctx.tConn.retrieveByIds(t, [row.targetId], []);
        return found ? found.id : false;
      }
      case 'PRESERVED_ID': {
        // The target took the source's own identifier, so the source id *is* the target id.
        const [found] = await ctx.tConn.retrieveByIds(t, [row.sourceId], []);
        return found ? found.id : false;
      }
      case 'ALTERNATE_KEY': {
        const key = t.keys.find((k) => k.logicalName === entity.alternateKey);
        if (!key) return 'NO_EVIDENCE';
        const values = await this.intendedValues(ctx, entity, t, row);
        if (!values) return 'NO_EVIDENCE';
        const found = await ctx.tConn.findByAlternateKey(t, key, values, []);
        return found ? found.id : false;
      }
      case 'BUSINESS_KEY': {
        const fields = entity.businessKeyFields ?? [];
        if (fields.length === 0) return 'NO_EVIDENCE';
        const values = await this.intendedValues(ctx, entity, t, row);
        if (!values) return 'NO_EVIDENCE';
        const criteria: Record<string, FieldValue> = {};
        for (const f of fields) {
          const v = values[f];
          // An incomplete key identifies nothing, and a partial match is a guess.
          if (v === undefined || v === null) return 'NO_EVIDENCE';
          criteria[f] = v;
        }
        const candidates = await ctx.tConn.findByFields(t, criteria, [], 2);
        // More than one match means the key is not unique in the target, so it is not evidence either.
        if (candidates.length > 1) return 'NO_EVIDENCE';
        return candidates.length === 1 ? candidates[0]!.id : false;
      }
      case 'NONE':
      default:
        return 'NO_EVIDENCE';
    }
  }

  /**
   * Re-reads and re-transforms the source record, so a key lookup uses the values that were written.
   *
   * The transformed values are not stored in the identity map — storing a copy of every record would be
   * a second copy of the customer's data — so recovery reads the one record it needs and puts it through
   * the same transformation engine the write used. Returns null when the source record is gone, which
   * means the key cannot be reconstructed and there is no evidence after all.
   */
  private async intendedValues(
    ctx: ExecContext,
    entity: SnapshotEntity,
    t: TableMetadata,
    row: typeof migrationRecordMaps.$inferSelect,
  ): Promise<Record<string, FieldValue> | null> {
    const s = ctx.sourceMeta.get(entity.logicalName);
    if (!s) return null;
    const [record] = await ctx.sConn.retrieveByIds(
      s,
      [row.sourceId],
      entity.mappings.map((m) => m.sourceField),
    );
    if (!record) return null;
    const prepared = prepareRecord({
      entity,
      options: ctx.options,
      source: s,
      target: t,
      record,
      principalMap: ctx.principalMap,
      lookups: ctx.lookupCache,
      targetTableFor: ctx.targetTableFor,
    });
    return prepared.values;
  }

  private async processBatch(
    ctx: ExecContext,
    entity: SnapshotEntity,
    s: TableMetadata,
    t: TableMetadata,
    records: DvRecord[],
  ): Promise<RecordResult[]> {
    // Batch-resolve lookups and candidate target records before any per-record write.
    await this.prefetchLookups(ctx, entity, records);
    const columns = compareColumns(ctx.options, entity);
    const prefetched = await ctx.matcher.prefetch(
      entity,
      t,
      records.map((r) => r.id),
      columns,
    );

    // --- decide ------------------------------------------------------------
    // Reads only. Nothing in the customer's database changes in this phase.
    type Planned = { record: DvRecord; prepared: PreparedRecord; decision: PlannedAction } | RecordResult;
    const planned: Planned[] = await mapLimit(records, 4, async (record) => {
      const prepared = prepareRecord({
        entity,
        options: ctx.options,
        source: s,
        target: t,
        record,
        principalMap: ctx.principalMap,
        lookups: ctx.lookupCache,
        targetTableFor: ctx.targetTableFor,
      });
      try {
        const match = await ctx.matcher.match(entity, t, record, prepared, prefetched, columns);
        return { record, prepared, decision: decideAction(entity, ctx.options, t, prepared, match) };
      } catch (err) {
        if (isFatal(err)) throw err;
        return this.failedResult(prepared, toRecordError(err, 'MATCH'));
      }
    });

    // --- record the intent -------------------------------------------------
    // One statement for the whole batch, and only for records that will actually write: a skipped or
    // unchanged record touches nothing, so there is nothing to be uncertain about.
    const writing = planned.filter(
      (p): p is { record: DvRecord; prepared: PreparedRecord; decision: PlannedAction } =>
        'decision' in p && (p.decision.action === 'UPDATE' || p.decision.action === 'CREATE'),
    );
    if (writing.length > 0) {
      await this.persistIntents(
        ctx,
        entity.logicalName,
        writing.map((w) => ({
          sourceId: w.prepared.sourceId,
          operation: w.decision.action === 'UPDATE' ? ('UPDATE' as const) : ('CREATE' as const),
          targetId: w.decision.action === 'UPDATE' ? w.decision.targetId : null,
          evidence: this.evidenceFor(ctx, entity, t, w.prepared, w.decision),
        })),
      );
    }

    // --- act ---------------------------------------------------------------
    return mapLimit(planned, 4, async (p) =>
      'decision' in p ? this.applyDecision(ctx, entity, t, p.prepared, p.decision) : p,
    );
  }

  /**
   * What could identify this record in the target if we lose the answer, decided before the write.
   *
   * Decided now rather than during recovery because the information is here: the match strategy, the
   * keys the target defines, whether this record's key values are complete, and whether the target will
   * take the identifier we supply. After a crash all of that has to be worked out again from the plan,
   * and a record whose evidence was never recorded is a record nobody can reason about.
   */
  private evidenceFor(
    ctx: ExecContext,
    entity: SnapshotEntity,
    t: TableMetadata,
    prepared: PreparedRecord,
    decision: PlannedAction,
  ): ReconciliationEvidence {
    // An update already knows the target record, so the identifier is the evidence.
    if (decision.action === 'UPDATE') return 'RECORDED_TARGET_ID';
    // A create whose identifier the target accepts is findable by that identifier.
    if (ctx.sameProvider && ctx.tConn.capabilities.supportsClientGeneratedIds) return 'PRESERVED_ID';
    if (entity.matchStrategy === 'ALTERNATE_KEY' && entity.alternateKey) {
      const key = t.keys.find((k) => k.logicalName === entity.alternateKey);
      // Only if every column of the key has a value: an incomplete key identifies nothing.
      if (
        key &&
        key.attributes.every((c) => prepared.values[c] !== undefined && prepared.values[c] !== null)
      ) {
        return 'ALTERNATE_KEY';
      }
    }
    if (entity.matchStrategy === 'BUSINESS_KEY' && (entity.businessKeyFields ?? []).length > 0) {
      const fields = entity.businessKeyFields ?? [];
      if (fields.every((c) => prepared.values[c] !== undefined && prepared.values[c] !== null)) {
        return 'BUSINESS_KEY';
      }
    }
    return 'NONE';
  }

  /**
   * Writes the intent rows for a batch, in one statement.
   *
   * Two statements per batch where there was one. The row is created or reset to `INTENDED` so a retry
   * of a previously failed record starts from the same place, and `attempts` is left alone here — it
   * counts what happened, and nothing has happened yet.
   */
  private async persistIntents(
    ctx: ExecContext,
    logicalName: string,
    intents: {
      sourceId: string;
      operation: 'CREATE' | 'UPDATE';
      targetId: string | null;
      evidence: ReconciliationEvidence;
    }[],
  ): Promise<void> {
    const run = ctx.run;
    await this.db
      .insert(migrationRecordMaps)
      .values(
        intents.map((i) => ({
          organizationId: run.organizationId,
          runId: run.id,
          sourceEnvironmentId: run.sourceEnvironmentId,
          targetEnvironmentId: run.targetEnvironmentId,
          logicalName,
          sourceId: i.sourceId.toLowerCase(),
          // An update already has its target; a create does not have one yet.
          targetId: i.targetId,
          outcome: 'UNRESOLVED' as const,
          writeState: 'INTENDED' as const,
          intendedOperation: i.operation,
          reconcileEvidence: i.evidence,
          runAttempt: run.attempt,
        })),
      )
      .onConflictDoUpdate({
        target: [migrationRecordMaps.runId, migrationRecordMaps.logicalName, migrationRecordMaps.sourceId],
        set: {
          outcome: 'UNRESOLVED',
          writeState: 'INTENDED',
          intendedOperation: sql`excluded.intended_operation`,
          reconcileEvidence: sql`excluded.reconcile_evidence`,
          reconcileNote: null,
          runAttempt: run.attempt,
          updatedAt: new Date(),
        },
      });
  }

  private failedResult(prepared: PreparedRecord, error: RecordError): RecordResult {
    return {
      sourceId: prepared.sourceId,
      outcome: 'FAILED',
      targetId: null,
      matchMethod: null,
      deferred: null,
      audit: null,
      fallbacks: prepared.principalFallbacks,
      errors: [...toRecordErrors(prepared), error],
    };
  }

  /** Executes the action the planner decided on. The classification is never recomputed here. */
  private async applyDecision(
    ctx: ExecContext,
    entity: SnapshotEntity,
    t: TableMetadata,
    prepared: PreparedRecord,
    decision: PlannedAction,
  ): Promise<RecordResult> {
    const base: RecordResult = {
      sourceId: prepared.sourceId,
      transformations: {
        applied: prepared.appliedTransformations.flatMap((t) => t.applied),
        lossyFields: prepared.lossyFields,
      },
      outcome: 'FAILED',
      targetId: null,
      matchMethod: null,
      deferred: null,
      audit: null,
      fallbacks: prepared.principalFallbacks,
      errors: toRecordErrors(prepared),
    };
    const deferred = Object.keys(prepared.deferred).length ? prepared.deferred : null;
    const writeOptions: WriteOptions = prepared.impersonateUserId
      ? {
          ...ctx.writeOptions,
          impersonateUserId: prepared.impersonateUserId,
          impersonateObjectId: ctx.principalObjectIds.get(prepared.impersonateUserId) ?? null,
        }
      : ctx.writeOptions;

    switch (decision.action) {
      case 'BLOCKED':
        return {
          ...base,
          errors: base.errors.length
            ? base.errors
            : [
                {
                  operation: 'CREATE',
                  severity: 'ERROR',
                  code: decision.code,
                  message: decision.reason,
                  retryable:
                    decision.code === 'PRINCIPAL_UNRESOLVED' || decision.code === 'LOOKUP_UNRESOLVED',
                },
              ],
        };
      case 'CONFLICT':
        return {
          ...base,
          targetId: decision.targetId ?? null,
          errors: [
            ...base.errors,
            {
              operation: 'MATCH',
              severity: 'ERROR',
              code: decision.code,
              message: decision.reason,
              retryable: false,
            },
          ],
        };
      case 'SKIP':
        return {
          ...base,
          outcome: 'SKIPPED',
          targetId: decision.targetId,
          matchMethod: decision.matchMethod,
        };
      case 'UNCHANGED':
        // Identical in both environments: nothing is sent to Dataverse.
        return {
          ...base,
          outcome: 'UNCHANGED',
          targetId: decision.targetId,
          matchMethod: decision.matchMethod,
        };
      case 'UPDATE':
        try {
          await ctx.tConn.updateRecord(t, decision.targetId, { values: decision.values }, writeOptions);
          return {
            ...base,
            outcome: 'UPDATED',
            writeState: 'CONFIRMED',
            targetId: decision.targetId,
            matchMethod: decision.matchMethod,
            deferred,
            audit: prepared.auditWork,
          };
        } catch (err) {
          if (isFatal(err)) throw err;
          const error = this.writeError(err, 'UPDATE', ctx, prepared);
          /**
           * An update whose outcome is unknown is still safe to repeat.
           *
           * The same values written to the same primary key a second time leave the target exactly as
           * the first attempt did, so an ambiguous update is recorded as a plain failure and retried
           * like any other. A create is not: see below. The asymmetry is the whole reason an
           * interrupted update recovers automatically and an interrupted create may not.
           */
          return { ...base, errors: [...base.errors, error] };
        }
      default:
        try {
          // Within one provider the source identifier is preserved, so references and re-runs
          // stay stable. Across providers a key means nothing in the other system (a SQL
          // integer is not a Dataverse GUID), so the target assigns the key and the identity
          // map records the pair.
          const preserveId = ctx.sameProvider && ctx.tConn.capabilities.supportsClientGeneratedIds;
          const createdId = await ctx.tConn.createRecord(
            t,
            { id: preserveId ? prepared.sourceId : undefined, values: decision.values },
            writeOptions,
          );
          return {
            ...base,
            outcome: 'CREATED',
            writeState: 'CONFIRMED',
            targetId: createdId,
            matchMethod: preserveId ? 'PRESERVED_ID' : 'GENERATED_ID',
            deferred,
            audit: prepared.auditWork,
          };
        } catch (err) {
          if (isFatal(err)) throw err;
          const error = this.writeError(err, 'CREATE', ctx, prepared);
          /**
           * A create whose outcome is unknown is not a failure.
           *
           * A timeout, a dropped connection or a 5xx may all arrive *after* the target committed. Calling
           * that FAILED says two false things — that the record is not in the target, and that
           * re-processing it is safe — and the second one is how a lost response became a duplicate.
           *
           * So an ambiguous create is UNRESOLVED, which nothing retries, and reconciliation decides what
           * it really was by asking the target.
           */
          if (verdictOf(error.code) === 'AMBIGUOUS') {
            return {
              ...base,
              outcome: 'UNRESOLVED',
              writeState: 'UNKNOWN',
              intendedOperation: 'CREATE',
              errors: [...base.errors, error],
            };
          }
          return { ...base, errors: [...base.errors, error] };
        }
    }
  }

  private writeError(
    err: unknown,
    operation: 'CREATE' | 'UPDATE',
    ctx: ExecContext,
    prepared: PreparedRecord,
  ): RecordError {
    const e = toRecordError(err, operation);
    if (e.code.startsWith('FORBIDDEN') && ctx.options.bypassCustomBusinessLogic) {
      e.message = `${e.message} (bypassing custom business logic requires the prvBypassCustomBusinessLogic privilege)`;
    }
    if (e.code.startsWith('FORBIDDEN') && prepared.impersonateUserId) {
      e.message = `${e.message} (preserving "created by" impersonates the mapped user and requires prvActOnBehalfOfAnotherUser, which must be assigned directly and not through a team)`;
    }
    return e;
  }

  // ---------------------------------------------------------------------------
  // Lookup resolution (record identity map)
  // ---------------------------------------------------------------------------

  private cacheKey = (logicalName: string, id: string) => `${logicalName}:${id.toLowerCase()}`;

  private async prefetchLookups(ctx: ExecContext, entity: SnapshotEntity, records: DvRecord[]) {
    const wanted = new Map<string, Set<string>>();
    for (const m of entity.mappings.filter((x) => x.isLookup)) {
      for (const r of records) {
        const v = r.values[m.sourceField];
        if (
          isLookupValue(v) &&
          !m.deferredTargets?.includes(v.logicalName) &&
          !ctx.lookupCache.has(this.cacheKey(v.logicalName, v.id))
        ) {
          if (!wanted.has(v.logicalName)) wanted.set(v.logicalName, new Set());
          wanted.get(v.logicalName)!.add(v.id.toLowerCase());
        }
      }
    }
    for (const [logicalName, ids] of wanted) await this.resolveIds(ctx, logicalName, [...ids]);
  }

  /**
   * Resolves source record ids of one table to target ids, filling the lookup cache:
   *  1) identity map of this run (authoritative),
   *  2) identity maps of earlier runs for the same environment pair (verified in the target,
   *     because those records may have been deleted since),
   *  3) records that already exist in the target with the same identifier.
   * Unresolved ids are not cached: they may be created later in the run.
   */
  private async resolveIds(ctx: ExecContext, logicalName: string, ids: string[]) {
    if (ids.length === 0) return;
    const maps = await this.db
      .select({
        sourceId: migrationRecordMaps.sourceId,
        targetId: migrationRecordMaps.targetId,
        runId: migrationRecordMaps.runId,
      })
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.organizationId, ctx.run.organizationId),
          eq(migrationRecordMaps.sourceEnvironmentId, ctx.run.sourceEnvironmentId),
          eq(migrationRecordMaps.targetEnvironmentId, ctx.run.targetEnvironmentId),
          eq(migrationRecordMaps.logicalName, logicalName),
          inArray(migrationRecordMaps.sourceId, ids),
          ne(migrationRecordMaps.outcome, 'FAILED'),
          isNotNull(migrationRecordMaps.targetId),
        ),
      )
      .orderBy(desc(migrationRecordMaps.updatedAt));
    const tTable = ctx.targetMeta.get(ctx.targetTableFor.get(logicalName) ?? logicalName);
    const earlier = new Map<string, string>();
    for (const m of maps) {
      const k = this.cacheKey(logicalName, m.sourceId);
      if (m.runId === ctx.run.id) ctx.lookupCache.set(k, m.targetId);
      else if (!earlier.has(m.sourceId)) earlier.set(m.sourceId, m.targetId!);
    }
    if (!tTable) return;
    const toVerify = [...earlier.entries()].filter(
      ([sid]) => !ctx.lookupCache.get(this.cacheKey(logicalName, sid)),
    );
    if (toVerify.length) {
      const found = new Set(
        (
          await ctx.tConn.retrieveByIds(
            tTable,
            toVerify.map(([, tid]) => tid),
            [],
          )
        ).map((f) => f.id.toLowerCase()),
      );
      for (const [sid, tid] of toVerify)
        if (found.has(tid.toLowerCase())) ctx.lookupCache.set(this.cacheKey(logicalName, sid), tid);
    }
    const unresolved = ids.filter((id) => !ctx.lookupCache.get(this.cacheKey(logicalName, id)));
    // Falling back to "the same id already exists in the target" is only meaningful within one
    // provider; a SQL integer key is not a Dataverse GUID.
    if (unresolved.length && ctx.sameProvider) {
      const found = new Set(
        (await ctx.tConn.retrieveByIds(tTable, unresolved, [])).map((f) => f.id.toLowerCase()),
      );
      for (const id of unresolved) if (found.has(id)) ctx.lookupCache.set(this.cacheKey(logicalName, id), id);
    }
  }

  private async resolveLookup(ctx: ExecContext, value: LookupValue): Promise<string | null> {
    const k = this.cacheKey(value.logicalName, value.id);
    if (!ctx.lookupCache.get(k)) await this.resolveIds(ctx, value.logicalName, [value.id.toLowerCase()]);
    return ctx.lookupCache.get(k) ?? null;
  }

  // ---------------------------------------------------------------------------
  // PASS 2
  // ---------------------------------------------------------------------------

  /**
   * Walks the record maps a second pass still has work for, a page at a time.
   *
   * Both second passes used to select every pending row for a table into an array and then batch
   * over it. The primary read path has always been paged; these two were not, so a table with
   * millions of deferred lookups would hold every one of their identity rows in memory at once —
   * at exactly the size where somebody needs this to work.
   *
   * Keyed on `sourceId`, which is unique per run and table, rather than on the status column the
   * pass is about to change. A status cursor would re-select a row it had just marked FAILED and
   * never finish; a keyset always moves forward, which also makes the continuation deterministic
   * and the pass safe to resume after a cancel.
   */
  private async *pendingMapPages(
    where: SQL,
    pageSize: number,
  ): AsyncGenerator<(typeof migrationRecordMaps.$inferSelect)[]> {
    const size = Math.max(1, Math.min(pageSize, 1000));
    let cursor: string | null = null;
    for (;;) {
      const page: (typeof migrationRecordMaps.$inferSelect)[] = await this.db
        .select()
        .from(migrationRecordMaps)
        .where(cursor === null ? where : and(where, gt(migrationRecordMaps.sourceId, cursor)))
        .orderBy(asc(migrationRecordMaps.sourceId))
        .limit(size);
      if (page.length === 0) return;
      yield page;
      cursor = page[page.length - 1]!.sourceId;
      if (page.length < size) return;
    }
  }

  private async resolveDeferred(ctx: ExecContext, entity: SnapshotEntity) {
    const { run } = ctx;
    const t = ctx.targetMeta.get(entity.targetLogicalName);
    if (!t) return;
    const where = and(
      eq(migrationRecordMaps.runId, run.id),
      eq(migrationRecordMaps.logicalName, entity.logicalName),
      /*
       * A later pass, or a later attempt, retries everything that is not settled. `INCOMPLETE` belongs
       * here: the reference was omitted because the referenced record was not in the target yet, and the
       * whole point of adding that table and running again is that this time it is.
       */
      inArray(migrationRecordMaps.deferredStatus, ['PENDING', 'INCOMPLETE', 'FAILED']),
      isNotNull(migrationRecordMaps.targetId),
    )!;
    const tAttrs = new Map(t.attributes.map((a) => [a.logicalName, a]));
    let announced = false;
    for await (const batch of this.pendingMapPages(where, ctx.options.batchSize)) {
      if (!announced) {
        announced = true;
        await this.db
          .update(migrationRuns)
          .set({ currentEntity: entity.logicalName })
          .where(eq(migrationRuns.id, run.id));
      }
      await this.checkControl(run.id);
      await mapLimit(batch, 4, async (map) => {
        const values: Record<string, FieldValue> = {};
        const errors: RecordError[] = [];
        const deferredLookups: Record<string, LookupValue> = map.deferredLookups ?? {};
        for (const [attr, lookup] of Object.entries(deferredLookups)) {
          const resolved = await this.resolveLookup(ctx, lookup);
          const tAttr: AttributeMeta | undefined = tAttrs.get(attr);
          if (resolved) {
            values[attr] = {
              id: resolved,
              logicalName: ctx.targetTableFor.get(lookup.logicalName) ?? lookup.logicalName,
            };
          } else {
            errors.push({
              operation: 'DEFERRED_UPDATE',
              severity:
                tAttr?.requiredLevel === 'None' || tAttr?.requiredLevel === 'Recommended'
                  ? 'WARNING'
                  : 'ERROR',
              code: 'LOOKUP_UNRESOLVED',
              field: attr,
              message: `Deferred lookup ${attr} references ${lookup.logicalName} ${lookup.id}, which could not be resolved in the target`,
              retryable: true,
            });
          }
        }
        let status = deferredOutcome(errors);
        if (Object.keys(values).length) {
          try {
            await ctx.tConn.updateRecord(t, map.targetId!, { values }, ctx.writeOptions);
          } catch (err) {
            if (isFatal(err)) throw err;
            errors.push(toRecordError(err, 'DEFERRED_UPDATE'));
            status = 'FAILED';
          }
        }
        await this.db
          .update(migrationRecordMaps)
          .set({ deferredStatus: status, updatedAt: new Date() })
          .where(eq(migrationRecordMaps.id, map.id));
        if (errors.length) await this.persistErrors(run.id, entity.logicalName, map.sourceId, errors);
        // Only a genuinely resolved record clears its earlier errors. An incomplete one has not settled
        // anything, and marking its rows resolved would erase the evidence that the reference is missing.
        if (status === 'RESOLVED') {
          await this.db
            .update(migrationErrors)
            .set({ resolved: true })
            .where(
              and(
                eq(migrationErrors.runId, run.id),
                eq(migrationErrors.logicalName, entity.logicalName),
                eq(migrationErrors.sourceRecordId, map.sourceId),
                eq(migrationErrors.operation, 'DEFERRED_UPDATE'),
                eq(migrationErrors.severity, 'ERROR'),
              ),
            );
        }
      });
      await this.refreshDeferredCounters(run.id, entity.logicalName);
      await ctx.heartbeat();
    }
  }

  /**
   * PASS 3: re-stamp "modified by". Dataverse never lets a client write modifiedby directly, so
   * the record is updated once more while impersonating the mapped source user. modifiedon always
   * becomes the migration time; that cannot be preserved by any supported API.
   */
  private async stampModifiedBy(ctx: ExecContext, entity: SnapshotEntity) {
    const { run } = ctx;
    const t = ctx.targetMeta.get(entity.targetLogicalName);
    if (!t) return;
    const where = and(
      eq(migrationRecordMaps.runId, run.id),
      eq(migrationRecordMaps.logicalName, entity.logicalName),
      eq(migrationRecordMaps.auditStatus, 'PENDING'),
      isNotNull(migrationRecordMaps.targetId),
    )!;
    let announced = false;
    for await (const batch of this.pendingMapPages(where, ctx.options.batchSize)) {
      if (!announced) {
        announced = true;
        await this.db
          .update(migrationRuns)
          .set({ currentEntity: entity.logicalName })
          .where(eq(migrationRuns.id, run.id));
      }
      await this.checkControl(run.id);
      await mapLimit(batch, 4, async (map) => {
        const work = map.auditPending;
        if (!work) return;
        try {
          await ctx.tConn.updateRecord(
            t,
            map.targetId!,
            { values: { [work.field]: work.value as FieldValue } },
            {
              ...ctx.writeOptions,
              impersonateUserId: work.modifiedById,
              impersonateObjectId: ctx.principalObjectIds.get(work.modifiedById) ?? null,
            },
          );
          await this.db
            .update(migrationRecordMaps)
            .set({ auditStatus: 'DONE', updatedAt: new Date() })
            .where(eq(migrationRecordMaps.id, map.id));
        } catch (err) {
          if (isFatal(err)) throw err;
          const e = toRecordError(err, 'AUDIT_UPDATE');
          e.severity = 'WARNING';
          e.message = `Could not set "modified by" to the mapped source user: ${e.message}`;
          await this.db
            .update(migrationRecordMaps)
            .set({ auditStatus: 'FAILED', updatedAt: new Date() })
            .where(eq(migrationRecordMaps.id, map.id));
          await this.persistErrors(run.id, entity.logicalName, map.sourceId, [e]);
        }
      });
      await ctx.heartbeat();
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Folds a batch's transformations into the run's aggregate metrics. Counting here rather than
   * storing a row per transformed value keeps a large run's audit proportionate: the totals are
   * aggregate, while warnings, failures and lossy conversions are also kept per record.
   */
  private countTransformations(ctx: ExecContext, results: RecordResult[]) {
    const m = ctx.metrics;
    for (const result of results) {
      const applied = result.transformations?.applied ?? [];
      if (result.outcome === 'FAILED') m.failures++;
      if (applied.length === 0) continue;
      m.recordsTransformed++;
      m.valuesTransformed += applied.length;
      m.lossyValues += applied.filter((a) => a.lossy).length;
      for (const step of applied) {
        m.byKind[step.kind] = (m.byKind[step.kind] ?? 0) + 1;
        if (step.kind === 'DEFAULT_IF_NULL' || step.kind === 'DEFAULT_IF_BLANK') m.defaultsApplied++;
        if (step.kind === 'EMPTY_TO_NULL' || step.kind === 'NULL_TO_EMPTY') m.nullConversions++;
        if (step.kind === 'VALUE_MAP' || step.kind === 'TO_BOOLEAN') m.valueMappings++;
      }
    }
  }

  private async persistResults(run: RunRow, logicalName: string, results: RecordResult[]) {
    for (const r of results) {
      await this.db
        .insert(migrationRecordMaps)
        .values({
          organizationId: run.organizationId,
          runId: run.id,
          sourceEnvironmentId: run.sourceEnvironmentId,
          targetEnvironmentId: run.targetEnvironmentId,
          logicalName,
          sourceId: r.sourceId.toLowerCase(),
          targetId: r.targetId,
          outcome: r.outcome,
          // The intent row said INTENDED; this replaces it with what actually happened. A record whose
          // answer was lost keeps an unresolved state here rather than being written off as failed.
          writeState: r.writeState ?? null,
          intendedOperation: r.intendedOperation ?? null,
          matchMethod: r.matchMethod,
          deferredLookups: r.deferred,
          deferredStatus: r.deferred ? 'PENDING' : null,
          principalFallbacks: r.fallbacks.length ? r.fallbacks : null,
          auditPending: r.audit,
          auditStatus: r.audit ? 'PENDING' : null,
          runAttempt: run.attempt,
        })
        .onConflictDoUpdate({
          target: [migrationRecordMaps.runId, migrationRecordMaps.logicalName, migrationRecordMaps.sourceId],
          set: {
            targetId: r.targetId,
            outcome: r.outcome,
            writeState: r.writeState ?? null,
            intendedOperation: r.intendedOperation ?? null,
            matchMethod: r.matchMethod,
            deferredLookups: r.deferred,
            deferredStatus: r.deferred ? 'PENDING' : null,
            principalFallbacks: r.fallbacks.length ? r.fallbacks : null,
            auditPending: r.audit,
            auditStatus: r.audit ? 'PENDING' : null,
            attempts: sql`${migrationRecordMaps.attempts} + 1`,
            // The attempt that last touched it, which is the one now answerable for its state.
            runAttempt: run.attempt,
            updatedAt: new Date(),
          },
        });
      if (r.outcome !== 'FAILED') {
        // A successful retry resolves earlier errors for this record.
        await this.db
          .update(migrationErrors)
          .set({ resolved: true })
          .where(
            and(
              eq(migrationErrors.runId, run.id),
              eq(migrationErrors.logicalName, logicalName),
              eq(migrationErrors.sourceRecordId, r.sourceId),
              eq(migrationErrors.severity, 'ERROR'),
              ne(migrationErrors.operation, 'DEFERRED_UPDATE'),
            ),
          );
      }
      // Warnings computed for records that were skipped (not written) are not actionable.
      const errors = r.outcome === 'SKIPPED' ? r.errors.filter((e) => e.severity === 'ERROR') : r.errors;
      if (errors.length) await this.persistErrors(run.id, logicalName, r.sourceId, errors);
    }
  }

  private async persistErrors(
    runId: string,
    logicalName: string,
    sourceRecordId: string | null,
    errors: RecordError[],
  ) {
    if (!errors.length) return;
    await this.db.insert(migrationErrors).values(
      errors.map((e) => ({
        runId,
        logicalName,
        sourceRecordId,
        operation: e.operation,
        severity: e.severity,
        errorCode: e.code,
        message: e.message.slice(0, 2000),
        field: e.field ?? null,
        retryable: e.retryable,
        httpStatus: e.httpStatus ?? null,
        attempts: e.attempts ?? 1,
      })),
    );
  }

  private async refreshDeferredCounters(runId: string, logicalName: string) {
    const rows = await this.db
      .select({ status: migrationRecordMaps.deferredStatus, n: sql<number>`count(*)` })
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.runId, runId),
          eq(migrationRecordMaps.logicalName, logicalName),
          isNotNull(migrationRecordMaps.deferredStatus),
        ),
      )
      .groupBy(migrationRecordMaps.deferredStatus);
    const get = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    await this.db
      .update(migrationRunEntities)
      .set({
        deferredPending: get('PENDING'),
        deferredResolved: get('RESOLVED'),
        deferredFailed: get('FAILED'),
        deferredIncomplete: get('INCOMPLETE'),
      })
      .where(and(eq(migrationRunEntities.runId, runId), eq(migrationRunEntities.logicalName, logicalName)));
  }

  /** Recomputes counters from the identity map (source of truth; safe across retries). */
  /**
   * Rebuilds this run's counters from the identity map.
   *
   * The derivation lives in `run-counters.ts` because reconciliation changes outcomes too, and two
   * copies of "what the counters mean" is how two screens come to disagree.
   */
  async refreshCounters(runId: string, runEntityId?: string) {
    await refreshRunCounters(this.db, runId, runEntityId);
    const entityRows = await this.db
      .select({ logicalName: migrationRunEntities.logicalName })
      .from(migrationRunEntities)
      .where(eq(migrationRunEntities.runId, runId));
    for (const e of entityRows) await this.refreshDeferredCounters(runId, e.logicalName);
    void SUCCESS_OUTCOMES;
  }
}

/**
 * Tracks the highest watermark value a run has read.
 *
 * Deliberately a maximum over everything seen rather than "the last record's value": records arrive
 * in primary-key order, not watermark order, so the last one read is not the newest one.
 */
/**
 * Whether a finished run carried everything it was asked to.
 *
 * Extracted and exported because it was wrong, and wrong in the way that matters most: it counted
 * only failed *records*. A whole table can fail without one — the table is missing in the source or
 * target, or the source read itself fails. Those paths mark the table FAILED and write an error but
 * produce no failed record, so a run that lost an entire table was stamped COMPLETED, the plan was
 * marked EXECUTED and the audit trail recorded success. Every signal now feeds one decision, in one
 * place that can be tested on its own.
 */
export function runHadErrors(counts: {
  failedRecords: number;
  deferredFailed: number;
  failedTables: number;
  unresolvedErrors: number;
  /** Records whose write outcome is unknown. A run with any of these is not finished. */
  unresolvedWrites?: number;
}): boolean {
  return (
    counts.failedRecords > 0 ||
    counts.deferredFailed > 0 ||
    counts.failedTables > 0 ||
    counts.unresolvedErrors > 0 ||
    (counts.unresolvedWrites ?? 0) > 0
  );
}

/**
 * The safety invariant, as one function the whole engine defers to.
 *
 * > A run may not be called complete while the outcome of any write is unknown.
 *
 * Not a style rule. A `COMPLETED` run is what every downstream claim rests on — the plan is marked
 * executed, the schedule advances its watermark, validation compares against the counts, the evidence
 * package is generated. Allowing one record whose fate nobody knows to pass through here is what would
 * turn a lost response into a report that says the migration worked.
 */
export function canCompleteRun(counts: { unresolvedWrites: number }): boolean {
  return counts.unresolvedWrites === 0;
}

/**
 * What the second pass achieved for one record.
 *
 * `RESOLVED` used to be the answer for anything the target did not refuse, which made a record whose
 * optional reference was dropped indistinguishable from one that carried everything across. Both counted
 * as resolved, the run saw no failure, and the result read `Completed`.
 *
 * The target's own metadata decides the severity before this is called: a required reference that cannot
 * be set is an `ERROR`, an optional one is a `WARNING`. This turns that into what happened to the record.
 *
 * Exported for its own sake. The three states are the difference between a migration that carried the
 * data and one that did not, and that belongs in a test rather than inside a closure.
 */
export function deferredOutcome(
  errors: readonly { severity: 'ERROR' | 'WARNING' }[],
): 'RESOLVED' | 'INCOMPLETE' | 'FAILED' {
  // A required reference is missing, or the target refused the update. The record is not valid.
  if (errors.some((e) => e.severity === 'ERROR')) return 'FAILED';
  // The write succeeded and something the source record had is not on the target record.
  if (errors.length > 0) return 'INCOMPLETE';
  return 'RESOLVED';
}

/**
 * The whole outcome model, as one function.
 *
 * Every question about how a run went is answered here, from counts the engine recorded while it ran, and
 * the order of the checks is the order of how bad the news is. It lives in one place because the thing it
 * decides is the sentence the product puts in front of somebody who is about to sign a migration off, and
 * a second copy of this reasoning somewhere else is how a screen comes to claim a better result than the
 * evidence supports.
 *
 * The rule, which `docs/MIGRATION_OUTCOME_SEMANTICS.md` sets out in full:
 *
 * > A run reports the worst outcome its own recorded evidence supports.
 *
 * `failedRecords === 0` is one input to that and has never been enough on its own. A run can write every
 * record it was given, receive a success from the target for each one, and still have dropped a reference
 * from every single one of them.
 */
export function decideRunStatus(counts: {
  failedRecords: number;
  deferredFailed: number;
  failedTables: number;
  unresolvedErrors: number;
  unresolvedWrites: number;
  /** Records written with a reference omitted. Not a failure: the record is there and is valid. */
  deferredIncomplete: number;
  /** Recorded warnings whose meaning is that the target's data differs. See `MATERIAL_WARNING_CODES`. */
  materialWarnings: number;
}): 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'COMPLETED_WITH_ERRORS' | 'NEEDS_RECONCILIATION' {
  // Nothing may be claimed at all while the outcome of a write is unknown. This outranks everything.
  if (!canCompleteRun({ unresolvedWrites: counts.unresolvedWrites })) return 'NEEDS_RECONCILIATION';
  if (runHadErrors(counts)) return 'COMPLETED_WITH_ERRORS';
  // Every write succeeded. Whether the data arrived intact is a separate question.
  if (counts.deferredIncomplete > 0 || counts.materialWarnings > 0) return 'COMPLETED_WITH_WARNINGS';
  return 'COMPLETED';
}

export function observeWatermark(into: { value: string | null }, page: DvRecord[], field: string): void {
  for (const record of page) {
    const raw = record.values[field];
    // A watermark column holds a timestamp or a number. Anything else — a lookup, an array — is not
    // one, and comparing it would invent an ordering the source does not have.
    if (raw === null || raw === undefined || typeof raw === 'object' || typeof raw === 'boolean') continue;
    const text = String(raw);
    if (into.value === null || newerThanWatermark(text, into.value)) into.value = text;
  }
}

interface ExecContext {
  run: RunRow;
  log: Logger;
  sConn: DataverseConnection;
  tConn: DataverseConnection;
  options: PlanOptions;
  writeOptions: WriteOptions;
  sourceMeta: Map<string, TableMetadata>;
  targetMeta: Map<string, TableMetadata>;
  /** Source table name -> target table name, from the plan's object mapping. */
  targetTableFor: ReadonlyMap<string, string>;
  /** True when both connections are the same kind of system, so record ids are comparable. */
  sameProvider: boolean;
  /** Aggregate record of what the transformation engine did, written when the run finishes. */
  metrics: TransformationMetricsDto;
  /**
   * For an incremental run: the column to compare and the value to read past. Null for a full run,
   * and also for the first run of an incremental schedule, which has nothing to read past yet.
   */
  incremental: { field: string; since: string | null } | null;
  /**
   * The highest watermark value seen while reading. Written to the run when it finishes, and only
   * then: a run that fails must not advance the watermark, or the records it never processed would
   * be skipped forever.
   */
  watermark: { value: string | null };
  heartbeat: () => Promise<void>;
  /** sourceLogicalName:sourceId -> targetId (null = known missing). */
  lookupCache: Map<string, string | null>;
  /** `${logicalName}:${sourceId}` -> target id for users, teams and business units. */
  principalMap: ReadonlyMap<string, string>;
  /** Target systemuser id -> Entra object id, for the preferred impersonation header. */
  principalObjectIds: ReadonlyMap<string, string>;
  matcher: RecordMatcher;
}
