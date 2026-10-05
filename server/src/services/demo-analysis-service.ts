import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { ProjectDto } from '../../../shared/domain';
import {
  customerModernizationFiles,
  DEMO_ANALYSIS_PROJECT_NAME,
  DEMO_DATASET_NAME,
} from '../demo/customer-modernization';
import type { AppDb } from '../db/client';
import { environments, projects } from '../db/schema';
import type { AnalysisService } from './analysis-service';
import type { RequestContext } from './context';
import type { ProjectService } from './project-service';
import type { StagedSourceService } from './staged-source-service';

/**
 * Builds the worked example, through the product's own path.
 *
 * Nothing here is a fixture inserted into the database. It creates a file dataset the way a user does,
 * imports four CSVs through the real importer, attaches the dataset to an analysis project, and runs the
 * real analysis. The consequence that matters: if the importer breaks, or the profiler regresses, or a
 * finding rule stops firing, **the demo breaks too** — which is the only kind of demo worth having, because
 * a seeded one would keep looking impressive long after the product stopped working.
 *
 * It is idempotent. Asking twice returns the project that already exists rather than a second one, which
 * also means the unique-name rule is never the thing that fails a demo.
 */
export class DemoAnalysisService {
  constructor(
    private readonly db: AppDb,
    private readonly projects: ProjectService,
    private readonly staged: StagedSourceService,
    private readonly analysis: AnalysisService,
    private readonly logger: Logger,
  ) {}

  async build(ctx: RequestContext): Promise<ProjectDto> {
    const existing = await this.existingProject(ctx);
    if (existing) {
      this.logger.info({ projectId: existing.id }, 'Demo analysis project already exists');
      return this.projects.get(ctx, existing.id);
    }

    const dataset = await this.datasetEnvironment(ctx);
    const files = customerModernizationFiles();
    for (const file of files) {
      await this.staged.importFile(ctx, dataset.id, {
        filename: file.filename,
        content: Buffer.from(file.content, 'utf8'),
      });
    }
    this.logger.info({ files: files.length, environmentId: dataset.id }, 'Demo dataset imported');

    const project = await this.projects.create(ctx, {
      name: DEMO_ANALYSIS_PROJECT_NAME,
      kind: 'ANALYSIS',
      description:
        'A legacy CRM extract with the problems a legacy CRM extract actually has. Every finding below was produced by the analysis engine reading these four files.',
      sourceEnvironmentId: dataset.id,
    });

    // The real analysis, over every table the import produced.
    await this.analysis.create(ctx, project.id, {});
    this.logger.info({ projectId: project.id }, 'Demo analysis project built');
    return this.projects.get(ctx, project.id);
  }

  private async existingProject(ctx: RequestContext) {
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, ctx.organizationId),
          eq(projects.name, DEMO_ANALYSIS_PROJECT_NAME),
          eq(projects.status, 'ACTIVE'),
        ),
      );
    return row ?? null;
  }

  /** The file dataset, reused if a previous attempt got this far and then failed. */
  private async datasetEnvironment(ctx: RequestContext) {
    const [existing] = await this.db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.organizationId, ctx.organizationId),
          eq(environments.displayName, DEMO_DATASET_NAME),
        ),
      );
    if (existing) return existing;
    const created = await this.staged.create(ctx, { displayName: DEMO_DATASET_NAME, kind: 'UPLOAD' });
    const [row] = await this.db.select().from(environments).where(eq(environments.id, created.id));
    return row!;
  }
}
