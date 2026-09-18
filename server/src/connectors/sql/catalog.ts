/**
 * SQL Server / Azure SQL catalog: the queries that describe a database, and the pure functions
 * that turn their rows into the shared metadata model.
 *
 * This module deliberately does not import `mssql` and never opens a connection. The connector
 * executes the exported query text and hands the rows back here, which keeps every normalization
 * decision (what is read-only, what is required, which unique index is trustworthy) unit-testable
 * without a database.
 *
 * All queries target the system catalog views and are compatible with SQL Server 2016+ and Azure
 * SQL Database. None of them interpolate anything: they are constants, executed as-is, so there is
 * no injection surface and the server can cache their plans.
 */
import type {
  AlternateKeyMeta,
  AttributeMeta,
  AttributeType,
  RelationshipMeta,
  TableMetadata,
  TableSummary,
} from '../../../../shared/metadata';
import {
  sqlCharLength,
  sqlDateTimeBehavior,
  sqlIntegerRange,
  sqlToAttributeType,
  SQL_UNSUPPORTED_TYPES,
} from './type-map';

// --- queries ---------------------------------------------------------------------------------

/** Tables and views with an approximate row count. Uses sys.tables, sys.views, sys.schemas, sys.dm_db_partition_stats. */
export const TABLES_QUERY = `
SELECT s.name AS schemaName,
       t.name AS tableName,
       'table' AS objectType,
       ISNULL((SELECT SUM(ps.row_count)
               FROM sys.dm_db_partition_stats ps
               WHERE ps.object_id = t.object_id AND ps.index_id IN (0, 1)), 0) AS rowCount
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
UNION ALL
SELECT s.name AS schemaName,
       v.name AS tableName,
       'view' AS objectType,
       NULL AS rowCount
FROM sys.views v
JOIN sys.schemas s ON s.schema_id = v.schema_id
WHERE v.is_ms_shipped = 0
ORDER BY schemaName, tableName`;

/** Every column of every table and view. Uses sys.columns, sys.objects, sys.schemas, sys.types, sys.computed_columns, sys.default_constraints. */
export const COLUMNS_QUERY = `
SELECT s.name AS schemaName,
       o.name AS tableName,
       c.name AS columnName,
       ty.name AS dataType,
       c.max_length AS maxLength,
       c.precision AS precision,
       c.scale AS scale,
       c.is_nullable AS isNullable,
       c.is_identity AS isIdentity,
       CAST(CASE WHEN cc.object_id IS NULL THEN 0 ELSE 1 END AS bit) AS isComputed,
       CAST(CASE WHEN ty.name IN ('timestamp', 'rowversion') THEN 1 ELSE 0 END AS bit) AS isRowVersion,
       dc.definition AS defaultDefinition,
       c.collation_name AS collation,
       c.column_id AS columnId
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'V')
ORDER BY s.name, o.name, c.column_id`;

/** Primary key columns in key order. Uses sys.key_constraints, sys.indexes, sys.index_columns, sys.columns, sys.tables, sys.schemas. */
export const PRIMARY_KEYS_QUERY = `
SELECT s.name AS schemaName,
       t.name AS tableName,
       kc.name AS constraintName,
       c.name AS columnName,
       ic.key_ordinal AS keyOrdinal
FROM sys.key_constraints kc
JOIN sys.tables t ON t.object_id = kc.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE kc.type = 'PK' AND t.is_ms_shipped = 0
ORDER BY s.name, t.name, kc.name, ic.key_ordinal`;

/**
 * Unique constraints and unique indexes, with the two facts that decide whether they can be used
 * for record matching (disabled, filtered). Uses sys.indexes, sys.index_columns, sys.key_constraints,
 * sys.columns, sys.tables, sys.schemas.
 */
export const UNIQUE_KEYS_QUERY = `
SELECT s.name AS schemaName,
       t.name AS tableName,
       i.name AS keyName,
       CASE WHEN kc.name IS NULL THEN 'index' ELSE 'constraint' END AS source,
       c.name AS columnName,
       ic.key_ordinal AS keyOrdinal,
       i.is_disabled AS isDisabled,
       i.has_filter AS isFiltered,
       i.filter_definition AS filterDefinition
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
LEFT JOIN sys.key_constraints kc ON kc.parent_object_id = i.object_id AND kc.unique_index_id = i.index_id AND kc.type = 'UQ'
WHERE i.is_unique = 1 AND i.is_primary_key = 0 AND t.is_ms_shipped = 0
ORDER BY s.name, t.name, i.name, ic.key_ordinal`;

/** Foreign key columns in constraint order. Uses sys.foreign_keys, sys.foreign_key_columns, sys.tables, sys.schemas, sys.columns. */
export const FOREIGN_KEYS_QUERY = `
SELECT fk.name AS constraintName,
       ps.name AS parentSchema,
       pt.name AS parentTable,
       pc.name AS parentColumn,
       rs.name AS referencedSchema,
       rt.name AS referencedTable,
       rc.name AS referencedColumn,
       fkc.constraint_column_id AS ordinal
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
ORDER BY ps.name, pt.name, fk.name, fkc.constraint_column_id`;

// --- row shapes ------------------------------------------------------------------------------

export interface SqlTableRow {
  schemaName: string;
  tableName: string;
  /** 'table' or 'view'. */
  objectType: string;
  /** Approximate for tables (partition statistics), null for views. */
  rowCount: number | null;
}

export interface SqlColumnRow {
  schemaName: string;
  tableName: string;
  columnName: string;
  dataType: string;
  /** Bytes, as sys.columns reports them; -1 for MAX. */
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  isNullable: boolean;
  isIdentity: boolean;
  isComputed: boolean;
  isRowVersion: boolean;
  defaultDefinition: string | null;
  collation: string | null;
  columnId: number;
}

export interface SqlPkRow {
  schemaName: string;
  tableName: string;
  constraintName: string;
  columnName: string;
  keyOrdinal: number;
}

export interface SqlUniqueRow {
  schemaName: string;
  tableName: string;
  keyName: string;
  /** 'constraint' for a UNIQUE constraint, 'index' for a standalone unique index. */
  source: string;
  columnName: string;
  keyOrdinal: number;
  isDisabled: boolean;
  isFiltered: boolean;
  filterDefinition: string | null;
}

export interface SqlFkRow {
  constraintName: string;
  parentSchema: string;
  parentTable: string;
  parentColumn: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
  ordinal: number;
}

export interface BuildTableMetadataInput {
  table: SqlTableRow;
  columns: SqlColumnRow[];
  primaryKeys: SqlPkRow[];
  uniques: SqlUniqueRow[];
  foreignKeys: SqlFkRow[];
}

// --- normalization ---------------------------------------------------------------------------

/**
 * The identifier used everywhere for a SQL table: `schema.table`, in the server's own casing.
 * SQL Server identifiers are usually case-insensitive but are stored with their declared case, and
 * a case-sensitive collation makes the difference real, so nothing here lower-cases them.
 */
export function sqlTableName(schema: string, table: string): string {
  return `${schema}.${table}`;
}

/** Tolerates drivers that surface `bit` as 0/1 instead of a boolean. */
const yes = (v: boolean | number | null | undefined): boolean => v === true || v === 1;

const isView = (row: SqlTableRow): boolean => String(row.objectType).toLowerCase() === 'view';

const sameTable = (row: { schemaName: string; tableName: string }, table: SqlTableRow): boolean =>
  row.schemaName.toLowerCase() === table.schemaName.toLowerCase() &&
  row.tableName.toLowerCase() === table.tableName.toLowerCase();

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** A column that could hold a human-readable label for the row. */
const NAME_LIKE = /name$|^name|title|description/i;

/** Types whose SQL `scale` is genuinely a count of decimal places. */
const FRACTIONAL_TYPES: ReadonlySet<AttributeType> = new Set(['Decimal', 'Money', 'Double']);

export function buildTableSummaries(rows: SqlTableRow[]): TableSummary[] {
  return rows.map((row) => ({
    logicalName: sqlTableName(row.schemaName, row.tableName),
    schemaName: row.tableName,
    displayName: row.tableName,
    // SQL has no entity sets; reusing the logical name keeps the field non-empty and unique so
    // callers that key on it (caches, report rows) behave the same for both providers.
    entitySetName: sqlTableName(row.schemaName, row.tableName),
    // Discovery does not read keys, so the primary id is unknown until buildTableMetadata runs.
    primaryIdAttribute: '',
    primaryNameAttribute: null,
    // Every table in a customer database is customer data; there is no "managed solution"
    // equivalent in SQL, so this is always true rather than a guess based on the schema name.
    isCustom: true,
    ownershipType: 'None',
    isIntersect: false,
    isActivity: false,
    sqlSchema: row.schemaName,
    isView: isView(row),
  }));
}

export function buildTableMetadata(input: BuildTableMetadataInput): TableMetadata {
  const { table } = input;
  const logicalName = sqlTableName(table.schemaName, table.tableName);

  // Callers may hand over the whole database's rows; keep only this table's.
  const columnRows = input.columns
    .filter((r) => sameTable(r, table))
    .slice()
    .sort((a, b) => a.columnId - b.columnId);
  const pkRows = input.primaryKeys
    .filter((r) => sameTable(r, table))
    .slice()
    .sort((a, b) => a.keyOrdinal - b.keyOrdinal);
  const uniqueRows = input.uniques.filter((r) => sameTable(r, table));
  const fkRows = input.foreignKeys.filter((r) =>
    sameTable({ schemaName: r.parentSchema, tableName: r.parentTable }, table),
  );

  const pkColumns = pkRows.map((r) => r.columnName);
  const pkSet = new Set(pkColumns.map((c) => c.toLowerCase()));
  /**
   * A single-column primary key behaves like a Dataverse primary id. A composite primary key does
   * not: there is no one column that identifies a row, so no synthetic id can be derived from it.
   * Such a table must be matched on its business/alternate key (the composite key is published in
   * `keys` below for exactly that purpose) and never on `primaryIdAttribute`, which is only filled
   * with the first key column so the field is not empty for display and ordering.
   */
  const hasSinglePk = pkColumns.length === 1;

  const { lookupTargets, manyToOne } = buildRelationships(fkRows, logicalName);

  const attributes: AttributeMeta[] = columnRows.map((row) =>
    buildAttribute(row, {
      isPk: pkSet.has(row.columnName.toLowerCase()),
      isPrimaryId: hasSinglePk && pkSet.has(row.columnName.toLowerCase()),
      lookupTarget: lookupTargets.get(row.columnName.toLowerCase()) ?? null,
    }),
  );

  const nameAttribute = pickPrimaryName(attributes, pkSet);
  if (nameAttribute) nameAttribute.isPrimaryName = true;

  return {
    logicalName,
    schemaName: table.tableName,
    displayName: table.tableName,
    entitySetName: logicalName,
    primaryIdAttribute: pkColumns[0] ?? '',
    primaryNameAttribute: nameAttribute?.logicalName ?? null,
    isCustom: true,
    ownershipType: 'None',
    isIntersect: false,
    isActivity: false,
    sqlSchema: table.schemaName,
    isView: isView(table),
    attributes,
    manyToOne,
    // SQL models many-to-many with an explicit junction table, which is discovered as an ordinary
    // table with two foreign keys. There is nothing extra to report here.
    manyToMany: [],
    keys: buildKeys(pkRows, uniqueRows),
  };
}

function buildAttribute(
  row: SqlColumnRow,
  ctx: { isPk: boolean; isPrimaryId: boolean; lookupTarget: string | null },
): AttributeMeta {
  const dataType = row.dataType;
  const charLength = sqlCharLength(dataType, row.maxLength);
  const isIdentity = yes(row.isIdentity);
  const isComputed = yes(row.isComputed);
  const isRowVersion = yes(row.isRowVersion);
  const isNullable = yes(row.isNullable);
  const hasDefault = row.defaultDefinition != null && row.defaultDefinition !== '';

  // The server produces these values itself, so a migration must never supply one.
  const serverGenerated = isIdentity || isComputed || isRowVersion;
  const isValidForCreate = !serverGenerated;
  // A primary key value may be supplied on insert but must not be changed afterwards: updating it
  // would rewrite the row's identity and break every foreign key pointing at it.
  const isValidForUpdate = !serverGenerated && !ctx.isPk;

  const scalarType = sqlToAttributeType(dataType, row.precision, row.scale, charLength);
  const type = ctx.lookupTarget ? 'Lookup' : scalarType;
  const range = sqlIntegerRange(dataType);
  const isText = scalarType === 'String' || scalarType === 'Memo';

  return {
    logicalName: row.columnName,
    schemaName: row.columnName,
    displayName: row.columnName,
    type,
    // The raw SQL type name is what diagnostics and the compatibility rules need; it is also how
    // `SQL_UNSUPPORTED_TYPES` recognises a column that cannot be migrated at all.
    rawType: dataType,
    // NOT NULL alone does not make a column required for a migration: if the server supplies the
    // value (identity, computed, rowversion) or a default fills it in, the source need not.
    requiredLevel: !isNullable && !hasDefault && isValidForCreate ? 'ApplicationRequired' : 'None',
    isPrimaryId: ctx.isPrimaryId,
    isPrimaryName: false,
    isCustom: true,
    isValidForCreate,
    isValidForUpdate,
    // Everything can be read, including rowversion and computed columns; they are simply never
    // written. Excluding them from reads would make comparison reports incomplete.
    isValidForRead: true,
    maxLength: isText && charLength != null && charLength >= 0 ? charLength : null,
    // The shared model's `precision` means "decimal places", which is SQL's `scale`. It is only
    // meaningful for the fractional numeric types: a `datetime2(7)` also reports a scale, and
    // copying it here would make the column look like it had 7 decimal places.
    precision: FRACTIONAL_TYPES.has(scalarType) ? (row.scale ?? null) : null,
    minValue: range?.min ?? null,
    maxValue: range?.max ?? null,
    format: null,
    dateTimeBehavior: sqlDateTimeBehavior(dataType),
    targets: ctx.lookupTarget ? [ctx.lookupTarget] : undefined,
    sql: {
      dataType,
      maxLength: charLength,
      precision: row.precision ?? null,
      scale: row.scale ?? null,
      isNullable,
      isIdentity,
      isComputed,
      isRowVersion,
      defaultDefinition: row.defaultDefinition ?? null,
      collation: row.collation ?? null,
    },
  };
}

/**
 * Picks a display column: the first non-key textual column that reads like a label. Nothing else
 * is guessed — a numeric or date column is never a name, and a wrong guess would show up as the
 * record's identity in every report and mapping screen.
 */
function pickPrimaryName(attributes: AttributeMeta[], pkSet: Set<string>): AttributeMeta | null {
  return (
    attributes.find(
      (a) =>
        !pkSet.has(a.logicalName.toLowerCase()) &&
        (a.type === 'String' || a.type === 'Memo') &&
        !SQL_UNSUPPORTED_TYPES.has((a.sql?.dataType ?? '').toLowerCase()) &&
        NAME_LIKE.test(a.logicalName),
    ) ?? null
  );
}

function buildRelationships(
  fkRows: SqlFkRow[],
  logicalName: string,
): { lookupTargets: Map<string, string>; manyToOne: RelationshipMeta[] } {
  const lookupTargets = new Map<string, string>();
  const manyToOne: RelationshipMeta[] = [];

  for (const [constraintName, rows] of groupBy(fkRows, (r) => r.constraintName)) {
    const ordered = rows.slice().sort((a, b) => a.ordinal - b.ordinal);
    const first = ordered[0];
    const referencedEntity = sqlTableName(first.referencedSchema, first.referencedTable);

    if (ordered.length === 1) {
      lookupTargets.set(first.parentColumn.toLowerCase(), referencedEntity);
      manyToOne.push({
        schemaName: constraintName,
        type: 'ManyToOne',
        referencingEntity: logicalName,
        referencingAttribute: first.parentColumn,
        referencedEntity,
        referencedAttribute: first.referencedColumn,
        // SQL has no navigation properties; @odata.bind is a Dataverse concept.
        navigationProperty: null,
        isCustom: true,
      });
      continue;
    }

    /**
     * A composite foreign key cannot become a lookup: a lookup holds exactly one value, and there
     * is no single column carrying the reference. The columns therefore keep their scalar types
     * (so their data still migrates), and the constraint is reported only as a relationship — with
     * its columns joined — so dependency ordering still loads the parent table first. Rewriting a
     * composite reference as a lookup is out of scope for this MVP; such a table must be matched
     * on its business key instead.
     */
    manyToOne.push({
      schemaName: constraintName,
      type: 'ManyToOne',
      referencingEntity: logicalName,
      referencingAttribute: ordered.map((r) => r.parentColumn).join(','),
      referencedEntity,
      referencedAttribute: ordered.map((r) => r.referencedColumn).join(','),
      navigationProperty: null,
      isCustom: true,
    });
  }

  manyToOne.sort((a, b) => a.schemaName.localeCompare(b.schemaName));
  return { lookupTargets, manyToOne };
}

function buildKeys(pkRows: SqlPkRow[], uniqueRows: SqlUniqueRow[]): AlternateKeyMeta[] {
  const keys: AlternateKeyMeta[] = [];

  // The primary key is the most reliable alternate key there is; publishing it means a composite
  // primary key is still usable for deterministic matching.
  for (const [constraintName, rows] of groupBy(pkRows, (r) => r.constraintName)) {
    const ordered = rows.slice().sort((a, b) => a.keyOrdinal - b.keyOrdinal);
    keys.push({
      logicalName: constraintName,
      schemaName: constraintName,
      displayName: constraintName,
      attributes: ordered.map((r) => r.columnName),
      status: 'Active',
    });
  }

  for (const [keyName, rows] of groupBy(uniqueRows, (r) => r.keyName)) {
    const ordered = rows.slice().sort((a, b) => a.keyOrdinal - b.keyOrdinal);
    const first = ordered[0];
    keys.push({
      logicalName: keyName,
      schemaName: keyName,
      displayName:
        first.source === 'constraint' ? `${keyName} (unique constraint)` : `${keyName} (unique index)`,
      attributes: ordered.map((r) => r.columnName),
      /**
       * Only an enforced, unconditional unique index guarantees "these values identify at most one
       * row", which is the whole promise a key makes to the record matcher:
       *  - a DISABLED index is not maintained and not enforced at all, so duplicates may already
       *    exist behind it;
       *  - a FILTERED index only enforces uniqueness over the rows matching its predicate, so two
       *    rows outside the filter can share the same values and a match would be ambiguous.
       * Both are reported with a non-Active status, which is precisely what `isKeyUsable` refuses,
       * so the key stays visible in reports without ever being matched on.
       */
      status: yes(first.isDisabled) ? 'Disabled' : yes(first.isFiltered) ? 'Filtered' : 'Active',
    });
  }

  return keys;
}
