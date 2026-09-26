import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  SCHEDULE_MODES,
  type MigrationScheduleDto,
  type RunTrigger,
  type ScheduleMode,
  type ScheduleRunHistoryItemDto,
} from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { migrationPlans, migrationRuns, migrationSchedules, users } from '../db/schema';
import { cronError, describeCron, nextCronTime } from '../lib/cron';
import { AppError, badRequest, errorMessage, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import type { MigrationRunService } from './migration-run-service';

/**
 * After this many consecutive failures a schedule stops firing by itself.
 *
 * A schedule that fails every five minutes for a week is not resilience, it is a queue of identical
 * errors and, against a real target, a queue of identical partial writes. Pausing makes someone look.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** The default watermark column for an incremental run, per provider family. */
const DEFAULT_WATERMARK = 'modifiedon';

/**
 * Recurring migrations.
 *
 * Data does not hold still, so a migration that only ever runs when someone clicks is only ever
 * correct at the moment they clicked. A schedule closes that gap — but a run with nobody present is
 * exactly when the safety gates matter most, so a scheduled run goes through the same path as a
 * manual one: same blocker check, same data-loss acknowledgement, same read-only enforcement, same
 * refusal to overlap another run against the same target. The one thing a person does at the
 * keyboard that a scheduler cannot is confirm the environment names, so those are captured when the
 * schedule is created and re-checked every time it fires.
 */
export class ScheduleService {
  constructor(
    private readonly db: AppDb,
    private readonly runs: MigrationRunService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Managing schedules
  // ---------------------------------------------------------------------------

  async listForPlan(ctx: RequestContext, planId: string): Promise<MigrationScheduleDto[]> {
    const plan = await this.plan(ctx, planId);
    const rows = await this.db
      .select({ schedule: migrationSchedules, user: users.displayName })
      .from(migrationSchedules)
      .leftJoin(users, eq(users.id, migrationSchedules.createdByUserId))
      .where(eq(migrationSchedules.planId, planId))
      .orderBy(desc(migrationSchedules.createdAt));
    return rows.map((r) => toDto(r.schedule, plan.name, r.user ?? null));
  }

  async get(ctx: Pick<RequestContext, 'organizationId'>, scheduleId: string): Promise<MigrationScheduleDto> {
    const { schedule, planName, createdBy } = await this.row(ctx, scheduleId);
    return toDto(schedule, planName, createdBy);
  }

  async create(
    ctx: RequestContext,
    planId: string,
    input: {
      name?: string;
      cron: string;
      timeZone?: string;
      mode?: ScheduleMode;
      watermarkField?: string | null;
      enabled?: boolean;
      confirmSourceName: string;
      confirmTargetName: string;
    },
  ): Promise<MigrationScheduleDto> {
    const plan = await this.runs.planForSchedule(ctx, planId);
    const timeZone = (input.timeZone ?? 'UTC').trim() || 'UTC';
    const cron = input.cron.trim();
    const invalid = cronError(cron, timeZone);
    if (invalid) throw badRequest(invalid);

    // The names are confirmed here, at the one moment a person is present, and re-checked at every
    // firing. Repointing the plan afterwards therefore stops the schedule instead of surprising it.
    if (
      input.confirmSourceName.trim() !== plan.sourceEnvironment.displayName ||
      input.confirmTargetName.trim() !== plan.targetEnvironment.displayName
    ) {
      throw badRequest('Environment confirmation does not match the plan source and target names');
    }
    const mode = input.mode ?? 'FULL';
    if (!SCHEDULE_MODES.includes(mode)) throw badRequest('Unknown schedule mode');
    const watermarkField = mode === 'INCREMENTAL' ? input.watermarkField?.trim() || DEFAULT_WATERMARK : null;

    const [row] = await this.db
      .insert(migrationSchedules)
      .values({
        organizationId: ctx.organizationId,
        planId,
        name: (input.name ?? '').trim() || describeCron(cron),
        cron,
        timeZone,
        enabled: input.enabled !== false,
        mode,
        watermarkField,
        confirmSourceName: plan.sourceEnvironment.displayName,
        confirmTargetName: plan.targetEnvironment.displayName,
        nextRunAt: input.enabled === false ? null : nextCronTime(cron, new Date(), timeZone),
        createdByUserId: ctx.userId,
      })
      .returning();

    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'SCHEDULE_CREATED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: plan.sourceEnvironment.id,
      targetEnvironmentId: plan.targetEnvironment.id,
      requestId: ctx.requestId,
      details: { scheduleId: row.id, planId, cron, timeZone, mode, watermarkField },
    });
    this.logger.info({ scheduleId: row.id, planId, cron, timeZone, mode }, 'Migration schedule created');
    return this.get(ctx, row.id);
  }

  async update(
    ctx: RequestContext,
    scheduleId: string,
    patch: {
      name?: string;
      cron?: string;
      timeZone?: string;
      enabled?: boolean;
      mode?: ScheduleMode;
      watermarkField?: string | null;
    },
  ): Promise<MigrationScheduleDto> {
    const { schedule } = await this.row(ctx, scheduleId);
    const cron = patch.cron?.trim() ?? schedule.cron;
    const timeZone = patch.timeZone?.trim() ?? schedule.timeZone;
    if (patch.cron !== undefined || patch.timeZone !== undefined) {
      const invalid = cronError(cron, timeZone);
      if (invalid) throw badRequest(invalid);
    }
    const enabled = patch.enabled ?? schedule.enabled;
    const mode = patch.mode ?? schedule.mode;
    if (!SCHEDULE_MODES.includes(mode)) throw badRequest('Unknown schedule mode');

    await this.db
      .update(migrationSchedules)
      .set({
        name: patch.name?.trim() || schedule.name,
        cron,
        timeZone,
        enabled,
        mode,
        watermarkField:
          mode === 'INCREMENTAL'
            ? (patch.watermarkField?.trim() ?? schedule.watermarkField ?? DEFAULT_WATERMARK)
            : null,
        // Re-enabling clears the pause and the failure streak: someone has looked at it.
        pausedReason: enabled ? null : schedule.pausedReason,
        consecutiveFailures: enabled && !schedule.enabled ? 0 : schedule.consecutiveFailures,
        nextRunAt: enabled ? nextCronTime(cron, new Date(), timeZone) : null,
        updatedAt: new Date(),
      })
      .where(eq(migrationSchedules.id, scheduleId));

    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'SCHEDULE_UPDATED',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { scheduleId, cron, timeZone, enabled, mode },
    });
    return this.get(ctx, scheduleId);
  }

  async remove(ctx: RequestContext, scheduleId: string): Promise<void> {
    await this.row(ctx, scheduleId);
    await this.db.delete(migrationSchedules).where(eq(migrationSchedules.id, scheduleId));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'SCHEDULE_DELETED',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { scheduleId },
    });
  }

  /**
   * Fires a schedule now, without disturbing its recurrence.
   *
   * This is the "trigger run" people reach for when they know something changed and do not want to
   * wait for the next slot. It goes through the identical path a timed firing does.
   */
  async trigger(ctx: RequestContext, scheduleId: string): Promise<{ runId: string }> {
    const { schedule } = await this.row(ctx, scheduleId);
    const result = await this.fire(schedule, 'TRIGGERED', ctx);
    if (result.kind === 'SKIPPED') throw new AppError(409, 'SCHEDULE_SKIPPED', result.reason);
    if (result.kind === 'FAILED') throw badRequest(result.reason);
    return { runId: result.runId };
  }

  /** Runs this schedule has produced, newest first. */
  async history(
    ctx: Pick<RequestContext, 'organizationId'>,
    scheduleId: string,
    limit = 20,
  ): Promise<ScheduleRunHistoryItemDto[]> {
    await this.row(ctx, scheduleId);
    const rows = await this.db
      .select()
      .from(migrationRuns)
      .where(eq(migrationRuns.scheduleId, scheduleId))
      .orderBy(desc(migrationRuns.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      runId: r.id,
      status: r.status,
      trigger: r.trigger,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      created: r.created,
      updated: r.updated,
      failed: r.failed,
    }));
  }

  // ---------------------------------------------------------------------------
  // Firing
  // ---------------------------------------------------------------------------

  /**
   * Claims and fires everything due, and returns what happened.
   *
   * Claiming is a conditional UPDATE that moves `nextRunAt` forward before the run is started, so
   * two worker processes polling the same database cannot both fire the same slot — and a crash
   * between claiming and starting loses one firing rather than repeating it forever.
   */
  async runDue(now = new Date()): Promise<{ fired: number; skipped: number; failed: number }> {
    const due = await this.db
      .select()
      .from(migrationSchedules)
      .where(
        and(
          eq(migrationSchedules.enabled, true),
          isNotNull(migrationSchedules.nextRunAt),
          lte(migrationSchedules.nextRunAt, now),
        ),
      );
    const outcome = { fired: 0, skipped: 0, failed: 0 };

    for (const schedule of due) {
      const next = nextCronTime(schedule.cron, now, schedule.timeZone);
      const claimed = await this.db
        .update(migrationSchedules)
        .set({ nextRunAt: next, lastRunAt: now, updatedAt: now })
        .where(
          and(
            eq(migrationSchedules.id, schedule.id),
            eq(migrationSchedules.enabled, true),
            // Only the process that still sees the old due time wins the slot.
            eq(migrationSchedules.nextRunAt, schedule.nextRunAt!),
          ),
        )
        .returning({ id: migrationSchedules.id });
      if (claimed.length === 0) continue;

      const result = await this.fire(schedule, 'SCHEDULED');
      if (result.kind === 'STARTED') outcome.fired++;
      else if (result.kind === 'SKIPPED') outcome.skipped++;
      else outcome.failed++;
    }
    return outcome;
  }

  /** One firing, from the timer or from a person pressing the button. */
  private async fire(
    schedule: typeof migrationSchedules.$inferSelect,
    trigger: Extract<RunTrigger, 'SCHEDULED' | 'TRIGGERED'>,
    ctx?: RequestContext,
  ): Promise<
    | { kind: 'STARTED'; runId: string }
    | { kind: 'SKIPPED'; reason: string }
    | { kind: 'FAILED'; reason: string }
  > {
    const runCtx: RequestContext =
      ctx ??
      ({
        organizationId: schedule.organizationId,
        userId: schedule.createdByUserId ?? '',
        role: 'ADMIN',
        isDemoOrg: false,
        displayName: `Schedule: ${schedule.name}`,
        requestId: `schedule-${schedule.id}`,
      } as RequestContext);

    try {
      const run = await this.runs.start(
        runCtx,
        schedule.planId,
        {
          // The names confirmed when a person created this schedule. If the plan now points
          // somewhere else these will not match, and the run is refused rather than misdirected.
          confirmSourceName: schedule.confirmSourceName,
          confirmTargetName: schedule.confirmTargetName,
          // Warnings were reviewed when the schedule was created. Blockers and data-loss
          // acknowledgement are NOT waived: those still stop a scheduled run.
          acknowledgeWarnings: true,
        },
        {
          trigger,
          scheduleId: schedule.id,
          incremental:
            schedule.mode === 'INCREMENTAL' && schedule.watermarkField
              ? { field: schedule.watermarkField, since: schedule.lastWatermark }
              : null,
        },
      );
      await this.db
        .update(migrationSchedules)
        .set({
          lastRunId: run.id,
          lastRunAt: new Date(),
          lastStatus: run.status,
          lastError: null,
          consecutiveFailures: 0,
          pausedReason: null,
          updatedAt: new Date(),
        })
        .where(eq(migrationSchedules.id, schedule.id));
      await this.audit.record({
        organizationId: schedule.organizationId,
        userId: schedule.createdByUserId,
        action: 'SCHEDULE_FIRED',
        outcome: 'REQUESTED',
        runId: run.id,
        details: { scheduleId: schedule.id, trigger, mode: schedule.mode },
      });
      this.logger.info({ scheduleId: schedule.id, runId: run.id, trigger }, 'Scheduled migration started');
      return { kind: 'STARTED', runId: run.id };
    } catch (err) {
      const reason = errorMessage(err);
      // An overlapping run is not a failure: the previous one is still working, and this slot is
      // simply skipped. Counting it as a failure would pause a schedule that is merely busy.
      const overlapping =
        err instanceof AppError &&
        err.statusCode === 409 &&
        typeof (err.details as { runId?: string } | undefined)?.runId === 'string';
      if (overlapping) {
        await this.db
          .update(migrationSchedules)
          .set({ lastStatus: 'SKIPPED', lastError: reason, updatedAt: new Date() })
          .where(eq(migrationSchedules.id, schedule.id));
        this.logger.warn({ scheduleId: schedule.id }, 'Scheduled migration skipped: a run is already active');
        return { kind: 'SKIPPED', reason };
      }

      const failures = schedule.consecutiveFailures + 1;
      const pause = failures >= MAX_CONSECUTIVE_FAILURES;
      await this.db
        .update(migrationSchedules)
        .set({
          lastStatus: 'FAILED',
          lastError: reason.slice(0, 2000),
          consecutiveFailures: failures,
          updatedAt: new Date(),
          // `nextRunAt` is deliberately left alone: the claim already moved it to the next slot, and
          // writing the old value back here would make a failing schedule re-fire on every poll.
          // Pausing is the one case that changes it, by removing it.
          ...(pause
            ? {
                enabled: false,
                nextRunAt: null,
                pausedReason: `Paused after ${failures} consecutive failures. Last error: ${reason.slice(0, 300)}`,
              }
            : {}),
        })
        .where(eq(migrationSchedules.id, schedule.id));
      await this.audit.record({
        organizationId: schedule.organizationId,
        userId: schedule.createdByUserId,
        action: pause ? 'SCHEDULE_PAUSED' : 'SCHEDULE_FIRED',
        outcome: 'FAILURE',
        details: { scheduleId: schedule.id, trigger, reason, consecutiveFailures: failures },
      });
      this.logger.error(
        { scheduleId: schedule.id, failures, pause },
        `Scheduled migration failed: ${reason}`,
      );
      return { kind: 'FAILED', reason };
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async plan(ctx: Pick<RequestContext, 'organizationId'>, planId: string) {
    const [plan] = await this.db
      .select({ id: migrationPlans.id, name: migrationPlans.name })
      .from(migrationPlans)
      .where(and(eq(migrationPlans.id, planId), eq(migrationPlans.organizationId, ctx.organizationId)));
    if (!plan) throw notFound('Migration plan');
    return plan;
  }

  private async row(ctx: Pick<RequestContext, 'organizationId'>, scheduleId: string) {
    const [row] = await this.db
      .select({ schedule: migrationSchedules, planName: migrationPlans.name, user: users.displayName })
      .from(migrationSchedules)
      .innerJoin(migrationPlans, eq(migrationPlans.id, migrationSchedules.planId))
      .leftJoin(users, eq(users.id, migrationSchedules.createdByUserId))
      .where(
        and(eq(migrationSchedules.id, scheduleId), eq(migrationSchedules.organizationId, ctx.organizationId)),
      );
    if (!row) throw notFound('Schedule');
    return { schedule: row.schedule, planName: row.planName, createdBy: row.user ?? null };
  }
}

const toDto = (
  row: typeof migrationSchedules.$inferSelect,
  planName: string,
  createdBy: string | null,
): MigrationScheduleDto => ({
  id: row.id,
  planId: row.planId,
  planName,
  name: row.name,
  cron: row.cron,
  timeZone: row.timeZone,
  description: describeCron(row.cron),
  enabled: row.enabled,
  mode: row.mode,
  watermarkField: row.watermarkField,
  lastWatermark: row.lastWatermark,
  nextRunAt: row.nextRunAt?.toISOString() ?? null,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  lastRunId: row.lastRunId,
  lastStatus: row.lastStatus,
  lastError: row.lastError,
  consecutiveFailures: row.consecutiveFailures,
  pausedReason: row.pausedReason,
  createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * The timer that fires schedules. Lives in the worker process, next to the job queue, because that
 * is the process that is already allowed to do work without a request behind it.
 */
export class Scheduler {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly schedules: ScheduleService,
    private readonly logger: Logger,
    private readonly opts: { pollMs: number } = { pollMs: 30_000 },
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info({ pollMs: this.opts.pollMs }, 'Migration scheduler started');
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
    // A scheduler must never hold the process open on its own.
    this.timer.unref?.();
  }

  /** Exposed so a test can advance the scheduler deterministically instead of waiting. */
  async tick(now = new Date()): Promise<{ fired: number; skipped: number; failed: number }> {
    let outcome = { fired: 0, skipped: 0, failed: 0 };
    try {
      outcome = await this.schedules.runDue(now);
      if (outcome.fired || outcome.failed) this.logger.info(outcome, 'Scheduler tick');
    } catch (err) {
      this.logger.error({ err }, 'Scheduler tick failed');
    }
    this.schedule(this.opts.pollMs);
    return outcome;
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
