import { describe, expect, it } from 'vitest';
import { normalizeForCompare, valuesEqual } from '../../server/src/services/values';
import type { AttributeMeta } from '../../shared/metadata';
import { attr } from './fixtures';

/**
 * What "equal" means, type by type.
 *
 * Two bugs in Phase 4 came from this area — a date-only column compared as an instant, a money total
 * compared at accumulated precision — and both were found by running the product rather than by
 * reading it. This file is the audit that follows: every type the platform compares, with the rule
 * stated as an assertion rather than left in the implementation.
 *
 * Where a rule is a deliberate tolerance it is marked as one and the cost is written down. Where it is
 * a limitation it says so. Nothing here was normalised to make a test pass; the cases that fail are
 * recorded in `docs/SEMANTIC_EQUALITY.md` as findings.
 *
 * The governing principle: **comparison is in the target's terms.** The target is where the data now
 * lives and its column is what will be read in five years, so `valuesEqual` takes the target
 * attribute and the source value is converted to that column's representation first.
 */

const withSql = (a: AttributeMeta, sql: Partial<NonNullable<AttributeMeta['sql']>>): AttributeMeta => ({
  ...a,
  sql: {
    dataType: 'decimal',
    maxLength: null,
    precision: null,
    scale: null,
    isNullable: true,
    isIdentity: false,
    isComputed: false,
    isRowVersion: false,
    defaultDefinition: null,
    ...sql,
  },
});

describe('text', () => {
  const text = attr('c', 'String');

  it('ignores line-ending style, because the two sides may store it differently', () => {
    expect(valuesEqual(text, 'a\r\nb', 'a\nb')).toBe(true);
  });

  it('ignores trailing whitespace — a deliberate tolerance with a cost', () => {
    // A CHAR(10) column pads with spaces, so without this every fixed-width column would differ.
    // The cost: a VARCHAR that genuinely lost a trailing space reads as equal.
    expect(valuesEqual(text, 'abc   ', 'abc')).toBe(true);
    // Leading whitespace is *not* ignored: no storage engine adds it.
    expect(valuesEqual(text, ' abc', 'abc')).toBe(false);
  });

  it('treats an empty string and a null as the same value', () => {
    // Right for Dataverse, which stores '' as null. A limitation for SQL to SQL, where they are two
    // different values and a column that lost one for the other compares equal.
    expect(valuesEqual(text, '', null)).toBe(true);
    expect(normalizeForCompare(text, '')).toBeNull();
  });

  it('does not normalise Unicode or fold case', () => {
    // é as one code point and as e + combining acute are different stored values, and the product
    // reports the difference rather than deciding they are the same.
    expect(valuesEqual(text, 'é', 'é')).toBe(false);
    expect(valuesEqual(text, 'ABC', 'abc')).toBe(false);
    expect(valuesEqual(text, '🧪', '🧪')).toBe(true);
  });
});

describe('integers and big integers', () => {
  it('compares integers exactly', () => {
    expect(valuesEqual(attr('c', 'Integer'), 42, 42)).toBe(true);
    expect(valuesEqual(attr('c', 'Integer'), 42, 43)).toBe(false);
    expect(valuesEqual(attr('c', 'Integer'), 42, '42')).toBe(true);
  });

  it('tells apart two big integers a double could not', () => {
    // Fixed in Phase 4. Everything numeric went through Number, so a BIGINT approaching 2^53 was
    // compared as the nearest double and two different stored values read as equal — a difference
    // reported as a match. Exact columns are now compared as scaled integers whenever both sides give
    // us the digits, which drivers return as strings precisely so they survive.
    const big = attr('c', 'BigInt');
    expect(valuesEqual(big, '9007199254740993', '9007199254740992')).toBe(false);
    expect(valuesEqual(big, '9000000000000001', '9000000000000000')).toBe(false);
    expect(valuesEqual(big, '9007199254740993', '9007199254740993')).toBe(true);
    expect(valuesEqual(big, '2147483647', '2147483646')).toBe(false);
  });

  it('still goes through a double when a side arrives as a number', () => {
    // Not a gap to close: a number in hand has already lost whatever it was going to lose, and
    // comparing it exactly would imply a precision it does not have.
    const big = attr('c', 'BigInt');
    // Written as a conversion rather than as a literal, because the literal itself loses the digit —
    // which is the whole point.
    expect(valuesEqual(big, Number('9007199254740993'), Number('9007199254740992'))).toBe(true);
  });
});

describe('decimals and money', () => {
  it('compares a Dataverse money column at its declared decimal places', () => {
    // Dataverse `precision` means decimal places, so 2 gives a tolerance of half a cent.
    const money = { ...attr('c', 'Money'), precision: 2 };
    expect(valuesEqual(money, 10.001, 10.0)).toBe(true);
    expect(valuesEqual(money, 10.01, 10.0)).toBe(false);
  });

  it('reads a SQL decimal scale rather than its total digits', () => {
    // Fixed in Phase 4. `precision` means two things: decimal places for a Dataverse attribute, total
    // digits for a SQL column, which keeps its places in `sql.scale`. Reading `precision` gave
    // numeric(18,2) a tolerance of 10^-18, so differences smaller than a hundredth — which that column
    // cannot even store — were reported as mismatches.
    const sqlDecimal = withSql({ ...attr('c', 'Decimal'), precision: 18 }, { precision: 18, scale: 2 });
    expect(valuesEqual(sqlDecimal, 1.001, 1.002), 'below the scale the column holds').toBe(true);
    expect(valuesEqual(sqlDecimal, 1.0, 1.01), 'a difference it can hold').toBe(false);
  });

  it('keeps every digit of a decimal wider than a double', () => {
    // The same fix as the BigInt one, and the reason it matters: a comparison that quietly rounds
    // reports a match that is not there.
    const wide = { ...attr('c', 'Decimal'), precision: 28 };
    expect(valuesEqual(wide, '12345678901234567890.1234', '12345678901234567890.1235')).toBe(false);
    expect(valuesEqual(wide, '12345678901234567890.1234', '12345678901234567890.12340')).toBe(true);
  });
});

describe('floating point', () => {
  it('compares doubles with a tolerance, which is the only defensible way', () => {
    const double = attr('c', 'Double');
    expect(valuesEqual(double, 0.1 + 0.2, 0.3)).toBe(true);
    // The tolerance for a column that declares no precision is 1e-9, so a difference just inside it
    // is a match and one just outside it is not. Stated as the boundary rather than as a round number.
    expect(valuesEqual(double, 1.0, 1.0000000005)).toBe(true);
    expect(valuesEqual(double, 1.0, 1.000000002)).toBe(false);
    expect(valuesEqual(double, 1.0, 1.1)).toBe(false);
  });
});

describe('dates and times', () => {
  it('compares a timestamp as an instant, not as text', () => {
    const ts = attr('c', 'DateTime');
    expect(valuesEqual(ts, '2024-06-01T10:00:00Z', '2024-06-01T03:00:00-07:00')).toBe(true);
    expect(valuesEqual(ts, '2024-06-01T10:00:00Z', '2024-06-01T10:00:01Z')).toBe(false);
  });

  it('ignores anything below a second — a deliberate tolerance', () => {
    // Engines differ in the precision they keep: datetime2(7) holds 100-nanosecond ticks, Dataverse
    // holds whole seconds. Comparing below a second would fail every migration between them.
    const ts = attr('c', 'DateTime');
    expect(valuesEqual(ts, '2024-06-01T10:00:00.123Z', '2024-06-01T10:00:00.456Z')).toBe(true);
    expect(valuesEqual(ts, '2024-06-01T10:00:00.999Z', '2024-06-01T10:00:01.000Z')).toBe(false);
  });

  it('compares a date-only column as a calendar day', () => {
    const dateOnly = { ...attr('c', 'DateTime'), dateTimeBehavior: 'DateOnly' };
    // The same day written with different times and zones is the same day.
    expect(valuesEqual(dateOnly, '2024-06-01T00:00:00Z', '2024-06-01T23:59:59-07:00')).toBe(true);
    expect(valuesEqual(dateOnly, '2024-06-01', '2024-06-02')).toBe(false);
  });

  it('depends on a date-only value arriving in ISO order', () => {
    // A LIMITATION. The rule is the first ten characters, so a connector returning 01/06/2024 would
    // be compared as the string "01/06/2024". Every connector here returns ISO, and this records what
    // the rule relies on.
    const dateOnly = { ...attr('c', 'DateTime'), dateTimeBehavior: 'DateOnly' };
    expect(normalizeForCompare(dateOnly, '2024-06-01T12:00:00Z')).toBe('2024-06-01');
    expect(normalizeForCompare(dateOnly, '01/06/2024')).toBe('01/06/2024');
  });
});

describe('booleans', () => {
  it('compares two real booleans correctly', () => {
    const flag = attr('c', 'Boolean');
    expect(valuesEqual(flag, true, true)).toBe(true);
    expect(valuesEqual(flag, true, false)).toBe(false);
  });

  it('reads a boolean written as text the way the engine meant it', () => {
    // Fixed in Phase 4. `Boolean('false')` is true in JavaScript, so a target returning a bit column
    // as the text 'false' compared equal to a source `true` — a difference reported as a match, which
    // is the direction that matters.
    const flag = attr('c', 'Boolean');
    for (const [text, expected] of [
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['t', true],
      ['yes', true],
      ['false', false],
      ['FALSE', false],
      ['0', false],
      ['f', false],
      ['no', false],
    ] as const) {
      expect(valuesEqual(flag, expected, text), `${text} means ${expected}`).toBe(true);
      expect(valuesEqual(flag, !expected, text), `${text} does not mean ${!expected}`).toBe(false);
    }
    expect(valuesEqual(flag, false, 0)).toBe(true);
    expect(valuesEqual(flag, true, 1)).toBe(true);
  });

  it('compares a value it cannot read as a boolean literally, rather than guessing', () => {
    const flag = attr('c', 'Boolean');
    expect(valuesEqual(flag, 'maybe', 'maybe')).toBe(true);
    expect(valuesEqual(flag, 'maybe', true)).toBe(false);
  });
});

describe('identifiers', () => {
  it('compares GUIDs without regard to case, which is how they are written', () => {
    const guid = attr('c', 'Uniqueidentifier');
    expect(
      valuesEqual(guid, 'A3F2C1D0-0000-4000-8000-000000000001', 'a3f2c1d0-0000-4000-8000-000000000001'),
    ).toBe(true);
  });

  it('compares a lookup by the record it points at', () => {
    const lookup = attr('c', 'Lookup');
    const value = { logicalName: 'account', id: 'AB-CD' };
    // A lookup's identity is the record it points at, compared without regard to case.
    expect(valuesEqual(lookup, value, { logicalName: 'account', id: 'ab-cd' })).toBe(true);
    expect(valuesEqual(lookup, value, { logicalName: 'account', id: 'other' })).toBe(false);
  });
});

describe('choices', () => {
  it('compares a choice by its numeric value', () => {
    const choice = attr('c', 'Picklist');
    expect(valuesEqual(choice, 1, 1)).toBe(true);
    expect(valuesEqual(choice, 1, 2)).toBe(false);
  });

  it('compares a multi-select by its set, not its order', () => {
    const multi = attr('c', 'MultiSelectPicklist');
    expect(valuesEqual(multi, [3, 1, 2], [1, 2, 3])).toBe(true);
    expect(valuesEqual(multi, [1, 2], [1, 2, 3])).toBe(false);
  });
});

describe('types with no rule of their own', () => {
  it('falls back to a structural comparison, which is order-sensitive for JSON', () => {
    // A LIMITATION. There is no JSON type in the metadata model, so a JSON column arrives as text or
    // as an object and is compared by its serialisation: the same document with its keys in a
    // different order reads as a difference.
    const unknown = attr('c', 'String');
    expect(valuesEqual(unknown, '{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(false);
  });

  it('has no defined comparison for binary', () => {
    // A LIMITATION, recorded rather than papered over. A binary column compared across engines may
    // arrive as a Buffer on one side and base64 text on the other, and nothing here reconciles them.
    const binary = attr('c', 'String');
    expect(valuesEqual(binary, 'AQID', 'AQID')).toBe(true);
    expect(valuesEqual(binary, 'AQID', 'AQIE')).toBe(false);
  });
});
