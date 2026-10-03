import { describe, expect, it } from 'vitest';
import { boundDetails } from '../../server/src/services/audit-service';

/**
 * Keeping an audit event bounded without destroying what it was for.
 *
 * The failure to avoid is not "the row got big" — it is a bounded row that nobody can use. Chopping
 * the middle out of a JSON document leaves something that no longer parses and silently discards
 * whichever half came second, which is worse than either storing it whole or storing nothing.
 */
describe('audit detail bounds', () => {
  it('leaves an ordinary event exactly as it was', () => {
    const details = { basis: 'EXACT', tables: 7, records: 177, blockers: 1 };
    // A copy rather than the same object, because every string now goes through the secret scrubber on
    // the way in. What a reader of the audit row sees is unchanged, which is what this is about.
    expect(boundDetails(details)).toEqual(details);
    expect(boundDetails(details)).not.toHaveProperty('_truncated');
  });

  it('keeps every key when it has to shorten something', () => {
    const details = {
      action: 'MIGRATION_COMPLETED',
      tables: ['a', 'b'],
      error: 'E'.repeat(50_000),
      runId: 'abc-123',
    };
    const bounded = boundDetails(details)!;
    // The shape survives: a reader can still see what kind of event this was and which run.
    expect(Object.keys(bounded)).toEqual(expect.arrayContaining(['action', 'tables', 'error', 'runId']));
    expect(bounded['action']).toBe('MIGRATION_COMPLETED');
    expect(bounded['runId']).toBe('abc-123');
    expect(String(bounded['error']).length).toBeLessThan(2000);
  });

  it('says where it cut, and how much there was', () => {
    const bounded = boundDetails({ note: 'N'.repeat(40_000) })!;
    const truncated = bounded['_truncated'] as Record<string, unknown>;
    expect(truncated, 'the event admits it was shortened').toBeTruthy();
    expect(Number(truncated['originalCharacters'])).toBeGreaterThan(40_000);
    expect(String(bounded['note'])).toMatch(/shortened for the audit trail/);
  });

  it('still produces valid JSON', () => {
    // The whole reason values are shortened individually rather than the document being sliced.
    const bounded = boundDetails({ a: 'x'.repeat(20_000), b: { c: 'y'.repeat(20_000) } });
    expect(() => JSON.parse(JSON.stringify(bounded))).not.toThrow();
  });

  it('bounds a long array by count, keeping the head and saying how many were dropped', () => {
    const bounded = boundDetails({
      filler: 'f'.repeat(9000),
      ids: Array.from({ length: 500 }, (_, i) => `id-${i}`),
    })!;
    const ids = bounded['ids'] as unknown[];
    expect(ids.length).toBe(21);
    expect(ids[0]).toBe('id-0');
    expect(String(ids[20])).toMatch(/480 more/);
  });

  it('does not fall over on something that cannot be serialised', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    // Treated as over the limit and bounded, rather than throwing inside an audit write.
    expect(() => boundDetails(circular)).not.toThrow();
  });

  it('leaves null alone', () => {
    expect(boundDetails(null)).toBeNull();
  });
  it('scrubs a secret out of an audit payload, whether or not it needed shortening', () => {
    /**
     * The audit trail is the most durable place a secret could land: rows are kept deliberately,
     * exported, and read by people who did not write them. Nothing deliberately puts a credential in a
     * payload — a connection event records `passwordChanged: true` — but the free-form thing most likely
     * to carry one is an error message, which is exactly where a connection string ends up.
     */
    const small = boundDetails({
      action: 'ENVIRONMENT_CONNECTION_TESTED',
      error: 'failed to connect: postgres://admin:hunter2@db.internal:5432/app',
    })!;
    expect(JSON.stringify(small)).not.toContain('hunter2');
    expect(String(small['error'])).toContain('[REDACTED]');
    // The shape survives: the key is still there and still says what went wrong.
    expect(String(small['error'])).toContain('failed to connect');
    expect(small['action']).toBe('ENVIRONMENT_CONNECTION_TESTED');

    // And on the path that also shortens, so neither pass can be the only one that scrubs.
    const large = boundDetails({
      filler: 'f'.repeat(9000),
      error: 'Login failed; Password=hunter2; Server=db.internal',
      token: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    })!;
    const serialised = JSON.stringify(large);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(large['_truncated'], 'and it was shortened as well').toBeTruthy();
  });

  it('scrubs inside nested structures and arrays', () => {
    const bounded = boundDetails({
      attempts: [
        { host: 'db.internal', message: 'postgres://u:s3cret@db.internal/app' },
        { host: 'db2.internal', message: 'fine' },
      ],
      nested: { deeper: { message: 'client_secret=abc123def' } },
    })!;
    const serialised = JSON.stringify(bounded);
    expect(serialised).not.toContain('s3cret');
    expect(serialised).not.toContain('abc123def');
    expect(serialised, 'and keeps everything that was not a secret').toContain('db2.internal');
  });
});
