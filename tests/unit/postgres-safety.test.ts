import { describe, expect, it } from 'vitest';
import { pgQuoteIdent, pgQuoteTable } from '../../server/src/connectors/sql/postgres-connector';
import {
  pgCharLength,
  pgDateTimeBehavior,
  pgIntegerRange,
  pgToAttributeType,
  PG_UNSUPPORTED_TYPES,
} from '../../server/src/connectors/sql/postgres-catalog';
import { toPositional } from '../../server/src/connectors/sql/shared';
import type { FieldValue } from '../../shared/metadata';

/**
 * The two places a PostgreSQL connector could be made to run something it was not asked to: an
 * identifier, which cannot be a parameter and so has to be quoted, and a value, which must always be
 * one and never text in a statement.
 */

describe('identifier quoting', () => {
  it('quotes so PostgreSQL keeps the catalog casing', () => {
    // Unquoted identifiers fold to lower case, which would stop matching the real column name.
    expect(pgQuoteIdent('CustomerName')).toBe('"CustomerName"');
    expect(pgQuoteIdent('order')).toBe('"order"');
    expect(pgQuoteTable('sales.Customer')).toBe('"sales"."Customer"');
    // No schema means the default one, stated rather than left to the search_path.
    expect(pgQuoteTable('customer')).toBe('"public"."customer"');
  });

  it('neutralizes a quote instead of letting it end the identifier', () => {
    expect(pgQuoteIdent('we"ird')).toBe('"we""ird"');
    // The classic attempt: closing the quote to append a statement. Doubling makes it one name.
    expect(pgQuoteIdent('x"; DROP TABLE users; --')).toBe('"x""; DROP TABLE users; --"');
    expect(pgQuoteTable('s."; DROP TABLE t; --')).toBe('"s"."""; DROP TABLE t; --"');
  });

  it('refuses what cannot be a real identifier', () => {
    expect(() => pgQuoteIdent('')).toThrow(/Invalid identifier/);
    // PostgreSQL truncates at 63 bytes, so anything longer never named a real column.
    expect(() => pgQuoteIdent('a'.repeat(64))).toThrow(/Invalid identifier/);
    expect(() => pgQuoteIdent('has\u0000null')).toThrow(/Invalid identifier/);
    expect(pgQuoteIdent('a'.repeat(63))).toBe(`"${'a'.repeat(63)}"`);
  });
});

describe('named parameters as positional ones', () => {
  const values = (text: string, params: Record<string, FieldValue>) => toPositional(text, params);

  it('numbers each name in the order it first appears', () => {
    const out = values('SELECT * FROM t WHERE a = @alpha AND b = @beta', { alpha: 1, beta: 'two' });
    expect(out.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(out.values).toEqual([1, 'two']);
  });

  it('reuses one position for a name used twice', () => {
    const out = values('SELECT * FROM t WHERE a = @x OR b = @x', { x: 7 });
    expect(out.text).toBe('SELECT * FROM t WHERE a = $1 OR b = $2'.replace('$2', '$1'));
    expect(out.values).toEqual([7]);
  });

  it('does not confuse names that share a prefix', () => {
    // `@id` and `@id1` are different parameters; matching greedily would bind one to the other.
    const out = values('WHERE a = @id AND b = @id1 AND c = @id10', { id: 'a', id1: 'b', id10: 'c' });
    expect(out.text).toBe('WHERE a = $1 AND b = $2 AND c = $3');
    expect(out.values).toEqual(['a', 'b', 'c']);
  });

  it('binds a lookup as the key it points at, and an array as text', () => {
    const out = values('WHERE owner = @o AND tags = @t', {
      o: { id: '42', logicalName: 'systemuser' },
      t: [1, 2, 3],
    });
    expect(out.values).toEqual([42, '1,2,3']);
    const guid = values('WHERE owner = @o', {
      o: { id: '9f1c2b3a-0000-0000-0000-000000000001', logicalName: 'systemuser' },
    });
    expect(guid.values).toEqual(['9f1c2b3a-0000-0000-0000-000000000001']);
  });

  it('refuses a statement whose parameter was never supplied', () => {
    // Binding nothing would silently become NULL and quietly change what the query matches.
    expect(() => values('WHERE a = @missing', {})).toThrow(/@missing was not supplied/);
  });

  it('leaves a value that looks like SQL as a single bound value', () => {
    const out = values('WHERE name = @n', { n: "'; DROP TABLE t; --" });
    expect(out.text).toBe('WHERE name = $1');
    expect(out.values).toEqual(["'; DROP TABLE t; --"]);
  });
});

describe('postgres type vocabulary', () => {
  it('maps the types with modifiers in their name', () => {
    expect(pgToAttributeType('character varying(160)', null, null, 160)).toBe('String');
    expect(pgToAttributeType('numeric(12,2)', 12, 2, null)).toBe('Decimal');
    expect(pgToAttributeType('timestamp with time zone', null, null, null)).toBe('DateTime');
    expect(pgToAttributeType('double precision', null, null, null)).toBe('Double');
    expect(pgToAttributeType('bigint', null, null, null)).toBe('BigInt');
    expect(pgToAttributeType('uuid', null, null, null)).toBe('Uniqueidentifier');
    expect(pgToAttributeType('some_custom_enum', null, null, null)).toBe('Other');
  });

  it('treats unbounded and over-long text as a memo', () => {
    expect(pgToAttributeType('text', null, null, null)).toBe('Memo');
    expect(pgToAttributeType('varchar', null, null, null)).toBe('Memo');
    expect(pgToAttributeType('varchar(8000)', null, null, 8000)).toBe('Memo');
    expect(pgCharLength('text', null)).toBeNull();
    expect(pgCharLength('varchar(20)', 20)).toBe(20);
  });

  it('does not call a PostgreSQL timestamp a row version', () => {
    // SQL Server's unsupported list contains 'timestamp' because there it is a row version. Sharing
    // that set would mark every PostgreSQL timestamp column unmigratable.
    expect(PG_UNSUPPORTED_TYPES.has('timestamp')).toBe(false);
    expect(PG_UNSUPPORTED_TYPES.has('bytea')).toBe(true);
    expect(pgDateTimeBehavior('timestamp')).toBe('TimeZoneIndependent');
    expect(pgDateTimeBehavior('timestamptz')).toBe('UserLocal');
    expect(pgDateTimeBehavior('date')).toBe('DateOnly');
    expect(pgDateTimeBehavior('integer')).toBeNull();
  });

  it('reports integer widths that are actually true', () => {
    expect(pgIntegerRange('smallint')).toEqual({ min: -32_768, max: 32_767 });
    expect(pgIntegerRange('int4')).toEqual({ min: -2_147_483_648, max: 2_147_483_647 });
    // Not 2^63: a JavaScript number cannot hold it exactly, so the safe bound is reported instead
    // of a figure the platform could not compare against.
    expect(pgIntegerRange('bigint')!.max).toBe(Number.MAX_SAFE_INTEGER);
    expect(pgIntegerRange('text')).toBeNull();
    // PostgreSQL has no tinyint, so claiming a 0-255 range for one would be inventing a constraint.
    expect(pgIntegerRange('tinyint')).toBeNull();
  });
});
