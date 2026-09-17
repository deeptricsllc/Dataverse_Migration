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
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type DependencyKind =
  | 'IN_SELECTION'
  | 'NOT_SELECTED'
  | 'PLATFORM'
  | 'SELF'
  | 'MISSING_IN_TARGET';

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
  missingDependencies: { table: string; requiredBy: { table: string; attribute: string; required: boolean }[] }[];
}

// ---------------------------------------------------------------------------
// Migration planning
// ---------------------------------------------------------------------------

export type ConflictStrategy = 'SKIP_EXISTING' | 'CREATE_ONLY' | 'UPSERT';
export type MatchStrategy = 'PRIMARY_ID' | 'ALTERNATE_KEY';
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
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  conflictStrategy: 'SKIP_EXISTING',
  batchSize: 50,
  maxRetries: 4,
  bypassCustomBusinessLogic: false,
  suppressFlowTriggers: false,
  stopOnFirstError: false,
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

export type RunEntityStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'SKIPPED';
export type RecordOutcome = 'CREATED' | 'UPDATED' | 'SKIPPED' | 'FAILED';
export type RecordOperation = 'READ' | 'CREATE' | 'UPDATE' | 'MATCH' | 'RESOLVE_LOOKUP' | 'DEFERRED_UPDATE';

export interface RunCounters {
  total: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
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
  | 'MISSING_IN_TARGET'
  | 'VALUE_MISMATCH'
  | 'LOOKUP_MISMATCH'
  | 'BROKEN_REFERENCE'
  | 'PRE_EXISTING_DIFFERENCE';

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
