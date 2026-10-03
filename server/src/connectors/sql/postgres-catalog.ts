import type { AttributeType } from '../../../../shared/metadata';

/**
 * PostgreSQL's system catalog, projected into exactly the row shapes the SQL Server catalog already
 * produces (`SqlTableRow`, `SqlColumnRow`, …).
 *
 * That is the whole trick: once both servers answer with the same columns, every bit of
 * normalization — building table summaries, resolving foreign keys into lookups, picking a primary
 * name, grouping alternate keys — is shared rather than written twice. The queries read `pg_catalog`
 * rather than `information_schema` where the latter cannot answer (identity vs serial, partial
 * indexes, row estimates), and are read-only.
 */

/**
 * Tables and views. `reltuples` is the planner's estimate, which is what makes a count from here
 * approximate; -1 means the relation has never been analyzed, and is reported as unknown.
 */
export const PG_TABLES_QUERY = `
  SELECT n.nspname                                              AS "schemaName",
         c.relname                                              AS "tableName",
         CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS "objectType",
         CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "rowCount"
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND n.nspname NOT LIKE 'pg_temp%'
    AND n.nspname NOT LIKE 'pg_toast_temp%'
  ORDER BY n.nspname, c.relname`;

/**
 * Columns, with the facts the normalized model needs.
 *
 * `format_type` is used rather than `information_schema.data_type` because it reports the type the
 * way PostgreSQL itself names it. Identity covers both the SQL-standard `GENERATED … AS IDENTITY`
 * and the older `serial`, which is a plain default of `nextval(...)` — a migration that mistook one
 * for a writable column would try to supply its own keys.
 */
export const PG_COLUMNS_QUERY = `
  SELECT n.nspname                                   AS "schemaName",
         c.relname                                   AS "tableName",
         a.attname                                   AS "columnName",
         format_type(a.atttypid, NULL)               AS "dataType",
         CASE
           WHEN t.typname IN ('varchar', 'bpchar', 'char') AND a.atttypmod > 4 THEN a.atttypmod - 4
           ELSE NULL
         END                                         AS "maxLength",
         CASE
           WHEN t.typname = 'numeric' AND a.atttypmod > 0 THEN ((a.atttypmod - 4) >> 16) & 65535
           WHEN t.typname IN ('int2', 'int4', 'int8', 'float4', 'float8') THEN information_schema._pg_numeric_precision(a.atttypid, a.atttypmod)
           ELSE NULL
         END                                         AS "precision",
         CASE
           WHEN t.typname = 'numeric' AND a.atttypmod > 0 THEN (a.atttypmod - 4) & 65535
           ELSE NULL
         END                                         AS "scale",
         NOT a.attnotnull                            AS "isNullable",
         (a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%') AS "isIdentity",
         (a.attgenerated <> '')                      AS "isComputed",
         false                                       AS "isRowVersion",
         pg_get_expr(d.adbin, d.adrelid)             AS "defaultDefinition",
         co.collname                                 AS "collation",
         a.attnum                                    AS "columnId"
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation AND co.collname <> 'default'
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND n.nspname NOT LIKE 'pg_temp%'
  ORDER BY n.nspname, c.relname, a.attnum`;

export const PG_PRIMARY_KEYS_QUERY = `
  SELECT n.nspname        AS "schemaName",
         c.relname        AS "tableName",
         con.conname      AS "constraintName",
         a.attname        AS "columnName",
         k.ord            AS "keyOrdinal"
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
  WHERE con.contype = 'p'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY n.nspname, c.relname, k.ord`;

/**
 * Unique constraints and unique indexes that are not the primary key.
 *
 * A partial index (`WHERE …`) is reported as filtered, because it only enforces uniqueness over part
 * of the table and therefore cannot be trusted as a whole-table alternate key. PostgreSQL has no
 * disabled index, so `isDisabled` reflects an index that is not yet valid — the state a concurrent
 * build leaves behind when it fails.
 */
export const PG_UNIQUE_KEYS_QUERY = `
  SELECT n.nspname                                        AS "schemaName",
         c.relname                                        AS "tableName",
         ic.relname                                       AS "keyName",
         CASE WHEN con.oid IS NULL THEN 'index' ELSE 'constraint' END AS "source",
         a.attname                                        AS "columnName",
         k.ord                                            AS "keyOrdinal",
         (NOT i.indisvalid OR NOT i.indisready)           AS "isDisabled",
         (i.indpred IS NOT NULL)                          AS "isFiltered",
         pg_get_expr(i.indpred, i.indrelid)               AS "filterDefinition"
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
  LEFT JOIN pg_catalog.pg_constraint con ON con.conindid = i.indexrelid AND con.contype = 'u'
  WHERE i.indisunique
    AND NOT i.indisprimary
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY n.nspname, c.relname, ic.relname, k.ord`;

export const PG_FOREIGN_KEYS_QUERY = `
  SELECT con.conname   AS "constraintName",
         pn.nspname    AS "parentSchema",
         pc.relname    AS "parentTable",
         pa.attname    AS "parentColumn",
         rn.nspname    AS "referencedSchema",
         rc.relname    AS "referencedTable",
         ra.attname    AS "referencedColumn",
         k.ord         AS "ordinal"
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class pc ON pc.oid = con.conrelid
  JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
  JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
  JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
  JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(parent_attnum, ref_attnum, ord) ON true
  JOIN pg_catalog.pg_attribute pa ON pa.attrelid = pc.oid AND pa.attnum = k.parent_attnum
  JOIN pg_catalog.pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = k.ref_attnum
  WHERE con.contype = 'f'
    AND pn.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY con.conname, k.ord`;

export const PG_VERSION_QUERY = `SELECT version() AS "version", current_database() AS "db"`;
export const PG_WHOAMI_QUERY = `SELECT current_user AS "login", current_database() AS "db"`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * PostgreSQL types with no faithful home in the normalized model.
 *
 * Note what is deliberately NOT here: `timestamp`. The SQL Server list excludes `timestamp` because
 * there it means a row version, not a point in time. In PostgreSQL it is an ordinary datetime, and
 * sharing that set would have marked every PostgreSQL timestamp column unmigratable.
 */
export const PG_UNSUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'bytea',
  'geometry',
  'geography',
  'tsvector',
  'tsquery',
  'pg_lsn',
  'txid_snapshot',
  'xid',
  'cid',
  'tid',
  'aclitem',
  'refcursor',
]);

/** Widths PostgreSQL's integer types actually hold, so a range check is real rather than assumed. */
const PG_INTEGER_RANGES: Record<string, { min: number; max: number }> = {
  smallint: { min: -32_768, max: 32_767 },
  int2: { min: -32_768, max: 32_767 },
  integer: { min: -2_147_483_648, max: 2_147_483_647 },
  int4: { min: -2_147_483_648, max: 2_147_483_647 },
  // Beyond IEEE-754 exact range; reported as the safe integer bound rather than a lie about 2^63.
  bigint: { min: -9_007_199_254_740_991, max: 9_007_199_254_740_991 },
  int8: { min: -9_007_199_254_740_991, max: 9_007_199_254_740_991 },
};

const normalize = (dataType: string) =>
  dataType
    .trim()
    .toLowerCase()
    // `character varying(160)` and `numeric(18,2)` carry their modifiers in the name.
    .replace(/\(.*\)$/, '')
    .replace(/\[\]$/, '')
    .trim();

export const pgIntegerRange = (dataType: string) => PG_INTEGER_RANGES[normalize(dataType)] ?? null;

/**
 * Character length. PostgreSQL reports it in characters already, and an unbounded `text` or
 * `varchar` has none — which is a fact worth keeping rather than replacing with a guess.
 */
export const pgCharLength = (dataType: string, maxLength: number | null): number | null => {
  const t = normalize(dataType);
  if (t === 'text' || t === 'citext' || t === 'json' || t === 'jsonb' || t === 'xml') return null;
  return maxLength && maxLength > 0 ? maxLength : null;
};

export const pgDateTimeBehavior = (dataType: string): string | null => {
  const t = normalize(dataType);
  if (t === 'date') return 'DateOnly';
  if (t === 'timestamptz' || t === 'timestamp with time zone') return 'UserLocal';
  if (t === 'timestamp' || t === 'timestamp without time zone') return 'TimeZoneIndependent';
  return null;
};

/** One PostgreSQL type, in the normalized model. */
export function pgToAttributeType(
  dataType: string,
  precision: number | null,
  scale: number | null,
  maxLength: number | null,
): AttributeType {
  const t = normalize(dataType);
  switch (t) {
    case 'boolean':
    case 'bool':
      return 'Boolean';
    case 'smallint':
    case 'int2':
    case 'integer':
    case 'int4':
      return 'Integer';
    case 'bigint':
    case 'int8':
      return 'BigInt';
    case 'numeric':
    case 'decimal':
      // An exact numeric with no fractional part is an integer everywhere it matters.
      return scale !== null && scale > 0 ? 'Decimal' : 'Decimal';
    case 'money':
      return 'Money';
    case 'real':
    case 'float4':
    case 'double precision':
    case 'float8':
      return 'Double';
    case 'date':
    case 'timestamp':
    case 'timestamptz':
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return 'DateTime';
    case 'uuid':
      return 'Uniqueidentifier';
    case 'char':
    case 'bpchar':
    case 'character':
    case 'varchar':
    case 'character varying':
    case 'citext': {
      const length = pgCharLength(dataType, maxLength);
      // Long or unbounded text behaves like a memo: the distinction drives which target columns it
      // can go into.
      return length !== null && length <= 4000 ? 'String' : 'Memo';
    }
    case 'text':
    case 'json':
    case 'jsonb':
    case 'xml':
      return 'Memo';
    default:
      void precision;
      return 'Other';
  }
}
