/** Minimal RFC 4180 CSV writer. Values are quoted defensively and never interpreted as formulas. */
export type CsvValue = string | number | boolean | null | undefined;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  // Spreadsheet formula injection: a leading =, +, - or @ is neutralized with a single quote.
  const safe = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  // Byte order mark so Excel detects UTF-8.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * A CSV written as its rows are found, for exports that scale with the migration.
 *
 * `toCsv` builds the whole file, which is right for a summary and wrong for one row per record: a
 * five-million-record export is a string nobody should have to hold, and the alternative the product
 * used to take — a cap with a TRUNCATED line at the bottom — answers a different question from the
 * one the person asked.
 *
 * Pages come in, text goes out, and nothing accumulates. Escaping is `csvCell`'s, so a streamed file
 * and a built one differ in nothing but how they were produced.
 */
export async function* csvStream(
  headers: string[],
  pages: AsyncIterable<CsvValue[][]>,
): AsyncGenerator<string> {
  // Byte order mark first, so Excel reads it as UTF-8 rather than as the local codepage.
  yield `\uFEFF${headers.map(csvCell).join(',')}\r\n`;
  for await (const page of pages) {
    if (page.length === 0) continue;
    // One string per page rather than per row: fewer, larger writes, still bounded by the page.
    yield `${page.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }
}

/** Safe, descriptive download file name. */
export function csvFileName(parts: (string | null | undefined)[]): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return `${name}-${stamp}.csv`;
}
