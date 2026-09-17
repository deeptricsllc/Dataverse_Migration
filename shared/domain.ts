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

export type EnvironmentProvider = 'dataverse' | 'demo';
export type ConnectionStatus = 'UNKNOWN' | 'CONNECTED' | 'FAILED';

export interface EnvironmentDto {
  id: string;
  provider: EnvironmentProvider;
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
}

export interface PlanEntityDto {
  id: string;
  logicalName: string;
  displayName: string;
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
