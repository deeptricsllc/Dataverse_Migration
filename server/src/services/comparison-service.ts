import { and, desc, eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import type { ComparisonRunDto, EnvRef, TableDiff } from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { comparisonRuns, comparisonTableResults, environments, users } from '../db/schema';
import type { ConnectionFactory } from '../dataverse/factory';
import type { JobQueue } from '../jobs/queue';
import { badRequest, errorMessage, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import type { EnvironmentService } from './environment-service';
import { defaultComparisonScope, isMigratableTable, type MetadataService } from './metadata-service';
import { compareSchemas } from './schema-diff';

const envRef = (e: { id: string; displayName: string; url: string }): EnvRef => ({
  id: e.id,
  displayName: e.displayName,
  url: e.url,
});

export class ComparisonService {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async create(
    ctx: RequestContext,
    input: {
      sourceEnvironmentId: string;
      targetEnvironmentId: string;
      tables?: string[] | null;
      refreshMetadata?: boolean;
    },
  ): Promise<ComparisonRunDto> {
    if (input.sourceEnvironmentId === input.targetEnvironmentId)
      throw badRequest('Source and target must be different environments');
    const source = await this.environmentsSvc.getAccessible(ctx, input.sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, input.targetEnvironmentId);
    const [run] = await this.db
      .insert(comparisonRuns)
      .values({
        organizationId: ctx.organizationId,
        sourceEnvironmentId: source.id,
        targetEnvironmentId: target.id,
        scope: input.tables?.length ? input.tables : null,
        refreshMetadata: Boolean(input.refreshMetadata),
        createdByUserId: ctx.userId,
        progressMessage: 'Queued',
      })
      .returning();
    await this.queue.enqueue('COMPARISON', ctx.organizationId, run.id);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'COMPARISON_REQUESTED',
      outcome: 'REQUESTED',
      sourceEnvironmentId: source.id,
      targetEnvironmentId: target.id,
      runId: run.id,
      requestId: ctx.requestId,
    });
    return this.get(ctx, run.id);
  }

  /** Job handler. */
  async execute(runId: string): Promise<void> {
    const [run] = await this.db.select().from(comparisonRuns).where(eq(comparisonRuns.id, runId));
    if (!run || run.status === 'COMPLETED') return;
    const log = this.logger.child({ comparisonRunId: runId });
    const progress = (progressMessage: string) =>
      this.db.update(comparisonRuns).set({ progressMessage }).where(eq(comparisonRuns.id, runId));
    await this.db
      .update(comparisonRuns)
      .set({ status: 'RUNNING', startedAt: new Date(), errorMessage: null })
      .where(eq(comparisonRuns.id, runId));
    log.info('Comparison started');
    try {
      if (!run.createdByUserId) throw new Error('Comparison has no initiating user');
      const source = await this.environmentsSvc.getInOrganization(
        run.organizationId,
        run.sourceEnvironmentId,
      );
      const target = await this.environmentsSvc.getInOrganization(
        run.organizationId,
        run.targetEnvironmentId,
      );
      const sConn = this.connections.forEnvironment(source, run.createdByUserId, { comparisonRunId: runId });
      const tConn = this.connections.forEnvironment(target, run.createdByUserId, { comparisonRunId: runId });

      await progress('Discovering table catalogs');
      const [sourceCatalog, targetCatalog] = await Promise.all([
        this.metadata.getCatalog(source.id, sConn, run.refreshMetadata),
        this.metadata.getCatalog(target.id, tConn, run.refreshMetadata),
      ]);
      const migratable = (c: typeof sourceCatalog) => c.filter(isMigratableTable);
      const scope = run.scope ?? defaultComparisonScope(sourceCatalog);
      const targetNames = new Set(targetCatalog.map((t) => t.logicalName));
      const sourceNames = new Set(sourceCatalog.map((t) => t.logicalName));
      const deepNames = scope.filter((n) => sourceNames.has(n) && targetNames.has(n));

      let done = 0;
      const total = deepNames.length * 2;
      const onProgress = () => void progress(`Reading table metadata (${++done}/${total})`);
      const [sourceDeep, targetDeep] = await Promise.all([
        this.metadata.getTables(source.id, sConn, deepNames, { refresh: run.refreshMetadata, onProgress }),
        this.metadata.getTables(target.id, tConn, deepNames, { refresh: run.refreshMetadata, onProgress }),
      ]);

      await progress('Comparing schemas');
      const { tables, summary } = compareSchemas({
        sourceCatalog: migratable(sourceCatalog),
        targetCatalog: migratable(targetCatalog),
        sourceDeep,
        targetDeep,
      });
      await this.db.delete(comparisonTableResults).where(eq(comparisonTableResults.comparisonRunId, runId));
      for (let i = 0; i < tables.length; i += 100) {
        await this.db.insert(comparisonTableResults).values(
          tables.slice(i, i + 100).map((t) => ({
            comparisonRunId: runId,
            logicalName: t.logicalName,
            displayName: t.displayName,
            status: t.status,
            isCustom: t.isCustom,
            deep: t.deep,
            differences: t.differences,
            columns: t.columns,
            relationships: t.relationships,
            keys: t.keys,
          })),
        );
      }
      await this.db
        .update(comparisonRuns)
        .set({
          status: 'COMPLETED',
          summary,
          completedAt: new Date(),
          progressMessage: 'Completed',
          scope: run.scope ?? scope,
        })
        .where(eq(comparisonRuns.id, runId));
      await this.audit.record({
        organizationId: run.organizationId,
        userId: run.createdByUserId,
        action: 'COMPARISON_COMPLETED',
        outcome: 'SUCCESS',
        sourceEnvironmentId: run.sourceEnvironmentId,
        targetEnvironmentId: run.targetEnvironmentId,
        runId,
        details: { ...summary },
      });
      log.info({ summary }, 'Comparison completed');
    } catch (err) {
      const message = errorMessage(err);
      log.error({ error: message }, 'Comparison failed');
      await this.db
        .update(comparisonRuns)
        .set({ status: 'FAILED', errorMessage: message, completedAt: new Date(), progressMessage: 'Failed' })
        .where(eq(comparisonRuns.id, runId));
      await this.audit.record({
        organizationId: run.organizationId,
        userId: run.createdByUserId,
        action: 'COMPARISON_COMPLETED',
        outcome: 'FAILURE',
        sourceEnvironmentId: run.sourceEnvironmentId,
        targetEnvironmentId: run.targetEnvironmentId,
        runId,
        details: { error: message },
      });
    }
  }

  private async loadRun(organizationId: string, id: string) {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const [row] = await this.db
      .select({ run: comparisonRuns, src, tgt, user: users.displayName })
      .from(comparisonRuns)
      .innerJoin(src, eq(src.id, comparisonRuns.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, comparisonRuns.targetEnvironmentId))
      .leftJoin(users, eq(users.id, comparisonRuns.createdByUserId))
      .where(and(eq(comparisonRuns.id, id), eq(comparisonRuns.organizationId, organizationId)));
    return row;
  }

  private toDto(row: NonNullable<Awaited<ReturnType<ComparisonService['loadRun']>>>): ComparisonRunDto {
    return {
      id: row.run.id,
      status: row.run.status,
      sourceEnvironment: envRef(row.src),
      targetEnvironment: envRef(row.tgt),
      scope: row.run.scope ?? null,
      summary: row.run.summary ?? null,
      errorMessage: row.run.errorMessage,
      progressMessage: row.run.progressMessage,
      createdAt: row.run.createdAt.toISOString(),
      completedAt: row.run.completedAt?.toISOString() ?? null,
      createdBy: row.user ?? null,
    };
  }

  async get(ctx: Pick<RequestContext, 'organizationId'>, id: string): Promise<ComparisonRunDto> {
    const row = await this.loadRun(ctx.organizationId, id);
    if (!row) throw notFound('Comparison');
    return this.toDto(row);
  }

  async tables(ctx: Pick<RequestContext, 'organizationId'>, id: string): Promise<TableDiff[]> {
    await this.get(ctx, id);
    const rows = await this.db
      .select()
      .from(comparisonTableResults)
      .where(eq(comparisonTableResults.comparisonRunId, id))
      .orderBy(comparisonTableResults.logicalName);
    return rows.map((r) => {
      const counts = { MATCH: 0, SOURCE_ONLY: 0, TARGET_ONLY: 0, DIFFERENT: 0, INCOMPATIBLE: 0 };
      for (const c of r.columns) counts[c.status]++;
      return {
        logicalName: r.logicalName,
        displayName: r.displayName,
        status: r.status as TableDiff['status'],
        isCustom: r.isCustom,
        deep: r.deep,
        differences: r.differences,
        columns: r.columns,
        relationships: r.relationships,
        keys: r.keys,
        counts,
      };
    });
  }

  async list(
    ctx: RequestContext,
    filter: { sourceEnvironmentId?: string; targetEnvironmentId?: string } = {},
    limit = 20,
  ) {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const conditions = [eq(comparisonRuns.organizationId, ctx.organizationId)];
    if (filter.sourceEnvironmentId)
      conditions.push(eq(comparisonRuns.sourceEnvironmentId, filter.sourceEnvironmentId));
    if (filter.targetEnvironmentId)
      conditions.push(eq(comparisonRuns.targetEnvironmentId, filter.targetEnvironmentId));
    const rows = await this.db
      .select({ run: comparisonRuns, src, tgt, user: users.displayName })
      .from(comparisonRuns)
      .innerJoin(src, eq(src.id, comparisonRuns.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, comparisonRuns.targetEnvironmentId))
      .leftJoin(users, eq(users.id, comparisonRuns.createdByUserId))
      .where(and(...conditions))
      .orderBy(desc(comparisonRuns.createdAt))
      .limit(limit);
    return rows.map((r) => this.toDto(r));
  }

  /** Most recent completed comparison for an environment pair (either direction excluded). */
  async latestCompleted(organizationId: string, sourceEnvironmentId: string, targetEnvironmentId: string) {
    const [row] = await this.db
      .select({ id: comparisonRuns.id })
      .from(comparisonRuns)
      .where(
        and(
          eq(comparisonRuns.organizationId, organizationId),
          eq(comparisonRuns.sourceEnvironmentId, sourceEnvironmentId),
          eq(comparisonRuns.targetEnvironmentId, targetEnvironmentId),
          or(eq(comparisonRuns.status, 'COMPLETED')),
        ),
      )
      .orderBy(desc(comparisonRuns.createdAt))
      .limit(1);
    return row?.id ?? null;
  }
}
