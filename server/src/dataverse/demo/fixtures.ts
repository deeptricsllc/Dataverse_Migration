/**
 * DEMO MODE fixtures: simulated Dataverse environments for DeepTrics.
 *
 * These are intentionally shaped to exercise every capability of the platform:
 *  - matching schema, source-only / target-only columns and tables
 *  - a type mismatch (product.dtx_warrantymonths), shorter max length, missing choice values
 *  - lookup dependencies, a self-reference (account.parentaccountid) and two cycles
 *    (account <-> contact, dtx_region <-> dtx_office)
 *  - pre-existing target records (same IDs), key-matched records with different IDs
 *  - source records that the target rejects (too long, invalid choice value)
 */
import crypto from 'node:crypto';
import type {
  AlternateKeyMeta,
  AttributeMeta,
  AttributeType,
  FieldValue,
  OptionMeta,
  RelationshipMeta,
  RequiredLevel,
  TableMetadata,
} from '../../../../shared/metadata';
import type { AutomationInfo } from '../../../../shared/domain';

export type DemoEnvKey = 'demo-dev' | 'demo-qa' | 'demo-uat' | 'demo-prod';

/**
 * Bump when the demo metadata or data changes: environments seeded from an older version are
 * re-seeded on the next start so an existing installation picks the new fixtures up.
 */
export const DEMO_DATA_VERSION = '2026-09-17.3';

export interface DemoEnvironmentDef {
  key: DemoEnvKey;
  displayName: string;
  url: string;
  environmentType: string;
  region: string;
  version: string;
  /** Simulates an environment the user can see but cannot connect to. */
  connectionError?: string;
}

export const DEMO_ENVIRONMENTS: DemoEnvironmentDef[] = [
  {
    key: 'demo-dev',
    displayName: 'DeepTrics Development',
    url: 'https://deeptrics-dev.demo.invalid',
    environmentType: 'Sandbox',
    region: 'unitedstates',
    version: '9.2.25081.00190',
  },
  {
    key: 'demo-qa',
    displayName: 'DeepTrics QA',
    url: 'https://deeptrics-qa.demo.invalid',
    environmentType: 'Sandbox',
    region: 'unitedstates',
    version: '9.2.25081.00190',
  },
  {
    key: 'demo-uat',
    displayName: 'DeepTrics UAT',
    url: 'https://deeptrics-uat.demo.invalid',
    environmentType: 'Sandbox',
    region: 'europe',
    version: '9.2.25072.00155',
  },
  {
    key: 'demo-prod',
    displayName: 'DeepTrics Production',
    url: 'https://deeptrics.demo.invalid',
    environmentType: 'Production',
    region: 'unitedstates',
    version: '9.2.25081.00190',
    connectionError: 'The user is not a member of the organization (Dataverse security role required).',
  },
];

/**
 * Demo users exist in every environment but with DIFFERENT record ids, exactly like real
 * Dataverse environments. Migrating ownership or audit fields therefore requires principal
 * mapping (matched here on Entra object id / login / email).
 */
export const DEMO_USERS = [
  {
    key: 'demo.user',
    name: 'Demo User',
    email: 'demo.user@deeptrics.demo',
    entra: true,
    envs: ['demo-dev', 'demo-qa', 'demo-uat', 'demo-prod'],
  },
  {
    key: 'priya.patel',
    name: 'Priya Patel',
    email: 'priya.patel@deeptrics.demo',
    entra: true,
    envs: ['demo-dev', 'demo-qa', 'demo-uat', 'demo-prod'],
  },
  {
    key: 'mateo.garcia',
    name: 'Mateo Garcia',
    email: 'mateo.garcia@deeptrics.demo',
    entra: true,
    envs: ['demo-dev', 'demo-qa', 'demo-uat', 'demo-prod'],
  },
  {
    key: 'aisha.haddad',
    name: 'Aisha Haddad',
    email: 'aisha.haddad@deeptrics.demo',
    entra: false,
    envs: ['demo-dev', 'demo-qa', 'demo-uat', 'demo-prod'],
  },
  // Only exists in Development: nothing to map to in the target.
  {
    key: 'legacy.integration',
    name: 'Legacy Integration Account',
    email: null,
    entra: false,
    envs: ['demo-dev'],
  },
  // Only exists in QA/UAT: available as a manual mapping target.
  {
    key: 'qa.analyst',
    name: 'QA Analyst',
    email: 'qa.analyst@deeptrics.demo',
    entra: true,
    envs: ['demo-qa', 'demo-uat'],
  },
  // Ambiguous by design: this Development user has no Entra id and no email, and two different
  // people share the display name in the targets. The platform must refuse to guess.
  {
    key: 'jordan.lee',
    name: 'Jordan Lee',
    email: null,
    entra: false,
    envs: ['demo-dev'],
  },
  {
    key: 'jordan.lee.sales',
    name: 'Jordan Lee',
    email: 'j.lee.sales@deeptrics.demo',
    entra: false,
    envs: ['demo-qa', 'demo-uat'],
  },
  {
    key: 'jordan.lee.service',
    name: 'Jordan Lee',
    email: 'j.lee.service@deeptrics.demo',
    entra: false,
    envs: ['demo-qa', 'demo-uat'],
  },
] as const;

export type DemoUserKey = (typeof DEMO_USERS)[number]['key'];

/** Record id of a demo user in one environment (differs per environment by design). */
export const demoUserId = (env: DemoEnvKey, key: string) => demoGuid('systemuser', env, key);

/** Reverse lookup used when projecting source data into another demo environment. */
export function demoUserKeyById(env: DemoEnvKey, id: string): string | null {
  return DEMO_USERS.find((u) => demoUserId(env, u.key) === id)?.key ?? null;
}

export const demoUsersFor = (env: DemoEnvKey) =>
  DEMO_USERS.filter((u) => (u.envs as readonly string[]).includes(env));

/** The user the demo signs in as, per environment. */
export const DEMO_SIGNED_IN_USER = 'demo.user';
export const DEMO_ORGANIZATION_ID = demoGuid('organization', 'deeptrics');

/** Deterministic GUID from a seed (stable across restarts and environments). */
export function demoGuid(...parts: string[]): string {
  const h = crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Metadata builders
// ---------------------------------------------------------------------------

interface AttrOpts {
  display?: string;
  required?: RequiredLevel;
  maxLength?: number;
  precision?: number;
  options?: OptionMeta[];
  targets?: string[];
  create?: boolean;
  update?: boolean;
  custom?: boolean;
  primaryName?: boolean;
  behavior?: string;
  secured?: boolean;
}

const titleCase = (s: string) =>
  s
    .replace(/^dtx_/, '')
    .replace(/id$/, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

function attr(logicalName: string, type: AttributeType, o: AttrOpts = {}): AttributeMeta {
  return {
    logicalName,
    schemaName: logicalName,
    displayName: o.display ?? titleCase(logicalName),
    type,
    rawType: `${type}Type`,
    requiredLevel: o.required ?? 'None',
    isPrimaryId: false,
    isPrimaryName: Boolean(o.primaryName),
    isCustom: o.custom ?? logicalName.startsWith('dtx_'),
    isValidForCreate: o.create ?? true,
    isValidForUpdate: o.update ?? o.create ?? true,
    isValidForRead: true,
    isSecured: o.secured ?? false,
    attributeOf: null,
    maxLength: o.maxLength ?? (type === 'String' ? 100 : type === 'Memo' ? 2000 : null),
    precision: o.precision ?? (type === 'Money' ? 2 : null),
    dateTimeBehavior: type === 'DateTime' ? (o.behavior ?? 'UserLocal') : null,
    options: o.options,
    targets: o.targets,
  };
}

const opts = (...labels: string[]): OptionMeta[] => labels.map((label, i) => ({ value: i + 1, label }));
const lookupName = (logicalName: string) => attr(`${logicalName}name`, 'String', { create: false });

interface TableDef {
  logicalName: string;
  displayName: string;
  entitySetName: string;
  primaryName: string;
  custom?: boolean;
  ownership?: string;
  attributes: AttributeMeta[];
  keys?: AlternateKeyMeta[];
}

function table(def: TableDef): TableMetadata {
  const pk = `${def.logicalName}id`;
  const attributes: AttributeMeta[] = [
    {
      ...attr(pk, 'Uniqueidentifier', { display: def.displayName, create: true, update: false }),
      isPrimaryId: true,
    },
    ...def.attributes,
  ];
  // Lookup "name" shadow columns exist in real Dataverse; include them to exercise filtering.
  for (const a of def.attributes.filter((x) => x.targets)) {
    attributes.push({ ...lookupName(a.logicalName), attributeOf: a.logicalName });
  }
  const manyToOne: RelationshipMeta[] = def.attributes
    .filter((a) => a.targets)
    .flatMap((a) =>
      a.targets!.map((target) => ({
        schemaName: `${def.logicalName}_${a.logicalName}_${target}`,
        type: 'ManyToOne' as const,
        referencingEntity: def.logicalName,
        referencingAttribute: a.logicalName,
        referencedEntity: target,
        referencedAttribute: `${target}id`,
        navigationProperty: a.targets!.length > 1 ? `${a.logicalName}_${target}` : a.logicalName,
        isCustom: a.isCustom,
      })),
    );
  return {
    logicalName: def.logicalName,
    schemaName: def.logicalName,
    displayName: def.displayName,
    entitySetName: def.entitySetName,
    primaryIdAttribute: pk,
    primaryNameAttribute: def.primaryName,
    isCustom: def.custom ?? def.logicalName.startsWith('dtx_'),
    ownershipType: def.ownership ?? 'UserOwned',
    isIntersect: false,
    isActivity: false,
    attributes: attributes.sort((a, b) => a.logicalName.localeCompare(b.logicalName)),
    manyToOne,
    manyToMany: [],
    keys: def.keys ?? [],
  };
}

const auditColumns = () => [
  ...systemAuditColumns(),
  attr('ownerid', 'Owner', { display: 'Owner', targets: ['systemuser', 'team'], required: 'SystemRequired' }),
  attr('statecode', 'State', {
    display: 'Status',
    options: [
      { value: 0, label: 'Active' },
      { value: 1, label: 'Inactive' },
    ],
    required: 'SystemRequired',
  }),
  attr('statuscode', 'Status', {
    display: 'Status Reason',
    options: [
      { value: 1, label: 'Active' },
      { value: 2, label: 'Inactive' },
    ],
  }),
];

/** Audit columns every Dataverse table carries. */
function systemAuditColumns() {
  return [
    attr('createdon', 'DateTime', { display: 'Created On', create: false, update: false }),
    attr('modifiedon', 'DateTime', { display: 'Modified On', create: false, update: false }),
    attr('createdby', 'Lookup', {
      display: 'Created By',
      targets: ['systemuser'],
      create: false,
      update: false,
    }),
    attr('modifiedby', 'Lookup', {
      display: 'Modified By',
      targets: ['systemuser'],
      create: false,
      update: false,
    }),
    // Writable on create only: backdates createdon, like Dataverse.
    attr('overriddencreatedon', 'DateTime', { display: 'Record Created On', create: true, update: false }),
  ];
}

const INDUSTRIES = opts(
  'Accounting',
  'Agriculture',
  'Consulting',
  'Financial',
  'Manufacturing',
  'Retail',
  'Technology',
);
const key = (logicalName: string, attributes: string[], displayName: string): AlternateKeyMeta => ({
  logicalName,
  schemaName: logicalName,
  displayName,
  attributes,
  status: 'Active',
});

interface Variant {
  env: 'dev' | 'qa' | 'uat';
}

function buildAccount({ env }: Variant): TableMetadata {
  return table({
    logicalName: 'account',
    displayName: 'Account',
    entitySetName: 'accounts',
    primaryName: 'name',
    custom: false,
    attributes: [
      attr('name', 'String', {
        display: 'Account Name',
        required: 'ApplicationRequired',
        maxLength: 160,
        primaryName: true,
        custom: false,
      }),
      attr('accountnumber', 'String', { display: 'Account Number', maxLength: 20 }),
      attr('telephone1', 'String', { display: 'Main Phone', maxLength: 50 }),
      attr('emailaddress1', 'String', { display: 'Email', maxLength: 100 }),
      attr('websiteurl', 'String', { display: 'Website', maxLength: env === 'qa' ? 100 : 200 }),
      attr('revenue', 'Money', { display: 'Annual Revenue', precision: 2 }),
      attr('numberofemployees', 'Integer', { display: 'Number of Employees' }),
      attr('industrycode', 'Picklist', {
        display: 'Industry',
        options: env === 'qa' ? INDUSTRIES.slice(0, 6) : INDUSTRIES,
      }),
      attr('description', 'Memo', { display: 'Description', maxLength: 2000 }),
      attr('creditonhold', 'Boolean', { display: 'Credit Hold' }),
      attr('parentaccountid', 'Lookup', { display: 'Parent Account', targets: ['account'] }),
      attr('primarycontactid', 'Lookup', { display: 'Primary Contact', targets: ['contact'] }),
      attr('transactioncurrencyid', 'Lookup', { display: 'Currency', targets: ['transactioncurrency'] }),
      attr('dtx_regionid', 'Lookup', { display: 'Region', targets: ['dtx_region'] }),
      ...(env === 'qa'
        ? []
        : [
            attr('dtx_tier', 'Picklist', {
              display: 'Customer Tier',
              options: opts('Bronze', 'Silver', 'Gold'),
            }),
          ]),
      ...auditColumns(),
    ],
  });
}

function buildContact({ env }: Variant): TableMetadata {
  return table({
    logicalName: 'contact',
    displayName: 'Contact',
    entitySetName: 'contacts',
    primaryName: 'fullname',
    custom: false,
    attributes: [
      attr('fullname', 'String', {
        display: 'Full Name',
        create: false,
        update: false,
        primaryName: true,
        maxLength: 160,
      }),
      attr('firstname', 'String', { display: 'First Name', maxLength: 50 }),
      attr('lastname', 'String', { display: 'Last Name', maxLength: 50, required: 'ApplicationRequired' }),
      attr('emailaddress1', 'String', { display: 'Email', maxLength: 100 }),
      attr('jobtitle', 'String', { display: 'Job Title', maxLength: 100 }),
      attr('birthdate', 'DateTime', { display: 'Birthday', behavior: 'DateOnly' }),
      attr('parentcustomerid', 'Customer', { display: 'Company Name', targets: ['account', 'contact'] }),
      attr('preferredcontactmethodcode', 'Picklist', {
        display: 'Preferred Method of Contact',
        options: opts('Any', 'Email', 'Phone', 'Fax', 'Mail'),
      }),
      attr('donotemail', 'Boolean', { display: 'Do not allow Emails' }),
      attr('dtx_nationalid', 'String', { display: 'National ID', maxLength: 20, secured: true }),
      ...(env === 'qa'
        ? [
            attr('dtx_preferredchannel', 'Picklist', {
              display: 'Preferred Channel',
              options: opts('Web', 'Mobile', 'Branch'),
            }),
          ]
        : []),
      ...auditColumns(),
    ],
  });
}

function buildProduct({ env }: Variant): TableMetadata {
  return table({
    logicalName: 'product',
    displayName: 'Product',
    entitySetName: 'products',
    primaryName: 'name',
    custom: false,
    ownership: 'OrganizationOwned',
    attributes: [
      attr('name', 'String', {
        display: 'Name',
        required: 'SystemRequired',
        primaryName: true,
        custom: false,
      }),
      attr('productnumber', 'String', { display: 'Product ID', required: 'SystemRequired', custom: false }),
      attr('price', 'Money', { display: 'List Price', precision: 2 }),
      attr('description', 'Memo', { display: 'Description' }),
      env === 'dev'
        ? attr('dtx_warrantymonths', 'String', { display: 'Warranty (months)', maxLength: 10 })
        : attr('dtx_warrantymonths', 'Integer', { display: 'Warranty (months)' }),
      attr('dtx_launchdate', 'DateTime', { display: 'Launch Date', behavior: 'DateOnly' }),
      attr('statecode', 'State', {
        display: 'Status',
        options: [
          { value: 0, label: 'Active' },
          { value: 1, label: 'Retired' },
        ],
        required: 'SystemRequired',
      }),
      ...systemAuditColumns(),
    ],
    keys: [key('dtx_productnumber_key', ['productnumber'], 'Product Number')],
  });
}

function buildConfig({ env }: Variant): TableMetadata {
  return table({
    logicalName: 'dtx_applicationconfig',
    displayName: 'Application Config',
    entitySetName: 'dtx_applicationconfigs',
    primaryName: 'dtx_name',
    ownership: 'OrganizationOwned',
    attributes: [
      attr('dtx_name', 'String', { display: 'Name', required: 'ApplicationRequired', primaryName: true }),
      attr('dtx_key', 'String', { display: 'Key', required: 'ApplicationRequired' }),
      attr('dtx_value', 'Memo', { display: 'Value', maxLength: env === 'qa' ? 500 : 4000 }),
      attr('dtx_isenabled', 'Boolean', { display: 'Enabled' }),
      attr('dtx_category', 'Picklist', {
        display: 'Category',
        options: opts('General', 'Integration', 'Security'),
      }),
      ...systemAuditColumns(),
    ],
    keys: [key('dtx_configkey_key', ['dtx_key'], 'Config Key')],
  });
}

function buildRegion(): TableMetadata {
  return table({
    logicalName: 'dtx_region',
    displayName: 'Region',
    entitySetName: 'dtx_regions',
    primaryName: 'dtx_name',
    ownership: 'OrganizationOwned',
    attributes: [
      attr('dtx_name', 'String', { display: 'Name', required: 'ApplicationRequired', primaryName: true }),
      attr('dtx_code', 'String', { display: 'Code', maxLength: 10, required: 'ApplicationRequired' }),
      attr('dtx_headofficeid', 'Lookup', { display: 'Head Office', targets: ['dtx_office'] }),
      ...systemAuditColumns(),
    ],
    keys: [key('dtx_regioncode_key', ['dtx_code'], 'Region Code')],
  });
}

function buildOffice(): TableMetadata {
  return table({
    logicalName: 'dtx_office',
    displayName: 'Office',
    entitySetName: 'dtx_offices',
    primaryName: 'dtx_name',
    attributes: [
      attr('dtx_name', 'String', { display: 'Name', required: 'ApplicationRequired', primaryName: true }),
      attr('dtx_city', 'String', { display: 'City' }),
      attr('dtx_regionid', 'Lookup', {
        display: 'Region',
        targets: ['dtx_region'],
        required: 'ApplicationRequired',
      }),
      attr('dtx_openedon', 'DateTime', { display: 'Opened On', behavior: 'DateOnly' }),
      attr('dtx_headcount', 'Integer', { display: 'Headcount' }),
      ...auditColumns(),
    ],
  });
}

function buildLegacyImport(): TableMetadata {
  return table({
    logicalName: 'dtx_legacyimport',
    displayName: 'Legacy Import',
    entitySetName: 'dtx_legacyimports',
    primaryName: 'dtx_name',
    attributes: [
      attr('dtx_name', 'String', { display: 'Name', required: 'ApplicationRequired', primaryName: true }),
      attr('dtx_payload', 'Memo', { display: 'Payload' }),
    ],
  });
}

function buildAuditNote(): TableMetadata {
  return table({
    logicalName: 'dtx_auditnote',
    displayName: 'Audit Note',
    entitySetName: 'dtx_auditnotes',
    primaryName: 'dtx_name',
    attributes: [
      attr('dtx_name', 'String', { display: 'Name', required: 'ApplicationRequired', primaryName: true }),
      attr('dtx_note', 'Memo', { display: 'Note' }),
    ],
  });
}

function platformTable(
  logicalName: string,
  displayName: string,
  entitySetName: string,
  primaryName: string,
  extra: AttributeMeta[] = [],
) {
  return {
    ...table({
      logicalName,
      displayName,
      entitySetName,
      primaryName,
      custom: false,
      ownership: 'BusinessOwned',
      attributes: [
        attr(primaryName, 'String', { display: 'Name', primaryName: true, custom: false }),
        ...extra,
      ],
    }),
  };
}

export function demoMetadata(env: DemoEnvKey): TableMetadata[] {
  const variant: Variant = {
    env: env === 'demo-dev' || env === 'demo-prod' ? 'dev' : env === 'demo-qa' ? 'qa' : 'uat',
  };
  const tables = [
    buildAccount(variant),
    buildContact(variant),
    buildProduct(variant),
    buildConfig(variant),
    buildRegion(),
    buildOffice(),
    platformTable('systemuser', 'User', 'systemusers', 'fullname', [
      attr('domainname', 'String', { display: 'User Name', maxLength: 200, custom: false }),
      attr('internalemailaddress', 'String', { display: 'Email', maxLength: 200, custom: false }),
      attr('azureactivedirectoryobjectid', 'Uniqueidentifier', { display: 'Entra Object Id', custom: false }),
      attr('isdisabled', 'Boolean', { display: 'Status', custom: false }),
    ]),
    platformTable('team', 'Team', 'teams', 'name'),
    platformTable('businessunit', 'Business Unit', 'businessunits', 'name'),
    platformTable('transactioncurrency', 'Currency', 'transactioncurrencies', 'currencyname', [
      attr('isocurrencycode', 'String', { display: 'Currency Code', maxLength: 5, custom: false }),
    ]),
  ];
  if (variant.env === 'dev') tables.push(buildLegacyImport());
  if (variant.env === 'qa') tables.push(buildAuditNote());
  return tables.sort((a, b) => a.logicalName.localeCompare(b.logicalName));
}

export function demoAutomation(env: DemoEnvKey, tableName: string): AutomationInfo {
  const base: AutomationInfo = {
    table: tableName,
    pluginSteps: 0,
    workflows: 0,
    flows: 0,
    details: [],
    detectionSupported: true,
  };
  if (env === 'demo-qa' && tableName === 'account') {
    return {
      ...base,
      pluginSteps: 1,
      details: ['Plug-in step: DeepTrics.Plugins.AccountNumberGenerator: Create of account'],
    };
  }
  if (env === 'demo-qa' && tableName === 'contact') {
    return { ...base, flows: 1, details: ['Flow: Notify account manager when a contact is created'] };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Data generation (deterministic)
// ---------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = Record<string, FieldValue>;
export type DemoDataset = Record<string, Row[]>;

const lk = (logicalName: string, id: string) => ({ id, logicalName });
const COMPANY_A = [
  'Contoso',
  'Fabrikam',
  'Northwind',
  'Adventure',
  'Tailspin',
  'Litware',
  'Proseware',
  'Wingtip',
  'Alpine',
  'Coho',
  'Lucerne',
  'Margie',
  'Humongous',
  'Trey',
  'Blue Yonder',
];
const COMPANY_B = [
  'Holdings',
  'Logistics',
  'Traders',
  'Systems',
  'Foods',
  'Partners',
  'Energy',
  'Health',
  'Labs',
  'Group',
];
const FIRST = [
  'Avery',
  'Jordan',
  'Priya',
  'Mateo',
  'Chen',
  'Fatima',
  'Liam',
  'Sofia',
  'Noah',
  'Aisha',
  'Ethan',
  'Mei',
  'Lucas',
  'Zara',
  'Ravi',
  'Elena',
];
const LAST = [
  'Patel',
  'Garcia',
  'Nguyen',
  'Smith',
  'Okafor',
  'Kowalski',
  'Tanaka',
  'Rossi',
  'Haddad',
  'Johansson',
  'Silva',
  'Murphy',
  'Kim',
  'Reddy',
];
const REGIONS = [
  ['NA', 'North America'],
  ['EMEA', 'Europe, Middle East & Africa'],
  ['APAC', 'Asia Pacific'],
  ['LATAM', 'Latin America'],
  ['ANZ', 'Australia & New Zealand'],
  ['IN', 'India'],
];
const CITIES = [
  'Seattle',
  'Toronto',
  'London',
  'Berlin',
  'Dubai',
  'Singapore',
  'Tokyo',
  'São Paulo',
  'Mexico City',
  'Sydney',
  'Auckland',
  'Hyderabad',
  'Bengaluru',
  'Austin',
  'Paris',
];

export const CURRENCY_USD = demoGuid('transactioncurrency', 'USD');
export const CURRENCY_EUR = demoGuid('transactioncurrency', 'EUR');

function platformRows(env: DemoEnvKey): DemoDataset {
  return {
    transactioncurrency: [
      { transactioncurrencyid: CURRENCY_USD, currencyname: 'US Dollar', isocurrencycode: 'USD' },
      { transactioncurrencyid: CURRENCY_EUR, currencyname: 'Euro', isocurrencycode: 'EUR' },
    ],
    systemuser: demoUsersFor(env).map((u) => ({
      systemuserid: demoUserId(env, u.key),
      fullname: u.name,
      domainname: u.email ?? `${u.key}@deeptrics.demo`,
      internalemailaddress: u.email,
      // Users federated with Entra ID carry an object id that is identical across environments.
      azureactivedirectoryobjectid: u.entra ? demoGuid('entra', u.key) : null,
      isdisabled: false,
    })),
    businessunit: [{ businessunitid: demoGuid('businessunit', 'root'), name: 'DeepTrics' }],
    team: [],
  };
}

export function sourceDataset(env: DemoEnvKey = 'demo-dev'): DemoDataset {
  const rand = prng(20260917);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const data: DemoDataset = { ...platformRows(env) };
  // Records are owned and were created by different users, so ownership/audit preservation
  // has something real to map.
  const owners = ['priya.patel', 'mateo.garcia', 'aisha.haddad', 'legacy.integration'];
  const owner = (i: number) => lk('systemuser', demoUserId(env, owners[i % owners.length]));
  const author = (i: number) => lk('systemuser', demoUserId(env, owners[(i + 1) % owners.length]));
  const editor = (i: number) => lk('systemuser', demoUserId(env, owners[(i + 2) % owners.length]));

  const regionIds = REGIONS.map(([code]) => demoGuid('dtx_region', code));
  const officeIds = CITIES.map((c) => demoGuid('dtx_office', c));
  data.dtx_region = REGIONS.map(([code, name], i) => ({
    dtx_regionid: regionIds[i],
    dtx_name: name,
    dtx_code: code,
    dtx_headofficeid: lk('dtx_office', officeIds[(i * 2) % officeIds.length]),
    createdon: '2025-01-15T10:00:00Z',
  }));
  data.dtx_office = CITIES.map((city, i) => ({
    dtx_officeid: officeIds[i],
    dtx_name: `${city} Office`,
    dtx_city: city,
    dtx_regionid: lk('dtx_region', regionIds[Math.floor(i / 3) % regionIds.length]),
    dtx_openedon: `20${10 + (i % 14)}-0${1 + (i % 9)}-15`,
    dtx_headcount: 20 + Math.floor(rand() * 400),
    ownerid: owner(i),
    createdby: author(i),
    modifiedby: editor(i),
    statecode: 0,
    statuscode: 1,
    createdon: '2025-01-15T10:00:00Z',
  }));

  data.dtx_applicationconfig = [
    ['Feature: Customer portal', 'feature.portal.enabled', 'true', 1],
    ['Feature: AI summaries', 'feature.ai.summaries', 'false', 1],
    ['ERP endpoint', 'integration.erp.endpoint', 'https://erp.deeptrics.example/api', 2],
    ['ERP batch size', 'integration.erp.batchsize', '250', 2],
    ['Email sender', 'integration.email.sender', 'no-reply@deeptrics.example', 2],
    ['Password policy', 'security.password.policy', 'min=12;upper=1;digit=1', 3],
    ['Session timeout', 'security.session.timeout', '30', 3],
    ['Default currency', 'general.currency', 'USD', 1],
    ['Fiscal year start', 'general.fiscal.start', '04-01', 1],
    ['Support hours', 'general.support.hours', 'Mon-Fri 08:00-18:00', 1],
    ['Holiday calendar', 'general.holidays', 'US;UK;IN', 1],
    [
      'Routing rules',
      'integration.routing.rules',
      JSON.stringify(
        Array.from({ length: 18 }, (_, i) => ({
          rule: `route-${i + 1}`,
          queue: `queue-${(i % 4) + 1}`,
          priority: i % 3,
          match: `category eq ${i}`,
        })),
      ),
      2,
    ],
  ].map(([name, k, value, cat]) => ({
    dtx_applicationconfigid: demoGuid('dtx_applicationconfig', String(k)),
    dtx_name: String(name),
    dtx_key: String(k),
    dtx_value: String(value),
    dtx_isenabled: value !== 'false',
    dtx_category: Number(cat),
    createdon: '2025-02-01T09:00:00Z',
  }));

  const accountIds = Array.from({ length: 120 }, (_, i) => demoGuid('account', String(i)));
  const contactIds = Array.from({ length: 300 }, (_, i) => demoGuid('contact', String(i)));
  data.account = accountIds.map((id, i) => {
    const name = `${COMPANY_A[i % COMPANY_A.length]} ${COMPANY_B[Math.floor(i / COMPANY_A.length) % COMPANY_B.length]}${i >= 150 ? ` ${i}` : ''}`;
    const industry = i % 23 === 5 ? 7 : 1 + Math.floor(rand() * 6);
    return {
      accountid: id,
      name,
      accountnumber: `ACC-${String(1000 + i)}`,
      telephone1: `+1-555-${String(1000 + i).padStart(4, '0')}`,
      emailaddress1: `info@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
      websiteurl:
        i === 17 || i === 64
          ? `https://www.${name.toLowerCase().replace(/[^a-z]+/g, '')}.example/campaigns/2026/q3/landing?utm_source=newsletter&utm_medium=email&utm_campaign=autumn-launch`
          : `https://www.${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
      revenue: Math.round(rand() * 50_000_000) / 100 + 10_000,
      numberofemployees: 5 + Math.floor(rand() * 5000),
      industrycode: industry,
      description: i % 4 === 0 ? `Strategic account in ${pick(CITIES)}.\r\nReviewed quarterly.` : null,
      creditonhold: i % 11 === 0,
      parentaccountid: i > 10 && i % 7 === 0 ? lk('account', accountIds[i % 10]) : null,
      primarycontactid: i % 5 !== 4 ? lk('contact', contactIds[i * 2]) : null,
      transactioncurrencyid: lk('transactioncurrency', i % 3 === 0 ? CURRENCY_EUR : CURRENCY_USD),
      dtx_regionid: lk('dtx_region', regionIds[i % regionIds.length]),
      dtx_tier: 1 + (i % 3),
      ownerid: owner(i),
      createdby: author(i),
      modifiedby: editor(i),
      statecode: 0,
      statuscode: 1,
      createdon: `2025-0${1 + (i % 9)}-1${i % 10}T12:00:00Z`,
      modifiedon: '2026-08-01T12:00:00Z',
    };
  });
  data.contact = contactIds.map((id, i) => {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    return {
      contactid: id,
      firstname: first,
      lastname: last,
      fullname: `${first} ${last}`,
      emailaddress1: `${first}.${last}${i}@example.com`.toLowerCase(),
      jobtitle: pick(['Buyer', 'CFO', 'IT Director', 'Operations Manager', 'Analyst', null]),
      birthdate:
        i % 3 === 0
          ? `19${60 + (i % 40)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`
          : null,
      parentcustomerid:
        i % 10 === 9 ? null : lk('account', accountIds[Math.floor(i / 2.5) % accountIds.length]),
      preferredcontactmethodcode: 1 + (i % 5),
      donotemail: i % 13 === 0,
      dtx_nationalid: i % 4 === 0 ? `NID-${100000 + i}` : null,
      ownerid: owner(i + 1),
      createdby: author(i + 1),
      modifiedby: editor(i + 1),
      statecode: 0,
      statuscode: 1,
      createdon: '2025-05-01T08:30:00Z',
    };
  });
  data.product = Array.from({ length: 40 }, (_, i) => ({
    productid: demoGuid('product', String(i)),
    name: `${pick(['Insight', 'Pulse', 'Atlas', 'Beacon', 'Vector'])} ${pick(['Analytics', 'Connector', 'Suite', 'Gateway'])} ${i + 1}`,
    productnumber: `SKU-${String(5000 + i)}`,
    price: Math.round(rand() * 500_000) / 100,
    description: i % 2 === 0 ? 'Subscription product' : null,
    dtx_warrantymonths: String(12 * (1 + (i % 3))),
    dtx_launchdate: `2024-${String(1 + (i % 12)).padStart(2, '0')}-01`,
    statecode: 0,
    createdon: '2024-06-01T00:00:00Z',
  }));
  data.dtx_legacyimport = Array.from({ length: 10 }, (_, i) => ({
    dtx_legacyimportid: demoGuid('dtx_legacyimport', String(i)),
    dtx_name: `Legacy batch ${i + 1}`,
    dtx_payload: '{"status":"archived"}',
  }));
  return data;
}

/** QA: some records already exist (same IDs, a few with different values) and key-matched products. */
export function qaDataset(source: DemoDataset): DemoDataset {
  const data: DemoDataset = { ...platformRows('demo-qa') };
  // Pre-existing QA records are owned by QA users (different ids for the same people).
  const toQaUser = (v: FieldValue): FieldValue => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const key = demoUserKeyById('demo-dev', (v as { id: string }).id);
    return key && key !== 'legacy.integration'
      ? lk('systemuser', demoUserId('demo-qa', key))
      : lk('systemuser', demoUserId('demo-qa', 'demo.user'));
  };
  data.dtx_region = source.dtx_region.slice(1, 3).map((r, i) => ({
    ...r,
    dtx_name: i === 0 ? 'EMEA Region' : r.dtx_name,
    dtx_headofficeid: null,
  }));
  data.dtx_office = [];
  data.account = source.account.slice(0, 15).map((a, i) => ({
    accountid: a.accountid,
    name: a.name,
    accountnumber: a.accountnumber,
    telephone1: i % 5 === 2 ? '+1-555-0000' : a.telephone1,
    emailaddress1: a.emailaddress1,
    websiteurl: typeof a.websiteurl === 'string' ? a.websiteurl.slice(0, 100) : null,
    revenue: a.revenue,
    numberofemployees: a.numberofemployees,
    industrycode: a.industrycode === 7 ? 3 : a.industrycode,
    description: a.description,
    creditonhold: a.creditonhold,
    parentaccountid: null,
    primarycontactid: null,
    transactioncurrencyid: a.transactioncurrencyid,
    dtx_regionid: null,
    ownerid: toQaUser(a.ownerid),
    createdby: toQaUser(a.createdby),
    modifiedby: toQaUser(a.modifiedby),
    statecode: 0,
    statuscode: 1,
    createdon: '2026-03-01T00:00:00Z',
  }));
  data.contact = [];
  data.product = source.product.slice(0, 5).map((p, i) => ({
    ...p,
    createdby: toQaUser(p.createdby),
    modifiedby: toQaUser(p.modifiedby),
    productid: demoGuid('product', 'qa', String(i)),
    dtx_warrantymonths: Number(p.dtx_warrantymonths),
    price: i === 1 ? 999.99 : p.price,
  }));
  data.dtx_applicationconfig = source.dtx_applicationconfig.slice(0, 3).map((c) => ({ ...c }));
  data.dtx_auditnote = Array.from({ length: 4 }, (_, i) => ({
    dtx_auditnoteid: demoGuid('dtx_auditnote', String(i)),
    dtx_name: `QA sign-off ${i + 1}`,
    dtx_note: 'Validated by QA team',
  }));
  return data;
}

export function uatDataset(): DemoDataset {
  return {
    ...platformRows('demo-uat'),
    dtx_region: [],
    dtx_office: [],
    account: [],
    contact: [],
    product: [],
    dtx_applicationconfig: [],
  };
}

export function datasetFor(env: DemoEnvKey): DemoDataset {
  const source = sourceDataset();
  if (env === 'demo-dev' || env === 'demo-prod') return source;
  if (env === 'demo-qa') return qaDataset(source);
  return uatDataset();
}
