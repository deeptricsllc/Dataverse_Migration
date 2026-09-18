import { describe, expect, it } from 'vitest';
import { isKeyUsable } from '../../shared/metadata';
import {
  buildTableMetadata,
  buildTableSummaries,
  sqlTableName,
  COLUMNS_QUERY,
  FOREIGN_KEYS_QUERY,
  PRIMARY_KEYS_QUERY,
  TABLES_QUERY,
  UNIQUE_KEYS_QUERY,
  type SqlColumnRow,
  type SqlFkRow,
  type SqlPkRow,
  type SqlTableRow,
  type SqlUniqueRow,
} from '../../server/src/connectors/sql/catalog';

const CUSTOMER: SqlTableRow = {
  schemaName: 'dbo',
  tableName: 'Customer',
  objectType: 'table',
  rowCount: 1200,
};

function col(columnId: number, columnName: string, dataType: string, extra: Partial<SqlColumnRow> = {}) {
  const row: SqlColumnRow = {
    schemaName: 'dbo',
    tableName: 'Customer',
    columnName,
    dataType,
    maxLength: null,
    precision: null,
    scale: null,
    isNullable: true,
    isIdentity: false,
    isComputed: false,
    isRowVersion: false,
    defaultDefinition: null,
    collation: null,
    columnId,
    ...extra,
  };
  return row;
}

const pk = (columnName: string, keyOrdinal = 1, constraintName = 'PK_Customer'): SqlPkRow => ({
  schemaName: 'dbo',
  tableName: 'Customer',
  constraintName,
  columnName,
  keyOrdinal,
});

const uq = (keyName: string, columnName: string, extra: Partial<SqlUniqueRow> = {}): SqlUniqueRow => ({
  schemaName: 'dbo',
  tableName: 'Customer',
  keyName,
  source: 'index',
  columnName,
  keyOrdinal: 1,
  isDisabled: false,
  isFiltered: false,
  filterDefinition: null,
  ...extra,
});

const fk = (
  constraintName: string,
  parentColumn: string,
  referencedTable: string,
  referencedColumn: string,
  ordinal = 1,
): SqlFkRow => ({
  constraintName,
  parentSchema: 'dbo',
  parentTable: 'Customer',
  parentColumn,
  referencedSchema: 'dbo',
  referencedTable,
  referencedColumn,
  ordinal,
});

function build(
  columns: SqlColumnRow[],
  opts: { primaryKeys?: SqlPkRow[]; uniques?: SqlUniqueRow[]; foreignKeys?: SqlFkRow[] } = {},
) {
  return buildTableMetadata({
    table: CUSTOMER,
    columns,
    primaryKeys: opts.primaryKeys ?? [],
    uniques: opts.uniques ?? [],
    foreignKeys: opts.foreignKeys ?? [],
  });
}

const byName = (t: ReturnType<typeof build>, name: string) =>
  t.attributes.find((a) => a.logicalName === name)!;

describe('catalog queries', () => {
  const queries = {
    TABLES_QUERY,
    COLUMNS_QUERY,
    PRIMARY_KEYS_QUERY,
    UNIQUE_KEYS_QUERY,
    FOREIGN_KEYS_QUERY,
  };

  it('are plain constants with nothing interpolated', () => {
    for (const [name, sql] of Object.entries(queries)) {
      expect(sql, name).not.toContain('${');
      expect(sql, name).not.toContain('@');
      expect(sql.trim().toUpperCase().startsWith('SELECT'), name).toBe(true);
    }
  });

  it('read only the system catalog views', () => {
    expect(TABLES_QUERY).toContain('sys.tables');
    expect(TABLES_QUERY).toContain('sys.views');
    expect(TABLES_QUERY).toContain('sys.dm_db_partition_stats');
    expect(COLUMNS_QUERY).toContain('sys.columns');
    expect(COLUMNS_QUERY).toContain('sys.types');
    expect(COLUMNS_QUERY).toContain('sys.computed_columns');
    expect(PRIMARY_KEYS_QUERY).toContain('sys.key_constraints');
    expect(PRIMARY_KEYS_QUERY).toContain('sys.index_columns');
    expect(UNIQUE_KEYS_QUERY).toContain('sys.indexes');
    expect(UNIQUE_KEYS_QUERY).toContain('is_disabled');
    expect(UNIQUE_KEYS_QUERY).toContain('has_filter');
    expect(FOREIGN_KEYS_QUERY).toContain('sys.foreign_key_columns');
  });

  it('never writes', () => {
    for (const [name, sql] of Object.entries(queries)) {
      expect(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|EXEC)\b/i.test(sql), name).toBe(false);
    }
  });
});

describe('sqlTableName', () => {
  it('qualifies with the schema and preserves the server casing', () => {
    expect(sqlTableName('dbo', 'Customer')).toBe('dbo.Customer');
    expect(sqlTableName('Sales', 'ORDER')).toBe('Sales.ORDER');
  });
});

describe('buildTableSummaries', () => {
  it('normalizes tables and views', () => {
    const [table, view] = buildTableSummaries([
      CUSTOMER,
      { schemaName: 'rpt', tableName: 'ActiveCustomer', objectType: 'view', rowCount: null },
    ]);

    expect(table).toEqual({
      logicalName: 'dbo.Customer',
      schemaName: 'Customer',
      displayName: 'Customer',
      entitySetName: 'dbo.Customer',
      primaryIdAttribute: '',
      primaryNameAttribute: null,
      isCustom: true,
      ownershipType: 'None',
      isIntersect: false,
      isActivity: false,
      sqlSchema: 'dbo',
      isView: false,
    });
    expect(view).toMatchObject({ logicalName: 'rpt.ActiveCustomer', sqlSchema: 'rpt', isView: true });
  });

  it('treats every SQL table as customer data', () => {
    const summaries = buildTableSummaries([
      CUSTOMER,
      { schemaName: 'config', tableName: 'Setting', objectType: 'table', rowCount: 3 },
    ]);
    expect(summaries.every((s) => s.isCustom)).toBe(true);
  });
});

describe('buildTableMetadata columns', () => {
  it('sorts attributes by column_id regardless of the row order', () => {
    const t = build([
      col(3, 'Email', 'nvarchar', { maxLength: 200 }),
      col(1, 'CustomerId', 'int'),
      col(2, 'Name', 'nvarchar', { maxLength: 200 }),
    ]);
    expect(t.attributes.map((a) => a.logicalName)).toEqual(['CustomerId', 'Name', 'Email']);
  });

  it('halves unicode byte lengths and keeps the raw SQL facts', () => {
    const t = build([
      col(1, 'Name', 'nvarchar', { maxLength: 200, collation: 'SQL_Latin1_General_CP1_CI_AS' }),
    ]);
    const a = byName(t, 'Name');
    expect(a.type).toBe('String');
    expect(a.maxLength).toBe(100);
    expect(a.rawType).toBe('nvarchar');
    expect(a.sql).toMatchObject({
      dataType: 'nvarchar',
      maxLength: 100,
      isNullable: true,
      collation: 'SQL_Latin1_General_CP1_CI_AS',
    });
  });

  it('turns MAX text into Memo with no declared length', () => {
    const t = build([col(1, 'Notes', 'nvarchar', { maxLength: -1 })]);
    const a = byName(t, 'Notes');
    expect(a.type).toBe('Memo');
    expect(a.maxLength).toBeNull();
    expect(a.sql!.maxLength).toBe(-1);
  });

  it('makes identity, computed and rowversion columns read-only', () => {
    const t = build([
      col(1, 'CustomerId', 'int', { isIdentity: true, isNullable: false }),
      col(2, 'FullName', 'nvarchar', { maxLength: 400, isComputed: true, isNullable: false }),
      col(3, 'RowVer', 'timestamp', { isRowVersion: true, isNullable: false, maxLength: 8 }),
    ]);

    for (const name of ['CustomerId', 'FullName', 'RowVer']) {
      const a = byName(t, name);
      expect(a.isValidForCreate, name).toBe(false);
      expect(a.isValidForUpdate, name).toBe(false);
      expect(a.isValidForRead, name).toBe(true);
      // The server supplies these values, so a NOT NULL declaration must not make them required.
      expect(a.requiredLevel, name).toBe('None');
    }
    expect(byName(t, 'RowVer').type).toBe('Other');
    expect(byName(t, 'CustomerId').sql).toMatchObject({ isIdentity: true });
  });

  it('requires a NOT NULL writable column only when it has no default', () => {
    const t = build([
      col(1, 'Code', 'varchar', { maxLength: 10, isNullable: false }),
      col(2, 'CreatedOn', 'datetime2', { isNullable: false, defaultDefinition: '(getutcdate())' }),
      col(3, 'Nickname', 'nvarchar', { maxLength: 100, isNullable: true }),
    ]);
    expect(byName(t, 'Code').requiredLevel).toBe('ApplicationRequired');
    expect(byName(t, 'CreatedOn').requiredLevel).toBe('None');
    expect(byName(t, 'Nickname').requiredLevel).toBe('None');
  });

  it('carries integer bounds and date behavior for value checks', () => {
    const t = build([
      col(1, 'Quantity', 'smallint', { precision: 5, scale: 0 }),
      col(2, 'BirthDate', 'date'),
      col(3, 'Price', 'decimal', { precision: 18, scale: 2 }),
    ]);
    expect(byName(t, 'Quantity')).toMatchObject({ minValue: -32768, maxValue: 32767 });
    expect(byName(t, 'BirthDate')).toMatchObject({ type: 'DateTime', dateTimeBehavior: 'DateOnly' });
    expect(byName(t, 'Price')).toMatchObject({ type: 'Decimal', precision: 2 });
    expect(byName(t, 'Price').sql).toMatchObject({ precision: 18, scale: 2 });
  });

  it('ignores rows that belong to another table', () => {
    const t = build([col(1, 'CustomerId', 'int'), { ...col(2, 'OrderId', 'int'), tableName: 'Order' }]);
    expect(t.attributes.map((a) => a.logicalName)).toEqual(['CustomerId']);
  });
});

describe('buildTableMetadata primary keys', () => {
  it('marks a single-column primary key as the primary id', () => {
    const t = build(
      [
        col(1, 'CustomerId', 'int', { isIdentity: true, isNullable: false }),
        col(2, 'Name', 'nvarchar', { maxLength: 200 }),
      ],
      {
        primaryKeys: [pk('CustomerId')],
      },
    );
    expect(t.primaryIdAttribute).toBe('CustomerId');
    expect(byName(t, 'CustomerId').isPrimaryId).toBe(true);
    expect(byName(t, 'Name').isPrimaryId).toBe(false);
    expect(t.keys).toEqual([
      {
        logicalName: 'PK_Customer',
        schemaName: 'PK_Customer',
        displayName: 'PK_Customer',
        attributes: ['CustomerId'],
        status: 'Active',
      },
    ]);
  });

  it('never marks a primary id on a composite key, but publishes the composite key', () => {
    const t = build(
      [
        col(1, 'TenantId', 'int', { isNullable: false }),
        col(2, 'Code', 'varchar', { maxLength: 20, isNullable: false }),
        col(3, 'Label', 'nvarchar', { maxLength: 200 }),
      ],
      { primaryKeys: [pk('Code', 2), pk('TenantId', 1)] },
    );

    expect(t.attributes.some((a) => a.isPrimaryId)).toBe(false);
    // Only a display/ordering fallback: matching must use the composite key below.
    expect(t.primaryIdAttribute).toBe('TenantId');
    expect(t.keys[0].attributes).toEqual(['TenantId', 'Code']);
    expect(isKeyUsable(t.keys[0])).toBe(true);
  });

  it('keeps primary key columns updatable-free but insertable', () => {
    const t = build([col(1, 'Code', 'varchar', { maxLength: 20, isNullable: false })], {
      primaryKeys: [pk('Code')],
    });
    expect(byName(t, 'Code').isValidForCreate).toBe(true);
    expect(byName(t, 'Code').isValidForUpdate).toBe(false);
  });

  it('leaves a view without a primary id', () => {
    const t = buildTableMetadata({
      table: { schemaName: 'rpt', tableName: 'ActiveCustomer', objectType: 'view', rowCount: null },
      columns: [
        { ...col(1, 'Name', 'nvarchar', { maxLength: 200 }), schemaName: 'rpt', tableName: 'ActiveCustomer' },
      ],
      primaryKeys: [],
      uniques: [],
      foreignKeys: [],
    });
    expect(t.primaryIdAttribute).toBe('');
    expect(t.isView).toBe(true);
    expect(t.keys).toEqual([]);
  });
});

describe('buildTableMetadata primary name', () => {
  it('picks the first textual name-like column that is not a key', () => {
    const t = build(
      [
        col(1, 'CustomerId', 'int'),
        col(2, 'CustomerName', 'nvarchar', { maxLength: 200 }),
        col(3, 'Description', 'nvarchar', { maxLength: -1 }),
      ],
      { primaryKeys: [pk('CustomerId')] },
    );
    expect(t.primaryNameAttribute).toBe('CustomerName');
    expect(byName(t, 'CustomerName').isPrimaryName).toBe(true);
    expect(byName(t, 'Description').isPrimaryName).toBe(false);
  });

  it('never picks a non-textual column, even when the name matches', () => {
    const t = build([col(1, 'NameId', 'int'), col(2, 'TitleDate', 'datetime2')]);
    expect(t.primaryNameAttribute).toBeNull();
    expect(t.attributes.some((a) => a.isPrimaryName)).toBe(false);
  });

  it('skips the key column itself', () => {
    const t = build(
      [col(1, 'Name', 'varchar', { maxLength: 50 }), col(2, 'Title', 'varchar', { maxLength: 50 })],
      {
        primaryKeys: [pk('Name')],
      },
    );
    expect(t.primaryNameAttribute).toBe('Title');
  });
});

describe('buildTableMetadata foreign keys', () => {
  it('turns a single-column foreign key into a lookup and a relationship', () => {
    const t = build([col(1, 'CustomerId', 'int'), col(2, 'RegionId', 'int', { isNullable: false })], {
      primaryKeys: [pk('CustomerId')],
      foreignKeys: [fk('FK_Customer_Region', 'RegionId', 'Region', 'RegionId')],
    });

    const lookup = byName(t, 'RegionId');
    expect(lookup.type).toBe('Lookup');
    expect(lookup.targets).toEqual(['dbo.Region']);
    expect(lookup.requiredLevel).toBe('ApplicationRequired');
    expect(t.manyToOne).toEqual([
      {
        schemaName: 'FK_Customer_Region',
        type: 'ManyToOne',
        referencingEntity: 'dbo.Customer',
        referencingAttribute: 'RegionId',
        referencedEntity: 'dbo.Region',
        referencedAttribute: 'RegionId',
        navigationProperty: null,
        isCustom: true,
      },
    ]);
    expect(t.manyToMany).toEqual([]);
  });

  it('keeps a composite foreign key out of the lookups but reports the relationship', () => {
    const t = build(
      [
        col(1, 'CustomerId', 'int'),
        col(2, 'TenantId', 'int'),
        col(3, 'RegionCode', 'varchar', { maxLength: 10 }),
      ],
      {
        primaryKeys: [pk('CustomerId')],
        foreignKeys: [
          fk('FK_Customer_Region', 'TenantId', 'Region', 'TenantId', 1),
          fk('FK_Customer_Region', 'RegionCode', 'Region', 'Code', 2),
        ],
      },
    );

    // A lookup holds a single value, so neither column may become one.
    expect(byName(t, 'TenantId').type).toBe('Integer');
    expect(byName(t, 'TenantId').targets).toBeUndefined();
    expect(byName(t, 'RegionCode').type).toBe('String');
    expect(byName(t, 'RegionCode').targets).toBeUndefined();

    expect(t.manyToOne).toHaveLength(1);
    expect(t.manyToOne[0]).toMatchObject({
      schemaName: 'FK_Customer_Region',
      referencingAttribute: 'TenantId,RegionCode',
      referencedEntity: 'dbo.Region',
      referencedAttribute: 'TenantId,Code',
    });
  });

  it('handles several foreign keys deterministically', () => {
    const t = build([col(1, 'RegionId', 'int'), col(2, 'OwnerId', 'int')], {
      foreignKeys: [
        fk('FK_Customer_Region', 'RegionId', 'Region', 'RegionId'),
        fk('FK_Customer_Owner', 'OwnerId', 'Employee', 'EmployeeId'),
      ],
    });
    expect(t.manyToOne.map((r) => r.schemaName)).toEqual(['FK_Customer_Owner', 'FK_Customer_Region']);
    expect(byName(t, 'OwnerId').targets).toEqual(['dbo.Employee']);
  });
});

describe('buildTableMetadata alternate keys', () => {
  const columns = [col(1, 'CustomerId', 'int'), col(2, 'Code', 'varchar', { maxLength: 20 })];

  it('publishes a unique constraint as an active key', () => {
    const t = build(columns, {
      primaryKeys: [pk('CustomerId')],
      uniques: [uq('UQ_Customer_Code', 'Code', { source: 'constraint' })],
    });
    const key = t.keys.find((k) => k.logicalName === 'UQ_Customer_Code')!;
    expect(key.attributes).toEqual(['Code']);
    expect(key.displayName).toBe('UQ_Customer_Code (unique constraint)');
    expect(key.status).toBe('Active');
    expect(isKeyUsable(key)).toBe(true);
  });

  it('refuses a filtered unique index for matching', () => {
    // A filtered index only enforces uniqueness over the rows matching its predicate, so two rows
    // outside the filter may share the same values.
    const t = build(columns, {
      uniques: [
        uq('IX_Customer_Code_Active', 'Code', {
          isFiltered: true,
          filterDefinition: '([IsActive]=(1))',
        }),
      ],
    });
    const key = t.keys[0];
    expect(key.status).toBe('Filtered');
    expect(isKeyUsable(key)).toBe(false);
  });

  it('refuses a disabled unique index for matching', () => {
    const t = build(columns, { uniques: [uq('IX_Customer_Code', 'Code', { isDisabled: true })] });
    expect(t.keys[0].status).toBe('Disabled');
    expect(isKeyUsable(t.keys[0])).toBe(false);
  });

  it('orders a multi-column unique index by its key ordinal', () => {
    const t = build(columns, {
      uniques: [
        uq('IX_Customer_Tenant_Code', 'Code', { keyOrdinal: 2 }),
        uq('IX_Customer_Tenant_Code', 'TenantId', { keyOrdinal: 1 }),
      ],
    });
    expect(t.keys[0].attributes).toEqual(['TenantId', 'Code']);
    expect(isKeyUsable(t.keys[0])).toBe(true);
  });

  it('tolerates a driver that returns bit columns as 0/1', () => {
    const t = build(columns, {
      uniques: [uq('IX_Customer_Code', 'Code', { isDisabled: 1 as unknown as boolean })],
    });
    expect(isKeyUsable(t.keys[0])).toBe(false);
  });
});
