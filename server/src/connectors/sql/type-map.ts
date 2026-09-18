/**
 * SQL Server / Azure SQL type knowledge.
 *
 * Two jobs, both pure:
 *  - normalize a SQL column type into the shared {@link AttributeType} vocabulary, so the rest of
 *    the platform never branches on `nvarchar` vs `varchar`;
 *  - classify and convert values *across* providers (SQL <-> Dataverse). The existing
 *    `services/type-compat.ts` answers the Dataverse-to-Dataverse question with a boolean
 *    `compatible`/`lossy` pair; across providers a third answer is needed — the migration can do
 *    it, but only after an explicit conversion step (parsing text, mapping a choice, resolving an
 *    identity). That is why this module returns a four-state status rather than reusing
 *    `Compatibility`. The words used here (widening, lossy, precision loss) are kept identical to
 *    `type-compat.ts` so reports read the same whichever engine produced them.
 */
import {
  isLookupValue,
  type AttributeMeta,
  type AttributeType,
  type FieldValue,
} from '../../../../shared/metadata';

export type CrossProviderStatus = 'COMPATIBLE' | 'CONVERSION_REQUIRED' | 'LOSSY' | 'INCOMPATIBLE';

export interface CrossProviderCompatibility {
  status: CrossProviderStatus;
  reason: string;
}

export type ConvertResult = { ok: true; value: FieldValue } | { ok: false; error: string };

const TEXT: ReadonlySet<AttributeType> = new Set(['String', 'Memo']);
const NUMERIC: ReadonlySet<AttributeType> = new Set(['Integer', 'BigInt', 'Decimal', 'Double', 'Money']);
const INTEGRAL: ReadonlySet<AttributeType> = new Set(['Integer', 'BigInt']);
const CHOICE: ReadonlySet<AttributeType> = new Set(['Picklist', 'MultiSelectPicklist', 'State', 'Status']);
const LOOKUP: ReadonlySet<AttributeType> = new Set(['Lookup', 'Customer', 'Owner']);

/**
 * Same widening table as `services/type-compat.ts`: a widening conversion keeps every value, a
 * narrowing one may not. Double is deliberately absent as a source — binary floating point cannot
 * be re-expressed exactly as decimal/money.
 */
const WIDENING: Record<string, readonly AttributeType[]> = {
  Integer: ['BigInt', 'Decimal', 'Double', 'Money'],
  BigInt: ['Decimal', 'Double'],
  Decimal: ['Double', 'Money'],
  Money: ['Decimal', 'Double'],
};

/**
 * `nvarchar(4000)` is the largest non-MAX unicode string; anything longer (or MAX) is multiline
 * text in Dataverse terms. 4000 is also the Dataverse String ceiling, so the boundary is the same
 * on both sides of a migration.
 */
export const MAX_STRING_LENGTH = 4000;

/**
 * Types a migration cannot move. Binary and spatial payloads have no neutral representation in the
 * shared model, and `rowversion`/`timestamp` is a per-database counter whose value is meaningless
 * anywhere else (it is also server-generated, so it could never be written).
 */
export const SQL_UNSUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'binary',
  'varbinary',
  'image',
  'geography',
  'geometry',
  'hierarchyid',
  'sql_variant',
  'timestamp',
  'rowversion',
]);

const UNICODE_TYPES: ReadonlySet<string> = new Set(['nchar', 'nvarchar', 'ntext']);

/** Integer ranges, used to detect overflow before the server rejects the row. */
const INTEGER_RANGES: Record<string, { min: number; max: number }> = {
  tinyint: { min: 0, max: 255 },
  smallint: { min: -32768, max: 32767 },
  int: { min: -2147483648, max: 2147483647 },
  // bigint's bounds exceed Number.MAX_SAFE_INTEGER; the safe-integer limit is the practical bound
  // for values that have already been through JSON/JavaScript, so that is what is reported.
  bigint: { min: -9007199254740991, max: 9007199254740991 },
};

const normalizeTypeName = (dataType: string) => dataType.trim().toLowerCase();

/**
 * `sys.columns.max_length` is a *byte* count: an `nvarchar(50)` reports 100. Everything above this
 * layer thinks in characters, so unicode lengths are halved here. -1 (MAX) is passed through.
 */
export function sqlCharLength(dataType: string, maxLength: number | null): number | null {
  if (maxLength == null) return null;
  if (maxLength === -1) return -1;
  return UNICODE_TYPES.has(normalizeTypeName(dataType)) ? Math.floor(maxLength / 2) : maxLength;
}

/** The integer bounds of a SQL type, or null when the type is not integral. */
export function sqlIntegerRange(dataType: string): { min: number; max: number } | null {
  return INTEGER_RANGES[normalizeTypeName(dataType)] ?? null;
}

/**
 * DateTime behavior for a SQL date/time type.
 *  - `date` carries no time at all -> DateOnly.
 *  - `datetimeoffset` carries an explicit offset, so it denotes an absolute instant -> UserLocal.
 *  - `datetime`/`datetime2`/`smalldatetime` have no zone; re-interpreting them in a user's time
 *    zone would silently shift every value, so they are TimeZoneIndependent.
 */
export function sqlDateTimeBehavior(dataType: string): string | null {
  switch (normalizeTypeName(dataType)) {
    case 'date':
      return 'DateOnly';
    case 'datetimeoffset':
      return 'UserLocal';
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
      return 'TimeZoneIndependent';
    default:
      return null;
  }
}

/** Normalizes a SQL column type into the shared attribute vocabulary. */
export function sqlToAttributeType(
  dataType: string,
  precision: number | null,
  scale: number | null,
  maxLength: number | null,
): AttributeType {
  const t = normalizeTypeName(dataType);
  switch (t) {
    case 'varchar':
    case 'nvarchar':
    case 'char':
    case 'nchar': {
      // maxLength is already in characters here; -1 means MAX (unbounded).
      if (maxLength == null) return 'String';
      if (maxLength === -1 || maxLength > MAX_STRING_LENGTH) return 'Memo';
      return 'String';
    }
    case 'text':
    case 'ntext':
    case 'xml':
      return 'Memo';
    case 'bit':
      return 'Boolean';
    case 'tinyint':
    case 'smallint':
    case 'int':
      return 'Integer';
    case 'bigint':
      return 'BigInt';
    case 'decimal':
    case 'numeric':
      // A zero-scale decimal is an integer in every practical sense, but it can hold up to 38
      // digits, so it stays Decimal rather than pretending to fit in a 32-bit Integer.
      return 'Decimal';
    case 'money':
    case 'smallmoney':
      return 'Money';
    case 'float':
    case 'real':
      return 'Double';
    case 'date':
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset':
      return 'DateTime';
    case 'uniqueidentifier':
      return 'Uniqueidentifier';
    default:
      // time, binary, varbinary, image, timestamp, rowversion, sql_variant, geography, geometry,
      // hierarchyid and any user-defined type: carried as Other so they survive discovery and are
      // reported honestly, even when they cannot be migrated.
      return 'Other';
  }
}

/** The raw SQL type behind an attribute, when it came from a SQL connector. */
const rawSqlType = (a: AttributeMeta): string => normalizeTypeName(a.sql?.dataType ?? a.rawType ?? '');

const isUnsupported = (a: AttributeMeta): boolean => SQL_UNSUPPORTED_TYPES.has(rawSqlType(a));

/** Text capacity in characters; null means unbounded (MAX / Memo / no declared length). */
function textCapacity(a: AttributeMeta): number | null {
  if (a.sql && a.sql.maxLength === -1) return null;
  if (a.maxLength == null || a.maxLength < 0) return null;
  return a.maxLength;
}

/** Decimal places the target column can keep. SQL reports `scale`; Dataverse calls it precision. */
const decimalScale = (a: AttributeMeta): number | null => a.sql?.scale ?? a.precision ?? null;

/**
 * Deterministic classification of a source column against a target column, across providers.
 *
 * The order of the rules matters: length- and precision-sensitive pairs are examined before the
 * "same type" shortcut, because `nvarchar(200) -> nvarchar(50)` and `decimal(18,4) -> decimal(9,2)`
 * are the same normalized type yet still lose data.
 */
export function classifyCrossProviderCompatibility(
  source: AttributeMeta,
  target: AttributeMeta,
): CrossProviderCompatibility {
  const s = source.type;
  const t = target.type;

  // 1. Unsupported payloads first: a binary/spatial column is unmovable whatever the target says,
  //    and `binary -> binary` would otherwise look like a perfect match.
  if (isUnsupported(source)) {
    return {
      status: 'INCOMPATIBLE',
      reason: `${source.sql?.dataType ?? source.rawType} columns carry provider-specific binary or spatial data that this migration cannot move`,
    };
  }
  if (isUnsupported(target)) {
    return {
      status: 'INCOMPATIBLE',
      reason: `the target column is ${target.sql?.dataType ?? target.rawType}, which cannot be written by a migration`,
    };
  }

  // 2. Text to text: only the capacity matters.
  if (TEXT.has(s) && TEXT.has(t)) {
    const from = textCapacity(source);
    const to = textCapacity(target);
    if (to != null && (from == null || from > to)) {
      return {
        status: 'LOSSY',
        reason: `values longer than ${to} characters will be truncated`,
      };
    }
    return { status: 'COMPATIBLE', reason: `text fits the target column` };
  }

  // 3. Number to number: widening keeps every value, narrowing does not.
  if (NUMERIC.has(s) && NUMERIC.has(t)) {
    if (s === t) {
      const fromScale = decimalScale(source);
      const toScale = decimalScale(target);
      const fromPrecision = source.sql?.precision ?? null;
      const toPrecision = target.sql?.precision ?? null;
      if (fromScale != null && toScale != null && toScale < fromScale) {
        return {
          status: 'LOSSY',
          reason: `the target keeps ${toScale} decimal places, the source has ${fromScale}`,
        };
      }
      if (fromPrecision != null && toPrecision != null && toPrecision < fromPrecision) {
        return {
          status: 'LOSSY',
          reason: `the target holds ${toPrecision} total digits, the source has ${fromPrecision}`,
        };
      }
      return { status: 'COMPATIBLE', reason: `both columns are ${s}` };
    }
    if (WIDENING[s]?.includes(t)) {
      return { status: 'COMPATIBLE', reason: `${s} widens to ${t} without loss` };
    }
    if (INTEGRAL.has(t)) {
      return {
        status: 'LOSSY',
        reason: INTEGRAL.has(s)
          ? `${s} values can overflow a ${t} column`
          : `${s} to ${t} drops the fractional part`,
      };
    }
    return { status: 'LOSSY', reason: `${s} to ${t} may lose precision` };
  }

  // 4. Same normalized type and nothing length-sensitive left to check.
  if (s === t) return { status: 'COMPATIBLE', reason: `both columns are ${s}` };

  // 5. Choices have no SQL equivalent: the numeric option value has to be produced by a mapping.
  if (CHOICE.has(t)) {
    return { status: 'CONVERSION_REQUIRED', reason: `a choice mapping is required to fill ${t}` };
  }

  // 6. Lookups are never copied verbatim: the target row's key is whatever the target provider
  //    generated for the migrated parent, which only the identity map knows.
  if (LOOKUP.has(t)) {
    if (s === 'Uniqueidentifier' || INTEGRAL.has(s) || s === 'String' || LOOKUP.has(s)) {
      return {
        status: 'CONVERSION_REQUIRED',
        reason: `the referenced key is resolved through the record identity map`,
      };
    }
    return { status: 'INCOMPATIBLE', reason: `${s} cannot identify a related record for a ${t}` };
  }

  // 7. Text into a scalar: parsing, which can fail per row.
  if (TEXT.has(s) && (NUMERIC.has(t) || t === 'Boolean' || t === 'DateTime' || t === 'Uniqueidentifier')) {
    return { status: 'CONVERSION_REQUIRED', reason: `text has to be parsed as ${t} for every row` };
  }

  // 8. bit <-> int is the classic SQL flag column.
  if ((s === 'Boolean' && INTEGRAL.has(t)) || (INTEGRAL.has(s) && t === 'Boolean')) {
    return { status: 'CONVERSION_REQUIRED', reason: `${s} is mapped onto ${t} as 0/1` };
  }

  // 9. Anything printable into text: a formatting step, never a failure.
  if (TEXT.has(t) && (NUMERIC.has(s) || s === 'Boolean' || s === 'DateTime' || s === 'Uniqueidentifier')) {
    return { status: 'CONVERSION_REQUIRED', reason: `${s} is formatted as text` };
  }

  return { status: 'INCOMPATIBLE', reason: `${s} cannot be converted to ${t}` };
}

const REQUIRED_LEVELS: ReadonlySet<string> = new Set(['ApplicationRequired', 'SystemRequired']);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BOOLEAN_WORDS: Record<string, boolean> = {
  true: true,
  false: false,
  t: true,
  f: false,
  yes: true,
  no: false,
  y: true,
  n: false,
  '1': true,
  '0': false,
};

/** Renders a value for an error message without dumping a whole memo field into a log. */
function show(value: FieldValue): string {
  if (value === null) return 'null';
  if (isLookupValue(value)) return `${value.logicalName}(${value.id})`;
  const s = Array.isArray(value) ? value.join(',') : String(value);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/**
 * JavaScript's date parser rolls impossible days over instead of failing: `2024-02-30` becomes
 * 1 March. Silently moving a value to a different day is exactly the kind of corruption this
 * module exists to prevent, so the calendar part of an ISO-like string is checked component by
 * component before parsing.
 */
function isRealCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return true; // Not an ISO date string; leave the verdict to Date.parse.
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function toNumber(value: FieldValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Number('') is 0, which would turn an empty cell into a real zero.
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Converts one value from a source column to its target representation.
 *
 * Never throws and never silently loses data: anything that would change the value beyond
 * formatting (truncation, rounding away non-zero digits, overflow) is returned as an error so the
 * row is reported rather than quietly corrupted.
 */
export function convertValue(value: FieldValue, source: AttributeMeta, target: AttributeMeta): ConvertResult {
  if (isUnsupported(source)) {
    return {
      ok: false,
      error: `${source.logicalName} is ${source.sql?.dataType ?? source.rawType}, which cannot be migrated`,
    };
  }

  if (value === null || value === undefined) {
    if (REQUIRED_LEVELS.has(target.requiredLevel)) {
      return { ok: false, error: 'target column is required but the source value is null' };
    }
    return { ok: true, value: null };
  }

  switch (target.type) {
    case 'String':
    case 'Memo': {
      if (isLookupValue(value)) {
        return { ok: false, error: `cannot write a lookup reference into text column ${target.logicalName}` };
      }
      // Only fixed-width `char`/`nchar` columns are de-padded: there, trailing spaces are storage
      // padding rather than data. Every other value is passed through exactly as it is, because
      // cleaning is the transformation pipeline's job and must be visible in the preview — a
      // converter that quietly trimmed would make " ACME " and "ACME" indistinguishable to the
      // user while still differing from what they configured.
      const raw = Array.isArray(value) ? value.join(',') : String(value);
      const fixedWidth = source.sql?.dataType === 'char' || source.sql?.dataType === 'nchar';
      const text = fixedWidth ? raw.replace(/\s+$/, '') : raw;
      const capacity = textCapacity(target);
      if (capacity != null && text.length > capacity) {
        return { ok: false, error: `value is ${text.length} characters, target allows ${capacity}` };
      }
      return { ok: true, value: text };
    }

    case 'Integer':
    case 'BigInt': {
      const n = toNumber(value);
      if (n === null) return { ok: false, error: `"${show(value)}" is not a numeric value` };
      if (!Number.isInteger(n)) {
        return {
          ok: false,
          error: `${n} has a fractional part that integer column ${target.logicalName} cannot store`,
        };
      }
      const min = target.minValue ?? null;
      const max = target.maxValue ?? null;
      if ((min != null && n < min) || (max != null && n > max)) {
        return {
          ok: false,
          error: `${n} is outside the range of ${target.logicalName} (${min ?? '-∞'} to ${max ?? '∞'})`,
        };
      }
      return { ok: true, value: n };
    }

    case 'Decimal':
    case 'Money':
    case 'Double': {
      const n = toNumber(value);
      if (n === null) return { ok: false, error: `"${show(value)}" is not a numeric value` };
      const scale = target.type === 'Double' ? null : decimalScale(target);
      if (scale != null && scale >= 0) {
        const factor = 10 ** scale;
        const rounded = Math.round(n * factor) / factor;
        // Rounding is only an error when it destroys a non-zero digit: 1.50 -> 1.5 is the same
        // number, 1.555 -> 1.56 is not. The tolerance absorbs binary floating point noise.
        if (Math.abs(rounded - n) > 1e-9 * Math.max(1, Math.abs(n))) {
          return {
            ok: false,
            error: `${n} needs more than ${scale} decimal places, which ${target.logicalName} cannot store`,
          };
        }
        return { ok: true, value: rounded };
      }
      return { ok: true, value: n };
    }

    case 'Boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (typeof value === 'number') {
        if (value === 0 || value === 1) return { ok: true, value: value === 1 };
        return { ok: false, error: `${value} is not a boolean value (expected 0 or 1)` };
      }
      if (typeof value === 'string') {
        const word = BOOLEAN_WORDS[value.trim().toLowerCase()];
        if (word !== undefined) return { ok: true, value: word };
      }
      return { ok: false, error: `"${show(value)}" is not a boolean value` };
    }

    case 'DateTime': {
      if (typeof value !== 'string' && typeof value !== 'number') {
        return { ok: false, error: `"${show(value)}" is not a valid date` };
      }
      const raw = typeof value === 'number' ? value : value.trim();
      if (typeof raw === 'string' && !isRealCalendarDate(raw)) {
        return { ok: false, error: `"${show(value)}" is not a valid date` };
      }
      const ms = typeof raw === 'number' ? raw : Date.parse(raw);
      if (Number.isNaN(ms)) return { ok: false, error: `"${show(value)}" is not a valid date` };
      const iso = new Date(ms).toISOString();
      // A DateOnly target must not carry a time component, otherwise the stored day can shift.
      return { ok: true, value: target.dateTimeBehavior === 'DateOnly' ? iso.slice(0, 10) : iso };
    }

    case 'Uniqueidentifier': {
      const raw = isLookupValue(value) ? value.id : String(value);
      const guid = raw.trim().replace(/^\{|\}$/g, '');
      if (!GUID_RE.test(guid)) return { ok: false, error: `"${show(value)}" is not a valid GUID` };
      // Lowercase everywhere so an identity map keyed on the value never misses on casing.
      return { ok: true, value: guid.toLowerCase() };
    }

    case 'Lookup':
    case 'Customer':
    case 'Owner': {
      if (isLookupValue(value)) return { ok: true, value };
      const targets = target.targets ?? [];
      if (targets.length !== 1) {
        return {
          ok: false,
          error: `${target.logicalName} references ${targets.length} tables, so the target table cannot be inferred`,
        };
      }
      const guid = String(value)
        .trim()
        .replace(/^\{|\}$/g, '');
      if (!GUID_RE.test(guid)) {
        return { ok: false, error: `"${show(value)}" is not a record identifier for ${targets[0]}` };
      }
      return { ok: true, value: { id: guid.toLowerCase(), logicalName: targets[0] } };
    }

    case 'Picklist':
    case 'State':
    case 'Status': {
      const n = toNumber(value);
      if (n === null || !Number.isInteger(n)) {
        return { ok: false, error: `a choice mapping is required to convert "${show(value)}"` };
      }
      return { ok: true, value: n };
    }

    case 'MultiSelectPicklist': {
      if (Array.isArray(value)) return { ok: true, value: [...value].sort((a, b) => a - b) };
      if (typeof value === 'string') {
        const parts = value
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p !== '');
        const numbers = parts.map((p) => Number(p));
        if (numbers.every((n) => Number.isInteger(n))) {
          return { ok: true, value: numbers.sort((a, b) => a - b) };
        }
      }
      return { ok: false, error: `a choice mapping is required to convert "${show(value)}"` };
    }

    default:
      // 'Other' and friends: pass the value through untouched rather than inventing a shape.
      return { ok: true, value };
  }
}
