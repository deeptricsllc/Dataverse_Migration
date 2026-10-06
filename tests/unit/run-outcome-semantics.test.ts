import { describe, expect, it } from 'vitest';
import {
  canCompleteRun,
  decideRunStatus,
  deferredOutcome,
  runHadErrors,
} from '../../server/src/services/migration-engine';
import {
  CONFIGURED_WARNING_CODES,
  isMaterialWarning,
  MATERIAL_WARNING_CODES,
} from '../../shared/failure-categories';

/**
 * What a run's result means, as the decision rather than as the label.
 *
 * The defect these tests exist for was not a wording problem. A run wrote three hundred contacts into a
 * target with no accounts in it, every write succeeded, the engine recorded all three hundred dropped
 * parent references, and the run reported `Completed · Failed 0`. Accurate in every number, and a lie
 * about the migration — because the model it came from treated a written record as a migrated one.
 *
 * See `docs/MIGRATION_OUTCOME_SEMANTICS.md`.
 */

const clean = {
  failedRecords: 0,
  deferredFailed: 0,
  failedTables: 0,
  unresolvedErrors: 0,
  unresolvedWrites: 0,
  deferredIncomplete: 0,
  materialWarnings: 0,
};

describe('a run reports the worst outcome its evidence supports', () => {
  it('reports a run that carried everything as completed', () => {
    expect(decideRunStatus(clean)).toBe('COMPLETED');
  });

  /** The run this gate turned on, as the numbers it produced. */
  it('does not report a run that dropped every reference as completed', () => {
    const droppedEveryParent = { ...clean, materialWarnings: 270 };
    expect(decideRunStatus(droppedEveryParent)).toBe('COMPLETED_WITH_WARNINGS');
  });

  it('reports a record written with a reference omitted as completed with warnings', () => {
    expect(decideRunStatus({ ...clean, deferredIncomplete: 1 })).toBe('COMPLETED_WITH_WARNINGS');
  });

  /**
   * An omitted reference is not a failure, and the two outcomes are not interchangeable.
   *
   * A product that reported them the same way would be choosing between telling somebody records are
   * missing when they are not, and telling them nothing is wrong when something is.
   */
  it('keeps an omitted reference apart from a failed record', () => {
    expect(decideRunStatus({ ...clean, deferredIncomplete: 5 })).toBe('COMPLETED_WITH_WARNINGS');
    expect(decideRunStatus({ ...clean, failedRecords: 5 })).toBe('COMPLETED_WITH_ERRORS');
  });

  /** A failure outranks a warning: the worse news is the one that gets reported. */
  it('reports errors rather than warnings when there are both', () => {
    expect(decideRunStatus({ ...clean, failedRecords: 1, deferredIncomplete: 100 })).toBe(
      'COMPLETED_WITH_ERRORS',
    );
  });

  /**
   * And an unknown write outranks everything.
   *
   * Nothing may be claimed about a run while the outcome of a write is unknown — not a failure, not a
   * warning, not a success. That invariant predates this change and must not be weakened by it.
   */
  it('reports an unknown write result above every other outcome', () => {
    expect(
      decideRunStatus({
        ...clean,
        unresolvedWrites: 1,
        failedRecords: 10,
        deferredIncomplete: 10,
        materialWarnings: 10,
      }),
    ).toBe('NEEDS_RECONCILIATION');
    expect(canCompleteRun({ unresolvedWrites: 1 })).toBe(false);
  });

  /** A required reference that could not be set fails the record. It is not a warning. */
  it('reports a required reference that could not be set as an error', () => {
    expect(decideRunStatus({ ...clean, deferredFailed: 3 })).toBe('COMPLETED_WITH_ERRORS');
    expect(runHadErrors({ ...clean, deferredFailed: 3 })).toBe(true);
  });

  /** A whole table can fail without one record failing. */
  it('reports a lost dataset as an error with no failed records', () => {
    expect(decideRunStatus({ ...clean, failedTables: 1 })).toBe('COMPLETED_WITH_ERRORS');
  });

  /**
   * An omitted reference is never counted as a failure.
   *
   * The assertion that keeps the two numbers honest in both directions: `failed` means failed, and a
   * degraded outcome does not inflate it.
   */
  it('does not count an omitted reference as a failure', () => {
    // `runHadErrors` does not take the warning counts at all, which is the structural half of this: a
    // warning cannot reach the failure decision even by mistake.
    expect(runHadErrors(clean)).toBe(false);
    expect(decideRunStatus({ ...clean, deferredIncomplete: 500, materialWarnings: 500 })).not.toBe(
      'COMPLETED_WITH_ERRORS',
    );
  });
});

describe('what the second pass achieved for one record', () => {
  it('reports a record whose references were all set as resolved', () => {
    expect(deferredOutcome([])).toBe('RESOLVED');
  });

  /**
   * The state that was missing.
   *
   * `RESOLVED` was the answer for anything the target did not refuse, so a record written without its
   * optional reference counted as resolved — and `deferredResolved` is what the run reads to decide it
   * had no issue. One record in this state is the difference between `Completed` and the truth.
   */
  it('reports a record written with an optional reference omitted as incomplete', () => {
    expect(deferredOutcome([{ severity: 'WARNING' }])).toBe('INCOMPLETE');
  });

  it('reports a record missing a required reference as failed', () => {
    expect(deferredOutcome([{ severity: 'ERROR' }])).toBe('FAILED');
  });

  it('reports failed when a record has both, because the record is not valid', () => {
    expect(deferredOutcome([{ severity: 'WARNING' }, { severity: 'ERROR' }])).toBe('FAILED');
  });
});

/**
 * Which warnings change the data.
 *
 * The risk in counting warnings toward a run's outcome is a product that calls every run degraded, which
 * teaches people the result line is noise. Only a warning that means a record carries less than its
 * source record did is counted.
 */
describe('a warning changes the outcome only when it changes the data', () => {
  it('counts a dropped relationship', () => {
    expect(isMaterialWarning('LOOKUP_UNRESOLVED')).toBe(true);
  });

  it('counts a record whose owner was not carried across', () => {
    expect(isMaterialWarning('PRINCIPAL_UNRESOLVED')).toBe(true);
  });

  /**
   * The line this change had to be careful about.
   *
   * A fallback identity is a real difference — the owner on the target record is not the owner on the
   * source record — and it is also exactly what the plan was configured to do: the identity is named in
   * the plan, the plan raises it as an issue, and the person acknowledges it before the run starts.
   *
   * Counting it would mark every run into a tenant with no user mapping as incomplete, for the rest of
   * the project, for doing what it was told. The test is not "is the data different" but "was this asked
   * for". Nobody asks for a relationship to be dropped.
   */
  it('does not count an owner replaced by the identity the plan names', () => {
    expect(isMaterialWarning('PRINCIPAL_FALLBACK_APPLIED')).toBe(false);
    expect(CONFIGURED_WARNING_CODES).toContain('PRINCIPAL_FALLBACK_APPLIED');
  });

  /** A record the strategy was configured to leave alone is the engine doing what it was told. */
  it('does not count a record the conflict strategy skipped', () => {
    expect(isMaterialWarning('ALREADY_EXISTS')).toBe(false);
    expect(CONFIGURED_WARNING_CODES).toContain('ALREADY_EXISTS');
  });

  /** No code is in both lists, because a warning is one or the other. */
  it('classifies every code it knows exactly once', () => {
    for (const code of MATERIAL_WARNING_CODES) expect(CONFIGURED_WARNING_CODES).not.toContain(code);
  });

  /** Resolved by the pass that follows it, so nothing is left behind. */
  it('does not count a reference waiting for a later dataset', () => {
    expect(isMaterialWarning('LOOKUP_PENDING_MIGRATION')).toBe(false);
  });

  /**
   * Codes arrive as `CODE:platformCode`, where the suffix is the target system's own code. The prefix is
   * the category, and a code that is not matched on its prefix would be silently uncounted.
   */
  it('matches a code that carries the target system’s own code', () => {
    expect(isMaterialWarning('LOOKUP_UNRESOLVED:0x80040217')).toBe(true);
  });

  it('does not count a code it does not know', () => {
    expect(isMaterialWarning('SOME_CONNECTOR_CODE')).toBe(false);
    expect(MATERIAL_WARNING_CODES).not.toContain('SOME_CONNECTOR_CODE');
  });
});
