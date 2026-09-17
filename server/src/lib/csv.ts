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
