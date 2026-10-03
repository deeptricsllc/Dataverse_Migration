import { describe, expect, it } from 'vitest';
import {
  buildTableMetadata,
  buildTableSummaries,
  type SqlColumnRow,
  type SqlFkRow,
  type SqlPkRow,
  type SqlTableRow,
  type SqlUniqueRow,
} from '../../server/src/connectors/sql/catalog';
import {
  MYSQL_UNSUPPORTED_TYPES,
  mysqlCharLength,
  mysqlDateTimeBehavior,
  mysqlIntegerRange,
  mysqlToAttributeType,
} from '../../server/src/connectors/sql/mysql-catalog';
import {
  MYSQL_TYPES,
  mysqlQuoteIdent,
  mysqlQuoteTable,
} from '../../server/src/connectors/sql/mysql-connector';
import { toPositional } from '../../server/src/connectors/sql/shared';
import { familyOf } from '../../shared/metadata';

/**
 * MySQL, without a MySQL server.
 *
 * There is no embedded MySQL to test against the way PGlite gives real PostgreSQL, so this covers
 * what can be checked without one — and that is most of what actually goes wrong in a connector:
 * identifier quoting, parameter binding, the type vocabulary, and turning catalog rows into
 * metadata. What is NOT covered here is the driver conversation itself, which is stated plainly
 * rather than implied by a passing suite.
 */

describe('identifier quoting', () => {
  it('quotes with backticks', () => {
    expect(mysqlQuoteIdent('CustomerName')).toBe('`CustomerName`');
    // `order` is reserved; quoting is what makes it usable at all.
    expect(mysqlQuoteIdent('order')).toBe('`order`');
  });

  it('doubles an embedded backtick instead of letting it close the identifier', () => {
    expect(mysqlQuoteIdent('we`ird')).toBe('`we``ird`');
    expect(mysqlQuoteIdent('x`; DROP TABLE users; --')).toBe('`x``; DROP TABLE users; --`');
  });

  it('refuses what could not be a real identifier', () => {
    expect(() => mysqlQuoteIdent('')).toThrow(/Invalid identifier/);
    // MySQL's limit is 64, so anything longer never named a real column.
    expect(() => mysqlQuoteIdent('a'.repeat(65))).toThrow(/Invalid identifier/);
    expect(() => mysqlQuoteIdent('has\u0000null')).toThrow(/Invalid identifier/);
    // A backslash is an escape character inside an identifier under some SQL modes, so it is refused
    // rather than reasoned about.
    expect(() => mysqlQuoteIdent('back\\slash')).toThrow(/Invalid identifier/);
    expect(mysqlQuoteIdent('a'.repeat(64))).toBe(`\`${'a'.repeat(64)}\``);
  });

  it('drops the qualifier when it is the connected database', () => {
    // MySQL has no schema inside a database. The catalogue reports the database as the schema, so a
    // name arrives qualified — and re-emitting that qualifier is right only when it still matches.
    expect(mysqlQuoteTable('shop.customer', 'shop')).toBe('`customer`');
    expect(mysqlQuoteTable('SHOP.customer', 'shop')).toBe('`customer`');
    expect(mysqlQuoteTable('customer', 'shop')).toBe('`customer`');
    // A genuinely different database stays qualified.
    expect(mysqlQuoteTable('archive.customer', 'shop')).toBe('`archive`.`customer`');
  });
});

describe('parameter binding', () => {
  it('binds every occurrence separately, because MySQL placeholders are anonymous', () => {
    // PostgreSQL numbers its placeholders, so a repeated name reuses one position and one value.
    // MySQL's `?` do not, so the same name used twice must be bound twice — in order. Getting this
    // backwards silently shifts every later parameter.
    const mysql = toPositional('WHERE a = @x OR b = @x', { x: 7 }, 'question');
    expect(mysql.text).toBe('WHERE a = ? OR b = ?');
    expect(mysql.values).toEqual([7, 7]);

    const postgres = toPositional('WHERE a = @x OR b = @x', { x: 7 });
    expect(postgres.text).toBe('WHERE a = $1 OR b = $1');
    expect(postgres.values).toEqual([7]);
  });

  it('keeps the order of distinct names', () => {
    const out = toPositional(
      'WHERE a = @first AND b = @second AND c = @first',
      {
        first: 'A',
        second: 'B',
      },
      'question',
    );
    expect(out.text).toBe('WHERE a = ? AND b = ? AND c = ?');
    expect(out.values).toEqual(['A', 'B', 'A']);
  });

  it('does not confuse names sharing a prefix', () => {
    const out = toPositional('IN (@id0, @id1, @id10)', { id0: 'a', id1: 'b', id10: 'c' }, 'question');
    expect(out.values).toEqual(['a', 'b', 'c']);
  });

  it('leaves a value that looks like SQL as one bound value', () => {
    const out = toPositional('WHERE n = @n', { n: "'; DROP TABLE t; --" }, 'question');
    expect(out.text).toBe('WHERE n = ?');
    expect(out.values).toEqual(["'; DROP TABLE t; --"]);
  });
});

describe('the MySQL type vocabulary', () => {
  it('reads the modifiers MySQL keeps inside the type name', () => {
    expect(mysqlToAttributeType('varchar(160)', null, null, 160)).toBe('String');
    expect(mysqlToAttributeType('int(11) unsigned', 10, 0, null)).toBe('Integer');
    expect(mysqlToAttributeType('decimal(12,2)', 12, 2, null)).toBe('Decimal');
    expect(mysqlToAttributeType('bigint(20)', null, null, null)).toBe('BigInt');
    expect(mysqlToAttributeType('longtext', null, null, null)).toBe('Memo');
    expect(mysqlToAttributeType('json', null, null, null)).toBe('Memo');
    expect(mysqlToAttributeType('somethingexotic', null, null, null)).toBe('Other');
  });

  it('treats tinyint(1) as the boolean MySQL has always used it for', () => {
    expect(mysqlToAttributeType('tinyint(1)', 3, 0, null)).toBe('Boolean');
    // A wider tinyint is a small number, not a flag.
    expect(mysqlToAttributeType('tinyint(4)', 3, 0, null)).toBe('Integer');
    expect(mysqlToAttributeType('tinyint', 3, 0, null)).toBe('Integer');
  });

  it('reports the range an unsigned column actually holds', () => {
    // Reporting the signed range for an unsigned column would understate its maximum by half and
    // report a negative minimum it can never contain.
    expect(mysqlIntegerRange('int unsigned')).toEqual({ min: 0, max: 4_294_967_295 });
    expect(mysqlIntegerRange('int')).toEqual({ min: -2_147_483_648, max: 2_147_483_647 });
    expect(mysqlIntegerRange('tinyint(3) unsigned')).toEqual({ min: 0, max: 255 });
    expect(mysqlIntegerRange('tinyint')).toEqual({ min: -128, max: 127 });
    expect(mysqlIntegerRange('varchar(10)')).toBeNull();
    // Not 2^63: a JavaScript number cannot hold it exactly.
    expect(mysqlIntegerRange('bigint')!.max).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('distinguishes the two datetime types MySQL has', () => {
    // `timestamp` is stored as UTC and converted to the session zone; `datetime` is neither.
    expect(mysqlDateTimeBehavior('timestamp')).toBe('UserLocal');
    expect(mysqlDateTimeBehavior('datetime')).toBe('TimeZoneIndependent');
    expect(mysqlDateTimeBehavior('date')).toBe('DateOnly');
    expect(mysqlDateTimeBehavior('time')).toBeNull();
    // A time of day has nowhere faithful to go, so it stays text rather than getting an invented day.
    expect(mysqlToAttributeType('time', null, null, null)).toBe('String');
  });

  it('reports the declared length, and none where there is none', () => {
    expect(mysqlCharLength('varchar(40)', 40)).toBe(40);
    expect(mysqlCharLength('tinytext', 255)).toBe(255);
    expect(mysqlCharLength('longtext', 4294967295)).toBeNull();
    expect(mysqlCharLength('json', null)).toBeNull();
  });

  it('excludes what cannot be migrated faithfully, and nothing else', () => {
    expect(MYSQL_UNSUPPORTED_TYPES.has('blob')).toBe(true);
    expect(MYSQL_UNSUPPORTED_TYPES.has('geometry')).toBe(true);
    // `timestamp` is a real point in time in MySQL, as in PostgreSQL — only SQL Server means a row
    // version by it.
    expect(MYSQL_UNSUPPORTED_TYPES.has('timestamp')).toBe(false);
    expect(MYSQL_UNSUPPORTED_TYPES.has('json')).toBe(false);
  });
});

describe('catalog rows into metadata', () => {
  // information_schema rows exactly as MySQL projects them through the connector's queries.
  const table: SqlTableRow = {
    schemaName: 'shop',
    tableName: 'customer',
    objectType: 'table',
    rowCount: 1042,
  };
  const column = (over: Partial<SqlColumnRow>): SqlColumnRow => ({
    schemaName: 'shop',
    tableName: 'customer',
    columnName: 'x',
    dataType: 'varchar(50)',
    maxLength: 50,
    precision: null,
    scale: null,
    isNullable: 1 as unknown as SqlColumnRow['isNullable'],
    isIdentity: 0 as unknown as SqlColumnRow['isIdentity'],
    isComputed: 0 as unknown as SqlColumnRow['isComputed'],
    isRowVersion: 0 as unknown as SqlColumnRow['isRowVersion'],
    defaultDefinition: null,
    collation: 'utf8mb4_general_ci',
    columnId: 1,
    ...over,
  });

  const columns: SqlColumnRow[] = [
    column({
      columnName: 'customer_id',
      dataType: 'bigint(20) unsigned',
      maxLength: null,
      isNullable: 0 as never,
      isIdentity: 1 as never,
      columnId: 1,
    }),
    column({
      columnName: 'account_no',
      dataType: 'varchar(20)',
      maxLength: 20,
      isNullable: 0 as never,
      columnId: 2,
    }),
    column({
      columnName: 'company_name',
      dataType: 'varchar(160)',
      maxLength: 160,
      isNullable: 0 as never,
      columnId: 3,
    }),
    column({ columnName: 'notes', dataType: 'longtext', maxLength: 4294967295, columnId: 4 }),
    column({
      columnName: 'is_active',
      dataType: 'tinyint(1)',
      maxLength: null,
      defaultDefinition: '1',
      columnId: 5,
    }),
    column({ columnName: 'modified_at', dataType: 'timestamp', maxLength: null, columnId: 6 }),
    column({
      columnName: 'label',
      dataType: 'varchar(200)',
      maxLength: 200,
      isComputed: 1 as never,
      columnId: 7,
    }),
    column({ columnName: 'region_id', dataType: 'int(11)', maxLength: null, columnId: 8 }),
  ];
  const primaryKeys: SqlPkRow[] = [
    {
      schemaName: 'shop',
      tableName: 'customer',
      constraintName: 'PRIMARY',
      columnName: 'customer_id',
      keyOrdinal: 1,
    },
  ];
  const uniques: SqlUniqueRow[] = [
    {
      schemaName: 'shop',
      tableName: 'customer',
      keyName: 'account_no_uq',
      source: 'index',
      columnName: 'account_no',
      keyOrdinal: 1,
      isDisabled: 0 as unknown as SqlUniqueRow['isDisabled'],
      isFiltered: 0 as unknown as SqlUniqueRow['isFiltered'],
      filterDefinition: null,
    },
  ];
  const foreignKeys: SqlFkRow[] = [
    {
      constraintName: 'fk_region',
      parentSchema: 'shop',
      parentTable: 'customer',
      parentColumn: 'region_id',
      referencedSchema: 'shop',
      referencedTable: 'region',
      referencedColumn: 'region_id',
      ordinal: 1,
    },
  ];

  const meta = buildTableMetadata({ table, columns, primaryKeys, uniques, foreignKeys }, MYSQL_TYPES);
  const byName = new Map(meta.attributes.map((a) => [a.logicalName, a]));

  it('types the columns as MySQL means them', () => {
    expect(byName.get('company_name')).toMatchObject({ type: 'String', maxLength: 160 });
    expect(byName.get('notes')).toMatchObject({ type: 'Memo', maxLength: null });
    expect(byName.get('is_active')!.type).toBe('Boolean');
    expect(byName.get('customer_id')!.type).toBe('BigInt');
    expect(byName.get('modified_at')).toMatchObject({
      type: 'DateTime',
      dateTimeBehavior: 'UserLocal',
    });
    // An unsigned key reports a range starting at zero.
    expect(byName.get('customer_id')!.minValue).toBe(0);
    // Every column says it came from a SQL server, which is what drives value conversion.
    expect(meta.attributes.every((a) => familyOf(a) === 'SQL')).toBe(true);
  });

  it('knows what the server writes for itself', () => {
    // auto_increment arrives in EXTRA, not as a separate flag.
    expect(byName.get('customer_id')!.sql?.isIdentity).toBe(true);
    expect(byName.get('customer_id')!.isValidForCreate).toBe(false);
    // A generated column can be read, never written.
    expect(byName.get('label')!.sql?.isComputed).toBe(true);
    expect(byName.get('label')!.isValidForCreate).toBe(false);
    expect(byName.get('label')!.isValidForRead).toBe(true);
    // MySQL has no row version, and claiming otherwise would exclude real columns.
    expect(meta.attributes.every((a) => a.sql?.isRowVersion === false)).toBe(true);
    // NOT NULL with a default is not required of the source.
    expect(byName.get('is_active')!.requiredLevel).toBe('None');
    expect(byName.get('company_name')!.requiredLevel).toBe('ApplicationRequired');
  });

  it('turns a foreign key into a lookup, and a unique index into an alternate key', () => {
    expect(byName.get('region_id')!.type).toBe('Lookup');
    expect(byName.get('region_id')!.targets).toEqual(['shop.region']);
    expect(meta.keys.find((k) => k.logicalName === 'account_no_uq')!.attributes).toEqual(['account_no']);
    // MySQL has neither a partial nor a disabled index, so every unique index is usable.
    expect(meta.keys.every((k) => k.status === 'Active')).toBe(true);
  });

  it('identifies a row by its single primary key, and names it for display', () => {
    expect(meta.primaryIdAttribute).toBe('customer_id');
    expect(meta.primaryNameAttribute).toBe('company_name');
  });

  it('reports the row estimate as one', () => {
    const [summary] = buildTableSummaries([table]);
    expect(summary.logicalName).toBe('shop.customer');
    expect(summary.isView).toBe(false);
    // TABLE_ROWS from InnoDB can be far out, which is why a count from it is labelled approximate
    // wherever it is used.
    expect(table.rowCount).toBe(1042);
    const [view] = buildTableSummaries([{ ...table, tableName: 'active_customer', objectType: 'view' }]);
    expect(view.isView).toBe(true);
  });
});
