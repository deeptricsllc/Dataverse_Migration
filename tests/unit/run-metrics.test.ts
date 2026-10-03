import { describe, expect, it } from 'vitest';
import type { RecordOutcome } from '../../shared/domain';
import {
  accountedFor,
  addAccounting,
  countOutcomes,
  EMPTY_ACCOUNTING,
  expectedInTarget,
  METRIC_DEFINITIONS,
  possiblyInTarget,
  sumAccounting,
  unresolvedCount,
  writtenByRun,
  wroteNothing,
} from '../../shared/run-metrics';

/**
 * The arithmetic every screen reads a migration through.
 *
 * The bug these exist for: the validation report counted every record the run had not failed on as
 * a record the run had migrated. A run that created nothing, updated nothing and skipped 28
 * pre-existing records reported 28 migrated, while the run page reported 0 created and 0 updated.
 * Two screens, one migration, two answers.
 */
describe('run metrics', () => {
  const outcomes = (counts: Partial<Record<RecordOutcome, number>>): RecordOutcome[] =>
    (Object.entries(counts) as [RecordOutcome, number][]).flatMap(([outcome, n]) =>
      Array.from({ length: n }, () => outcome),
    );

  it('counts each outcome into exactly one bucket', () => {
    const a = countOutcomes(
      outcomes({ CREATED: 3, UPDATED: 2, UNCHANGED: 4, SKIPPED: 5, FAILED: 1, UNRESOLVED: 2 }),
    );
    expect(a).toEqual({ created: 3, updated: 2, unchanged: 4, skipped: 5, failed: 1, unresolved: 2 });
    // Exhaustive and non-overlapping: the buckets add back up to what went in.
    expect(accountedFor(a)).toBe(17);
  });

  it('counts a record whose outcome is unknown as neither written nor failed', () => {
    /**
     * The sixth bucket, and why it exists.
     *
     * A write that timed out may have been applied. Calling it failed says the record is not in the
     * target, which may be false and — worse — implies re-processing it is safe. Calling it created
     * claims something unproven. So it is counted on its own, it is processed, and it is not written.
     */
    const a = countOutcomes(outcomes({ CREATED: 8, UNRESOLVED: 2 }));
    expect(writtenByRun(a), 'not written: we do not know that').toBe(8);
    expect(accountedFor(a), 'but processed: something was attempted').toBe(10);
    expect(unresolvedCount(a)).toBe(2);
    expect(possiblyInTarget(a), 'and they may be in the target').toBe(2);
    // Deliberately excluded from what validation should expect to find: the whole point is that
    // nobody knows whether they are there.
    expect(expectedInTarget(a)).toBe(8);
  });

  it('never counts a skipped record as written by the run', () => {
    // The exact shape of the migration that produced the contradiction.
    const a = countOutcomes(outcomes({ SKIPPED: 28, FAILED: 2 }));
    expect(writtenByRun(a)).toBe(0);
    expect(wroteNothing(a)).toBe(true);
    // It is still accounted for, and still expected to be in the target — those are the questions
    // skipped records legitimately answer. They are simply not work this run did.
    expect(accountedFor(a)).toBe(30);
    expect(expectedInTarget(a)).toBe(28);
  });

  it('never counts an unchanged record as written by the run', () => {
    const a = countOutcomes(outcomes({ CREATED: 1, UNCHANGED: 9 }));
    expect(writtenByRun(a)).toBe(1);
    expect(expectedInTarget(a)).toBe(10);
  });

  it('counts only created and updated as written, whatever the mix', () => {
    for (const [counts, written] of [
      [{ CREATED: 10 }, 10],
      [{ UPDATED: 7 }, 7],
      [{ CREATED: 4, UPDATED: 6, UNCHANGED: 100, SKIPPED: 100, FAILED: 100 }, 10],
      [{ UNCHANGED: 50, SKIPPED: 50 }, 0],
    ] as const) {
      expect(writtenByRun(countOutcomes(outcomes(counts)))).toBe(written);
    }
  });

  it('excludes failed records from what should be in the target', () => {
    // A run saying a record failed is a run saying it is not there. Expecting it would make
    // validation report a missing record that the run already accounted for.
    const a = countOutcomes(outcomes({ CREATED: 5, FAILED: 3 }));
    expect(expectedInTarget(a)).toBe(5);
    expect(accountedFor(a)).toBe(8);
  });

  it('adds up across tables without losing a bucket', () => {
    const a = countOutcomes(outcomes({ CREATED: 2, SKIPPED: 1 }));
    const b = countOutcomes(outcomes({ UPDATED: 3, FAILED: 4 }));
    expect(addAccounting(a, b)).toEqual({
      created: 2,
      updated: 3,
      unchanged: 0,
      skipped: 1,
      failed: 4,
      unresolved: 0,
    });
    expect(sumAccounting([a, b, EMPTY_ACCOUNTING])).toEqual(addAccounting(a, b));
    expect(sumAccounting([])).toEqual(EMPTY_ACCOUNTING);
  });

  it('defines "written" in words that exclude what was already there', () => {
    // The definitions ship to the browser so a tooltip cannot contradict a server message. If
    // somebody loosens this wording, the number and the explanation part company again.
    expect(METRIC_DEFINITIONS.written.label).toBe('Written by this run');
    expect(METRIC_DEFINITIONS.written.definition).toMatch(/created plus updated/i);
    expect(METRIC_DEFINITIONS.skipped.definition).toMatch(/did not write/i);
  });
});
