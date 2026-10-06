/**
 * Domain enums and API DTOs shared between server and web.
 */
import type { AttributeType, FieldValue, OptionMeta, RequiredLevel } from './metadata';
import type { RecordAccounting } from './run-metrics';
import type { WorkspaceRole } from './authorization';
import type { ValidationCoverage, ValidationDepth } from './validation-coverage';
import type { AggregateCheck } from './aggregates';
import type { ReadinessFinding, ReadinessOverride, ReadinessVerdict } from './readiness';
import type { UniquenessCheck } from './uniqueness';
import type { SemanticReading } from './semantic-types';
import type { Finding, FindingDisposition } from './findings';
import type { AnalysisReadiness } from './analysis-readiness';
import type { ReconciliationEvidence, WriteState } from './write-state';

// ---------------------------------------------------------------------------
// Session / environments
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  displayName: string;
  email: string | null;
  /** As stored. `MEMBER` predates the four-role model; `normaliseRole` reads it. */
  role: WorkspaceRole | 'MEMBER';
  organization: { id: string; name: string; isDemo: boolean };
  authProvider: 'microsoft' | 'demo';
  /**
   * Whether this user operates the deployment itself, rather than being an administrator inside one
   * customer organization. Comes from ADMIN_EMAILS.
   *
   * The distinction matters for exactly one thing today: inbound access requests are addressed to
   * whoever runs the platform, and are not any tenant's data. A customer administrator must not be
   * able to read the names and email addresses of other people who asked for access.
   */
  platformOperator: boolean;
}

export interface AuthConfigDto {
  microsoftEnabled: boolean;
  demoEnabled: boolean;
  /** Certification mode: reads are allowed, every Dataverse write is blocked server-side. */
  realTenantReadOnly: boolean;
  /**
   * Whether signing in with a Microsoft work account also creates the workspace.
   *
   * True when Microsoft sign-in is configured and no tenant allow-list is set: the first person from
   * a tenant we have not seen becomes its administrator. False when ALLOWED_TENANT_IDS restricts the
   * deployment, because then an unknown tenant is refused and "sign up" would be a dead end.
   */
  signUpEnabled: boolean;
  /** Where to email a human, when the deployment has been given an address. */
  contactEmail: string | null;
}

/** What someone asking for access tells us. Unauthenticated: it is the public sign-up path. */
export interface AccessRequestInput {
  name: string;
  email: string;
  company?: string;
  /** Roughly how much data, in the requester's own words. Free text on purpose. */
  useCase?: string;
  /** Anti-spam honeypot. A real browser leaves it empty because it is hidden. */
  website?: string;
}

export interface AccessRequestDto {
  id: string;
  name: string;
  email: string;
  company: string | null;
  useCase: string | null;
  createdAt: string;
  updatedAt: string;
  /** How many times this address has asked. A second ask is a stronger signal, not a duplicate row. */
  submissions: number;
  handledAt: string | null;
  handledBy: string | null;
}

export interface SessionResponseDto {
  user: SessionUser | null;
  csrfToken: string | null;
  realTenantReadOnly: boolean;
}

export type EnvironmentProvider =
  | 'dataverse'
  | 'demo'
  | 'sqlserver'
  | 'azuresql'
  | 'postgres'
  | 'mysql'
  | 'file'
  | 'onedrive'
  | 'sharepoint'
  | 'demosql';
export type ConnectionStatus = 'UNKNOWN' | 'CONNECTED' | 'FAILED';

/** The kind of system a connection points at. Chosen by the user when adding a connection. */
export type ConnectionType =
  'DATAVERSE' | 'SQL_SERVER' | 'AZURE_SQL' | 'POSTGRES' | 'MYSQL' | 'FILE' | 'ONEDRIVE' | 'SHAREPOINT';

/** The connection types configured by hand rather than discovered. */
export const SQL_CONNECTION_TYPES = ['SQL_SERVER', 'AZURE_SQL', 'POSTGRES', 'MYSQL'] as const;

/** Connection kinds whose rows are imported and kept rather than queried live. */
export const STAGED_CONNECTION_TYPES = ['FILE', 'ONEDRIVE', 'SHAREPOINT'] as const;
export type StagedConnectionType = (typeof STAGED_CONNECTION_TYPES)[number];

export const isStagedConnection = (t: ConnectionType): t is StagedConnectionType =>
  (STAGED_CONNECTION_TYPES as readonly string[]).includes(t);
export const isSqlConnection = (t: ConnectionType): t is SqlConnectionType =>
  (SQL_CONNECTION_TYPES as readonly string[]).includes(t);
export type SqlConnectionType = (typeof SQL_CONNECTION_TYPES)[number];

/** The port each server listens on unless told otherwise. */
export const DEFAULT_SQL_PORT: Record<SqlConnectionType, number> = {
  SQL_SERVER: 1433,
  AZURE_SQL: 1433,
  POSTGRES: 5432,
  MYSQL: 3306,
};

/** The schema a table belongs to when its name does not say. */
export const DEFAULT_SQL_SCHEMA: Record<SqlConnectionType, string> = {
  SQL_SERVER: 'dbo',
  AZURE_SQL: 'dbo',
  POSTGRES: 'public',
  // MySQL has no schema layer: a "schema" IS a database, so a table name needs no qualifier.
  MYSQL: '',
};

/** Connections of the same family share a connector implementation and a metadata dialect. */
export type ProviderFamily = 'DATAVERSE' | 'SQL';

export const connectionFamily = (t: ConnectionType): ProviderFamily =>
  t === 'DATAVERSE' ? 'DATAVERSE' : 'SQL';

export const CONNECTION_TYPE_LABELS: Record<ConnectionType, string> = {
  DATAVERSE: 'Microsoft Dataverse',
  SQL_SERVER: 'SQL Server',
  AZURE_SQL: 'Azure SQL',
  POSTGRES: 'PostgreSQL',
  MYSQL: 'MySQL',
  FILE: 'CSV / Excel / XML file',
  ONEDRIVE: 'OneDrive / SharePoint file',
  SHAREPOINT: 'SharePoint list',
};

/**
 * How the server reaches the database. DIRECT requires network reachability from wherever the
 * application runs; AGENT routes through a customer-hosted agent making outbound connections
 * (designed in docs/ON_PREM_AGENT_ARCHITECTURE.md, not implemented yet).
 */
export type ConnectionTransportKind = 'DIRECT' | 'AGENT';

/**
 * SQL authentication modes. Only SQL_LOGIN is implemented; the others exist so the
 * configuration shape does not have to change when they are added.
 */
export type SqlAuthType =
  'SQL_LOGIN' | 'ENTRA_PASSWORD' | 'ENTRA_INTEGRATED' | 'MANAGED_IDENTITY' | 'WINDOWS';

export const SQL_AUTH_IMPLEMENTED: ReadonlySet<SqlAuthType> = new Set<SqlAuthType>(['SQL_LOGIN']);

/** Everything needed to reach a SQL database EXCEPT the password, which is never sent to a client. */
/** One check from a connection test, safe to display. */
export interface ConnectionCheckDto {
  key: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'NOT_TESTED';
  message: string;
  resolution?: string | null;
}

export interface ConnectionTestResultDto {
  ok: boolean;
  /** One line about the connection, e.g. the server version. Never contains a credential. */
  summary: string;
  checks: ConnectionCheckDto[];
}

export interface SqlConnectionConfig {
  host: string;
  port: number;
  database: string;
  authType: SqlAuthType;
  username: string | null;
  /** TLS. Azure SQL always encrypts; on-premises servers may present a self-signed certificate. */
  encrypt: boolean;
  trustServerCertificate: boolean;
  transport: ConnectionTransportKind;
  /** Restricts discovery to these SQL schemas; empty means every schema the login can read. */
  schemas: string[];
  /** Set once a password has been stored, so the UI can say so without ever reading it back. */
  hasSecret?: boolean;
}

/**
 * What a connector can actually do. The UI reads these instead of checking the provider, so
 * Dataverse-only settings (ownership, impersonation, plug-in bypass) never appear for SQL.
 */
export interface ConnectorCapabilities {
  supportsRead: boolean;
  supportsWrite: boolean;
  supportsTransactions: boolean;
  supportsBatchWrite: boolean;
  supportsAlternateKeys: boolean;
  supportsOwnership: boolean;
  supportsAuditImpersonation: boolean;
  supportsChoices: boolean;
  supportsServerSideLogicDetection: boolean;
  supportsClientGeneratedIds: boolean;
  supportsPrincipals: boolean;
  /** Can filter a read to records changed since a watermark value, server-side. */
  supportsIncrementalRead: boolean;
}

export interface EnvironmentDto {
  id: string;
  provider: EnvironmentProvider;
  /** DATAVERSE for every environment created before connections became multi-provider. */
  connectionType: ConnectionType;
  /** SQL connection settings, without the password. Null for Dataverse connections. */
  sql: SqlConnectionConfig | null;
  capabilities: ConnectorCapabilities;
  displayName: string;
  url: string;
  organizationId: string | null;
  environmentId: string | null;
  uniqueName: string | null;
  environmentType: string | null;
  region: string | null;
  version: string | null;
  state: string | null;
  dataverseAvailable: boolean;
  connectionStatus: ConnectionStatus;
  connectionMessage: string | null;
  lastTestedAt: string | null;
  lastDiscoveredAt: string | null;
}

/** Safety classification derived from the environment type reported by Microsoft. */
export type EnvironmentClass = 'PRODUCTION' | 'NON_PRODUCTION' | 'UNKNOWN';

export function classifyEnvironment(environmentType: string | null | undefined): EnvironmentClass {
  const t = (environmentType ?? '').trim().toLowerCase();
  if (!t) return 'UNKNOWN';
  if (t === 'production' || t === 'default') return 'PRODUCTION';
  if (
    ['sandbox', 'trial', 'developer', 'preview', 'teams', 'subscriptionbasedtrial', 'support'].includes(t)
  ) {
    return 'NON_PRODUCTION';
  }
  return 'UNKNOWN';
}

/**
 * Whether writing here should make somebody type the environment's name.
 *
 * Typing the target name is a good gate and a bad habit. Asking for it on every run — including the
 * fiftieth run into a sandbox that exists to be written to — trains people to type the name without
 * reading it, which is precisely the reflex you do not want on the one occasion the name is not the
 * one they expected. So the friction scales with the consequence: production, or anything we could
 * not classify, asks for the name; a sandbox asks for a deliberate click on a button that says
 * where it is about to write.
 *
 * This is a human safeguard, not a security control. Authorization is what stops a member writing
 * to production at all (see `requireAdminForProductionTarget`); this is what stops somebody who is
 * allowed to do it from doing it by accident.
 */
export function needsTypedConfirmation(target: { environmentClass: EnvironmentClass }): boolean {
  return target.environmentClass !== 'NON_PRODUCTION';
}

/**
 * Audit events, grouped into the handful of things a person actually looks for.
 *
 * Derived from the action name rather than stored, because the alternative is a column on a table
 * with years of history in it and a migration that would have to guess at the old rows. The mapping
 * lives here so the API and the screen cannot drift apart.
 */
export const AUDIT_CATEGORIES = [
  'ACCESS',
  'CONNECTIONS',
  'ANALYSIS',
  'PLANNING',
  'MIGRATION',
  'VERIFICATION',
  'SCHEDULES',
  'ADMIN',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  ACCESS: 'Sign-in',
  CONNECTIONS: 'Connections',
  ANALYSIS: 'Analysis & profiling',
  PLANNING: 'Plans & mapping',
  MIGRATION: 'Migration runs',
  VERIFICATION: 'Validation & comparison',
  SCHEDULES: 'Schedules',
  ADMIN: 'Administration',
};

export function auditCategory(action: string): AuditCategory {
  if (action.startsWith('AUTH_')) return 'ACCESS';
  if (action.startsWith('CONNECTION_') || action.startsWith('ENVIRONMENT') || action === 'WORKSPACE_SELECTED')
    return 'CONNECTIONS';
  if (action.startsWith('ANALYSIS_') || action === 'DATA_PROFILED' || action.startsWith('PROJECT_'))
    return 'ANALYSIS';
  if (
    action.startsWith('MIGRATION_PLAN') ||
    action.startsWith('MAPPING_') ||
    action.startsWith('OBJECT_MAPPING') ||
    action.startsWith('CHOICE_MAPPING') ||
    action.startsWith('TRANSFORMATION') ||
    action.startsWith('PREFLIGHT_') ||
    action.startsWith('LOSSY_') ||
    action === 'TABLE_CATEGORY_CHANGED' ||
    action === 'PRINCIPAL_MAPPING_CHANGED'
  )
    return 'PLANNING';
  if (action.startsWith('MIGRATION_')) return 'MIGRATION';
  if (
    action.startsWith('VALIDATION_') ||
    action.startsWith('COMPARISON_') ||
    action.startsWith('DATA_COMPARISON_')
  )
    return 'VERIFICATION';
  if (action.startsWith('SCHEDULE_')) return 'SCHEDULES';
  // Stated rather than left to the fallthrough: a permission change is the event an auditor looks for
  // first, and a reader should not have to work out that it lands here by elimination.
  if (action.startsWith('TEAM_')) return 'ADMIN';
  return 'ADMIN';
}

export interface AuditPageDto {
  items: AuditEventDto[];
  /** Matching the filters, before the page limit — so a capped list can say it is capped. */
  total: number;
  /** Everyone who appears in this organization's trail, for the filter. */
  users: string[];
}

export interface WorkspaceDto {
  source: EnvironmentDto | null;
  target: EnvironmentDto | null;
}

// ---------------------------------------------------------------------------
// Schema comparison
// ---------------------------------------------------------------------------

export type DiffStatus = 'MATCH' | 'SOURCE_ONLY' | 'TARGET_ONLY' | 'DIFFERENT' | 'INCOMPATIBLE';

export interface PropertyDifference {
  property: string;
  source: unknown;
  target: unknown;
  /** Whether this single difference makes data transfer unsafe. */
  breaking: boolean;
  note?: string;
}

export interface ColumnDiff {
  logicalName: string;
  displayName: string;
  status: DiffStatus;
  sourceType: AttributeType | null;
  targetType: AttributeType | null;
  sourceRequired: RequiredLevel | null;
  targetRequired: RequiredLevel | null;
  differences: PropertyDifference[];
  optionDiff?: { sourceOnly: OptionMeta[]; targetOnly: OptionMeta[]; labelChanged: number[] };
}

export interface RelationshipDiff {
  schemaName: string;
  status: DiffStatus;
  referencingAttribute: string;
  sourceTarget: string | null;
  targetTarget: string | null;
  differences: PropertyDifference[];
}

export interface KeyDiff {
  logicalName: string;
  status: DiffStatus;
  sourceAttributes: string[] | null;
  targetAttributes: string[] | null;
}

export interface TableDiff {
  logicalName: string;
  displayName: string;
  status: DiffStatus;
  isCustom: boolean;
  /** Whether deep (column-level) comparison was performed. */
  deep: boolean;
  differences: PropertyDifference[];
  columns: ColumnDiff[];
  relationships: RelationshipDiff[];
  keys: KeyDiff[];
  counts: Record<DiffStatus, number>;
}

export interface ComparisonSummary {
  tablesCompared: number;
  deepCompared: number;
  match: number;
  different: number;
  sourceOnly: number;
  targetOnly: number;
  incompatible: number;
  columnDifferences: number;
}

export type JobRunStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ComparisonRunDto {
  id: string;
  status: JobRunStatus;
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  scope: string[] | null;
  summary: ComparisonSummary | null;
  errorMessage: string | null;
  progressMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
}

export interface EnvRef {
  id: string;
  displayName: string;
  url: string;
  /** Safety classification, so the UI can warn before writing to a production environment. */
  environmentClass: EnvironmentClass;
  connectionType: ConnectionType;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type DependencyKind = 'IN_SELECTION' | 'NOT_SELECTED' | 'PLATFORM' | 'SELF' | 'MISSING_IN_TARGET';

export interface DependencyEdgeDto {
  from: string;
  to: string;
  attribute: string;
  required: boolean;
  kind: DependencyKind;
  /** Deferred to pass 2 to break a cycle. */
  deferred: boolean;
}

export interface DependencyNodeDto {
  logicalName: string;
  displayName: string;
  order: number | null;
  dependsOn: DependencyEdgeDto[];
  dependents: DependencyEdgeDto[];
  cycleGroup: number | null;
  warnings: string[];
}

export interface DependencyAnalysisDto {
  order: string[];
  nodes: DependencyNodeDto[];
  cycles: { group: number; tables: string[]; resolvable: boolean; deferredEdges: DependencyEdgeDto[] }[];
  /** Tables required by the selection but not selected (excluding platform tables). */
  missingDependencies: {
    table: string;
    requiredBy: { table: string; attribute: string; required: boolean }[];
  }[];
}

// ---------------------------------------------------------------------------
// Migration planning
// ---------------------------------------------------------------------------

export type ConflictStrategy = 'SKIP_EXISTING' | 'CREATE_ONLY' | 'UPSERT' | 'SYNC';
export type MatchStrategy = 'PRIMARY_ID' | 'ALTERNATE_KEY' | 'BUSINESS_KEY';

/** How references to users/teams/business units that have no approved mapping are handled. */
export type UserResolutionPolicy = 'STRICT' | 'FALLBACK';

/**
 * How much of the source audit trail the migration tries to reproduce.
 *  NONE                 - platform defaults (migrating user owns and authors everything).
 *  STANDARD             - owner + created on; no extra writes.
 *  PRESERVE_ATTRIBUTION - owner + created on + created by + modified by (impersonated writes).
 */
export type AuditPolicy = 'NONE' | 'STANDARD' | 'PRESERVE_ATTRIBUTION';

export interface FallbackPrincipalDto {
  logicalName: PrincipalTable;
  id: string;
  name: string;
}

/** Effective audit behavior derived from the policy; the engine never reads the policy directly. */
export interface AuditCapabilityFlags {
  owner: boolean;
  createdOn: boolean;
  createdBy: boolean;
  modifiedBy: boolean;
}

export function auditFlags(policy: AuditPolicy): AuditCapabilityFlags {
  switch (policy) {
    case 'STANDARD':
      return { owner: true, createdOn: true, createdBy: false, modifiedBy: false };
    case 'PRESERVE_ATTRIBUTION':
      return { owner: true, createdOn: true, createdBy: true, modifiedBy: true };
    default:
      return { owner: false, createdOn: false, createdBy: false, modifiedBy: false };
  }
}

/** True when the policy needs the mapped identities (and therefore a user mapping). */
export const auditNeedsPrincipals = (policy: AuditPolicy) => policy !== 'NONE';
/** True when the policy needs impersonation privileges in the target. */
export const auditNeedsImpersonation = (policy: AuditPolicy) => policy === 'PRESERVE_ATTRIBUTION';
export type IssueSeverity = 'BLOCKER' | 'WARNING' | 'INFO';
export type MappingStatus = 'AUTO_MAPPED' | 'MANUAL' | 'UNMAPPED' | 'INCOMPATIBLE' | 'IGNORED';

/**
 * How a source table was paired with a target table. Cross-provider names rarely match, so a
 * suggestion is never executed until a person confirms it.
 */
export type ObjectMappingStatus =
  'EXACT' | 'AUTO_SUGGESTED' | 'CONFIRMED' | 'MANUAL' | 'UNMAPPED' | 'INCOMPATIBLE' | 'IGNORED';

/** A suggestion is usable only once it is EXACT (same name) or a human has confirmed it. */
export const objectMappingReady = (s: ObjectMappingStatus) =>
  s === 'EXACT' || s === 'CONFIRMED' || s === 'MANUAL';

export type TypeCompatibility = 'COMPATIBLE' | 'CONVERSION_REQUIRED' | 'LOSSY' | 'INCOMPATIBLE';

/** One source value paired with the target choice it becomes. */
export interface ChoiceMapEntryDto {
  sourceValue: string;
  targetValue: number | null;
  targetLabel: string | null;
  status: 'AUTO_SUGGESTED' | 'CONFIRMED' | 'UNMAPPED' | 'IGNORED';
  /** How many source records carry this value (from the last profile/preflight). */
  occurrences?: number | null;
}

export interface ChoiceMappingDto {
  entries: ChoiceMapEntryDto[];
  /** Applied when a source value has no entry. Null means "report it as an issue instead". */
  defaultTargetValue: number | null;
}

export type TransformKind =
  'DIRECT' | 'TRIM' | 'UPPER' | 'LOWER' | 'CONSTANT' | 'DEFAULT_IF_NULL' | 'CHOICE_MAP';

/**
 * A single field transformation, kept for the plans that predate ordered pipelines.
 * New configuration uses {@link TransformationRule}.
 */
export interface FieldTransformDto {
  kind: TransformKind;
  /** CONSTANT / DEFAULT_IF_NULL value. */
  value?: string | number | boolean | null;
}

export const DEFAULT_TRANSFORM: FieldTransformDto = { kind: 'DIRECT' };

// ---------------------------------------------------------------------------
// Transformation pipeline
// ---------------------------------------------------------------------------

/**
 * Every transformation the engine can perform. Deliberately a closed list: transformation
 * configuration is declarative data, never code, so a rule can never become an injection
 * mechanism. There is no expression language, no scripting and no SQL.
 */
export const TRANSFORMATION_KINDS = [
  // --- string ---
  'TRIM',
  'LEFT_TRIM',
  'RIGHT_TRIM',
  'UPPERCASE',
  'LOWERCASE',
  'REPLACE',
  'PREFIX',
  'SUFFIX',
  'SUBSTRING',
  'TRUNCATE',
  // --- null / blank ---
  'EMPTY_TO_NULL',
  'NULL_TO_EMPTY',
  'DEFAULT_IF_NULL',
  'DEFAULT_IF_BLANK',
  'BLOCK_IF_NULL',
  'CONSTANT',
  // --- type ---
  'TO_STRING',
  'TO_INTEGER',
  'TO_DECIMAL',
  'TO_BOOLEAN',
  'TO_DATE',
  'TO_DATETIME',
  'TO_GUID',
  // --- value mapping ---
  'VALUE_MAP',
  // --- composition ---
  'CONCAT',
  // --- conditional ---
  'IF_THEN',
] as const;
export type TransformationKind = (typeof TRANSFORMATION_KINDS)[number];

/** Comparison operators available to a conditional rule. No expression language. */
export const CONDITION_OPERATORS = [
  'EQUALS',
  'NOT_EQUALS',
  'IS_NULL',
  'IS_NOT_NULL',
  'IS_BLANK',
  'CONTAINS',
  'STARTS_WITH',
  'GREATER_THAN',
  'LESS_THAN',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface TransformationCondition {
  /** Source column to test. Empty means the value currently flowing through the pipeline. */
  field?: string | null;
  operator: ConditionOperator;
  value?: string | number | boolean | null;
}

/** What an unknown source value does when a VALUE_MAP has no entry for it. */
export type UnmappedValuePolicy = 'BLOCK' | 'IGNORE' | 'DEFAULT';

export interface TransformationRule {
  kind: TransformationKind;
  /** REPLACE. */
  find?: string | null;
  replaceWith?: string | null;
  /** PREFIX / SUFFIX / CONSTANT / DEFAULT_IF_NULL / DEFAULT_IF_BLANK / IF_THEN SET_VALUE. */
  value?: string | number | boolean | null;
  /** SUBSTRING / TRUNCATE. */
  start?: number | null;
  length?: number | null;
  /** TO_DATE / TO_DATETIME: the exact input format, so an ambiguous date is never guessed. */
  inputFormat?: string | null;
  /** TO_DECIMAL: digits kept after the decimal point. */
  scale?: number | null;
  /** VALUE_MAP / TO_BOOLEAN: many source values may map onto one target value. */
  map?: { from: string; to: string | number | boolean | null }[];
  onUnmapped?: UnmappedValuePolicy;
  /** VALUE_MAP with onUnmapped = DEFAULT. */
  defaultValue?: string | number | boolean | null;
  /** CONCAT: source columns and literals, in order. */
  parts?: { field?: string | null; literal?: string | null }[];
  separator?: string | null;
  /** CONCAT: leave out parts that are null or blank instead of producing empty separators. */
  skipEmptyParts?: boolean | null;
  /** IF_THEN. */
  condition?: TransformationCondition | null;
  action?: 'SET_VALUE' | 'SET_NULL' | 'APPLY' | null;
  /** IF_THEN with action APPLY: the rules to run when the condition holds. */
  then?: TransformationRule[];
}

/** Transformations that deliberately discard information. Acknowledged before a migration runs. */
export const LOSSY_TRANSFORMATIONS: ReadonlySet<TransformationKind> = new Set<TransformationKind>([
  'TRUNCATE',
  'SUBSTRING',
  'TO_DATE',
  'TO_INTEGER',
  'TO_DECIMAL',
]);

/**
 * TO_DECIMAL only loses precision when a scale is configured; without one it is a plain
 * conversion. Everything else in the set is lossy by its nature.
 */
export const isLossyRule = (r: TransformationRule) =>
  r.kind === 'TO_DECIMAL' ? r.scale != null : LOSSY_TRANSFORMATIONS.has(r.kind);

/** One step of what the engine actually did to a value, for previews and per-record reporting. */
export interface AppliedTransformationDto {
  kind: TransformationKind;
  before: string | null;
  after: string | null;
  /** True only when the rule actually discarded information, not merely changed the value. */
  lossy: boolean;
  /** What was lost, phrased without embedding the value (which may be from a secured column). */
  loss?: string | null;
}

export interface TransformationIssueDto {
  severity: 'ERROR' | 'WARNING';
  code: string;
  message: string;
  field?: string | null;
}

/** The result of running one field through the pipeline. */
export interface TransformFieldResultDto {
  field: string;
  targetField: string | null;
  originalValue: string | null;
  transformedValue: string | null;
  applied: AppliedTransformationDto[];
  issues: TransformationIssueDto[];
  blocked: boolean;
  lossy: boolean;
}

// ---------------------------------------------------------------------------
// Data profiling
// ---------------------------------------------------------------------------

/** Whether a statistic was computed over every record or over a sample. Never blurred. */
export type StatisticBasis = 'EXACT' | 'SAMPLED';

export interface ValueFrequencyDto {
  value: string | null;
  count: number;
}

export interface FieldProfileDto {
  field: string;
  displayName: string;
  type: AttributeType;
  /** The target column this field is mapped to, when the profile was run for a plan. */
  targetField?: string | null;
  basis: StatisticBasis;
  /** Records examined. Equals the table total when the basis is EXACT. */
  examined: number;
  nullCount: number;
  nullPercent: number;
  blankCount: number;
  distinctCount: number | null;
  duplicateCount: number | null;
  /** Text statistics. */
  minLength: number | null;
  maxLength: number | null;
  averageLength: number | null;
  whitespaceCount: number;
  /** Numeric statistics. */
  minValue: number | null;
  maxValue: number | null;
  averageValue: number | null;
  maxScale: number | null;
  /** Date statistics, ISO strings. */
  minDate: string | null;
  maxDate: string | null;
  invalidDateCount: number;
  /** Values that could not be converted at all (non-numeric in a numeric column, …). */
  invalidValueCount: number;
  /** The distinct values and their counts, for choice mapping. Capped. */
  topValues: ValueFrequencyDto[];
  topValuesTruncated: boolean;
  /** Quality findings for this field, derived from the target and from the data. */
  issues: DataQualityIssueDto[];
  /**
   * What the values appear to mean, when that differs from how they are stored.
   *
   * Carried on the profile — not only on the column metadata — because the profile is what gets stored
   * with an analysis run, and a finding about a column has to be reproducible from the record of the run
   * rather than by re-reading a source that may have changed since.
   *
   * Optional for profiles written before it existed.
   */
  semantic?: SemanticReading | null;
  /** Whether the source declares a value mandatory. Decides whether a gap is a warning or a blocker. */
  requiredLevel?: RequiredLevel;
}

export interface TableProfileDto {
  environmentId: string;
  table: string;
  displayName: string;
  basis: StatisticBasis;
  /** Total records in the table. Approximate for very large Dataverse tables. */
  totalRecords: number;
  totalApproximate: boolean;
  examined: number;
  columns: number;
  primaryKeyField: string | null;
  /** Records whose primary key is null or blank. */
  primaryKeyMissing: number;
  /** Source records sharing the configured match key. */
  duplicateKeyCount: number;
  fields: FieldProfileDto[];
  issues: DataQualityIssueDto[];
  profiledAt: string;
  /** How long profiling took, so a user can judge a full profile of a bigger table. */
  durationMs: number;
}

/** The kinds of rule the platform can check. Not a general data-quality product. */
export const DATA_QUALITY_RULE_KINDS = [
  'REQUIRED',
  'NOT_BLANK',
  'MAX_LENGTH',
  'MIN_LENGTH',
  'VALID_EMAIL',
  'VALID_PHONE',
  'NUMERIC_RANGE',
  'DATE_RANGE',
  'ALLOWED_VALUES',
  'UNIQUE',
  'REGEX_PATTERN',
] as const;
export type DataQualityRuleKind = (typeof DATA_QUALITY_RULE_KINDS)[number];

export interface DataQualityRuleDto {
  kind: DataQualityRuleKind;
  field: string;
  /** MAX_LENGTH / MIN_LENGTH / NUMERIC_RANGE / DATE_RANGE. */
  max?: number | string | null;
  min?: number | string | null;
  /** ALLOWED_VALUES. */
  values?: string[];
  /** REGEX_PATTERN: a literal pattern, validated server-side and never user-executed code. */
  pattern?: string | null;
  /** Where the rule came from: the target schema, the mapping, or a person. */
  /**
   * Where the rule came from. SOURCE_SCHEMA is a constraint the source itself declares, checked
   * against its own data during analysis — a column declared required that nonetheless holds blanks.
   */
  origin: 'TARGET_SCHEMA' | 'SOURCE_SCHEMA' | 'MAPPING' | 'USER';
  severity: 'BLOCKER' | 'WARNING';
}

export interface DataQualityIssueDto {
  severity: 'BLOCKER' | 'WARNING';
  /** e.g. REQUIRED_VALUE_MISSING, STRING_TOO_LONG, INVALID_EMAIL, DUPLICATE_KEY. */
  code: string;
  field: string | null;
  message: string;
  /** How many records are affected, within what was examined. */
  affected: number;
  basis: StatisticBasis;
  resolution?: string | null;
  /** A few offending values, for a person to recognise the problem. Masked when secured. */
  samples?: { recordId: string; value: string | null }[];
}

/** The workspace-level summary of everything profiling found. */
export interface DataQualitySummaryDto {
  planId: string;
  tablesAnalyzed: number;
  recordsProfiled: number;
  basis: StatisticBasis;
  blockers: number;
  warnings: number;
  /** Issue counts by code, for the dashboard's category list. */
  categories: { code: string; label: string; severity: 'BLOCKER' | 'WARNING'; count: number }[];
  tables: { table: string; displayName: string; blockers: number; warnings: number }[];
  profiledAt: string;
}

/**
 * What the transformation engine did across a whole run. Aggregate counters rather than a row
 * per transformed value: a million successful trims is one number, while the warnings, errors and
 * lossy conversions are also recorded per record.
 */
export interface TransformationMetricsDto {
  /** Records where at least one rule changed a value. */
  recordsTransformed: number;
  /** Individual rule applications that changed a value. */
  valuesTransformed: number;
  /** Values where a rule deliberately discarded information. */
  lossyValues: number;
  /** Values a DEFAULT_IF_* rule supplied. */
  defaultsApplied: number;
  /** Values turned into null, or null turned into a value. */
  nullConversions: number;
  /** Values resolved through a value/choice map. */
  valueMappings: number;
  /** Records blocked because a transformation could not produce a value. */
  failures: number;
  /** Counts per rule kind, so a run says which rules actually did something. */
  byKind: Record<string, number>;
}

/** One field of a record-level before/after preview. */
export interface PreviewFieldDto {
  field: string;
  targetField: string | null;
  sourceValue: string | null;
  transformedValue: string | null;
  targetValue: string | null;
  applied: AppliedTransformationDto[];
  issues: TransformationIssueDto[];
  changed: boolean;
}

export interface PreviewRecordDto {
  sourceRecordId: string;
  recordName: string | null;
  targetRecordId: string | null;
  action: PreflightAction;
  reason: string | null;
  fields: PreviewFieldDto[];
}

/** The preview of one field's pipeline over representative source values. */
export interface TransformPreviewDto {
  field: string;
  targetField: string | null;
  rows: {
    sourceValue: string | null;
    transformedValue: string | null;
    status: 'OK' | 'WARNING' | 'BLOCKED';
    message: string | null;
    applied: AppliedTransformationDto[];
  }[];
  previewed: number;
  valid: number;
  warnings: number;
  blocked: number;
  /** True when at least one row's transformation discards information. */
  lossy: boolean;
  sampled: boolean;
}

/** A reusable pipeline that can be applied to a field mapping. */
export interface TransformationTemplateDto {
  id: string;
  name: string;
  description: string;
  rules: TransformationRule[];
  /** Built-in templates ship with the product and cannot be edited. */
  builtIn: boolean;
}
export type TableCategory = 'CONFIGURATION' | 'REFERENCE' | 'TRANSACTIONAL';

export type PlanStatus = 'DRAFT' | 'PLANNED' | 'EXECUTED' | 'ARCHIVED';

export interface PlanOptions {
  conflictStrategy: ConflictStrategy;
  batchSize: number;
  maxRetries: number;
  /** Explicit, audited, disabled by default. Requires Dataverse bypass privilege. */
  bypassCustomBusinessLogic: boolean;
  /** Suppress Power Automate flows triggered by Dataverse events. */
  suppressFlowTriggers: boolean;
  /** Stop the whole run on first failure instead of continuing. */
  stopOnFirstError: boolean;
  /** How much of the source audit trail to reproduce in the target. */
  auditPolicy: AuditPolicy;
  /** What to do with user/team references that have no approved mapping. */
  userResolutionPolicy: UserResolutionPolicy;
  /** Identity used by the FALLBACK policy. Never defaults to the executing user implicitly. */
  fallbackPrincipal: FallbackPrincipalDto | null;
  /**
   * Acknowledgement that the configured lossy transformations (truncation, precision or
   * time-of-day loss) are intended. Records exactly what was accepted, so adding another lossy
   * rule afterwards invalidates it and has to be accepted again.
   */
  lossyAcknowledgement: LossyAcknowledgementDto | null;
  /**
   * Readiness blockers somebody accepted explicitly, each naming the finding and the object.
   *
   * Stored on the plan rather than on the run, because the decision is about the plan and survives a
   * retry. Written into the evidence package so a reader sees what was accepted, by whom and why.
   */
  readinessOverrides?: ReadinessOverride[];
}

export interface LossyAcknowledgementDto {
  /** `table.sourceField:RULE` for every lossy rule that was accepted. */
  accepted: string[];
  acknowledgedBy: string;
  acknowledgedAt: string;
}

/** One configured transformation that will discard information, and what it affects. */
export interface LossyTransformationDto {
  table: string;
  field: string;
  targetTable: string | null;
  targetField: string | null;
  kind: TransformationKind;
  /** `table.sourceField:RULE`, the key used by the acknowledgement. */
  key: string;
  description: string;
  /**
   * Records whose value actually loses information — not every record the rule runs on. A
   * TRUNCATE(160) over 100 records where 7 exceed the limit reports 7.
   * Null when nothing has measured it yet.
   */
  affected: number | null;
  /** Records examined to produce {@link affected}. */
  examined: number | null;
  /**
   * EXACT when a completed preflight measured every record; SAMPLED when the number comes from
   * a bounded scan and is therefore a floor rather than a total.
   */
  basis: StatisticBasis | null;
  /** The longest source value seen, for "maximum source length: 247". */
  maxSourceLength: number | null;
  /** The length values are cut to — the target column's limit for a TRUNCATE derived from it. */
  targetMaxLength: number | null;
  /** True when the counts came from a preflight rather than a sample. */
  fromPreflight: boolean;
}

/** One record a lossy transformation actually changed, for the drill-down and the export. */
export interface LossyRecordDto {
  table: string;
  sourceRecordId: string;
  recordName: string | null;
  field: string;
  targetField: string | null;
  kind: TransformationKind;
  originalValue: string | null;
  transformedValue: string | null;
  /** What was lost, e.g. "247 characters truncated to 160". Never embeds the value. */
  loss: string;
}

/** The per-record loss detail a preflight persists so it can be drilled into later. */
export interface LossyRecordDetail {
  field: string;
  targetField: string | null;
  kind: TransformationKind;
  before: string | null;
  after: string | null;
  loss: string;
}

/** What a preflight measured about each lossy transformation, keyed as LossyTransformationDto. */
export interface LossyImpactDto {
  key: string;
  table: string;
  field: string;
  targetField: string | null;
  kind: TransformationKind;
  affected: number;
  examined: number;
  maxSourceLength: number | null;
}

/** Dataverse columns that only the audit/ownership options can write. */
export interface AuditPreservation {
  owner: boolean;
  createdOn: boolean;
  createdBy: boolean;
  modifiedBy: boolean;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  conflictStrategy: 'SKIP_EXISTING',
  batchSize: 50,
  maxRetries: 4,
  bypassCustomBusinessLogic: false,
  suppressFlowTriggers: false,
  stopOnFirstError: false,
  auditPolicy: 'NONE',
  userResolutionPolicy: 'STRICT',
  fallbackPrincipal: null,
  lossyAcknowledgement: null,
};

export interface PlanIssue {
  severity: IssueSeverity;
  code: string;
  table: string | null;
  field?: string | null;
  message: string;
  /** How the user can resolve it. */
  resolution?: string;
  /** Blockers that the user acknowledged/resolved are no longer blocking. */
  acknowledged?: boolean;
}

export interface FieldMappingDto {
  id: string;
  sourceField: string;
  sourceDisplayName: string;
  targetField: string | null;
  sourceType: AttributeType;
  targetType: AttributeType | null;
  status: MappingStatus;
  confidence: number;
  reason: string;
  isLookup: boolean;
  lookupTargets: string[];
  required: boolean;
  deferred: boolean;
  deferredTargets: string[];
  /** Cross-provider type verdict shown in the mapping UI. */
  compatibility: TypeCompatibility;
  /** The ordered transformation pipeline. Empty means a direct copy. */
  transformations: TransformationRule[];
  /** True when any configured rule deliberately discards information. */
  lossy: boolean;
  /** How the source value is turned into the target value. DIRECT for an unchanged copy. */
  transform: FieldTransformDto;
  /** Value-level mapping for choice columns (SQL text into a Dataverse choice, for example). */
  choiceMap: ChoiceMappingDto | null;
}

export interface PlanEntityDto {
  id: string;
  /** Source table. Kept as `logicalName` because same-name migrations predate table mapping. */
  logicalName: string;
  displayName: string;
  /** Target table this source table is migrated into. Equal to logicalName for same-name pairs. */
  targetLogicalName: string;
  targetDisplayName: string;
  objectMappingStatus: ObjectMappingStatus;
  /** Suggested targets when the mapping is not confirmed yet, best first. */
  targetCandidates?: { logicalName: string; displayName: string; confidence: number; reason: string }[];
  orderIndex: number;
  selectedExplicitly: boolean;
  category: TableCategory | null;
  sourceCount: number | null;
  targetCount: number | null;
  countApproximate: boolean;
  schemaStatus: DiffStatus | null;
  matchStrategy: MatchStrategy;
  alternateKey: string | null;
  /** Columns forming a configured business key (MatchStrategy BUSINESS_KEY). */
  businessKeyFields: string[];
  /** Human readable summary shown in the plan, e.g. "accountnumber (alternate key)". */
  matchDescription: string;
  availableKeys: { logicalName: string; attributes: string[] }[];
  dependsOn: DependencyEdgeDto[];
  cycleGroup: number | null;
  mappingSummary: Record<MappingStatus, number>;
  automation: AutomationInfo | null;
}

export interface AutomationInfo {
  table: string;
  pluginSteps: number;
  workflows: number;
  flows: number;
  details: string[];
  detectionSupported: boolean;
}

export interface MigrationPlanDto {
  /** The migration project this plan belongs to. Null for plans that predate projects. */
  projectId: string | null;
  projectName: string | null;
  id: string;
  name: string;
  status: PlanStatus;
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  comparisonRunId: string | null;
  options: PlanOptions;
  issues: PlanIssue[];
  entities: PlanEntityDto[];
  dependencyAnalysis: DependencyAnalysisDto | null;
  blockerCount: number;
  warningCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  lastRunId: string | null;
}

export interface TableCandidateDto {
  logicalName: string;
  displayName: string;
  isCustom: boolean;
  category: TableCategory | null;
  schemaStatus: DiffStatus | null;
  sourceCount: number | null;
  targetCount: number | null;
  countApproximate: boolean;
  lookups: { attribute: string; targets: string[]; required: boolean }[];
}

// ---------------------------------------------------------------------------
// Migration runs
// ---------------------------------------------------------------------------

export type MigrationRunStatus =
  | 'DRAFT'
  | 'PLANNED'
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  /**
   * Every record was written, nothing failed, nothing is in doubt, and the data in the target is not
   * what the source said.
   *
   * A distinct outcome rather than a softer label for `COMPLETED`, because it is a different claim. The
   * run that forced it into existence wrote three hundred contacts and dropped the account each one
   * belonged to: every write succeeded, the engine recorded every omitted reference, and the run
   * reported a clean result. See `docs/MIGRATION_OUTCOME_SEMANTICS.md`.
   *
   * A plan whose last run ended here has work left.
   */
  | 'COMPLETED_WITH_WARNINGS'
  | 'COMPLETED_WITH_ERRORS'
  /**
   * The work stopped and something has to be settled by a person before it can go on.
   *
   * A write may have been applied to the target and nothing can prove it either way, so the run is
   * neither complete nor failed: claiming either would be asserting something unknown. Terminal for this
   * attempt — the run will not continue on its own — and retryable once somebody has resolved the
   * records the run names. See `docs/CRASH_CONSISTENCY.md`.
   */
  | 'NEEDS_RECONCILIATION'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL_RUN_STATUSES: ReadonlySet<MigrationRunStatus> = new Set([
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'COMPLETED_WITH_ERRORS',
  'NEEDS_RECONCILIATION',
  'FAILED',
  'CANCELLED',
]);

export type RunEntityStatus =
  'PENDING' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'SKIPPED';
export type RecordOutcome =
  | 'CREATED'
  | 'UPDATED'
  | 'UNCHANGED'
  | 'SKIPPED'
  | 'FAILED'
  /**
   * The write may have happened and we cannot prove it either way.
   *
   * Non-terminal: it means the outcome is not yet known, not that it failed. Resolved by reconciling
   * against the target, or by a person, and never by assumption. A run cannot complete while one
   * exists. See `shared/write-state.ts`.
   */
  | 'UNRESOLVED';
export type RecordOperation =
  | 'READ'
  | 'CREATE'
  | 'UPDATE'
  | 'MATCH'
  | 'COMPARE'
  | 'RESOLVE_LOOKUP'
  | 'RESOLVE_PRINCIPAL'
  | 'DEFERRED_UPDATE'
  | 'AUDIT_UPDATE';

export interface RunCounters {
  total: number;
  processed: number;
  created: number;
  updated: number;
  /** Matched in the target and identical to the source: deliberately not written. */
  unchanged: number;
  skipped: number;
  failed: number;
  /**
   * Records this run tried to write and cannot account for.
   *
   * Neither written nor failed: the write may have been applied before the answer was lost. A run with
   * any of these cannot be called complete. See `shared/write-state.ts`.
   */
  unresolved: number;
}

// ---------------------------------------------------------------------------
// Principal (user / team / business unit) mapping
// ---------------------------------------------------------------------------

export type PrincipalTable = 'systemuser' | 'team' | 'businessunit';
export type PrincipalMatchStatus = 'AUTO_MATCHED' | 'MANUAL' | 'AMBIGUOUS' | 'UNMATCHED' | 'IGNORED';

export interface PrincipalDto {
  id: string;
  name: string;
  /** Domain/login name (systemuser) or null. */
  login: string | null;
  email: string | null;
  /** Entra object id when available: the most reliable match key. */
  entraObjectId: string | null;
  disabled: boolean;
}

export interface PrincipalMappingDto {
  logicalName: PrincipalTable;
  source: PrincipalDto;
  target: PrincipalDto | null;
  status: PrincipalMatchStatus;
  /** How the match was made: ENTRA_OBJECT_ID, LOGIN, EMAIL, NAME or MANUAL. */
  matchMethod: string | null;
  confidence: number;
  note: string | null;
  /** Candidates when several targets matched; a human must choose (never auto-applied). */
  candidates: PrincipalDto[];
  /** Who decided (manual mappings/exclusions) and when the row was last written. */
  decidedBy: string | null;
  decidedAt: string;
}

export interface PrincipalMappingSummaryDto {
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  refreshedAt: string | null;
  counts: {
    total: number;
    matched: number;
    unmatched: number;
    ambiguous: number;
    manual: number;
    ignored: number;
  };
  mappings: PrincipalMappingDto[];
  /** Target principals available for manual selection. */
  targetPrincipals: Record<PrincipalTable, PrincipalDto[]>;
  capabilities: ImpersonationCapabilityDto | null;
}

export interface ImpersonationCapabilityDto {
  checkedAt: string;
  /** Whether the target accepted an impersonated call (prvActOnBehalfOfAnotherUser). */
  canImpersonate: boolean;
  message: string;
}

export interface MigrationRunEntityDto extends RunCounters {
  id: string;
  logicalName: string;
  displayName: string;
  orderIndex: number;
  status: RunEntityStatus;
  deferredPending: number;
  deferredResolved: number;
  deferredFailed: number;
  /**
   * Records whose deferred references could not all be set.
   *
   * The second pass only, and only the records that reached it. A reference dropped when the record was
   * first prepared never enters the deferred pass, so this is not the count of everything this dataset
   * failed to carry across — `MigrationRunDto.omittedReferences` is. Zero for datasets that ran before
   * this column existed.
   */
  deferredIncomplete: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MigrationRunDto extends RunCounters {
  /** What the transformation engine did during this run. Null for runs that predate it. */
  transformationMetrics?: TransformationMetricsDto | null;
  id: string;
  planId: string;
  /**
   * The project this run belongs to.
   *
   * Carried so a failure can link to the place that fixes it. Null for runs made before projects owned
   * migrations; a failure in one of those names the correction without offering to navigate to it.
   */
  projectId: string | null;
  planName: string;
  status: MigrationRunStatus;
  phase: string | null;
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  options: PlanOptions;
  currentEntity: string | null;
  entities: MigrationRunEntityDto[];
  errorCount: number;
  warningCount: number;
  /**
   * Records written into the target carrying less than the source record did.
   *
   * Counted per record, from the warnings the engine recorded while it ran, so it is available for every
   * run including those that finished before the outcome model distinguished this. This is the number that
   * turns a run's outcome into `COMPLETED_WITH_WARNINGS`, and the reason a run can report no failures and
   * still not have carried the data across. See `docs/MIGRATION_OUTCOME_SEMANTICS.md`.
   */
  omittedReferences: number;
  errorMessage: string | null;
  cancelRequested: boolean;
  pauseRequested: boolean;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  latestValidationRunId: string | null;
}

/**
 * Where a run's failures are, and what caused them.
 *
 * The first question after a run that did not go cleanly is "what went wrong", and the answer is a small
 * number of causes with very uneven counts. Every category is an error code the engine recorded; none is
 * inferred from a message. A code this product does not define appears as itself.
 */
export interface RunFailureSummaryDto {
  runId: string;
  status: MigrationRunStatus;
  attempt: number;
  failed: number;
  /** Records whose write result could not be confirmed. Not failures. See `shared/write-state.ts`. */
  unresolved: number;
  /** The engine's own classification, recorded per error when it happened. */
  retryable: number;
  permanent: number;
  /**
   * Recorded against a record that was written anyway.
   *
   * A dropped lookup is the common one: the record exists in the target, and a reference it carried does
   * not. Never counted as a failure, and never left out — the difference between "it worked" and "it
   * worked, and here is what it could not carry across".
   */
  warnings: number;
  datasets: {
    logicalName: string;
    displayName: string;
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    unresolved: number;
    categories: {
      code: string;
      label: string;
      meaning: string | null;
      action: string | null;
      /** False when the label is the code itself, because this product did not define it. */
      known: boolean;
      field: string | null;
      retryable: boolean;
      records: number;
      exampleRecordId: string | null;
      exampleMessage: string | null;
    }[];
    /** Same shape, recorded against records the run wrote. Not failures. */
    warnings: {
      code: string;
      label: string;
      meaning: string | null;
      action: string | null;
      known: boolean;
      field: string | null;
      retryable: boolean;
      records: number;
      exampleRecordId: string | null;
      exampleMessage: string | null;
    }[];
  }[];
}

export interface MigrationRunListItemDto {
  id: string;
  planName: string;
  status: MigrationRunStatus;
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  total: number;
  processed: number;
  failed: number;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
}

import type { FailureCategory } from './failure-categories';

export interface MigrationErrorDto {
  id: string;
  entity: string;
  sourceRecordId: string | null;
  operation: RecordOperation;
  severity: 'ERROR' | 'WARNING';
  errorCode: string;
  message: string;
  retryable: boolean;
  field: string | null;
  attempts: number;
  resolved: boolean;
  createdAt: string;
  /**
   * What the target answered with, where the failure came from the target at all.
   *
   * Null for a failure the engine decided by itself — an unresolvable reference, an incomplete business
   * key — because no request was made. Shown as `Not recorded` rather than as a zero.
   */
  httpStatus: number | null;
  /** Which attempt recorded this. Null for rows written before the product recorded it. */
  runAttempt: number | null;
  /** The target table this dataset writes to. Null where the plan maps it to a table of the same name. */
  targetTable: string | null;
  /** What this code means and what to do about it, where this product defines the code. */
  category: FailureCategory;
}

/**
 * Which failures a list or an export is about.
 *
 * One shape, used by both, so an export cannot honour a different set of filters from the list it was taken
 * from.
 */
export interface ErrorFilter {
  entity?: string;
  kind?: 'all' | 'retryable' | 'permanent';
  severity?: 'ERROR' | 'WARNING';
  /** One recorded cause, matched exactly. */
  code?: string;
  /** One attempt of this run. Rows with no recorded attempt are excluded, not guessed at. */
  attempt?: number;
  /** One source record, matched exactly: a contains-search over millions of rows is a scan. */
  sourceRecordId?: string;
  includeResolved?: boolean;
}

/**
 * Whether another attempt of this run is safe, and what it would act on.
 *
 * Answered before the button is offered rather than after it is pressed. A retry is the one action in this
 * product that can create a second copy of a customer's record, so "press it and find out" is not an
 * acceptable interaction: the assessment is shown, the count is exact, and where it is not safe there is no
 * button at all.
 *
 * Every number here is derived from what the engine recorded. See `docs/MIGRATION_OUTCOME_SEMANTICS.md`
 * and `shared/write-state.ts`.
 */
export interface RetrySafetyDto {
  runId: string;
  attempt: number;
  state: RetrySafetyState;
  /** State, then evidence, then consequence. One sentence, for the reader who presses the button. */
  reason: string;
  /** Records another attempt would act on. Zero means there is nothing to retry, not that it is unsafe. */
  safe: number;
  /** Records another attempt would not touch, with the reason for each group. */
  excluded: { reason: string; records: number }[];
  /** Records that cannot be settled by any number of attempts, and need a person to look in the target. */
  needsReconciliation: number;
  /** True only when the server would accept a retry right now. The button follows this and nothing else. */
  allowed: boolean;
}

export type RetrySafetyState =
  /** Another attempt can act on records, and no record is in a state where repeating could duplicate. */
  | 'SAFE_TO_RETRY'
  /**
   * At least one record may be in the target with nothing to identify it.
   *
   * Another attempt would re-create it. The way forward is reconciliation, not a retry, and the server
   * refuses a retry in this state as well.
   */
  | 'RECONCILE_FIRST'
  /** The run is not in a state a retry applies to — it is still going, or another run holds the target. */
  | 'RETRY_BLOCKED'
  /** The run finished and there is nothing a further attempt would do. */
  | 'NOTHING_TO_RETRY';

/**
 * One record, and everything recorded about what happened to it.
 *
 * The answer to the question a consultant asks about a single row: what is this record, what went wrong,
 * and what do I do. Assembled from the identity map and the error rows, and from nothing else — a field
 * that was not recorded is reported as not recorded.
 */
export interface RunRecordDetailDto {
  runId: string;
  /** Which attempt this record was last touched by. Null for runs that predate the column. */
  runAttempt: number | null;
  entity: string;
  displayName: string;
  targetTable: string | null;
  sourceId: string;
  targetId: string | null;
  outcome: RecordOutcome;
  /** How the engine matched this record in the target, where it matched one. */
  matchMethod: string | null;
  writeState: string | null;
  deferredStatus: string | null;
  /** The source values that identify this record, and the values the failures name. Never every column. */
  evidence: { label: string; value: string | null; field: string | null }[];
  /** Every failure and warning recorded against this record, newest first. */
  errors: MigrationErrorDto[];
  updatedAt: string | null;
}

/**
 * What one attempt of a run is answerable for.
 *
 * **Execution history, not accountability.** The run's own counters are the figures somebody signs for:
 * every source record, counted exactly once, under one outcome. These say which attempt is responsible
 * for the state each record is now in — the answer to "the first run failed, what did the second one
 * actually do".
 *
 * They sum to the run total exactly, and that is by construction rather than luck: each record records
 * the attempt that last touched it, so every record belongs to one attempt. Summing *activity* instead
 * would produce a figure larger than the data, which is the trap worth avoiding.
 *
 * The cost of that choice: work an earlier attempt did on a record a later attempt touched again is not
 * separately visible. A record created in attempt 1 and updated in attempt 2 appears under attempt 2
 * only.
 */
export interface RunAttemptSummary {
  /**
   * Failures and warnings this attempt recorded, counted per record.
   *
   * The only part of an attempt's history that a later attempt cannot overwrite. The identity map holds one
   * row per record, so a retry that re-processes a record moves it to the new attempt and the earlier one
   * stops being visible in the outcome columns. Error rows are inserted, never replaced, so this number
   * stays true — and it is why an attempt that has had all of its records re-done still appears here
   * instead of vanishing as though it never ran.
   *
   * Null for attempts whose errors predate the attempt being recorded on them.
   */
  recordsWithProblems: number | null;
  /** Null for records written before the attempt was recorded. "Not known", not attempt zero. */
  attempt: number | null;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  unresolved: number;
  /** When this attempt first and last touched a record. Not the attempt's start and end. */
  firstRecordAt: string;
  lastRecordAt: string;
}

export interface RecordMapDto {
  entity: string;
  sourceId: string;
  targetId: string | null;
  outcome: RecordOutcome;
  matchMethod: string | null;
  deferredStatus: string | null;
  /**
   * Whether the platform can prove what happened to this record.
   *
   * Carried here, and not only inside the evidence package, because it is the answer to the question
   * somebody asks about one record: did this get written? A run says how many records are unresolved;
   * this says which. Null on identity rows written before the crash-consistency protocol existed.
   */
  writeState: WriteState | null;
  /** What could have identified the record if the answer to the write was lost. */
  recoveryEvidence: ReconciliationEvidence | null;
  /** What reconciliation, or a person, concluded. In words, because a person wrote some of them. */
  recoveryNote: string | null;
  updatedAt: string;
}

export interface RollbackPreviewDto {
  runId: string;
  executionSupported: false;
  executionStatus: 'NOT_YET_SUPPORTED';
  reason: string;
  entities: {
    entity: string;
    displayName: string;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  }[];
  /** Reverse dependency order in which created records would be removed. */
  deletionOrder: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationOutcome = 'PASS' | 'WARNING' | 'FAIL';
/**
 * Why a record does not match.
 *
 * `VALUE_LOST` and `VALUE_TRUNCATED` were split out of `VALUE_MISMATCH` because they are different
 * problems with different fixes. A value that arrived wrong is usually a mapping or a
 * transformation; a value that arrived empty is usually a required column the source could not
 * fill; a value that arrived shortened is a column too narrow for the data, which is the one that
 * silently destroys information and still looks plausible.
 */
export type DifferenceType =
  | 'MISSING_IN_TARGET'
  | 'VALUE_MISMATCH'
  /** The source had a value after transformation; the target has none. */
  | 'VALUE_LOST'
  /** The target holds a prefix of the expected value, in a column too narrow to hold it. */
  | 'VALUE_TRUNCATED'
  | 'LOOKUP_MISMATCH'
  | 'BROKEN_REFERENCE'
  | 'PRE_EXISTING_DIFFERENCE';

export interface ValidationCheckDto {
  check:
    | 'SCHEMA'
    | 'ROW_COUNT'
    | 'RECORD_EXISTENCE'
    | 'FIELD_VALUES'
    | 'REFERENCES'
    /**
     * Repeated key values in the target. Its own name rather than a FIELD_VALUES result, because it
     * answers a different question — not "is this record right" but "is there more than one of it" —
     * and because what it proves depends entirely on which key was grouped on. See `uniqueness`.
     */
    | 'UNIQUENESS'
    /**
     * Totals compared across the two sides. Kept apart from ROW_COUNT because they answer different
     * questions: ROW_COUNT compares whole tables, this compares figures over the records this run
     * wrote, and a report that merged them would let a pass on one read as a pass on the other.
     */
    | 'AGGREGATES';
  outcome: ValidationOutcome;
  message: string;
}

export interface ValidationEntityResultDto {
  logicalName: string;
  displayName: string;
  outcome: ValidationOutcome;
  sourceCount: number | null;
  targetCount: number | null;
  /**
   * What the run did with this table's records, or null for a report produced before the platform
   * recorded the breakdown. Null means "not recorded", which a report must say rather than show as
   * a row of zeros.
   */
  accounting: RecordAccounting | null;
  /** Records actually compared against the source. A sample when the table is large. */
  checkedRecords: number;
  /**
   * Records the run itself reported as failed, confirmed absent here.
   *
   * Separate from `missing`, which is validation's own finding. Adding them together made
   * matched + missing + different exceed the number of records examined, because a failed record
   * was never examined — it is not in the target to compare against.
   */
  failedInRun: number;
  /**
   * Records the run could not account for, which is why this report cannot pass.
   *
   * Excluded from the comparison — a record whose write outcome is unknown may or may not be in the
   * target, and comparing it would report either "missing" for something possibly present or "matched"
   * for something nobody can account for. Reported as its own number instead.
   */
  unresolvedInRun: number;
  /**
   * How much of this table was examined, and how those records were chosen. Null for a report
   * produced before coverage was recorded, which the report says rather than implying FULL.
   */
  coverage: ValidationCoverage | null;
  /** Repeated key values found in the target, or null when this connector cannot look. */
  duplicates: DuplicateFindingDto[] | null;
  /**
   * Totals compared across the two sides. Supplementary evidence: totals agreeing does not prove
   * the records agree. Null for a report produced before aggregates were computed.
   */
  aggregates: AggregateCheck[] | null;
  /** Coverage of the duplicate check specifically: it can be NOT_VERIFIED while values pass. */
  duplicateCoverage: ValidationCoverage | null;
  /**
   * Which kind of uniqueness the duplicate scan tested, and therefore what finding none proves.
   * Null on reports produced before the basis was recorded — which a report must say rather than let
   * a primary-key scan be read as evidence of business uniqueness.
   */
  uniqueness: UniquenessCheck | null;
  /**
   * Columns the comparison could not honestly answer for, and why.
   *
   * A JSON document that repeats a key, or a binary value past the size this platform will read, is
   * genuinely unknown — not equal and not different. Counting such a record as matched would be a
   * silent false pass, and counting it as different would report a problem nobody has shown. So the
   * limitation is recorded where it actually lives, which is the column, and the record is still
   * compared on everything else. Null on reports produced before this was recorded.
   */
  uncomparedColumns: UncomparedColumn[] | null;
  matched: number;
  missing: number;
  different: number;
  brokenReferences: number;
  checks: ValidationCheckDto[];
}

/**
 * One column the comparison declined to answer for, and how many records it affected.
 *
 * `reason` is written by the comparison itself, so what a report prints is what the code decided
 * rather than a restatement of it.
 */
export interface UncomparedColumn {
  field: string;
  reason: string;
  /** How many of the examined records hit this. */
  records: number;
}

export interface ValidationSummary {
  tablesValidated: number;
  sourceRows: number;
  targetRows: number;
  /** The run's own accounting, totalled across the validated tables. Null for older reports. */
  accounting: RecordAccounting | null;
  /** The weakest coverage any validated table can support. Null for older reports. */
  coverage: ValidationCoverage | null;
  /** How deep this validation was asked to go. Null for reports that predate the setting. */
  depth: ValidationDepth | null;
  /** Records sharing a key value that should be unique, across every validated table. */
  duplicateRecords: number;
  /**
   * How many validated tables had their *business-level* uniqueness tested — grouped on a key the
   * target does not simply enforce for us.
   *
   * Zero alongside `duplicateRecords: 0` is the case worth stating out loud: every table was counted
   * over its own primary key, which can never repeat, so the report establishes nothing about whether
   * the data is unique. Without this number a clean summary reads as "no duplicates" when what was
   * proven is "no duplicate primary keys". Null on reports produced before it was recorded.
   */
  businessUniquenessVerifiedTables: number | null;
  matchedRecords: number;
  missingRecords: number;
  /** Records the run reported as failed. Not a validation finding; the run already knew. */
  failedInRunRecords: number;
  differentRecords: number;
  brokenReferences: number;
  pass: number;
  warning: number;
  fail: number;
}

/**
 * A key value that occurs more than once where it should occur at most once.
 *
 * `attributable` answers the question a migration lead actually asks — did we do this? — and is
 * only set when the evidence supports an answer: the run's own identity map says how many of these
 * records it wrote. Null means the duplicates are there and nothing in this run's records proves
 * who put them there.
 */
export interface DuplicateFindingDto {
  /** The columns that were expected to be unique together. */
  columns: string[];
  /** The repeated value, rendered for display. */
  value: string;
  /** How many records share it. */
  occurrences: number;
  /** A few of the records, for somebody to go and look at. Never the whole group. */
  sampleIds: string[];
  /** How many of these records this run wrote, when the identity map can say. */
  writtenByThisRun: number | null;
  /** Whether this run appears to have introduced the duplication. Null when unprovable. */
  attributable: boolean | null;
}

export interface ValidationRunDto {
  id: string;
  status: JobRunStatus;
  outcome: ValidationOutcome | null;
  migrationRunId: string | null;
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  tables: string[];
  /** How deep this validation was asked to go. */
  depth: ValidationDepth;
  summary: ValidationSummary | null;
  entities: ValidationEntityResultDto[];
  errorMessage: string | null;
  progressMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
}

export interface ValidationDifferenceDto {
  id: string;
  entity: string;
  sourceRecordId: string | null;
  targetRecordId: string | null;
  field: string | null;
  sourceValue: string | null;
  targetValue: string | null;
  differenceType: DifferenceType;
  outcome: ValidationOutcome;
}

// ---------------------------------------------------------------------------
// Preflight (dry run)
// ---------------------------------------------------------------------------

/** What the migration would do with a source record. No writes happen to determine this. */
export type PreflightAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'CONFLICT' | 'BLOCKED';

export interface PreflightTotals {
  sourceRecords: number;
  analyzed: number;
  create: number;
  update: number;
  unchanged: number;
  conflict: number;
  blocked: number;
}

export interface PreflightEntityResultDto extends PreflightTotals {
  logicalName: string;
  displayName: string;
  matchDescription: string;
  /** True when only part of the table was analyzed (very large tables). */
  sampled: boolean;
  /**
   * How many records the drill-down actually holds.
   *
   * Separate from the totals on purpose. The totals count every record analysed; the per-record list
   * is capped per action, so a table can report 47,000 blocked records and store 2,000 of them. That
   * gap is invisible unless it is stated, and the remediation package — the artefact a migration team
   * works from — is built from the stored list.
   */
  recordsStored: number;
  /** True when at least one action hit the per-action storage cap. */
  recordsTruncated: boolean;
}

export interface FieldChangeDto {
  field: string;
  displayName: string;
  sourceValue: string | null;
  targetValue: string | null;
  action: 'SET' | 'CLEAR' | 'UNCHANGED';
}

export interface PreflightRecordDto {
  id: string;
  entity: string;
  sourceRecordId: string;
  recordName: string | null;
  action: PreflightAction;
  targetRecordId: string | null;
  matchMethod: string | null;
  reasonCode: string | null;
  reason: string | null;
  changes: FieldChangeDto[];
  /** Fields where a transformation discarded information for this record. */
  lossy?: LossyRecordDetail[];
}

export interface PreflightRunDto {
  id: string;
  planId: string;
  planName: string;
  status: JobRunStatus;
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  options: PlanOptions;
  totals: PreflightTotals;
  entities: PreflightEntityResultDto[];
  /** Unresolved/ambiguous identities found while analyzing, for the acknowledgement screen. */
  identityImpact: IdentityImpactDto;
  /** Exactly how many records each lossy transformation actually changes. */
  lossyImpact: LossyImpactDto[];
  progressMessage: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
}

/** What an ownership substitution would actually do, shown before execution. */
export interface IdentityImpactDto {
  policy: UserResolutionPolicy;
  fallbackPrincipal: FallbackPrincipalDto | null;
  unresolvedPrincipals: {
    logicalName: PrincipalTable;
    id: string;
    name: string | null;
    records: number;
    fields: string[];
  }[];
  recordsAffected: number;
  fieldsAffected: string[];
}

/** One row of the remediation package. */
export interface IssueRowDto {
  severity: 'BLOCKER' | 'WARNING' | 'INFO';
  category: string;
  table: string | null;
  sourceRecordId: string | null;
  recordName: string | null;
  field: string | null;
  sourceValue: string | null;
  targetValue: string | null;
  issue: string;
  resolution: string | null;
  suggestedAction: string | null;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticStatus = 'PASS' | 'FAIL' | 'WARN' | 'NOT_TESTED';

export interface DiagnosticCheckDto {
  key: string;
  label: string;
  status: DiagnosticStatus;
  message: string;
  /** Actionable hint for failures; never contains tokens or raw payloads. */
  resolution?: string | null;
  durationMs?: number;
}

export interface DiagnosticsReportDto {
  ranAt: string;
  mode: { demoMode: boolean; realTenantReadOnly: boolean };
  sourceEnvironment: EnvRef | null;
  targetEnvironment: EnvRef | null;
  checks: DiagnosticCheckDto[];
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export interface ProfileDto {
  environmentId: string;
  table: string;
  count: number;
  countApproximate: boolean;
  primaryIdAttribute: string;
  primaryNameAttribute: string | null;
  sampleSize: number;
  nullStats: { field: string; displayName: string; nullCount: number; nullPercent: number }[];
  sampleRecords: { id: string; values: Record<string, FieldValue> }[];
}

export interface AuditEventDto {
  id: string;
  action: string;
  outcome: string;
  user: string | null;
  sourceEnvironment: string | null;
  targetEnvironment: string | null;
  runId: string | null;
  /** The project the action belonged to, where it belonged to one. */
  projectId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardDto {
  environments: { total: number; connected: number };
  /** Work in progress, which is what the dashboard is now organized around. */
  projects: { analysis: number; migration: number };
  analyses: { total: number; completed: number; active: number; blockers: number };
  schedules: { total: number; enabled: number; paused: number; needsAttention: number };
  recentProjects: ProjectDto[];
  recentAnalyses: AnalysisRunListItemDto[];
  /** Schedules due next, so the dashboard says what will happen without anyone asking. */
  upcomingSchedules: MigrationScheduleDto[];
  migrationRuns: { total: number; completed: number; withErrors: number; failed: number; active: number };
  validationRuns: { total: number; pass: number; warning: number; fail: number };
  recentMigrationRuns: MigrationRunListItemDto[];
  recentValidationRuns: {
    id: string;
    status: JobRunStatus;
    outcome: ValidationOutcome | null;
    sourceEnvironment: EnvRef;
    targetEnvironment: EnvRef;
    createdAt: string;
  }[];
  lastComparison: ComparisonRunDto | null;
}

// ---------------------------------------------------------------------------
// Projects: the container a piece of work belongs to
// ---------------------------------------------------------------------------

/**
 * What a project is for. The distinction is real, not cosmetic: an analysis project reads a source
 * and never has a target, while a migration project writes and therefore carries every safety gate.
 */
export const PROJECT_KINDS = ['ANALYSIS', 'MIGRATION', 'COMPARISON'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  ANALYSIS: 'Data analysis',
  MIGRATION: 'Data migration',
  COMPARISON: 'Comparison & validation',
};

export const PROJECT_KIND_DESCRIPTIONS: Record<ProjectKind, string> = {
  ANALYSIS:
    'Connect to a source and understand it: tables, columns, volumes, data quality and relationships. Read-only — nothing is ever written.',
  MIGRATION:
    'Move data into a target. Can start from an analysis project, so the mapping begins from what the source actually contains.',
  COMPARISON:
    'Compare two datasets record by record: what matches, what differs field by field, what exists on only one side. Read-only on both sides — it never writes anywhere.',
};

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED';

export interface ProjectDto {
  id: string;
  name: string;
  kind: ProjectKind;
  description: string | null;
  status: ProjectStatus;
  /** The source being analysed or migrated. Set on both kinds once chosen. */
  sourceEnvironment: EnvRef | null;
  /**
   * Every dataset this project is about, in the order they were added.
   *
   * An analysis project may have several: four workbooks, or a database and a spreadsheet of corrections.
   * `sourceEnvironment` is the first of these, kept for the workflows whose source genuinely is one thing.
   * A migration or comparison project has exactly the one.
   */
  sources: EnvRef[];
  /** Migration projects only. */
  targetEnvironment: EnvRef | null;
  /** A migration project may be informed by an analysis project's findings. */
  analysisProject: { id: string; name: string } | null;
  /** How many analyses (analysis projects) or plans (migration projects) it holds. */
  itemCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a migration project is, in one answer.
 *
 * The screen this feeds has thirty seconds to say what is being moved, from where, to where, how much of
 * it, whether it is safe to run, what is stopping it, what happened last time, and what to do next. That
 * is eight questions, and the shape leads with the answers rather than with a list of pages.
 *
 * Assembled on read from evidence that already exists — the project's two ends, its plan, the readiness
 * assessment, the latest run. Nothing here is stored, so nothing can drift out of step with the thing it
 * describes.
 */
export interface MigrationWorkspaceDto {
  projectId: string;
  projectName: string;
  description: string | null;
  status: MigrationProjectStatus;
  source: EnvRef | null;
  target: EnvRef | null;
  /**
   * What the destination can actually do, decided by the same function that refuses the write.
   *
   * §9: a read-only or simulated target must never appear executable. The engine refuses it either way;
   * this is so nobody plans a weekend cutover around finding that out at the end.
   */
  targetCapability: {
    /** Whether this deployment would permit a write to it at all. */
    writable: boolean;
    /** Why, in the words the write guard itself uses. */
    reason: string;
    /** A simulator rather than a real system: a run proves the configuration, not the destination. */
    simulated: boolean;
  } | null;
  /** The project's current configuration. Null until source data has been added. */
  plan: {
    id: string;
    datasets: number;
    /** Source records across the scope, where they have been counted. Null where they have not. */
    records: number | null;
    blockers: number;
    warnings: number;
    updatedAt: string;
  } | null;
  /**
   * Whether this can safely execute, from the readiness service rather than a second opinion.
   * Null when there is no configuration to assess yet.
   */
  readiness: {
    verdict: ReadinessVerdict;
    summary: string;
    blockers: number;
    warnings: number;
    /** The few worth putting on the overview, worst first. */
    top: ReadinessFinding[];
  } | null;
  lastRun: {
    id: string;
    status: MigrationRunStatus;
    attempt: number;
    startedAt: string | null;
    finishedAt: string | null;
    succeeded: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
  /** How many runs this project has had, so "what happened last time" has a history behind it. */
  runCount: number;
  /** The one thing to do next, named as an action rather than as a stage. */
  nextAction: {
    kind:
      | 'ADD_SOURCE_DATA'
      | 'CHOOSE_DESTINATION'
      | 'RESOLVE_BLOCKERS'
      | 'REVIEW_WARNINGS'
      | 'PREPARE'
      | 'EXECUTE'
      | 'REVIEW_FAILURES'
      /** Nothing failed and the data is not complete. A distinct action, because there is nothing to fix
       * in the failure list — the work is to add the missing dataset and run again. */
      | 'REVIEW_OMITTED_REFERENCES'
      | 'VALIDATE'
      | 'WATCH_RUN';
    label: string;
    detail: string;
  };
}

/**
 * What state a migration project is actually in.
 *
 * Derived, never stored, and never a step number. "Step 6 of 9" describes the product; these describe
 * the work, which is the only thing a person planning a weekend cutover is asking about.
 */
export type MigrationProjectStatus =
  'DRAFT' | 'PREPARING' | 'BLOCKED' | 'READY' | 'RUNNING' | 'COMPLETED_WITH_ISSUES' | 'COMPLETED';

export const MIGRATION_PROJECT_STATUS_LABELS: Record<MigrationProjectStatus, string> = {
  DRAFT: 'Draft',
  PREPARING: 'Preparing',
  BLOCKED: 'Blocked',
  READY: 'Ready',
  RUNNING: 'Running',
  COMPLETED_WITH_ISSUES: 'Completed with issues',
  COMPLETED: 'Completed',
};

// ---------------------------------------------------------------------------
// Data comparison: two datasets, reconciled record by record
// ---------------------------------------------------------------------------

/**
 * Deliberately not called "comparison" on its own: this product already has one of those, and it
 * compares *schemas* between two environments. This compares the data — the rows, field by field —
 * and the two answer different questions. `DataComparison` everywhere keeps them apart.
 */
export type DataComparisonStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/**
 * How a record on one side relates to the other side.
 *
 * `DUPLICATE_KEY` is not a comparison result so much as a reason the comparison cannot be trusted
 * for those records: if a key appears twice, no honest answer exists to "which one does it match?",
 * so they are reported rather than silently paired with the first.
 */
export type ComparisonDifferenceType =
  'VALUE_DIFFERS' | 'ONLY_IN_LEFT' | 'ONLY_IN_RIGHT' | 'DUPLICATE_KEY' | 'BLANK_KEY';

/** One column on each side, paired. The names differ between systems more often than not. */
export interface ComparisonFieldPairDto {
  left: string;
  right: string;
}

export interface ComparisonTablePairDto {
  leftTable: string;
  rightTable: string;
  /** The columns that identify the same real-world record on each side. At least one. */
  key: ComparisonFieldPairDto[];
  /** Columns compared field by field. Empty means keys only: existence, not content. */
  fields: ComparisonFieldPairDto[];
}

export interface DataComparisonOptions {
  pairs: ComparisonTablePairDto[];
}

/**
 * The numbers, arranged so that no record can go missing without the arithmetic showing it:
 *
 *     matched + different + onlyInLeft  === leftRecords  - leftExcluded
 *     matched + different + onlyInRight === rightRecords - rightExcluded
 *
 * That identity is asserted by a test. A reconciliation tool whose own totals do not reconcile has
 * no business telling anyone their data does not.
 */
export interface ComparisonTotalsDto {
  /** Records read from each side, after the per-side cap. */
  leftRecords: number;
  rightRecords: number;
  /** Records set aside because their key was empty or not unique, and so cannot be paired. */
  leftExcluded: number;
  rightExcluded: number;
  /** Left records paired with a right record and equal on every compared field. */
  matched: number;
  /** Paired, but at least one compared field differs. */
  different: number;
  onlyInLeft: number;
  onlyInRight: number;
  /** Excluded records, by reason. Both sides summed, for display. */
  duplicateKeys: number;
  blankKeys: number;
  /** Individual field differences across every compared record. */
  fieldDifferences: number;
}

export interface DataComparisonTableResultDto extends ComparisonTotalsDto {
  leftTable: string;
  rightTable: string;
  displayName: string;
  outcome: ValidationOutcome;
  /** Exact row counts from each side, independent of how many were read. */
  leftCount: number | null;
  rightCount: number | null;
  /** True when the per-side cap stopped the read before the end of the table. */
  leftTruncated: boolean;
  rightTruncated: boolean;
  /** Columns compared, and the ones that exist on one side only — the "missing fields" answer. */
  comparedFields: ComparisonFieldPairDto[];
  fieldsOnlyInLeft: string[];
  fieldsOnlyInRight: string[];
  checks: ValidationCheckDto[];
}

export interface DataComparisonDto {
  id: string;
  projectId: string;
  name: string;
  status: DataComparisonStatus;
  leftEnvironment: EnvRef | null;
  rightEnvironment: EnvRef | null;
  options: DataComparisonOptions;
  totals: ComparisonTotalsDto;
  outcome: ValidationOutcome;
  tables: DataComparisonTableResultDto[];
  progressMessage: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface DataComparisonListItemDto {
  id: string;
  name: string;
  status: DataComparisonStatus;
  outcome: ValidationOutcome;
  totals: ComparisonTotalsDto;
  tableCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ComparisonDifferenceDto {
  leftTable: string;
  /** The key value this difference is about, rendered as the user chose the key. */
  keyValue: string;
  differenceType: ComparisonDifferenceType;
  /** Null for a whole-record difference (only on one side, duplicate key). */
  field: string | null;
  leftValue: string | null;
  rightValue: string | null;
}

/** What the setup screen proposes, so a comparison is a confirmation rather than data entry. */
export interface ComparisonSuggestionDto {
  leftTable: string;
  rightTable: string;
  displayName: string;
  key: ComparisonFieldPairDto[];
  fields: ComparisonFieldPairDto[];
  /** Why this pairing was proposed, and what a person should check about it. */
  rationale: string;
  /** False when no usable key could be proposed: the pair needs a person to choose one. */
  keyProposed: boolean;
}

// ---------------------------------------------------------------------------
// Source analysis
// ---------------------------------------------------------------------------

export type AnalysisStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface AnalysisOptions {
  /** Tables to analyse. Empty means every migratable table in the source. */
  tables: string[];
  /** Records examined per table when not running a full analysis. */
  sampleSize: number;
  /** Examine every record, honoured up to the profiling service's own ceiling. */
  full: boolean;
}

export interface AnalysisTotalsDto {
  tables: number;
  columns: number;
  records: number;
  /** True when any table could only report an estimated row count. */
  recordsApproximate: boolean;
  examined: number;
  findings: number;
  blockers: number;
  warnings: number;
  emptyTables: number;
  /** Tables holding a column whose values are all null or blank. */
  unusedColumns: number;
}

export interface AnalysisRunDto {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  environment: EnvRef;
  status: AnalysisStatus;
  options: AnalysisOptions;
  totals: AnalysisTotalsDto;
  /** EXACT only when every table was read in full against an exact row count. */
  basis: StatisticBasis | null;
  progressMessage: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  tables: AnalysisTableDto[];
}

export interface AnalysisRunListItemDto {
  id: string;
  projectId: string;
  name: string;
  environmentName: string;
  status: AnalysisStatus;
  basis: StatisticBasis | null;
  totals: AnalysisTotalsDto;
  createdAt: string;
  completedAt: string | null;
}

/**
 * An entity relationship diagram of what an analysis looked at.
 *
 * Laid out by the same dependency analysis that decides load order, so the picture and the order a
 * migration runs in are the same fact drawn two ways: a table to the left of another must exist
 * before it.
 */
export interface ErdNodeDto {
  logicalName: string;
  displayName: string;
  recordCount: number;
  columnCount: number;
  /** Distance from a table that depends on nothing. Drawn as the column it sits in. */
  depth: number;
  /** The column that identifies a row, where the source names one. */
  keyColumn: string | null;
  /** Tables in a reference cycle share a group, and the order between them cannot be resolved. */
  cycleGroup: number | null;
}

export interface ErdEdgeDto {
  /** The referenced table: it must exist first. */
  from: string;
  /** The referencing table: it holds the column. */
  to: string;
  /** The column on `to` that points at `from`. */
  attribute: string;
  required: boolean;
  /** Part of a cycle, so this reference is resolved in a second pass. */
  deferred: boolean;
}

export interface ErdDto {
  nodes: ErdNodeDto[];
  edges: ErdEdgeDto[];
  /** References to tables outside the analysis, which the diagram cannot draw. */
  externalReferences: { from: string; attribute: string; to: string }[];
}

export interface AnalysisTableDto {
  logicalName: string;
  displayName: string;
  recordCount: number;
  recordCountApproximate: boolean;
  columnCount: number;
  examined: number;
  basis: StatisticBasis;
  blockers: number;
  warnings: number;
  /** Where this table sits in a dependency-safe load order. */
  orderIndex: number;
  /** Source tables this one points at through a lookup or foreign key. */
  dependsOn: string[];
  /** Columns whose values were entirely null or blank in everything examined. */
  emptyColumns: string[];
  primaryKeyField: string | null;
  duplicateKeyCount: number;
}

/** The full column-level profile of one analysed table, loaded on demand. */
export interface AnalysisTableDetailDto extends AnalysisTableDto {
  profile: TableProfileDto;
  findings: AnalysisFindingDto[];
}

/**
 * How far an analysis of one dataset has got.
 *
 * `STALE` is the one worth naming: the dataset was analysed, and then it changed. Showing the old findings
 * without saying so is how somebody acts on an assessment of data that no longer exists.
 */
export type DatasetAnalysisState = 'NOT_ANALYSED' | 'QUEUED' | 'RUNNING' | 'ANALYSED' | 'STALE' | 'FAILED';

/**
 * What a file turned out to contain, before anything is stored.
 *
 * Produced by the same reader and the same type inference the import uses, so what is shown is what will
 * be added. Nothing in the database changes to produce one.
 */
export interface StagedPreviewDto {
  filename: string;
  bytes: number;
  tables: StagedPreviewTableDto[];
  /** Sheets that held nothing usable, named with the reason rather than silently dropped. */
  skipped: { name: string; reason: string }[];
}

export interface StagedPreviewTableDto {
  /**
   * The sheet this came from, as the reader named it. Always set, and the identifier the import is
   * given to say which sheets to take — a display name is not unique enough to select by.
   */
  sheet: string;
  /** Set only for a workbook with more than one sheet, where it is the thing that tells them apart. */
  sheetName: string | null;
  displayName: string;
  logicalName: string;
  rowCount: number;
  columnCount: number;
  /** The column that identifies a row, or null when the file offers none and a row number was used. */
  keyColumn: string | null;
  columns: StagedPreviewColumnDto[];
  sampleRows: string[][];
}

export interface StagedPreviewColumnDto {
  name: string;
  type: AttributeType;
  blanks: number;
  distinct: number | null;
  unique: boolean;
  /** Why this type was chosen, in one line. */
  reason: string;
  /** What the values appear to mean, when that differs from how they are stored. */
  semantic: SemanticReading | null;
}

/** One dataset inside an analysis project, with what was found in it. */
/**
 * One concrete thing that was selected: a sheet, a table, a list.
 *
 * This is what the word "dataset" means to the person using the product — `Customers`, not "the
 * connection that happens to hold Customers". A connection may hold several, and a workbook usually
 * does, so the screen lists these rather than the connections that carry them.
 */
export interface AssessedObjectDto {
  /** Its identity inside the connection. Stable across re-imports, which is what makes replace work. */
  logicalName: string;
  displayName: string;
  /** The sheet it was read from, when a workbook had more than one. Null for anything else. */
  sheetName: string | null;
  /**
   * How much of it there is, or null when that is not known yet.
   *
   * Known from the moment an upload lands, because its rows are here. Not known for a table on somebody
   * else's server until an analysis has counted it — and "0 records" beside a table that plainly has
   * millions is worse than saying nothing, because it reads as an answer.
   */
  recordCount: number | null;
  columnCount: number | null;
  /** The file, drive item or list the rows came from, for "where did this come from". */
  origin: string | null;
  /** Whether the latest completed analysis covered it. */
  analysed: boolean;
}

export interface AssessedDatasetDto {
  environmentId: string;
  name: string;
  connectionType: string | null;
  provider: string | null;
  analysed: boolean;
  state: DatasetAnalysisState;
  /** Set when the last run failed, so the screen can say what went wrong rather than "not analysed". */
  failureMessage: string | null;
  analysisRunId: string | null;
  analysedAt: string | null;
  tables: number;
  records: number;
  critical: number;
  warning: number;
  info: number;
  /**
   * The concrete content this dataset resolves to.
   *
   * Empty means the connection is in the project but nothing in it has been selected or seen yet —
   * which the server already refuses to analyse, and which the screen should say plainly rather than
   * showing a dataset that is not one.
   */
  objects: AssessedObjectDto[];
}

/**
 * What an analysis project found, across every dataset in it.
 *
 * The screen this feeds answers one question — "what did you find?" — so the shape leads with the verdict
 * and the findings, and the per-dataset breakdown is underneath. Assembled on read from the stored
 * profiles; see `AssessmentService` for why.
 */
export interface AnalysisAssessmentDto {
  projectId: string;
  projectName: string;
  datasets: AssessedDatasetDto[];
  tables: number;
  records: number;
  readiness: AnalysisReadiness;
  findings: Finding[];
  /**
   * What people have decided about these findings, keyed by finding id.
   *
   * Carried beside the findings rather than merged into them, which is the same separation the storage
   * keeps: the engine's observation and the human's judgement are different kinds of claim and must stay
   * distinguishable on the screen as well as in the database.
   */
  dispositions: FindingDisposition[];
  /** A paragraph assembled from the findings, for somebody who will read it aloud. */
  summary: string;
  /** Every analysis run in this project, newest first, so a reader can see what changed and when. */
  runs: AnalysisRunSummaryDto[];
}

/** One run, for the lineage a reader needs to answer "what changed between analyses". */
export interface AnalysisRunSummaryDto {
  id: string;
  datasetName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tables: number;
  records: number;
}

export interface AnalysisFindingDto {
  table: string;
  field: string | null;
  severity: 'BLOCKER' | 'WARNING';
  code: string;
  message: string;
  affected: number;
  basis: StatisticBasis;
  resolution: string | null;
}

// ---------------------------------------------------------------------------
// The mapping workbook
// ---------------------------------------------------------------------------

/**
 * The columns of the field-mapping sheet, in order. Exported as data because the importer matches
 * a returned workbook on these labels — someone will reorder them, and that has to keep working.
 */
export const MAPPING_SHEET_COLUMNS = [
  'Source table',
  'Source field',
  'Source type',
  'Required',
  'Max length',
  'Records',
  'Nulls',
  'Blanks',
  'Distinct',
  'Sample value',
  'Target table',
  'Target field',
  /** Read-only: a one-line rendering. Pipelines are edited on the Transformations sheet. */
  'Transformation (reference)',
  'Notes',
] as const;

/** What an imported workbook would change, before anything is written. */
export interface MappingImportPreviewDto {
  /** Rows the workbook contained that name a field this plan has. */
  matched: number;
  /** Rows naming a table or field the plan does not contain. */
  unmatched: { row: number; table: string; field: string; reason: string }[];
  changes: MappingImportChangeDto[];
  /** Rows that asked for something the plan cannot hold, each naming its row. */
  rejected: { row: number; table: string; field: string; reason: string }[];
  /** Columns whose transformation pipeline the workbook changes. */
  transformationsChanged: number;
  applied: boolean;
}

export interface MappingImportChangeDto {
  table: string;
  field: string;
  from: string | null;
  to: string | null;
  action: 'MAP' | 'REMAP' | 'IGNORE' | 'UNCHANGED';
}

// ---------------------------------------------------------------------------
// Scheduled and triggered runs
// ---------------------------------------------------------------------------

/**
 * How a scheduled run reads the source.
 *
 * FULL re-reads every record; the engine still only writes what differs, so a repeated full run is
 * idempotent. INCREMENTAL additionally asks the source for records changed since the last run's
 * high-water mark, which is the only way to keep up with a table that changes continuously.
 */
export const SCHEDULE_MODES = ['FULL', 'INCREMENTAL'] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

export interface MigrationScheduleDto {
  id: string;
  planId: string;
  planName: string;
  name: string;
  /** Five-field cron expression: minute hour day-of-month month day-of-week. */
  cron: string;
  /** IANA zone the expression is interpreted in, so 02:00 means 02:00 locally all year. */
  timeZone: string;
  description: string;
  enabled: boolean;
  mode: ScheduleMode;
  /** The column INCREMENTAL compares against, e.g. `modifiedon`. */
  watermarkField: string | null;
  /** Highest watermark value a run of this schedule has read. */
  lastWatermark: string | null;
  /** Warning codes reviewed when this schedule was last confirmed. */
  acknowledgedWarnings: string[];
  /**
   * Warning codes the plan has now that were not reviewed. Non-empty means the schedule will refuse
   * to fire until someone looks and re-confirms.
   */
  unreviewedWarnings: string[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Paused automatically after repeated failures rather than retrying forever. */
  pausedReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRunHistoryItemDto {
  runId: string;
  status: string;
  trigger: RunTrigger;
  startedAt: string | null;
  completedAt: string | null;
  created: number;
  updated: number;
  failed: number;
}

/** Why a run started. Recorded on the run so history distinguishes a person from a schedule. */
export const RUN_TRIGGERS = ['MANUAL', 'SCHEDULED', 'TRIGGERED'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

// ---------------------------------------------------------------------------
// Staged sources: everything that is not a live queryable database
// ---------------------------------------------------------------------------

/**
 * Where a staged table's rows came from.
 *
 * A spreadsheet, a list and a file in cloud storage have something in common that separates all of
 * them from a database: you cannot ask them a question. There is no server to plan a query, no index
 * to page by, no transaction. So instead of pretending otherwise, the rows are read once, kept, and
 * re-read on demand — which also means the provenance of every row is recorded, and a migration can
 * be repeated against exactly the data somebody signed off.
 */
export const STAGED_SOURCE_KINDS = ['UPLOAD', 'ONEDRIVE', 'SHAREPOINT'] as const;
export type StagedSourceKind = (typeof STAGED_SOURCE_KINDS)[number];

export const STAGED_SOURCE_LABELS: Record<StagedSourceKind, string> = {
  UPLOAD: 'Uploaded file',
  ONEDRIVE: 'OneDrive / SharePoint file',
  SHAREPOINT: 'SharePoint list',
};

/** One imported table, with how it was read and what was inferred about it. */
export interface StagedTableDto {
  logicalName: string;
  displayName: string;
  kind: StagedSourceKind;
  /** The file name, drive item or list this came from. */
  sourceRef: string;
  /** The sheet within a workbook, when there was more than one. */
  sheetName: string | null;
  rowCount: number;
  columnCount: number;
  /** The column that identifies a row, and whether it had to be invented. */
  keyColumn: string;
  keyIsSynthetic: boolean;
  importedAt: string;
  importedBy: string | null;
  columns: StagedColumnDto[];
}

/** One inferred column, with the reasoning, so the guess is inspectable rather than magic. */
export interface StagedColumnDto {
  name: string;
  type: AttributeType;
  maxLength: number | null;
  blanks: number;
  distinct: number | null;
  unique: boolean;
  /** Why this type was chosen, in one line. */
  reason: string;
}

/** What an import did, or would do. */
export interface StagedImportResultDto {
  tables: StagedTableDto[];
  /** Sheets that were skipped, and why — an empty tab is normal and should not look like a failure. */
  skipped: { name: string; reason: string }[];
  totalRows: number;
  /**
   * Tables this import overwrote.
   *
   * A table's name is its identity here: importing over it deletes the rows that were there, which
   * is right for a snapshot and wrong to do silently. Re-importing the same file is the ordinary
   * case; `previousSourceRef` differing from the file just imported means two different files
   * resolved to one name, and the earlier one's rows are now gone.
   */
  replaced: {
    logicalName: string;
    displayName: string;
    previousRows: number;
    previousSourceRef: string;
  }[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}
