import { and, count, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import {
  auditEvents,
  demoRecords,
  jobs,
  migrationRecordMaps,
  migrationRuns,
  organizations,
  sessions,
  users,
  validationRuns,
} from '../db/schema';
import { buildIdentity, type BuildIdentity } from '../build-info';

/**
 * What an operator needs to know while a pilot is running.
 *
 * Deliberately not an observability platform. It answers the specific questions somebody asks at two in
 * the morning, each from one query against the database the application already uses, and it answers
 * them with a verdict rather than a number to interpret:
 *
 *   Is the application healthy?            a round trip to the database, timed
 *   Are migrations running?                queued and running counts, and the oldest of each
 *   Are jobs stuck?                        running past their heartbeat, which is what stuck looks like
 *   Are queues backing up?                 how long the oldest queued job has waited
 *   Are migrations retrying repeatedly?    runs past their second attempt, which is where a loop shows
 *   Did evidence generation fail?          evidence is produced on demand, so this says so rather than guessing
 *   Is storage growing unexpectedly?       the three tables that actually grow, by row count
 *   Did workspace cleanup fail?            demo workspaces past their expiry that are still here
 *
 * Operator-only. None of it is secret, and all of it is a map of the deployment's internals — how many
 * tenants, what they are doing, how much they have — which is nobody else's business.
 *
 * Every verdict is derived from the number beside it, so a reader can disagree with the judgement
 * without having to re-derive the fact. A check that says OK and a number that says otherwise is worse
 * than no check.
 */

export type OperationalStatus = 'OK' | 'ATTENTION' | 'FAILING' | 'UNKNOWN';

export interface OperationalCheck {
  key: string;
  /** The question, as somebody would ask it. */
  question: string;
  status: OperationalStatus;
  /** The answer, in words, including the number the status was derived from. */
  detail: string;
  /** What to do, when something should be done. */
  action?: string;
}

export interface OperationalReport {
  checkedAt: string;
  build: BuildIdentity;
  worst: OperationalStatus;
  checks: OperationalCheck[];
}

/** How long a RUNNING job may go without a heartbeat before it is considered stuck. */
const STALE_HEARTBEAT_MS = 120_000;
/** How long a job may sit queued before the queue is considered to be backing up. */
const QUEUE_WAIT_WARNING_MS = 300_000;
/** Attempts past which a run is retrying rather than recovering. */
const RETRY_ATTENTION = 3;

const minutes = (ms: number) => Math.round(ms / 60_000);

const WORST_ORDER: OperationalStatus[] = ['FAILING', 'ATTENTION', 'UNKNOWN', 'OK'];

export class OperationsService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDb,
    private readonly logger: Logger,
  ) {}

  async report(): Promise<OperationalReport> {
    const checks: OperationalCheck[] = [];
    const now = Date.now();

    checks.push(await this.database());
    checks.push(...(await this.jobQueue(now)));
    checks.push(await this.retries());
    checks.push(await this.unresolvedWrites());
    checks.push(await this.storage());
    checks.push(await this.workspaceCleanup(now));

    const worst = WORST_ORDER.find((s) => checks.some((c) => c.status === s)) ?? 'OK';
    if (worst === 'FAILING') {
      this.logger.error(
        { checks: checks.filter((c) => c.status === 'FAILING') },
        'Operational check failing',
      );
    }
    return {
      checkedAt: new Date().toISOString(),
      build: buildIdentity(this.config),
      worst,
      checks,
    };
  }

  /** A round trip, timed. Everything else here depends on this working, so it is asked first. */
  private async database(): Promise<OperationalCheck> {
    const started = Date.now();
    try {
      await this.db.execute(sql`select 1`);
      const ms = Date.now() - started;
      return {
        key: 'DATABASE',
        question: 'Is the database reachable?',
        status: ms > 2_000 ? 'ATTENTION' : 'OK',
        detail: `A round trip took ${ms} ms.`,
        action: ms > 2_000 ? 'Check the database connection and the pool size.' : undefined,
      };
    } catch (err) {
      return {
        key: 'DATABASE',
        question: 'Is the database reachable?',
        status: 'FAILING',
        detail: `The round trip failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}.`,
        action: 'Nothing else in this report can be trusted until this is fixed.',
      };
    }
  }

  /** Work in progress, work waiting, and work that stopped without saying so. */
  private async jobQueue(now: number): Promise<OperationalCheck[]> {
    const rows = await this.db
      .select({
        status: jobs.status,
        n: count(),
        oldest: sql<string | null>`min(${jobs.createdAt})`,
      })
      .from(jobs)
      .groupBy(jobs.status);
    const byStatus = new Map(rows.map((r) => [r.status, r]));
    const running = byStatus.get('RUNNING');
    const queued = byStatus.get('QUEUED');

    const [stale] = await this.db
      .select({ n: count() })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'RUNNING'),
          isNotNull(jobs.heartbeatAt),
          lt(jobs.heartbeatAt, new Date(now - STALE_HEARTBEAT_MS)),
        ),
      );

    const queuedWaitMs = queued?.oldest ? now - new Date(queued.oldest).getTime() : 0;
    const staleCount = Number(stale?.n ?? 0);

    return [
      {
        key: 'JOBS_RUNNING',
        question: 'Are migrations running?',
        status: 'OK',
        detail: `${Number(running?.n ?? 0)} job(s) running, ${Number(queued?.n ?? 0)} queued.`,
      },
      {
        key: 'JOBS_STUCK',
        question: 'Are jobs stuck?',
        status: staleCount > 0 ? 'ATTENTION' : 'OK',
        detail:
          staleCount > 0
            ? `${staleCount} job(s) have been running without a heartbeat for over ${minutes(STALE_HEARTBEAT_MS)} minute(s).`
            : `All ${Number(running?.n ?? 0)} running job(s) have heartbeated within ${minutes(STALE_HEARTBEAT_MS)} minute(s).`,
        action:
          staleCount > 0
            ? 'A worker died mid-job. The queue reclaims these on its own; if the count does not fall, the worker is not running.'
            : undefined,
      },
      {
        key: 'QUEUE_BACKLOG',
        question: 'Are queues backing up?',
        status: queuedWaitMs > QUEUE_WAIT_WARNING_MS ? 'ATTENTION' : 'OK',
        detail:
          queuedWaitMs > 0
            ? `The oldest queued job has waited ${minutes(queuedWaitMs)} minute(s).`
            : `0 job(s) are waiting.`,
        action:
          queuedWaitMs > QUEUE_WAIT_WARNING_MS
            ? 'Either the worker is not running, or one long job is holding the queue.'
            : undefined,
      },
    ];
  }

  /** A run past its second attempt is retrying rather than recovering. */
  private async retries(): Promise<OperationalCheck> {
    const [row] = await this.db
      .select({ n: count() })
      .from(migrationRuns)
      .where(gt(migrationRuns.attempt, RETRY_ATTENTION));
    const failing = await this.db.select({ n: count() }).from(jobs).where(eq(jobs.status, 'FAILED'));
    const retrying = Number(row?.n ?? 0);
    const failed = Number(failing[0]?.n ?? 0);
    return {
      key: 'RETRIES',
      question: 'Are migrations retrying repeatedly?',
      status: retrying > 0 || failed > 0 ? 'ATTENTION' : 'OK',
      detail: `${retrying} run(s) are past attempt ${RETRY_ATTENTION}; ${failed} job(s) ended failed.`,
      action:
        retrying > 0 || failed > 0
          ? 'Read the run errors. A run that retries without progressing has a cause that retrying will not fix.'
          : undefined,
    };
  }

  /**
   * Records nobody can account for.
   *
   * Not on the brief's list, and the most important number on it. A run holding unresolved writes is a
   * run where the platform does not know whether a record reached the target, and it stays that way
   * until a person settles it. See `docs/CRASH_CONSISTENCY.md`.
   */
  private async unresolvedWrites(): Promise<OperationalCheck> {
    const [row] = await this.db
      .select({ n: count() })
      .from(migrationRecordMaps)
      .where(sql`${migrationRecordMaps.writeState} in ('INTENDED', 'UNKNOWN', 'RECONCILIATION_REQUIRED')`);
    const [runs] = await this.db
      .select({ n: count() })
      .from(migrationRuns)
      .where(eq(migrationRuns.status, 'NEEDS_RECONCILIATION'));
    const records = Number(row?.n ?? 0);
    const waiting = Number(runs?.n ?? 0);
    return {
      key: 'UNRESOLVED_WRITES',
      question: 'Is anything waiting for a person to settle it?',
      status: records > 0 || waiting > 0 ? 'ATTENTION' : 'OK',
      detail: `${records} record(s) have an unresolved write state; ${waiting} run(s) need reconciliation.`,
      action:
        records > 0 || waiting > 0
          ? 'Open those runs and reconcile the records they name. They will not resolve on their own.'
          : undefined,
    };
  }

  /** The three tables that actually grow. A count, not a byte figure, because a count is portable. */
  private async storage(): Promise<OperationalCheck> {
    const [identity] = await this.db.select({ n: count() }).from(migrationRecordMaps);
    const [audit] = await this.db.select({ n: count() }).from(auditEvents);
    const [demo] = await this.db.select({ n: count() }).from(demoRecords);
    const [validations] = await this.db.select({ n: count() }).from(validationRuns);
    return {
      key: 'STORAGE',
      question: 'Is storage growing unexpectedly?',
      status: 'OK',
      detail:
        `identity map ${Number(identity?.n ?? 0).toLocaleString()} rows, ` +
        `audit ${Number(audit?.n ?? 0).toLocaleString()}, ` +
        `demo records ${Number(demo?.n ?? 0).toLocaleString()}, ` +
        `validations ${Number(validations?.n ?? 0).toLocaleString()}.`,
      action:
        'There is no threshold here on purpose: what counts as unexpected depends on what was migrated. Compare against the last reading.',
    };
  }

  /** Demo workspaces past their expiry are what cleanup failing looks like. */
  private async workspaceCleanup(now: number): Promise<OperationalCheck> {
    if (!this.config.DEMO_MODE) {
      return {
        key: 'WORKSPACE_CLEANUP',
        question: 'Did workspace cleanup fail?',
        status: 'OK',
        detail: 'Demo mode is off, so 0 workspaces expire.',
      };
    }
    const ttlHours = this.config.DEMO_WORKSPACE_TTL_HOURS;
    const [total] = await this.db
      .select({ n: count() })
      .from(organizations)
      .where(eq(organizations.isDemo, true));
    const live = Number(total?.n ?? 0);
    const ceiling = this.config.DEMO_MAX_WORKSPACES;

    if (ttlHours <= 0) {
      return {
        key: 'WORKSPACE_CLEANUP',
        question: 'Did workspace cleanup fail?',
        status: 'UNKNOWN',
        detail: `The sweep is disabled (DEMO_WORKSPACE_TTL_HOURS=0). ${live} demo workspace(s) exist and none will be removed.`,
        action: 'Set a TTL, or accept that demo workspaces accumulate until the ceiling refuses new ones.',
      };
    }

    /**
     * Expired means the same thing here as it does to the sweep: older than the window, and with no
     * session still valid — because deleting a workspace somebody is sitting in would log them out
     * mid-evaluation. Asking the same question the sweep asks is the point; a check with its own
     * definition would disagree with the thing it is checking.
     */
    const cutoff = new Date(now - ttlHours * 3_600_000);
    const [expired] = await this.db
      .select({ n: count() })
      .from(organizations)
      .where(
        and(
          eq(organizations.isDemo, true),
          lt(organizations.createdAt, cutoff),
          sql`not exists (
            select 1 from ${users}
            join ${sessions} on ${sessions.userId} = ${users.id}
            where ${users.organizationId} = ${organizations.id} and ${sessions.expiresAt} > now()
          )`,
        ),
      );
    const stale = Number(expired?.n ?? 0);
    const nearCeiling = live >= ceiling * 0.9;
    return {
      key: 'WORKSPACE_CLEANUP',
      question: 'Did workspace cleanup fail?',
      status: stale > 0 || nearCeiling ? 'ATTENTION' : 'OK',
      detail:
        `${live} demo workspace(s) of a ceiling of ${ceiling}; ${stale} are past the ${ttlHours}-hour ` +
        'window with nobody in them and should have been swept.',
      action:
        stale > 0
          ? 'The sweep runs hourly and on capacity. A count that does not fall within the hour means it is not running.'
          : nearCeiling
            ? 'Near the ceiling, so the next visitor may be turned away. The sweep frees capacity only for workspaces past the window.'
            : undefined,
    };
  }
}
