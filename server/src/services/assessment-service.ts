import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AnalysisAssessmentDto, DatasetAnalysisState } from '../../../shared/domain';
import {
  dispositionSilences,
  findingsForTable,
  sortFindings,
  type Finding,
  type FindingDisposition,
  type FindingDispositionStatus,
} from '../../../shared/findings';
import { assessReadiness, executiveSummary } from '../../../shared/analysis-readiness';
import type { AppDb } from '../db/client';
import {
  analysisRuns,
  analysisTables,
  environments,
  findingDispositions,
  projectSources,
  projects,
  stagedTables,
  users,
} from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { unresolvableDatasets } from './dataset-resolution';
import type { AnalysisService } from './analysis-service';
import type { AuditService } from './audit-service';
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
/**
 * Whether a dataset changed after it was analysed.
 *
 * The second of tolerance is not superstition: an import and the analysis that follows it can land in the
 * same moment, and a dataset reporting itself stale the instant it finished being analysed would teach
 * people to ignore the word.
 */
const isStale = (changedAt: Date | undefined, analysedAt: Date | null) =>
  Boolean(changedAt && analysedAt && changedAt.getTime() > analysedAt.getTime() + 1000);

export class AssessmentService {
  constructor(
    private readonly db: AppDb,
    private readonly analysis: AnalysisService,
    private readonly audit: AuditService,
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
    const allRuns = await this.db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.projectId, projectId))
      .orderBy(asc(analysisRuns.createdAt));
    const runs = allRuns.filter((r) => r.status === 'COMPLETED');
    const latestByEnvironment = new Map<string, (typeof runs)[number]>();
    for (const run of runs) latestByEnvironment.set(run.environmentId, run);
    /** The newest run of any status per dataset, which is what decides whether one is running or failed. */
    const newestAttemptByEnvironment = new Map<string, (typeof allRuns)[number]>();
    for (const run of allRuns) newestAttemptByEnvironment.set(run.environmentId, run);

    const runIds = [...latestByEnvironment.values()].map((r) => r.id);
    const tables = runIds.length
      ? await this.db
          .select()
          .from(analysisTables)
          .where(inArray(analysisTables.analysisRunId, runIds))
          .orderBy(asc(analysisTables.orderIndex), asc(analysisTables.logicalName))
      : [];

    /**
     * When each dataset's contents last changed.
     *
     * For a file dataset this is exact: re-importing writes new `stagedTables` rows and `importedAt`
     * moves. For a database or a Dataverse environment there is no equivalent — the data changes on
     * their side without telling us — so those datasets are never reported STALE rather than being
     * reported fresh on a guess. The limitation is real and is stated in the report rather than papered
     * over with a timestamp that would mean nothing.
     */
    const imports = sources.length
      ? await this.db
          .select({ environmentId: stagedTables.environmentId, importedAt: stagedTables.importedAt })
          .from(stagedTables)
          .where(
            inArray(
              stagedTables.environmentId,
              sources.map((x) => x.environment.id),
            ),
          )
      : [];
    const lastChangedByEnvironment = new Map<string, Date>();
    for (const row of imports) {
      const current = lastChangedByEnvironment.get(row.environmentId);
      if (!current || row.importedAt > current)
        lastChangedByEnvironment.set(row.environmentId, row.importedAt);
    }

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

    /**
     * Decisions people have recorded, and the effect they have.
     *
     * A finding somebody has accepted or ruled out is still returned, with its evidence intact — the
     * observation did not stop being true because a person decided about it. It stops counting against
     * readiness, because readiness answers "what is left to deal with".
     *
     * `WILL_FIX` deliberately still counts: intending to fix something is not having fixed it, and a
     * score that improved on a promise would be worth nothing.
     */
    const dispositionRows = await this.db
      .select({ row: findingDispositions, user: users })
      .from(findingDispositions)
      .leftJoin(users, eq(users.id, findingDispositions.decidedByUserId))
      .where(eq(findingDispositions.projectId, projectId));
    const dispositions: FindingDisposition[] = dispositionRows.map(({ row, user }) => ({
      findingId: row.findingId,
      status: row.status,
      note: row.note,
      decidedBy: user?.displayName ?? null,
      decidedAt: row.updatedAt.toISOString(),
    }));
    const silenced = new Set(
      dispositions.filter((d) => dispositionSilences(d.status)).map((d) => d.findingId),
    );
    const readiness = assessReadiness(
      findings.filter((f) => !silenced.has(f.id)),
      assessed,
    );

    const datasets = sources.map((s) => {
      const run = latestByEnvironment.get(s.environment.id);
      const attempt = newestAttemptByEnvironment.get(s.environment.id);
      const theirTables = tables.filter((t) => t.analysisRunId === run?.id);
      const theirFindings = findings.filter((f) => f.dataset === s.environment.displayName);

      /**
       * `STALE` is the state worth having.
       *
       * The dataset was analysed, and then it changed — a file re-uploaded, more rows imported. Showing
       * the old findings without saying so is how somebody acts on an assessment of data that no longer
       * exists, and there is nothing on the screen to tell them. `updatedAt` on the environment moves
       * whenever its contents are replaced, so comparing it against the run's completion is enough.
       */
      const state: DatasetAnalysisState = !attempt
        ? 'NOT_ANALYSED'
        : attempt.status === 'QUEUED'
          ? 'QUEUED'
          : attempt.status === 'RUNNING'
            ? 'RUNNING'
            : attempt.status === 'FAILED' && (!run || attempt.createdAt > run.createdAt)
              ? 'FAILED'
              : run && isStale(lastChangedByEnvironment.get(s.environment.id), run.completedAt)
                ? 'STALE'
                : run
                  ? 'ANALYSED'
                  : 'NOT_ANALYSED';

      return {
        environmentId: s.environment.id,
        name: s.environment.displayName,
        connectionType: s.environment.connectionType,
        provider: s.environment.provider,
        analysed: Boolean(run),
        state,
        failureMessage: state === 'FAILED' ? (attempt?.errorMessage ?? 'The analysis failed.') : null,
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
      dispositions,
      runs: allRuns
        .slice()
        .reverse()
        .map((run) => {
          const theirTables = tables.filter((t) => t.analysisRunId === run.id);
          return {
            id: run.id,
            datasetName:
              sources.find((s) => s.environment.id === run.environmentId)?.environment.displayName ??
              'Unknown dataset',
            status: run.status,
            startedAt: run.createdAt.toISOString(),
            completedAt: run.completedAt?.toISOString() ?? null,
            tables: theirTables.length,
            records: theirTables.reduce((sum, t) => sum + t.recordCount, 0),
          };
        }),
      summary: executiveSummary({
        projectName: project.name,
        datasets: datasets.filter((d) => d.analysed).length,
        tables: tables.length,
        records,
        readiness,
        findings: sorted.filter((f) => !silenced.has(f.id)),
      }),
    };
  }

  /**
   * Starts an analysis for every dataset that needs one.
   *
   * "Needs one" means never analysed, failed, or changed since it was last analysed. `all` includes the
   * ones that are up to date, which is what a deliberate re-analysis means. Datasets already queued or
   * running are skipped either way, so pressing the button twice does not double the work.
   */
  async analyseProject(
    ctx: RequestContext,
    projectId: string,
    opts: { all?: boolean } = {},
  ): Promise<{ started: string[]; skipped: { dataset: string; reason: string }[] }> {
    const assessment = await this.forProject(ctx, projectId);

    /**
     * Analysis needs a dataset, and a connection is not one.
     *
     * Rejected here rather than queued and failed, because a request that cannot succeed should be
     * refused when it is made. The previous behaviour accepted it, queued a run, and reported the result
     * as a failed analysis — which reads as "the product is broken" rather than "you have not chosen any
     * data yet". The second is true and is the thing the person can act on.
     */
    if (assessment.datasets.length === 0) {
      throw badRequest(
        'This project has no datasets yet, so there is nothing to analyse. Add a file, a table or a list first.',
      );
    }
    const sources = await this.db
      .select({ environment: environments })
      .from(projectSources)
      .innerJoin(environments, eq(environments.id, projectSources.environmentId))
      .where(eq(projectSources.projectId, projectId));
    const unusable = await unresolvableDatasets(
      this.db,
      sources.map((s) => s.environment),
    );
    if (unusable.length === sources.length) {
      const first = unusable[0]!;
      throw badRequest(`${first.resolution.message} ${first.resolution.whatToDo}`);
    }

    const started: string[] = [];
    const skipped: { dataset: string; reason: string }[] = [];
    // A dataset that cannot be read is skipped with its own reason rather than queued to fail.
    const unusableIds = new Set(unusable.map((u) => u.environment.id));

    for (const dataset of assessment.datasets) {
      if (dataset.state === 'QUEUED' || dataset.state === 'RUNNING') {
        skipped.push({ dataset: dataset.name, reason: 'already being analysed' });
        continue;
      }
      if (!opts.all && dataset.state === 'ANALYSED') {
        skipped.push({ dataset: dataset.name, reason: 'already analysed and unchanged' });
        continue;
      }
      if (unusableIds.has(dataset.environmentId)) {
        const why = unusable.find((u) => u.environment.id === dataset.environmentId)!.resolution;
        skipped.push({ dataset: dataset.name, reason: why.message });
        continue;
      }
      await this.analysis.create(ctx, projectId, { environmentId: dataset.environmentId });
      started.push(dataset.name);
    }
    this.logger.info({ projectId, started: started.length, skipped: skipped.length }, 'Analysis requested');
    return { started, skipped };
  }

  /**
   * Records what a person decided about a finding.
   *
   * Upserted per project and finding, so a decision can be changed. The *history* of decisions is the
   * audit trail's job rather than this table's — what matters here is that nothing about the finding
   * itself is written, so the evidence a decision was taken against stays exactly as the engine produced
   * it and the next analysis recomputes it unchanged.
   */
  async setDisposition(
    ctx: RequestContext,
    projectId: string,
    findingId: string,
    input: { status: FindingDispositionStatus; note?: string | null },
  ): Promise<AnalysisAssessmentDto> {
    const assessment = await this.forProject(ctx, projectId);
    const finding = assessment.findings.find((f) => f.id === findingId);
    if (!finding) throw notFound('Finding');

    const note = input.note?.trim() || null;
    const now = new Date();
    await this.db
      .insert(findingDispositions)
      .values({
        organizationId: ctx.organizationId,
        projectId,
        findingId,
        status: input.status,
        note,
        decidedByUserId: ctx.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [findingDispositions.projectId, findingDispositions.findingId],
        set: { status: input.status, note, decidedByUserId: ctx.userId, updatedAt: now },
      });

    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'FINDING_DISPOSITION_SET',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { projectId, findingId, status: input.status, hasNote: Boolean(note), title: finding.title },
    });
    return this.forProject(ctx, projectId);
  }
}
