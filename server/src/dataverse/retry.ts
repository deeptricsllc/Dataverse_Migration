import type { Logger } from 'pino';
import { toDataverseError, type DataverseError } from './errors';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Upper bound for a server-provided Retry-After. Dataverse service protection limits are
   * evaluated over a five minute window, so waiting the full advertised delay is correct.
   * https://learn.microsoft.com/power-apps/developer/data-platform/api-limits
   */
  maxRetryAfterMs?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 300_000,
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bounded exponential backoff with full jitter; honors Retry-After for throttling. */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  err?: DataverseError,
  random = Math.random,
): number {
  // Honour Retry-After as advertised: Dataverse tells us exactly how long to wait.
  if (err?.retryAfterSeconds) {
    return Math.min(err.retryAfterSeconds * 1000, policy.maxRetryAfterMs ?? 300_000);
  }
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * Executes an operation, retrying only transient failures (network, timeout, throttling,
 * 502/503/504). Permanent failures such as validation errors are thrown immediately.
 */
export async function withRetry<T>(
  op: (attempt: number) => Promise<T>,
  opts: {
    policy?: RetryPolicy;
    logger?: Logger;
    context?: Record<string, unknown>;
    onRetry?: (e: DataverseError) => void;
  } = {},
): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op(attempt);
    } catch (raw) {
      const err = toDataverseError(raw);
      if (!err.retryable || attempt >= policy.maxAttempts) {
        (err as DataverseError & { attempts?: number }).attempts = attempt;
        throw err;
      }
      const delay = backoffDelay(attempt, policy, err);
      opts.onRetry?.(err);
      opts.logger?.warn(
        { ...opts.context, errorCode: err.code, status: err.status, attempt, delayMs: delay },
        err.code === 'THROTTLED'
          ? 'Dataverse throttling; backing off'
          : 'Transient Dataverse failure; retrying',
      );
      await sleep(delay);
    }
  }
}

/** Minimal counting semaphore to bound concurrent requests per connection. */
export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
