import { describe, expect, it } from 'vitest';
import { isDatabaseUnreachable, migrateWhenReachable } from '../../server/src/db/client';

/**
 * Starting up when the database is not there yet.
 *
 * A deploy used to be minutes of refused requests because the app exited the instant the database's
 * name did not resolve, and the platform restarted it until DNS caught up. It waits now — but only
 * for the errors that mean "not yet", because waiting out a rejected password only delays the
 * answer.
 */
describe('waiting for the database at startup', () => {
  /** A migrate() that fails with the given errors in turn, then succeeds. */
  function migrator(errors: unknown[]) {
    const calls: string[] = [];
    return {
      calls,
      migrate: async (dir: string) => {
        calls.push(dir);
        const error = errors[calls.length - 1];
        if (error) throw error;
      },
    };
  }

  const dnsNotReady = Object.assign(new Error('getaddrinfo EAI_AGAIN db.internal'), {
    code: 'EAI_AGAIN',
  });

  it('waits out a database that is not resolvable yet, then applies the migrations', async () => {
    const db = migrator([dnsNotReady, dnsNotReady]);
    const waits: number[] = [];
    await migrateWhenReachable(db, './migrations', {
      baseDelayMs: 1,
      onWait: (info) => waits.push(info.attempt),
    });
    expect(db.calls).toEqual(['./migrations', './migrations', './migrations']);
    expect(waits).toEqual([1, 2]);
  });

  it('looks through the wrapper the driver puts around it', async () => {
    // Drizzle reports its own error and hangs the driver's underneath, so the code that says
    // "not yet" is never the one on the error that is thrown.
    const wrapped = Object.assign(new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"'), {
      cause: Object.assign(new Error('getaddrinfo EAI_AGAIN postgres.railway.internal'), {
        code: 'EAI_AGAIN',
      }),
    });
    expect(isDatabaseUnreachable(wrapped)).toBe(true);

    const db = migrator([wrapped]);
    await migrateWhenReachable(db, './migrations', { baseDelayMs: 1 });
    expect(db.calls).toHaveLength(2);
  });

  it('does not wait for an answer the database already gave', async () => {
    // A rejected password and a migration that does not apply are both final. Retrying them for a
    // minute would only postpone the error that says what is actually wrong.
    for (const fatal of [
      Object.assign(new Error('password authentication failed'), { code: '28P01' }),
      new Error('syntax error at or near "CREAT"'),
    ]) {
      const db = migrator([fatal]);
      await expect(migrateWhenReachable(db, './migrations', { baseDelayMs: 1 })).rejects.toThrow();
      expect(db.calls).toHaveLength(1);
    }
  });

  it('gives up once it has waited long enough, and reports the real reason', async () => {
    // Never reachable: the error the operator sees is the database's, not a timeout of our own.
    const db = migrator(Array.from({ length: 50 }, () => dnsNotReady));
    await expect(migrateWhenReachable(db, './migrations', { waitMs: 20, baseDelayMs: 1 })).rejects.toThrow(
      /EAI_AGAIN/,
    );
    expect(db.calls.length).toBeGreaterThan(1);
  });
});
