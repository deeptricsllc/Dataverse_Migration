import { describe, expect, it } from 'vitest';
import {
  combineCoverage,
  coverageOf,
  coveragePercent,
  depthCap,
  describeClean,
  describeCoverage,
  fullCoverage,
  notVerified,
} from '../../shared/validation-coverage';

/**
 * What a validation result is allowed to claim about itself.
 *
 * The failure these prevent is a sentence, not a crash: "all checks passed" printed over a report
 * that compared fifty thousand of ten million records. Every success message in the product is
 * derived from coverage so that none of them can be written by hand next to a number that
 * contradicts them.
 */
describe('validation coverage', () => {
  it('calls a partial examination sampled, however large', () => {
    const c = coverageOf({ eligible: 10_000_000, examined: 50_000, cap: 50_000 });
    expect(c.mode).toBe('SAMPLED');
    expect(coveragePercent(c)).toBe(0.5);
    expect(describeClean(c)).toBe('No differences found in the 50,000 records examined, of 10,000,000.');
    // The words that were there before, and must never come back over a sample.
    expect(describeClean(c)).not.toMatch(/all checks passed/i);
    expect(describeClean(c)).not.toMatch(/everything matches/i);
  });

  it('only says "all" when all of them were examined', () => {
    const c = coverageOf({ eligible: 441, examined: 441, cap: 5000 });
    expect(c.mode).toBe('FULL');
    expect(describeClean(c)).toBe('No differences in any of the 441 records.');
    expect(describeCoverage(c)).toBe('All 441 records were examined.');
  });

  it('never rounds a sample up to full coverage', () => {
    // 9,999,999 of 10,000,000 is not 100%, and displaying it as 100% is the whole problem.
    const almost = coverageOf({ eligible: 10_000_000, examined: 9_999_999, cap: null });
    expect(almost.mode).toBe('SAMPLED');
    expect(coveragePercent(almost)).toBe(99.9);
    expect(coveragePercent(almost)).toBeLessThan(100);

    // And a vanishingly small sample is not reported as 0%, which would read as "nothing checked".
    const tiny = coverageOf({ eligible: 100_000_000, examined: 10, cap: 10 });
    expect(coveragePercent(tiny)).toBe(0.1);
    expect(coveragePercent(tiny)).toBeGreaterThan(0);
  });

  it('distinguishes "could not check" from "checked and found nothing"', () => {
    const missing = notVerified(5000, 'This connector cannot group by key.');
    expect(missing.mode).toBe('NOT_VERIFIED');
    expect(missing.examined).toBe(0);
    expect(describeClean(missing)).toMatch(/Not verified/);
    expect(describeClean(missing)).toContain('cannot group by key');
    // A clean full result and an unrunnable one must not read alike.
    expect(describeClean(missing)).not.toBe(describeClean(fullCoverage(5000)));
  });

  it('takes the weakest claim across tables', () => {
    // One sampled table makes the report a sampled report: the reader is being handed one verdict.
    const mixed = combineCoverage([fullCoverage(100), coverageOf({ eligible: 900, examined: 90, cap: 90 })]);
    expect(mixed.mode).toBe('SAMPLED');
    expect(mixed.eligible).toBe(1000);
    expect(mixed.examined).toBe(190);

    // And one unrunnable check outranks a sample, because it is a gap rather than a reduction.
    const withGap = combineCoverage([
      fullCoverage(100),
      coverageOf({ eligible: 900, examined: 90, cap: 90 }),
      notVerified(10, 'no key'),
    ]);
    expect(withGap.mode).toBe('NOT_VERIFIED');
    expect(withGap.reason).toContain('no key');

    expect(combineCoverage([fullCoverage(5), fullCoverage(7)]).mode).toBe('FULL');
  });

  it('treats an empty table as fully examined rather than unverified', () => {
    const c = coverageOf({ eligible: 0, examined: 0, cap: 5000 });
    expect(c.mode).toBe('FULL');
    expect(describeClean(c)).toBe('Nothing to check.');
  });

  it('caps work by depth, and only full has no cap', () => {
    expect(depthCap('QUICK')).toBe(500);
    expect(depthCap('STANDARD')).toBe(5000);
    expect(depthCap('FULL')).toBeNull();
  });

  it('says how the records were chosen, without claiming it was a random sample', () => {
    const c = coverageOf({ eligible: 1000, examined: 100, cap: 100 });
    expect(c.deterministic).toBe(true);
    expect(c.strategy).toMatch(/source-identifier order/);
    // No statistical language anywhere: nothing here supports a confidence interval.
    expect(c.strategy).not.toMatch(/confidence|random|stratified|margin/i);
  });
});
