import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';
import { normaliseRole } from '../../../shared/authorization';
import type { Logger } from 'pino';
import {
  needsTypedConfirmation,
  SCHEDULE_MODES,
  type PlanIssue,
  type MigrationScheduleDto,
  type RunTrigger,
  type ScheduleMode,
  type ScheduleRunHistoryItemDto,
} from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { migrationPlans, migrationRuns, migrationSchedules, users } from '../db/schema';
import { cronError, describeCron, nextCronTime } from '../lib/cron';
import type { AlertEvent } from './alert-service';
import { AppError, badRequest, errorMessage, notFound } from '../lib/errors';
import { requireAdmin } from './authorization';
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

/**
 * The distinct warning codes a plan currently raises.
 *
 * Codes, not counts: a schedule confirmed while one kind of warning was present should keep running
 * as that warning comes and goes with the data, and should stop when a *different* kind appears.
 * Counting would do neither — it would block on noise and wave through a genuinely new problem that
 * happened to replace an old one.
 */
const warningCodes = (plan: { issues: PlanIssue[] }): string[] =>
  [
    ...new Set(plan.issues.filter((i) => i.severity === 'WARNING' && !i.acknowledged).map((i) => i.code)),
  ].sort();

/** Warning codes the plan has that this schedule was never confirmed against. */
const unreviewed = (current: string[], acknowledged: string[]): string[] => {
  const seen = new Set(acknowledged);
  return current.filter((code) => !seen.has(code));
};

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
/** The one thing this service needs from the alerting path. */
interface Alerts {
  notify(event: AlertEvent): Promise<void>;
}

export class ScheduleService {
  constructor(
    private readonly db: AppDb,
    private readonly runs: MigrationRunService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly alerts: Alerts,
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
    if (rows.length === 0) return [];
    const current = warningCodes(await this.runs.planForSchedule(ctx, planId));
    return rows.map((r) => toDto(r.schedule, plan.name, r.user ?? null, current));
  }

  async get(ctx: Pick<RequestContext, 'organizationId'>, scheduleId: string): Promise<MigrationScheduleDto> {
    const { schedule, planName, createdBy } = await this.row(ctx, scheduleId);
    // The plan is loaded so the screen can say whether anything new has appeared since.
    const current = await this.runs
      .planForSchedule(ctx as RequestContext, schedule.planId)
      .then(warningCodes)
      .catch(() => schedule.acknowledgedWarnings);
    return toDto(schedule, planName, createdBy, current);
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
      confirmSourceName?: string;
      confirmTargetName?: string;
      /** Explicit confirmation, for a target where typing the name is not required. */
      confirmed?: boolean;
    },
  ): Promise<MigrationScheduleDto> {
    // A schedule keeps writing when nobody is watching, so creating one is a standing grant rather
    // than a single action.
    requireAdmin(ctx, 'Creating a schedule');
    const plan = await this.runs.planForSchedule(ctx, planId);
    const timeZone = (input.timeZone ?? 'UTC').trim() || 'UTC';
    const cron = input.cron.trim();
    const invalid = cronError(cron, timeZone);
    if (invalid) throw badRequest(invalid);

    // The target is confirmed here, at the one moment a person is present, and re-checked at every
    // firing. Repointing the plan afterwards therefore stops the schedule instead of surprising it.
    // How heavy that confirmation is scales with the target, exactly as it does for a manual run.
    const typedMatches =
      input.confirmSourceName?.trim() === plan.sourceEnvironment.displayName &&
      input.confirmTargetName?.trim() === plan.targetEnvironment.displayName;
    if (needsTypedConfirmation(plan.targetEnvironment)) {
      if (!typedMatches) {
        throw badRequest(
          `${plan.targetEnvironment.displayName} is a production environment, or one this deployment could not classify. Type its name exactly to confirm this schedule.`,
        );
      }
    } else if (!typedMatches && input.confirmed !== true) {
      throw badRequest('Confirm the target environment before creating the schedule');
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
        // Stored as the plan saw it now, so a later repointing is detectable at firing time.
        confirmTargetName: plan.targetEnvironment.displayName,
        // What the person creating this schedule could see. Anything new later stops it.
        acknowledgedWarnings: warningCodes(plan),
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
      /** Re-confirms the warnings the plan has now, so the schedule may fire again. */
      acknowledgeWarnings?: boolean;
    },
  ): Promise<MigrationScheduleDto> {
    requireAdmin(ctx, 'Changing a schedule');
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
        // Re-confirming is a separate, deliberate act: enabling a schedule is not the same as
        // having read the warnings that appeared while it was off.
        ...(patch.acknowledgeWarnings
          ? { acknowledgedWarnings: warningCodes(await this.runs.planForSchedule(ctx, schedule.planId)) }
          : {}),
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
    requireAdmin(ctx, 'Deleting a schedule');
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
    requireAdmin(ctx, 'Firing a schedule');
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

  /**
   * The context a timed firing runs as: the person who created the schedule, with the role they hold
   * **now**.
   *
   * It used to fabricate `role: 'ADMIN'`, which was harmless only while nothing checked the role.
   * The moment writing to production needs an administrator, a fabricated one turns a schedule into a
   * privilege-escalation path — a member creates it, and it fires with rights they do not have.
   * Reading the role at fire time rather than storing it also means revoking someone's access stops
   * their schedules, which is what revoking access is supposed to mean.
   */
  private async creatorContext(schedule: typeof migrationSchedules.$inferSelect): Promise<RequestContext> {
    const [creator] = schedule.createdByUserId
      ? await this.db
          .select({ id: users.id, role: users.role, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, schedule.createdByUserId))
      : [];
    if (!creator) {
      // No creator left to act for. Refusing is the only safe answer: firing as nobody would mean
      // firing with whatever rights the code happens to assume.
      throw badRequest(
        `The account that created "${schedule.name}" no longer exists, so it has nobody to run as. Recreate the schedule.`,
      );
    }
    return {
      organizationId: schedule.organizationId,
      userId: creator.id,
      role: normaliseRole(creator.role),
      isDemoOrg: false,
      displayName: `${creator.displayName} (schedule: ${schedule.name})`,
      requestId: `schedule-${schedule.id}`,
      // A schedule runs migrations; it never has business with deployment-level administration.
      platformOperator: false,
    };
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
    const runCtx: RequestContext = ctx ?? (await this.creatorContext(schedule));

    try {
      // Blockers are caught by `start`. Warnings need this extra step, because `start` only knows
      // "acknowledged or not" and a schedule needs "acknowledged *these*".
      const plan = await this.runs.planForSchedule(runCtx, schedule.planId);
      const appeared = unreviewed(warningCodes(plan), schedule.acknowledgedWarnings);
      if (appeared.length > 0) {
        throw badRequest(
          `The plan has ${appeared.length} warning(s) nobody has reviewed (${appeared.join(', ')}). Open the schedule, check them, and confirm to let it run again.`,
        );
      }

      const run = await this.runs.start(
        runCtx,
        schedule.planId,
        {
          // The names confirmed when a person created this schedule. If the plan now points
          // somewhere else these will not match, and the run is refused rather than misdirected.
          confirmSourceName: schedule.confirmSourceName,
          confirmTargetName: schedule.confirmTargetName,
          // The warning codes were checked against this schedule's own acknowledgement just above,
          // so the generic gate has nothing left to add. Blockers and data-loss acknowledgement are
          // NOT waived: those still stop a scheduled run.
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
      // A schedule that has given up is the case nobody finds on their own: it stops appearing in
      // the runs list precisely because it is no longer running.
      if (pause) {
        await this.alerts.notify({
          kind: 'SCHEDULE_PAUSED',
          scheduleName: schedule.name,
          planName: schedule.name,
          target: schedule.confirmTargetName,
          failures,
          lastError: reason,
        });
      }
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
  currentWarnings: string[],
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
  acknowledgedWarnings: row.acknowledgedWarnings,
  unreviewedWarnings: unreviewed(currentWarnings, row.acknowledgedWarnings),
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
