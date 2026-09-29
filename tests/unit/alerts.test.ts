import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../server/src/config';
import { AlertService, type AlertEvent } from '../../server/src/services/alert-service';
import { createLogger } from '../../server/src/logger';

/**
 * Announcing what happened.
 *
 * Everything the platform did was recorded faithfully and told to nobody, so a schedule that gave
 * up after five failures stopped appearing in the runs list precisely because it had stopped
 * running. The rule that matters most here is the one about not making things worse: an alert must
 * never affect the work that triggered it.
 */

const logger = createLogger('silent');

const config = (overrides: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    DATABASE_URL: '',
    PGLITE_DATA_DIR: 'memory://',
    LOG_LEVEL: 'silent',
    ENTRA_CLIENT_ID: '',
    ENTRA_CLIENT_SECRET: '',
    APP_BASE_URL: 'https://migrate.example.org',
    ...overrides,
  });

const ok = () => new Response('', { status: 200 });

const event: AlertEvent = {
  kind: 'SCHEDULE_PAUSED',
  scheduleName: 'Nightly accounts',
  planName: 'Accounts into QA',
  target: 'DeepTrics QA',
  failures: 5,
  lastError: 'The plan has 2 unresolved blocker(s)',
};

describe('when no webhook is configured', () => {
  it('does nothing, and says so rather than pretending', async () => {
    const fetchImpl = vi.fn(ok);
    const alerts = new AlertService(config(), logger, fetchImpl as unknown as typeof fetch);
    expect(alerts.configured).toBe(false);
    await alerts.notify(event);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await alerts.deliver(event)).toMatchObject({ ok: false });
  });
});

describe('what gets sent', () => {
  // Typed with fetch's own shape, so the recorded calls are a (url, init) pair rather than unknown.
  const send = async (e: AlertEvent, impl = vi.fn(async (_url: string, _init: RequestInit) => ok())) => {
    const alerts = new AlertService(
      config({ ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc' }),
      logger,
      impl as unknown as typeof fetch,
    );
    const result = await alerts.deliver(e);
    const call = impl.mock.calls[0];
    return { result, url: call?.[0], body: call ? JSON.parse(String(call[1].body)) : null };
  };

  it('posts one readable line plus the detail behind it', async () => {
    const { result, url, body } = await send(event);
    expect(result.ok).toBe(true);
    expect(url).toBe('https://hooks.example.com/abc');
    // `text` is what a chat client shows without anyone configuring a template.
    expect(body.text).toBe('Schedule "Nightly accounts" paused itself after 5 consecutive failures');
    expect(body.event).toBe('SCHEDULE_PAUSED');
    // Which deployment it came from, because an operator may run more than one.
    expect(body.deployment).toBe('https://migrate.example.org');
    expect(body.detail).toMatchObject({ schedule: 'Nightly accounts', failures: 5 });
  });

  it('scrubs secrets out of anything it repeats', async () => {
    // The last error of a failed schedule can carry a connection string.
    const { body } = await send({
      ...event,
      lastError: 'connect failed: Server=sql01;User Id=svc;Password=hunter2;',
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('bounds what it repeats, so an alert cannot become a payload', async () => {
    const { body } = await send({ ...event, lastError: 'x'.repeat(5000) });
    expect(body.detail.lastError.length).toBeLessThanOrEqual(500);
  });

  it('summarises each kind in words somebody can act on', async () => {
    const access = await send({
      kind: 'ACCESS_REQUEST',
      name: 'Dana Whitfield',
      email: 'dana@contoso.com',
      company: 'Contoso',
      useCase: null,
    });
    expect(access.body.text).toBe('Access requested by Dana Whitfield (Contoso)');

    const run = await send({
      kind: 'RUN_ENDED_BADLY',
      runId: 'r-1',
      target: 'DeepTrics QA',
      status: 'COMPLETED_WITH_ERRORS',
      failed: 2,
      error: null,
    });
    expect(run.body.text).toBe(
      'Migration into DeepTrics QA ended COMPLETED_WITH_ERRORS with 2 failed record(s)',
    );
  });
});

describe('when the webhook misbehaves', () => {
  const alerts = (impl: unknown) =>
    new AlertService(
      config({ ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc' }),
      logger,
      impl as typeof fetch,
    );

  it('never throws, whatever the endpoint does', async () => {
    // A migration must not fail because a chat server is down.
    const refused = alerts(vi.fn(async () => new Response('no', { status: 500 })));
    await expect(refused.notify(event)).resolves.toBeUndefined();
    expect(await refused.deliver(event)).toMatchObject({ ok: false, reason: 'The webhook answered 500' });

    const broken = alerts(
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND hooks.example.com');
      }),
    );
    await expect(broken.notify(event)).resolves.toBeUndefined();
    expect((await broken.deliver(event)).ok).toBe(false);
  });

  it('gives up rather than hanging on to the work that caused it', async () => {
    const hangs = alerts(
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            // Mirrors what fetch does when the caller's signal aborts.
            init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
          }),
      ),
    );
    vi.useFakeTimers();
    const pending = hangs.deliver(event);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;
    vi.useRealTimers();
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toMatch(/did not answer within/);
  });
});
