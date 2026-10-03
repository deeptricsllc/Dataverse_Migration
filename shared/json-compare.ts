import { decimalsEqual } from './aggregates';

/**
 * Whether two JSON documents say the same thing.
 *
 * Validation used to compare a JSON column by its serialisation, so `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` were reported as a difference. That is the safe direction to be wrong in — noise
 * rather than silence — but it is still wrong, and on a table with a `jsonb` column it reported a
 * difference on every record.
 *
 * `JSON.parse` is not usable for this, for two reasons that both produce a **false match**:
 *
 *   - Duplicate keys are collapsed silently. `{"a":1,"a":2}` parses to `{a:2}`, so two documents
 *     that genuinely differ can compare equal and nobody is told. Which one wins is a property of
 *     the parser, not of the data.
 *   - Numbers become doubles. `12345678901234567890` and `12345678901234567891` both become
 *     1.2345678901234567e19, so a BIGINT inside a JSON document compares equal to a different one.
 *
 * So this parses the text itself, keeps every number as the digits it was written with, and records
 * duplicate keys rather than resolving them. The rules:
 *
 *   - **Object key order is ignored.** Two objects are equal when they have the same keys with equal
 *     values. This is the whole point of the exercise.
 *   - **Array order matters.** A JSON array is an ordered sequence; `[1,2]` and `[2,1]` are two
 *     different documents, and treating them as equal would be inventing a tolerance nobody asked
 *     for.
 *   - **Numbers are compared as exact decimals**, through the same scaled-integer comparison the
 *     numeric columns use, with exponents expanded first. So `1`, `1.0` and `1e0` are equal, and two
 *     twenty-digit integers are equal only if they are.
 *   - **`null` is a value.** A key present with value `null` is not the same document as a key that
 *     is absent.
 *   - **Strings are exact**, after JSON unescaping. `"A"` equals `"A"` because they are the same
 *     string; nothing is trimmed or case-folded, because this is data inside a document rather than a
 *     column value with a column's tolerances.
 *   - **Duplicate keys anywhere, invalid text, or a document past the limits** gives
 *     `NOT_COMPARABLE` with a reason. Not equal, not different — unknown, and said out loud.
 *
 * The limits exist so a comparison cannot be made expensive by the data. A document larger than
 * `maxBytes`, deeper than `maxDepth`, or with more nodes than `maxNodes` is not parsed at all.
 */

export interface JsonCompareLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

/**
 * Deliberately modest. A megabyte of JSON per value, compared twice per record, is already more work
 * than a validation should do; past that the honest answer is that it was not compared.
 */
export const JSON_COMPARE_LIMITS: JsonCompareLimits = {
  maxBytes: 1_000_000,
  maxDepth: 64,
  maxNodes: 50_000,
};

export type JsonNode =
  | { k: 'null' }
  | { k: 'bool'; v: boolean }
  /** The digits as written. Never a JavaScript number, so nothing is lost before comparison. */
  | { k: 'num'; literal: string }
  | { k: 'str'; v: string }
  | { k: 'arr'; items: JsonNode[] }
  | { k: 'obj'; entries: [string, JsonNode][]; duplicates: string[] };

export type JsonParseResult =
  | { ok: true; node: JsonNode; duplicates: string[] }
  /**
   * `limited` separates "we declined to read this" from "this is not JSON". The first is a fact about
   * our limits and can only ever yield NOT_COMPARABLE; the second is a fact about the data and is a
   * reportable difference.
   */
  | { ok: false; error: string; limited: boolean };

/**
 * Parses JSON text into a tree that keeps what matters for comparison.
 *
 * A hand-written parser rather than `JSON.parse` because the two things that make this comparison
 * trustworthy — duplicate keys and exact number digits — are exactly what `JSON.parse` throws away.
 */
export function parseJsonForCompare(
  text: string,
  limits: JsonCompareLimits = JSON_COMPARE_LIMITS,
): JsonParseResult {
  if (text.length > limits.maxBytes) {
    return {
      ok: false,
      limited: true,
      error: `the document is ${text.length} characters, past the ${limits.maxBytes}-character comparison limit`,
    };
  }
  let i = 0;
  let nodes = 0;
  const duplicates: string[] = [];

  /** Thrown when a limit stopped the parse, so the caller can tell it from a syntax error. */
  class LimitReached extends Error {}
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at character ${i}`);
  };
  const tooBig = (message: string): never => {
    throw new LimitReached(message);
  };
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r'))
      i++;
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return true;
    }
    return false;
  };

  const parseString = (): string => {
    if (text[i] !== '"') fail('expected a string');
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const ch = text[i]!;
      if (ch === '"') {
        i++;
        return out;
      }
      if (ch === '\\') {
        i++;
        const esc = text[i];
        i++;
        switch (esc) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail('bad escape');
        }
        continue;
      }
      // A raw control character is invalid JSON, and accepting it would make this parser more
      // permissive than the databases it is comparing.
      if (ch < ' ') fail('raw control character in a string');
      out += ch;
      i++;
    }
  };

  const parseNumber = (): JsonNode => {
    const start = i;
    if (text[i] === '-') i++;
    if (text[i] === '0') i++;
    else if (text[i]! >= '1' && text[i]! <= '9')
      while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    else fail('expected a number');
    if (text[i] === '.') {
      i++;
      if (!(text[i]! >= '0' && text[i]! <= '9')) fail('expected a digit after the decimal point');
      while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!(text[i]! >= '0' && text[i]! <= '9')) fail('expected a digit in the exponent');
      while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    }
    return { k: 'num', literal: text.slice(start, i) };
  };

  const parseValue = (depth: number): JsonNode => {
    if (depth > limits.maxDepth) tooBig(`the document nests deeper than ${limits.maxDepth} levels`);
    if (++nodes > limits.maxNodes) tooBig(`the document holds more than ${limits.maxNodes} values`);
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const entries: [string, JsonNode][] = [];
      const seen = new Set<string>();
      const localDuplicates: string[] = [];
      ws();
      if (text[i] === '}') {
        i++;
        return { k: 'obj', entries, duplicates: localDuplicates };
      }
      for (;;) {
        ws();
        const key = parseString();
        if (seen.has(key)) {
          localDuplicates.push(key);
          duplicates.push(key);
        }
        seen.add(key);
        ws();
        if (text[i] !== ':') fail('expected a colon');
        i++;
        entries.push([key, parseValue(depth + 1)]);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return { k: 'obj', entries, duplicates: localDuplicates };
        }
        fail('expected a comma or a closing brace');
      }
    }
    if (ch === '[') {
      i++;
      const items: JsonNode[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return { k: 'arr', items };
      }
      for (;;) {
        items.push(parseValue(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return { k: 'arr', items };
        }
        fail('expected a comma or a closing bracket');
      }
    }
    if (ch === '"') return { k: 'str', v: parseString() };
    if (literal('true')) return { k: 'bool', v: true };
    if (literal('false')) return { k: 'bool', v: false };
    if (literal('null')) return { k: 'null' };
    return parseNumber();
  };

  try {
    const node = parseValue(0);
    ws();
    if (i !== text.length) fail('unexpected trailing content');
    return { ok: true, node, duplicates };
  } catch (err) {
    return {
      ok: false,
      limited: err instanceof LimitReached,
      error: err instanceof Error ? err.message : 'could not be parsed',
    };
  }
}

/**
 * Expands a JSON number literal into plain decimal digits, so two literals can be compared exactly.
 *
 * `decimalsEqual` compares scaled integers and does not read exponents, so `1e3` has to become
 * `1000` before it gets there — otherwise `1e3` and `1000` would compare unequal.
 */
export function expandJsonNumber(literal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal.trim());
  if (!match) return literal.trim();
  const [, sign = '', whole = '0', fraction = '', exponent] = match;
  const exp = exponent ? Number(exponent) : 0;
  const digits = `${whole}${fraction}`;
  // Where the decimal point sits once the exponent is applied.
  const point = whole.length + exp;
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = `${digits}${'0'.repeat(point - digits.length)}`;
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${sign}${out}`;
}

export type JsonVerdict = 'EQUAL' | 'DIFFERENT' | 'NOT_COMPARABLE';
export interface JsonComparison {
  verdict: JsonVerdict;
  /** Why the answer is unknown. Present only for NOT_COMPARABLE. */
  reason?: string;
}

/** Structural equality under the rules above. Key order ignored, array order significant. */
export function jsonNodesEqual(a: JsonNode, b: JsonNode): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'null':
      return true;
    case 'bool':
      return a.v === (b as { v: boolean }).v;
    case 'num':
      return decimalsEqual(expandJsonNumber(a.literal), expandJsonNumber((b as { literal: string }).literal));
    case 'str':
      return a.v === (b as { v: string }).v;
    case 'arr': {
      const other = b as { items: JsonNode[] };
      if (a.items.length !== other.items.length) return false;
      return a.items.every((item, index) => jsonNodesEqual(item, other.items[index]!));
    }
    case 'obj': {
      const other = b as { entries: [string, JsonNode][] };
      if (a.entries.length !== other.entries.length) return false;
      const rhs = new Map(other.entries);
      for (const [key, value] of a.entries) {
        const match = rhs.get(key);
        // `undefined` here means the key is absent, which is not the same as present-and-null.
        if (match === undefined) return false;
        if (!jsonNodesEqual(value, match)) return false;
      }
      return true;
    }
  }
}

/**
 * Compares two JSON documents as text.
 *
 * Identical text is equal without parsing — the common case, and it means a document that happens to
 * be past the limits still compares equal to a byte-identical copy of itself rather than reporting
 * that it could not be read.
 */
export function compareJsonText(
  a: string,
  b: string,
  limits: JsonCompareLimits = JSON_COMPARE_LIMITS,
): JsonComparison {
  if (a === b) return { verdict: 'EQUAL' };

  const left = parseJsonForCompare(a, limits);
  const right = parseJsonForCompare(b, limits);

  // A limit is a fact about us, not about the data, so it can never produce a verdict either way.
  const limited = [left, right].find((r) => !r.ok && r.limited) as { error: string } | undefined;
  if (limited) return { verdict: 'NOT_COMPARABLE', reason: limited.error };

  /**
   * Past the limits, a failure to parse is a fact about the data. One side a document and the other
   * not is a real difference; neither side a document means the text differs, which is all a text
   * comparison could have said anyway. Either way the answer is known, so it is not NOT_COMPARABLE.
   */
  if (!left.ok || !right.ok) return { verdict: 'DIFFERENT' };

  if (left.duplicates.length > 0 || right.duplicates.length > 0) {
    const keys = [...new Set([...left.duplicates, ...right.duplicates])].slice(0, 3);
    return {
      verdict: 'NOT_COMPARABLE',
      reason:
        `the document repeats the key ${keys.map((k) => `"${k}"`).join(', ')}, so which value counts ` +
        'depends on the reader rather than on the data',
    };
  }

  return { verdict: jsonNodesEqual(left.node, right.node) ? 'EQUAL' : 'DIFFERENT' };
}
