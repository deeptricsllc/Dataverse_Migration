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
    expect(boundDetails(details)).toBe(details);
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
});
