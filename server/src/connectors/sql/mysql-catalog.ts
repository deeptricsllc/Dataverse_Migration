import type { AttributeType } from '../../../../shared/metadata';

/**
 * MySQL's catalog, projected into the same row shapes SQL Server and PostgreSQL produce.
 *
 * One thing about MySQL changes the shape of everything here: it has no schema layer. A "schema" IS
 * a database, so `information_schema.TABLE_SCHEMA` is the database name, and a table inside the
 * connected database needs no qualifier at all. The queries therefore filter on `DATABASE()` and
 * report the schema as the database, which keeps the shared normalization working while never
 * producing a `db.table` name that MySQL would reject.
 *
 * Read-only, and every one filters to the connected database — a login with rights on several must
 * not have another one's tables appear in this connection's catalogue.
 */

/**
 * Tables and views. `TABLE_ROWS` is the storage engine's estimate, and for InnoDB it can be out by a
 * wide margin, which is exactly why a count from it is reported as approximate.
 */
export const MYSQL_TABLES_QUERY = `
  SELECT TABLE_SCHEMA AS schemaName,
         TABLE_NAME   AS tableName,
         CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS objectType,
         TABLE_ROWS   AS rowCount
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME`;

/**
 * Columns.
 *
 * `EXTRA` carries what MySQL has instead of separate flags: `auto_increment` for a generated key and
 * `VIRTUAL GENERATED` / `STORED GENERATED` for a computed column. `COLUMN_TYPE` is kept as the raw
 * type because it is the only place the display width and `unsigned` appear — and `unsigned` changes
 * the range a column can hold.
 */
export const MYSQL_COLUMNS_QUERY = `
  SELECT TABLE_SCHEMA                                          AS schemaName,
         TABLE_NAME                                            AS tableName,
         COLUMN_NAME                                           AS columnName,
         COLUMN_TYPE                                           AS dataType,
         CHARACTER_MAXIMUM_LENGTH                              AS maxLength,
         NUMERIC_PRECISION                                     AS \`precision\`,
         NUMERIC_SCALE                                         AS scale,
         CASE WHEN IS_NULLABLE = 'YES' THEN 1 ELSE 0 END       AS isNullable,
         CASE WHEN EXTRA LIKE '%auto_increment%' THEN 1 ELSE 0 END AS isIdentity,
         CASE WHEN EXTRA LIKE '%GENERATED%' THEN 1 ELSE 0 END  AS isComputed,
         0                                                     AS isRowVersion,
         COLUMN_DEFAULT                                        AS defaultDefinition,
         COLLATION_NAME                                        AS collation,
         ORDINAL_POSITION                                      AS columnId
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME, ORDINAL_POSITION`;

export const MYSQL_PRIMARY_KEYS_QUERY = `
  SELECT k.TABLE_SCHEMA   AS schemaName,
         k.TABLE_NAME     AS tableName,
         k.CONSTRAINT_NAME AS constraintName,
         k.COLUMN_NAME    AS columnName,
         k.ORDINAL_POSITION AS keyOrdinal
  FROM information_schema.KEY_COLUMN_USAGE k
  JOIN information_schema.TABLE_CONSTRAINTS c
    ON c.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
   AND c.CONSTRAINT_NAME = k.CONSTRAINT_NAME
   AND c.TABLE_NAME = k.TABLE_NAME
  WHERE k.TABLE_SCHEMA = DATABASE()
    AND c.CONSTRAINT_TYPE = 'PRIMARY KEY'
  ORDER BY k.TABLE_NAME, k.ORDINAL_POSITION`;

/**
 * Unique indexes that are not the primary key.
 *
 * MySQL has no partial index and no disabled index, so both flags are always false — stated here
 * rather than left to a reader to wonder about. `NON_UNIQUE = 0` is the unique ones.
 */
export const MYSQL_UNIQUE_KEYS_QUERY = `
  SELECT TABLE_SCHEMA AS schemaName,
         TABLE_NAME   AS tableName,
         INDEX_NAME   AS keyName,
         'index'      AS source,
         COLUMN_NAME  AS columnName,
         SEQ_IN_INDEX AS keyOrdinal,
         0            AS isDisabled,
         0            AS isFiltered,
         NULL         AS filterDefinition
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND NON_UNIQUE = 0
    AND INDEX_NAME <> 'PRIMARY'
  ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

export const MYSQL_FOREIGN_KEYS_QUERY = `
  SELECT k.CONSTRAINT_NAME            AS constraintName,
         k.TABLE_SCHEMA               AS parentSchema,
         k.TABLE_NAME                 AS parentTable,
         k.COLUMN_NAME                AS parentColumn,
         k.REFERENCED_TABLE_SCHEMA    AS referencedSchema,
         k.REFERENCED_TABLE_NAME      AS referencedTable,
         k.REFERENCED_COLUMN_NAME     AS referencedColumn,
         k.ORDINAL_POSITION           AS ordinal
  FROM information_schema.KEY_COLUMN_USAGE k
  WHERE k.TABLE_SCHEMA = DATABASE()
    AND k.REFERENCED_TABLE_NAME IS NOT NULL
  ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`;

export const MYSQL_VERSION_QUERY = `SELECT VERSION() AS version, DATABASE() AS db`;
export const MYSQL_WHOAMI_QUERY = `SELECT CURRENT_USER() AS login, DATABASE() AS db`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** MySQL types with no faithful home in the normalized model. */
export const MYSQL_UNSUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'bit',
]);

/**
 * `COLUMN_TYPE` without its modifiers: `int(11) unsigned` -> `int`.
 *
 * The modifiers still matter, which is why they are read separately rather than thrown away — an
 * unsigned column holds a different range, and `tinyint(1)` is how MySQL stores a boolean.
 */
const baseType = (columnType: string) =>
  columnType
    .trim()
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\s+(unsigned|zerofill)/g, '')
    .trim();

const isUnsigned = (columnType: string) => /\bunsigned\b/i.test(columnType);

/** Signed and unsigned widths, because a column's range is a fact worth reporting correctly. */
const SIGNED: Record<string, { min: number; max: number }> = {
  tinyint: { min: -128, max: 127 },
  smallint: { min: -32_768, max: 32_767 },
  mediumint: { min: -8_388_608, max: 8_388_607 },
  int: { min: -2_147_483_648, max: 2_147_483_647 },
  integer: { min: -2_147_483_648, max: 2_147_483_647 },
  bigint: { min: -9_007_199_254_740_991, max: 9_007_199_254_740_991 },
};
const UNSIGNED: Record<string, { min: number; max: number }> = {
  tinyint: { min: 0, max: 255 },
  smallint: { min: 0, max: 65_535 },
  mediumint: { min: 0, max: 16_777_215 },
  int: { min: 0, max: 4_294_967_295 },
  integer: { min: 0, max: 4_294_967_295 },
  // Beyond what a JavaScript number holds exactly; the safe bound is reported rather than a lie.
  bigint: { min: 0, max: 9_007_199_254_740_991 },
};

export const mysqlIntegerRange = (columnType: string) => {
  const t = baseType(columnType);
  return (isUnsigned(columnType) ? UNSIGNED[t] : SIGNED[t]) ?? null;
};

/** Character length. MySQL reports characters already, and a text blob has no declared limit. */
export const mysqlCharLength = (columnType: string, maxLength: number | null): number | null => {
  const t = baseType(columnType);
  if (t === 'tinytext') return 255;
  if (t === 'text' || t === 'mediumtext' || t === 'longtext' || t === 'json') return null;
  return maxLength && maxLength > 0 ? maxLength : null;
};

export const mysqlDateTimeBehavior = (columnType: string): string | null => {
  const t = baseType(columnType);
  if (t === 'date') return 'DateOnly';
  // `timestamp` is stored as UTC and converted to the session zone; `datetime` is neither.
  if (t === 'timestamp') return 'UserLocal';
  if (t === 'datetime') return 'TimeZoneIndependent';
  return null;
};

/** One MySQL column type, in the normalized model. */
export function mysqlToAttributeType(
  columnType: string,
  precision: number | null,
  scale: number | null,
  maxLength: number | null,
): AttributeType {
  const t = baseType(columnType);
  // `tinyint(1)` is how MySQL has always stored a boolean, and the driver returns 0/1 for it.
  if (t === 'tinyint' && /\(1\)/.test(columnType)) return 'Boolean';
  switch (t) {
    case 'bool':
    case 'boolean':
      return 'Boolean';
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'integer':
    case 'year':
      return 'Integer';
    case 'bigint':
      return 'BigInt';
    case 'decimal':
    case 'numeric':
      return 'Decimal';
    case 'float':
    case 'double':
    case 'real':
      return 'Double';
    case 'date':
    case 'datetime':
    case 'timestamp':
      return 'DateTime';
    case 'time':
      // A time of day with no date has nowhere faithful to go, so it stays text rather than becoming
      // a DateTime on an invented day.
      return 'String';
    case 'char':
    case 'varchar':
    case 'tinytext': {
      const length = mysqlCharLength(columnType, maxLength);
      return length !== null && length <= 4000 ? 'String' : 'Memo';
    }
    case 'text':
    case 'mediumtext':
    case 'longtext':
    case 'json':
      return 'Memo';
    case 'enum':
    case 'set':
      // An enum's allowed values are in the raw type; it is text until somebody maps it onto a choice.
      return 'String';
    default:
      void precision;
      void scale;
      return 'Other';
  }
}
