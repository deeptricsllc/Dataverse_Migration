import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import {
  DEFAULT_PLAN_OPTIONS,
  auditFlags,
  type IdentityImpactDto,
  type PlanOptions,
  type PreflightAction,
  type PreflightRecordDto,
  type PreflightRunDto,
  type PreflightTotals,
  type PrincipalTable,
} from '../../../shared/domain';
import { LOOKUP_TYPES, isLookupValue, type DvRecord, type TableMetadata } from '../../../shared/metadata';
import type { AppDb } from '../db/client';
import {
  environments,
  migrationPlanEntities,
  migrationPlans,
  preflightEntityResults,
  preflightRecords,
  preflightRuns,
  principalDirectory,
  users,
} from '../db/schema';
import type { ConnectionFactory } from '../dataverse/factory';
import type { JobQueue } from '../jobs/queue';
import { badRequest, errorMessage, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import { type EnvironmentService } from './environment-service';
import type { MetadataService } from './metadata-service';
import type { MigrationRunService } from './migration-run-service';
import type { PrincipalService } from './principal-service';
import { RecordMatcher, describeMatchStrategy } from './record-matcher';
import { classify, decideAction, prepareRecord } from './record-planner';
import type { RunPlanSnapshot } from './run-snapshot';
import { envRef } from './env-ref';

/** Upper bound per table so a dry run cannot become unbounded on very large tables. */
const MAX_RECORDS_PER_TABLE = 20_000;
const MAX_PERSISTED_RECORDS_PER_ACTION = 2_000;

const emptyTotals = (): PreflightTotals => ({
  sourceRecords: 0,
  analyzed: 0,
  create: 0,
  update: 0,
  unchanged: 0,
  conflict: 0,
  blocked: 0,
});

/**
 * Dry run: classifies every source record as CREATE / UPDATE / UNCHANGED / CONFLICT / BLOCKED
 * without writing anything. It uses the same planner and matcher as the execution engine, so the
 * numbers reviewed here are the decisions the migration will make.
 */
export class PreflightService {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly principals: PrincipalService,
    private readonly runs: MigrationRunService,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async create(ctx: RequestContext, planId: string): Promise<PreflightRunDto> {
    const [plan] = await this.db
      .select()
      .from(migrationPlans)
      .where(and(eq(migrationPlans.id, planId), eq(migrationPlans.organizationId, ctx.organizationId)));
    if (!plan) throw notFound('Migration plan');
    const entities = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, planId));
    if (entities.length === 0) throw badRequest('The plan has no tables to analyze');

    const [run] = await this.db
      .insert(preflightRuns)
      .values({
        organizationId: ctx.organizationId,
        planId,
        sourceEnvironmentId: plan.sourceEnvironmentId,
        targetEnvironmentId: plan.targetEnvironmentId,
        options: { ...DEFAULT_PLAN_OPTIONS, ...plan.options },
        createdByUserId: ctx.userId,
        progressMessage: 'Queued',
      })
      .returning();
    await this.queue.enqueue('PREFLIGHT', ctx.organizationId, run.id);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'PREFLIGHT_REQUESTED',
      outcome: 'REQUESTED',
      sourceEnvironmentId: plan.sourceEnvironmentId,
      targetEnvironmentId: plan.targetEnvironmentId,
      runId: run.id,
      requestId: ctx.requestId,
      details: { planId },
    });
    return this.get(ctx, run.id);
  }

  /** Job handler. Performs reads only. */
  async execute(preflightRunId: string, heartbeat: () => Promise<void> = async () => {}): Promise<void> {
    const [pf] = await this.db.select().from(preflightRuns).where(eq(preflightRuns.id, preflightRunId));
    if (!pf || pf.status === 'COMPLETED' || pf.status === 'FAILED') return;
    const log = this.logger.child({ preflightRunId, planId: pf.planId });
    const progress = (progressMessage: string) =>
      this.db.update(preflightRuns).set({ progressMessage }).where(eq(preflightRuns.id, preflightRunId));
    await this.db
      .update(preflightRuns)
      .set({ status: 'RUNNING', startedAt: new Date(), errorMessage: null })
      .where(eq(preflightRuns.id, preflightRunId));
    await this.db.delete(preflightRecords).where(eq(preflightRecords.preflightRunId, preflightRunId));
    await this.db
      .delete(preflightEntityResults)
      .where(eq(preflightEntityResults.preflightRunId, preflightRunId));
    log.info('Preflight started');

    try {
      if (!pf.createdByUserId) throw new Error('Preflight has no initiating user');
      const source = await this.environmentsSvc.getInOrganization(pf.organizationId, pf.sourceEnvironmentId);
      const target = await this.environmentsSvc.getInOrganization(pf.organizationId, pf.targetEnvironmentId);
      const sConn = this.connections.forEnvironment(source, pf.createdByUserId, { preflightRunId });
      const tConn = this.connections.forEnvironment(target, pf.createdByUserId, { preflightRunId });
      const options: PlanOptions = { ...DEFAULT_PLAN_OPTIONS, ...pf.options };

      // The plan snapshot the migration would use, built exactly as execution builds it.
      const snapshot = await this.runs.buildSnapshot(pf.planId);
      const names = snapshot.entities.map((e) => e.logicalName);
      await progress('Loading metadata');
      const sourceMeta = await this.metadata.getTables(source.id, sConn, names);
      const referenced = new Set<string>(names);
      for (const e of snapshot.entities) {
        const s = sourceMeta.get(e.logicalName);
        for (const m of e.mappings.filter((x) => x.isLookup)) {
          for (const t of s?.attributes.find((a) => a.logicalName === m.sourceField)?.targets ?? []) {
            referenced.add(t);
          }
        }
      }
      const targetCatalog = await this.metadata.getCatalog(target.id, tConn);
      const targetMeta = await this.metadata.getTables(
        target.id,
        tConn,
        [...referenced].filter((n) => targetCatalog.some((c) => c.logicalName === n)),
      );
      const principalMap = await this.principals.resolutionMap(pf.organizationId, source.id, target.id);

      const totals = emptyTotals();
      const identity = new Map<
        string,
        { logicalName: PrincipalTable; records: Set<string>; fields: Set<string> }
      >();
      const plannedTables = new Set(snapshot.entities.map((e) => e.logicalName));
      for (const entity of [...snapshot.entities].sort((a, b) => a.orderIndex - b.orderIndex)) {
        await progress(`Analyzing ${entity.logicalName}`);
        const entityTotals = await this.analyzeEntity({
          pf,
          entity,
          options,
          source: sourceMeta.get(entity.logicalName),
          target: targetMeta.get(entity.logicalName),
          targetMeta,
          sConn,
          tConn,
          principalMap,
          plannedTables,
          identity,
          heartbeat,
        });
        for (const key of Object.keys(totals) as (keyof PreflightTotals)[]) totals[key] += entityTotals[key];
        await heartbeat();
      }

      const impact = await this.buildIdentityImpact(target.id, options, identity);
      await this.db
        .update(preflightRuns)
        .set({
          status: 'COMPLETED',
          totals,
          identityImpact: impact,
          completedAt: new Date(),
          progressMessage: 'Completed',
        })
        .where(eq(preflightRuns.id, preflightRunId));
      await this.audit.record({
        organizationId: pf.organizationId,
        userId: pf.createdByUserId,
        action: 'PREFLIGHT_COMPLETED',
        outcome: 'SUCCESS',
        sourceEnvironmentId: pf.sourceEnvironmentId,
        targetEnvironmentId: pf.targetEnvironmentId,
        runId: preflightRunId,
        details: { ...totals },
      });
      log.info({ totals }, 'Preflight completed');
    } catch (err) {
      const message = errorMessage(err);
      log.error({ error: message }, 'Preflight failed');
      await this.db
        .update(preflightRuns)
        .set({ status: 'FAILED', errorMessage: message.slice(0, 2000), completedAt: new Date() })
        .where(eq(preflightRuns.id, preflightRunId));
    }
  }

  private async analyzeEntity(p: {
    pf: typeof preflightRuns.$inferSelect;
    entity: RunPlanSnapshot['entities'][number];
    options: PlanOptions;
    source: TableMetadata | undefined;
    target: TableMetadata | undefined;
    targetMeta: Map<string, TableMetadata>;
    sConn: ReturnType<ConnectionFactory['forEnvironment']>;
    tConn: ReturnType<ConnectionFactory['forEnvironment']>;
    principalMap: ReadonlyMap<string, string>;
    plannedTables: ReadonlySet<string>;
    identity: Map<string, { logicalName: PrincipalTable; records: Set<string>; fields: Set<string> }>;
    heartbeat: () => Promise<void>;
  }): Promise<PreflightTotals> {
    const { pf, entity, options, source, target } = p;
    const totals = emptyTotals();
    const matchDescription = describeMatchStrategy(entity);

    if (!source || !target) {
      await this.db.insert(preflightEntityResults).values({
        preflightRunId: pf.id,
        logicalName: entity.logicalName,
        displayName: entity.displayName,
        matchDescription,
        sampled: false,
        totals,
      });
      return totals;
    }

    const matcher = new RecordMatcher(this.db, p.tConn, {
      organizationId: pf.organizationId,
      sourceEnvironmentId: pf.sourceEnvironmentId,
      targetEnvironmentId: pf.targetEnvironmentId,
    });
    const flags = auditFlags(options.auditPolicy);
    const auditColumns = [
      flags.owner ? entity.audit.ownerField : null,
      flags.createdOn ? entity.audit.createdOnField : null,
      flags.createdBy ? entity.audit.createdByField : null,
      flags.modifiedBy ? entity.audit.modifiedByField : null,
    ].filter((c): c is string => Boolean(c));
    const sourceColumns = [...new Set([...entity.mappings.map((m) => m.sourceField), ...auditColumns])];
    const compareColumns = [...new Set(entity.mappings.map((m) => m.targetField).concat(auditColumns))];

    const count = await p.sConn.countRecords(source).catch(() => ({ count: 0, approximate: true }));
    totals.sourceRecords = count.count;
    const persisted: Record<PreflightAction, number> = {
      CREATE: 0,
      UPDATE: 0,
      UNCHANGED: 0,
      CONFLICT: 0,
      BLOCKED: 0,
    };
    let sampled = false;

    for await (const page of p.sConn.queryRecords(source, sourceColumns, { pageSize: 200 })) {
      if (totals.analyzed >= MAX_RECORDS_PER_TABLE) {
        sampled = true;
        break;
      }
      // Lookups the migration would resolve. Those pointing at records an earlier pass of this
      // same plan creates are reported as pending, not blocked.
      const { lookups, pending } = await this.resolveLookups(p, entity, page);
      const prefetched = await matcher.prefetch(
        entity,
        target,
        page.map((r) => r.id),
        compareColumns,
      );
      const rows: (typeof preflightRecords.$inferInsert)[] = [];
      for (const record of page) {
        const prepared = prepareRecord({
          entity,
          options,
          source,
          target,
          record,
          principalMap: p.principalMap,
          lookups,
          pendingLookups: pending,
        });
        for (const issue of prepared.issues.filter((i) => i.code.startsWith('PRINCIPAL'))) {
          this.trackIdentity(p.identity, record, entity, issue.field ?? null, source);
        }
        const match = await matcher.match(entity, target, record, prepared, prefetched, compareColumns);
        const decision = decideAction(entity, options, target, prepared, match);
        const action = classify(decision);
        totals.analyzed++;
        totals[action.toLowerCase() as 'create'] += 1;
        if (persisted[action] < MAX_PERSISTED_RECORDS_PER_ACTION) {
          persisted[action] += 1;
          rows.push({
            preflightRunId: pf.id,
            logicalName: entity.logicalName,
            sourceRecordId: record.id,
            recordName: prepared.name,
            action,
            targetRecordId:
              decision.action === 'UPDATE' || decision.action === 'UNCHANGED' || decision.action === 'SKIP'
                ? decision.targetId
                : decision.action === 'CONFLICT'
                  ? (decision.targetId ?? null)
                  : null,
            matchMethod:
              decision.action === 'UPDATE' || decision.action === 'UNCHANGED' || decision.action === 'SKIP'
                ? decision.matchMethod
                : null,
            reasonCode:
              decision.action === 'CONFLICT' || decision.action === 'BLOCKED' ? decision.code : null,
            reason: decision.action === 'CONFLICT' || decision.action === 'BLOCKED' ? decision.reason : null,
            changes: decision.action === 'UPDATE' ? decision.changes : [],
          });
        }
      }
      if (rows.length) {
        for (let i = 0; i < rows.length; i += 200) {
          await this.db.insert(preflightRecords).values(rows.slice(i, i + 200));
        }
      }
      await p.heartbeat();
    }

    await this.db.insert(preflightEntityResults).values({
      preflightRunId: pf.id,
      logicalName: entity.logicalName,
      displayName: entity.displayName,
      matchDescription,
      sampled,
      totals,
    });
    return totals;
  }

  /** Mirrors the engine's lookup resolution, read-only. */
  private async resolveLookups(
    p: {
      pf: typeof preflightRuns.$inferSelect;
      tConn: ReturnType<ConnectionFactory['forEnvironment']>;
      targetMeta: Map<string, TableMetadata>;
      principalMap: ReadonlyMap<string, string>;
      /** Tables this plan migrates, so their records count as "will exist" during the dry run. */
      plannedTables: ReadonlySet<string>;
    },
    entity: RunPlanSnapshot['entities'][number],
    page: DvRecord[],
  ): Promise<{ lookups: Map<string, string | null>; pending: Set<string> }> {
    const resolved = new Map<string, string | null>(p.principalMap);
    const pending = new Set<string>();
    const wanted = new Map<string, Set<string>>();
    for (const m of entity.mappings.filter((x) => x.isLookup)) {
      for (const r of page) {
        const v = r.values[m.sourceField];
        if (!isLookupValue(v)) continue;
        if (m.deferredTargets?.includes(v.logicalName)) continue;
        const key = `${v.logicalName}:${v.id.toLowerCase()}`;
        if (resolved.has(key)) continue;
        if (!wanted.has(v.logicalName)) wanted.set(v.logicalName, new Set());
        wanted.get(v.logicalName)!.add(v.id.toLowerCase());
      }
    }
    for (const [logicalName, ids] of wanted) {
      const idList = [...ids];
      const rows = await this.db
        .select({ sourceId: sql<string>`source_id`, targetId: sql<string>`target_id` })
        .from(sql`migration_record_maps`)
        .where(
          sql`organization_id = ${p.pf.organizationId} and source_environment_id = ${p.pf.sourceEnvironmentId} and target_environment_id = ${p.pf.targetEnvironmentId} and logical_name = ${logicalName} and outcome <> 'FAILED' and target_id is not null and source_id in ${sql.raw(`(${idList.map((i) => `'${i.replace(/'/g, "''")}'`).join(',') || `''`})`)}`,
        );
      for (const r of rows) resolved.set(`${logicalName}:${r.sourceId}`, r.targetId);
      const table = p.targetMeta.get(logicalName);
      const unresolved = idList.filter((id) => !resolved.get(`${logicalName}:${id}`));
      if (table && unresolved.length) {
        const found = await p.tConn.retrieveByIds(table, unresolved, []);
        const ids2 = new Set(found.map((f) => f.id.toLowerCase()));
        for (const id of unresolved) if (ids2.has(id)) resolved.set(`${logicalName}:${id}`, id);
      }
      if (p.plannedTables.has(logicalName)) {
        for (const id of idList) {
          const key = `${logicalName}:${id}`;
          if (!resolved.get(key)) pending.add(key);
        }
      }
    }
    return { lookups: resolved, pending };
  }

  private trackIdentity(
    identity: Map<string, { logicalName: PrincipalTable; records: Set<string>; fields: Set<string> }>,
    record: DvRecord,
    entity: RunPlanSnapshot['entities'][number],
    field: string | null,
    source: TableMetadata,
  ) {
    if (!field) return;
    const value = record.values[field];
    if (!isLookupValue(value)) return;
    const key = `${value.logicalName}:${value.id.toLowerCase()}`;
    const current = identity.get(key) ?? {
      logicalName: value.logicalName as PrincipalTable,
      records: new Set<string>(),
      fields: new Set<string>(),
    };
    current.records.add(`${entity.logicalName}:${record.id}`);
    current.fields.add(field);
    identity.set(key, current);
    void source;
  }

  private async buildIdentityImpact(
    targetEnvironmentId: string,
    options: PlanOptions,
    identity: Map<string, { logicalName: PrincipalTable; records: Set<string>; fields: Set<string> }>,
  ): Promise<IdentityImpactDto> {
    const names = new Map<string, string>();
    if (identity.size) {
      const rows = await this.db
        .select({ id: principalDirectory.principalId, data: principalDirectory.data })
        .from(principalDirectory)
        .where(eq(principalDirectory.environmentId, targetEnvironmentId));
      for (const r of rows) names.set(r.id, r.data.name);
    }
    const unresolved = [...identity.entries()].map(([key, v]) => {
      const id = key.split(':')[1];
      return {
        logicalName: v.logicalName,
        id,
        name: names.get(id) ?? null,
        records: v.records.size,
        fields: [...v.fields].sort(),
      };
    });
    const records = new Set<string>();
    const fields = new Set<string>();
    for (const v of identity.values()) {
      for (const r of v.records) records.add(r);
      for (const f of v.fields) fields.add(f);
    }
    return {
      policy: options.userResolutionPolicy,
      fallbackPrincipal: options.fallbackPrincipal,
      unresolvedPrincipals: unresolved.sort((a, b) => b.records - a.records).slice(0, 200),
      recordsAffected: records.size,
      fieldsAffected: [...fields].sort(),
    };
  }

  // ---------------------------------------------------------------------------
  // Read models
  // ---------------------------------------------------------------------------

  async get(ctx: Pick<RequestContext, 'organizationId'>, id: string): Promise<PreflightRunDto> {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const [row] = await this.db
      .select({ pf: preflightRuns, src, tgt, planName: migrationPlans.name, user: users.displayName })
      .from(preflightRuns)
      .innerJoin(src, eq(src.id, preflightRuns.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, preflightRuns.targetEnvironmentId))
      .innerJoin(migrationPlans, eq(migrationPlans.id, preflightRuns.planId))
      .leftJoin(users, eq(users.id, preflightRuns.createdByUserId))
      .where(and(eq(preflightRuns.id, id), eq(preflightRuns.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Preflight run');
    const entities = await this.db
      .select()
      .from(preflightEntityResults)
      .where(eq(preflightEntityResults.preflightRunId, id))
      .orderBy(asc(preflightEntityResults.logicalName));
    return {
      id: row.pf.id,
      planId: row.pf.planId,
      planName: row.planName,
      status: row.pf.status,
      sourceEnvironment: envRef(row.src),
      targetEnvironment: envRef(row.tgt),
      options: { ...DEFAULT_PLAN_OPTIONS, ...row.pf.options },
      totals: row.pf.totals ?? emptyTotals(),
      entities: entities.map((e) => ({
        logicalName: e.logicalName,
        displayName: e.displayName,
        matchDescription: e.matchDescription,
        sampled: e.sampled,
        ...e.totals,
      })),
      identityImpact: row.pf.identityImpact ?? {
        policy: (row.pf.options as PlanOptions).userResolutionPolicy,
        fallbackPrincipal: (row.pf.options as PlanOptions).fallbackPrincipal,
        unresolvedPrincipals: [],
        recordsAffected: 0,
        fieldsAffected: [],
      },
      progressMessage: row.pf.progressMessage,
      errorMessage: row.pf.errorMessage,
      createdAt: row.pf.createdAt.toISOString(),
      completedAt: row.pf.completedAt?.toISOString() ?? null,
      createdBy: row.user ?? null,
    };
  }

  async latestForPlan(
    ctx: Pick<RequestContext, 'organizationId'>,
    planId: string,
  ): Promise<PreflightRunDto | null> {
    const [row] = await this.db
      .select({ id: preflightRuns.id })
      .from(preflightRuns)
      .where(and(eq(preflightRuns.planId, planId), eq(preflightRuns.organizationId, ctx.organizationId)))
      .orderBy(desc(preflightRuns.createdAt))
      .limit(1);
    return row ? this.get(ctx, row.id) : null;
  }

  async records(
    ctx: Pick<RequestContext, 'organizationId'>,
    id: string,
    filter: { action?: PreflightAction; entity?: string; limit: number; offset: number },
  ): Promise<{ items: PreflightRecordDto[]; total: number }> {
    await this.get(ctx, id);
    const conditions = [eq(preflightRecords.preflightRunId, id)];
    if (filter.action) conditions.push(eq(preflightRecords.action, filter.action));
    if (filter.entity) conditions.push(eq(preflightRecords.logicalName, filter.entity));
    const [total] = await this.db
      .select({ n: count() })
      .from(preflightRecords)
      .where(and(...conditions));
    const rows = await this.db
      .select()
      .from(preflightRecords)
      .where(and(...conditions))
      .orderBy(asc(preflightRecords.logicalName), asc(preflightRecords.sourceRecordId))
      .limit(filter.limit)
      .offset(filter.offset);
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((r) => ({
        id: r.id,
        entity: r.logicalName,
        sourceRecordId: r.sourceRecordId,
        recordName: r.recordName,
        action: r.action,
        targetRecordId: r.targetRecordId,
        matchMethod: r.matchMethod,
        reasonCode: r.reasonCode,
        reason: r.reason,
        changes: r.changes,
      })),
    };
  }

  async list(ctx: Pick<RequestContext, 'organizationId'>, planId?: string, limit = 20) {
    const conditions = [eq(preflightRuns.organizationId, ctx.organizationId)];
    if (planId) conditions.push(eq(preflightRuns.planId, planId));
    const rows = await this.db
      .select({ id: preflightRuns.id })
      .from(preflightRuns)
      .where(and(...conditions))
      .orderBy(desc(preflightRuns.createdAt))
      .limit(limit);
    return Promise.all(rows.map((r) => this.get(ctx, r.id)));
  }

  /** Every preflight record that needs attention, for the remediation export. */
  async issueRecords(ctx: Pick<RequestContext, 'organizationId'>, id: string) {
    await this.get(ctx, id);
    return this.db
      .select()
      .from(preflightRecords)
      .where(
        and(
          eq(preflightRecords.preflightRunId, id),
          inArray(preflightRecords.action, ['CONFLICT', 'BLOCKED', 'UPDATE']),
        ),
      )
      .orderBy(asc(preflightRecords.action), asc(preflightRecords.logicalName));
  }
}

void LOOKUP_TYPES;
