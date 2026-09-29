import type { Logger } from 'pino';
import { AuthService } from '../auth/auth-service';
import { graphScopes, MicrosoftIdentityService } from '../auth/microsoft-identity';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import { ConnectionFactory } from '../dataverse/factory';
import { JobQueue, Worker } from '../jobs/queue';
import { AccessRequestService } from './access-request-service';
import { AlertService } from './alert-service';
import { AnalysisService } from './analysis-service';
import { DataComparisonService } from './data-comparison-service';
import { AuditService } from './audit-service';
import { ComparisonService } from './comparison-service';
import { EnvironmentService } from './environment-service';
import { InsightsService } from './insights-service';
import { MappingWorkbookService } from './mapping-workbook-service';
import { MetadataService } from './metadata-service';
import { MigrationEngine } from './migration-engine';
import { MigrationRunService } from './migration-run-service';
import { PlanningService } from './planning-service';
import { ProjectService } from './project-service';
import { ConnectionService } from './connection-service';
import { DataQualityService } from './data-quality-service';
import { ProfilingService } from './profiling-service';
import { TransformationService } from './transformation/transformation-service';
import { DiagnosticsService } from './diagnostics-service';
import { PreflightService } from './preflight-service';
import { RemediationService } from './remediation-service';
import { ScheduleService, Scheduler } from './schedule-service';
import { StagedSourceService } from './staged-source-service';
import { PrincipalService } from './principal-service';
import { ValidationService } from './validation-service';

export type Services = ReturnType<typeof createServices>;

export function createServices(config: AppConfig, db: AppDb, logger: Logger) {
  const audit = new AuditService(db, logger);
  // Declared early: several services take it, and a webhook that announces what happened has to
  // exist before the things that happen.
  const alerts = new AlertService(config, logger.child({ component: 'alerts' }));
  const identity = new MicrosoftIdentityService(config, db, logger);
  const auth = new AuthService(config, db, identity, audit, logger);
  const connections = new ConnectionFactory(config, db, logger, identity);
  const queue = new JobQueue(db);
  const environments = new EnvironmentService(db, connections, audit, logger);
  const metadata = new MetadataService(db, logger);
  const comparisons = new ComparisonService(db, environments, metadata, connections, queue, audit, logger);
  const principals = new PrincipalService(db, environments, connections, audit, logger);
  const planning = new PlanningService(
    db,
    config,
    environments,
    metadata,
    connections,
    comparisons,
    principals,
    audit,
    logger,
  );
  const transformations = new TransformationService(
    db,
    planning,
    environments,
    metadata,
    connections,
    audit,
    logger,
  );
  const runs = new MigrationRunService(
    db,
    config,
    planning,
    transformations,
    environments,
    queue,
    audit,
    logger,
  );
  const engine = new MigrationEngine(
    db,
    environments,
    metadata,
    connections,
    principals,
    audit,
    logger,
    alerts,
  );
  const validation = new ValidationService(db, environments, metadata, connections, queue, audit, logger);
  const preflight = new PreflightService(
    db,
    environments,
    metadata,
    connections,
    principals,
    runs,
    queue,
    audit,
    logger,
  );
  const diagnostics = new DiagnosticsService(
    config,
    environments,
    metadata,
    connections,
    principals,
    identity,
    logger,
  );
  const connectionAdmin = new ConnectionService(db, connections, audit, logger);
  const profiling = new ProfilingService(db, environments, metadata, connections, logger);
  const projectsSvc = new ProjectService(db, environments, audit, logger);
  const analysis = new AnalysisService(
    db,
    projectsSvc,
    environments,
    metadata,
    connections,
    profiling,
    queue,
    audit,
    logger,
  );
  const dataComparisons = new DataComparisonService(
    db,
    projectsSvc,
    environments,
    metadata,
    connections,
    queue,
    audit,
    logger,
  );
  const dataQuality = new DataQualityService(db, profiling, environments, metadata, connections, logger);
  const mappingWorkbooks = new MappingWorkbookService(
    db,
    projectsSvc,
    planning,
    transformations,
    analysis,
    audit,
    logger,
  );
  const schedules = new ScheduleService(db, runs, audit, logger, alerts);
  const stagedSources = new StagedSourceService(
    db,
    metadata,
    audit,
    logger,
    // Only wired when reading from OneDrive and SharePoint is switched on: without it the service
    // refuses with an explanation rather than failing on a token it was never going to get.
    config.MICROSOFT_FILES_ENABLED && config.microsoftEnabled
      ? (userId: string) => identity.getAccessToken(userId, graphScopes())
      : undefined,
  );
  const accessRequests = new AccessRequestService(db, logger, alerts);
  const remediation = new RemediationService(planning, comparisons, principals, preflight);
  const insights = new InsightsService(
    db,
    environments,
    metadata,
    connections,
    comparisons,
    runs,
    validation,
    projectsSvc,
    analysis,
  );

  /**
   * The scheduler lives beside the worker: both do work with no request behind them, and both are
   * started only by a process that is meant to act on its own.
   */
  const createScheduler = () =>
    new Scheduler(schedules, logger.child({ component: 'scheduler' }), {
      pollMs: config.SCHEDULER_POLL_MS,
    });

  const createWorker = () =>
    new Worker(
      queue,
      {
        COMPARISON: (job) => comparisons.execute(job.targetId),
        MIGRATION: (job, s) => engine.execute(job.targetId, s.heartbeat),
        VALIDATION: (job, s) => validation.execute(job.targetId, s.heartbeat),
        PREFLIGHT: (job, s) => preflight.execute(job.targetId, s.heartbeat),
        ANALYSIS: (job, s) => analysis.execute(job.targetId, s.heartbeat),
        DATA_COMPARISON: (job, s) => dataComparisons.execute(job.targetId, s.heartbeat),
      },
      logger.child({ component: 'worker' }),
      { pollMs: config.WORKER_POLL_MS, concurrency: 2, staleMs: 90_000 },
    );

  return {
    config,
    db,
    logger,
    audit,
    identity,
    auth,
    connections,
    queue,
    environments,
    principals,
    metadata,
    comparisons,
    planning,
    runs,
    engine,
    validation,
    preflight,
    transformations,
    profiling,
    dataQuality,
    projects: projectsSvc,
    analysis,
    dataComparisons,
    mappingWorkbooks,
    schedules,
    stagedSources,
    accessRequests,
    alerts,
    createScheduler,
    diagnostics,
    remediation,
    connectionAdmin,
    insights,
    createWorker,
  };
}
