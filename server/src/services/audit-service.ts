import { and, desc, eq, gte } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  auditCategory,
  type AuditCategory,
  type AuditEventDto,
  type AuditPageDto,
} from '../../../shared/domain';
import { scrubSecrets } from '../logger';
import type { AppDb } from '../db/client';
import { auditEvents, environments, users } from '../db/schema';
import { alias } from 'drizzle-orm/pg-core';

/** How many recent events are considered when filtering. Beyond this, narrow the period. */
const MAX_SCANNED = 2000;

/**
 * The most an audit event may carry, in characters of serialised JSON.
 *
 * Generous on purpose: the point is to stop one pathological event — a validation result, a source
 * record, an error with a stack — from becoming an unbounded row, not to keep events small.
 */
const MAX_DETAIL_CHARS = 8_000;
/** A single value longer than this is summarised rather than stored whole. */
const MAX_VALUE_CHARS = 1_000;

/**
 * Keeps an audit event's detail bounded without destroying what it was for.
 *
 * Truncating the middle of a JSON document is the wrong answer twice over: it leaves something that
 * no longer parses, and it throws away whichever half happened to be second. Instead each value is
 * shortened on its own, and a value that was shortened says so in place — so the shape of the event
 * survives, every key is still there, and a reader can see exactly where the detail was cut and go
 * to the run or the validation report for the whole of it.
 *
 * What is never touched: the action, who did it, when, the environments and the run. Those are the
 * forensic record. This only bounds the free-form payload hanging off it.
 */
export function boundDetails(details: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!details) return null;

  /**
   * Scrubbed before anything else, and whether or not it needs shortening.
   *
   * The audit trail is the one place a secret would be most durable if it got in: rows are kept
   * deliberately, exported, and read by people who are not the person who wrote them. Nothing
   * deliberately puts a credential here — a connection event records `passwordChanged: true`, not the
   * password — but an audit payload is free-form and the free-form thing most likely to carry one is an
   * error message, which is exactly where a connection string ends up. So the same scrubber the logs
   * and the error responses use runs over every string on the way in. Defence in depth: it is not
   * where the protection is supposed to come from, it is the layer that holds when the first one is
   * forgotten.
   */
  const scrubbed = scrubValue(details) as Record<string, unknown>;
  const serialised = safeLength(scrubbed);
  if (serialised <= MAX_DETAIL_CHARS) return scrubbed;

  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scrubbed)) {
    bounded[key] = boundValue(value);
  }
  bounded['_truncated'] = {
    reason: 'This event carried more detail than an audit row stores.',
    originalCharacters: serialised,
    limit: MAX_DETAIL_CHARS,
    where: 'Individual values were shortened; every key is still present.',
  };
  return bounded;
}

/** How deep the walk goes. A structure deeper than this is summarised rather than followed. */
const MAX_DEPTH = 8;

/** Applies the secret scrubber to every string in a structure, leaving the shape alone. */
function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function boundValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length <= MAX_VALUE_CHARS
      ? value
      : `${value.slice(0, MAX_VALUE_CHARS)}… (${value.length} characters, shortened for the audit trail)`;
  }
  // A depth limit rather than a visited set: it bounds a deeply nested structure and a circular
  // one with the same rule, and an audit write is the wrong place to find out which it was.
  if (depth >= MAX_DEPTH) return '… (nested too deeply for the audit trail)';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => boundValue(v, depth + 1));
    return value.length <= 20 ? head : [...head, `… ${value.length - 20} more`];
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = boundValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function safeLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Circular or otherwise unserialisable: treat as over the limit so it gets bounded.
    return Number.MAX_SAFE_INTEGER;
  }
}

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
  /** A workspace role was changed: who, by whom, from what to what. */
  | 'TEAM_ROLE_CHANGED'
  // Somebody took a copy of what happened. Worth recording: an evidence package leaves the
  // deployment and is the artefact most likely to be forwarded.
  | 'EVIDENCE_EXPORTED'
  | 'EVIDENCE_VERIFIED'
  | 'MIGRATION_RECONCILED'
  | 'READINESS_BLOCKER_OVERRIDDEN'
  | 'READINESS_OVERRIDE_WITHDRAWN'
  | 'PRINCIPAL_MAPPING_CHANGED'
  | 'PREFLIGHT_REQUESTED'
  | 'PREFLIGHT_COMPLETED'
  | 'READ_ONLY_WRITE_BLOCKED'
  | 'CERTIFICATION_WRITE_PERMITTED'
  | 'FINDING_DISPOSITION_SET'
  | 'CONNECTION_CREATED'
  | 'CONNECTION_UPDATED'
  | 'CONNECTION_TESTED'
  | 'CONNECTION_DELETED'
  | 'OBJECT_MAPPING_CHANGED'
  | 'CHOICE_MAPPING_CHANGED'
  | 'TRANSFORMATION_CHANGED'
  | 'LOSSY_TRANSFORMATION_ACKNOWLEDGED'
  | 'DATA_PROFILED'
  | 'PROJECT_CREATED'
  | 'PROJECT_ARCHIVED'
  | 'ANALYSIS_REQUESTED'
  | 'ANALYSIS_COMPLETED'
  | 'DATA_COMPARISON_REQUESTED'
  | 'DATA_COMPARISON_COMPLETED'
  | 'MAPPING_WORKBOOK_EXPORTED'
  | 'MAPPING_WORKBOOK_IMPORTED'
  | 'SCHEDULE_CREATED'
  | 'SCHEDULE_UPDATED'
  | 'SCHEDULE_DELETED'
  | 'SCHEDULE_FIRED'
  | 'SCHEDULE_PAUSED'
  | 'STAGED_SOURCE_IMPORTED'
  | 'STAGED_SOURCE_TABLE_REMOVED'
  | 'DATASET_RENAMED'
  | 'DEMO_DATA_RESET';

export interface AuditInput {
  organizationId: string;
  userId?: string | null;
  action: AuditAction;
  outcome: 'SUCCESS' | 'FAILURE' | 'REQUESTED';
  sourceEnvironmentId?: string | null;
  targetEnvironmentId?: string | null;
  runId?: string | null;
  /** The project this action belonged to, where it belonged to one. */
  projectId?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
}

export class AuditService {
  constructor(
    private readonly db: AppDb,
    private readonly logger: Logger,
  ) {}

  async record(input: AuditInput): Promise<void> {
    // Details are bounded before they are stored. See `boundDetails`.
    try {
      await this.db.insert(auditEvents).values({
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        action: input.action,
        outcome: input.outcome,
        sourceEnvironmentId: input.sourceEnvironmentId ?? null,
        targetEnvironmentId: input.targetEnvironmentId ?? null,
        runId: input.runId ?? null,
        projectId: input.projectId ?? null,
        requestId: input.requestId ?? null,
        details: boundDetails(input.details ?? null),
      });
      this.logger.info(
        {
          audit: input.action,
          outcome: input.outcome,
          runId: input.runId,
          projectId: input.projectId,
          organizationId: input.organizationId,
          userId: input.userId,
        },
        'audit event',
      );
    } catch (err) {
      // Audit failures must be visible but should not break the user's operation.
      this.logger.error({ err, action: input.action }, 'Failed to persist audit event');
    }
  }

  /**
   * The trail, filtered.
   *
   * An audit trail nobody can search is an audit trail nobody reads, and one nobody reads is
   * decoration. The category is computed from the action rather than stored, so filtering by it
   * happens here over the matching set rather than in SQL over a column that does not exist.
   */
  async list(
    organizationId: string,
    opts: {
      limit?: number;
      category?: AuditCategory;
      outcome?: 'SUCCESS' | 'FAILURE' | 'REQUESTED';
      user?: string;
      search?: string;
      since?: Date;
    } = {},
  ): Promise<AuditPageDto> {
    const limit = Math.min(opts.limit ?? 100, 500);
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const where = [eq(auditEvents.organizationId, organizationId)];
    if (opts.outcome) where.push(eq(auditEvents.outcome, opts.outcome));
    if (opts.since) where.push(gte(auditEvents.createdAt, opts.since));

    // Bounded before anything is filtered in memory: a trail with a year of history in it must not
    // be loaded whole to answer a filtered question.
    const rows = await this.db
      .select({ e: auditEvents, user: users.displayName, src: src.displayName, tgt: tgt.displayName })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.userId))
      .leftJoin(src, and(eq(src.id, auditEvents.sourceEnvironmentId), eq(src.organizationId, organizationId)))
      .leftJoin(tgt, and(eq(tgt.id, auditEvents.targetEnvironmentId), eq(tgt.organizationId, organizationId)))
      .where(and(...where))
      .orderBy(desc(auditEvents.createdAt))
      .limit(MAX_SCANNED);

    const needle = opts.search?.trim().toLowerCase();
    const matching = rows.filter((r) => {
      if (opts.category && auditCategory(r.e.action) !== opts.category) return false;
      if (opts.user && r.user !== opts.user) return false;
      if (needle) {
        const hay = [r.e.action, r.user, r.src, r.tgt, JSON.stringify(r.e.details ?? {})]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    const toDto = (r: (typeof rows)[number]): AuditEventDto => ({
      id: r.e.id,
      action: r.e.action,
      outcome: r.e.outcome,
      user: r.user,
      sourceEnvironment: r.src,
      targetEnvironment: r.tgt,
      runId: r.e.runId,
      projectId: r.e.projectId,
      details: r.e.details,
      createdAt: r.e.createdAt.toISOString(),
    });

    return {
      items: matching.slice(0, limit).map(toDto),
      total: matching.length,
      users: [...new Set(rows.map((r) => r.user).filter((u): u is string => Boolean(u)))].sort(),
    };
  }
}
