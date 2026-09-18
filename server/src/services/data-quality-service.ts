import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  DataQualityIssueDto,
  DataQualityRuleDto,
  DataQualitySummaryDto,
  IssueRowDto,
  StatisticBasis,
  TableProfileDto,
} from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { fieldMappings, migrationPlanEntities, migrationPlans } from '../db/schema';
import { notFound } from '../lib/errors';
import type { RequestContext } from './context';
import { deriveTargetRules, type ProfilingService } from './profiling-service';
import type { EnvironmentService } from './environment-service';
import type { MetadataService } from './metadata-service';
import type { ConnectionFactory } from '../dataverse/factory';

/** Human-readable names for the issue codes the dashboard groups by. */
const CATEGORY_LABELS: Record<string, string> = {
  REQUIRED_VALUE_MISSING: 'Missing required values',
  STRING_TOO_LONG: 'Strings too long',
  INVALID_DATE: 'Invalid dates',
  INVALID_NUMBER: 'Invalid numbers',
  VALUE_MAP_MISSING: 'Unmapped choices',
  DUPLICATE_KEY: 'Duplicate keys',
  INVALID_EMAIL: 'Invalid emails',
  INVALID_PHONE: 'Invalid phone numbers',
  PRIMARY_KEY_MISSING: 'Missing primary keys',
  NUMERIC_OUT_OF_RANGE: 'Values outside the target range',
};

/**
 * Profiles a plan's source tables against the rules its target schema implies, and rolls the
 * findings up into the workspace summary.
 *
 * Everything here is read-only. The rules come from the target columns each source column is
 * actually mapped to, so "428 missing required values" means "428 records the target would
 * refuse", not a generic data-quality opinion.
 */
export class DataQualityService {
  constructor(
    private readonly db: AppDb,
    private readonly profiling: ProfilingService,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly logger: Logger,
  ) {}

  /** The rules one plan table implies, derived from the target columns it maps into. */
  async rulesForEntity(ctx: RequestContext, planId: string, entityId: string): Promise<DataQualityRuleDto[]> {
    const { plan, entity, mappings } = await this.loadEntity(ctx, planId, entityId);
    if (!entity.targetLogicalName) return [];
    const targetEnv = await this.environmentsSvc.getAccessible(ctx, plan.targetEnvironmentId);
    const tConn = await this.connections.connectorFor(targetEnv, ctx.userId, { requestId: ctx.requestId });
    const target = await this.metadata.getTable(targetEnv.id, tConn, entity.targetLogicalName);
    if (!target) return [];
    return deriveTargetRules(
      target,
      mappings
        .filter((m) => m.targetField && (m.status === 'AUTO_MAPPED' || m.status === 'MANUAL'))
        .map((m) => ({ sourceField: m.sourceField, targetField: m.targetField! })),
    );
  }

  /** Profiles one plan table with its target-derived rules applied. */
  async profileEntity(
    ctx: RequestContext,
    planId: string,
    entityId: string,
    opts: { sampleSize?: number; full?: boolean } = {},
  ): Promise<TableProfileDto> {
    const { plan, entity, mappings } = await this.loadEntity(ctx, planId, entityId);
    const rules = await this.rulesForEntity(ctx, planId, entityId);
    const mapped = mappings
      .filter((m) => m.targetField && (m.status === 'AUTO_MAPPED' || m.status === 'MANUAL'))
      .map((m) => ({ sourceField: m.sourceField, targetField: m.targetField! }));
    return this.profiling.profileTable(ctx, {
      environmentId: plan.sourceEnvironmentId,
      table: entity.logicalName,
      // Only the columns that are actually migrated: profiling a column nobody maps is noise.
      fields: mapped.length ? mapped.map((m) => m.sourceField) : undefined,
      rules,
      mappings: mapped,
      sampleSize: opts.sampleSize,
      full: opts.full,
    });
  }

  /** The workspace summary: every mapped table profiled, issues grouped by category. */
  async summary(
    ctx: RequestContext,
    planId: string,
    opts: { sampleSize?: number } = {},
  ): Promise<DataQualitySummaryDto & { profiles: TableProfileDto[] }> {
    const plan = await this.loadPlan(ctx, planId);
    const entities = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, plan.id))
      .orderBy(asc(migrationPlanEntities.orderIndex));

    const profiles: TableProfileDto[] = [];
    for (const entity of entities) {
      try {
        profiles.push(await this.profileEntity(ctx, planId, entity.id, opts));
      } catch (err) {
        // One unreadable table must not hide the findings of the others.
        this.logger.warn(
          { planId, table: entity.logicalName, err: (err as Error).message },
          'Profiling failed for a table',
        );
      }
    }

    const categories = new Map<string, { severity: 'BLOCKER' | 'WARNING'; count: number }>();
    let blockers = 0;
    let warnings = 0;
    const tables: DataQualitySummaryDto['tables'] = [];
    for (const profile of profiles) {
      const issues = [...profile.issues, ...profile.fields.flatMap((f) => f.issues)];
      let tableBlockers = 0;
      let tableWarnings = 0;
      for (const issue of issues) {
        const entry = categories.get(issue.code) ?? { severity: issue.severity, count: 0 };
        entry.count += issue.affected;
        // A category is as severe as its most severe finding.
        if (issue.severity === 'BLOCKER') entry.severity = 'BLOCKER';
        categories.set(issue.code, entry);
        if (issue.severity === 'BLOCKER') {
          blockers += issue.affected;
          tableBlockers += issue.affected;
        } else {
          warnings += issue.affected;
          tableWarnings += issue.affected;
        }
      }
      tables.push({
        table: profile.table,
        displayName: profile.displayName,
        blockers: tableBlockers,
        warnings: tableWarnings,
      });
    }

    // Sampled anywhere means sampled overall: a summary must not look more certain than its parts.
    const basis: StatisticBasis = profiles.every((p) => p.basis === 'EXACT') ? 'EXACT' : 'SAMPLED';
    return {
      planId,
      tablesAnalyzed: profiles.length,
      recordsProfiled: profiles.reduce((n, p) => n + p.examined, 0),
      basis,
      blockers,
      warnings,
      categories: [...categories.entries()]
        .map(([code, v]) => ({
          code,
          label: CATEGORY_LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase(),
          severity: v.severity,
          count: v.count,
        }))
        .sort((a, b) => b.count - a.count),
      tables,
      profiledAt: new Date().toISOString(),
      profiles,
    };
  }

  /** The data-quality findings as remediation rows, for the shared issues export. */
  async issueRows(ctx: RequestContext, planId: string): Promise<IssueRowDto[]> {
    const summary = await this.summary(ctx, planId, { sampleSize: 5_000 });
    const rows: IssueRowDto[] = [];
    for (const profile of summary.profiles) {
      const all: { issue: DataQualityIssueDto; field: string | null }[] = [
        ...profile.issues.map((issue) => ({ issue, field: issue.field })),
        ...profile.fields.flatMap((f) => f.issues.map((issue) => ({ issue, field: f.field }))),
      ];
      for (const { issue, field } of all) {
        const samples = issue.samples?.length ? issue.samples : [null];
        for (const sample of samples) {
          rows.push({
            severity: issue.severity,
            category: CATEGORY_LABELS[issue.code] ?? issue.code,
            table: profile.table,
            sourceRecordId: sample?.recordId ?? null,
            recordName: null,
            field,
            sourceValue: sample?.value ?? null,
            targetValue: null,
            issue:
              issue.basis === 'EXACT'
                ? `${issue.message} (${issue.affected} record(s))`
                : `${issue.message} (${issue.affected} record(s) in the profiled sample)`,
            resolution: issue.resolution ?? null,
            suggestedAction: suggestedAction(issue.code),
          });
        }
      }
    }
    return rows;
  }

  private async loadPlan(ctx: RequestContext, planId: string) {
    const [plan] = await this.db
      .select()
      .from(migrationPlans)
      .where(and(eq(migrationPlans.id, planId), eq(migrationPlans.organizationId, ctx.organizationId)));
    if (!plan) throw notFound('Migration plan');
    return plan;
  }

  private async loadEntity(ctx: RequestContext, planId: string, entityId: string) {
    const plan = await this.loadPlan(ctx, planId);
    const [entity] = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(and(eq(migrationPlanEntities.id, entityId), eq(migrationPlanEntities.planId, planId)));
    if (!entity) throw notFound('Plan table');
    const mappings = await this.db
      .select()
      .from(fieldMappings)
      .where(inArray(fieldMappings.planEntityId, [entity.id]));
    return { plan, entity, mappings };
  }
}

function suggestedAction(code: string): string {
  switch (code) {
    case 'REQUIRED_VALUE_MISSING':
      return 'Add a DEFAULT_IF_BLANK transformation or fix the source data';
    case 'STRING_TOO_LONG':
      return 'Configure TRUNCATE (lossy) or shorten the source values';
    case 'VALUE_MAP_MISSING':
      return 'Map the value, exclude it, or set a default choice';
    case 'INVALID_DATE':
      return 'Configure the input format for this column';
    case 'DUPLICATE_KEY':
      return 'De-duplicate the source or choose a different match key';
    case 'INVALID_EMAIL':
      return 'Clean the source values; the target expects an email address';
    default:
      return 'Review before migrating';
  }
}
