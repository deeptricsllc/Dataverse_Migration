/**
 * Normalized metadata model, shared by every provider.
 *
 * Dataverse (real Web API or demo) and SQL Server / Azure SQL all produce these shapes, so
 * diffing, dependency analysis, mapping and the UI never touch a provider's raw payloads.
 * Provider-specific details that have no neutral equivalent are kept in optional fields
 * (see `sql` on AttributeMeta) rather than leaking into the shared model.
 */

import type { SemanticReading } from './semantic-types';

export const ATTRIBUTE_TYPES = [
  'String',
  'Memo',
  'Integer',
  'BigInt',
  'Decimal',
  'Double',
  'Money',
  'Boolean',
  'DateTime',
  'Picklist',
  'MultiSelectPicklist',
  'State',
  'Status',
  'Lookup',
  'Customer',
  'Owner',
  'Uniqueidentifier',
  'EntityName',
  'Image',
  'File',
  'Virtual',
  'Other',
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export type RequiredLevel = 'None' | 'Recommended' | 'ApplicationRequired' | 'SystemRequired';

export interface OptionMeta {
  value: number;
  label: string;
}

/**
 * The kind of system a column came from.
 *
 * It decides whether a value needs converting when it moves: within one family the types mean the
 * same thing, between families they do not. `TABULAR` covers everything whose columns are inferred
 * from the data rather than declared by a server — a spreadsheet, a delimited file, a list.
 */
export type ProviderFamily = 'DATAVERSE' | 'SQL' | 'TABULAR';

/**
 * A column's family.
 *
 * The fallback exists because Dataverse and SQL metadata predate the field: a SQL column always
 * carries `sql`, and anything else at the time was Dataverse. Every provider added since states its
 * family outright, which is the point — inferring it from whether one optional property happened to
 * be populated is how a spreadsheet column ends up being treated as a Dataverse column and skipping
 * type conversion altogether.
 */
export const familyOf = (attr: AttributeMeta): ProviderFamily =>
  attr.family ?? (attr.sql ? 'SQL' : 'DATAVERSE');

/** True when two columns come from different kinds of system, so values have to be converted. */
export const crossFamily = (source: AttributeMeta, target: AttributeMeta): boolean =>
  familyOf(source) !== familyOf(target);

export interface AttributeMeta {
  logicalName: string;
  schemaName: string;
  displayName: string;
  description?: string;
  type: AttributeType;
  /** Raw Dataverse AttributeType / AttributeTypeName, kept for diagnostics. */
  rawType: string;
  requiredLevel: RequiredLevel;
  isPrimaryId: boolean;
  isPrimaryName: boolean;
  isCustom: boolean;
  isValidForCreate: boolean;
  isValidForUpdate: boolean;
  isValidForRead: boolean;
  /** Field-level security enabled; values are masked in reports. */
  isSecured?: boolean;
  /** Set when this attribute is a computed child of another (e.g. name of a lookup). */
  attributeOf?: string | null;
  maxLength?: number | null;
  precision?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  format?: string | null;
  /** DateTime behavior: UserLocal | DateOnly | TimeZoneIndependent */
  dateTimeBehavior?: string | null;
  options?: OptionMeta[];
  optionSetName?: string | null;
  isGlobalOptionSet?: boolean;
  /** Lookup targets (logical names). */
  targets?: string[];
  /** SQL-specific column facts, preserved for diagnostics and for writing SQL targets. */
  sql?: SqlColumnMeta;
  /**
   * Which kind of system this column came from. Optional only for backward compatibility with
   * metadata cached before it existed; see {@link familyOf}.
   */
  family?: ProviderFamily;
  /**
   * What the values appear to *mean*, when that differs from how they are stored.
   *
   * Set for inferred sources — a file has no declared schema, so a column of five-digit integers under a
   * heading of `Start Date` is the only place the product can notice it is probably a date. `type` above
   * stays the observed storage type; this is the reading, and it carries its own confidence. Nothing acts
   * on it without the user choosing to.
   */
  semantic?: SemanticReading | null;
}

/** What a SQL column is, beyond the normalized type. */
export interface SqlColumnMeta {
  /** Raw SQL type name, e.g. `nvarchar`, `decimal`, `uniqueidentifier`. */
  dataType: string;
  /** Character length; -1 for MAX. */
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  isNullable: boolean;
  /** IDENTITY column: the server generates the value, so a migration must not supply one. */
  isIdentity: boolean;
  /** Computed or generated column: read-only. */
  isComputed: boolean;
  /** Rowversion/timestamp column: read-only and meaningless across databases. */
  isRowVersion: boolean;
  defaultDefinition: string | null;
  collation?: string | null;
}

export interface RelationshipMeta {
  schemaName: string;
  type: 'ManyToOne' | 'ManyToMany';
  /** For ManyToOne: the table holding the lookup column. */
  referencingEntity: string;
  referencingAttribute: string;
  /** For ManyToOne: the table being referenced. */
  referencedEntity: string;
  referencedAttribute: string;
  /** Single-valued navigation property used for @odata.bind on the referencing entity. */
  navigationProperty?: string | null;
  isCustom: boolean;
  /** ManyToMany only. */
  intersectEntity?: string | null;
}

export interface AlternateKeyMeta {
  logicalName: string;
  schemaName: string;
  displayName: string;
  attributes: string[];
  /**
   * Dataverse EntityKeyIndexStatus: Pending, InProgress, Active or Failed. The unique index is
   * only in place once the status is Active, so only Active keys are safe to match on.
   * https://learn.microsoft.com/power-apps/developer/data-platform/define-alternate-keys-entity
   */
  status?: string | null;
}

/** True when the alternate key's unique index is in place and can be relied on. */
export const isKeyUsable = (key: AlternateKeyMeta) => (key.status ?? 'Active') === 'Active';

export interface TableSummary {
  /**
   * Provider-unique identifier for the table. Dataverse uses the entity logical name
   * (`account`); SQL uses the schema-qualified name (`dbo.Customer`).
   */
  logicalName: string;
  schemaName: string;
  displayName: string;
  description?: string;
  entitySetName: string;
  primaryIdAttribute: string;
  primaryNameAttribute: string | null;
  isCustom: boolean;
  ownershipType: string;
  isIntersect: boolean;
  isActivity: boolean;
  /** SQL only: the containing schema (`dbo`, `config`, …). */
  sqlSchema?: string | null;
  /** SQL only: a view is readable but never a migration target. */
  isView?: boolean;
}

export interface TableMetadata extends TableSummary {
  attributes: AttributeMeta[];
  /** Lookups defined on this table (this table is the referencing entity). */
  manyToOne: RelationshipMeta[];
  manyToMany: RelationshipMeta[];
  keys: AlternateKeyMeta[];
}

export interface LookupValue {
  id: string;
  logicalName: string;
}

export type FieldValue = string | number | boolean | null | number[] | LookupValue;

export interface DvRecord {
  id: string;
  values: Record<string, FieldValue>;
}

export function isLookupValue(v: unknown): v is LookupValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as LookupValue).id === 'string' &&
    typeof (v as LookupValue).logicalName === 'string'
  );
}

export const LOOKUP_TYPES: ReadonlySet<AttributeType> = new Set(['Lookup', 'Customer', 'Owner']);

/**
 * Tables that belong to the platform (users, teams, currencies...). They are referenced by
 * business data but are not migrated by the data engine; lookups to them are resolved in
 * the target by identifier instead.
 */
export const PLATFORM_TABLES: ReadonlySet<string> = new Set([
  'systemuser',
  'team',
  'businessunit',
  'organization',
  'transactioncurrency',
  'calendar',
  'queue',
  'principal',
]);

/** Columns maintained by the platform that are never written by a migration. */
export const SYSTEM_MANAGED_COLUMNS: ReadonlySet<string> = new Set([
  'createdon',
  'createdby',
  'modifiedon',
  'modifiedby',
  'createdonbehalfby',
  'modifiedonbehalfby',
  'versionnumber',
  'importsequencenumber',
  'overriddencreatedon',
  'timezoneruleversionnumber',
  'utcconversiontimezonecode',
  'owningbusinessunit',
  'owninguser',
  'owningteam',
  'ownerid',
  'exchangerate',
]);
