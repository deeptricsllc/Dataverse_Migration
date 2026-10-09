import { and, asc, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  type AnalysisFindingDto,
  type AnalysisOptions,
  type AnalysisRunDto,
  type AnalysisRunListItemDto,
  type AnalysisTableDetailDto,
  type AnalysisTableDto,
  type AnalysisTotalsDto,
  type DataQualityRuleDto,
  type StatisticBasis,
  type TableProfileDto,
  type ErdDto,
  type ErdEdgeDto,
  type ErdNodeDto,
} from '../../../shared/domain';
import type { TableMetadata, TableSummary } from '../../../shared/metadata';
import type { AppDb } from '../db/client';
import {
  analysisFindings,
  analysisRuns,
  analysisTables,
  environments,
  projectSources,
  projects,
  users,
} from '../db/schema';
import type { ConnectionFactory } from '../dataverse/factory';
import type { JobQueue } from '../jobs/queue';
import { badRequest, errorMessage, notFound } from '../lib/errors';
import { resolveDataset } from './dataset-resolution';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import { analyzeDependencies } from './dependency-graph';
import { envRef } from './env-ref';
import { isMigratableTable, type MetadataService } from './metadata-service';
import type { ProjectService } from './project-service';
import { deriveTargetRules, type ProfilingService } from './profiling-service';

/** Upper bound per analysis, so "analyse everything" on a large org stays a bounded job. */
const MAX_TABLES_PER_ANALYSIS = 200;
const DEFAULT_SAMPLE_SIZE = 10_000;

/**
 * Analysis of a source system, on its own terms.
 *
 * This is the half of the product that has no target: before anyone decides where data should go,
 * they need to know what is actually there — how many rows, which columns are really populated,
 * what the keys and relationships are, and where the data contradicts its own schema. It reuses the
 * profiling engine the migration side uses, so a number seen here means the same thing later.
 *
 * Read-only by construction. Nothing in this service writes to a source, and an analysis project
 * has no target to write to.
 */
export class AnalysisService {
  constructor(
    private readonly db: AppDb,
    private readonly projectsSvc: ProjectService,
    private readonly environmentsSvc: EnvironmentServiceLike,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly profiling: ProfilingService,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Starting an analysis
  // ---------------------------------------------------------------------------

  async create(
    ctx: RequestContext,
    projectId: string,
    input: {
      name?: string;
      tables?: string[];
      sampleSize?: number;
      full?: boolean;
      /**
       * Which dataset to analyse.
       *
       * An analysis project has several, and each run covers one — so "analyse this project" is several
       * runs rather than one, and a dataset added later can be analysed without redoing the others.
       * Omitted means the primary source, which is what every existing caller means.
       */
      environmentId?: string;
    } = {},
  ): Promise<AnalysisRunDto> {
    const project = await this.projectsSvc.ofKind(ctx, projectId, 'ANALYSIS');
    const wanted = input.environmentId ?? project.sourceEnvironmentId;
    if (!wanted) {
      throw badRequest('Add a dataset to this project before running an analysis');
    }
    if (input.environmentId) {
      // A run may only cover a dataset this project actually lists. Otherwise an analysis could be
      // attributed to a project that has nothing to do with the data in it.
      const listed = await this.db
        .select({ id: projectSources.id })
        .from(projectSources)
        .where(
          and(eq(projectSources.projectId, projectId), eq(projectSources.environmentId, input.environmentId)),
        )
        .limit(1);
      if (listed.length === 0) throw badRequest('That dataset is not part of this project');
    }
    const env = await this.environmentsSvc.getAccessible(ctx, wanted);

    /**
     * Does this connection resolve to anything to read?
     *
     * Checked here and not only where the dataset was added, because adding and running are
     * different moments and the answer can change between them: a file can be removed from a
     * connection after the project was built around it. A check that only runs at the earlier moment
     * is a check that passes for a project which cannot work.
     *
     * This is the refusal the reported failure should have been. It was accepted instead, queued,
     * and failed inside the worker with `None of the requested tables exist in this source` — which
     * named no table the person had asked for, because they had asked for none.
     */
    const resolution = await resolveDataset(this.db, env);
    if (!resolution.resolves) {
      throw badRequest(`${resolution.message} ${resolution.whatToDo}`);
    }

    /**
     * What to analyse: what the caller asked for, or what the project already chose.
     *
     * An empty list reaches `selectTables` as "every table in the catalogue". That is the right
     * default for a connection nobody has narrowed, and the wrong one for a project where somebody
     * picked three tables out of two hundred — the selection is recorded on the project source, and
     * reading past it analyses a hundred and ninety-seven tables nobody asked about.
     *
     * The fan-out behind the Analyse button already passed the selection, so this closed a gap
     * between two routes to the same work rather than a gap nobody could reach: the per-dataset
     * endpoint is what a second screen, a retry or a script would call.
     */
    const [listedSource] = await this.db
      .select({ selectedObjects: projectSources.selectedObjects })
      .from(projectSources)
      .where(and(eq(projectSources.projectId, projectId), eq(projectSources.environmentId, env.id)))
      .limit(1);
    const requested = input.tables ?? listedSource?.selectedObjects ?? [];
    const tables = [...new Set(requested.map((t) => t.trim()).filter(Boolean))];
    if (tables.length > MAX_TABLES_PER_ANALYSIS) {
      throw badRequest(`An analysis covers at most ${MAX_TABLES_PER_ANALYSIS} tables at a time`);
    }
    const options: AnalysisOptions = {
      tables,
      sampleSize: clampSample(input.sampleSize),
      full: input.full === true,
    };
    const name = (input.name ?? '').trim() || defaultAnalysisName(tables);

    const [run] = await this.db
      .insert(analysisRuns)
      .values({
        organizationId: ctx.organizationId,
        projectId,
        environmentId: env.id,
        name,
        status: 'QUEUED',
        options,
        progressMessage: 'Queued',
        createdByUserId: ctx.userId,
      })
      .returning();
    await this.queue.enqueue('ANALYSIS', ctx.organizationId, run.id);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'ANALYSIS_REQUESTED',
      outcome: 'REQUESTED',
      sourceEnvironmentId: env.id,
      requestId: ctx.requestId,
      details: { analysisRunId: run.id, projectId, tables: tables.length || 'all', options },
    });
    this.logger.info({ analysisRunId: run.id, projectId }, 'Analysis queued');
    return this.get(ctx, run.id);
  }

  // ---------------------------------------------------------------------------
  // Running it
  // ---------------------------------------------------------------------------

  /**
   * The job handler. Resumable in the sense that matters: a re-run after a crash starts the
   * analysis again from scratch rather than leaving half a result behind, because a partial profile
   * presented as a complete one is the failure mode worth avoiding.
   */
  async execute(runId: string, heartbeat: () => Promise<void> = async () => {}): Promise<void> {
    const [run] = await this.db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    if (!run || run.status === 'COMPLETED') return;

    const progress = (progressMessage: string) =>
      this.db.update(analysisRuns).set({ progressMessage }).where(eq(analysisRuns.id, runId));

    try {
      await this.db
        .update(analysisRuns)
        .set({ status: 'RUNNING', startedAt: new Date(), errorMessage: null, progressMessage: 'Starting' })
        .where(eq(analysisRuns.id, runId));
      // A re-run replaces its own previous output rather than adding to it.
      await this.db.delete(analysisTables).where(eq(analysisTables.analysisRunId, runId));
      await this.db.delete(analysisFindings).where(eq(analysisFindings.analysisRunId, runId));

      const env = await this.environmentsSvc.getInOrganization(run.organizationId, run.environmentId);
      const conn = await this.connections.connectorFor(env, run.createdByUserId ?? '', {
        analysisRunId: runId,
      });

      await progress('Reading the table catalogue');
      const catalog = await this.metadata.getCatalog(env.id, conn);
      const chosen = selectTables(catalog, run.options.tables);
      if (chosen.length === 0) {
        /*
         * Two different situations, and they had one message between them.
         *
         * An empty catalogue means the connection holds nothing to read — nothing was chosen, or
         * what was chosen is gone. `None of the requested tables exist in this source` described
         * neither: no table was requested, and the source has no tables to speak of. A run that
         * reaches here is also a run the checks above should have refused, so it says that too.
         */
        if (catalog.length === 0) {
          const resolution = await resolveDataset(this.db, env);
          throw badRequest(
            resolution.resolves
              ? `${env.displayName} holds nothing to analyse. Select the data to analyse, then run it again.`
              : `${resolution.message} ${resolution.whatToDo}`,
          );
        }
        throw badRequest(
          `None of the selected tables are in ${env.displayName} any more. Select the data to analyse, then run it again.`,
        );
      }

      await progress(`Reading metadata for ${chosen.length} table(s)`);
      let done = 0;
      const metaByName = await this.metadata.getTables(
        env.id,
        conn,
        chosen.map((t) => t.logicalName),
        {
          onProgress: () => {
            done++;
            void progress(`Reading metadata (${done}/${chosen.length})`);
          },
        },
      );
      const metas = [...metaByName.values()];

      // Relationships and a dependency-safe order, from the source alone. Passing the analysed set
      // as the "known" set means a reference to a table outside the analysis is reported as
      // out-of-scope rather than as missing.
      const inScope = new Set(metas.map((m) => m.logicalName));
      const dependencies = analyzeDependencies({ tables: metas, targetTables: inScope });
      const orderIndex = new Map(dependencies.order.map((name, i) => [name, i]));
      // A node's dependencies are edges; the analysis stores the distinct table names they point at.
      const dependsOn = new Map(
        dependencies.nodes.map((n) => [n.logicalName, [...new Set(n.dependsOn.map((e) => e.to))].sort()]),
      );

      const totals = emptyTotals();
      let allExact = true;

      for (const [i, meta] of metas.entries()) {
        await heartbeat();
        await progress(`Analysing ${meta.displayName} (${i + 1}/${metas.length})`);
        const profile = await this.profiling.profileTable(
          { organizationId: run.organizationId, userId: run.createdByUserId ?? '' } as RequestContext,
          {
            environmentId: env.id,
            table: meta.logicalName,
            // The source's own declared constraints, checked against the source's own data.
            rules: deriveSourceRules(meta),
            sampleSize: run.options.sampleSize,
            full: run.options.full,
          },
        );
        const findings = flattenFindings(meta.logicalName, profile);
        const empty = emptyColumns(profile);

        totals.tables++;
        totals.columns += profile.columns;
        totals.records += profile.totalRecords;
        totals.examined += profile.examined;
        totals.recordsApproximate ||= profile.totalApproximate;
        totals.findings += findings.length;
        totals.blockers += findings.filter((f) => f.severity === 'BLOCKER').length;
        totals.warnings += findings.filter((f) => f.severity === 'WARNING').length;
        if (profile.totalRecords === 0) totals.emptyTables++;
        totals.unusedColumns += empty.length;
        if (profile.basis !== 'EXACT') allExact = false;

        await this.db.insert(analysisTables).values({
          analysisRunId: runId,
          logicalName: meta.logicalName,
          displayName: meta.displayName,
          recordCount: profile.totalRecords,
          recordCountApproximate: profile.totalApproximate,
          columnCount: profile.columns,
          examined: profile.examined,
          basis: profile.basis,
          blockers: findings.filter((f) => f.severity === 'BLOCKER').length,
          warnings: findings.filter((f) => f.severity === 'WARNING').length,
          orderIndex: orderIndex.get(meta.logicalName) ?? i,
          dependsOn: dependsOn.get(meta.logicalName) ?? [],
          emptyColumns: empty,
          primaryKeyField: profile.primaryKeyField,
          duplicateKeyCount: profile.duplicateKeyCount,
          profile,
        });
        if (findings.length) {
          for (let f = 0; f < findings.length; f += 200) {
            await this.db.insert(analysisFindings).values(
              findings.slice(f, f + 200).map((finding) => ({
                analysisRunId: runId,
                logicalName: finding.table,
                field: finding.field,
                severity: finding.severity,
                code: finding.code,
                message: finding.message,
                affected: finding.affected,
                basis: finding.basis,
                resolution: finding.resolution,
              })),
            );
          }
        }
      }

      const basis: StatisticBasis = allExact && !totals.recordsApproximate ? 'EXACT' : 'SAMPLED';
      await this.db
        .update(analysisRuns)
        .set({
          status: 'COMPLETED',
          totals,
          basis,
          progressMessage: null,
          completedAt: new Date(),
        })
        .where(eq(analysisRuns.id, runId));
      await this.audit.record({
        organizationId: run.organizationId,
        userId: run.createdByUserId,
        action: 'ANALYSIS_COMPLETED',
        outcome: 'SUCCESS',
        sourceEnvironmentId: env.id,
        details: { analysisRunId: runId, ...totals, basis },
      });
      this.logger.info({ analysisRunId: runId, ...totals, basis }, 'Analysis completed');
    } catch (err) {
      const message = errorMessage(err);
      await this.db
        .update(analysisRuns)
        .set({ status: 'FAILED', errorMessage: message, progressMessage: null, completedAt: new Date() })
        .where(eq(analysisRuns.id, runId));
      this.logger.error({ analysisRunId: runId, err: { message } }, 'Analysis failed');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Reading it back
  // ---------------------------------------------------------------------------

  /**
   * The analysed tables as an entity relationship diagram.
   *
   * Built from the same `analyzeDependencies` the run itself used, rather than from a second reading
   * of the relationships: the diagram and the load order are one answer, and drawing them from
   * different code is how they would come to disagree.
   */
  async erd(ctx: RequestContext, runId: string): Promise<ErdDto> {
    const run = await this.get(ctx, runId);
    if (run.status !== 'COMPLETED') {
      throw badRequest('This analysis has not finished, so there is nothing to draw yet.');
    }
    const names = run.tables.map((t) => t.logicalName);
    if (names.length === 0) return { nodes: [], edges: [], externalReferences: [] };

    const env = await this.environmentsSvc.getAccessible(ctx, run.environment.id);
    const conn = await this.connections.connectorFor(env, ctx.userId, { analysisRunId: runId });
    try {
      const metaByName = await this.metadata.getTables(env.id, conn, names);
      const metas = [...metaByName.values()];
      const inScope = new Set(metas.map((m) => m.logicalName));
      const analysis = analyzeDependencies({ tables: metas, targetTables: inScope });

      const cycleOf = new Map(analysis.nodes.map((n) => [n.logicalName, n.cycleGroup]));
      const edges: ErdEdgeDto[] = [];
      const externalReferences: ErdDto['externalReferences'] = [];
      for (const node of analysis.nodes) {
        for (const edge of node.dependsOn) {
          // `from` is what must exist first, which reads left to right in the drawing.
          if (inScope.has(edge.to)) {
            edges.push({
              from: edge.to,
              to: node.logicalName,
              attribute: edge.attribute,
              required: edge.required,
              deferred: edge.deferred,
            });
          } else {
            externalReferences.push({ from: node.logicalName, attribute: edge.attribute, to: edge.to });
          }
        }
      }

      // Depth is the longest chain of things that must exist first. A cycle stops the walk, so a
      // table caught in one is placed beside the rest of its group rather than sent to infinity.
      const parents = new Map<string, string[]>();
      for (const e of edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
      const depths = new Map<string, number>();
      const depthOf = (name: string, seen: Set<string>): number => {
        const cached = depths.get(name);
        if (cached !== undefined) return cached;
        if (seen.has(name)) return 0;
        seen.add(name);
        const own = (parents.get(name) ?? []).filter((p) => p !== name).map((p) => depthOf(p, seen) + 1);
        const depth = own.length ? Math.max(...own) : 0;
        seen.delete(name);
        depths.set(name, depth);
        return depth;
      };

      const byName = new Map(run.tables.map((t) => [t.logicalName, t]));
      const nodes: ErdNodeDto[] = metas.map((meta) => {
        const table = byName.get(meta.logicalName);
        const key = meta.attributes.find((a) => a.isPrimaryId);
        return {
          logicalName: meta.logicalName,
          displayName: meta.displayName,
          recordCount: table?.recordCount ?? 0,
          columnCount: table?.columnCount ?? meta.attributes.length,
          depth: depthOf(meta.logicalName, new Set()),
          keyColumn: key?.logicalName ?? null,
          cycleGroup: cycleOf.get(meta.logicalName) ?? null,
        };
      });
      nodes.sort((a, b) => a.depth - b.depth || a.displayName.localeCompare(b.displayName));
      return { nodes, edges, externalReferences };
    } finally {
      await conn.dispose?.();
    }
  }

  async get(ctx: Pick<RequestContext, 'organizationId'>, runId: string): Promise<AnalysisRunDto> {
    const [row] = await this.db
      .select({ run: analysisRuns, project: projects, env: environments, user: users })
      .from(analysisRuns)
      .innerJoin(projects, eq(projects.id, analysisRuns.projectId))
      .innerJoin(environments, eq(environments.id, analysisRuns.environmentId))
      .leftJoin(users, eq(users.id, analysisRuns.createdByUserId))
      .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Analysis');

    const tables = await this.db
      .select()
      .from(analysisTables)
      .where(eq(analysisTables.analysisRunId, runId))
      .orderBy(asc(analysisTables.orderIndex), asc(analysisTables.logicalName));

    return {
      id: row.run.id,
      projectId: row.run.projectId,
      projectName: row.project.name,
      name: row.run.name,
      environment: envRef(row.env),
      status: row.run.status,
      options: row.run.options,
      totals: row.run.totals ?? emptyTotals(),
      basis: row.run.basis,
      progressMessage: row.run.progressMessage,
      errorMessage: row.run.errorMessage,
      createdBy: row.user?.displayName ?? null,
      createdAt: row.run.createdAt.toISOString(),
      startedAt: row.run.startedAt?.toISOString() ?? null,
      completedAt: row.run.completedAt?.toISOString() ?? null,
      tables: tables.map(toTableDto),
    };
  }

  async list(ctx: RequestContext, projectId: string): Promise<AnalysisRunListItemDto[]> {
    await this.projectsSvc.row(ctx, projectId);
    const rows = await this.db
      .select({ run: analysisRuns, env: environments })
      .from(analysisRuns)
      .innerJoin(environments, eq(environments.id, analysisRuns.environmentId))
      .where(eq(analysisRuns.projectId, projectId))
      .orderBy(desc(analysisRuns.createdAt));
    return rows.map((r) => ({
      id: r.run.id,
      projectId: r.run.projectId,
      name: r.run.name,
      environmentName: r.env.displayName,
      status: r.run.status,
      basis: r.run.basis,
      totals: r.run.totals ?? emptyTotals(),
      createdAt: r.run.createdAt.toISOString(),
      completedAt: r.run.completedAt?.toISOString() ?? null,
    }));
  }

  /** The newest completed analysis of a project, which is what a migration plan starts from. */
  async latestCompleted(
    ctx: Pick<RequestContext, 'organizationId'>,
    projectId: string,
  ): Promise<AnalysisRunDto | null> {
    const [row] = await this.db
      .select({ id: analysisRuns.id })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.projectId, projectId),
          eq(analysisRuns.organizationId, ctx.organizationId),
          eq(analysisRuns.status, 'COMPLETED'),
        ),
      )
      .orderBy(desc(analysisRuns.createdAt))
      .limit(1);
    return row ? this.get(ctx, row.id) : null;
  }

  /** One table's full column profile, loaded only when someone opens it. */
  async table(
    ctx: Pick<RequestContext, 'organizationId'>,
    runId: string,
    logicalName: string,
  ): Promise<AnalysisTableDetailDto> {
    await this.get(ctx, runId);
    const [row] = await this.db
      .select()
      .from(analysisTables)
      .where(and(eq(analysisTables.analysisRunId, runId), eq(analysisTables.logicalName, logicalName)));
    if (!row) throw notFound('Analysed table');
    const findings = await this.db
      .select()
      .from(analysisFindings)
      .where(and(eq(analysisFindings.analysisRunId, runId), eq(analysisFindings.logicalName, logicalName)));
    return {
      ...toTableDto(row),
      profile: row.profile,
      findings: findings.map(toFindingDto),
    };
  }

  async findings(
    ctx: Pick<RequestContext, 'organizationId'>,
    runId: string,
    filter: { severity?: 'BLOCKER' | 'WARNING'; table?: string } = {},
  ): Promise<AnalysisFindingDto[]> {
    await this.get(ctx, runId);
    const where = [eq(analysisFindings.analysisRunId, runId)];
    if (filter.severity) where.push(eq(analysisFindings.severity, filter.severity));
    if (filter.table) where.push(eq(analysisFindings.logicalName, filter.table));
    const rows = await this.db
      .select()
      .from(analysisFindings)
      .where(and(...where))
      .orderBy(asc(analysisFindings.logicalName), desc(analysisFindings.affected));
    return rows.map(toFindingDto);
  }

  /** The tables a source offers, so an analysis can be scoped before it runs. */
  async availableTables(ctx: RequestContext, projectId: string): Promise<TableSummary[]> {
    const project = await this.projectsSvc.ofKind(ctx, projectId, 'ANALYSIS');
    if (!project.sourceEnvironmentId) throw badRequest('Choose a source for this project first');
    const env = await this.environmentsSvc.getAccessible(ctx, project.sourceEnvironmentId);
    const conn = await this.connections.connectorFor(env, ctx.userId, { requestId: ctx.requestId });
    const catalog = await this.metadata.getCatalog(env.id, conn);
    return catalog.filter(isMigratableTable).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}

/** Only the two methods this service needs, so it does not depend on the whole environment service. */
interface EnvironmentServiceLike {
  getAccessible(ctx: RequestContext, environmentId: string): Promise<typeof environments.$inferSelect>;
  getInOrganization(organizationId: string, environmentId: string): Promise<typeof environments.$inferSelect>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyTotals = (): AnalysisTotalsDto => ({
  tables: 0,
  columns: 0,
  records: 0,
  recordsApproximate: false,
  examined: 0,
  findings: 0,
  blockers: 0,
  warnings: 0,
  emptyTables: 0,
  unusedColumns: 0,
});

const clampSample = (value: number | undefined) =>
  Math.min(200_000, Math.max(100, Math.floor(value ?? DEFAULT_SAMPLE_SIZE)));

const defaultAnalysisName = (tables: string[]) => {
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return tables.length === 0 ? `Full source analysis: ${when}` : `${tables.length} table(s): ${when}`;
};

/** Requested tables, or every migratable one when nothing was named. */
function selectTables(catalog: TableSummary[], requested: string[]): TableSummary[] {
  if (requested.length === 0) {
    return catalog.filter(isMigratableTable).slice(0, MAX_TABLES_PER_ANALYSIS);
  }
  const wanted = new Set(requested.map((t) => t.toLowerCase()));
  return catalog.filter((t) => wanted.has(t.logicalName.toLowerCase()));
}

/**
 * The source's own declared constraints, restated as rules about its own columns.
 *
 * Reuses `deriveTargetRules` by mapping every column onto itself: a column the schema calls
 * required that nonetheless holds blanks, or an email column holding something that is not an
 * email, is a fact about the source worth knowing before any target is chosen.
 */
export function deriveSourceRules(meta: TableMetadata): DataQualityRuleDto[] {
  const readable = meta.attributes.filter((a) => a.isValidForRead && !a.attributeOf);
  const identity = readable.map((a) => ({ sourceField: a.logicalName, targetField: a.logicalName }));
  return deriveTargetRules(meta, identity).map((rule) => ({ ...rule, origin: 'SOURCE_SCHEMA' as const }));
}

/** Table-level and column-level issues, flattened into one list per table. */
function flattenFindings(table: string, profile: TableProfileDto): AnalysisFindingDto[] {
  const all = [
    ...profile.issues.map((i) => ({ issue: i, field: i.field ?? null })),
    ...profile.fields.flatMap((f) => f.issues.map((i) => ({ issue: i, field: i.field ?? f.field }))),
  ];
  return all.map(({ issue, field }) => ({
    table,
    field,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    affected: issue.affected,
    basis: issue.basis,
    resolution: issue.resolution ?? null,
  }));
}

/**
 * Columns that held nothing in everything examined.
 *
 * Worth naming explicitly: a column that is empty in the source is usually either dead weight that
 * should not be migrated at all, or a sign that the data everyone assumed was there is somewhere
 * else entirely.
 */
function emptyColumns(profile: TableProfileDto): string[] {
  if (profile.examined === 0) return [];
  return profile.fields
    .filter((f) => f.examined > 0 && f.nullCount + f.blankCount >= f.examined)
    .map((f) => f.field);
}

const toTableDto = (row: typeof analysisTables.$inferSelect): AnalysisTableDto => ({
  logicalName: row.logicalName,
  displayName: row.displayName,
  recordCount: row.recordCount,
  recordCountApproximate: row.recordCountApproximate,
  columnCount: row.columnCount,
  examined: row.examined,
  basis: row.basis,
  blockers: row.blockers,
  warnings: row.warnings,
  orderIndex: row.orderIndex,
  dependsOn: row.dependsOn,
  emptyColumns: row.emptyColumns,
  primaryKeyField: row.primaryKeyField,
  duplicateKeyCount: row.duplicateKeyCount,
});

const toFindingDto = (row: typeof analysisFindings.$inferSelect): AnalysisFindingDto => ({
  table: row.logicalName,
  field: row.field,
  severity: row.severity,
  code: row.code,
  message: row.message,
  affected: row.affected,
  basis: row.basis,
  resolution: row.resolution,
});
