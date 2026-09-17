import type { Logger } from 'pino';
import { AuthService } from '../auth/auth-service';
import { MicrosoftIdentityService } from '../auth/microsoft-identity';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import { ConnectionFactory } from '../dataverse/factory';
import { JobQueue, Worker } from '../jobs/queue';
import { AuditService } from './audit-service';
import { ComparisonService } from './comparison-service';
import { EnvironmentService } from './environment-service';
import { InsightsService } from './insights-service';
import { MetadataService } from './metadata-service';
import { MigrationEngine } from './migration-engine';
import { MigrationRunService } from './migration-run-service';
import { PlanningService } from './planning-service';
import { DiagnosticsService } from './diagnostics-service';
import { PreflightService } from './preflight-service';
import { RemediationService } from './remediation-service';
import { PrincipalService } from './principal-service';
import { ValidationService } from './validation-service';

export type Services = ReturnType<typeof createServices>;

export function createServices(config: AppConfig, db: AppDb, logger: Logger) {
  const audit = new AuditService(db, logger);
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
  const runs = new MigrationRunService(db, config, planning, environments, queue, audit, logger);
  const engine = new MigrationEngine(db, environments, metadata, connections, principals, audit, logger);
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
  const remediation = new RemediationService(planning, comparisons, principals, preflight);
  const insights = new InsightsService(
    db,
    environments,
    metadata,
    connections,
    comparisons,
    runs,
    validation,
  );

  const createWorker = () =>
    new Worker(
      queue,
      {
        COMPARISON: (job) => comparisons.execute(job.targetId),
        MIGRATION: (job, s) => engine.execute(job.targetId, s.heartbeat),
        VALIDATION: (job, s) => validation.execute(job.targetId, s.heartbeat),
        PREFLIGHT: (job, s) => preflight.execute(job.targetId, s.heartbeat),
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
    diagnostics,
    remediation,
    insights,
    createWorker,
  };
}
