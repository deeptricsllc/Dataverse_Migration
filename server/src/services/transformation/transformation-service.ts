import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  isLossyRule,
  type LossyRecordDto,
  type LossyTransformationDto,
  type MigrationPlanDto,
  type PreviewFieldDto,
  type PreviewRecordDto,
  type TransformationKind,
  type TransformationRule,
  type TransformationTemplateDto,
  type TransformPreviewDto,
} from '../../../../shared/domain';
import type { AttributeMeta, DvRecord, FieldValue, TableMetadata } from '../../../../shared/metadata';
import type { AppDb } from '../../db/client';
import {
  fieldMappings,
  migrationPlanEntities,
  migrationPlans,
  preflightEntityResults,
  preflightRecords,
  preflightRuns,
} from '../../db/schema';
import type { ConnectionFactory } from '../../dataverse/factory';
import { badRequest, notFound } from '../../lib/errors';
import type { AuditService } from '../audit-service';
import type { RequestContext } from '../context';
import type { EnvironmentService } from '../environment-service';
import type { MetadataService } from '../metadata-service';
import type { PlanningService } from '../planning-service';
import { display, lostSteps, transformField } from './engine';
import { BUILT_IN_TEMPLATES } from './templates';

/** Rows read for a preview. Bounded: a preview is a sample, never a scan. */
const PREVIEW_SAMPLE = 25;
const PREVIEW_SCAN_LIMIT = 500;

/**
 * Rows read when no preflight has measured the loss yet. A bounded scan can only produce a floor,
 * which is why anything it reports is labelled SAMPLED rather than presented as a total.
 */
const LOSS_SCAN_LIMIT = 5_000;

type PlanRow = typeof migrationPlans.$inferSelect;
type EntityRow = typeof migrationPlanEntities.$inferSelect;
type MappingRow = typeof fieldMappings.$inferSelect;

/**
 * Configures and previews transformations.
 *
 * Every preview runs the same `transformField` that preflight, migration and validation run, over
 * real source values read from the source connection. It is deliberately not a front-end
 * approximation: a preview that can disagree with the migration is worse than no preview.
 */
export class TransformationService {
  constructor(
    private readonly db: AppDb,
    private readonly planning: PlanningService,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  templates(): TransformationTemplateDto[] {
    return BUILT_IN_TEMPLATES;
  }

  /** Replaces the ordered pipeline of one field mapping. */
  async updatePipeline(
    ctx: RequestContext,
    planId: string,
    mappingId: string,
    rules: TransformationRule[],
  ): Promise<MigrationPlanDto> {
    const { plan, mapping } = await this.loadMapping(ctx, planId, mappingId);
    await this.db
      .update(fieldMappings)
      .set({ transformations: rules, updatedByUserId: ctx.userId, updatedAt: new Date() })
      .where(eq(fieldMappings.id, mapping.id));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'TRANSFORMATION_CHANGED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: plan.sourceEnvironmentId,
      targetEnvironmentId: plan.targetEnvironmentId,
      runId: plan.id,
      requestId: ctx.requestId,
      details: {
        field: mapping.sourceField,
        rules: rules.map((r) => r.kind),
        lossy: rules.filter(isLossyRule).map((r) => r.kind),
      },
    });
    // Re-validating recomputes the plan's issues against the new pipeline.
    return this.planning.revalidate(ctx, planId);
  }

  /**
   * Runs a candidate pipeline over real source values. Used while editing, before anything is
   * saved, so a user sees what a rule does to their own data rather than to an example.
   */
  async previewField(
    ctx: RequestContext,
    planId: string,
    mappingId: string,
    rules: TransformationRule[] | null,
  ): Promise<TransformPreviewDto> {
    const { plan, mapping, entity } = await this.loadMapping(ctx, planId, mappingId);
    const { source, target, sConn } = await this.metaFor(ctx, plan, entity);
    const sAttr = source.attributes.find((a) => a.logicalName === mapping.sourceField);
    if (!sAttr) throw badRequest('That source column no longer exists');
    const tAttr = mapping.targetField
      ? target?.attributes.find((a) => a.logicalName === mapping.targetField)
      : undefined;
    if (!tAttr) throw badRequest('Map this column to a target column before previewing transformations');

    const effective = rules ?? mapping.transformations ?? [];
    const sourceAttributes = new Map(source.attributes.map((a) => [a.logicalName, a]));
    const rows: TransformPreviewDto['rows'] = [];
    const seen = new Set<string>();
    let scanned = 0;

    // Prefer distinct values: fifty rows that are all "Active" teach nobody anything.
    outer: for await (const page of sConn.queryRecords(source, this.previewColumns(effective, mapping), {
      pageSize: 100,
    })) {
      for (const record of page) {
        scanned++;
        const raw = record.values[mapping.sourceField] ?? null;
        const key = display(raw) ?? '<<null>>';
        if (seen.has(key)) continue;
        seen.add(key);
        const result = transformField({
          value: raw,
          source: sAttr,
          target: tAttr,
          rules: effective,
          legacyTransform: mapping.transform,
          choiceMap: mapping.choiceMap,
          context: { record, sourceAttributes },
        });
        const error = result.issues.find((i) => i.severity === 'ERROR');
        const warning = result.issues.find((i) => i.severity === 'WARNING');
        rows.push({
          sourceValue: this.mask(sAttr, display(raw)),
          transformedValue: result.ok ? this.mask(sAttr, display(result.value)) : null,
          status: result.ok ? (warning ? 'WARNING' : 'OK') : 'BLOCKED',
          message: error?.message ?? warning?.message ?? null,
          applied: result.applied.map((a) => ({
            ...a,
            before: this.mask(sAttr, a.before),
            after: this.mask(sAttr, a.after),
          })),
        });
        if (rows.length >= PREVIEW_SAMPLE || scanned >= PREVIEW_SCAN_LIMIT) break outer;
      }
    }

    return {
      field: mapping.sourceField,
      targetField: mapping.targetField,
      rows,
      previewed: rows.length,
      valid: rows.filter((r) => r.status === 'OK').length,
      warnings: rows.filter((r) => r.status === 'WARNING').length,
      blocked: rows.filter((r) => r.status === 'BLOCKED').length,
      lossy: effective.some(isLossyRule),
      sampled: scanned >= PREVIEW_SCAN_LIMIT,
    };
  }

  /**
   * A record-level before/after view: source value, transformed value and what the target holds
   * today, for a handful of records. This is the screen that answers "what will this actually do".
   */
  async previewRecords(
    ctx: RequestContext,
    planId: string,
    entityId: string,
    limit = 10,
  ): Promise<PreviewRecordDto[]> {
    const plan = await this.loadPlan(ctx, planId);
    const [entity] = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(and(eq(migrationPlanEntities.id, entityId), eq(migrationPlanEntities.planId, planId)));
    if (!entity) throw notFound('Plan table');
    const { source, target, sConn, tConn } = await this.metaFor(ctx, plan, entity);
    if (!target) throw badRequest('Map this table to a target table before previewing records');

    const mappings = await this.db
      .select()
      .from(fieldMappings)
      .where(eq(fieldMappings.planEntityId, entity.id))
      .orderBy(asc(fieldMappings.sourceField));
    const active = mappings.filter(
      (m) => m.targetField && (m.status === 'AUTO_MAPPED' || m.status === 'MANUAL'),
    );
    const sourceAttributes = new Map(source.attributes.map((a) => [a.logicalName, a]));
    const targetAttributes = new Map(target.attributes.map((a) => [a.logicalName, a]));

    const records: DvRecord[] = [];
    for await (const page of sConn.queryRecords(
      source,
      active.map((m) => m.sourceField),
      { pageSize: Math.min(limit, 50) },
    )) {
      records.push(...page);
      if (records.length >= limit) break;
    }
    const sample = records.slice(0, limit);

    // What the target holds today, matched the way the migration matches records.
    const targetColumns = active.map((m) => m.targetField!);
    const existing = new Map<string, DvRecord>();
    if (sample.length && entity.matchStrategy === 'PRIMARY_ID') {
      const found = await tConn.retrieveByIds(
        target,
        sample.map((r) => r.id),
        targetColumns,
      );
      for (const r of found) existing.set(r.id.toLowerCase(), r);
    }

    const out: PreviewRecordDto[] = [];
    for (const record of sample) {
      const fields: PreviewFieldDto[] = [];
      let blocked = false;
      for (const m of active) {
        const sAttr = sourceAttributes.get(m.sourceField);
        const tAttr = targetAttributes.get(m.targetField!);
        if (!sAttr || !tAttr) continue;
        const raw = record.values[m.sourceField] ?? null;
        const result = transformField({
          value: raw,
          source: sAttr,
          target: tAttr,
          rules: m.transformations,
          legacyTransform: m.transform,
          choiceMap: m.choiceMap,
          context: { record, sourceAttributes },
        });
        if (!result.ok) blocked = true;
        const current = existing.get(record.id.toLowerCase())?.values[m.targetField!] ?? null;
        const transformed = result.ok ? display(result.value) : null;
        fields.push({
          field: m.sourceField,
          targetField: m.targetField,
          sourceValue: this.mask(sAttr, display(raw)),
          transformedValue: this.mask(sAttr, transformed),
          targetValue: this.mask(tAttr, display(current)),
          applied: result.applied,
          issues: result.issues,
          changed: result.ok && display(current) !== transformed,
        });
      }
      const matched = existing.get(record.id.toLowerCase());
      out.push({
        sourceRecordId: record.id,
        recordName: source.primaryNameAttribute ? display(record.values[source.primaryNameAttribute]) : null,
        targetRecordId: matched?.id ?? null,
        action: blocked
          ? 'BLOCKED'
          : !matched
            ? 'CREATE'
            : fields.some((f) => f.changed)
              ? 'UPDATE'
              : 'UNCHANGED',
        reason: blocked ? 'A transformation cannot produce a value for this record' : null,
        fields,
      });
    }
    return out;
  }

  /**
   * Every configured transformation that will discard information, with how many records it
   * actually affects, for the acknowledgement.
   *
   * The count is measured, never assumed: a completed preflight already read every record and
   * knows exactly which values lost something, so its numbers are preferred. Without one, a
   * bounded scan through the same engine gives a floor, which is reported as SAMPLED.
   */
  async lossyTransformations(
    ctx: RequestContext,
    planId: string,
    opts: { scanLimit?: number } = {},
  ): Promise<LossyTransformationDto[]> {
    const plan = await this.loadPlan(ctx, planId);
    const entities = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, plan.id));
    if (entities.length === 0) return [];
    const mappings = await this.db
      .select()
      .from(fieldMappings)
      .where(
        inArray(
          fieldMappings.planEntityId,
          entities.map((e) => e.id),
        ),
      );
    const byEntity = new Map(entities.map((e) => [e.id, e]));
    const out: LossyTransformationDto[] = [];
    for (const m of mappings) {
      if (m.status !== 'AUTO_MAPPED' && m.status !== 'MANUAL') continue;
      const entity = byEntity.get(m.planEntityId);
      if (!entity) continue;
      // A lossy rule nested inside a conditional still discards data, so the acknowledgement
      // has to see it too: otherwise wrapping TRUNCATE in an IF_THEN would skip the gate.
      for (const rule of flattenRules(m.transformations ?? [])) {
        if (!isLossyRule(rule)) continue;
        out.push({
          table: entity.logicalName,
          field: m.sourceField,
          targetTable: entity.targetLogicalName,
          targetField: m.targetField,
          kind: rule.kind,
          key: `${entity.logicalName}.${m.sourceField}:${rule.kind}`,
          description: describeLossy(rule),
          affected: null,
          examined: null,
          basis: null,
          maxSourceLength: null,
          targetMaxLength: limitOf(rule),
          fromPreflight: false,
        });
      }
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    await this.measureLoss(ctx, plan, entities, mappings, out, opts.scanLimit ?? LOSS_SCAN_LIMIT);
    return out;
  }

  /**
   * The records one lossy transformation actually changed, for the drill-down and the export.
   *
   * Only a preflight can answer this: it is the pass that looked at every record and kept what
   * each one lost. Values from a secured column were masked when the preflight stored them, so
   * nothing here can unmask them.
   */
  async lossyRecords(
    ctx: RequestContext,
    planId: string,
    filter: { key?: string; limit: number; offset: number },
  ): Promise<{ items: LossyRecordDto[]; total: number; preflightId: string | null }> {
    const plan = await this.loadPlan(ctx, planId);
    const pf = await this.latestMeasuredPreflight(ctx, plan.id);
    if (!pf) return { items: [], total: 0, preflightId: null };
    const target = filter.key ? parseKey(filter.key) : null;
    if (filter.key && !target) return { items: [], total: 0, preflightId: pf.id };
    const where = [
      eq(preflightRecords.preflightRunId, pf.id),
      sql`jsonb_array_length(${preflightRecords.lossy}) > 0`,
    ];
    if (target) where.push(eq(preflightRecords.logicalName, target.table));
    const rows = await this.db
      .select()
      .from(preflightRecords)
      .where(and(...where))
      .orderBy(asc(preflightRecords.sourceRecordId));

    const items: LossyRecordDto[] = [];
    for (const row of rows) {
      for (const detail of row.lossy) {
        if (target && (detail.field !== target.field || detail.kind !== target.kind)) continue;
        items.push({
          table: row.logicalName,
          sourceRecordId: row.sourceRecordId,
          recordName: row.recordName,
          field: detail.field,
          targetField: detail.targetField,
          kind: detail.kind,
          originalValue: detail.before,
          transformedValue: detail.after,
          loss: detail.loss,
        });
      }
    }
    return {
      items: items.slice(filter.offset, filter.offset + filter.limit),
      total: items.length,
      preflightId: pf.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Fills in how many records each lossy transformation actually changes.
   *
   * A completed preflight wins: it examined every record with the same engine, so its count is
   * the real one. Only what it did not cover falls back to a bounded scan.
   */
  private async measureLoss(
    ctx: RequestContext,
    plan: PlanRow,
    entities: EntityRow[],
    mappings: MappingRow[],
    items: LossyTransformationDto[],
    scanLimit: number,
  ): Promise<void> {
    if (items.length === 0) return;
    const pf = await this.latestMeasuredPreflight(ctx, plan.id);
    if (pf) {
      const impact = new Map(pf.lossyImpact.map((i) => [i.key, i]));
      const covered = await this.db
        .select({
          logicalName: preflightEntityResults.logicalName,
          totals: preflightEntityResults.totals,
          sampled: preflightEntityResults.sampled,
        })
        .from(preflightEntityResults)
        .where(eq(preflightEntityResults.preflightRunId, pf.id));
      const perTable = new Map(covered.map((e) => [e.logicalName, e]));
      for (const item of items) {
        const table = perTable.get(item.table);
        if (!table) continue;
        const hit = impact.get(item.key);
        // A key the preflight did not report is a rule that ran but never discarded anything:
        // zero affected records, which is exactly what the acknowledgement should say.
        item.affected = hit?.affected ?? 0;
        item.examined = table.totals?.analysed ?? 0;
        // A preflight that stopped at the per-table cap read a prefix of the table, not all of it.
        item.basis = table.sampled ? 'SAMPLED' : 'EXACT';
        item.maxSourceLength = hit?.maxSourceLength ?? null;
        item.fromPreflight = true;
      }
    }
    const pending = items.filter((i) => i.basis === null);
    if (pending.length > 0) await this.sampleLoss(ctx, plan, entities, mappings, pending, scanLimit);
  }

  /** The newest preflight that ran to completion, and therefore measured the loss. */
  private async latestMeasuredPreflight(ctx: RequestContext, planId: string) {
    const [pf] = await this.db
      .select({ id: preflightRuns.id, lossyImpact: preflightRuns.lossyImpact })
      .from(preflightRuns)
      .where(
        and(
          eq(preflightRuns.planId, planId),
          eq(preflightRuns.organizationId, ctx.organizationId),
          eq(preflightRuns.status, 'COMPLETED'),
        ),
      )
      .orderBy(desc(preflightRuns.createdAt))
      .limit(1);
    return pf ?? null;
  }

  /**
   * A bounded scan for the transformations no preflight has measured, through the same
   * `transformField` everything else runs. It can only report a floor, so its numbers are
   * labelled SAMPLED unless the table ended before the cap.
   */
  private async sampleLoss(
    ctx: RequestContext,
    plan: PlanRow,
    entities: EntityRow[],
    mappings: MappingRow[],
    pending: LossyTransformationDto[],
    scanLimit: number,
  ): Promise<void> {
    const byTable = new Map<string, LossyTransformationDto[]>();
    for (const item of pending) {
      const list = byTable.get(item.table) ?? [];
      list.push(item);
      byTable.set(item.table, list);
    }
    for (const [table, group] of byTable) {
      const entity = entities.find((e) => e.logicalName === table);
      if (!entity) continue;
      let meta: Awaited<ReturnType<TransformationService['metaFor']>>;
      try {
        meta = await this.metaFor(ctx, plan, entity);
      } catch (err) {
        // The acknowledgement still has to render when the source is unreachable; it simply
        // cannot say how many records are affected.
        this.logger.warn({ err, table }, 'lossy impact sample skipped');
        continue;
      }
      const { source, target, sConn } = meta;
      if (!target) continue;
      const sourceAttributes = new Map(source.attributes.map((a) => [a.logicalName, a]));
      const targetAttributes = new Map(target.attributes.map((a) => [a.logicalName, a]));
      const fields = new Set(group.map((g) => g.field));
      const active = mappings.filter(
        (m) => m.planEntityId === entity.id && m.targetField && fields.has(m.sourceField),
      );
      const columns = new Set<string>();
      for (const m of active) {
        for (const c of this.previewColumns(m.transformations ?? [], m)) columns.add(c);
      }
      const counts = new Map<string, { affected: number; maxSourceLength: number | null }>();
      let scanned = 0;
      for await (const page of sConn.queryRecords(source, [...columns], { pageSize: 500 })) {
        for (const record of page) {
          scanned++;
          for (const m of active) {
            const sAttr = sourceAttributes.get(m.sourceField);
            const tAttr = targetAttributes.get(m.targetField!);
            if (!sAttr || !tAttr) continue;
            const raw = record.values[m.sourceField] ?? null;
            const result = transformField({
              value: raw,
              source: sAttr,
              target: tAttr,
              rules: m.transformations,
              legacyTransform: m.transform,
              choiceMap: m.choiceMap,
              context: { record, sourceAttributes },
            });
            // The same signal the preflight counts: a step that reports it discarded something,
            // not merely a step that ran.
            for (const step of lostSteps(result.applied)) {
              const key = `${table}.${m.sourceField}:${step.kind}`;
              const entry = counts.get(key) ?? { affected: 0, maxSourceLength: null };
              entry.affected++;
              if (typeof raw === 'string') {
                entry.maxSourceLength = Math.max(entry.maxSourceLength ?? 0, raw.length);
              }
              counts.set(key, entry);
            }
          }
          if (scanned >= scanLimit) break;
        }
        if (scanned >= scanLimit) break;
      }
      for (const item of group) {
        const hit = counts.get(item.key);
        item.affected = hit?.affected ?? 0;
        item.examined = scanned;
        // Stopping at the cap leaves the rest of the table unread, so the number is a floor.
        // Reaching the end of the table means every record was examined after all.
        item.basis = scanned >= scanLimit ? 'SAMPLED' : 'EXACT';
        item.maxSourceLength = hit?.maxSourceLength ?? null;
      }
    }
  }

  /** Columns a preview has to read: the mapped column plus anything CONCAT or a condition needs. */
  private previewColumns(rules: TransformationRule[], mapping: { sourceField: string }): string[] {
    const columns = new Set<string>([mapping.sourceField]);
    const walk = (list: TransformationRule[]) => {
      for (const rule of list) {
        for (const part of rule.parts ?? []) if (part.field) columns.add(part.field);
        if (rule.condition?.field) columns.add(rule.condition.field);
        if (rule.then?.length) walk(rule.then);
      }
    };
    walk(rules);
    return [...columns];
  }

  /** Secured columns are masked everywhere a value is shown, previews included. */
  private mask(attr: AttributeMeta | undefined, value: string | null): string | null {
    if (!attr?.isSecured || value === null) return value;
    return '***';
  }

  private async loadPlan(ctx: RequestContext, planId: string) {
    const [plan] = await this.db
      .select()
      .from(migrationPlans)
      .where(and(eq(migrationPlans.id, planId), eq(migrationPlans.organizationId, ctx.organizationId)));
    if (!plan) throw notFound('Migration plan');
    return plan;
  }

  private async loadMapping(ctx: RequestContext, planId: string, mappingId: string) {
    const plan = await this.loadPlan(ctx, planId);
    const [row] = await this.db
      .select({ mapping: fieldMappings, entity: migrationPlanEntities })
      .from(fieldMappings)
      .innerJoin(migrationPlanEntities, eq(migrationPlanEntities.id, fieldMappings.planEntityId))
      .where(and(eq(fieldMappings.id, mappingId), eq(migrationPlanEntities.planId, planId)));
    if (!row) throw notFound('Field mapping');
    return { plan, mapping: row.mapping, entity: row.entity };
  }

  private async metaFor(
    ctx: RequestContext,
    plan: { sourceEnvironmentId: string; targetEnvironmentId: string },
    entity: { logicalName: string; targetLogicalName: string | null },
  ): Promise<{
    source: TableMetadata;
    target: TableMetadata | undefined;
    sConn: Awaited<ReturnType<ConnectionFactory['connectorFor']>>;
    tConn: Awaited<ReturnType<ConnectionFactory['connectorFor']>>;
  }> {
    const sourceEnv = await this.environmentsSvc.getAccessible(ctx, plan.sourceEnvironmentId);
    const targetEnv = await this.environmentsSvc.getAccessible(ctx, plan.targetEnvironmentId);
    const sConn = await this.connections.connectorFor(sourceEnv, ctx.userId, { requestId: ctx.requestId });
    const tConn = await this.connections.connectorFor(targetEnv, ctx.userId, { requestId: ctx.requestId });
    const source = await this.metadata.getTable(sourceEnv.id, sConn, entity.logicalName);
    if (!source) throw notFound('Source table');
    const target = entity.targetLogicalName
      ? await this.metadata.getTable(targetEnv.id, tConn, entity.targetLogicalName)
      : undefined;
    return { source, target, sConn, tConn };
  }
}

/** Every rule in a pipeline, including the ones a conditional would run. */
function flattenRules(rules: TransformationRule[]): TransformationRule[] {
  return rules.flatMap((rule) => [rule, ...flattenRules(rule.then ?? [])]);
}

/**
 * The length a rule cuts values to. For a TRUNCATE derived from the target column, this is that
 * column's maximum length, which is the number the acknowledgement shows next to it.
 */
function limitOf(rule: TransformationRule): number | null {
  return rule.kind === 'TRUNCATE' || rule.kind === 'SUBSTRING' ? (rule.length ?? null) : null;
}

/** Splits `table.field:RULE` back into its parts. */
function parseKey(key: string): { table: string; field: string; kind: TransformationKind } | null {
  const [path, kind] = key.split(':');
  if (!path || !kind) return null;
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || dot === path.length - 1) return null;
  return { table: path.slice(0, dot), field: path.slice(dot + 1), kind: kind as TransformationKind };
}

function describeLossy(rule: TransformationRule): string {
  switch (rule.kind) {
    case 'TRUNCATE':
      return `Values longer than ${rule.length ?? 0} characters are cut to ${rule.length ?? 0}`;
    case 'SUBSTRING':
      return `Only characters ${rule.start ?? 0}–${(rule.start ?? 0) + (rule.length ?? 0)} are kept`;
    case 'TO_DATE':
      return 'The time of day is dropped, keeping only the date';
    case 'TO_INTEGER':
      return 'Decimal digits are dropped';
    case 'TO_DECIMAL':
      return `Values are rounded to ${rule.scale ?? 0} decimal place(s)`;
    default:
      return 'Information is discarded';
  }
}

/** Re-exported so callers do not need to know where the value formatter lives. */
export { display as displayTransformedValue };
export type { FieldValue };
