import { describe, expect, it } from 'vitest';
import {
  currencyMarker,
  decimalPlaces,
  decimalSeparator,
  looksLikeCurrency,
  shapeOf,
} from '../../shared/value-shapes';

/**
 * The classifier the conversion findings count with.
 *
 * Every count a reader is asked to act on is a tally of these answers, so the answers are pinned
 * here rather than being implied by the findings that quote them. The awkward cases are the point:
 * a finance export contains all of them on the same sheet.
 */

describe('what a stored value looks like', () => {
  it('reads plain numbers as numbers', () => {
    expect(shapeOf('1000')).toBe('NUMBER');
    expect(shapeOf('-12.5')).toBe('NUMBER');
    expect(shapeOf(' 42 ')).toBe('NUMBER');
  });

  it('reads money written for people as money', () => {
    expect(shapeOf('$1,200.50')).toBe('CURRENCY');
    expect(shapeOf('£20')).toBe('CURRENCY');
    expect(shapeOf('USD 1500')).toBe('CURRENCY');
    expect(shapeOf('1.234,56')).toBe('CURRENCY');
    expect(shapeOf('1,234.56')).toBe('CURRENCY');
  });

  it('does not call an ungrouped number money just because it could be an amount', () => {
    // 1200.50 is a number. Calling it money would make every quantity column a currency finding.
    expect(shapeOf('1200.50')).toBe('NUMBER');
    expect(looksLikeCurrency('1200.50')).toBe(false);
  });

  it('reads boolean words as boolean, and bare digits as numbers', () => {
    expect(shapeOf('Yes')).toBe('BOOLEAN');
    expect(shapeOf('N')).toBe('BOOLEAN');
    expect(shapeOf('false')).toBe('BOOLEAN');
    // A column of 1s and 0s is a column of numbers until a word shows up beside them.
    expect(shapeOf('1')).toBe('NUMBER');
    expect(shapeOf('0')).toBe('NUMBER');
  });

  it('reads dates only when they are written as dates', () => {
    expect(shapeOf('2026-03-04')).toBe('DATE');
    expect(shapeOf('2026-03-04T10:00:00Z')).toBe('DATE');
    expect(shapeOf('04/03/2026')).toBe('DATE');
    // An Excel serial is a number here. That it *means* a date is the semantic reader's job.
    expect(shapeOf('44000')).toBe('NUMBER');
    // A reference number must not become a date.
    expect(shapeOf('ORD-5001')).toBe('TEXT');
  });

  it('reads anything else as text, and nothing as blank', () => {
    expect(shapeOf('Northwind Trading')).toBe('TEXT');
    expect(shapeOf('')).toBe('BLANK');
    expect(shapeOf('   ')).toBe('BLANK');
  });
});

describe('the two things about written money that carry risk', () => {
  it('treats one currency written large and small as one convention', () => {
    /*
     * $1,200.50 and $9.99 are the same convention: the second simply has nothing to group. An
     * earlier signature folded grouping in, so every currency column holding amounts above and
     * below a thousand reported itself as inconsistent.
     */
    expect(currencyMarker('$1,200.50')).toBe('$');
    expect(currencyMarker('$9.99')).toBe('$');
    expect(decimalSeparator('$1,200.50')).toBe('dot');
    expect(decimalSeparator('$9.99')).toBe('dot');
  });

  it('tells two currencies apart', () => {
    expect(currencyMarker('£20')).toBe('£');
    expect(currencyMarker('USD 1500')).toBe('USD');
    expect(currencyMarker('hello')).toBeNull();
  });

  it('tells the two decimal conventions apart, which is the expensive one', () => {
    // 1.234,56 puts the comma where 1,234.56 puts the dot. Read either the wrong way round and the
    // amount is out by a factor of a thousand.
    expect(decimalSeparator('1.234,56')).toBe('comma');
    expect(decimalSeparator('1,234.56')).toBe('dot');
  });

  it('does not invent a convention for an amount with no fraction', () => {
    expect(decimalSeparator('$1,200')).toBeNull();
    expect(decimalSeparator('hello')).toBeNull();
  });
});

describe('decimal places, which is where money quietly loses value', () => {
  it('counts the fraction', () => {
    expect(decimalPlaces('1200')).toBe(0);
    expect(decimalPlaces('1200.5')).toBe(1);
    expect(decimalPlaces('$1,200.50')).toBe(2);
    expect(decimalPlaces('0.12345')).toBe(5);
  });

  it('does not mistake a thousands group for a fraction', () => {
    // 1.234 in a European export is one thousand two hundred and thirty-four, not 1.234.
    expect(decimalPlaces('1.234')).toBe(0);
  });

  it('is null for something with no number in it', () => {
    expect(decimalPlaces('not a number')).toBeNull();
  });
});
