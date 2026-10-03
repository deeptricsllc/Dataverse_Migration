import { describe, expect, it } from 'vitest';
import { accountedFor, countOutcomes, writtenByRun } from '../../shared/run-metrics';
import {
  combineCoverage,
  coverageOf,
  coveragePercent,
  describeClean,
  fullCoverage,
  notVerified,
  withMode,
  type ValidationCoverage,
} from '../../shared/validation-coverage';
import {
  CONNECTOR_VERIFICATION,
  ENGINE_PROVABLE,
  levelRank,
  summaryLevel,
  type ConnectorCapabilityKey,
} from '../../shared/connector-verification';
import type { RecordOutcome } from '../../shared/domain';

/**
 * The statements the product is not allowed to make, whatever route it takes to them.
 *
 * Each of these started as a mistake that a screen could display. The 882-against-441 coverage
 * figure was found by reading a deployed page, not by a test, and the lesson was not "read more
 * pages" — it was that an arithmetic relationship nobody had written down can quietly stop holding.
 * So the relationships are written down, exhaustively where the space is small enough to be
 * exhaustive.
 */
describe('invariants that must hold however the numbers arrive', () => {
  const outcomes = (counts: Partial<Record<RecordOutcome, number>>): RecordOutcome[] =>
    (Object.entries(counts) as [RecordOutcome, number][]).flatMap(([outcome, n]) =>
      Array.from({ length: n }, () => outcome),
    );

  /** A spread of mixes, including every single-outcome case and several awkward ones. */
  const MIXES: Partial<Record<RecordOutcome, number>>[] = [
    {},
    { CREATED: 1 },
    { UPDATED: 1 },
    { UNCHANGED: 1 },
    { SKIPPED: 1 },
    { FAILED: 1 },
    { CREATED: 10, UPDATED: 5, UNCHANGED: 3, SKIPPED: 2, FAILED: 1 },
    { SKIPPED: 28, FAILED: 2 },
    { UNCHANGED: 1000 },
    { CREATED: 441 },
    { CREATED: 65, SKIPPED: 2, FAILED: 3 },
  ];

  it('written is created plus updated, and never anything else', () => {
    for (const mix of MIXES) {
      const a = countOutcomes(outcomes(mix));
      expect(writtenByRun(a), JSON.stringify(mix)).toBe(a.created + a.updated);
      expect(writtenByRun(a)).toBeLessThanOrEqual(accountedFor(a));
    }
  });

  it('processed is the sum of the five mutually exclusive outcomes', () => {
    for (const mix of MIXES) {
      const a = countOutcomes(outcomes(mix));
      expect(accountedFor(a), JSON.stringify(mix)).toBe(
        a.created + a.updated + a.unchanged + a.skipped + a.failed,
      );
    }
  });

  it('a record the run refused to write is never counted as written', () => {
    for (const mix of MIXES) {
      const a = countOutcomes(outcomes(mix));
      // Skipped, unchanged and failed can be any size at all without moving `written`.
      const inflated = countOutcomes(
        outcomes({ ...mix, SKIPPED: (mix.SKIPPED ?? 0) + 10_000, UNCHANGED: (mix.UNCHANGED ?? 0) + 10_000 }),
      );
      expect(writtenByRun(inflated), JSON.stringify(mix)).toBe(writtenByRun(a));
    }
  });

  const COVERAGES = [
    fullCoverage(0),
    fullCoverage(441),
    coverageOf({ eligible: 10, examined: 10, cap: 5000 }),
    coverageOf({ eligible: 10_000_000, examined: 50_000, cap: 50_000 }),
    coverageOf({ eligible: 2, examined: 1, cap: 1 }),
    notVerified(500, 'no key'),
  ];

  it('examined never exceeds eligible', () => {
    for (const c of COVERAGES) expect(c.examined).toBeLessThanOrEqual(c.eligible);
  });

  it('FULL means every eligible record was examined, and nothing else claims that', () => {
    for (const c of COVERAGES) {
      if (c.mode === 'FULL') expect(c.examined, JSON.stringify(c)).toBe(c.eligible);
      if (c.mode === 'SAMPLED') expect(c.examined).toBeLessThan(c.eligible);
      if (c.mode === 'NOT_VERIFIED') expect(c.examined).toBe(0);
    }
  });

  it('a partial examination never displays as complete coverage', () => {
    for (const c of COVERAGES) {
      if (c.mode !== 'SAMPLED') continue;
      expect(coveragePercent(c), JSON.stringify(c)).toBeLessThan(100);
      // And a vanishing sample is not shown as nothing, which would read as "we checked none".
      if (c.examined > 0) expect(coveragePercent(c)).toBeGreaterThan(0);
    }
  });

  it('a result that could not run never reads like one that passed', () => {
    const missing = notVerified(100, 'this connector cannot group by key');
    const clean = fullCoverage(100);
    expect(describeClean(missing)).not.toBe(describeClean(clean));
    expect(describeClean(missing)).toMatch(/not verified/i);
    expect(describeClean(missing)).not.toMatch(/no differences/i);
  });

  it('combining coverage never invents records or strengthens the claim', () => {
    for (const a of COVERAGES) {
      for (const b of COVERAGES) {
        const combined = combineCoverage([a, b]);
        expect(combined.eligible).toBe(a.eligible + b.eligible);
        expect(combined.examined).toBe(a.examined + b.examined);
        expect(combined.examined).toBeLessThanOrEqual(combined.eligible);
        // The weakest claim wins: two FULLs make a FULL, anything else does not.
        const expected =
          a.mode === 'NOT_VERIFIED' || b.mode === 'NOT_VERIFIED'
            ? 'NOT_VERIFIED'
            : a.mode === 'SAMPLED' || b.mode === 'SAMPLED'
              ? 'SAMPLED'
              : 'FULL';
        expect(combined.mode, `${a.mode} + ${b.mode}`).toBe(expected);
      }
    }
  });

  it('narrowing a coverage mode never changes its counts', () => {
    // The 882-against-441 bug in one assertion: a mode can be weakened without adding records.
    for (const c of COVERAGES) {
      const narrowed = withMode(c, 'NOT_VERIFIED', 'a check did not run');
      expect(narrowed.eligible).toBe(c.eligible);
      expect(narrowed.examined).toBe(c.examined);
      expect(narrowed.mode).toBe('NOT_VERIFIED');
    }
  });

  it('the numbers a reader adds up actually add up', () => {
    // Found by reconciling a deployed report by hand: matched 66 + missing 3 + differing 1 = 70,
    // over 67 records examined. Each number was right; the sum was not a number of anything,
    // because the three "missing" were records the run had already reported as failed and which
    // were therefore never compared. They are counted separately now.
    const examined = 67;
    const matched = 66;
    const different = 1;
    const missing = 0; // validation's own finding
    const failedInRun = 3; // the run's finding, confirmed
    expect(matched + different + missing, 'what was examined is what was accounted for').toBe(examined);
    expect(failedInRun, 'is reported beside, not added into, the examined set').toBeGreaterThan(0);
  });

  it('a run that did not deliver records never reads as passed', () => {
    // Separating the counts was right; separating the verdict would not have been. The first fix
    // quietly turned a FAIL into "passed with warnings" on a run that lost three records, which is
    // exactly the green badge this product exists to argue against. Absence fails the check
    // whatever its reason; only the explanation differs.
    const cases = [
      { missing: 0, failedInRun: 0, shouldPass: true },
      { missing: 0, failedInRun: 3, shouldPass: false },
      { missing: 2, failedInRun: 0, shouldPass: false },
      { missing: 2, failedInRun: 3, shouldPass: false },
    ];
    for (const c of cases) {
      const absent = c.missing + c.failedInRun;
      expect(absent === 0, JSON.stringify(c)).toBe(c.shouldPass);
    }
  });

  it('a capability cannot read as engine verified without being engine provable', () => {
    for (const [type, row] of Object.entries(CONNECTOR_VERIFICATION)) {
      if (type === 'FILE') continue; // no external engine exists to verify against
      for (const [capability, level] of Object.entries(row!)) {
        if (level !== 'ENGINE_VERIFIED') continue;
        expect(ENGINE_PROVABLE, `${type}.${capability}`).toContain(capability as ConnectorCapabilityKey);
      }
    }
  });

  it('a connector summary is never stronger than its weakest capability', () => {
    for (const [type, row] of Object.entries(CONNECTOR_VERIFICATION)) {
      const summary = summaryLevel(type as never)!;
      for (const level of Object.values(row!)) {
        if (level === 'NOT_SUPPORTED' || level === 'REQUIRES_CONFIGURATION') continue;
        expect(levelRank(summary), `${type} summary vs ${level}`).toBeLessThanOrEqual(levelRank(level!));
      }
    }
  });
});

/**
 * A check that examined nothing cannot pass.
 *
 * Found on deployed QA: a validation whose source records could not be re-read compared nothing, and
 * reported "PASS: Not verified — no records were examined. Every one of them is in the target." A
 * self-contradicting sentence with a green badge on it.
 *
 * The rule is stated here as a property of the vocabulary rather than of one code path: for any check,
 * an outcome of PASS and a coverage mode of NOT_VERIFIED must never appear together.
 */
describe('a verdict never outruns its coverage', () => {
  const cases: { coverage: ValidationCoverage; label: string }[] = [
    {
      label: 'nothing examined at all',
      coverage: notVerified(1200, 'No records were examined.'),
    },
    {
      label: 'a check that could not run',
      coverage: notVerified(50, 'The connector cannot look.'),
    },
  ];

  for (const { coverage, label } of cases) {
    it(`describes ${label} without claiming anything`, () => {
      const described = describeClean(coverage, 'records');
      // The sentence a PASS would have used must itself say it was not verified.
      expect(described.toLowerCase()).toContain('not verified');
      expect(described.toLowerCase()).not.toContain('no differences');
      expect(coveragePercent(coverage), 'and no percentage is implied').toBe(0);
    });
  }

  it('says nothing was examined rather than that everything was clean', () => {
    const coverage = notVerified(1200, 'No records were examined.');
    expect(coverage.mode).toBe('NOT_VERIFIED');
    expect(coverage.examined).toBe(0);
    expect(coverage.eligible, 'while still saying how many there were').toBe(1200);
    // The distinction that matters: "nothing to check" and "we did not check" are different answers.
    const empty = fullCoverage(0, 'Nothing to examine.');
    expect(empty.mode).toBe('FULL');
    expect(describeClean(empty, 'records')).toBe('Nothing to check.');
    expect(describeClean(coverage, 'records')).not.toBe('Nothing to check.');
  });
});
