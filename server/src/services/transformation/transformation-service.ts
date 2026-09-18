import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  isLossyRule,
  type LossyTransformationDto,
  type MigrationPlanDto,
  type PreviewFieldDto,
  type PreviewRecordDto,
  type TransformationRule,
  type TransformationTemplateDto,
  type TransformPreviewDto,
} from '../../../../shared/domain';
import type { AttributeMeta, DvRecord, FieldValue, TableMetadata } from '../../../../shared/metadata';
import type { AppDb } from '../../db/client';
import { fieldMappings, migrationPlanEntities, migrationPlans } from '../../db/schema';
import type { ConnectionFactory } from '../../dataverse/factory';
import { badRequest, notFound } from '../../lib/errors';
import type { AuditService } from '../audit-service';
import type { RequestContext } from '../context';
import type { EnvironmentService } from '../environment-service';
import type { MetadataService } from '../metadata-service';
import type { PlanningService } from '../planning-service';
import { display, transformField } from './engine';
import { BUILT_IN_TEMPLATES } from './templates';

/** Rows read for a preview. Bounded: a preview is a sample, never a scan. */
const PREVIEW_SAMPLE = 25;
const PREVIEW_SCAN_LIMIT = 500;

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

  /** Every configured transformation that will discard information, for the acknowledgement. */
  async lossyTransformations(ctx: RequestContext, planId: string): Promise<LossyTransformationDto[]> {
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
      for (const rule of m.transformations ?? []) {
        if (!isLossyRule(rule)) continue;
        out.push({
          table: entity.logicalName,
          field: m.sourceField,
          targetField: m.targetField,
          kind: rule.kind,
          key: `${entity.logicalName}.${m.sourceField}:${rule.kind}`,
          description: describeLossy(rule),
        });
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

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
    default:
      return 'Information is discarded';
  }
}

/** Re-exported so callers do not need to know where the value formatter lives. */
export { display as displayTransformedValue };
export type { FieldValue };
