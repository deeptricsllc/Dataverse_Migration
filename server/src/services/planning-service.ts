import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import {
  DEFAULT_PLAN_OPTIONS,
  auditNeedsImpersonation,
  auditNeedsPrincipals,
  type DiffStatus,
  type FieldMappingDto,
  type MappingStatus,
  type ChoiceMappingDto,
  type FieldTransformDto,
  type MigrationPlanDto,
  type ObjectMappingStatus,
  type PlanEntityDto,
  type PlanOptions,
  type TableCandidateDto,
  type TableCategory,
} from '../../../shared/domain';
import {
  LOOKUP_TYPES,
  SYSTEM_MANAGED_COLUMNS,
  isKeyUsable,
  type TableMetadata,
} from '../../../shared/metadata';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import {
  comparisonTableResults,
  environments,
  fieldMappings,
  migrationPlanEntities,
  migrationPlans,
  migrationRuns,
  metadataTables,
  tableCategories,
  users,
} from '../db/schema';
import type { ConnectionFactory } from '../dataverse/factory';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { ComparisonService } from './comparison-service';
import type { RequestContext } from './context';
import { analyzeDependencies } from './dependency-graph';
import { integrationError, type EnvironmentService } from './environment-service';
import {
  NameSimilaritySuggestionProvider,
  autoMapTable,
  proposeMapping,
  validateManualMapping,
  type MappingSuggestion,
  type MappingSuggestionProvider,
} from './mapping';
import { isMigratableTable, type MetadataService } from './metadata-service';
import { countBySeverity, validatePlan } from './plan-validation';
import type { PrincipalService } from './principal-service';
import { fieldVerdict, needsChoiceMapping } from './field-verdict';
import { proposeObjectMapping, type ObjectCandidate } from './object-mapping';
import { describeMatchStrategy } from './record-matcher';
import { diffTableDeep } from './schema-diff';
import { envRef } from './env-ref';

type PlanRow = typeof migrationPlans.$inferSelect;
type EntityRow = typeof migrationPlanEntities.$inferSelect;
type MappingRow = typeof fieldMappings.$inferSelect;

const MAPPED = new Set<MappingStatus>(['AUTO_MAPPED', 'MANUAL']);
/** Rows scanned when profiling a column's distinct values for choice mapping. */
const SOURCE_VALUE_SAMPLE = 20_000;

export class PlanningService {
  private readonly suggestionProviders: MappingSuggestionProvider[] = [
    new NameSimilaritySuggestionProvider(),
  ];

  constructor(
    private readonly db: AppDb,
    private readonly config: AppConfig,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly comparisons: ComparisonService,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  bypassAllowed(ctx: Pick<RequestContext, 'role'>) {
    return this.config.ALLOW_BUSINESS_LOGIC_BYPASS && ctx.role === 'ADMIN';
  }

  // ---------------------------------------------------------------------------
  // Candidates
  // ---------------------------------------------------------------------------

  async candidates(
    ctx: RequestContext,
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
  ): Promise<TableCandidateDto[]> {
    const source = await this.environmentsSvc.getAccessible(ctx, sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, targetEnvironmentId);
    const sConn = await this.connections.connectorFor(source, ctx.userId, { requestId: ctx.requestId });
    const tConn = await this.connections.connectorFor(target, ctx.userId, { requestId: ctx.requestId });
    try {
      const [sourceCatalog, targetCatalog] = await Promise.all([
        this.metadata.getCatalog(source.id, sConn),
        this.metadata.getCatalog(target.id, tConn),
      ]);
      const comparisonId = await this.comparisons.latestCompleted(ctx.organizationId, source.id, target.id);
      type Analyzed = {
        status: DiffStatus;
        deep: boolean;
        sourceCount: number | null;
        targetCount: number | null;
        approximate: boolean;
      };
      const statusByTable = new Map<string, Analyzed>();
      if (comparisonId) {
        const rows = await this.db
          .select({
            name: comparisonTableResults.logicalName,
            status: comparisonTableResults.status,
            deep: comparisonTableResults.deep,
            sourceCount: comparisonTableResults.sourceCount,
            targetCount: comparisonTableResults.targetCount,
            approximate: comparisonTableResults.countApproximate,
          })
          .from(comparisonTableResults)
          .where(eq(comparisonTableResults.comparisonRunId, comparisonId));
        for (const r of rows) statusByTable.set(r.name, { ...r, status: r.status as DiffStatus });
      }
      const targetByName = new Map(targetCatalog.map((t) => [t.logicalName, t]));
      const migratable = sourceCatalog.filter(isMigratableTable);
      // Counts were captured by the (background) analysis; lookups come from cached metadata.
      const analyzed = migratable.filter((t) => statusByTable.get(t.logicalName)?.deep);
      const sourceMeta = await this.metadata.getTables(
        source.id,
        sConn,
        analyzed.map((t) => t.logicalName),
      );
      const categories = await this.categoryMap(ctx.organizationId);
      return migratable.map((t) => {
        const analysis = statusByTable.get(t.logicalName);
        const meta = sourceMeta.get(t.logicalName);
        return {
          logicalName: t.logicalName,
          displayName: t.displayName,
          isCustom: t.isCustom,
          category: categories.get(t.logicalName) ?? null,
          schemaStatus:
            statusByTable.get(t.logicalName)?.status ??
            (targetByName.has(t.logicalName) ? null : 'SOURCE_ONLY'),
          sourceCount: analysis?.sourceCount ?? null,
          targetCount: analysis?.targetCount ?? null,
          countApproximate: Boolean(analysis?.approximate),
          lookups: (meta?.attributes ?? [])
            .filter(
              (a) => LOOKUP_TYPES.has(a.type) && !a.attributeOf && (a.isValidForCreate || a.isValidForUpdate),
            )
            .map((a) => ({
              attribute: a.logicalName,
              targets: a.targets ?? [],
              required: a.requiredLevel === 'ApplicationRequired' || a.requiredLevel === 'SystemRequired',
            })),
        };
      });
    } catch (err) {
      throw integrationError(err, 'Loading tables');
    }
  }

  private async categoryMap(organizationId: string) {
    const rows = await this.db
      .select()
      .from(tableCategories)
      .where(eq(tableCategories.organizationId, organizationId));
    return new Map(rows.map((r) => [r.logicalName, r.category as TableCategory]));
  }

  async setCategory(ctx: RequestContext, logicalName: string, category: TableCategory | null) {
    if (category === null) {
      await this.db
        .delete(tableCategories)
        .where(
          and(
            eq(tableCategories.organizationId, ctx.organizationId),
            eq(tableCategories.logicalName, logicalName),
          ),
        );
    } else {
      await this.db
        .insert(tableCategories)
        .values({ organizationId: ctx.organizationId, logicalName, category })
        .onConflictDoUpdate({
          target: [tableCategories.organizationId, tableCategories.logicalName],
          set: { category, updatedAt: new Date() },
        });
    }
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'TABLE_CATEGORY_CHANGED',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { table: logicalName, category },
    });
  }

  // ---------------------------------------------------------------------------
  // Plan lifecycle
  // ---------------------------------------------------------------------------

  async create(
    ctx: RequestContext,
    input: { name?: string; sourceEnvironmentId: string; targetEnvironmentId: string; tables: string[] },
  ): Promise<MigrationPlanDto> {
    if (input.sourceEnvironmentId === input.targetEnvironmentId)
      throw badRequest('Source and target must be different environments');
    const source = await this.environmentsSvc.getAccessible(ctx, input.sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, input.targetEnvironmentId);
    const comparisonRunId = await this.comparisons.latestCompleted(ctx.organizationId, source.id, target.id);
    const [plan] = await this.db
      .insert(migrationPlans)
      .values({
        organizationId: ctx.organizationId,
        name:
          input.name?.trim() ||
          `${source.displayName} → ${target.displayName} (${new Date().toISOString().slice(0, 10)})`,
        sourceEnvironmentId: source.id,
        targetEnvironmentId: target.id,
        comparisonRunId,
        options: DEFAULT_PLAN_OPTIONS,
        createdByUserId: ctx.userId,
      })
      .returning();
    await this.rebuild(ctx, plan, input.tables);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'MIGRATION_PLAN_CREATED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: source.id,
      targetEnvironmentId: target.id,
      runId: plan.id,
      requestId: ctx.requestId,
      details: { tables: input.tables },
    });
    return this.get(ctx, plan.id);
  }

  private async loadPlan(organizationId: string, planId: string): Promise<PlanRow> {
    const [plan] = await this.db
      .select()
      .from(migrationPlans)
      .where(and(eq(migrationPlans.id, planId), eq(migrationPlans.organizationId, organizationId)));
    if (!plan) throw notFound('Migration plan');
    return plan;
  }

  private async assertEditable(organizationId: string, plan: PlanRow) {
    const [active] = await this.db
      .select({ id: migrationRuns.id })
      .from(migrationRuns)
      .where(
        and(
          eq(migrationRuns.planId, plan.id),
          eq(migrationRuns.organizationId, organizationId),
          inArray(migrationRuns.status, ['QUEUED', 'RUNNING', 'PAUSED']),
        ),
      );
    if (active)
      throw new AppError(409, 'PLAN_LOCKED', 'This plan has an active migration run and cannot be changed');
  }

  async updateSelection(ctx: RequestContext, planId: string, tables: string[]) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    await this.assertEditable(ctx.organizationId, plan);
    await this.rebuild(ctx, plan, tables);
    await this.auditUpdate(ctx, plan, { tables });
    return this.get(ctx, planId);
  }

  async revalidate(ctx: RequestContext, planId: string) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    const entities = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, planId));
    await this.rebuild(
      ctx,
      plan,
      entities.map((e) => e.logicalName),
    );
    return this.get(ctx, planId);
  }

  async updateOptions(ctx: RequestContext, planId: string, patch: Partial<PlanOptions>) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    await this.assertEditable(ctx.organizationId, plan);
    if (patch.bypassCustomBusinessLogic && !this.bypassAllowed(ctx)) {
      throw forbidden(
        'Bypassing custom business logic is not permitted. It requires ALLOW_BUSINESS_LOGIC_BYPASS=true and the ADMIN role.',
      );
    }
    const options: PlanOptions = { ...DEFAULT_PLAN_OPTIONS, ...plan.options, ...patch };
    if (options.userResolutionPolicy === 'FALLBACK' && options.fallbackPrincipal) {
      // The fallback identity must be a real principal in the target; it is never assumed.
      const known = await this.principals.list(ctx, plan.sourceEnvironmentId, plan.targetEnvironmentId);
      const fallback = options.fallbackPrincipal;
      const exists = known.targetPrincipals[fallback.logicalName]?.some((x) => x.id === fallback.id);
      if (!exists) throw badRequest('The fallback identity does not exist in the target environment');
    }
    if (options.userResolutionPolicy === 'STRICT') options.fallbackPrincipal = null;
    await this.db
      .update(migrationPlans)
      .set({ options, updatedAt: new Date() })
      .where(eq(migrationPlans.id, planId));
    if (patch.bypassCustomBusinessLogic && !plan.options.bypassCustomBusinessLogic) {
      await this.audit.record({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        action: 'BUSINESS_LOGIC_BYPASS_ENABLED',
        outcome: 'SUCCESS',
        sourceEnvironmentId: plan.sourceEnvironmentId,
        targetEnvironmentId: plan.targetEnvironmentId,
        runId: plan.id,
        requestId: ctx.requestId,
      });
    }
    await this.auditUpdate(ctx, plan, { options: patch });
    return this.revalidate(ctx, planId);
  }

  async updateEntity(
    ctx: RequestContext,
    planId: string,
    entityId: string,
    patch: {
      matchStrategy: 'PRIMARY_ID' | 'ALTERNATE_KEY' | 'BUSINESS_KEY';
      alternateKey: string | null;
      businessKeyFields?: string[];
    },
  ) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    await this.assertEditable(ctx.organizationId, plan);
    const [entity] = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(and(eq(migrationPlanEntities.id, entityId), eq(migrationPlanEntities.planId, planId)));
    if (!entity) throw notFound('Plan table');
    await this.db
      .update(migrationPlanEntities)
      .set({
        matchStrategy: patch.matchStrategy,
        alternateKey: patch.matchStrategy === 'ALTERNATE_KEY' ? patch.alternateKey : null,
        businessKeyFields: patch.matchStrategy === 'BUSINESS_KEY' ? (patch.businessKeyFields ?? []) : [],
      })
      .where(eq(migrationPlanEntities.id, entityId));
    await this.auditUpdate(ctx, plan, { table: entity.logicalName, ...patch });
    return this.revalidate(ctx, planId);
  }

  /**
   * Pairs a source table with a target table. A suggestion is only acted on once it is confirmed
   * here, because migrating rows into the wrong table is not something a user can quietly undo.
   */
  async updateObjectMapping(
    ctx: RequestContext,
    planId: string,
    entityId: string,
    patch: { targetLogicalName: string | null; status: 'CONFIRMED' | 'MANUAL' | 'UNMAPPED' | 'IGNORED' },
  ) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    await this.assertEditable(ctx.organizationId, plan);
    const [entity] = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(and(eq(migrationPlanEntities.id, entityId), eq(migrationPlanEntities.planId, planId)));
    if (!entity) throw notFound('Plan table');

    let targetDisplayName: string | null = null;
    if (patch.targetLogicalName) {
      const target = await this.environmentsSvc.getAccessible(ctx, plan.targetEnvironmentId);
      const tConn = await this.connections.connectorFor(target, ctx.userId, { requestId: ctx.requestId });
      const catalog = await this.metadata.getCatalog(target.id, tConn);
      const match = catalog.find((t) => t.logicalName === patch.targetLogicalName);
      if (!match) throw badRequest(`${patch.targetLogicalName} does not exist in the target connection`);
      if (match.isView) throw badRequest('A view cannot be a migration target');
      targetDisplayName = match.displayName;
    }

    await this.db
      .update(migrationPlanEntities)
      .set({
        targetLogicalName: patch.targetLogicalName,
        targetDisplayName,
        objectMappingStatus: patch.targetLogicalName ? patch.status : 'UNMAPPED',
      })
      .where(eq(migrationPlanEntities.id, entityId));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'OBJECT_MAPPING_CHANGED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: plan.sourceEnvironmentId,
      targetEnvironmentId: plan.targetEnvironmentId,
      runId: plan.id,
      requestId: ctx.requestId,
      details: { source: entity.logicalName, target: patch.targetLogicalName, status: patch.status },
    });
    // Field mappings are rebuilt against the newly chosen target table.
    return this.revalidate(ctx, planId);
  }

  /** Target tables that could hold this source table's data, best match first. */
  async targetCandidates(ctx: RequestContext, planId: string, entityId: string) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    const [entity] = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(and(eq(migrationPlanEntities.id, entityId), eq(migrationPlanEntities.planId, planId)));
    if (!entity) throw notFound('Plan table');
    const source = await this.environmentsSvc.getAccessible(ctx, plan.sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, plan.targetEnvironmentId);
    const sConn = await this.connections.connectorFor(source, ctx.userId, { requestId: ctx.requestId });
    const tConn = await this.connections.connectorFor(target, ctx.userId, { requestId: ctx.requestId });
    const [sourceCatalog, targetCatalog] = await Promise.all([
      this.metadata.getCatalog(source.id, sConn),
      this.metadata.getCatalog(target.id, tConn),
    ]);
    const summary = sourceCatalog.find((t) => t.logicalName === entity.logicalName);
    const proposal = summary
      ? proposeObjectMapping(summary, targetCatalog)
      : { candidates: [] as ObjectCandidate[] };
    return {
      current: entity.targetLogicalName,
      status: entity.objectMappingStatus,
      candidates: proposal.candidates,
      // Every target table, so a person can choose one the suggestion engine did not rank.
      allTargets: targetCatalog
        .filter((t) => !t.isView && !t.isIntersect)
        .map((t) => ({ logicalName: t.logicalName, displayName: t.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }

  /**
   * The distinct values a source column actually holds, with counts, so a choice mapping is built
   * from the data rather than from guesswork. Sampled, and capped.
   */
  async sourceValues(ctx: RequestContext, planId: string, entityId: string, field: string) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    const [entity] = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(and(eq(migrationPlanEntities.id, entityId), eq(migrationPlanEntities.planId, planId)));
    if (!entity) throw notFound('Plan table');
    const source = await this.environmentsSvc.getAccessible(ctx, plan.sourceEnvironmentId);
    const sConn = await this.connections.connectorFor(source, ctx.userId, { requestId: ctx.requestId });
    const table = await this.metadata.getTable(source.id, sConn, entity.logicalName);
    if (!table) throw notFound('Source table');
    const counts = new Map<string, number>();
    let scanned = 0;
    for await (const page of sConn.queryRecords(table, [field], { pageSize: 500 })) {
      for (const record of page) {
        scanned++;
        const raw = record.values[field];
        if (raw === null || raw === undefined) continue;
        const key = typeof raw === 'object' && 'id' in raw ? raw.id : String(raw);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      if (scanned >= SOURCE_VALUE_SAMPLE || counts.size >= 500) break;
    }
    return {
      field,
      scanned,
      sampled: scanned >= SOURCE_VALUE_SAMPLE,
      values: [...counts.entries()]
        .map(([value, occurrences]) => ({ value, occurrences }))
        .sort((a, b) => b.occurrences - a.occurrences || a.value.localeCompare(b.value))
        .slice(0, 200),
    };
  }

  /** Stores the value-level mapping for a choice column. Unmapped values stay unmapped. */
  async updateChoiceMap(ctx: RequestContext, planId: string, mappingId: string, choiceMap: ChoiceMappingDto) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    await this.assertEditable(ctx.organizationId, plan);
    const mapping = await this.loadMapping(planId, mappingId);
    await this.db
      .update(fieldMappings)
      .set({ choiceMap, updatedByUserId: ctx.userId, updatedAt: new Date() })
      .where(eq(fieldMappings.id, mapping.id));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'CHOICE_MAPPING_CHANGED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: plan.sourceEnvironmentId,
      targetEnvironmentId: plan.targetEnvironmentId,
      runId: plan.id,
      requestId: ctx.requestId,
      details: {
        field: mapping.sourceField,
        mapped: choiceMap.entries.filter((e) => e.targetValue !== null).length,
        total: choiceMap.entries.length,
      },
    });
    return this.revalidate(ctx, planId);
  }

  /** Stores a field transformation (trim, case, constant, default). */
  async updateTransform(
    ctx: RequestContext,
    planId: string,
    mappingId: string,
    transform: FieldTransformDto,
  ) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    await this.assertEditable(ctx.organizationId, plan);
    const mapping = await this.loadMapping(planId, mappingId);
    await this.db
      .update(fieldMappings)
      .set({ transform, updatedByUserId: ctx.userId, updatedAt: new Date() })
      .where(eq(fieldMappings.id, mapping.id));
    await this.auditUpdate(ctx, plan, { field: mapping.sourceField, transform: transform.kind });
    return this.revalidate(ctx, planId);
  }

  private async loadMapping(planId: string, mappingId: string) {
    const [row] = await this.db
      .select({ mapping: fieldMappings })
      .from(fieldMappings)
      .innerJoin(migrationPlanEntities, eq(migrationPlanEntities.id, fieldMappings.planEntityId))
      .where(and(eq(fieldMappings.id, mappingId), eq(migrationPlanEntities.planId, planId)));
    if (!row) throw notFound('Field mapping');
    return row.mapping;
  }

  private auditUpdate(ctx: RequestContext, plan: PlanRow, details: Record<string, unknown>) {
    return this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'MIGRATION_PLAN_UPDATED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: plan.sourceEnvironmentId,
      targetEnvironmentId: plan.targetEnvironmentId,
      runId: plan.id,
      requestId: ctx.requestId,
      details,
    });
  }

  /**
   * Recomputes a plan for the selected tables: metadata, counts, automation, auto-mapping
   * (preserving user decisions), dependency order and issues.
   */
  private async rebuild(ctx: RequestContext, plan: PlanRow, requestedTables: string[]) {
    // Dataverse logical names are lower_snake; SQL tables are schema-qualified and case-sensitive.
    const tables = [...new Set(requestedTables)].filter((t) => /^[A-Za-z0-9_.]{1,257}$/.test(t)).sort();
    const source = await this.environmentsSvc.getAccessible(ctx, plan.sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, plan.targetEnvironmentId);
    const sConn = await this.connections.connectorFor(source, ctx.userId, {
      requestId: ctx.requestId,
      planId: plan.id,
    });
    const tConn = await this.connections.connectorFor(target, ctx.userId, {
      requestId: ctx.requestId,
      planId: plan.id,
    });

    try {
      const [sourceCatalog, targetCatalog] = await Promise.all([
        this.metadata.getCatalog(source.id, sConn),
        this.metadata.getCatalog(target.id, tConn),
      ]);
      const sourceNames = new Set(sourceCatalog.map((t) => t.logicalName));
      const targetNames = new Set(targetCatalog.map((t) => t.logicalName));

      // Remove deselected tables.
      if (tables.length) {
        await this.db
          .delete(migrationPlanEntities)
          .where(
            and(
              eq(migrationPlanEntities.planId, plan.id),
              notInArray(migrationPlanEntities.logicalName, tables),
            ),
          );
      } else {
        await this.db.delete(migrationPlanEntities).where(eq(migrationPlanEntities.planId, plan.id));
      }

      const existingEntities = new Map(
        (
          await this.db.select().from(migrationPlanEntities).where(eq(migrationPlanEntities.planId, plan.id))
        ).map((e) => [e.logicalName, e]),
      );

      // Pair every selected source table with a target table. Same-name pairs resolve to
      // themselves (so Dataverse to Dataverse is unchanged); cross-provider pairs are proposed
      // and stay unconfirmed until a person accepts them.
      const objectMapping = new Map<
        string,
        { targetLogicalName: string | null; status: ObjectMappingStatus; candidates: ObjectCandidate[] }
      >();
      for (const name of tables) {
        const summary = sourceCatalog.find((c) => c.logicalName === name);
        const existing = existingEntities.get(name);
        if (existing?.targetLogicalName && targetNames.has(existing.targetLogicalName)) {
          objectMapping.set(name, {
            targetLogicalName: existing.targetLogicalName,
            status: existing.objectMappingStatus,
            candidates: summary ? proposeObjectMapping(summary, targetCatalog).candidates : [],
          });
          continue;
        }
        const proposal = summary
          ? proposeObjectMapping(summary, targetCatalog)
          : { targetLogicalName: null, status: 'UNMAPPED' as ObjectMappingStatus, candidates: [] };
        objectMapping.set(name, {
          targetLogicalName: proposal.targetLogicalName,
          status: proposal.status,
          candidates: proposal.candidates,
        });
      }
      const targetNameFor = (sourceName: string) => objectMapping.get(sourceName)?.targetLogicalName ?? null;

      const [sourceMeta, targetMeta] = await Promise.all([
        this.metadata.getTables(
          source.id,
          sConn,
          tables.filter((t) => sourceNames.has(t)),
        ),
        this.metadata.getTables(target.id, tConn, [
          ...new Set(tables.map(targetNameFor).filter((t): t is string => !!t && targetNames.has(t))),
        ]),
      ]);

      const sourceSummaries = tables
        .map((t) => sourceCatalog.find((c) => c.logicalName === t))
        .filter((t) => !!t);
      const targetSummaries = tables
        .map((t) => targetCatalog.find((c) => c.logicalName === targetNameFor(t)))
        .filter((t) => !!t);
      const [sourceCounts, targetCounts, automation] = await Promise.all([
        this.metadata.counts(source.id, sConn, sourceSummaries, true),
        this.metadata.counts(target.id, tConn, targetSummaries, true),
        tConn.detectAutomation(targetSummaries).catch((err) => {
          this.logger.warn({ planId: plan.id, err: (err as Error).message }, 'Automation detection failed');
          return [];
        }),
      ]);
      const automationByTable = new Map(automation.map((a) => [a.table, a]));

      // Upsert entities + mappings.
      const entityRows: EntityRow[] = [];
      for (const name of tables) {
        const s = sourceMeta.get(name);
        const mapping = objectMapping.get(name)!;
        const targetName = mapping.targetLogicalName;
        const t = targetName ? targetMeta.get(targetName) : undefined;
        const displayName = s?.displayName ?? name;
        let entity = existingEntities.get(name);
        if (!entity) {
          // Only an Active key index is enforced by Dataverse, so only those are chosen by
          // default — and only keys whose columns a migration can actually write, which rules
          // out a key over a server-generated IDENTITY column.
          const writableInTarget = (key: { attributes: string[] }) =>
            key.attributes.every((a) => t?.attributes.find((x) => x.logicalName === a)?.isValidForCreate);
          const sharedKey =
            s && t
              ? s.keys.find(
                  (k) =>
                    isKeyUsable(k) &&
                    writableInTarget(k) &&
                    t.keys.some(
                      (tk) =>
                        tk.logicalName === k.logicalName &&
                        tk.attributes.join() === k.attributes.join() &&
                        isKeyUsable(tk),
                    ),
                )
              : undefined;
          [entity] = await this.db
            .insert(migrationPlanEntities)
            .values({
              planId: plan.id,
              logicalName: name,
              displayName,
              targetLogicalName: targetName,
              targetDisplayName: t?.displayName ?? targetName,
              objectMappingStatus: mapping.status,
              selectedExplicitly: true,
              // A SQL identity primary key cannot be carried across, so those tables are matched
              // on a business/alternate key instead of on the record id.
              matchStrategy: sharedKey ? 'ALTERNATE_KEY' : 'PRIMARY_ID',
              alternateKey: sharedKey?.logicalName ?? null,
            })
            .returning();
        }
        const sc = sourceCounts.get(name);
        const tc = targetName ? targetCounts.get(targetName) : undefined;
        [entity] = await this.db
          .update(migrationPlanEntities)
          .set({
            displayName,
            targetLogicalName: targetName,
            targetDisplayName: t?.displayName ?? targetName,
            objectMappingStatus: mapping.status,
            sourceCount: sc?.count ?? null,
            targetCount: tc?.count ?? null,
            countApproximate: Boolean(sc?.approximate || tc?.approximate),
            schemaStatus: !s ? null : !t ? 'SOURCE_ONLY' : diffTableDeep(s, t).status,
            // Cross-provider pairs are compared through the field mapping, not by name.
            automation: automationByTable.get(name) ?? null,
            audit: s && t ? auditCapability(s, t) : null,
          })
          .where(eq(migrationPlanEntities.id, entity.id))
          .returning();
        entityRows.push(entity);
        if (s) await this.syncMappings(entity, s, t);
      }

      // Dependency analysis based on lookups that are actually mapped.
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
      const mappedLookups = new Map<string, Set<string>>();
      for (const e of entityRows) {
        mappedLookups.set(
          e.logicalName,
          new Set(
            mappingRows
              .filter((m) => m.planEntityId === e.id && m.isLookup && MAPPED.has(m.status))
              .map((m) => m.sourceField),
          ),
        );
      }
      const analysis = analyzeDependencies({
        tables: [...sourceMeta.values()],
        // "Available in the target" means the referenced source table either migrates into a
        // target table in this plan, or already exists in the target under the same name (which
        // is how a Dataverse lookup to a table nobody selected still resolves).
        targetTables: new Set([
          ...tables.filter((t) => {
            const name = targetNameFor(t);
            return !!name && targetNames.has(name);
          }),
          ...[...targetNames],
        ]),
        mappedLookups,
      });
      const deferredTargets = new Map<string, string[]>();
      for (const d of analysis.nodes.flatMap((n) => n.dependsOn.filter((x) => x.deferred))) {
        const k = `${d.from}.${d.attribute}`;
        deferredTargets.set(k, [...(deferredTargets.get(k) ?? []), d.to].sort());
      }
      for (const e of entityRows) {
        const node = analysis.nodes.find((n) => n.logicalName === e.logicalName);
        const orderIndex = analysis.order.indexOf(e.logicalName);
        await this.db
          .update(migrationPlanEntities)
          .set({
            orderIndex: orderIndex >= 0 ? orderIndex + 1 : 9999,
            dependsOn: node?.dependsOn ?? [],
            cycleGroup: node?.cycleGroup ?? null,
          })
          .where(eq(migrationPlanEntities.id, e.id));
        for (const m of mappingRows.filter((x) => x.planEntityId === e.id && x.isLookup)) {
          const targets = deferredTargets.get(`${e.logicalName}.${m.sourceField}`) ?? [];
          if (targets.join() !== m.deferredTargets.join()) {
            await this.db
              .update(fieldMappings)
              .set({ deferred: targets.length > 0, deferredTargets: targets })
              .where(eq(fieldMappings.id, m.id));
          }
        }
      }

      const opts = { ...DEFAULT_PLAN_OPTIONS, ...plan.options };
      let principals:
        { total: number; unmatched: number; ambiguous: number; canImpersonate: boolean | null } | undefined;
      if (auditNeedsPrincipals(opts.auditPolicy)) {
        const summary = await this.principals.list(ctx, source.id, target.id);
        principals = {
          total: summary.counts.total,
          unmatched: summary.counts.unmatched,
          ambiguous: summary.counts.ambiguous,
          canImpersonate: null,
        };
        if (auditNeedsImpersonation(opts.auditPolicy)) {
          try {
            principals.canImpersonate = (
              await this.principals.checkImpersonation(ctx, source.id, target.id)
            ).canImpersonate;
          } catch (err) {
            this.logger.warn({ planId: plan.id, err: (err as Error).message }, 'Impersonation check failed');
          }
        }
      }

      const issues = validatePlan({
        crossProvider: source.connectionType !== target.connectionType,
        entities: entityRows.map((e) => {
          const s = sourceMeta.get(e.logicalName);
          const t = e.targetLogicalName ? targetMeta.get(e.targetLogicalName) : undefined;
          return {
            logicalName: e.logicalName,
            targetLogicalName: e.targetLogicalName,
            objectMappingStatus: e.objectMappingStatus,
            source: s,
            target: t,
            schemaStatus: e.schemaStatus as DiffStatus | null,
            tableDiff: s && t ? diffTableDeep(s, t) : null,
            mappings: mappingRows
              .filter((m) => m.planEntityId === e.id)
              .map((m) => ({
                sourceField: m.sourceField,
                targetField: m.targetField,
                status: m.status,
                reason: m.reason,
                isLookup: m.isLookup,
                compatibility: m.compatibility,
                choiceMap: m.choiceMap,
              })),
            sourceCount: e.sourceCount,
            targetCount: e.targetCount,
            matchStrategy: e.matchStrategy,
            alternateKey: e.alternateKey,
            businessKeyFields: e.businessKeyFields ?? [],
            automation: e.automation ?? null,
            audit: e.audit ?? null,
          };
        }),
        dependencies: analysis,
        options: opts,
        bypassAllowed: this.bypassAllowed(ctx),
        principals,
      });

      const blockers = countBySeverity(issues, 'BLOCKER');
      await this.db
        .update(migrationPlans)
        .set({
          issues,
          dependencyAnalysis: analysis,
          status: plan.status === 'EXECUTED' ? 'EXECUTED' : blockers === 0 ? 'PLANNED' : 'DRAFT',
          updatedAt: new Date(),
        })
        .where(eq(migrationPlans.id, plan.id));
    } catch (err) {
      throw integrationError(err, 'Building the migration plan');
    }
  }

  /** Creates/refreshes auto mappings; decisions made by a user (updatedByUserId) are preserved. */
  private async syncMappings(entity: EntityRow, source: TableMetadata, target: TableMetadata | undefined) {
    const proposals = autoMapTable(source, target);
    const existing = new Map(
      (await this.db.select().from(fieldMappings).where(eq(fieldMappings.planEntityId, entity.id))).map(
        (m) => [m.sourceField, m],
      ),
    );
    const targetAttrs = new Map((target?.attributes ?? []).map((a) => [a.logicalName, a]));
    for (const p of proposals) {
      const current = existing.get(p.sourceField);
      existing.delete(p.sourceField);
      if (current?.updatedByUserId) {
        // Re-check that the user's mapping is still valid against current metadata.
        if (current.status === 'MANUAL' && current.targetField) {
          const sAttr = source.attributes.find((a) => a.logicalName === p.sourceField)!;
          const error = validateManualMapping(sAttr, targetAttrs.get(current.targetField));
          if (error) {
            await this.db
              .update(fieldMappings)
              .set({
                status: 'INCOMPATIBLE',
                reason: `Manual mapping no longer valid: ${error}`,
                updatedByUserId: null,
                updatedAt: new Date(),
              })
              .where(eq(fieldMappings.id, current.id));
          }
        }
        continue;
      }
      const sAttr = source.attributes.find((a) => a.logicalName === p.sourceField);
      const tAttr = p.targetField ? targetAttrs.get(p.targetField) : undefined;
      const values = {
        sourceDisplayName: p.sourceDisplayName,
        targetField: p.targetField,
        sourceType: p.sourceType,
        targetType: p.targetType,
        status: p.status,
        confidence: p.confidence,
        reason: p.reason,
        isLookup: p.isLookup,
        lookupTargets: p.lookupTargets,
        required: p.required,
        compatibility: sAttr ? fieldVerdict(sAttr, tAttr) : 'INCOMPATIBLE',
        // A choice target needs a value map; it is proposed empty so nothing is guessed.
        choiceMap:
          sAttr && needsChoiceMapping(sAttr, tAttr)
            ? (current?.choiceMap ?? { entries: [], defaultTargetValue: null })
            : null,
        updatedAt: new Date(),
      };
      if (current) await this.db.update(fieldMappings).set(values).where(eq(fieldMappings.id, current.id));
      else
        await this.db
          .insert(fieldMappings)
          .values({ planEntityId: entity.id, sourceField: p.sourceField, ...values });
    }
    // Source columns that disappeared.
    if (existing.size) {
      await this.db.delete(fieldMappings).where(
        inArray(
          fieldMappings.id,
          [...existing.values()].map((m) => m.id),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Mapping edits & suggestions
  // ---------------------------------------------------------------------------

  private async loadEntityWithMeta(ctx: RequestContext, planId: string, entityId: string) {
    const plan = await this.loadPlan(ctx.organizationId, planId);
    const [entity] = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(and(eq(migrationPlanEntities.id, entityId), eq(migrationPlanEntities.planId, planId)));
    if (!entity) throw notFound('Plan table');
    const source = await this.environmentsSvc.getAccessible(ctx, plan.sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, plan.targetEnvironmentId);
    const sConn = await this.connections.connectorFor(source, ctx.userId, { requestId: ctx.requestId });
    const tConn = await this.connections.connectorFor(target, ctx.userId, { requestId: ctx.requestId });
    try {
      const s = await this.metadata.getTable(source.id, sConn, entity.logicalName);
      // The target table is whichever table this source table is mapped into, which is the same
      // name for a same-provider plan and a different one across providers.
      const targetName = entity.targetLogicalName ?? entity.logicalName;
      const t = await this.metadata.getTable(target.id, tConn, targetName);
      return { plan, entity, s, t };
    } catch (err) {
      throw integrationError(err, 'Loading table metadata');
    }
  }

  async mappings(ctx: RequestContext, planId: string, entityId: string) {
    const { entity, t } = await this.loadEntityWithMeta(ctx, planId, entityId);
    const rows = await this.db
      .select()
      .from(fieldMappings)
      .where(eq(fieldMappings.planEntityId, entity.id))
      .orderBy(asc(fieldMappings.sourceField));
    return {
      entity: { id: entity.id, logicalName: entity.logicalName, displayName: entity.displayName },
      mappings: rows.map(toMappingDto),
      targetColumns: (t?.attributes ?? [])
        .filter((a) => !a.attributeOf && !a.isPrimaryId && (a.isValidForCreate || a.isValidForUpdate))
        .map((a) => ({
          logicalName: a.logicalName,
          displayName: a.displayName,
          type: a.type,
          required: a.requiredLevel === 'ApplicationRequired' || a.requiredLevel === 'SystemRequired',
          targets: a.targets ?? [],
        })),
    };
  }

  async updateMapping(
    ctx: RequestContext,
    planId: string,
    mappingId: string,
    input:
      | { action: 'MAP'; targetField: string }
      | { action: 'IGNORE' }
      | { action: 'UNMAP' }
      | { action: 'RESET' },
  ) {
    const [mapping] = await this.db
      .select({ m: fieldMappings, e: migrationPlanEntities })
      .from(fieldMappings)
      .innerJoin(migrationPlanEntities, eq(migrationPlanEntities.id, fieldMappings.planEntityId))
      .where(and(eq(fieldMappings.id, mappingId), eq(migrationPlanEntities.planId, planId)));
    if (!mapping) throw notFound('Field mapping');
    const { plan, s, t } = await this.loadEntityWithMeta(ctx, planId, mapping.e.id);
    await this.assertEditable(ctx.organizationId, plan);
    const sAttr = s?.attributes.find((a) => a.logicalName === mapping.m.sourceField);
    if (!sAttr) throw badRequest('Source column no longer exists');

    let set: Partial<MappingRow>;
    if (input.action === 'MAP') {
      const tAttr = t?.attributes.find((a) => a.logicalName === input.targetField);
      const error = validateManualMapping(sAttr, tAttr);
      if (error) throw badRequest(`Cannot map ${sAttr.logicalName} to ${input.targetField}: ${error}`);
      const duplicate = await this.db
        .select({ id: fieldMappings.id })
        .from(fieldMappings)
        .where(
          and(
            eq(fieldMappings.planEntityId, mapping.e.id),
            eq(fieldMappings.targetField, input.targetField),
            inArray(fieldMappings.status, ['AUTO_MAPPED', 'MANUAL']),
          ),
        );
      if (duplicate.some((d) => d.id !== mappingId))
        throw badRequest(`${input.targetField} is already mapped from another column`);
      set = {
        targetField: tAttr!.logicalName,
        targetType: tAttr!.type,
        status: 'MANUAL',
        confidence: 100,
        reason: `Manually mapped by ${ctx.displayName}`,
        required: tAttr!.requiredLevel === 'ApplicationRequired' || tAttr!.requiredLevel === 'SystemRequired',
        compatibility: fieldVerdict(sAttr, tAttr),
        // Mapping onto a choice column starts an (empty) value mapping, which plan validation
        // then reports as incomplete until a person fills it in.
        choiceMap: needsChoiceMapping(sAttr, tAttr)
          ? (mapping.m.choiceMap ?? { entries: [], defaultTargetValue: null })
          : null,
        updatedByUserId: ctx.userId,
      };
    } else if (input.action === 'IGNORE') {
      set = {
        status: 'IGNORED',
        reason: `Ignored by ${ctx.displayName}`,
        choiceMap: null,
        updatedByUserId: ctx.userId,
      };
    } else if (input.action === 'UNMAP') {
      set = {
        status: 'UNMAPPED',
        targetField: null,
        targetType: null,
        confidence: 0,
        reason: `Unmapped by ${ctx.displayName}`,
        compatibility: 'INCOMPATIBLE',
        choiceMap: null,
        updatedByUserId: ctx.userId,
      };
    } else {
      const p = proposeMapping(
        sAttr,
        t?.attributes.find((a) => a.logicalName === sAttr.logicalName),
      );
      const resetTarget = t?.attributes.find((a) => a.logicalName === sAttr.logicalName);
      set = {
        targetField: p.targetField,
        targetType: p.targetType,
        status: p.status,
        confidence: p.confidence,
        reason: p.reason,
        required: p.required,
        compatibility: fieldVerdict(sAttr, resetTarget),
        choiceMap: null,
        updatedByUserId: null,
      };
    }
    await this.db
      .update(fieldMappings)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(fieldMappings.id, mappingId));
    await this.auditUpdate(ctx, plan, {
      mapping: mapping.m.sourceField,
      table: mapping.e.logicalName,
      action: input.action,
    });
    return this.revalidate(ctx, planId);
  }

  /** Suggestions only; the caller must explicitly accept each one (recorded as MANUAL). */
  async suggestions(ctx: RequestContext, planId: string, entityId: string): Promise<MappingSuggestion[]> {
    const { entity, s, t } = await this.loadEntityWithMeta(ctx, planId, entityId);
    if (!s || !t) return [];
    const rows = await this.db.select().from(fieldMappings).where(eq(fieldMappings.planEntityId, entity.id));
    const unmappedNames = new Set(
      rows.filter((r) => r.status === 'UNMAPPED' || r.status === 'INCOMPATIBLE').map((r) => r.sourceField),
    );
    const used = new Set(
      rows.filter((r) => MAPPED.has(r.status) && r.targetField).map((r) => r.targetField!),
    );
    const out: MappingSuggestion[] = [];
    for (const provider of this.suggestionProviders) {
      out.push(
        ...(await provider.suggest({
          source: s,
          target: t,
          unmapped: s.attributes.filter((a) => unmappedNames.has(a.logicalName)),
          usedTargets: used,
        })),
      );
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Read models
  // ---------------------------------------------------------------------------

  async get(ctx: Pick<RequestContext, 'organizationId'>, planId: string): Promise<MigrationPlanDto> {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const [row] = await this.db
      .select({ plan: migrationPlans, src, tgt, user: users.displayName })
      .from(migrationPlans)
      .innerJoin(src, eq(src.id, migrationPlans.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, migrationPlans.targetEnvironmentId))
      .leftJoin(users, eq(users.id, migrationPlans.createdByUserId))
      .where(and(eq(migrationPlans.id, planId), eq(migrationPlans.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Migration plan');
    const entities = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, planId))
      .orderBy(asc(migrationPlanEntities.orderIndex), asc(migrationPlanEntities.logicalName));
    const mappingRows = entities.length
      ? await this.db
          .select({ planEntityId: fieldMappings.planEntityId, status: fieldMappings.status })
          .from(fieldMappings)
          .where(
            inArray(
              fieldMappings.planEntityId,
              entities.map((e) => e.id),
            ),
          )
      : [];
    const categories = await this.categoryMap(ctx.organizationId);
    const sourceMetaRows = await this.metadataKeys(
      row.plan.targetEnvironmentId,
      entities.map((e) => e.logicalName),
    );
    const [lastRun] = await this.db
      .select({ id: migrationRuns.id })
      .from(migrationRuns)
      .where(eq(migrationRuns.planId, planId))
      .orderBy(desc(migrationRuns.createdAt))
      .limit(1);
    const entityDtos: PlanEntityDto[] = entities.map((e) => {
      const summary: Record<MappingStatus, number> = {
        AUTO_MAPPED: 0,
        MANUAL: 0,
        UNMAPPED: 0,
        INCOMPATIBLE: 0,
        IGNORED: 0,
      };
      for (const m of mappingRows) if (m.planEntityId === e.id) summary[m.status]++;
      return {
        id: e.id,
        logicalName: e.logicalName,
        displayName: e.displayName,
        targetLogicalName: e.targetLogicalName ?? e.logicalName,
        targetDisplayName: e.targetDisplayName ?? e.displayName,
        objectMappingStatus: e.objectMappingStatus,
        orderIndex: e.orderIndex,
        selectedExplicitly: e.selectedExplicitly,
        category: categories.get(e.logicalName) ?? null,
        sourceCount: e.sourceCount,
        targetCount: e.targetCount,
        countApproximate: e.countApproximate,
        schemaStatus: e.schemaStatus as DiffStatus | null,
        matchStrategy: e.matchStrategy,
        alternateKey: e.alternateKey,
        businessKeyFields: e.businessKeyFields ?? [],
        matchDescription: describeMatchStrategy({
          matchStrategy: e.matchStrategy,
          alternateKey: e.alternateKey,
          businessKeyFields: e.businessKeyFields ?? [],
        }),
        availableKeys: sourceMetaRows.get(e.logicalName) ?? [],
        dependsOn: e.dependsOn,
        cycleGroup: e.cycleGroup,
        mappingSummary: summary,
        automation: e.automation ?? null,
      };
    });
    const issues = row.plan.issues ?? [];
    return {
      id: row.plan.id,
      name: row.plan.name,
      status: row.plan.status,
      sourceEnvironment: envRef(row.src),
      targetEnvironment: envRef(row.tgt),
      comparisonRunId: row.plan.comparisonRunId,
      options: { ...DEFAULT_PLAN_OPTIONS, ...row.plan.options },
      issues,
      entities: entityDtos,
      dependencyAnalysis: row.plan.dependencyAnalysis ?? null,
      blockerCount: countBySeverity(issues, 'BLOCKER'),
      warningCount: countBySeverity(issues, 'WARNING'),
      createdAt: row.plan.createdAt.toISOString(),
      updatedAt: row.plan.updatedAt.toISOString(),
      createdBy: row.user ?? null,
      lastRunId: lastRun?.id ?? null,
    };
  }

  /** Alternate keys defined in the target (from metadata cache). */
  private async metadataKeys(targetEnvironmentId: string, names: string[]) {
    const out = new Map<string, { logicalName: string; attributes: string[] }[]>();
    if (!names.length) return out;
    const rows = await this.db
      .select({ name: metadataTables.logicalName, metadata: metadataTables.metadata })
      .from(metadataTables)
      .where(
        and(
          eq(metadataTables.environmentId, targetEnvironmentId),
          inArray(metadataTables.logicalName, names),
        ),
      );
    for (const r of rows)
      out.set(
        r.name,
        r.metadata.keys.map((k) => ({ logicalName: k.logicalName, attributes: k.attributes })),
      );
    return out;
  }

  async list(ctx: RequestContext, limit = 50) {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const rows = await this.db
      .select({ plan: migrationPlans, src, tgt, user: users.displayName })
      .from(migrationPlans)
      .innerJoin(src, eq(src.id, migrationPlans.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, migrationPlans.targetEnvironmentId))
      .leftJoin(users, eq(users.id, migrationPlans.createdByUserId))
      .where(eq(migrationPlans.organizationId, ctx.organizationId))
      .orderBy(desc(migrationPlans.updatedAt))
      .limit(limit);
    const planIds = rows.map((r) => r.plan.id);
    const counts = planIds.length
      ? await this.db
          .select({ planId: migrationPlanEntities.planId })
          .from(migrationPlanEntities)
          .where(inArray(migrationPlanEntities.planId, planIds))
      : [];
    return rows.map((r) => ({
      id: r.plan.id,
      name: r.plan.name,
      status: r.plan.status,
      sourceEnvironment: envRef(r.src),
      targetEnvironment: envRef(r.tgt),
      tableCount: counts.filter((c) => c.planId === r.plan.id).length,
      blockerCount: countBySeverity(r.plan.issues ?? [], 'BLOCKER'),
      warningCount: countBySeverity(r.plan.issues ?? [], 'WARNING'),
      updatedAt: r.plan.updatedAt.toISOString(),
      createdBy: r.user ?? null,
    }));
  }
}

export function toMappingDto(m: MappingRow): FieldMappingDto {
  return {
    id: m.id,
    sourceField: m.sourceField,
    sourceDisplayName: m.sourceDisplayName,
    targetField: m.targetField,
    sourceType: m.sourceType as FieldMappingDto['sourceType'],
    targetType: m.targetType as FieldMappingDto['targetType'],
    status: m.status,
    confidence: m.confidence,
    reason: m.reason,
    isLookup: m.isLookup,
    lookupTargets: m.lookupTargets,
    required: m.required,
    deferred: m.deferred,
    compatibility: m.compatibility,
    transform: m.transform,
    choiceMap: m.choiceMap ?? null,
    deferredTargets: m.deferredTargets,
  };
}

/**
 * Which ownership/audit columns a table can preserve, given both schemas.
 *  - owner: written directly on create/update.
 *  - createdOn: written through the target's overriddencreatedon column.
 *  - createdBy/modifiedBy: only reachable by impersonating the mapped user.
 *  - touchField: a mapped column re-written in pass 3 to re-stamp modifiedby.
 */
export function auditCapability(source: TableMetadata, target: TableMetadata) {
  const sourceHas = (name: string) =>
    source.attributes.some((a) => a.logicalName === name && a.isValidForRead);
  const targetWritable = (name: string, onCreate = true) =>
    target.attributes.some(
      (a) => a.logicalName === name && (onCreate ? a.isValidForCreate : a.isValidForUpdate),
    );
  const touchSource = [target.primaryNameAttribute, ...target.attributes.map((a) => a.logicalName)].find(
    (name): name is string =>
      Boolean(name) &&
      sourceHas(name!) &&
      targetWritable(name!, false) &&
      !LOOKUP_TYPES.has(target.attributes.find((a) => a.logicalName === name)?.type ?? 'Other') &&
      !SYSTEM_MANAGED_COLUMNS.has(name!),
  );
  return {
    ownerField: sourceHas('ownerid') && targetWritable('ownerid') ? 'ownerid' : null,
    createdOnField: sourceHas('createdon') ? 'createdon' : null,
    createdByField: sourceHas('createdby') ? 'createdby' : null,
    modifiedByField: sourceHas('modifiedby') ? 'modifiedby' : null,
    overriddenCreatedOnField: targetWritable('overriddencreatedon') ? 'overriddencreatedon' : null,
    touchField: touchSource ? { source: touchSource, target: touchSource } : null,
  };
}
