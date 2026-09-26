import {
  isLookupValue,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
  type TableMetadata,
} from '../../../../shared/metadata';
import { DataverseError } from '../../dataverse/errors';
import type { WriteRecord } from '../types';

/**
 * The parts of a relational connector that have nothing to do with which relational database it is.
 *
 * Turning a driver row into the normalized record model, turning a normalized value into something
 * a driver can bind, and deciding which columns a write may touch are all the same reasoning
 * whichever server is on the other end. They live here so two dialects cannot quietly disagree about
 * them — a disagreement that would show up as wrong data rather than as an error.
 *
 * What is *not* here: SQL text, identifier quoting, paging syntax, error codes and the driver. Those
 * genuinely differ, and pretending otherwise would be worse than the duplication it avoided.
 */

/** Quotes one identifier for a particular server. */
export type QuoteIdent = (name: string) => string;

/** The columns a read has to ask for, and the attributes they correspond to. */
export function selectList(
  table: TableMetadata,
  columns: string[],
  quoteIdent: QuoteIdent,
): { list: string; attrs: AttributeMeta[] } {
  const byName = new Map(table.attributes.map((a) => [a.logicalName, a]));
  const attrs = [...new Set(columns)]
    .map((c) => byName.get(c))
    .filter((a): a is AttributeMeta => !!a && a.isValidForRead);
  // The primary key is always read: it is the record's identity, whether or not it was asked for.
  const names = [table.primaryIdAttribute, ...attrs.map((a) => a.logicalName)];
  return { list: [...new Set(names)].map(quoteIdent).join(', '), attrs };
}

/** A driver row as a normalized record. */
export function toRecord(
  table: TableMetadata,
  row: Record<string, unknown>,
  attrs: AttributeMeta[],
): DvRecord {
  const values: Record<string, FieldValue> = {};
  for (const a of attrs) {
    if (a.logicalName === table.primaryIdAttribute) continue;
    values[a.logicalName] = fromSql(row[a.logicalName], a);
  }
  return { id: String(row[table.primaryIdAttribute]), values };
}

/**
 * A driver value in the normalized model; a foreign key becomes a lookup.
 *
 * `numericAsString` exists for drivers that hand back exact numerics as text to avoid losing
 * precision — PostgreSQL's does. Parsing it here would undo that protection, so an exact numeric is
 * left as the string the driver chose to send.
 */
export function fromSql(raw: unknown, attr: AttributeMeta): FieldValue {
  if (raw === null || raw === undefined) return null;
  if (attr.type === 'Lookup' && attr.targets?.length) {
    return { id: String(raw), logicalName: attr.targets[0] };
  }
  if (raw instanceof Date) {
    return attr.dateTimeBehavior === 'DateOnly' ? raw.toISOString().slice(0, 10) : raw.toISOString();
  }
  if (Buffer.isBuffer(raw)) return raw.toString('base64');
  if (typeof raw === 'bigint') return Number(raw);
  return raw as FieldValue;
}

/** A normalized value as something a driver will accept. */
export function bindValue(value: FieldValue): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (isLookupValue(value)) {
    // A lookup binds as the key it points at; a numeric key is bound as a number so the server does
    // not have to coerce it.
    const id = value.id;
    return /^-?\d+$/.test(id) ? Number(id) : id;
  }
  if (Array.isArray(value)) return value.join(',');
  return value;
}

/** The columns a create or update may write, and the parameters to bind for them. */
export function writableValues(
  table: TableMetadata,
  record: WriteRecord,
  forCreate: boolean,
): { columns: string[]; params: Record<string, FieldValue> } {
  const attrs = new Map(table.attributes.map((a) => [a.logicalName, a]));
  const params: Record<string, FieldValue> = {};
  const columns: string[] = [];
  for (const [name, value] of Object.entries(record.values)) {
    const a = attrs.get(name);
    if (!a) throw new DataverseError('VALIDATION', `Invalid column name '${name}'.`, 400, '207');
    // Server-generated and key columns are skipped rather than refused: a caller handing over a
    // whole record should not have to know which columns the server owns.
    if (forCreate ? !a.isValidForCreate : !a.isValidForUpdate) continue;
    columns.push(name);
    params[`c${columns.length - 1}`] = bindValue(value) as FieldValue;
  }
  return { columns, params };
}

/** The watermark column, confirmed to exist on this table before it reaches a query. */
export function watermarkColumn(table: TableMetadata, field: string): string {
  const attr = table.attributes.find((a) => a.logicalName.toLowerCase() === field.toLowerCase());
  if (!attr) {
    throw new Error(`Cannot read incrementally: ${table.logicalName} has no column ${field}`);
  }
  return attr.logicalName;
}

/** Restricts discovered rows to the schemas a connection was configured for. */
export function schemaFilter<T extends { schemaName: string }>(
  rows: T[],
  schemas: string[] | undefined,
): T[] {
  if (!schemas?.length) return rows;
  const set = new Set(schemas.map((s) => s.toLowerCase()));
  return rows.filter((r) => set.has(r.schemaName.toLowerCase()));
}

/**
 * Rewrites `@name` placeholders as the positional form a driver expects.
 *
 * Every SQL string in these connectors is written with named placeholders, because that is what
 * makes them readable and what stops a parameter being bound to the wrong slot. Neither PostgreSQL
 * nor MySQL has named parameters, so the translation happens once, here, rather than by writing
 * every query twice.
 *
 * `style` differs in more than appearance. PostgreSQL numbers its placeholders, so a name used twice
 * reuses one position and is bound once. MySQL's `?` are anonymous, so the same name used twice has
 * to be bound twice, in order. Getting that backwards silently shifts every later parameter.
 */
export function toPositional(
  text: string,
  params: Record<string, FieldValue>,
  style: 'numbered' | 'question' = 'numbered',
): { text: string; values: (string | number | boolean | Date | null)[] } {
  const order: string[] = [];
  // Word-boundary-terminated so `@id1` is never matched as `@id` followed by a stray `1`.
  const rewritten = text.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    if (style === 'question') {
      // Anonymous placeholders: every occurrence is its own parameter.
      order.push(name);
      return '?';
    }
    let at = order.indexOf(name);
    if (at < 0) {
      order.push(name);
      at = order.length - 1;
    }
    return `$${at + 1}`;
  });
  const values = order.map((name) => {
    if (!(name in params)) {
      throw new DataverseError('VALIDATION', `Query parameter @${name} was not supplied.`, 500, 'PARAM');
    }
    return bindValue(params[name]);
  });
  return { text: rewritten, values };
}
