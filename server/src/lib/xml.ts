/**
 * Reading an XML extract as a table.
 *
 * XML is one of the most common shapes a legacy system exports in, and until now uploading one
 * produced something worse than a refusal: the file is UTF-8 text with no NUL bytes, so it fell
 * through to the delimited-text reader and came back as a one-column table of XML fragments. That
 * table then profiled, mapped and migrated like any other. A tool that answers confidently and
 * wrongly is the failure this product exists to prevent, so this reader exists to give the honest
 * answer instead.
 *
 * Deliberately hand-written, like the spreadsheet and archive readers beside it. Not for the fun of
 * it: a parser that never resolves an external entity cannot be made to fetch a file off the disk of
 * the machine it runs on, and that property is easier to guarantee in fifty lines than to verify in
 * a dependency. `<!DOCTYPE` is refused outright rather than ignored.
 */

export type XmlCell = string | null;

export interface XmlTable {
  /** The repeating element's name, which is what the table is called. */
  name: string;
  /** Header row first, then one row per record. */
  rows: XmlCell[][];
}

/** Bounds, matching the staged importer's own. Beyond these it is an extract, not an upload. */
const MAX_NODES = 2_000_000;
const MAX_RECORDS = 500_000;
const MAX_COLUMNS = 300;
/** How deep a nested value is still given a column. Below this it is joined into its parent. */
const MAX_PATH_DEPTH = 4;

export class XmlReadError extends Error {}

interface XmlNode {
  name: string;
  attrs: [string, string][];
  children: XmlNode[];
  /** Text directly inside this element, trimmed and collapsed. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decodes the five standard entities and numeric references.
 *
 * Anything else is left exactly as written. An unknown entity is never looked up, which is the
 * whole point: there is no table to poison and no document to fetch.
 */
function decodeText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * True when the bytes look like an XML document rather than delimited text.
 *
 * A complete opening tag is required, not just a leading `<`: a text file that happens to begin
 * with "<not a tag" is prose, and routing it here would answer with the wrong error.
 */
export function looksLikeXml(content: Buffer): boolean {
  const head = content
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<!--')) return true;
  return /^<[A-Za-z_][\w.:-]*(\s[^<>]*?)?\/?>/.test(head);
}

/** Parses the document into a tree. Bounded, non-validating, and it resolves nothing external. */
function parse(text: string): XmlNode {
  let i = 0;
  let nodes = 0;
  const root: XmlNode = { name: '#document', attrs: [], children: [], text: '' };
  const stack: XmlNode[] = [root];

  const fail = (message: string): never => {
    throw new XmlReadError(message);
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i) {
      const chunk = collapse(decodeText(text.slice(i, lt)));
      if (chunk) {
        const top = stack[stack.length - 1];
        top.text = top.text ? `${top.text} ${chunk}` : chunk;
      }
    }

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const chunk = collapse(text.slice(lt + 9, end === -1 ? text.length : end));
      if (chunk) {
        const top = stack[stack.length - 1];
        top.text = top.text ? `${top.text} ${chunk}` : chunk;
      }
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!DOCTYPE', lt) || text.startsWith('<!ENTITY', lt)) {
      // Refused rather than skipped. A document type declaration is how entity expansion and
      // external references get in, and no extract needs one to describe rows of data.
      fail(
        'This XML file carries a document type declaration. Export it without a DOCTYPE and upload it again: a declaration can define entities that make a small file expand into an enormous one, so this reader refuses to process one at all.',
      );
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt === -1) fail('This XML file ends in the middle of a tag, so it is incomplete or corrupt.');
    const inner = text.slice(lt + 1, gt);

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      // A stray or mismatched close tag: pop to it if we can, otherwise ignore it. Being lenient
      // here is right — the reader's job is to read an export, not to certify it.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) {
          stack.length = d;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) {
      i = gt + 1;
      continue;
    }
    if (++nodes > MAX_NODES) {
      fail(
        `This XML file holds more than ${MAX_NODES.toLocaleString()} elements. Split it, or load an extract this size from a database connection instead.`,
      );
    }
    const node: XmlNode = {
      name: nameMatch[1],
      attrs: readAttributes(body.slice(nameMatch[1].length)),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root;
}

/** The `>` that closes a tag, skipping any inside a quoted attribute value. */
function findTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function readAttributes(source: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push([m[1], decodeText(m[3] ?? m[4] ?? m[5] ?? '')]);
  }
  return out;
}

const elements = (node: XmlNode) => node.children;

/**
 * Finds the element that repeats, which is the row.
 *
 * Searches the whole tree rather than only the chain of single-child wrappers, because a real
 * export usually buries the records beside something else: `<export><meta/><orders><order/>...`
 * has no repetition at the top, and stopping there would call the entire export one row.
 *
 * Shallowest wins, then the largest group. Going deeper would find the repeated line items inside
 * each order and call a line a row, which is a different table than the one that was exported.
 *
 * Where nothing repeats anywhere, the document is a single record and is read as one row. That is
 * a real shape: one file per record.
 */
function findRecords(root: XmlNode): { name: string; records: XmlNode[] } | null {
  interface Group {
    name: string;
    records: XmlNode[];
    depth: number;
  }
  // A holder rather than a bare `let`: the assignments happen inside the closure below, which the
  // compiler does not track through, so a plain variable stays narrowed to null at the end.
  const state: { best: Group | null } = { best: null };

  const visit = (node: XmlNode, depth: number) => {
    if (depth > 8) return;
    const kids = elements(node);
    if (kids.length === 0) return;
    const groups = new Map<string, XmlNode[]>();
    for (const kid of kids) {
      const group = groups.get(kid.name);
      if (group) group.push(kid);
      else groups.set(kid.name, [kid]);
    }
    for (const [name, group] of groups) {
      if (group.length < 2) continue;
      const best = state.best;
      if (!best || depth < best.depth || (depth === best.depth && group.length > best.records.length)) {
        state.best = { name, records: group, depth };
      }
    }
    // Nothing deeper than a group already found can beat it.
    if (state.best && depth >= state.best.depth) return;
    for (const kid of kids) visit(kid, depth + 1);
  };
  visit(root, 0);
  if (state.best) return { name: state.best.name, records: state.best.records };

  // Nothing repeats: the deepest single wrapper holding fields is the one record.
  let container = root;
  for (let depth = 0; depth < 8; depth++) {
    const kids = elements(container);
    if (kids.length === 0) return null;
    if (kids.length === 1 && elements(kids[0]).length > 0) {
      container = kids[0];
      continue;
    }
    return { name: container === root ? kids[0].name : container.name, records: [container] };
  }
  return null;
}

/**
 * Flattens one record into column/value pairs.
 *
 * Attributes become `@name`, nested elements become a dotted path, and a child that appears more
 * than once in the same record is joined with a semicolon rather than silently keeping the last
 * one. Losing the earlier values quietly is exactly the kind of thing this product reports.
 */
function flatten(record: XmlNode): Map<string, string> {
  const out = new Map<string, string>();
  const put = (key: string, value: string) => {
    const existing = out.get(key);
    out.set(key, existing === undefined || existing === '' ? value : `${existing}; ${value}`);
  };

  const walk = (node: XmlNode, prefix: string, depth: number) => {
    for (const [name, value] of node.attrs) put(prefix ? `${prefix}@${name}` : `@${name}`, value);
    const kids = elements(node);
    if (kids.length === 0 || depth >= MAX_PATH_DEPTH) {
      // A leaf, or as deep as columns go: take the element's whole text.
      const value = depth >= MAX_PATH_DEPTH && kids.length ? collapse(textOf(node)) : node.text;
      if (prefix && value) put(prefix, value);
      return;
    }
    if (prefix && node.text) put(prefix, node.text);
    for (const kid of kids) walk(kid, prefix ? `${prefix}.${kid.name}` : kid.name, depth + 1);
  };

  walk(record, '', 0);
  return out;
}

/** Everything under a node as one string, for a subtree that is past the column depth. */
function textOf(node: XmlNode): string {
  let out = node.text;
  for (const kid of elements(node)) {
    const kidText = textOf(kid);
    if (kidText) out = out ? `${out} ${kidText}` : kidText;
  }
  return out;
}

/**
 * Reads an XML document as one table.
 *
 * Columns are the union of every record's fields, in first-seen order, and a record missing one
 * gets null — the same rule a SharePoint list already follows, because an export whose later rows
 * carry an extra field is ordinary rather than an error.
 */
export function readXml(content: Buffer, filename: string): XmlTable[] {
  const text = content.toString('utf8').replace(/^\uFEFF/, '');
  const root = parse(text);
  const found = findRecords(root);
  if (!found || found.records.length === 0) {
    throw new XmlReadError(
      `Nothing in ${filename} looks like a repeated record. This reader expects an element that occurs many times, one per row, such as a <customer> inside a <customers>.`,
    );
  }
  if (found.records.length > MAX_RECORDS) {
    throw new XmlReadError(
      `${filename} holds ${found.records.length.toLocaleString()} records; the limit is ${MAX_RECORDS.toLocaleString()}. Load an extract this size from a database connection instead.`,
    );
  }

  // Path -> the column name it is presented under, and the reverse, so a name is never reused for
  // two different paths.
  const columnFor = new Map<string, string>();
  const takenNames = new Set<string>();
  const columns: string[] = [];
  const flattened = found.records.map((record) => {
    const fields = flatten(record);
    for (const path of fields.keys()) {
      if (columnFor.has(path)) continue;
      if (columns.length >= MAX_COLUMNS) {
        throw new XmlReadError(
          `${filename} produces more than ${MAX_COLUMNS} columns. Export fewer fields, or split it into several files.`,
        );
      }
      const name = uniqueName(columnName(path), takenNames);
      columnFor.set(path, name);
      takenNames.add(name);
      columns.push(name);
    }
    return fields;
  });
  const paths = [...columnFor.keys()];

  if (columns.length === 0) {
    throw new XmlReadError(
      `Nothing in ${filename} looks like a repeated record. This reader expects an element that occurs many times, one per row, such as a <customer> inside a <customers>.`,
    );
  }

  const rows: XmlCell[][] = [columns];
  for (const fields of flattened) {
    rows.push(paths.map((p) => fields.get(p) ?? null));
  }
  return [{ name: found.name, rows }];
}

/**
 * The column name a flattened path is presented under.
 *
 * The `@` and `.` in a path are this reader's own notation for "attribute" and "nested", not
 * something the customer wrote, so they are turned into a name the rest of the platform can carry:
 * a field name reaches API routes, exports and target columns, and a dot is not valid in one. A CSV
 * header is left exactly as the customer typed it, because that one IS their name for the column.
 */
function columnName(path: string): string {
  const cleaned = path
    .replace(/^@/, '')
    .replace(/[@.]/g, '_')
    .replace(/[^A-Za-z0-9_ #$]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'field').slice(0, 128);
}

/** Keeps two different paths from collapsing onto one column and silently merging their values. */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}`.slice(0, 128);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_x`.slice(0, 128);
}
