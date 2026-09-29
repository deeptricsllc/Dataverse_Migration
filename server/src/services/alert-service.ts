import type { Logger } from 'pino';
import type { AppConfig } from '../config';
import { scrubSecrets } from '../logger';

/**
 * Telling somebody when something consequential happened.
 *
 * Until now nothing left this process. A schedule that gave up after five failures, a run that
 * finished having lost a table, a prospect asking for access — all of it was recorded faithfully
 * and announced to nobody, which meant somebody had to think to go and look. For a demo that is
 * fine. For a deployment with real users on it, an alert nobody receives is the same as no alert.
 *
 * One outbound webhook, configured by the operator, posting small JSON. Deliberately not email:
 * email needs a provider, a sender domain, a bounce story and a suppression list, and a webhook
 * reaches Slack, Teams, a queue or a function today with none of that.
 */

export type AlertEvent =
  | {
      kind: 'ACCESS_REQUEST';
      name: string;
      email: string;
      company: string | null;
      useCase: string | null;
    }
  | {
      kind: 'SCHEDULE_PAUSED';
      scheduleName: string;
      planName: string;
      target: string;
      failures: number;
      lastError: string;
    }
  | {
      kind: 'RUN_ENDED_BADLY';
      runId: string;
      /** Absent where the run carries a snapshot rather than the plan itself. */
      planName?: string;
      target: string;
      status: string;
      failed: number;
      error: string | null;
    }
  | { kind: 'TEST'; requestedBy: string };

/** How long an alert may take before it is abandoned. It must never hold up the work that caused it. */
const TIMEOUT_MS = 5_000;
/** A message is a summary, not a payload. Anything longer is in the product, where it belongs. */
const MAX_TEXT = 500;

const trim = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : scrubSecrets(String(value)).slice(0, MAX_TEXT);

/** One line a person can read in a chat client without opening anything. */
function summarize(event: AlertEvent): string {
  switch (event.kind) {
    case 'ACCESS_REQUEST':
      return `Access requested by ${event.name}${event.company ? ` (${event.company})` : ''}`;
    case 'SCHEDULE_PAUSED':
      return `Schedule "${event.scheduleName}" paused itself after ${event.failures} consecutive failures`;
    case 'RUN_ENDED_BADLY':
      return `Migration into ${event.target} ended ${event.status}${
        event.failed ? ` with ${event.failed} failed record(s)` : ''
      }`;
    case 'TEST':
      return `Test alert from the Data Analysis & Migration Platform, sent by ${event.requestedBy}`;
  }
}

export class AlertService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    /** Injected so a test can watch what would be sent without a server to send it to. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.ALERT_WEBHOOK_URL);
  }

  /**
   * Sends an alert, and never lets the attempt affect the caller.
   *
   * A migration must not fail because a chat server is down, and a person asking for access must
   * not see an error because a webhook URL has a typo in it. Everything here is caught and logged.
   */
  async notify(event: AlertEvent): Promise<void> {
    const result = await this.deliver(event);
    if (!result.ok) {
      this.logger.warn({ kind: event.kind, reason: result.reason }, 'Alert not delivered');
    }
  }

  /** The same send, with the outcome returned. Used by the operator's own test button. */
  async deliver(event: AlertEvent): Promise<{ ok: boolean; reason?: string }> {
    const url = this.config.ALERT_WEBHOOK_URL;
    if (!url) return { ok: false, reason: 'No ALERT_WEBHOOK_URL is configured' };

    // `text` is what a chat client shows; the rest is for anything parsing it.
    const body = {
      text: summarize(event),
      event: event.kind,
      deployment: this.config.APP_BASE_URL,
      at: new Date().toISOString(),
      detail: this.detail(event),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: `The webhook answered ${res.status}` };
      this.logger.info({ kind: event.kind }, 'Alert delivered');
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        ok: false,
        reason: message.includes('abort')
          ? `The webhook did not answer within ${TIMEOUT_MS / 1000} seconds`
          : scrubSecrets(message),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Per-event detail, with every free-text field scrubbed and bounded. */
  private detail(event: AlertEvent): Record<string, unknown> {
    switch (event.kind) {
      case 'ACCESS_REQUEST':
        return {
          name: trim(event.name),
          email: trim(event.email),
          company: trim(event.company),
          useCase: trim(event.useCase),
        };
      case 'SCHEDULE_PAUSED':
        return {
          schedule: trim(event.scheduleName),
          plan: trim(event.planName),
          target: trim(event.target),
          failures: event.failures,
          lastError: trim(event.lastError),
        };
      case 'RUN_ENDED_BADLY':
        return {
          runId: event.runId,
          plan: trim(event.planName),
          target: trim(event.target),
          status: event.status,
          failedRecords: event.failed,
          error: trim(event.error),
        };
      case 'TEST':
        return { requestedBy: trim(event.requestedBy) };
    }
  }
}
