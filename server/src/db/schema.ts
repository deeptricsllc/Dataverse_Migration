import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ComparisonSummary,
  DependencyAnalysisDto,
  DependencyEdgeDto,
  PlanIssue,
  PlanOptions,
  PropertyDifference,
  ColumnDiff,
  RelationshipDiff,
  KeyDiff,
  ValidationCheckDto,
  ValidationSummary,
  AutomationInfo,
} from '../../../shared/domain';
import type {
  ChoiceMappingDto,
  ConnectionType,
  EnvironmentProvider,
  FieldChangeDto,
  FieldTransformDto,
  IdentityImpactDto,
  ObjectMappingStatus,
  SqlConnectionConfig,
  TransformationMetricsDto,
  TransformationRule,
  TypeCompatibility,
  PreflightAction,
  PreflightTotals,
  PrincipalDto,
  PrincipalMatchStatus,
  PrincipalTable,
} from '../../../shared/domain';
import type { TableMetadata, TableSummary } from '../../../shared/metadata';
import type { RunPlanSnapshot } from '../services/run-snapshot';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  /** Microsoft Entra tenant id (tid claim). Null for demo organizations. */
  entraTenantId: text('entra_tenant_id').unique(),
  isDemo: boolean('is_demo').notNull().default(false),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Entra object id (oid) or a demo identifier. */
    externalId: text('external_id').notNull(),
    authProvider: text('auth_provider').$type<'microsoft' | 'demo'>().notNull(),
    email: text('email'),
    displayName: text('display_name').notNull(),
    role: text('role').$type<'ADMIN' | 'MEMBER'>().notNull().default('MEMBER'),
    /** MSAL home account id used to acquire tokens silently. */
    msalHomeAccountId: text('msal_home_account_id'),
    createdAt: createdAt(),
    lastLoginAt: ts('last_login_at'),
  },
  (t) => [uniqueIndex('users_org_external_uq').on(t.organizationId, t.externalId)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 hash of the opaque session token held in the cookie. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/** Pending OAuth authorization requests (state -> PKCE verifier). */
export const authRequests = pgTable('auth_requests', {
  state: text('state').primaryKey(),
  encryptedVerifier: text('encrypted_verifier').notNull(),
  nonce: text('nonce').notNull(),
  returnTo: text('return_to'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
});

/** Encrypted MSAL token cache, one row per user. Never returned to the browser. */
export const tokenCaches = pgTable('token_caches', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedCache: text('encrypted_cache').notNull(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export const environments = pgTable(
  'environments',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<EnvironmentProvider>().notNull(),
    /**
     * What kind of system this connection points at. Environments created before the platform
     * supported SQL are DATAVERSE, which is why the column defaults to it.
     */
    connectionType: text('connection_type').$type<ConnectionType>().notNull().default('DATAVERSE'),
    /** SQL host/database/auth settings. Never contains the password (see connectionSecrets). */
    sqlConfig: jsonb('sql_config').$type<SqlConnectionConfig | null>(),
    displayName: text('display_name').notNull(),
    /** Normalized instance URL without trailing slash, e.g. https://org.crm.dynamics.com */
    url: text('url').notNull(),
    apiUrl: text('api_url'),
    dataverseOrganizationId: text('dataverse_organization_id'),
    environmentId: text('environment_id'),
    uniqueName: text('unique_name'),
    environmentType: text('environment_type'),
    region: text('region'),
    version: text('version'),
    state: text('state'),
    dataverseAvailable: boolean('dataverse_available').notNull().default(true),
    connectionStatus: text('connection_status')
      .$type<'UNKNOWN' | 'CONNECTED' | 'FAILED'>()
      .notNull()
      .default('UNKNOWN'),
    connectionMessage: text('connection_message'),
    lastTestedAt: ts('last_tested_at'),
    lastDiscoveredAt: ts('last_discovered_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('environments_org_url_uq').on(t.organizationId, t.url)],
);

/**
 * Encrypted connection credentials, kept in a separate table so that ordinary environment
 * queries (which feed DTOs and exports) cannot return a secret by accident. The ciphertext is
 * AES-256-GCM via SecretBox and is only ever decrypted inside the connector factory.
 */
export const connectionSecrets = pgTable('connection_secrets', {
  environmentId: uuid('environment_id')
    .primaryKey()
    .references(() => environments.id, { onDelete: 'cascade' }),
  /** SecretBox ciphertext. Never logged, never returned by the API, never put in a snapshot. */
  ciphertext: text('ciphertext').notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

/** Which users have discovered (and therefore can access) an environment. */
export const environmentAccess = pgTable(
  'environment_access',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.environmentId] })],
);

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  sourceEnvironmentId: uuid('source_environment_id').references(() => environments.id, {
    onDelete: 'set null',
  }),
  targetEnvironmentId: uuid('target_environment_id').references(() => environments.id, {
    onDelete: 'set null',
  }),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Metadata cache
// ---------------------------------------------------------------------------

export const metadataCatalogs = pgTable('metadata_catalogs', {
  environmentId: uuid('environment_id')
    .primaryKey()
    .references(() => environments.id, { onDelete: 'cascade' }),
  tables: jsonb('tables').$type<TableSummary[]>().notNull(),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
});

export const metadataTables = pgTable(
  'metadata_tables',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    metadata: jsonb('metadata').$type<TableMetadata>().notNull(),
    attributeCount: integer('attribute_count').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.logicalName] })],
);

/** Organization-level tagging of tables as configuration/reference data. */
export const tableCategories = pgTable(
  'table_categories',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    category: text('category').$type<'CONFIGURATION' | 'REFERENCE' | 'TRANSACTIONAL'>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.logicalName] })],
);

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').$type<'COMPARISON' | 'MIGRATION' | 'VALIDATION' | 'PREFLIGHT'>().notNull(),
    targetId: uuid('target_id').notNull(),
    status: text('status').$type<'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'>().notNull().default('QUEUED'),
    attempts: integer('attempts').notNull().default(0),
    lockedBy: text('locked_by'),
    heartbeatAt: ts('heartbeat_at'),
    runAfter: ts('run_after').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_status_run_after_idx').on(t.status, t.runAfter),
    index('jobs_target_idx').on(t.targetId),
  ],
);

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export const comparisonRuns = pgTable(
  'comparison_runs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sourceEnvironmentId: uuid('source_environment_id')
      .notNull()
      .references(() => environments.id),
    targetEnvironmentId: uuid('target_environment_id')
      .notNull()
      .references(() => environments.id),
    status: text('status').$type<'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'>().notNull().default('QUEUED'),
    scope: jsonb('scope').$type<string[] | null>(),
    refreshMetadata: boolean('refresh_metadata').notNull().default(false),
    summary: jsonb('summary').$type<ComparisonSummary>(),
    progressMessage: text('progress_message'),
    errorMessage: text('error_message'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [index('comparison_runs_org_created_idx').on(t.organizationId, t.createdAt)],
);

export const comparisonTableResults = pgTable(
  'comparison_table_results',
  {
    id: id(),
    comparisonRunId: uuid('comparison_run_id')
      .notNull()
      .references(() => comparisonRuns.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    isCustom: boolean('is_custom').notNull().default(false),
    deep: boolean('deep').notNull().default(false),
    differences: jsonb('differences').$type<PropertyDifference[]>().notNull(),
    columns: jsonb('columns').$type<ColumnDiff[]>().notNull(),
    relationships: jsonb('relationships').$type<RelationshipDiff[]>().notNull(),
    keys: jsonb('keys').$type<KeyDiff[]>().notNull(),
    /** Record counts captured during analysis (deep-compared tables only). */
    sourceCount: integer('source_count'),
    targetCount: integer('target_count'),
    countApproximate: boolean('count_approximate').notNull().default(false),
  },
  (t) => [uniqueIndex('comparison_table_results_uq').on(t.comparisonRunId, t.logicalName)],
);

// ---------------------------------------------------------------------------
// Migration planning
// ---------------------------------------------------------------------------

export const migrationPlans = pgTable(
  'migration_plans',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').$type<'DRAFT' | 'PLANNED' | 'EXECUTED' | 'ARCHIVED'>().notNull().default('DRAFT'),
    sourceEnvironmentId: uuid('source_environment_id')
      .notNull()
      .references(() => environments.id),
    targetEnvironmentId: uuid('target_environment_id')
      .notNull()
      .references(() => environments.id),
    comparisonRunId: uuid('comparison_run_id').references(() => comparisonRuns.id, { onDelete: 'set null' }),
    options: jsonb('options').$type<PlanOptions>().notNull(),
    issues: jsonb('issues')
      .$type<PlanIssue[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependencyAnalysis: jsonb('dependency_analysis').$type<DependencyAnalysisDto>(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('migration_plans_org_created_idx').on(t.organizationId, t.createdAt)],
);

export const migrationPlanEntities = pgTable(
  'migration_plan_entities',
  {
    id: id(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => migrationPlans.id, { onDelete: 'cascade' }),
    /** Source table. Named `logical_name` because same-name migrations predate table mapping. */
    logicalName: text('logical_name').notNull(),
    displayName: text('display_name').notNull(),
    /** Target table. Equal to logicalName for same-name (Dataverse to Dataverse) pairs. */
    targetLogicalName: text('target_logical_name'),
    targetDisplayName: text('target_display_name'),
    objectMappingStatus: text('object_mapping_status')
      .$type<ObjectMappingStatus>()
      .notNull()
      .default('EXACT'),
    orderIndex: integer('order_index').notNull().default(0),
    selectedExplicitly: boolean('selected_explicitly').notNull().default(true),
    sourceCount: integer('source_count'),
    targetCount: integer('target_count'),
    countApproximate: boolean('count_approximate').notNull().default(false),
    schemaStatus: text('schema_status'),
    matchStrategy: text('match_strategy')
      .$type<'PRIMARY_ID' | 'ALTERNATE_KEY' | 'BUSINESS_KEY'>()
      .notNull()
      .default('PRIMARY_ID'),
    alternateKey: text('alternate_key'),
    /** Columns forming a configured business key when matchStrategy is BUSINESS_KEY. */
    businessKeyFields: jsonb('business_key_fields')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependsOn: jsonb('depends_on')
      .$type<DependencyEdgeDto[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    cycleGroup: integer('cycle_group'),
    automation: jsonb('automation').$type<AutomationInfo | null>(),
    /** Which ownership/audit columns this table can preserve (computed from both schemas). */
    audit: jsonb('audit').$type<RunPlanSnapshot['entities'][number]['audit'] | null>(),
  },
  (t) => [uniqueIndex('migration_plan_entities_uq').on(t.planId, t.logicalName)],
);

export const fieldMappings = pgTable(
  'field_mappings',
  {
    id: id(),
    planEntityId: uuid('plan_entity_id')
      .notNull()
      .references(() => migrationPlanEntities.id, { onDelete: 'cascade' }),
    sourceField: text('source_field').notNull(),
    sourceDisplayName: text('source_display_name').notNull(),
    targetField: text('target_field'),
    sourceType: text('source_type').notNull(),
    targetType: text('target_type'),
    status: text('status')
      .$type<'AUTO_MAPPED' | 'MANUAL' | 'UNMAPPED' | 'INCOMPATIBLE' | 'IGNORED'>()
      .notNull(),
    confidence: integer('confidence').notNull().default(0),
    reason: text('reason').notNull(),
    isLookup: boolean('is_lookup').notNull().default(false),
    lookupTargets: jsonb('lookup_targets')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    required: boolean('required').notNull().default(false),
    deferred: boolean('deferred').notNull().default(false),
    /** Cross-provider type verdict, recomputed whenever the mapping changes. */
    compatibility: text('compatibility').$type<TypeCompatibility>().notNull().default('COMPATIBLE'),
    /**
     * The ordered transformation pipeline for this mapping. Empty means a direct copy.
     * Declarative data only: the engine executes a closed list of rule kinds, never code.
     */
    transformations: jsonb('transformations')
      .$type<TransformationRule[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Single-step transformation kept for mappings created before pipelines existed. */
    transform: jsonb('transform')
      .$type<FieldTransformDto>()
      .notNull()
      .default(sql`'{"kind":"DIRECT"}'::jsonb`),
    /** Value-level choice mapping (e.g. SQL 'ACTIVE' into a Dataverse option). */
    choiceMap: jsonb('choice_map').$type<ChoiceMappingDto | null>(),
    /** Lookup target tables whose references are set in pass 2 (circular dependencies). */
    deferredTargets: jsonb('deferred_targets')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('field_mappings_uq').on(t.planEntityId, t.sourceField)],
);

// ---------------------------------------------------------------------------
// Migration execution
// ---------------------------------------------------------------------------

export const migrationRuns = pgTable(
  'migration_runs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => migrationPlans.id),
    sourceEnvironmentId: uuid('source_environment_id')
      .notNull()
      .references(() => environments.id),
    targetEnvironmentId: uuid('target_environment_id')
      .notNull()
      .references(() => environments.id),
    status: text('status').notNull().default('QUEUED'),
    phase: text('phase'),
    options: jsonb('options').$type<PlanOptions>().notNull(),
    planSnapshot: jsonb('plan_snapshot').$type<RunPlanSnapshot>().notNull(),
    /** Aggregate record of what the transformation engine did during this run. */
    transformationMetrics: jsonb('transformation_metrics').$type<TransformationMetricsDto | null>(),
    currentEntity: text('current_entity'),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    created: integer('created').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    unchanged: integer('unchanged').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    pauseRequested: boolean('pause_requested').notNull().default(false),
    attempt: integer('attempt').notNull().default(1),
    errorMessage: text('error_message'),
    /** User on whose delegated authority the run executes. */
    executedByUserId: uuid('executed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('migration_runs_org_created_idx').on(t.organizationId, t.createdAt),
    index('migration_runs_plan_idx').on(t.planId),
  ],
);

export const migrationRunEntities = pgTable(
  'migration_run_entities',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => migrationRuns.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    displayName: text('display_name').notNull(),
    orderIndex: integer('order_index').notNull(),
    status: text('status').notNull().default('PENDING'),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    created: integer('created').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    unchanged: integer('unchanged').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    deferredPending: integer('deferred_pending').notNull().default(0),
    deferredResolved: integer('deferred_resolved').notNull().default(0),
    deferredFailed: integer('deferred_failed').notNull().default(0),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [uniqueIndex('migration_run_entities_uq').on(t.runId, t.logicalName)],
);

export const migrationRecordMaps = pgTable(
  'migration_record_maps',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => migrationRuns.id, { onDelete: 'cascade' }),
    sourceEnvironmentId: uuid('source_environment_id').notNull(),
    targetEnvironmentId: uuid('target_environment_id').notNull(),
    logicalName: text('logical_name').notNull(),
    sourceId: text('source_id').notNull(),
    targetId: text('target_id'),
    outcome: text('outcome').$type<'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED'>().notNull(),
    matchMethod: text('match_method'),
    /** Lookups deferred to pass 2: attribute -> source lookup value. */
    deferredLookups: jsonb('deferred_lookups').$type<Record<
      string,
      { id: string; logicalName: string }
    > | null>(),
    deferredStatus: text('deferred_status').$type<'PENDING' | 'RESOLVED' | 'FAILED' | null>(),
    /** Ownership/audit fields where the configured fallback identity was substituted. */
    principalFallbacks: jsonb('principal_fallbacks').$type<string[] | null>(),
    /** Pass 3: re-stamp modifiedby as the mapped source user (impersonated update). */
    auditPending: jsonb('audit_pending').$type<{
      modifiedById: string;
      field: string;
      value: unknown;
    } | null>(),
    auditStatus: text('audit_status').$type<'PENDING' | 'DONE' | 'FAILED' | null>(),
    attempts: integer('attempts').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('migration_record_maps_run_uq').on(t.runId, t.logicalName, t.sourceId),
    index('migration_record_maps_pair_idx').on(
      t.organizationId,
      t.sourceEnvironmentId,
      t.targetEnvironmentId,
      t.logicalName,
      t.sourceId,
    ),
    index('migration_record_maps_deferred_idx').on(t.runId, t.deferredStatus),
  ],
);

export const migrationErrors = pgTable(
  'migration_errors',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => migrationRuns.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    sourceRecordId: text('source_record_id'),
    operation: text('operation').notNull(),
    severity: text('severity').$type<'ERROR' | 'WARNING'>().notNull().default('ERROR'),
    errorCode: text('error_code').notNull(),
    message: text('message').notNull(),
    field: text('field'),
    retryable: boolean('retryable').notNull().default(false),
    httpStatus: integer('http_status'),
    attempts: integer('attempts').notNull().default(1),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('migration_errors_run_idx').on(t.runId, t.createdAt),
    index('migration_errors_record_idx').on(t.runId, t.logicalName, t.sourceRecordId),
  ],
);

// ---------------------------------------------------------------------------
// Principal (user / team / business unit) mapping
// ---------------------------------------------------------------------------

/** Cached directory of principals per environment, used for matching and manual selection. */
export const principalDirectory = pgTable(
  'principal_directory',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').$type<PrincipalTable>().notNull(),
    principalId: text('principal_id').notNull(),
    data: jsonb('data').$type<PrincipalDto>().notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.logicalName, t.principalId] })],
);

/**
 * Source principal -> target principal for one environment pair. Drives ownership and
 * created-by/modified-by preservation, and lookups to users, teams and business units.
 */
export const principalMaps = pgTable(
  'principal_maps',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sourceEnvironmentId: uuid('source_environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    targetEnvironmentId: uuid('target_environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').$type<PrincipalTable>().notNull(),
    sourceId: text('source_id').notNull(),
    targetId: text('target_id'),
    status: text('status').$type<PrincipalMatchStatus>().notNull(),
    matchMethod: text('match_method'),
    confidence: integer('confidence').notNull().default(0),
    note: text('note'),
    /** Target candidates when the match was ambiguous; a human must choose one. */
    candidates: jsonb('candidates')
      .$type<PrincipalDto[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('principal_maps_uq').on(
      t.sourceEnvironmentId,
      t.targetEnvironmentId,
      t.logicalName,
      t.sourceId,
    ),
    index('principal_maps_org_idx').on(t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Preflight (dry run)
// ---------------------------------------------------------------------------

export const preflightRuns = pgTable(
  'preflight_runs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => migrationPlans.id, { onDelete: 'cascade' }),
    sourceEnvironmentId: uuid('source_environment_id')
      .notNull()
      .references(() => environments.id),
    targetEnvironmentId: uuid('target_environment_id')
      .notNull()
      .references(() => environments.id),
    status: text('status').$type<'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'>().notNull().default('QUEUED'),
    options: jsonb('options').$type<PlanOptions>().notNull(),
    totals: jsonb('totals').$type<PreflightTotals>(),
    identityImpact: jsonb('identity_impact').$type<IdentityImpactDto>(),
    progressMessage: text('progress_message'),
    errorMessage: text('error_message'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [index('preflight_runs_plan_idx').on(t.planId, t.createdAt)],
);

export const preflightEntityResults = pgTable(
  'preflight_entity_results',
  {
    id: id(),
    preflightRunId: uuid('preflight_run_id')
      .notNull()
      .references(() => preflightRuns.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    displayName: text('display_name').notNull(),
    matchDescription: text('match_description').notNull(),
    sampled: boolean('sampled').notNull().default(false),
    totals: jsonb('totals').$type<PreflightTotals>().notNull(),
  },
  (t) => [uniqueIndex('preflight_entity_results_uq').on(t.preflightRunId, t.logicalName)],
);

/** Per-record classification. Nothing here was written to Dataverse. */
export const preflightRecords = pgTable(
  'preflight_records',
  {
    id: id(),
    preflightRunId: uuid('preflight_run_id')
      .notNull()
      .references(() => preflightRuns.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    recordName: text('record_name'),
    action: text('action').$type<PreflightAction>().notNull(),
    targetRecordId: text('target_record_id'),
    matchMethod: text('match_method'),
    reasonCode: text('reason_code'),
    reason: text('reason'),
    changes: jsonb('changes')
      .$type<FieldChangeDto[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => [
    index('preflight_records_run_idx').on(t.preflightRunId, t.action),
    index('preflight_records_entity_idx').on(t.preflightRunId, t.logicalName, t.action),
  ],
);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const validationRuns = pgTable(
  'validation_runs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    migrationRunId: uuid('migration_run_id').references(() => migrationRuns.id, { onDelete: 'set null' }),
    sourceEnvironmentId: uuid('source_environment_id')
      .notNull()
      .references(() => environments.id),
    targetEnvironmentId: uuid('target_environment_id')
      .notNull()
      .references(() => environments.id),
    tables: jsonb('tables').$type<string[]>().notNull(),
    status: text('status').$type<'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'>().notNull().default('QUEUED'),
    outcome: text('outcome').$type<'PASS' | 'WARNING' | 'FAIL'>(),
    summary: jsonb('summary').$type<ValidationSummary>(),
    progressMessage: text('progress_message'),
    errorMessage: text('error_message'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('validation_runs_org_created_idx').on(t.organizationId, t.createdAt),
    index('validation_runs_migration_idx').on(t.migrationRunId),
  ],
);

export const validationEntityResults = pgTable(
  'validation_entity_results',
  {
    id: id(),
    validationRunId: uuid('validation_run_id')
      .notNull()
      .references(() => validationRuns.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    displayName: text('display_name').notNull(),
    outcome: text('outcome').$type<'PASS' | 'WARNING' | 'FAIL'>().notNull(),
    sourceCount: integer('source_count'),
    targetCount: integer('target_count'),
    migratedRecords: integer('migrated_records').notNull().default(0),
    checkedRecords: integer('checked_records').notNull().default(0),
    matched: integer('matched').notNull().default(0),
    missing: integer('missing').notNull().default(0),
    different: integer('different').notNull().default(0),
    brokenReferences: integer('broken_references').notNull().default(0),
    checks: jsonb('checks').$type<ValidationCheckDto[]>().notNull(),
  },
  (t) => [uniqueIndex('validation_entity_results_uq').on(t.validationRunId, t.logicalName)],
);

export const validationDifferences = pgTable(
  'validation_differences',
  {
    id: id(),
    validationRunId: uuid('validation_run_id')
      .notNull()
      .references(() => validationRuns.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    sourceRecordId: text('source_record_id'),
    targetRecordId: text('target_record_id'),
    field: text('field'),
    sourceValue: text('source_value'),
    targetValue: text('target_value'),
    differenceType: text('difference_type').notNull(),
    outcome: text('outcome').$type<'PASS' | 'WARNING' | 'FAIL'>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('validation_differences_run_idx').on(t.validationRunId, t.logicalName)],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    outcome: text('outcome').$type<'SUCCESS' | 'FAILURE' | 'REQUESTED'>().notNull(),
    sourceEnvironmentId: uuid('source_environment_id'),
    targetEnvironmentId: uuid('target_environment_id'),
    runId: uuid('run_id'),
    requestId: text('request_id'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_events_org_created_idx').on(t.organizationId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Demo Dataverse storage (only used by DEMO_MODE simulated environments)
// ---------------------------------------------------------------------------

export const demoRecords = pgTable(
  'demo_records',
  {
    environmentKey: text('environment_key').notNull(),
    logicalName: text('logical_name').notNull(),
    recordId: text('record_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.environmentKey, t.logicalName, t.recordId] })],
);
