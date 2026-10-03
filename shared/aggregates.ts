import type { AttributeMeta } from './metadata';

/**
 * Totals compared across the two sides, as supplementary evidence.
 *
 * Record-level validation is the real check and this is not a substitute for it. Two tables can
 * agree on every total and disagree on every row: swap two customers' balances and the sum is
 * identical. What aggregates buy is reach — a hundred million rows can be summed when they cannot
 * be compared one at a time — so the right framing is "nothing here contradicts the migration",
 * never "the migration is correct".
 *
 * The product says so in those words wherever a result is shown, because an aggregate PASS is the
 * easiest number in the whole system to over-read.
 *
 * Only checks that are defensible across engines are offered. The list of what is deliberately
 * absent is as important as the list of what is here, and both are below.
 */

export type AggregateKind = 'COUNT' | 'SUM' | 'MIN' | 'MAX';
export type AggregateOutcome = 'PASS' | 'FAIL' | 'NOT_VERIFIED';

export interface AggregateCheck {
  kind: AggregateKind;
  /** The table, as the product names it. */
  entity: string;
  /** Null for COUNT, which is about rows rather than a column. */
  column: string | null;
  /** What the source side reported. Null when it could not be read. */
  sourceValue: string | null;
  /** What the target side reported, over the records this run is responsible for. */
  targetValue: string | null;
  outcome: AggregateOutcome;
  /** What the figures cover, said plainly, because scope is where this check goes wrong. */
  scope: string;
  /** Why, in a sentence somebody can act on. */
  reason: string;
}

/**
 * Whether a column can be summed in a way that means the same thing on both sides.
 *
 * Integers and fixed-point decimals, and nothing else. The exclusions are the point:
 *
 * - **Floating point** (Double) is excluded because addition is not associative in binary floating
 *   point. Two engines summing identical values in a different row order produce different totals,
 *   so a mismatch would mean nothing and a match would be luck.
 * - **Dates** are excluded because a sum of dates is not a quantity.
 * - **Choices, lookups and booleans** are excluded because their numeric representation is an
 *   identifier, not an amount. Summing status codes produces a number with no meaning.
 */
export function canSum(attr: AttributeMeta): boolean {
  return ['Integer', 'BigInt', 'Decimal', 'Money'].includes(attr.type);
}

/**
 * Whether a column has a minimum and maximum that compare across engines.
 *
 * Numbers and timestamps, which are ordered the same way everywhere. Two exclusions:
 *
 * - **Text**: MIN over strings depends on collation, and two engines with different collations
 *   disagree about which value is smallest without either being wrong.
 * - **Date-only columns**: the engine returns an instant, the column means a calendar day, and
 *   turning one into the other depends on a timezone neither side declares. A source reporting
 *   `2024-05-31 17:00-07` and a target reporting `2024-06-01 00:00-07` hold the same day and
 *   different instants, so an extreme comparison contradicts the record-level comparison — which
 *   applies the date-only rule properly and is the authority here.
 */
export function canCompareExtremes(attr: AttributeMeta): boolean {
  if (attr.type === 'DateTime') return attr.dateTimeBehavior !== 'DateOnly';
  return ['Integer', 'BigInt', 'Decimal', 'Money'].includes(attr.type);
}

/** Why a column was skipped, for a report that says what it did not check and why. */
export function whyNotAggregatable(attr: AttributeMeta): string | null {
  if (canSum(attr) || canCompareExtremes(attr)) return null;
  switch (attr.type) {
    case 'Double':
      return 'floating point: addition depends on row order, so totals are not comparable';
    case 'DateTime':
      return 'a date without a time: the engine reports an instant, and which day that is depends on a timezone neither side declares';
    case 'String':
    case 'Memo':
      return 'text: ordering depends on collation, which differs between engines';
    case 'Boolean':
    case 'Picklist':
    case 'State':
    case 'Status':
      return 'the numeric form is an identifier, not an amount';
    case 'Lookup':
    case 'Customer':
    case 'Owner':
    case 'Uniqueidentifier':
      return 'an identifier has no total';
    default:
      return `no defensible aggregate for ${attr.type}`;
  }
}

/**
 * Compares two exact numeric strings without going through a float.
 *
 * `Number('12345678901234567890.1234')` loses digits, and a reconciliation that quietly rounds is
 * worse than one that refuses. Decimals are compared as scaled integers, which is exact for every
 * value either engine can store in a fixed-point column.
 */
export function decimalsEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = normaliseDecimal(a);
  const right = normaliseDecimal(b);
  if (!left || !right) return a.trim() === b.trim();
  const scale = Math.max(left.scale, right.scale);
  return scaleTo(left, scale) === scaleTo(right, scale);
}

interface ParsedDecimal {
  negative: boolean;
  digits: string;
  scale: number;
}

function normaliseDecimal(raw: string): ParsedDecimal | null {
  const text = raw.trim();
  if (!/^[+-]?\d*(\.\d*)?$/.test(text) || text === '' || text === '.') return null;
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole = '', fraction = ''] = unsigned.split('.');
  return { negative, digits: `${whole}${fraction}` || '0', scale: fraction.length };
}

function scaleTo(value: ParsedDecimal, scale: number): bigint {
  const padded = value.digits + '0'.repeat(scale - value.scale);
  const magnitude = BigInt(padded === '' ? '0' : padded);
  return value.negative ? -magnitude : magnitude;
}

/**
 * Rounds an exact numeric string to a given number of decimal places, without a float.
 *
 * Half away from zero, applied identically to both sides of a comparison, so the rule itself cannot
 * decide an outcome. Returns null for anything that is not a number, which the caller treats as
 * "compare these literally" rather than as zero.
 */
export function roundDecimal(value: string, scale: number): string | null {
  const parsed = normaliseDecimal(value);
  if (!parsed || scale < 0) return null;
  const magnitude = BigInt(parsed.digits || '0');
  let scaled: bigint;
  if (parsed.scale <= scale) {
    scaled = magnitude * 10n ** BigInt(scale - parsed.scale);
  } else {
    const divisor = 10n ** BigInt(parsed.scale - scale);
    const quotient = magnitude / divisor;
    scaled = (magnitude % divisor) * 2n >= divisor ? quotient + 1n : quotient;
  }
  const digits = scaled.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  const body = `${whole}${fraction}`;
  // -0 and 0 are the same number, so a sign with nothing behind it is dropped.
  return parsed.negative && /[1-9]/.test(body) ? `-${body}` : body;
}

/** How to compare two totals of the same kind: what they are, and how exact the column is. */
export interface TotalComparison {
  /** Compare as instants rather than as text. */
  temporal?: boolean;
  /**
   * The column's declared decimal places, when it has them.
   *
   * A Money(2) column cannot hold a third decimal, so digits beyond the second in a SUM are an
   * artifact of how the values were stored and read on the way to the total, not data. Comparing at
   * full accumulated precision compares that noise: one side reporting 30024889.949999999985 and the
   * other 30024889.95 is one number, and reporting it as a failed migration is a false alarm that
   * teaches people to ignore the check. Rounding to the declared scale cannot hide a real
   * difference, because a difference smaller than the scale cannot exist in the column.
   */
  scale?: number | null;
}

/**
 * Compares two aggregate values of the same kind, by what they mean rather than by how they print.
 *
 * Timestamps are compared as instants, because two engines render the same moment differently —
 * `2025-01-15 03:00:00-07` and `2025-01-15T10:00:00Z` are one value, and a text comparison would
 * report a migration failure that is really a formatting difference. Numbers are compared as exact
 * decimals, at the column's declared scale where it has one. Anything neither side could parse falls
 * back to a literal comparison rather than guessing.
 */
export function totalsEqual(left: string | null, right: string | null, how: TotalComparison = {}): boolean {
  if (how.temporal) {
    if (left === null || right === null) return left === right;
    const a = Date.parse(left.trim());
    const b = Date.parse(right.trim());
    if (Number.isNaN(a) || Number.isNaN(b)) return left.trim() === right.trim();
    return a === b;
  }
  if (how.scale !== null && how.scale !== undefined && left !== null && right !== null) {
    const a = roundDecimal(left, how.scale);
    const b = roundDecimal(right, how.scale);
    if (a !== null && b !== null) return a === b;
  }
  return decimalsEqual(left, right);
}

/** The sentence every aggregate result carries, so a PASS is never read as a proof. */
export const AGGREGATE_CAVEAT =
  'Aggregate reconciliation is supplementary evidence. Totals agreeing does not prove the records agree — two tables can share every total and differ in every row — and it is offered for tables too large to compare one record at a time.';
