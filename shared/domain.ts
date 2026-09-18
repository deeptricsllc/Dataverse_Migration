/**
 * Domain enums and API DTOs shared between server and web.
 */
import type { AttributeType, FieldValue, OptionMeta, RequiredLevel } from './metadata';

// ---------------------------------------------------------------------------
// Session / environments
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  displayName: string;
  email: string | null;
  role: 'ADMIN' | 'MEMBER';
  organization: { id: string; name: string; isDemo: boolean };
  authProvider: 'microsoft' | 'demo';
}

export interface AuthConfigDto {
  microsoftEnabled: boolean;
  demoEnabled: boolean;
  /** Certification mode: reads are allowed, every Dataverse write is blocked server-side. */
  realTenantReadOnly: boolean;
}

export interface SessionResponseDto {
  user: SessionUser | null;
  csrfToken: string | null;
  realTenantReadOnly: boolean;
}

export type EnvironmentProvider = 'dataverse' | 'demo' | 'sqlserver' | 'azuresql' | 'demosql';
export type ConnectionStatus = 'UNKNOWN' | 'CONNECTED' | 'FAILED';

/** The kind of system a connection points at. Chosen by the user when adding a connection. */
export type ConnectionType = 'DATAVERSE' | 'SQL_SERVER' | 'AZURE_SQL';

/** Connections of the same family share a connector implementation and a metadata dialect. */
export type ProviderFamily = 'DATAVERSE' | 'SQL';

export const connectionFamily = (t: ConnectionType): ProviderFamily =>
  t === 'DATAVERSE' ? 'DATAVERSE' : 'SQL';

export const CONNECTION_TYPE_LABELS: Record<ConnectionType, string> = {
  DATAVERSE: 'Microsoft Dataverse',
  SQL_SERVER: 'SQL Server',
  AZURE_SQL: 'Azure SQL',
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
  /** TO_DATETIME: treat a source value without a zone as UTC rather than local. */
  assumeUtc?: boolean | null;
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
]);

export const isLossyRule = (r: TransformationRule) => LOSSY_TRANSFORMATIONS.has(r.kind);

/** One step of what the engine actually did to a value, for previews and per-record reporting. */
export interface AppliedTransformationDto {
  kind: TransformationKind;
  before: string | null;
  after: string | null;
  lossy: boolean;
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
  origin: 'TARGET_SCHEMA' | 'MAPPING' | 'USER';
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
  | 'COMPLETED_WITH_ERRORS'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL_RUN_STATUSES: ReadonlySet<MigrationRunStatus> = new Set([
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
]);

export type RunEntityStatus =
  'PENDING' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'SKIPPED';
export type RecordOutcome = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED';
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
  startedAt: string | null;
  completedAt: string | null;
}

export interface MigrationRunDto extends RunCounters {
  id: string;
  planId: string;
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
}

export interface RecordMapDto {
  entity: string;
  sourceId: string;
  targetId: string | null;
  outcome: RecordOutcome;
  matchMethod: string | null;
  deferredStatus: string | null;
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
export type DifferenceType =
  'MISSING_IN_TARGET' | 'VALUE_MISMATCH' | 'LOOKUP_MISMATCH' | 'BROKEN_REFERENCE' | 'PRE_EXISTING_DIFFERENCE';

export interface ValidationCheckDto {
  check: 'SCHEMA' | 'ROW_COUNT' | 'RECORD_EXISTENCE' | 'FIELD_VALUES' | 'REFERENCES';
  outcome: ValidationOutcome;
  message: string;
}

export interface ValidationEntityResultDto {
  logicalName: string;
  displayName: string;
  outcome: ValidationOutcome;
  sourceCount: number | null;
  targetCount: number | null;
  migratedRecords: number;
  checkedRecords: number;
  matched: number;
  missing: number;
  different: number;
  brokenReferences: number;
  checks: ValidationCheckDto[];
}

export interface ValidationSummary {
  tablesValidated: number;
  sourceRows: number;
  targetRows: number;
  migratedRows: number;
  matchedRecords: number;
  missingRecords: number;
  differentRecords: number;
  brokenReferences: number;
  pass: number;
  warning: number;
  fail: number;
}

export interface ValidationRunDto {
  id: string;
  status: JobRunStatus;
  outcome: ValidationOutcome | null;
  migrationRunId: string | null;
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  tables: string[];
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
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardDto {
  environments: { total: number; connected: number };
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

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}
