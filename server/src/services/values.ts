import { decimalsEqual } from '../../../shared/aggregates';
import { compareJsonText } from '../../../shared/json-compare';
import { familyOf, isLookupValue, type AttributeMeta, type FieldValue } from '../../../shared/metadata';

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
       * matters. The recognized spellings are the ones engines actually emit; anything else is
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

/** The types that hold text, and therefore have an empty value distinct from no value. */
const TEXT_TYPES = new Set(['String', 'Memo']);

/**
 * Whether an empty string and NULL are the same value in this column.
 *
 * They are in Dataverse, which stores one as the other: a record saved with an empty text field comes
 * back with null, so calling them different would report a mismatch on data the platform itself made
 * identical. They are two values in a SQL column, and in a file, and treating them as equal there
 * reported a lost value as a match — a column whose text the migration failed to write read as
 * correct, which is the direction that matters.
 *
 * Stated per column rather than globally, and reported with the result: see `ComparisonRulesDto`.
 * `docs/SEMANTIC_EQUALITY.md` records it as a platform semantic, which is the only kind of
 * normalisation a comparison is allowed to apply without a configured rule.
 */
export function emptyEqualsNull(attr: AttributeMeta): boolean {
  return familyOf(attr) === 'DATAVERSE';
}

/**
 * Three answers, not two.
 *
 * `valuesEqual` could only say equal or different, so a column the platform cannot honestly compare
 * had to be called one of them — and calling it equal is a silent false pass. JSON with a repeated
 * key, or a binary value too large to read, is genuinely unknown, and a report that says so is worth
 * more than a report that guesses.
 */
export type ComparisonVerdict = 'EQUAL' | 'DIFFERENT' | 'NOT_COMPARABLE';

export interface ValueComparison {
  verdict: ComparisonVerdict;
  /** Why the answer is unknown, in words a report can print. Present only for NOT_COMPARABLE. */
  reason?: string;
}

/** The SQL types that hold a JSON document, and are therefore compared as one. */
const JSON_SQL_TYPES = new Set(['json', 'jsonb']);

/** The SQL types that hold bytes. Dataverse says so through the attribute type instead. */
const BINARY_SQL_TYPES = /^(var)?binary$|^bytea$|^(tiny|medium|long)?blob$|^image$|^raw$/i;

/**
 * How many bytes of a binary value will be compared.
 *
 * Past this the answer is NOT_COMPARABLE rather than a comparison that reads an arbitrary amount of
 * data into memory to answer one question about one field.
 */
export const MAX_BINARY_COMPARE_BYTES = 8 * 1024 * 1024;

/**
 * Whether this column holds a JSON document.
 *
 * Only when the *target* column says so. Comparison is in the target's terms, so a `jsonb` source
 * column migrated into a Dataverse Memo is text now, and comparing it as text is correct: text is
 * what somebody will read in that column in five years.
 */
function isJsonColumn(attr: AttributeMeta): boolean {
  return JSON_SQL_TYPES.has((attr.sql?.dataType ?? '').toLowerCase());
}

function isBinaryColumn(attr: AttributeMeta): boolean {
  return attr.type === 'File' || attr.type === 'Image' || BINARY_SQL_TYPES.test(attr.sql?.dataType ?? '');
}

/** The document as text. An object means the driver parsed it; see the note in `compareValues`. */
function jsonText(value: FieldValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

type Bytes = { bytes: Uint8Array } | { unavailable: string };

const HEX_BYTEA = /^\\x[0-9a-f]*$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The bytes of a binary value, when they can be had cheaply and within the limit.
 *
 * Connectors hand binary back in several shapes: a Buffer from most drivers, base64 text from
 * Dataverse and from JSON transports, and PostgreSQL's hex form when bytea is read as text.
 */
function binaryBytes(value: FieldValue): Bytes {
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_BINARY_COMPARE_BYTES) {
      return {
        unavailable: `the value is ${value.byteLength} bytes, past the ${MAX_BINARY_COMPARE_BYTES}-byte comparison limit`,
      };
    }
    return { bytes: value };
  }
  if (typeof value === 'string') {
    if (value.length / 2 > MAX_BINARY_COMPARE_BYTES) {
      return { unavailable: `the encoded value is ${value.length} characters, past the comparison limit` };
    }
    if (HEX_BYTEA.test(value)) {
      const hex = value.slice(2);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return { bytes: out };
    }
    if (BASE64.test(value) && value.length % 4 === 0) {
      return { bytes: Uint8Array.from(Buffer.from(value, 'base64')) };
    }
    return { unavailable: 'the value is text in a form this platform does not recognize as bytes' };
  }
  return { unavailable: `a ${typeof value} is not a binary value this platform can read` };
}

/**
 * Compares two binary values byte for byte, within the limit.
 *
 * Byte equality rather than a digest, deliberately. A digest is how you compare bytes you do not both
 * have — across a network, or against something recorded earlier. Both values are already in hand
 * here, so hashing them would be strictly more work for exactly the same answer, and would introduce
 * a collision the comparison does not need to have.
 */
function compareBinary(a: FieldValue, b: FieldValue): ValueComparison {
  const left = binaryBytes(a);
  const right = binaryBytes(b);
  if ('unavailable' in left) return { verdict: 'NOT_COMPARABLE', reason: left.unavailable };
  if ('unavailable' in right) return { verdict: 'NOT_COMPARABLE', reason: right.unavailable };
  // A length difference is provable without looking further, and is what a truncation looks like.
  if (left.bytes.byteLength !== right.bytes.byteLength) return { verdict: 'DIFFERENT' };
  for (let i = 0; i < left.bytes.byteLength; i++) {
    if (left.bytes[i] !== right.bytes[i]) return { verdict: 'DIFFERENT' };
  }
  return { verdict: 'EQUAL' };
}

/**
 * Compares a source value, already put into the target's terms, against the target value.
 *
 * A note on JSON that the type system cannot express: when a driver returns a `jsonb` column as a
 * parsed object rather than as text, duplicate keys have already been collapsed and long numbers have
 * already been through a double — before this platform sees anything. Nothing here can recover that,
 * exactly as nothing can recover a BIGINT that arrived as a JavaScript number.
 * `docs/SEMANTIC_EQUALITY.md` records it as a limitation rather than implying the check was stronger
 * than it was.
 */
export function compareValues(
  attr: AttributeMeta,
  a: FieldValue | undefined,
  b: FieldValue | undefined,
): ValueComparison {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;

  if (isJsonColumn(attr)) {
    // An absent document and a present one are different, and so is JSON's own `null`.
    if (aEmpty || bEmpty) return { verdict: aEmpty === bEmpty ? 'EQUAL' : 'DIFFERENT' };
    return compareJsonText(jsonText(a), jsonText(b));
  }

  if (isBinaryColumn(attr)) {
    if (aEmpty || bEmpty) return { verdict: aEmpty === bEmpty ? 'EQUAL' : 'DIFFERENT' };
    return compareBinary(a, b);
  }

  return { verdict: valuesEqualScalar(attr, a, b) ? 'EQUAL' : 'DIFFERENT' };
}

/**
 * Equal or not, for everything else.
 *
 * NOT_COMPARABLE collapses to "not equal" here, which is the safe direction for the caller that uses
 * it: the record planner, deciding whether a record is unchanged. A field it cannot verify is a field
 * it should write rather than skip.
 */
export function valuesEqual(
  attr: AttributeMeta,
  a: FieldValue | undefined,
  b: FieldValue | undefined,
): boolean {
  return compareValues(attr, a, b).verdict === 'EQUAL';
}

function valuesEqualScalar(
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
  /**
   * An empty text value is not the absence of one, except where the platform makes it so.
   *
   * Checked before normalising, because normalising is what loses the distinction: it maps `''` to
   * null so that a padded CHAR column compares equal to an unpadded one. That is right within text
   * and wrong across the boundary to NULL, so the boundary is decided here. See `emptyEqualsNull`.
   */
  if (TEXT_TYPES.has(attr.type) && !emptyEqualsNull(attr)) {
    const aAbsent = a === null || a === undefined;
    const bAbsent = b === null || b === undefined;
    if (aAbsent !== bAbsent) return false;
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
