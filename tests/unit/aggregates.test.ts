import { describe, expect, it } from 'vitest';
import {
  AGGREGATE_CAVEAT,
  canCompareExtremes,
  canSum,
  decimalsEqual,
  roundDecimal,
  totalsEqual,
  whyNotAggregatable,
} from '../../shared/aggregates';
import { attr } from './fixtures';

/**
 * What may be reconciled by totals, and what must not be.
 *
 * The temptation with aggregates is to offer them for everything, because every column has a SUM.
 * Most of those sums mean nothing, and a reconciliation that compares meaningless numbers produces
 * failures nobody can act on and passes nobody should trust. The exclusions are the design.
 */
describe('which columns can be reconciled by totals', () => {
  it('sums integers and fixed-point decimals', () => {
    for (const type of ['Integer', 'BigInt', 'Decimal', 'Money'] as const) {
      expect(canSum(attr('c', type)), type).toBe(true);
    }
  });

  it('refuses to sum floating point, and says why', () => {
    // Addition is not associative in binary floating point, so two engines adding identical values
    // in a different row order produce different totals. A mismatch would mean nothing.
    const double = attr('c', 'Double');
    expect(canSum(double)).toBe(false);
    expect(whyNotAggregatable(double)).toMatch(/row order/);
  });

  it('refuses to sum things whose numbers are identifiers', () => {
    for (const type of ['Boolean', 'Picklist', 'Status', 'Lookup', 'Uniqueidentifier'] as const) {
      const a = attr('c', type);
      expect(canSum(a), type).toBe(false);
      expect(whyNotAggregatable(a), type).toBeTruthy();
    }
  });

  it('compares extremes for ordered types but not for text', () => {
    expect(canCompareExtremes(attr('c', 'DateTime'))).toBe(true);
    expect(canCompareExtremes(attr('c', 'Decimal'))).toBe(true);
    // MIN over strings depends on collation: two engines can disagree about which value is
    // smallest without either being wrong.
    expect(canCompareExtremes(attr('c', 'String'))).toBe(false);
    expect(whyNotAggregatable(attr('c', 'String'))).toMatch(/collation/);
  });
});

describe('comparing decimal totals exactly', () => {
  it('does not lose digits a float would lose', () => {
    // Number() cannot hold this; a reconciliation that quietly rounds is worse than one that
    // refuses, because it reports a match that is not there.
    const a = '12345678901234567890.1234';
    const b = '12345678901234567890.1235';
    expect(Number(a) === Number(b), 'floats cannot tell these apart').toBe(true);
    expect(decimalsEqual(a, b), 'the comparison can').toBe(false);
    expect(decimalsEqual(a, a)).toBe(true);
  });

  it('treats the same value written differently as equal', () => {
    expect(decimalsEqual('1.50', '1.5')).toBe(true);
    expect(decimalsEqual('1.5000', '1.50')).toBe(true);
    expect(decimalsEqual('0', '0.000')).toBe(true);
    expect(decimalsEqual('-0.0', '0')).toBe(true);
    expect(decimalsEqual(' 42 ', '42')).toBe(true);
  });

  it('keeps sign and magnitude apart', () => {
    expect(decimalsEqual('-99.5000', '-99.5')).toBe(true);
    expect(decimalsEqual('-99.5', '99.5')).toBe(false);
    expect(decimalsEqual('0.0001', '0.001')).toBe(false);
  });

  it('says nothing is equal to a value it could not read', () => {
    expect(decimalsEqual(null, '1')).toBe(false);
    expect(decimalsEqual('1', null)).toBe(false);
    // Two absent values are the same absence, which is a fact about scope rather than about data.
    expect(decimalsEqual(null, null)).toBe(true);
  });

  it('falls back to a literal comparison rather than guessing at nonsense', () => {
    expect(decimalsEqual('not a number', 'not a number')).toBe(true);
    expect(decimalsEqual('not a number', '0')).toBe(false);
  });

  it('compares timestamps as instants, not as text', () => {
    // The same moment, rendered by two engines. A text comparison would call this a failed
    // migration, which is how a correct report teaches people to ignore it.
    expect(totalsEqual('2025-01-15 03:00:00-07', '2025-01-15T10:00:00Z', { temporal: true })).toBe(true);
    expect(totalsEqual('2025-01-15 10:00:00+00', '2025-01-15T10:00:00.000Z', { temporal: true })).toBe(true);
    // A genuinely different moment still fails.
    expect(totalsEqual('2025-01-15T10:00:00Z', '2025-01-15T10:00:01Z', { temporal: true })).toBe(false);
    // And an unparseable pair is compared literally rather than guessed at.
    expect(totalsEqual('not a date', 'not a date', { temporal: true })).toBe(true);
    expect(totalsEqual('not a date', '2025-01-15T10:00:00Z', { temporal: true })).toBe(false);
  });

  it('keeps the numeric path exact when the values are not timestamps', () => {
    expect(totalsEqual('12345678901234567890.1234', '12345678901234567890.1235', {})).toBe(false);
    expect(totalsEqual('1.50', '1.5', {})).toBe(true);
    // A date string is not treated as a number when the column is not temporal.
    expect(totalsEqual('2025-01-15', '2025-01-15', {})).toBe(true);
  });

  it('compares a money total at the exactness the column actually has', () => {
    // The real case this exists for. One side accumulated float error on the way to the sum; the
    // column holds two decimals, so there is no third decimal for the two sides to disagree about,
    // and reporting a failed migration here would be a false alarm.
    expect(totalsEqual('30024889.949999999985', '30024889.95', { scale: 2 })).toBe(true);
    // Without the scale it is a difference, which is why the scale has to be passed rather than
    // assumed: at full precision these are not the same string.
    expect(totalsEqual('30024889.949999999985', '30024889.95', {})).toBe(false);
    // And a difference the column *can* hold is still a difference.
    expect(totalsEqual('100.00', '100.01', { scale: 2 })).toBe(false);
    expect(totalsEqual('100.004', '100.005', { scale: 2 })).toBe(false);
  });

  it('rounds exactly, and the same way on both sides', () => {
    expect(roundDecimal('1.005', 2)).toBe('1.01');
    expect(roundDecimal('1.004', 2)).toBe('1.00');
    expect(roundDecimal('-1.005', 2)).toBe('-1.01');
    expect(roundDecimal('1.5', 0)).toBe('2');
    expect(roundDecimal('1', 4)).toBe('1.0000');
    // No float anywhere, so a value wider than a double survives.
    expect(roundDecimal('12345678901234567890.1235', 3)).toBe('12345678901234567890.124');
    // Zero has no sign.
    expect(roundDecimal('-0.0004', 2)).toBe('0.00');
    expect(roundDecimal('not a number', 2)).toBeNull();
  });

  it('states that totals agreeing is not records agreeing', () => {
    // The sentence that travels with every aggregate result. An aggregate PASS is the easiest
    // number in the system to over-read, so the caveat is part of the data, not the styling.
    expect(AGGREGATE_CAVEAT).toMatch(/supplementary/i);
    expect(AGGREGATE_CAVEAT).toMatch(/does not prove/i);
  });
});
