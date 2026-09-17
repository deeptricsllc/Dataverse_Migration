import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { DEFAULT_PLAN_OPTIONS, type PlanOptions, type RecordOperation } from '../../../shared/domain';
import {
  LOOKUP_TYPES,
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
import { transformValue, valuesEqual } from './values';

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
  errors: RecordError[];
}

class RunInterrupted extends Error {
  constructor(public readonly reason: 'CANCELLED' | 'PAUSED') {
    super(reason);
  }
}

class FatalRunError extends Error {}

const SUCCESS_OUTCOMES = ['CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED'] as const;

/** Target columns to read for SYNC comparison (empty for every other strategy). */
function syncCompareColumns(options: PlanOptions, entity: SnapshotEntity): string[] {
  if (options.conflictStrategy !== 'SYNC') return [];
  const columns = entity.mappings.map((m) => m.targetField);
  if (options.preserveOwnership && entity.audit.ownerField) columns.push(entity.audit.ownerField);
  return [...new Set(columns)];
}

/** Source audit columns to read when ownership / audit preservation is enabled. */
function auditSourceColumns(options: PlanOptions, entity: SnapshotEntity): string[] {
  const a = entity.audit;
  const columns: (string | null)[] = [
    options.preserveOwnership ? a.ownerField : null,
    options.preserveCreatedOn ? a.createdOnField : null,
    options.preserveCreatedBy ? a.createdByField : null,
    options.preserveModifiedBy ? a.modifiedByField : null,
  ];
  return columns.filter((c): c is string => Boolean(c));
}

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
      const sConn = this.connections.forEnvironment(source, run.executedByUserId, { migrationRunId: runId });
      const tConn = this.connections.forEnvironment(target, run.executedByUserId, { migrationRunId: runId });
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
      const referenced = new Set<string>(names);
      for (const e of entities) {
        const s = sourceMeta.get(e.logicalName);
        for (const m of e.mappings.filter((x) => x.isLookup)) {
          for (const t of s?.attributes.find((a) => a.logicalName === m.sourceField)?.targets ?? [])
            referenced.add(t);
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
        heartbeat,
        lookupCache: new Map(principalMap),
        principalMap,
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

      if (options.preserveModifiedBy) {
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
    const t = ctx.targetMeta.get(entity.logicalName);
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
          message: `Table ${entity.logicalName} is not available in the ${!s ? 'source' : 'target'} environment`,
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
    // Batch-resolve lookups and existing target records before per-record writes.
    await this.prefetchLookups(ctx, entity, records);
    const existingById = new Set<string>();
    const existingTargetRecords = new Map<string, DvRecord>();
    // SYNC compares against the current target values, so read every column the run may write:
    // the mapped ones plus the ownership column when ownership is preserved.
    const compareColumns = syncCompareColumns(ctx.options, entity);
    if (entity.matchStrategy === 'PRIMARY_ID') {
      const found = await ctx.tConn.retrieveByIds(
        t,
        records.map((r) => r.id),
        compareColumns,
      );
      for (const f of found) {
        existingById.add(f.id.toLowerCase());
        existingTargetRecords.set(f.id.toLowerCase(), f);
      }
    }
    return mapLimit(records, 4, async (record) => {
      const result = await this.processRecord(ctx, entity, s, t, record, existingById, existingTargetRecords);
      // Alternate-key matches are resolved per record; fetch the match for SYNC comparison.
      return result;
    });
  }

  private async processRecord(
    ctx: ExecContext,
    entity: SnapshotEntity,
    s: TableMetadata,
    t: TableMetadata,
    record: DvRecord,
    existingById: Set<string>,
    existingTargetRecords: Map<string, DvRecord>,
  ): Promise<RecordResult> {
    const result: RecordResult = {
      sourceId: record.id,
      outcome: 'FAILED',
      targetId: null,
      matchMethod: null,
      deferred: null,
      audit: null,
      errors: [],
    };
    const sAttrs = new Map(s.attributes.map((a) => [a.logicalName, a]));
    const tAttrs = new Map(t.attributes.map((a) => [a.logicalName, a]));
    const values: Record<string, FieldValue> = {};
    const deferred: Record<string, LookupValue> = {};

    for (const m of entity.mappings) {
      const sAttr = sAttrs.get(m.sourceField);
      const tAttr = tAttrs.get(m.targetField);
      if (!sAttr || !tAttr) {
        result.errors.push({
          operation: 'CREATE',
          severity: 'ERROR',
          code: 'MAPPING_INVALID',
          field: m.sourceField,
          message: `Mapped column ${m.sourceField} → ${m.targetField} no longer exists`,
          retryable: false,
        });
        return result;
      }
      const raw = record.values[m.sourceField];
      if (LOOKUP_TYPES.has(tAttr.type)) {
        if (raw === null || raw === undefined) {
          values[tAttr.logicalName] = null;
          continue;
        }
        if (!isLookupValue(raw)) continue;
        if (m.deferredTargets?.includes(raw.logicalName)) {
          deferred[tAttr.logicalName] = raw;
          continue;
        }
        const resolved = await this.resolveLookup(ctx, raw);
        if (resolved) {
          values[tAttr.logicalName] = { id: resolved, logicalName: raw.logicalName };
        } else if (
          tAttr.requiredLevel === 'SystemRequired' ||
          tAttr.requiredLevel === 'ApplicationRequired'
        ) {
          result.errors.push({
            operation: 'RESOLVE_LOOKUP',
            severity: 'ERROR',
            code: 'LOOKUP_UNRESOLVED',
            field: m.sourceField,
            message: `Required lookup ${m.sourceField} references ${raw.logicalName} ${raw.id}, which was not migrated and does not exist in the target`,
            retryable: true,
          });
          return result;
        } else {
          result.errors.push({
            operation: 'RESOLVE_LOOKUP',
            severity: 'WARNING',
            code: 'LOOKUP_UNRESOLVED',
            field: m.sourceField,
            message: `Lookup ${m.sourceField} references ${raw.logicalName} ${raw.id}, which does not exist in the target; value left empty`,
            retryable: true,
          });
        }
        continue;
      }
      const converted = transformValue(sAttr, tAttr, raw);
      if (!converted.ok) {
        result.errors.push({
          operation: 'CREATE',
          severity: 'ERROR',
          code: 'VALUE_CONVERSION',
          field: m.sourceField,
          message: converted.error,
          retryable: false,
        });
        return result;
      }
      values[tAttr.logicalName] = converted.value;
    }

    // Identify an existing target record.
    let existingId: string | null = null;
    let matchMethod: string | null = null;
    try {
      if (entity.matchStrategy === 'ALTERNATE_KEY' && entity.alternateKey) {
        const key = t.keys.find((k) => k.logicalName === entity.alternateKey);
        if (!key)
          throw new DataverseError(
            'VALIDATION',
            `Alternate key ${entity.alternateKey} is not defined in the target`,
            400,
          );
        const match = await ctx.tConn.findByAlternateKey(
          t,
          key,
          values,
          syncCompareColumns(ctx.options, entity),
        );
        if (match) {
          existingId = match.id;
          matchMethod = `ALTERNATE_KEY:${key.logicalName}`;
          existingTargetRecords.set(match.id, match);
        }
      } else if (existingById.has(record.id.toLowerCase())) {
        existingId = record.id.toLowerCase();
        matchMethod = 'PRIMARY_ID';
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      result.errors.push(toRecordError(err, 'MATCH'));
      return result;
    }

    // Ownership and audit preservation (only what Dataverse actually allows to be written).
    const audit = entity.audit;
    const principal = (field: string | null): { value: LookupValue | null; unmapped: boolean } => {
      if (!field) return { value: null, unmapped: false };
      const raw = record.values[field];
      if (!isLookupValue(raw)) return { value: null, unmapped: false };
      const mapped = ctx.principalMap.get(`${raw.logicalName}:${raw.id.toLowerCase()}`);
      return mapped
        ? { value: { id: mapped, logicalName: raw.logicalName }, unmapped: false }
        : { value: null, unmapped: true };
    };
    let impersonateUserId: string | null = null;
    if (ctx.options.preserveOwnership && audit.ownerField) {
      const owner = principal(audit.ownerField);
      if (owner.value) values[audit.ownerField] = owner.value;
      else if (owner.unmapped) {
        result.errors.push({
          operation: 'RESOLVE_PRINCIPAL',
          severity: 'WARNING',
          code: 'PRINCIPAL_UNMAPPED',
          field: audit.ownerField,
          message: `Owner is not mapped to a target user; the record is owned by the migrating user instead`,
          retryable: true,
        });
      }
    }
    if (ctx.options.preserveCreatedOn && audit.createdOnField && audit.overriddenCreatedOnField) {
      const createdOn = record.values[audit.createdOnField];
      if (typeof createdOn === 'string') values[audit.overriddenCreatedOnField] = createdOn;
    }
    if (ctx.options.preserveCreatedBy && audit.createdByField) {
      const createdBy = principal(audit.createdByField);
      if (createdBy.value) impersonateUserId = createdBy.value.id;
      else if (createdBy.unmapped) {
        result.errors.push({
          operation: 'RESOLVE_PRINCIPAL',
          severity: 'WARNING',
          code: 'PRINCIPAL_UNMAPPED',
          field: audit.createdByField,
          message: 'Created by is not mapped to a target user; the migrating user is recorded instead',
          retryable: true,
        });
      }
    }
    let auditWork: RecordResult['audit'] = null;
    if (ctx.options.preserveModifiedBy && audit.modifiedByField && audit.touchField) {
      const modifiedBy = principal(audit.modifiedByField);
      if (modifiedBy.value && modifiedBy.value.id !== impersonateUserId) {
        auditWork = {
          modifiedById: modifiedBy.value.id,
          field: audit.touchField.target,
          value: values[audit.touchField.target] ?? null,
        };
      }
    }
    const writeOptions: WriteOptions = impersonateUserId
      ? { ...ctx.writeOptions, impersonateUserId }
      : ctx.writeOptions;

    const strategy = ctx.options.conflictStrategy;
    try {
      if (existingId) {
        if (strategy === 'SKIP_EXISTING') {
          return { ...result, outcome: 'SKIPPED', targetId: existingId, matchMethod };
        }
        if (strategy === 'CREATE_ONLY') {
          result.targetId = existingId;
          result.matchMethod = matchMethod;
          result.errors.push({
            operation: 'CREATE',
            severity: 'ERROR',
            code: 'ALREADY_EXISTS',
            message: `A matching record already exists in the target (${matchMethod}); CREATE_ONLY does not modify existing records`,
            retryable: false,
          });
          return result;
        }
        let changes = values;
        if (strategy === 'SYNC') {
          // Compare with the target and write only what actually differs, so records that already
          // match keep their modifiedon / modifiedby untouched.
          const current = existingTargetRecords.get(existingId);
          if (!current) {
            result.errors.push({
              operation: 'COMPARE',
              severity: 'ERROR',
              code: 'TARGET_READ_FAILED',
              message: 'Could not read the existing target record to compare values',
              retryable: true,
            });
            return result;
          }
          changes = {};
          const tAttrsByName = new Map(t.attributes.map((a) => [a.logicalName, a]));
          for (const [field, value] of Object.entries(values)) {
            const attr = tAttrsByName.get(field);
            if (!attr) continue;
            // overriddencreatedon only applies to creates.
            if (field === audit.overriddenCreatedOnField) continue;
            if (!valuesEqual(attr, value, current.values[field] ?? null)) changes[field] = value;
          }
          if (Object.keys(changes).length === 0) {
            return { ...result, outcome: 'UNCHANGED', targetId: existingId, matchMethod };
          }
        }
        await ctx.tConn.updateRecord(t, existingId, { values: changes }, writeOptions);
        return {
          ...result,
          outcome: 'UPDATED',
          targetId: existingId,
          matchMethod,
          deferred: Object.keys(deferred).length ? deferred : null,
          audit: auditWork,
        };
      }
      // Preserve the source identifier when creating so references and re-runs stay stable.
      const createdId = await ctx.tConn.createRecord(t, { id: record.id, values }, writeOptions);
      return {
        ...result,
        outcome: 'CREATED',
        targetId: createdId,
        matchMethod: 'PRESERVED_ID',
        deferred: Object.keys(deferred).length ? deferred : null,
        audit: auditWork,
      };
    } catch (err) {
      if (isFatal(err)) throw err;
      const e = toRecordError(err, existingId ? 'UPDATE' : 'CREATE');
      if (e.code.startsWith('FORBIDDEN') && ctx.options.bypassCustomBusinessLogic) {
        e.message = `${e.message} (bypassing custom business logic requires the prvBypassCustomBusinessLogic privilege)`;
      }
      if (e.code.startsWith('FORBIDDEN') && impersonateUserId) {
        e.message = `${e.message} (preserving "created by" impersonates the mapped user and requires prvActOnBehalfOfAnotherUser)`;
      }
      result.errors.push(e);
      return result;
    }
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
    const tTable = ctx.targetMeta.get(logicalName);
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
    if (unresolved.length) {
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
    const t = ctx.targetMeta.get(entity.logicalName);
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
        for (const [attr, lookup] of Object.entries(map.deferredLookups ?? {})) {
          const resolved = await this.resolveLookup(ctx, lookup);
          const tAttr: AttributeMeta | undefined = tAttrs.get(attr);
          if (resolved) values[attr] = { id: resolved, logicalName: lookup.logicalName };
          else {
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
    const t = ctx.targetMeta.get(entity.logicalName);
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
            { ...ctx.writeOptions, impersonateUserId: work.modifiedById },
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
  heartbeat: () => Promise<void>;
  /** sourceLogicalName:sourceId -> targetId (null = known missing). */
  lookupCache: Map<string, string | null>;
  /** `${logicalName}:${sourceId}` -> target id for users, teams and business units. */
  principalMap: ReadonlyMap<string, string>;
}
