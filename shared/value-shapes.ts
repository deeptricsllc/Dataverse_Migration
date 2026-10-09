/**
 * What a single stored value looks like, independent of the type it is stored as.
 *
 * The semantic reader in `semantic-types.ts` answers a different question: what does this *column*
 * mean, decided from a distinct sample of its values. That is the right question for "this column
 * holds email addresses" and the wrong one for "how many records would fail to convert", because a
 * distinct sample counts spellings and a migration converts records.
 *
 * These helpers classify one value at a time so the profiler can count records, and they are shared
 * so that the rule used to count is the same rule used to decide. Two implementations would let the
 * product report that a column holds money and that none of its values are money.
 *
 * Nothing here converts anything. A shape is an observation.
 */

export type ValueShape = 'BLANK' | 'NUMBER' | 'CURRENCY' | 'BOOLEAN' | 'DATE' | 'TEXT';

/** A plain number: optional sign, digits, optional decimal part. No grouping, no symbol. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * A number written for people: a currency symbol or ISO code, or digit grouping, or both.
 *
 * Accepts the two common groupings — `1,234.56` and `1.234,56` — and accounting negatives in
 * parentheses, because an export from a finance system contains all of them and a migration has to
 * know which.
 */
const CURRENCY_SYMBOL = /[$£€¥₹]/;
const CURRENCY_CODE = /\b(USD|EUR|GBP|JPY|INR|AUD|CAD|CHF|CNY|SEK|NZD)\b/i;
const MONEY_BODY = /^-?\(?\s*(?:\d{1,3}(?:[,\s]\d{3})+|\d{1,3}(?:\.\d{3})+|\d+)(?:[.,]\d{1,4})?\s*\)?-?$/;

/** The boolean spellings a spreadsheet actually contains. */
export const BOOLEAN_TOKENS = new Set([
  'true',
  'false',
  'yes',
  'no',
  'y',
  'n',
  't',
  'f',
  '1',
  '0',
  'on',
  'off',
]);

/**
 * Shapes that are unambiguously boolean.
 *
 * `1` and `0` are in BOOLEAN_TOKENS because a column of them beside a column of `Y`/`N` is the same
 * idea spelled differently, but on their own they are numbers and calling them boolean would make
 * every quantity column look like a flag. A column is only read as boolean when its vocabulary is
 * small and contains at least one word.
 */
const BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 't', 'f', 'on', 'off']);

export function isBooleanWord(text: string): boolean {
  return BOOLEAN_WORDS.has(text.trim().toLowerCase());
}

/** Strips grouping and symbols so the remainder can be tested as a number. */
function moneyBody(text: string): string {
  return text.replace(CURRENCY_SYMBOL, '').replace(CURRENCY_CODE, '').trim();
}

export function looksLikeCurrency(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const hasMarker = CURRENCY_SYMBOL.test(trimmed) || CURRENCY_CODE.test(trimmed);
  const body = hasMarker ? moneyBody(trimmed) : trimmed;
  if (!MONEY_BODY.test(body)) return false;
  // Without a symbol it is only money-as-text if it is grouped: 1,234.56 rather than 1234.56.
  return hasMarker || /[,\s]/.test(body) || /^\d{1,3}(\.\d{3})+$/.test(body);
}

/**
 * Which currency this value is marked with, if any.
 *
 * Kept separate from the decimal convention below, because they are two different problems with two
 * different fixes: a column holding both `$` and `€` needs a currency column beside it, and a column
 * holding both `1,234.56` and `1.234,56` needs somebody to decide which mark is the decimal point.
 * An earlier version combined them into one "notation" signature and also folded in whether the
 * amount was grouped — which made `$1,200.50` and `$9.99` two different notations, so any column
 * with amounts above and below a thousand reported itself as inconsistent.
 */
export function currencyMarker(text: string): string | null {
  const trimmed = text.trim();
  if (!looksLikeCurrency(trimmed)) return null;
  const symbol = CURRENCY_SYMBOL.exec(trimmed)?.[0];
  if (symbol) return symbol;
  const code = CURRENCY_CODE.exec(trimmed)?.[0]?.toUpperCase();
  return code ?? null;
}

/**
 * Which mark this value uses for the decimal point, or null when it has no fraction.
 *
 * Null rather than a guess: `$1,200` says nothing about the convention, and inventing an answer for
 * it would make a column of round amounts disagree with itself.
 */
export function decimalSeparator(text: string): 'dot' | 'comma' | null {
  const trimmed = text.trim();
  if (!looksLikeCurrency(trimmed) && !PLAIN_NUMBER.test(trimmed)) return null;
  const body = looksLikeCurrency(trimmed) ? moneyBody(trimmed) : trimmed;
  // Grouped with dots means the comma is the decimal mark, and the other way round.
  if (/^\d{1,3}(\.\d{3})+,\d+/.test(body)) return 'comma';
  if (/^\d{1,3}([,\s]\d{3})+\.\d+/.test(body)) return 'dot';
  // Grouped with no fraction says nothing about the convention: "1,200" is a thousand two hundred
  // under one reading and one-point-two under the other, and guessing picks the wrong one half the
  // time in exactly the columns where that matters.
  if (/^\d{1,3}([,\s]\d{3})+$/.test(body)) return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(body)) return null;
  if (/,\d{1,4}\s*\)?-?$/.test(body)) return 'comma';
  if (/\.\d{1,4}\s*\)?-?$/.test(body)) return 'dot';
  return null;
}

/** Decimal places in a plain or money-shaped number, or null when it is not one. */
export function decimalPlaces(text: string): number | null {
  const trimmed = text.trim();
  const body = looksLikeCurrency(trimmed) ? moneyBody(trimmed) : trimmed;
  if (!PLAIN_NUMBER.test(body) && !MONEY_BODY.test(body)) return null;
  const m = /[.,](\d{1,10})\s*\)?-?$/.exec(body);
  if (!m) return 0;
  // A three-digit group after a dot is grouping, not a fraction: 1.234 is one thousand two hundred.
  if (/\.\d{3}$/.test(body) && /^\d{1,3}(\.\d{3})+$/.test(body)) return 0;
  return m[1].length;
}

/**
 * Whether a value reads as a date.
 *
 * Deliberately strict. `Date.parse` accepts bare integers in some runtimes and a great many strings
 * that nobody wrote as a date, and a loose test here would classify a column of reference numbers as
 * dates and recommend converting them.
 */
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2}([T ]|$)|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/;

export function shapeOf(raw: string): ValueShape {
  const text = raw.trim();
  if (text === '') return 'BLANK';
  if (PLAIN_NUMBER.test(text)) return 'NUMBER';
  if (looksLikeCurrency(text)) return 'CURRENCY';
  if (isBooleanWord(text)) return 'BOOLEAN';
  if (DATE_SHAPED.test(text) && !Number.isNaN(Date.parse(text))) return 'DATE';
  return 'TEXT';
}
