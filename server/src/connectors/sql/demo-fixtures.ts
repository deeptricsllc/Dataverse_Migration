/**
 * A simulated legacy SQL Server, so the whole SQL -> Dataverse journey can be demonstrated and
 * tested end to end without a database server.
 *
 * The metadata is built exactly the way the real connector builds it from the SQL catalog
 * (identity columns read-only, foreign keys exposed as lookups, unique constraints as keys), and
 * the data deliberately contains the problems a real legacy database has: values too long for the
 * target, a status value nobody mapped, a duplicate business key, a broken foreign key and rows
 * that already exist in the target unchanged.
 */
import type {
  AttributeMeta,
  AttributeType,
  RelationshipMeta,
  SqlColumnMeta,
  TableMetadata,
} from '../../../../shared/metadata';

export const DEMO_SQL_ENV_KEY = 'demo-sql';

export const DEMO_SQL_ENVIRONMENT = {
  key: DEMO_SQL_ENV_KEY,
  displayName: 'Legacy SQL Server (Demo)',
  host: 'sql01.deeptrics.demo',
  port: 1433,
  database: 'IIC_Legacy',
  version: 'Microsoft SQL Server 2019 (RTM-CU18) — simulated',
} as const;

export const DEMO_SQL_URL = `sqlserver://${DEMO_SQL_ENVIRONMENT.host}:${DEMO_SQL_ENVIRONMENT.port}/${DEMO_SQL_ENVIRONMENT.database}`;

export const DEMO_SQL_TARGET_ENV_KEY = 'demo-sql-target';

/**
 * A second simulated database with the same schema and no rows, so a migration INTO SQL
 * (from Dataverse, or from the legacy database) can be demonstrated as well.
 */
export const DEMO_SQL_TARGET_ENVIRONMENT = {
  key: DEMO_SQL_TARGET_ENV_KEY,
  displayName: 'Reporting SQL Database (Demo)',
  host: 'sql02.deeptrics.demo',
  port: 1433,
  database: 'IIC_Reporting',
  version: 'Microsoft SQL Server 2022 (RTM) — simulated',
} as const;

export const DEMO_SQL_TARGET_URL = `sqlserver://${DEMO_SQL_TARGET_ENVIRONMENT.host}:${DEMO_SQL_TARGET_ENVIRONMENT.port}/${DEMO_SQL_TARGET_ENVIRONMENT.database}`;

export const DEMO_SQL_ENVIRONMENTS = [DEMO_SQL_ENVIRONMENT, DEMO_SQL_TARGET_ENVIRONMENT] as const;

// ---------------------------------------------------------------------------
// Column builders
// ---------------------------------------------------------------------------

interface ColOpts {
  nullable?: boolean;
  identity?: boolean;
  computed?: boolean;
  maxLength?: number | null;
  precision?: number | null;
  scale?: number | null;
  primaryId?: boolean;
  primaryName?: boolean;
  fk?: { table: string; column: string };
  defaultDefinition?: string | null;
}

const NORMALIZED: Record<string, AttributeType> = {
  int: 'Integer',
  bigint: 'BigInt',
  smallint: 'Integer',
  tinyint: 'Integer',
  bit: 'Boolean',
  decimal: 'Decimal',
  numeric: 'Decimal',
  money: 'Money',
  float: 'Double',
  real: 'Double',
  nvarchar: 'String',
  varchar: 'String',
  nchar: 'String',
  char: 'String',
  text: 'Memo',
  ntext: 'Memo',
  date: 'DateTime',
  datetime: 'DateTime',
  datetime2: 'DateTime',
  uniqueidentifier: 'Uniqueidentifier',
  varbinary: 'Other',
};

function col(name: string, dataType: string, opts: ColOpts = {}): AttributeMeta {
  const nullable = opts.nullable ?? true;
  const identity = opts.identity ?? false;
  const computed = opts.computed ?? false;
  const isLong = (opts.maxLength ?? 0) > 4000 || opts.maxLength === -1;
  const type: AttributeType = opts.fk ? 'Lookup' : isLong ? 'Memo' : (NORMALIZED[dataType] ?? 'Other');
  const sql: SqlColumnMeta = {
    dataType,
    maxLength: opts.maxLength ?? null,
    precision: opts.precision ?? null,
    scale: opts.scale ?? null,
    isNullable: nullable,
    isIdentity: identity,
    isComputed: computed,
    isRowVersion: dataType === 'rowversion' || dataType === 'timestamp',
    defaultDefinition: opts.defaultDefinition ?? null,
  };
  return {
    logicalName: name,
    schemaName: name,
    displayName: name,
    type,
    rawType: dataType,
    // An identity or computed column is never written by a migration, so it can never be
    // "required" of the caller either.
    requiredLevel:
      !nullable && !identity && !computed && !opts.defaultDefinition ? 'ApplicationRequired' : 'None',
    isPrimaryId: opts.primaryId ?? false,
    isPrimaryName: opts.primaryName ?? false,
    isCustom: true,
    isValidForCreate: !identity && !computed && !sql.isRowVersion,
    isValidForUpdate: !identity && !computed && !sql.isRowVersion && !opts.primaryId,
    isValidForRead: true,
    maxLength: opts.maxLength ?? null,
    precision: opts.precision ?? null,
    dateTimeBehavior: dataType === 'date' ? 'DateOnly' : dataType.startsWith('datetime') ? 'UserLocal' : null,
    targets: opts.fk ? [opts.fk.table] : undefined,
    sql,
  };
}

function sqlTable(input: {
  schema: string;
  name: string;
  columns: AttributeMeta[];
  uniques?: { name: string; columns: string[] }[];
}): TableMetadata {
  const logicalName = `${input.schema}.${input.name}`;
  const pk = input.columns.find((c) => c.isPrimaryId);
  const manyToOne: RelationshipMeta[] = input.columns
    .filter((c) => c.targets?.length)
    .map((c) => ({
      schemaName: `FK_${input.name}_${c.logicalName}`,
      type: 'ManyToOne' as const,
      referencingEntity: logicalName,
      referencingAttribute: c.logicalName,
      referencedEntity: c.targets![0],
      referencedAttribute: c.targets![0].split('.')[1] + 'Id',
      isCustom: true,
    }));
  return {
    logicalName,
    schemaName: input.name,
    displayName: input.name,
    entitySetName: logicalName,
    primaryIdAttribute: pk?.logicalName ?? input.columns[0].logicalName,
    primaryNameAttribute: input.columns.find((c) => c.isPrimaryName)?.logicalName ?? null,
    isCustom: true,
    ownershipType: 'None',
    isIntersect: false,
    isActivity: false,
    sqlSchema: input.schema,
    isView: false,
    attributes: input.columns,
    manyToOne,
    manyToMany: [],
    keys: [
      ...(pk
        ? [
            {
              logicalName: `PK_${input.name}`,
              schemaName: `PK_${input.name}`,
              displayName: `PK_${input.name}`,
              attributes: [pk.logicalName],
              status: 'Active',
            },
          ]
        : []),
      ...(input.uniques ?? []).map((u) => ({
        logicalName: u.name,
        schemaName: u.name,
        displayName: u.name,
        attributes: u.columns,
        status: 'Active',
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function demoSqlTables(): TableMetadata[] {
  return [
    sqlTable({
      schema: 'dbo',
      name: 'Customer',
      columns: [
        col('CustomerId', 'int', { identity: true, nullable: false, primaryId: true }),
        col('CustomerNumber', 'nvarchar', { maxLength: 20, nullable: false }),
        col('CustomerName', 'nvarchar', { maxLength: 200, nullable: false, primaryName: true }),
        col('Email', 'nvarchar', { maxLength: 200 }),
        col('Phone', 'nvarchar', { maxLength: 50 }),
        // 200 characters here against a 100 character target column in QA: truncation risk.
        col('Website', 'nvarchar', { maxLength: 200 }),
        col('Industry', 'nvarchar', { maxLength: 40 }),
        // Legacy flags and codes, stored as text the way an old system does.
        col('IsActive', 'char', { maxLength: 1 }),
        col('StatusCode', 'nvarchar', { maxLength: 10 }),
        // A date kept as text in the local format, which is only readable with the format stated.
        col('LegacyCreatedDate', 'nvarchar', { maxLength: 20 }),
        col('CreditLimit', 'money', { precision: 19, scale: 4 }),
        col('EmployeeCount', 'int'),
        col('OnCreditHold', 'bit', { nullable: false, defaultDefinition: '((0))' }),
        col('RegionId', 'int', { fk: { table: 'config.Region', column: 'RegionId' } }),
        col('Notes', 'nvarchar', { maxLength: -1 }),
        col('CustomerGuid', 'uniqueidentifier', { nullable: false }),
        col('CreatedDate', 'datetime2', { nullable: false }),
        col('ModifiedDate', 'datetime2'),
      ],
      uniques: [{ name: 'UQ_Customer_CustomerNumber', columns: ['CustomerNumber'] }],
    }),
    sqlTable({
      schema: 'dbo',
      name: 'Contact',
      columns: [
        col('ContactId', 'int', { identity: true, nullable: false, primaryId: true }),
        col('CustomerId', 'int', { nullable: false, fk: { table: 'dbo.Customer', column: 'CustomerId' } }),
        col('FirstName', 'nvarchar', { maxLength: 50 }),
        col('LastName', 'nvarchar', { maxLength: 50, nullable: false, primaryName: true }),
        col('Email', 'nvarchar', { maxLength: 200 }),
        col('JobTitle', 'nvarchar', { maxLength: 100 }),
        col('BirthDate', 'date'),
        col('DoNotEmail', 'bit', { nullable: false, defaultDefinition: '((0))' }),
        col('CreatedDate', 'datetime2', { nullable: false }),
      ],
    }),
    sqlTable({
      schema: 'dbo',
      name: 'Order',
      columns: [
        col('OrderId', 'int', { identity: true, nullable: false, primaryId: true }),
        col('OrderNumber', 'nvarchar', { maxLength: 30, nullable: false, primaryName: true }),
        col('CustomerId', 'int', { nullable: false, fk: { table: 'dbo.Customer', column: 'CustomerId' } }),
        col('OrderDate', 'datetime2', { nullable: false }),
        col('TotalAmount', 'money', { precision: 19, scale: 4 }),
        col('Status', 'nvarchar', { maxLength: 20 }),
        col('RowVersion', 'rowversion', { nullable: false }),
      ],
      uniques: [{ name: 'UQ_Order_OrderNumber', columns: ['OrderNumber'] }],
    }),
    sqlTable({
      schema: 'dbo',
      name: 'OrderLine',
      columns: [
        col('OrderLineId', 'int', { identity: true, nullable: false, primaryId: true }),
        col('OrderId', 'int', { nullable: false, fk: { table: 'dbo.Order', column: 'OrderId' } }),
        col('ProductId', 'int', { nullable: false, fk: { table: 'dbo.Product', column: 'ProductId' } }),
        col('Quantity', 'int', { nullable: false }),
        col('UnitPrice', 'money', { precision: 19, scale: 4, nullable: false }),
        col('LineTotal', 'money', { computed: true, precision: 19, scale: 4 }),
      ],
    }),
    sqlTable({
      schema: 'dbo',
      name: 'Product',
      columns: [
        col('ProductId', 'int', { identity: true, nullable: false, primaryId: true }),
        col('ProductCode', 'nvarchar', { maxLength: 30, nullable: false }),
        col('ProductName', 'nvarchar', { maxLength: 150, nullable: false, primaryName: true }),
        col('UnitPrice', 'money', { precision: 19, scale: 4 }),
        col('WarrantyMonths', 'int'),
        col('LaunchDate', 'date'),
        col('Discontinued', 'bit', { nullable: false, defaultDefinition: '((0))' }),
        col('Description', 'nvarchar', { maxLength: -1 }),
      ],
      uniques: [{ name: 'UQ_Product_ProductCode', columns: ['ProductCode'] }],
    }),
    sqlTable({
      schema: 'config',
      name: 'Region',
      columns: [
        col('RegionId', 'int', { identity: true, nullable: false, primaryId: true }),
        col('RegionCode', 'nvarchar', { maxLength: 10, nullable: false }),
        col('RegionName', 'nvarchar', { maxLength: 100, nullable: false, primaryName: true }),
      ],
      uniques: [{ name: 'UQ_Region_RegionCode', columns: ['RegionCode'] }],
    }),
    sqlTable({
      schema: 'config',
      name: 'ApplicationSetting',
      columns: [
        // A natural (non-identity) primary key, so this table's ids survive a migration as-is.
        col('SettingKey', 'nvarchar', { maxLength: 100, nullable: false, primaryId: true }),
        col('SettingName', 'nvarchar', { maxLength: 100, nullable: false, primaryName: true }),
        col('SettingValue', 'nvarchar', { maxLength: 400 }),
        col('Category', 'nvarchar', { maxLength: 40 }),
        col('IsEnabled', 'bit', { nullable: false, defaultDefinition: '((1))' }),
        col('ModifiedDate', 'datetime2'),
      ],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type Row = Record<string, string | number | boolean | null>;

const guid = (n: number) =>
  `9c0${n.toString(16).padStart(5, '0')}-1111-4222-8333-44445555${n.toString(16).padStart(4, '0')}`;

const REGIONS = [
  ['NA', 'North America'],
  ['EMEA', 'Europe, Middle East & Africa'],
  ['APAC', 'Asia Pacific'],
  ['LATAM', 'Latin America'],
];

const INDUSTRY_VALUES = ['Manufacturing', 'Retail', 'Financial Services', 'Healthcare', 'Logistics'];

/** The rows of the simulated database, keyed by `schema.Table`. */
export function demoSqlData(): Record<string, Row[]> {
  const region: Row[] = REGIONS.map(([code, name], i) => ({
    RegionId: i + 1,
    RegionCode: code,
    RegionName: name,
  }));

  // The dirt is deliberate and every kind of it is represented: padded names, mixed-case and
  // blank emails, an address that is not an email at all, Y/N flags, three spellings of the same
  // status, and dates kept as text in a local format.
  const customer: Row[] = Array.from({ length: 24 }, (_, i) => {
    const n = i + 1;
    const rawName = `${['Northwind', 'Contoso', 'Fabrikam', 'Adventure Works', 'Tailspin', 'Woodgrove'][i % 6]} ${['Industries', 'Group', 'Holdings', 'Partners'][i % 4]} ${n}`;
    const email =
      i % 7 === 0
        ? null
        : i % 5 === 0
          ? '' // a blank string, which is not the same thing as null
          : i === 11
            ? 'not-an-email' // fails the target's email format
            : i % 3 === 0
              ? `  CONTACT${n}@EXAMPLE.COM  ` // mixed case with padding
              : `contact${n}@example.com`;
    return {
      CustomerId: n,
      CustomerNumber: `CUST-${String(n).padStart(4, '0')}`,
      // Every third name arrives padded, the way a fixed-width export leaves it.
      CustomerName: i % 3 === 0 ? `  ${rawName}  ` : rawName,
      Email: email,
      IsActive: i % 4 === 0 ? 'N' : 'Y',
      StatusCode: ['A', 'ACTIVE', 'Active', 'D'][i % 4],
      LegacyCreatedDate: `${String((i % 12) + 1).padStart(2, '0')}/${String((i % 28) + 1).padStart(2, '0')}/20${19 + (i % 5)}`,
      Phone: `+1 555 01${String(n).padStart(2, '0')}`,
      Website:
        i === 3
          ? // Deliberately longer than the 100 characters the QA target column allows.
            `https://www.a-very-long-legacy-domain-name-that-will-not-fit-in-the-target-column-${n}.example.com/corporate/profile`
          : `https://example.com/${n}`,
      Industry: i === 5 ? 'Aerospace' : INDUSTRY_VALUES[i % INDUSTRY_VALUES.length],
      CreditLimit: 25000 + i * 1750,
      EmployeeCount: 10 + i * 13,
      OnCreditHold: i % 9 === 0,
      // Customer 7 points at a region that no longer exists: a broken foreign key.
      RegionId: i === 6 ? 99 : (i % REGIONS.length) + 1,
      Notes: i % 4 === 0 ? `Legacy account migrated from AS/400 in 2011. Reference ${n}.` : null,
      CustomerGuid: guid(n),
      CreatedDate: `2019-${String((i % 12) + 1).padStart(2, '0')}-14T09:30:00Z`,
      ModifiedDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-03T16:45:00Z`,
    };
  });
  // Two customers share a customer number: a duplicate business key that must not be guessed at.
  customer.push({
    ...customer[1],
    CustomerId: 25,
    CustomerName: 'Contoso Group 2 (duplicate record)',
    CustomerGuid: guid(25),
  });
  // A record whose name is only whitespace: the target requires a name, so it cannot be migrated
  // until somebody decides what it should be.
  customer.push({
    ...customer[0],
    CustomerId: 26,
    CustomerNumber: 'CUST-0026',
    CustomerName: '   ',
    Email: null,
    IsActive: 'Y',
    StatusCode: 'UNKNOWN',
    CustomerGuid: guid(26),
  });

  const contact: Row[] = Array.from({ length: 40 }, (_, i) => {
    const n = i + 1;
    return {
      ContactId: n,
      CustomerId: (i % 24) + 1,
      FirstName: ['Ana', 'Ben', 'Chen', 'Dara', 'Eli', 'Fay'][i % 6],
      LastName: `Legacy${String(n).padStart(2, '0')}`,
      // Contacts carry the same kinds of mess as customers.
      Email: i % 6 === 0 ? `  PERSON${n}@EXAMPLE.COM ` : `person${n}@example.com`,
      JobTitle: ['Buyer', 'Director', 'Analyst', 'Owner'][i % 4],
      BirthDate: `19${70 + (i % 25)}-0${(i % 9) + 1}-1${i % 9}`,
      DoNotEmail: i % 11 === 0,
      CreatedDate: `2020-0${(i % 9) + 1}-08T11:00:00Z`,
    };
  });

  const product: Row[] = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return {
      ProductId: n,
      ProductCode: `SKU-${String(n).padStart(3, '0')}`,
      ProductName: `Industrial Component ${n}`,
      UnitPrice: 49.99 + i * 12.5,
      WarrantyMonths: 12 + (i % 3) * 12,
      LaunchDate: `202${i % 5}-0${(i % 9) + 1}-01`,
      Discontinued: i % 6 === 5,
      Description: `Component ${n} for the legacy catalogue.`,
    };
  });

  const order: Row[] = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    return {
      OrderId: n,
      OrderNumber: `SO-${String(n).padStart(5, '0')}`,
      CustomerId: (i % 24) + 1,
      OrderDate: `2024-0${(i % 9) + 1}-1${i % 9}T10:00:00Z`,
      TotalAmount: 500 + i * 137.25,
      Status: ['OPEN', 'SHIPPED', 'CANCELLED'][i % 3],
      RowVersion: `0x0000000000${String(n).padStart(6, '0')}`,
    };
  });

  const orderLine: Row[] = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1;
    const qty = (i % 5) + 1;
    const price = 49.99 + (i % 12) * 12.5;
    return {
      OrderLineId: n,
      OrderId: (i % 30) + 1,
      ProductId: (i % 12) + 1,
      Quantity: qty,
      UnitPrice: price,
      LineTotal: Number((qty * price).toFixed(2)),
    };
  });

  const applicationSetting: Row[] = [
    ['integration.endpoint', 'Integration Endpoint', 'https://legacy.example.com/api', 'Integration', true],
    ['integration.retries', 'Integration Retries', '5', 'Integration', true],
    ['security.mfa', 'Require MFA', 'true', 'Security', true],
    ['general.timezone', 'Default Time Zone', 'UTC', 'General', true],
    ['general.legacyflag', 'Legacy Flag', 'obsolete', 'Unknown Category', false],
  ].map(([key, name, value, category, enabled]) => ({
    SettingKey: key as string,
    SettingName: name as string,
    SettingValue: value as string,
    Category: category as string,
    IsEnabled: enabled as boolean,
    ModifiedDate: '2024-02-01T08:00:00Z',
  }));

  return {
    'config.Region': region,
    'dbo.Customer': customer,
    'dbo.Contact': contact,
    'dbo.Product': product,
    'dbo.Order': order,
    'dbo.OrderLine': orderLine,
    'config.ApplicationSetting': applicationSetting,
  };
}
