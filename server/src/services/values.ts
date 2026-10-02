import { decimalsEqual } from '../../../shared/aggregates';
import { isLookupValue, type AttributeMeta, type FieldValue } from '../../../shared/metadata';

export type TransformResult = { ok: true; value: FieldValue } | { ok: false; error: string };

const round = (n: number, precision: number | null | undefined) =>
  precision == null ? n : Math.round(n * 10 ** precision) / 10 ** precision;

/** Converts a source column value into the representation expected by the target column. */
export function transformValue(
  source: AttributeMeta,
  target: AttributeMeta,
  value: FieldValue | undefined,
): TransformResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  switch (target.type) {
    case 'String':
    case 'Memo':
      if (typeof value === 'object') return { ok: false, error: `Cannot convert ${source.type} to text` };
      return { ok: true, value: String(value) };
    case 'Integer':
    case 'BigInt': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `Value is not a number` };
      return { ok: true, value: Math.round(n) };
    }
    case 'Decimal':
    case 'Money':
    case 'Double': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `Value is not a number` };
      return { ok: true, value: round(n, target.precision) };
    }
    case 'Boolean':
      if (typeof value !== 'boolean') return { ok: false, error: 'Value is not a boolean' };
      return { ok: true, value };
    case 'DateTime': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
        return { ok: false, error: 'Invalid date/time' };
      if (target.dateTimeBehavior === 'DateOnly') return { ok: true, value: value.slice(0, 10) };
      return { ok: true, value: new Date(value).toISOString() };
    }
    case 'Picklist':
    case 'State':
    case 'Status':
      if (typeof value !== 'number') return { ok: false, error: 'Choice value must be numeric' };
      return { ok: true, value };
    case 'MultiSelectPicklist':
      if (!Array.isArray(value)) return { ok: false, error: 'Multi-select value must be a list' };
      return { ok: true, value: [...value].sort((a, b) => a - b) };
    case 'Uniqueidentifier':
      return { ok: true, value: String(value).toLowerCase() };
    case 'Lookup':
    case 'Customer':
    case 'Owner':
      if (!isLookupValue(value)) return { ok: false, error: 'Lookup value expected' };
      return { ok: true, value };
    default:
      return { ok: true, value };
  }
}

/** Normalizes a value so formatting-only differences do not register as mismatches. */
export function normalizeForCompare(
  attr: AttributeMeta,
  value: FieldValue | undefined,
): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  switch (attr.type) {
    case 'String':
    case 'Memo': {
      const s = String(value).replace(/\r\n/g, '\n').trimEnd();
      return s === '' ? null : s;
    }
    case 'Integer':
    case 'BigInt':
    case 'Decimal':
    case 'Money':
    case 'Double':
    case 'Picklist':
    case 'State':
    case 'Status': {
      const n = Number(value);
      return Number.isFinite(n) ? round(n, decimalPlaces(attr) ?? 10) : String(value);
    }
    case 'Boolean': {
      /**
       * Not `Boolean(value)`.
       *
       * `Boolean('false')` is true, so a target returning a bit column as the text 'false' compared
       * equal to a source `true` — a difference reported as a match, which is the direction that
       * matters. The recognised spellings are the ones engines actually emit; anything else is
       * returned as text so two unrecognised values are compared literally rather than guessed at.
       */
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      const s = String(value).trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return true;
      if (FALSE_WORDS.has(s)) return false;
      return s;
    }
    case 'DateTime': {
      const s = String(value);
      if (attr.dateTimeBehavior === 'DateOnly') return s.slice(0, 10);
      const ms = Date.parse(s);
      return Number.isNaN(ms) ? s : new Date(Math.floor(ms / 1000) * 1000).toISOString();
    }
    case 'MultiSelectPicklist':
      return Array.isArray(value) ? [...value].sort((a, b) => a - b).join(',') : String(value);
    case 'Lookup':
    case 'Customer':
    case 'Owner':
    case 'Uniqueidentifier':
      return isLookupValue(value) ? value.id.toLowerCase() : String(value).toLowerCase();
    default:
      return typeof value === 'object' ? JSON.stringify(value) : value;
  }
}

/** Types whose values are exact, so two of them are equal or they are not. */
const EXACT_NUMERIC = new Set(['Integer', 'BigInt', 'Decimal', 'Money']);

export function valuesEqual(
  attr: AttributeMeta,
  a: FieldValue | undefined,
  b: FieldValue | undefined,
): boolean {
  /**
   * An exact column is compared exactly, when both sides give us the digits.
   *
   * Everything used to go through `Number`, which cannot hold a BIGINT near 2^53 or a wide decimal:
   * `9000000000000001` and `9000000000000000` compared equal. Drivers return those columns as strings
   * precisely so the digits survive, and `decimalsEqual` compares them as scaled integers.
   *
   * Only when both sides are strings. A number in hand has already lost whatever it was going to
   * lose, and routing it through here would imply a precision it does not have.
   */
  if (EXACT_NUMERIC.has(attr.type) && typeof a === 'string' && typeof b === 'string') {
    return decimalsEqual(a.trim() === '' ? null : a, b.trim() === '' ? null : b);
  }
  const na = normalizeForCompare(attr, a);
  const nb = normalizeForCompare(attr, b);
  if (typeof na === 'number' && typeof nb === 'number') {
    const places = decimalPlaces(attr);
    const tolerance = places != null ? 10 ** -places / 2 : 1e-9;
    return Math.abs(na - nb) <= tolerance;
  }
  return na === nb;
}

/**
 * How many decimal places the column actually holds.
 *
 * `precision` means two different things depending on where the metadata came from: for a Dataverse
 * money or decimal attribute it is the number of decimal places, and for a SQL column it is the total
 * number of digits with the places in `sql.scale`. Reading `precision` for a SQL `numeric(18,2)` gave
 * a tolerance of 10^-18 — so differences smaller than a hundredth, which that column cannot even
 * store, were reported as mismatches.
 */
function decimalPlaces(attr: AttributeMeta): number | null {
  return attr.sql?.scale ?? attr.precision ?? null;
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 't']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'f', '']);

const MAX_DISPLAY = 256;

/** Renders a value for reports, masking secured columns and truncating long text. */
export function displayValue(attr: AttributeMeta | undefined, value: FieldValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (attr?.isSecured) return '•••• (secured column)';
  let s: string;
  if (isLookupValue(value)) s = `${value.logicalName}(${value.id})`;
  else if (Array.isArray(value)) s = value.join(', ');
  else s = String(value);
  return s.length > MAX_DISPLAY ? `${s.slice(0, MAX_DISPLAY)}…` : s;
}
