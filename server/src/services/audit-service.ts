import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AuditEventDto } from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { auditEvents, environments, users } from '../db/schema';
import { alias } from 'drizzle-orm/pg-core';

export type AuditAction =
  | 'AUTH_SIGN_IN'
  | 'AUTH_SIGN_OUT'
  | 'ENVIRONMENTS_DISCOVERED'
  | 'ENVIRONMENT_CONNECTION_TESTED'
  | 'WORKSPACE_SELECTED'
  | 'COMPARISON_REQUESTED'
  | 'COMPARISON_COMPLETED'
  | 'MIGRATION_PLAN_CREATED'
  | 'MIGRATION_PLAN_UPDATED'
  | 'MIGRATION_EXECUTION_REQUESTED'
  | 'MIGRATION_COMPLETED'
  | 'MIGRATION_CANCEL_REQUESTED'
  | 'MIGRATION_PAUSE_REQUESTED'
  | 'MIGRATION_RESUMED'
  | 'MIGRATION_RETRY_REQUESTED'
  | 'BUSINESS_LOGIC_BYPASS_ENABLED'
  | 'VALIDATION_REQUESTED'
  | 'VALIDATION_COMPLETED'
  | 'TABLE_CATEGORY_CHANGED'
  | 'DEMO_DATA_RESET';

export interface AuditInput {
  organizationId: string;
  userId?: string | null;
  action: AuditAction;
  outcome: 'SUCCESS' | 'FAILURE' | 'REQUESTED';
  sourceEnvironmentId?: string | null;
  targetEnvironmentId?: string | null;
  runId?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
}

export class AuditService {
  constructor(
    private readonly db: AppDb,
    private readonly logger: Logger,
  ) {}

  async record(input: AuditInput): Promise<void> {
    try {
      await this.db.insert(auditEvents).values({
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        action: input.action,
        outcome: input.outcome,
        sourceEnvironmentId: input.sourceEnvironmentId ?? null,
        targetEnvironmentId: input.targetEnvironmentId ?? null,
        runId: input.runId ?? null,
        requestId: input.requestId ?? null,
        details: input.details ?? null,
      });
      this.logger.info(
        { audit: input.action, outcome: input.outcome, runId: input.runId, organizationId: input.organizationId, userId: input.userId },
        'audit event',
      );
    } catch (err) {
      // Audit failures must be visible but should not break the user's operation.
      this.logger.error({ err, action: input.action }, 'Failed to persist audit event');
    }
  }

  async list(organizationId: string, limit = 100): Promise<AuditEventDto[]> {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const rows = await this.db
      .select({ e: auditEvents, user: users.displayName, src: src.displayName, tgt: tgt.displayName })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.userId))
      .leftJoin(src, and(eq(src.id, auditEvents.sourceEnvironmentId), eq(src.organizationId, organizationId)))
      .leftJoin(tgt, and(eq(tgt.id, auditEvents.targetEnvironmentId), eq(tgt.organizationId, organizationId)))
      .where(eq(auditEvents.organizationId, organizationId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(Math.min(limit, 500));
    return rows.map((r) => ({
      id: r.e.id,
      action: r.e.action,
      outcome: r.e.outcome,
      user: r.user,
      sourceEnvironment: r.src,
      targetEnvironment: r.tgt,
      runId: r.e.runId,
      details: r.e.details,
      createdAt: r.e.createdAt.toISOString(),
    }));
  }
}
