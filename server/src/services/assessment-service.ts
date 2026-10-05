import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AnalysisAssessmentDto } from '../../../shared/domain';
import { findingsForTable, sortFindings, type Finding } from '../../../shared/findings';
import { assessReadiness, executiveSummary } from '../../../shared/analysis-readiness';
import type { AppDb } from '../db/client';
import { analysisRuns, analysisTables, environments, projectSources, projects } from '../db/schema';
import { notFound } from '../lib/errors';
import type { RequestContext } from './context';

/**
 * What an analysis project found, across everything in it.
 *
 * ## Why this is assembled on read
 *
 * The findings are a pure function of the stored profiles, so they are computed when asked for rather than
 * written down at analysis time. Two reasons, and the second is the real one:
 *
 * - The engine improves. A rule added next month should apply to an analysis run last month, because the
 *   evidence has not changed — only our ability to read it.
 * - There is one source of truth. Storing a derived list invites it to drift from the profile it came
 *   from, and then two screens disagree about how many critical problems a dataset has.
 *
 * The profile itself *is* stored, and that is the part that must be: it is the record of what the data
 * looked like when it was examined, and re-reading the source later would answer a different question.
 *
 * ## One project, many datasets
 *
 * An analysis project has several sources, each analysed separately. This joins them: every finding is
 * tagged with the dataset it came from, the readiness is assessed over all of them together, and the
 * summary is a paragraph about the project rather than about one spreadsheet.
 */
export class AssessmentService {
  constructor(
    private readonly db: AppDb,
    private readonly logger: Logger,
  ) {}

  async forProject(
    ctx: Pick<RequestContext, 'organizationId'>,
    projectId: string,
  ): Promise<AnalysisAssessmentDto> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)));
    if (!project) throw notFound('Project');

    // Every dataset the project lists, named as the user named it.
    const sources = await this.db
      .select({ environment: environments, position: projectSources.position })
      .from(projectSources)
      .innerJoin(environments, eq(environments.id, projectSources.environmentId))
      .where(eq(projectSources.projectId, projectId))
      .orderBy(asc(projectSources.position));

    /**
     * The latest completed analysis per dataset.
     *
     * Per dataset, not per project: analysing one source must not make the others look stale, and a
     * project where three of four datasets have been analysed should report on the three rather than
     * refusing to report at all.
     */
    const runs = await this.db
      .select()
      .from(analysisRuns)
      .where(and(eq(analysisRuns.projectId, projectId), eq(analysisRuns.status, 'COMPLETED')))
      .orderBy(asc(analysisRuns.createdAt));
    const latestByEnvironment = new Map<string, (typeof runs)[number]>();
    for (const run of runs) latestByEnvironment.set(run.environmentId, run);

    const runIds = [...latestByEnvironment.values()].map((r) => r.id);
    const tables = runIds.length
      ? await this.db
          .select()
          .from(analysisTables)
          .where(inArray(analysisTables.analysisRunId, runIds))
          .orderBy(asc(analysisTables.orderIndex), asc(analysisTables.logicalName))
      : [];

    const nameByRun = new Map<string, string>();
    for (const [environmentId, run] of latestByEnvironment) {
      const source = sources.find((s) => s.environment.id === environmentId);
      nameByRun.set(run.id, source?.environment.displayName ?? 'Unknown dataset');
    }

    const findings: Finding[] = [];
    let records = 0;
    for (const table of tables) {
      const dataset = nameByRun.get(table.analysisRunId) ?? 'Unknown dataset';
      records += table.recordCount;
      findings.push(...findingsForTable({ dataset, profile: table.profile }));
    }

    /**
     * What could be assessed, which is not the same as what was found.
     *
     * A dataset nobody profiled and a dataset with a perfect key both produce zero identity findings. Only
     * one of them has earned a hundred, so the readiness model is told what was examined rather than being
     * left to infer it from an empty list.
     */
    const assessed = {
      profiled: tables.length > 0,
      relationships: tables.some((t) => t.dependsOn.length > 0),
    };
    const readiness = assessReadiness(findings, assessed);

    const datasets = sources.map((s) => {
      const run = latestByEnvironment.get(s.environment.id);
      const theirTables = tables.filter((t) => t.analysisRunId === run?.id);
      const theirFindings = findings.filter((f) => f.dataset === s.environment.displayName);
      return {
        environmentId: s.environment.id,
        name: s.environment.displayName,
        connectionType: s.environment.connectionType,
        provider: s.environment.provider,
        analysed: Boolean(run),
        analysisRunId: run?.id ?? null,
        analysedAt: run?.completedAt?.toISOString() ?? null,
        tables: theirTables.length,
        records: theirTables.reduce((sum, t) => sum + t.recordCount, 0),
        critical: theirFindings.filter((f) => f.severity === 'CRITICAL').length,
        warning: theirFindings.filter((f) => f.severity === 'WARNING').length,
        info: theirFindings.filter((f) => f.severity === 'INFO').length,
      };
    });

    const sorted = sortFindings(findings);
    this.logger.debug(
      { projectId, datasets: datasets.length, findings: sorted.length },
      'Assessment assembled',
    );

    return {
      projectId,
      projectName: project.name,
      datasets,
      tables: tables.length,
      records,
      readiness,
      findings: sorted,
      summary: executiveSummary({
        projectName: project.name,
        datasets: datasets.filter((d) => d.analysed).length,
        tables: tables.length,
        records,
        readiness,
        findings: sorted,
      }),
    };
  }
}
