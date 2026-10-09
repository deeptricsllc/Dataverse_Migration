/**
 * What a column's values appear to *mean*, as distinct from how they are stored.
 *
 * ## Why this is a separate thing from the storage type
 *
 * A spreadsheet column holding `45292`, `45380`, `45291` is a column of integers. That is a fact, and the
 * storage type has to say so, because that is what the engine will read and what a target column has to
 * accept. But `45292` under a heading of `Start Date` is almost certainly 2024-01-01 — Excel stores a date
 * as the number of days since 1899-12-30 — and a product that reports "Start Date: Integer" and stops has
 * told the user something true and useless. They will migrate a column of five-digit numbers into a date
 * field and find out later.
 *
 * So both are kept. **Storage type** is observed. **Semantic type** is inferred, carries a confidence, and
 * is never acted on by itself.
 *
 * ## The rule that makes this safe
 *
 * Nothing here transforms anything. A detection produces a suggestion the user can accept or ignore, and
 * the distinction between *observed*, *inferred* and *applied* is the product's whole claim to being
 * trustworthy about a migration. A column silently converted because something was 70% sure is exactly the
 * failure this layer exists to prevent: it would be invisible, and it would be wrong roughly a third of the
 * time.
 */

export const SEMANTIC_TYPES = [
  'EXCEL_SERIAL_DATE',
  'EMAIL',
  'URL',
  'PHONE',
  'CURRENCY',
  'PERCENTAGE',
  'IDENTIFIER',
  'CATEGORICAL',
  'EMPTY',
] as const;
export type SemanticType = (typeof SEMANTIC_TYPES)[number];

/**
 * How much the evidence supports the reading.
 *
 * There is no LOW. A detection we would describe as low confidence is a guess, and showing a user a guess
 * next to a fact teaches them to discount both — so anything that weak is simply not reported.
 */
export type SemanticConfidence = 'HIGH' | 'MEDIUM';

export interface SemanticReading {
  type: SemanticType;
  confidence: SemanticConfidence;
  /** The detected meaning, for a person. "Date, stored as an Excel serial number". */
  label: string;
  /** Why this reading was reached, naming the evidence rather than asserting the conclusion. */
  evidence: string;
  /**
   * What would have to happen before this column is usable as its apparent meaning, or null when
   * nothing need happen. **A suggestion. Never applied by detecting it.**
   */
  suggestedTransformation: string | null;
}

export const SEMANTIC_LABELS: Record<SemanticType, string> = {
  EXCEL_SERIAL_DATE: 'Date, stored as an Excel serial number',
  EMAIL: 'Email address',
  URL: 'Web address',
  PHONE: 'Telephone number',
  CURRENCY: 'Monetary amount',
  PERCENTAGE: 'Percentage',
  IDENTIFIER: 'Identifier',
  CATEGORICAL: 'Category, from a small fixed set',
  EMPTY: 'No values at all',
};

// ---------------------------------------------------------------------------
// Excel serial dates
// ---------------------------------------------------------------------------

/**
 * Excel's epoch, which is not the one Excel documents.
 *
 * Serial 1 is 1900-01-01, and Excel also believes 1900 was a leap year — a deliberate 1980s compatibility
 * decision with Lotus 1-2-3 that Microsoft has never been able to undo. The phantom 29 February 1900 means
 * that for every serial above 60 the arithmetic works out if you treat day zero as 1899-12-30, which is
 * why that date appears here instead of 1900-01-01.
 *
 * Serials of 60 or below are therefore not converted at all: they are either the two months where the bug
 * makes the answer ambiguous, or they are small numbers that have no business being read as dates.
 * https://learn.microsoft.com/office/troubleshoot/excel/1900-and-1904-date-system
 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/** Below this a serial is ambiguous or implausible as a date; see the epoch note above. */
const MIN_SERIAL = 61;
/**
 * The window a value has to fall in before it is read as a date.
 *
 * 15000 is 1941 and 80000 is 2119. Wide enough for a date of birth and a long-dated contract, narrow
 * enough that quantities, prices, row counts and small identifiers fall outside it. A column of integers
 * that happen to sit in this range but are not dates is why the column *name* also has to agree before the
 * confidence is HIGH.
 */
const PLAUSIBLE_SERIAL_MIN = 15_000;
const PLAUSIBLE_SERIAL_MAX = 80_000;

/** A heading that says this column is a date. The strongest single piece of evidence available. */
const DATE_NAME =
  /(^|[^a-z])(date|dob|birthday|created|modified|updated|start|end|due|expiry|expires|effective|closed|opened|received|shipped|invoiced|paid)([^a-z]|$)/i;

/** Converts an Excel serial to an ISO date, or null when it is outside the range we will convert. */
export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < MIN_SERIAL || serial > PLAUSIBLE_SERIAL_MAX) return null;
  // The fractional part is the time of day. Kept, because a timestamp exported this way still carries it.
  const ms = EXCEL_EPOCH_UTC + Math.round(serial * MS_PER_DAY);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const whole = Number.isInteger(serial);
  return whole ? date.toISOString().slice(0, 10) : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Exported so the profiler counts invalid addresses by the same rule this uses to decide the column
 * holds addresses at all. Two regexes would let the product say "this column is email" and "none of
 * these are invalid" about the same values.
 */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
const EMAIL = EMAIL_SHAPE;
const URL = /^(https?:\/\/|www\.)[^\s]+$/i;
/**
 * Deliberately narrow. A telephone number has no universal shape, so this only matches things that are
 * unambiguously *written as* phone numbers — enough punctuation or a leading `+` — rather than any run of
 * digits, which would swallow every identifier in the file.
 */
const PHONE = /^[+(]?\d[\d\s().-]{6,19}$|^\(\d[\d\s().-]{6,19}$/;
/**
 * What makes a run of digits *written as* a telephone number.
 *
 * A hyphen or a dot is not enough, and assuming it was produced three false readings in the demo dataset
 * the first time this ran: `2024-03-15` and `8220.50` both matched, so a date column and a currency column
 * were reported as telephone numbers. A space, a parenthesis or a leading `+` is the actual signal —
 * nobody writes a date with a space in the middle or an amount in brackets.
 */
const HAS_PHONE_PUNCTUATION = /^\+|[\s()]/;
const CURRENCY = /^[-(]?\s*[$£€¥]\s?\d[\d,]*(\.\d{1,4})?\s*\)?$/;
const PERCENTAGE = /^-?\d{1,3}(\.\d{1,4})?\s?%$/;
/**
 * A column holding a person's name, which is never a choice set.
 *
 * The ratio test alone cannot tell the difference: a sample where three hundred contacts share ten first
 * names satisfies it exactly, and the product then offered to map `first_name` to a target choice column.
 * A person's name is not a category however few of them a sample happens to contain, so the name of the
 * column overrules the arithmetic here.
 */
const PERSON_NAME =
  /(^|[^a-z])(first_?name|last_?name|sur_?name|fore_?name|given_?name|middle_?name|full_?name|contact_?name)([^a-z]|$)/i;

/** Digits with a leading zero: an identifier written in digits, which a number would destroy. */
const LEADING_ZERO_DIGITS = /^-?0\d/;

export interface SemanticInput {
  /** The column heading, which is often the only thing that disambiguates a number. */
  name: string;
  /** The storage type already inferred, so a reading can only ever add to it. */
  storageType: string;
  /** Non-empty sample values, as text. */
  values: string[];
  /** Distinct non-empty values, when known. */
  distinct: number | null;
  /** Non-empty value count, for the categorical ratio. */
  populated: number;
}

const ratio = (matching: number, total: number) => (total === 0 ? 0 : matching / total);

/**
 * How much of a column has to fit a pattern before the column is read as that kind of thing.
 *
 * 0.8, not 0.95, and the difference matters more than it looks. A column where 19 of 400 addresses are
 * malformed is *exactly* the column a user needs told about, and a 0.95 threshold reports it as ordinary
 * text — hiding the finding behind the strictness meant to protect against false ones. So the reading is
 * made at 0.8 and the confidence carries the doubt: HIGH when almost everything fits, MEDIUM when enough
 * does not that somebody should look.
 */
const ENOUGH = 0.8;
const NEARLY_ALL = 0.98;

const confidenceFor = (matching: number, total: number): SemanticConfidence =>
  ratio(matching, total) >= NEARLY_ALL ? 'HIGH' : 'MEDIUM';

/**
 * Reads a column's apparent meaning, or returns null when nothing is confidently apparent.
 *
 * Order matters only where two readings could both fit. A column of Excel serials is checked before
 * `IDENTIFIER` and `CATEGORICAL` because those would otherwise claim it on weaker grounds.
 */
export function detectSemanticType(input: SemanticInput): SemanticReading | null {
  const { name, values, distinct, populated } = input;
  if (populated === 0) {
    return {
      type: 'EMPTY',
      confidence: 'HIGH',
      label: SEMANTIC_LABELS.EMPTY,
      evidence: 'No row in this column contains a value.',
      suggestedTransformation: null,
    };
  }
  if (values.length === 0) return null;

  const excel = detectExcelSerialDate(name, values);
  if (excel) return excel;

  const matches = (test: RegExp) => values.filter((v) => test.test(v)).length;

  const emails = matches(EMAIL);
  if (ratio(emails, values.length) >= ENOUGH) {
    const bad = values.length - emails;
    return {
      type: 'EMAIL',
      confidence: confidenceFor(emails, values.length),
      label: SEMANTIC_LABELS.EMAIL,
      evidence:
        bad === 0
          ? `All ${values.length} sampled values are email addresses.`
          : `${emails} of ${values.length} sampled values are email addresses; ${bad} are not.`,
      suggestedTransformation: bad > 0 ? 'Correct or exclude the values that are not addresses' : null,
    };
  }
  const urls = matches(URL);
  if (ratio(urls, values.length) >= ENOUGH) {
    return {
      type: 'URL',
      confidence: confidenceFor(urls, values.length),
      label: SEMANTIC_LABELS.URL,
      evidence: `${urls} of ${values.length} sampled values are web addresses.`,
      suggestedTransformation:
        urls === values.length ? null : 'Correct or exclude the values that are not addresses',
    };
  }
  const money = matches(CURRENCY);
  if (ratio(money, values.length) >= ENOUGH) {
    return {
      type: 'CURRENCY',
      confidence: confidenceFor(money, values.length),
      label: SEMANTIC_LABELS.CURRENCY,
      evidence: `${money} of ${values.length} sampled values carry a currency symbol.`,
      suggestedTransformation: 'Strip the symbol and separators so the amount can be stored as a number',
    };
  }
  const percentages = matches(PERCENTAGE);
  if (ratio(percentages, values.length) >= ENOUGH) {
    return {
      type: 'PERCENTAGE',
      confidence: confidenceFor(percentages, values.length),
      label: SEMANTIC_LABELS.PERCENTAGE,
      evidence: `${percentages} of ${values.length} sampled values end in a percent sign.`,
      suggestedTransformation: 'Decide whether the target stores 15% as 15 or as 0.15, and convert to match',
    };
  }
  // Punctuation is required as well as the pattern: a bare run of digits is far more often a reference.
  const phoneLike = values.filter((v) => PHONE.test(v) && HAS_PHONE_PUNCTUATION.test(v)).length;
  if (ratio(phoneLike, values.length) >= ENOUGH) {
    return {
      type: 'PHONE',
      // Never HIGH, whatever the ratio: a telephone number has no universal format, so this stays a
      // reading rather than becoming a certainty just because every value happened to fit.
      confidence: 'MEDIUM',
      label: SEMANTIC_LABELS.PHONE,
      evidence: `${phoneLike} of ${values.length} sampled values are punctuated like telephone numbers. A telephone number has no universal format, so this is a reading rather than a certainty.`,
      suggestedTransformation: 'Normalise to one format before migrating, if the target expects one',
    };
  }
  if (ratio(matches(LEADING_ZERO_DIGITS), values.length) >= ENOUGH) {
    return {
      type: 'IDENTIFIER',
      confidence: 'HIGH',
      label: SEMANTIC_LABELS.IDENTIFIER,
      evidence:
        'Values are digits with a leading zero, which a number cannot preserve: 007 stored as a number becomes 7.',
      suggestedTransformation: 'Keep this column as text',
    };
  }

  /**
   * Categorical, which is only interesting when the ratio is extreme.
   *
   * Four distinct values across 40,000 rows is a choice column, and knowing that turns a text field into a
   * mapping decision. Four across twelve rows is just a short file, and reporting it as a category would be
   * noise.
   */
  if (
    distinct !== null &&
    populated >= 50 &&
    distinct >= 2 &&
    distinct <= 25 &&
    distinct / populated < 0.05 &&
    !PERSON_NAME.test(name)
  ) {
    return {
      type: 'CATEGORICAL',
      confidence: 'HIGH',
      label: SEMANTIC_LABELS.CATEGORICAL,
      evidence: `Only ${distinct} distinct values across ${populated} rows.`,
      suggestedTransformation: 'Map these values to the target choice set, if the target uses one',
    };
  }
  return null;
}

function detectExcelSerialDate(name: string, values: string[]): SemanticReading | null {
  // Only a column that is entirely numeric can be a serial date. One "N/A" and this is a text column
  // with numbers in it, which is a different and more interesting problem.
  const numbers: number[] = [];
  for (const v of values) {
    if (!/^\d{4,5}(\.\d+)?$/.test(v)) return null;
    numbers.push(Number(v));
  }
  if (numbers.length === 0) return null;
  const inWindow = numbers.filter((n) => n >= PLAUSIBLE_SERIAL_MIN && n <= PLAUSIBLE_SERIAL_MAX).length;
  if (inWindow !== numbers.length) return null;

  const nameAgrees = DATE_NAME.test(name);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const from = excelSerialToIsoDate(min);
  const to = excelSerialToIsoDate(max);
  if (!from || !to) return null;

  /**
   * The heading decides the confidence, not the detection.
   *
   * Every value being in the window is weak on its own: quantities and reference numbers live there too.
   * A heading that says `Start Date` is the thing that makes this a reading worth acting on, and without
   * one it stays MEDIUM so a user looks before converting.
   */
  return {
    type: 'EXCEL_SERIAL_DATE',
    confidence: nameAgrees ? 'HIGH' : 'MEDIUM',
    label: SEMANTIC_LABELS.EXCEL_SERIAL_DATE,
    evidence: nameAgrees
      ? `Every value is a whole number between ${min} and ${max}, and the column is named like a date. Read as Excel serial numbers these are ${from} to ${to}.`
      : `Every value is a whole number between ${min} and ${max}, which read as Excel serial numbers would be ${from} to ${to}. The column name does not confirm it, so this may be a quantity or a reference number.`,
    suggestedTransformation: 'Convert from Excel serial number to a date',
  };
}
