import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { DashboardDto, MigrationScheduleDto, ProfileDto } from '../../../shared/domain';
import type { DvRecord } from '../../../shared/metadata';
import type { AppDb } from '../db/client';
import {
  analysisRuns,
  migrationPlans,
  migrationSchedules,
  projects,
  migrationRuns,
  validationRuns,
} from '../db/schema';
import type { ConnectionFactory } from '../dataverse/factory';
import { notFound } from '../lib/errors';
import type { AnalysisService } from './analysis-service';
import type { ComparisonService } from './comparison-service';
import type { RequestContext } from './context';
import { integrationError, type EnvironmentService } from './environment-service';
import type { MetadataService } from './metadata-service';
import type { MigrationRunService } from './migration-run-service';
import type { ProjectService } from './project-service';
import type { ValidationService } from './validation-service';
import { describeCron } from '../lib/cron';
import { displayValue } from './values';

const PROFILE_SAMPLE = 200;

/**
 * A schedule as the dashboard needs it. The warning fields are left as the schedule recorded them:
 * the dashboard is a glance, and re-deriving each plan's current warnings to fill them would mean a
 * full plan validation per schedule.
 */
const scheduleSummary = (
  row: typeof migrationSchedules.$inferSelect,
  planName: string,
): MigrationScheduleDto => ({
  id: row.id,
  planId: row.planId,
  planName,
  name: row.name,
  cron: row.cron,
  timeZone: row.timeZone,
  description: describeCron(row.cron),
  enabled: row.enabled,
  mode: row.mode,
  watermarkField: row.watermarkField,
  lastWatermark: row.lastWatermark,
  acknowledgedWarnings: row.acknowledgedWarnings,
  unreviewedWarnings: [],
  nextRunAt: row.nextRunAt?.toISOString() ?? null,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  lastRunId: row.lastRunId,
  lastStatus: row.lastStatus,
  lastError: row.lastError,
  consecutiveFailures: row.consecutiveFailures,
  pausedReason: row.pausedReason,
  createdBy: null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Data profiling and dashboard read models. */
export class InsightsService {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly comparisons: ComparisonService,
    private readonly runs: MigrationRunService,
    private readonly validations: ValidationService,
    private readonly projectsSvc: ProjectService,
    private readonly analysis: AnalysisService,
  ) {}

  async profile(ctx: RequestContext, environmentId: string, table: string): Promise<ProfileDto> {
    const env = await this.environmentsSvc.getAccessible(ctx, environmentId);
    const conn = await this.connections.connectorFor(env, ctx.userId, { requestId: ctx.requestId });
    try {
      const meta = await this.metadata.getTable(env.id, conn, table);
      if (!meta) throw notFound('Table');
      const count = await this.metadata.count(env.id, conn, meta, true);
      const columns = meta.attributes
        .filter(
          (a) =>
            !a.attributeOf &&
            a.isValidForRead &&
            !['Virtual', 'EntityName', 'Image', 'File', 'Other'].includes(a.type),
        )
        .slice(0, 40);
      const sample: DvRecord[] = [];
      for await (const page of conn.queryRecords(
        meta,
        columns.map((c) => c.logicalName),
        { pageSize: PROFILE_SAMPLE },
      )) {
        sample.push(...page);
        if (sample.length >= PROFILE_SAMPLE) break;
      }
      const nullStats = columns
        .filter((c) => !c.isPrimaryId)
        .map((c) => {
          const nulls = sample.filter(
            (r) =>
              r.values[c.logicalName] === null ||
              r.values[c.logicalName] === undefined ||
              r.values[c.logicalName] === '',
          ).length;
          return {
            field: c.logicalName,
            displayName: c.displayName,
            nullCount: nulls,
            nullPercent: sample.length ? Math.round((nulls / sample.length) * 1000) / 10 : 0,
          };
        });
      const byName = new Map(columns.map((c) => [c.logicalName, c]));
      return {
        environmentId: env.id,
        table,
        count: count.count,
        countApproximate: count.approximate,
        primaryIdAttribute: meta.primaryIdAttribute,
        primaryNameAttribute: meta.primaryNameAttribute,
        sampleSize: sample.length,
        nullStats,
        sampleRecords: sample.slice(0, 5).map((r) => ({
          id: r.id,
          values: Object.fromEntries(
            Object.entries(r.values).map(([k, v]) => [k, displayValue(byName.get(k), v)]),
          ),
        })),
      };
    } catch (err) {
      throw integrationError(err, 'Profiling');
    }
  }

  async dashboard(ctx: RequestContext): Promise<DashboardDto> {
    const envs = await this.environmentsSvc.list(ctx);
    const runStatus = await this.db
      .select({ status: migrationRuns.status, n: count() })
      .from(migrationRuns)
      .where(eq(migrationRuns.organizationId, ctx.organizationId))
      .groupBy(migrationRuns.status);
    const valOutcome = await this.db
      .select({ outcome: validationRuns.outcome, n: count() })
      .from(validationRuns)
      .where(
        and(
          eq(validationRuns.organizationId, ctx.organizationId),
          inArray(validationRuns.status, ['COMPLETED']),
        ),
      )
      .groupBy(validationRuns.outcome);
    const [valTotal] = await this.db
      .select({ n: count() })
      .from(validationRuns)
      .where(eq(validationRuns.organizationId, ctx.organizationId));
    const byStatus = (s: string[]) =>
      runStatus.filter((r) => s.includes(r.status)).reduce((n, r) => n + Number(r.n), 0);
    const byOutcome = (o: string) => Number(valOutcome.find((v) => v.outcome === o)?.n ?? 0);
    const recentValidations = await this.validations.list(ctx, 5);

    // The project half of the picture. Counted rather than listed where a count is the answer.
    const projectRows = await this.db
      .select({ kind: projects.kind, n: count() })
      .from(projects)
      .where(and(eq(projects.organizationId, ctx.organizationId), eq(projects.status, 'ACTIVE')))
      .groupBy(projects.kind);
    const projectCount = (kind: string) => Number(projectRows.find((r) => r.kind === kind)?.n ?? 0);

    const analysisRows = await this.db
      .select({ status: analysisRuns.status, totals: analysisRuns.totals })
      .from(analysisRuns)
      .where(eq(analysisRuns.organizationId, ctx.organizationId));

    const scheduleRows = await this.db
      .select({
        schedule: migrationSchedules,
        planName: migrationPlans.name,
      })
      .from(migrationSchedules)
      .innerJoin(migrationPlans, eq(migrationPlans.id, migrationSchedules.planId))
      .where(eq(migrationSchedules.organizationId, ctx.organizationId))
      .orderBy(asc(migrationSchedules.nextRunAt));

    const recentProjects = (await this.projectsSvc.list(ctx as RequestContext)).slice(0, 5);
    const recentAnalyses = (
      await Promise.all(
        recentProjects
          .filter((p) => p.kind === 'ANALYSIS')
          .map((p) => this.analysis.list(ctx as RequestContext, p.id)),
      )
    )
      .flat()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5);
    const [lastComparison] = await this.comparisons.list(ctx, {}, 1);
    return {
      environments: {
        total: envs.length,
        connected: envs.filter((e) => e.connectionStatus === 'CONNECTED').length,
      },
      projects: { analysis: projectCount('ANALYSIS'), migration: projectCount('MIGRATION') },
      analyses: {
        total: analysisRows.length,
        completed: analysisRows.filter((r) => r.status === 'COMPLETED').length,
        active: analysisRows.filter((r) => r.status === 'QUEUED' || r.status === 'RUNNING').length,
        blockers: analysisRows.reduce((n, r) => n + (r.totals?.blockers ?? 0), 0),
      },
      schedules: {
        total: scheduleRows.length,
        enabled: scheduleRows.filter((r) => r.schedule.enabled).length,
        paused: scheduleRows.filter((r) => !r.schedule.enabled).length,
        // Anything a person has to look at: paused by repeated failure, or last firing failed.
        needsAttention: scheduleRows.filter(
          (r) => r.schedule.pausedReason !== null || r.schedule.lastStatus === 'FAILED',
        ).length,
      },
      recentProjects,
      recentAnalyses,
      upcomingSchedules: scheduleRows
        .filter((r) => r.schedule.enabled && r.schedule.nextRunAt !== null)
        .slice(0, 5)
        .map((r) => scheduleSummary(r.schedule, r.planName)),
      migrationRuns: {
        total: runStatus.reduce((n, r) => n + Number(r.n), 0),
        completed: byStatus(['COMPLETED']),
        withErrors: byStatus(['COMPLETED_WITH_ERRORS']),
        failed: byStatus(['FAILED']),
        active: byStatus(['QUEUED', 'RUNNING', 'PAUSED']),
      },
      validationRuns: {
        total: Number(valTotal?.n ?? 0),
        pass: byOutcome('PASS'),
        warning: byOutcome('WARNING'),
        fail: byOutcome('FAIL'),
      },
      recentMigrationRuns: await this.runs.list(ctx, 5),
      recentValidationRuns: recentValidations.map((v) => ({
        id: v.id,
        status: v.status,
        outcome: v.outcome,
        sourceEnvironment: v.sourceEnvironment,
        targetEnvironment: v.targetEnvironment,
        createdAt: v.createdAt,
      })),
      lastComparison: lastComparison ?? null,
    };
  }
}
