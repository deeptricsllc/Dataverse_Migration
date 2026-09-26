import { readZip, writeZip, type ZipEntry } from './zip';

/**
 * Reads and writes the subset of .xlsx that a mapping workbook needs.
 *
 * A mapping sheet is the document a migration is actually argued over: it leaves the tool, gets
 * filled in by people who will never open the tool, and comes back. So it has to be a real
 * spreadsheet — frozen header, widths, filters — and it has to be readable again afterwards,
 * including when Excel itself rewrote it with a shared-string table and styles we never emitted.
 *
 * Deliberately narrow: no formulas, no merged cells, no charts. Cells are text, numbers or blanks.
 */

export type XlsxValue = string | number | boolean | null | undefined;

export interface XlsxColumn {
  header: string;
  /** Width in characters. Defaults to something sensible for the header. */
  width?: number;
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxValue[][];
  /** Rendered above the header as guidance for whoever fills the sheet in. */
  notes?: string[];
}

export interface XlsxReadSheet {
  name: string;
  rows: (string | number | boolean | null)[][];
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A sheet name Excel will accept: 31 characters, none of `[]:*?/\`, and never blank. */
export function safeSheetName(name: string, fallback = 'Sheet'): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || fallback;
}

export function writeXlsx(sheets: XlsxSheet[]): Buffer {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet');
  const names = uniqueSheetNames(sheets.map((s) => s.name));
  const entries: ZipEntry[] = [];

  entries.push(part('[Content_Types].xml', contentTypes(sheets.length)));
  entries.push(part('_rels/.rels', rootRels()));
  entries.push(part('xl/workbook.xml', workbook(names)));
  entries.push(part('xl/_rels/workbook.xml.rels', workbookRels(sheets.length)));
  entries.push(part('xl/styles.xml', styles()));
  sheets.forEach((sheet, i) => entries.push(part(`xl/worksheets/sheet${i + 1}.xml`, worksheet(sheet))));
  return writeZip(entries);
}

const part = (path: string, xml: string): ZipEntry => ({ path, data: Buffer.from(xml, 'utf8') });

/** Excel refuses a workbook with two sheets of the same name, so collisions are numbered. */
function uniqueSheetNames(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((name, i) => {
    const base = safeSheetName(name, `Sheet${i + 1}`);
    const key = base.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? base : safeSheetName(`${base.slice(0, 27)} (${n + 1})`, `Sheet${i + 1}`);
  });
}

function contentTypes(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}</Types>`;
}

const rootRels = () =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

function workbook(names: string[]): string {
  const sheets = names
    .map((name, i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
}

function workbookRels(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  const styleRel = `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}${styleRel}</Relationships>`;
}

/** Three styles: plain, bold header on a fill, and the italic grey used for the guidance notes. */
function styles(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF1E293B"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

const STYLE_PLAIN = 0;
const STYLE_HEADER = 1;
const STYLE_NOTE = 2;

function worksheet(sheet: XlsxSheet): string {
  const notes = sheet.notes ?? [];
  const headerRow = notes.length + 1;
  const out: string[] = [];

  notes.forEach((note, i) => {
    out.push(`<row r="${i + 1}">${cell(colRef(0) + (i + 1), note, STYLE_NOTE)}</row>`);
  });
  out.push(
    `<row r="${headerRow}" customHeight="1" ht="22">${sheet.columns
      .map((c, i) => cell(colRef(i) + headerRow, c.header, STYLE_HEADER))
      .join('')}</row>`,
  );
  sheet.rows.forEach((row, r) => {
    const rowNumber = headerRow + 1 + r;
    const cells = row
      .map((value, i) => cell(colRef(i) + rowNumber, value, STYLE_PLAIN))
      .filter(Boolean)
      .join('');
    out.push(`<row r="${rowNumber}">${cells}</row>`);
  });

  const lastColumn = colRef(Math.max(0, sheet.columns.length - 1));
  const lastRow = headerRow + sheet.rows.length;
  const cols = sheet.columns
    .map(
      (c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? widthFor(c.header)}" customWidth="1"/>`,
    )
    .join('');
  // The header is frozen and filterable, because these sheets are read by scrolling and sorting.
  const pane = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  const filter = sheet.rows.length ? `<autoFilter ref="A${headerRow}:${lastColumn}${lastRow}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<cols>${cols}</cols><sheetData>${out.join('')}</sheetData>${filter}</worksheet>`;
}

const widthFor = (header: string) => Math.min(60, Math.max(12, header.length + 4));

/**
 * One cell. Strings are written as inline strings rather than formulas, so a value beginning with
 * `=` is data and stays data — an .xlsx cell cannot be reinterpreted as a formula the way a CSV
 * field can.
 */
function cell(ref: string, value: XlsxValue, style: number): string {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : '';
  }
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function colRef(index: number): string {
  let n = index;
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    if (n < 26) return out;
    n = Math.floor(n / 26) - 1;
  }
}

/** XML text, with the control characters Excel rejects removed rather than escaped. */
function esc(value: string): string {
  return (
    value
      // Excel rejects most control characters outright, so they are dropped rather than escaped.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Reads every sheet of a workbook into rows of plain values.
 *
 * Written to survive a real round trip through Excel: shared strings, styles we never wrote,
 * cells stored out of order, and — the one that silently corrupts a naive reader — omitted empty
 * cells, which is why each cell is placed by its own `r="C7"` reference instead of by arrival order.
 */
export function readXlsx(buf: Buffer): XlsxReadSheet[] {
  const files = readZip(buf);
  const workbookXml = text(files, 'xl/workbook.xml');
  if (!workbookXml) throw new Error('Not an .xlsx workbook: xl/workbook.xml is missing');
  const rels = parseRels(text(files, 'xl/_rels/workbook.xml.rels') ?? '');
  const shared = parseSharedStrings(text(files, 'xl/sharedStrings.xml') ?? '');

  const out: XlsxReadSheet[] = [];
  const sheetTags = workbookXml.match(/<sheet\b[^>]*\/?>/g) ?? [];
  sheetTags.forEach((tag, i) => {
    const name = unesc(attr(tag, 'name') ?? `Sheet${i + 1}`);
    const rid = attr(tag, 'r:id') ?? attr(tag, 'id');
    const target = (rid && rels.get(rid)) || `worksheets/sheet${i + 1}.xml`;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = text(files, path);
    if (xml === null) return;
    out.push({ name, rows: parseSheet(xml, shared) });
  });
  return out;
}

const text = (files: Map<string, Buffer>, path: string): string | null => {
  const found = files.get(path) ?? files.get(path.replace(/^\//, ''));
  return found ? found.toString('utf8') : null;
};

function parseRels(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of xml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    if (id && target) out.set(id, target);
  }
  return out;
}

/**
 * The shared string table. An entry can be split across several `<r>` runs when part of the text
 * was formatted differently, so every `<t>` in the entry is concatenated.
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.match(/<si\b[^>]*>[\s\S]*?<\/si>|<si\b[^>]*\/>/g) ?? []) {
    const parts = si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    out.push(parts.map((t) => unesc(t.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))).join(''));
  }
  return out;
}

function parseSheet(xml: string, shared: string[]): (string | number | boolean | null)[][] {
  const rows: (string | number | boolean | null)[][] = [];
  for (const rowXml of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g) ?? []) {
    const rowNumber = Number(attr(rowXml, 'r') ?? rows.length + 1);
    const row: (string | number | boolean | null)[] = [];
    for (const cellXml of rowXml.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) ?? []) {
      const ref = attr(cellXml, 'r');
      const column = ref ? columnIndex(ref) : row.length;
      while (row.length < column) row.push(null);
      row[column] = cellValue(cellXml, shared);
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = row;
  }
  return rows;
}

function cellValue(cellXml: string, shared: string[]): string | number | boolean | null {
  const type = attr(cellXml, 't') ?? 'n';
  if (type === 'inlineStr') {
    const parts = cellXml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    if (parts.length === 0) return null;
    return parts.map((t) => unesc(t.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))).join('');
  }
  const raw = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  if (!raw) return null;
  const value = unesc(raw[1]);
  if (type === 's') {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n < shared.length ? shared[n] : null;
  }
  if (type === 'b') return value === '1' || value.toLowerCase() === 'true';
  if (type === 'str' || type === 'e') return value;
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

/** `C7` / `$AB$12` -> 2 / 27. */
export function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Za-z]/g, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : null;
};

function unesc(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Rows of a sheet keyed by its header row, which is how an imported workbook is read: people
 * reorder columns, rename a sheet and add notes above the header, but they keep the header labels.
 */
export function rowsByHeader(
  sheet: XlsxReadSheet,
  required: string[],
): { headers: string[]; rows: Record<string, string>[] } | null {
  const wanted = required.map(normalizeHeader);
  for (let i = 0; i < Math.min(sheet.rows.length, 20); i++) {
    const cells = (sheet.rows[i] ?? []).map((c) => (c === null ? '' : String(c)));
    const normalized = cells.map(normalizeHeader);
    if (!wanted.every((w) => normalized.includes(w))) continue;
    const rows: Record<string, string>[] = [];
    for (const raw of sheet.rows.slice(i + 1)) {
      const record: Record<string, string> = {};
      let any = false;
      normalized.forEach((key, c) => {
        if (!key) return;
        const value = raw?.[c];
        const asText = value === null || value === undefined ? '' : String(value).trim();
        record[key] = asText;
        if (asText) any = true;
      });
      if (any) rows.push(record);
    }
    return { headers: cells, rows };
  }
  return null;
}

/** Header labels match on letters and digits only, so "Target Field" and "target_field" agree. */
export const normalizeHeader = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
