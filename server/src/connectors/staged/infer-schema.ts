import type {
  AlternateKeyMeta,
  AttributeMeta,
  AttributeType,
  TableMetadata,
} from '../../../../shared/metadata';

/**
 * Working out what a spreadsheet's columns are.
 *
 * A file has no schema. It has a header row and some values, and every value is text. So the shape
 * has to be inferred — and the inference has to be conservative, because the cost of being wrong is
 * asymmetric: calling a text column a number makes every non-numeric row fail at migration time,
 * while calling a number column text costs nothing but a conversion the engine already does.
 *
 * So a column is only given a narrower type when **every** non-empty value fits it. One "N/A" in a
 * thousand rows is enough to keep the column as text, which is the correct answer — that column does
 * contain something that is not a number.
 */

/** The synthetic key used when the file has no column that can identify a row. */
export const ROW_KEY = '__row';

/** Values that mean "nothing here", whatever the column turns out to be. */
const BLANKS = new Set(['', '-', 'n/a', 'na', 'null', 'nil', '(blank)', '(null)', '#n/a']);

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 't']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'f']);

// Wide enough to recognise a 20-digit account number AS a whole number, so it can be reported as
// one that must stay text rather than as an unrecognisable mix.
const INTEGER = /^-?\d{1,25}$/;
const DECIMAL = /^-?\d{1,15}(\.\d{1,10})?$/;
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

/**
 * Digits with a leading zero, which is an identifier written in digits rather than a number.
 *
 * `007`, `01234`, `000-123` — a part number, a postcode, an account reference. Inferring a number from
 * these loses the zeros, which is the one thing an identifier cannot survive, and it loses them silently:
 * the file says 007 and the target says 7, and nothing reports a difference because by then the value is
 * the number seven.
 *
 * `0` on its own is a number. `0.5` is a number. `0` followed by another digit is not.
 */
const LEADING_ZERO_DIGITS = /^-?0\d/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** Day-first and month-first are both common and indistinguishable, so neither is guessed. */
const AMBIGUOUS_DATE = /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/;

/** A column name that reads like a label rather than data. */
const NAME_LIKE = /name$|^name|title|description|label|subject/i;
/** A column name that reads like an identifier. */
const KEY_LIKE = /^(id|key|code|number|no|ref|reference)$|(_|\b)(id|key|code|guid|uuid)$/i;

export interface InferredColumn {
  name: string;
  type: AttributeType;
  maxLength: number | null;
  /** How many of the examined values were empty. Reported so the inference is inspectable. */
  blanks: number;
  distinct: number | null;
  /** True when every non-empty value was distinct, which is what makes a column a candidate key. */
  unique: boolean;
  /** Why this type was chosen, in one line, for the import report. */
  reason: string;
}

export interface InferredTable {
  logicalName: string;
  displayName: string;
  columns: InferredColumn[];
  /** The column chosen to identify a row, or the synthetic one. */
  keyColumn: string;
  keyIsSynthetic: boolean;
  nameColumn: string | null;
  rowCount: number;
}

/**
 * Infers a table from a header row and the rows beneath it.
 *
 * `rows` is every row, because a type decided from the first hundred and contradicted by row 900 is
 * worse than no type at all. Files here are bounded by the upload limit, so reading them all is
 * affordable.
 */
export function inferTable(
  logicalName: string,
  displayName: string,
  headers: string[],
  rows: (string | number | boolean | null)[][],
): InferredTable {
  const names = uniqueHeaders(headers);
  const columns: InferredColumn[] = names.map((name, index) => inferColumn(name, rows, index));
  const keyColumn = pickKey(columns);
  return {
    logicalName,
    displayName,
    columns,
    keyColumn: keyColumn ?? ROW_KEY,
    keyIsSynthetic: keyColumn === null,
    nameColumn: pickNameColumn(columns, keyColumn),
    rowCount: rows.length,
  };
}

/**
 * A blank or duplicated heading still has to become a usable column name, because a real export has
 * both. Positional fallbacks keep the column addressable rather than dropping its data.
 */
function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((raw, i) => {
    const cleaned = String(raw ?? '')
      .replace(/[^A-Za-z0-9_ #$@.]/g, ' ')
      .trim()
      .slice(0, 120);
    const base = cleaned || `column_${i + 1}`;
    const key = base.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? base : `${base} ${n + 1}`;
  });
}

function inferColumn(
  name: string,
  rows: (string | number | boolean | null)[][],
  index: number,
): InferredColumn {
  let blanks = 0;
  let maxLength = 0;
  let allInteger = true;
  let allDecimal = true;
  let allBoolean = true;
  let allGuid = true;
  let allDateOnly = true;
  let allDateTime = true;
  let anyAmbiguousDate = false;
  /** Any value that is digits with a leading zero, which a numeric type would destroy. */
  let anyLeadingZero = false;
  let examined = 0;
  const distinct = new Set<string>();
  let distinctOverflow = false;

  for (const row of rows) {
    const text = cellText(row?.[index]);
    if (isBlank(text)) {
      blanks++;
      continue;
    }
    examined++;
    maxLength = Math.max(maxLength, text.length);
    if (distinct.size < 100_000) distinct.add(text);
    else distinctOverflow = true;

    if (!INTEGER.test(text)) allInteger = false;
    if (!DECIMAL.test(text)) allDecimal = false;
    if (!TRUE_WORDS.has(text.toLowerCase()) && !FALSE_WORDS.has(text.toLowerCase())) allBoolean = false;
    if (!GUID.test(text)) allGuid = false;
    if (!DATE_ONLY.test(text)) allDateOnly = false;
    if (!DATE_ONLY.test(text) && !DATE_TIME.test(text)) allDateTime = false;
    if (AMBIGUOUS_DATE.test(text)) anyAmbiguousDate = true;
    if (LEADING_ZERO_DIGITS.test(text)) anyLeadingZero = true;
  }

  const unique = examined > 0 && !distinctOverflow && distinct.size === examined;
  const stats = {
    blanks,
    distinct: distinctOverflow ? null : distinct.size,
    unique,
  };

  if (examined === 0) {
    // Nothing to go on. Text is the type that accepts whatever arrives later.
    return { name, type: 'String', maxLength: 255, reason: 'no values to infer from', ...stats };
  }
  // 0/1 columns are usually flags, but a column of only ones and zeroes is just as often a count.
  // Booleans are therefore only inferred from words, never from digits alone.
  const wordyBoolean = allBoolean && [...distinct].some((v) => !/^[01]$/.test(v));
  if (wordyBoolean) {
    return { name, type: 'Boolean', maxLength: null, reason: 'every value is true/false', ...stats };
  }
  if (allGuid) {
    return { name, type: 'Uniqueidentifier', maxLength: null, reason: 'every value is a GUID', ...stats };
  }
  /**
   * An identifier that happens to be digits stays text.
   *
   * Checked before the numeric branches rather than inside them, because it applies to whole numbers and
   * to decimals alike, and because the decision is not "which number type" — it is that this is not a
   * number. Preserving the source value is the rule; a type that cannot hold `007` is a transformation
   * nobody asked for.
   */
  if (anyLeadingZero && (allInteger || allDecimal)) {
    return {
      name,
      type: maxLength > 4000 ? 'Memo' : 'String',
      maxLength: maxLength || 255,
      reason:
        'digits with a leading zero, which is an identifier rather than a number — kept as text so the ' +
        'zeros survive',
      ...stats,
    };
  }
  if (allInteger) {
    const big = [...distinct].some((v) => !Number.isSafeInteger(Number(v)));
    return {
      name,
      type: big ? 'String' : Math.abs(Number([...distinct][0])) > 2_147_483_647 ? 'BigInt' : 'Integer',
      maxLength: big ? maxLength : null,
      reason: big ? 'whole numbers too large to hold exactly, kept as text' : 'every value is a whole number',
      ...stats,
    };
  }
  if (allDecimal) {
    return { name, type: 'Decimal', maxLength: null, reason: 'every value is a number', ...stats };
  }
  if (allDateOnly) {
    return { name, type: 'DateTime', maxLength: null, reason: 'every value is a date', ...stats };
  }
  if (allDateTime) {
    return { name, type: 'DateTime', maxLength: null, reason: 'every value is a date and time', ...stats };
  }
  // A narrower type is not worth a wrong guess about which number is the day.
  const reason = anyAmbiguousDate
    ? 'looks like dates, but the day and month order is ambiguous — kept as text'
    : 'mixed values, kept as text';
  return { name, type: maxLength > 4000 ? 'Memo' : 'String', maxLength: maxLength || 255, reason, ...stats };
}

const cellText = (value: string | number | boolean | null | undefined): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim();
};

const isBlank = (text: string) => text === '' || BLANKS.has(text.toLowerCase());

/**
 * A column that can identify a row: unique, never empty, and named like a key.
 *
 * All three conditions matter. Unique-and-never-empty alone would pick the first text column of a
 * small file by accident, and a key chosen by accident is one that stops being unique as soon as
 * more rows arrive — after the mapping has been built on it.
 */
function pickKey(columns: InferredColumn[]): string | null {
  const candidates = columns.filter((c) => c.unique && c.blanks === 0);
  return (
    candidates.find((c) => KEY_LIKE.test(c.name.replace(/\s+/g, '')))?.name ??
    candidates.find((c) => c.type === 'Uniqueidentifier')?.name ??
    null
  );
}

function pickNameColumn(columns: InferredColumn[], keyColumn: string | null): string | null {
  const text = columns.filter((c) => c.name !== keyColumn && (c.type === 'String' || c.type === 'Memo'));
  return text.find((c) => NAME_LIKE.test(c.name))?.name ?? text[0]?.name ?? null;
}

/**
 * The inferred table as the platform's own metadata model.
 *
 * Every column is marked `TABULAR`, which is what makes the rest of the platform convert values out
 * of it rather than copy them, and read-only, because a file is never written back to.
 */
export function toTableMetadata(inferred: InferredTable): TableMetadata {
  const attributes: AttributeMeta[] = [];
  if (inferred.keyIsSynthetic) {
    attributes.push({
      logicalName: ROW_KEY,
      schemaName: ROW_KEY,
      displayName: 'Row number',
      type: 'Integer',
      rawType: 'row',
      requiredLevel: 'SystemRequired',
      isPrimaryId: true,
      isPrimaryName: false,
      isCustom: true,
      // A row number identifies a row within this import and nothing beyond it, so it is never
      // written anywhere and never mapped.
      isValidForCreate: false,
      isValidForUpdate: false,
      isValidForRead: true,
      maxLength: null,
      precision: null,
      minValue: 1,
      maxValue: null,
      format: null,
      dateTimeBehavior: null,
      family: 'TABULAR',
    });
  }
  for (const column of inferred.columns) {
    const isKey = column.name === inferred.keyColumn;
    attributes.push({
      logicalName: column.name,
      schemaName: column.name,
      displayName: column.name,
      type: column.type,
      rawType: `${column.type.toLowerCase()} (inferred)`,
      // Nothing in a file is required: the file is the whole truth about what it contains.
      requiredLevel: 'None',
      isPrimaryId: isKey && !inferred.keyIsSynthetic,
      isPrimaryName: column.name === inferred.nameColumn,
      isCustom: true,
      isValidForCreate: false,
      isValidForUpdate: false,
      isValidForRead: true,
      maxLength: column.maxLength,
      precision: column.type === 'Decimal' ? 4 : null,
      minValue: null,
      maxValue: null,
      format: null,
      dateTimeBehavior: column.type === 'DateTime' ? 'TimeZoneIndependent' : null,
      family: 'TABULAR',
    });
  }

  // A detected key column is published as an alternate key too, so a migration can match on it.
  const keys: AlternateKeyMeta[] = inferred.keyIsSynthetic
    ? []
    : [
        {
          logicalName: `${inferred.logicalName}_key`,
          schemaName: `${inferred.logicalName}_key`,
          displayName: `${inferred.keyColumn} (detected key)`,
          attributes: [inferred.keyColumn],
          status: 'Active',
        },
      ];

  return {
    logicalName: inferred.logicalName,
    schemaName: inferred.logicalName,
    displayName: inferred.displayName,
    entitySetName: inferred.logicalName,
    isActivity: false,
    primaryIdAttribute: inferred.keyIsSynthetic ? ROW_KEY : inferred.keyColumn,
    primaryNameAttribute: inferred.nameColumn ?? inferred.keyColumn,
    isCustom: true,
    // A file is never a migration target, and marking it a view is how the rest of the platform
    // already knows not to offer something as one.
    isView: true,
    isIntersect: false,
    ownershipType: 'None',
    attributes,
    manyToOne: [],
    manyToMany: [],
    keys,
  };
}
