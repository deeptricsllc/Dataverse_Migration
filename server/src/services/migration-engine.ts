import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  DEFAULT_PLAN_OPTIONS,
  auditFlags,
  type PlanOptions,
  type RecordOperation,
} from '../../../shared/domain';
import {
  isLookupValue,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
  type LookupValue,
  type TableMetadata,
} from '../../../shared/metadata';
import type { AppDb } from '../db/client';
import {
  migrationErrors,
  migrationPlans,
  migrationRecordMaps,
  migrationRunEntities,
  migrationRuns,
} from '../db/schema';
import { DataverseError, toDataverseError } from '../dataverse/errors';
import type { ConnectionFactory } from '../dataverse/factory';
import type { DataverseConnection, WriteOptions } from '../dataverse/types';
import { AppError, errorMessage } from '../lib/errors';
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
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED';
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
export class MigrationEngine {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

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
      const sConn = await this.connections.connectorFor(source, run.executedByUserId, {
        migrationRunId: runId,
      });
      const tConn = await this.connections.connectorFor(target, run.executedByUserId, {
        migrationRunId: runId,
      });
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
      const withErrors = final.failed > 0 || Number(deferredFailed?.n ?? 0) > 0;
      const status = withErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
      await this.db
        .update(migrationRuns)
        .set({ status, phase: 'DONE', currentEntity: null, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(migrationRuns.id, runId));
      await this.db
        .update(migrationPlans)
        .set({ status: 'EXECUTED' })
        .where(eq(migrationPlans.id, run.planId));
      this.metadata.invalidateCounts(target.id);
      await this.audit.record({
        organizationId: run.organizationId,
        userId: run.executedByUserId,
        action: 'MIGRATION_COMPLETED',
        outcome: withErrors ? 'FAILURE' : 'SUCCESS',
        sourceEnvironmentId: run.sourceEnvironmentId,
        targetEnvironmentId: run.targetEnvironmentId,
        runId,
        details: {
          status,
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
      await this.db
        .update(migrationRuns)
        .set({
          status: 'FAILED',
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

    const existingMaps = new Map(
      (
        await this.db
          .select({ sourceId: migrationRecordMaps.sourceId, outcome: migrationRecordMaps.outcome })
          .from(migrationRecordMaps)
          .where(
            and(
              eq(migrationRecordMaps.runId, run.id),
              eq(migrationRecordMaps.logicalName, entity.logicalName),
            ),
          )
      ).map((m) => [m.sourceId, m.outcome]),
    );

    const sourceColumns = [
      ...entity.mappings.map((m) => m.sourceField),
      ...auditSourceColumns(ctx.options, entity),
    ];
    const pageSize = Math.max(1, Math.min(ctx.options.batchSize, 500));
    try {
      for await (const page of ctx.sConn.queryRecords(s, sourceColumns, { pageSize })) {
        await this.checkControl(run.id);
        const pending = page.filter((r) => {
          const outcome = existingMaps.get(r.id);
          return !outcome || outcome === 'FAILED';
        });
        if (pending.length === 0) continue;
        const results = await this.processBatch(ctx, entity, s, t, pending);
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
    // The planner runs per record (pure); writes stay bounded by the connection semaphore.
    return mapLimit(records, 4, async (record) => {
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
      let decision: PlannedAction;
      try {
        const match = await ctx.matcher.match(entity, t, record, prepared, prefetched, columns);
        decision = decideAction(entity, ctx.options, t, prepared, match);
      } catch (err) {
        if (isFatal(err)) throw err;
        return this.failedResult(prepared, toRecordError(err, 'MATCH'));
      }
      return this.applyDecision(ctx, entity, t, prepared, decision);
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
            targetId: decision.targetId,
            matchMethod: decision.matchMethod,
            deferred,
            audit: prepared.auditWork,
          };
        } catch (err) {
          if (isFatal(err)) throw err;
          return { ...base, errors: [...base.errors, this.writeError(err, 'UPDATE', ctx, prepared)] };
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
            targetId: createdId,
            matchMethod: preserveId ? 'PRESERVED_ID' : 'GENERATED_ID',
            deferred,
            audit: prepared.auditWork,
          };
        } catch (err) {
          if (isFatal(err)) throw err;
          return { ...base, errors: [...base.errors, this.writeError(err, 'CREATE', ctx, prepared)] };
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

  private async resolveDeferred(ctx: ExecContext, entity: SnapshotEntity) {
    const { run } = ctx;
    const t = ctx.targetMeta.get(entity.targetLogicalName);
    if (!t) return;
    const pending = await this.db
      .select()
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.runId, run.id),
          eq(migrationRecordMaps.logicalName, entity.logicalName),
          inArray(migrationRecordMaps.deferredStatus, ['PENDING', 'FAILED']),
          isNotNull(migrationRecordMaps.targetId),
        ),
      );
    if (pending.length === 0) return;
    await this.db
      .update(migrationRuns)
      .set({ currentEntity: entity.logicalName })
      .where(eq(migrationRuns.id, run.id));
    const tAttrs = new Map(t.attributes.map((a) => [a.logicalName, a]));
    for (let i = 0; i < pending.length; i += ctx.options.batchSize) {
      await this.checkControl(run.id);
      const batch = pending.slice(i, i + ctx.options.batchSize);
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
        let status: 'RESOLVED' | 'FAILED' = errors.some((e) => e.severity === 'ERROR')
          ? 'FAILED'
          : 'RESOLVED';
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
    const pending = await this.db
      .select()
      .from(migrationRecordMaps)
      .where(
        and(
          eq(migrationRecordMaps.runId, run.id),
          eq(migrationRecordMaps.logicalName, entity.logicalName),
          eq(migrationRecordMaps.auditStatus, 'PENDING'),
          isNotNull(migrationRecordMaps.targetId),
        ),
      );
    if (pending.length === 0) return;
    await this.db
      .update(migrationRuns)
      .set({ currentEntity: entity.logicalName })
      .where(eq(migrationRuns.id, run.id));
    for (let i = 0; i < pending.length; i += ctx.options.batchSize) {
      await this.checkControl(run.id);
      const batch = pending.slice(i, i + ctx.options.batchSize);
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
          matchMethod: r.matchMethod,
          deferredLookups: r.deferred,
          deferredStatus: r.deferred ? 'PENDING' : null,
          principalFallbacks: r.fallbacks.length ? r.fallbacks : null,
          auditPending: r.audit,
          auditStatus: r.audit ? 'PENDING' : null,
        })
        .onConflictDoUpdate({
          target: [migrationRecordMaps.runId, migrationRecordMaps.logicalName, migrationRecordMaps.sourceId],
          set: {
            targetId: r.targetId,
            outcome: r.outcome,
            matchMethod: r.matchMethod,
            deferredLookups: r.deferred,
            deferredStatus: r.deferred ? 'PENDING' : null,
            principalFallbacks: r.fallbacks.length ? r.fallbacks : null,
            auditPending: r.audit,
            auditStatus: r.audit ? 'PENDING' : null,
            attempts: sql`${migrationRecordMaps.attempts} + 1`,
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
      })
      .where(and(eq(migrationRunEntities.runId, runId), eq(migrationRunEntities.logicalName, logicalName)));
  }

  /** Recomputes counters from the identity map (source of truth; safe across retries). */
  async refreshCounters(runId: string, runEntityId?: string) {
    const entityRows = await this.db
      .select()
      .from(migrationRunEntities)
      .where(eq(migrationRunEntities.runId, runId));
    const grouped = await this.db
      .select({
        logicalName: migrationRecordMaps.logicalName,
        outcome: migrationRecordMaps.outcome,
        n: sql<number>`count(*)`,
      })
      .from(migrationRecordMaps)
      .where(eq(migrationRecordMaps.runId, runId))
      .groupBy(migrationRecordMaps.logicalName, migrationRecordMaps.outcome);
    const totals = { total: 0, processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    for (const e of entityRows) {
      const get = (o: string) =>
        Number(grouped.find((g) => g.logicalName === e.logicalName && g.outcome === o)?.n ?? 0);
      const c = {
        created: get('CREATED'),
        updated: get('UPDATED'),
        unchanged: get('UNCHANGED'),
        skipped: get('SKIPPED'),
        failed: get('FAILED'),
      };
      const processed = c.created + c.updated + c.unchanged + c.skipped + c.failed;
      if (!runEntityId || runEntityId === e.id) {
        await this.db
          .update(migrationRunEntities)
          .set({ ...c, processed })
          .where(eq(migrationRunEntities.id, e.id));
      }
      totals.total += Math.max(e.total, processed);
      totals.processed += processed;
      totals.created += c.created;
      totals.updated += c.updated;
      totals.unchanged += c.unchanged;
      totals.skipped += c.skipped;
      totals.failed += c.failed;
    }
    await this.db
      .update(migrationRuns)
      .set({ ...totals, updatedAt: new Date() })
      .where(eq(migrationRuns.id, runId));
    for (const e of entityRows) await this.refreshDeferredCounters(runId, e.logicalName);
    void SUCCESS_OUTCOMES;
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
  heartbeat: () => Promise<void>;
  /** sourceLogicalName:sourceId -> targetId (null = known missing). */
  lookupCache: Map<string, string | null>;
  /** `${logicalName}:${sourceId}` -> target id for users, teams and business units. */
  principalMap: ReadonlyMap<string, string>;
  /** Target systemuser id -> Entra object id, for the preferred impersonation header. */
  principalObjectIds: ReadonlyMap<string, string>;
  matcher: RecordMatcher;
}
