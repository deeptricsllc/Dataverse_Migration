import os from 'node:os';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AppDb } from '../db/client';
import { jobs } from '../db/schema';
import { errorMessage } from '../lib/errors';

export type JobType = 'COMPARISON' | 'MIGRATION' | 'VALIDATION';
export type JobRow = typeof jobs.$inferSelect;
export type JobHandler = (job: JobRow, signal: { heartbeat: () => Promise<void> }) => Promise<void>;

/**
 * Durable job queue on the relational database (no extra infrastructure). Jobs are claimed with
 * FOR UPDATE SKIP LOCKED so multiple worker processes can run safely against PostgreSQL.
 */
export class JobQueue {
  constructor(private readonly db: AppDb) {}

  async enqueue(type: JobType, organizationId: string, targetId: string): Promise<string> {
    const [row] = await this.db
      .insert(jobs)
      .values({ type, organizationId, targetId })
      .returning({ id: jobs.id });
    return row.id;
  }

  async claim(workerId: string): Promise<JobRow | null> {
    const result = await this.db.execute(sql`
      UPDATE jobs SET status = 'RUNNING', locked_by = ${workerId}, heartbeat_at = now(),
        attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'QUEUED' AND run_after <= now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id`);
    const rows = (result as unknown as { rows: { id: string }[] }).rows;
    if (!rows?.length) return null;
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, rows[0].id));
    return job ?? null;
  }

  async heartbeat(jobId: string) {
    await this.db.update(jobs).set({ heartbeatAt: new Date() }).where(eq(jobs.id, jobId));
  }

  async complete(jobId: string) {
    await this.db
      .update(jobs)
      .set({ status: 'DONE', updatedAt: new Date(), lockedBy: null })
      .where(eq(jobs.id, jobId));
  }

  async fail(jobId: string, message: string) {
    await this.db
      .update(jobs)
      .set({ status: 'FAILED', lastError: message.slice(0, 2000), updatedAt: new Date(), lockedBy: null })
      .where(eq(jobs.id, jobId));
  }

  /** Re-queues jobs whose worker stopped heart-beating (crash/restart). Handlers are resumable. */
  async recoverStale(staleMs: number): Promise<number> {
    const rows = await this.db
      .update(jobs)
      .set({ status: 'QUEUED', lockedBy: null, updatedAt: new Date() })
      .where(and(eq(jobs.status, 'RUNNING'), lt(jobs.heartbeatAt, new Date(Date.now() - staleMs))))
      .returning({ id: jobs.id });
    return rows.length;
  }
}

export class Worker {
  private running = false;
  private active = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  readonly workerId = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Record<JobType, JobHandler>,
    private readonly logger: Logger,
    private readonly opts: { pollMs: number; concurrency: number; staleMs: number },
  ) {}

  async start() {
    if (this.running) return;
    this.running = true;
    const recovered = await this.queue.recoverStale(this.opts.staleMs);
    if (recovered) this.logger.warn({ recovered }, 'Recovered stale jobs');
    this.logger.info({ workerId: this.workerId }, 'Job worker started');
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick() {
    try {
      while (this.running && this.active.size < this.opts.concurrency) {
        const job = await this.queue.claim(this.workerId);
        if (!job) break;
        const p = this.run(job).finally(() => this.active.delete(p));
        this.active.add(p);
      }
      if (this.running && Math.random() < 0.05) await this.queue.recoverStale(this.opts.staleMs);
    } catch (err) {
      this.logger.error({ err }, 'Worker poll failed');
    }
    this.schedule(this.opts.pollMs);
  }

  private async run(job: JobRow) {
    const log = this.logger.child({ jobId: job.id, jobType: job.type, targetId: job.targetId });
    const handler = this.handlers[job.type];
    const heartbeat = () => this.queue.heartbeat(job.id);
    const interval = setInterval(() => void heartbeat().catch(() => undefined), 10_000);
    log.info('Job started');
    try {
      await handler(job, { heartbeat });
      await this.queue.complete(job.id);
      log.info('Job finished');
    } catch (err) {
      log.error({ err: { message: errorMessage(err) } }, 'Job failed');
      await this.queue.fail(job.id, errorMessage(err));
    } finally {
      clearInterval(interval);
    }
  }

  /** Waits for in-flight jobs (tests / graceful shutdown). */
  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.active]);
  }

  async drain(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.active.size === 0) {
        const job = await this.queue.claim(this.workerId);
        if (!job) return;
        await this.run(job);
        continue;
      }
      if (Date.now() > deadline) throw new Error('Worker drain timed out');
      await Promise.race([...this.active]);
    }
  }
}
