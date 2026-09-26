/**
 * The provider-neutral contract every data system implements.
 *
 * Dataverse, SQL Server, Azure SQL and the simulated demo systems all expose the same
 * operations over the same normalized metadata model (`shared/metadata.ts`), so the schema
 * comparison, mapping, dependency, preflight, migration, validation and export services are
 * written once and never branch on the provider.
 *
 * Where a system genuinely cannot do something (SQL has no record ownership; Dataverse has no
 * transactions across records) the difference is expressed as a capability flag rather than as
 * an unimplemented method, so callers can ask instead of guess.
 */
import type {
  AutomationInfo,
  ConnectionCheckDto,
  ConnectionTestResultDto,
  ConnectorCapabilities,
  PrincipalDto,
  PrincipalTable,
} from '../../../shared/domain';
import type {
  AlternateKeyMeta,
  DvRecord,
  FieldValue,
  TableMetadata,
  TableSummary,
} from '../../../shared/metadata';

export interface WhoAmI {
  userId: string;
  businessUnitId: string;
  organizationId: string;
}

/**
 * How a read is bounded.
 *
 * `since` is what makes a recurring migration affordable: without it, keeping a target up to date
 * with a table that changes every second means re-reading the whole table every time. A connector
 * that cannot filter server-side says so through `supportsIncrementalRead`, and the caller is told
 * rather than silently handed a full read it believes was incremental.
 */
export interface ReadOptions {
  pageSize: number;
  /** Only records whose `field` is greater than `value`. Compared as the column's own type. */
  since?: { field: string; value: string } | null;
}

/**
 * What a watermark value is allowed to look like: an ISO-8601 instant or a plain number.
 *
 * A watermark reaches a connector from a stored schedule, so it is input, and it ends up inside an
 * OData filter. Restricting it to the two shapes a watermark actually takes means the filter cannot
 * be anything other than a comparison.
 */
export const WATERMARK_VALUE =
  /^(\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:?\d{2})?)?|\d+(\.\d+)?)$/;

/**
 * Whether a stored demo row is newer than a watermark.
 *
 * The real connectors push this predicate into the platform's own query; the demo ones hold their
 * rows in a table of JSON, so they apply the same comparison here. Keeping the semantics identical
 * matters more than where the filtering happens: a schedule tested against the demo source has to
 * behave the way it will against a real one.
 */
export function newerThanWatermark(value: unknown, watermark: string): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value);
  const asNumber = Number(text);
  const watermarkNumber = Number(watermark);
  if (Number.isFinite(asNumber) && Number.isFinite(watermarkNumber) && !text.includes('-')) {
    return asNumber > watermarkNumber;
  }
  const left = Date.parse(text);
  const right = Date.parse(watermark);
  // Unparseable on either side: the record is included rather than silently skipped, because
  // dropping a changed record is the failure that loses data.
  if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
  return left > right;
}

export interface RecordCount {
  count: number;
  /** True when the platform only provides a snapshot/estimate (large tables). */
  approximate: boolean;
}

export interface WriteRecord {
  /** Primary key to use when creating (ID preservation), when the provider allows it. */
  id?: string;
  /** Column values; lookup/foreign-key columns take LookupValue or null. */
  values: Record<string, FieldValue>;
}

export interface WriteOptions {
  bypassCustomBusinessLogic: boolean;
  suppressFlowTriggers: boolean;
  /**
   * Execute the write as this target user, to preserve "created by" / "modified by".
   * Dataverse only. Requires the "Act on Behalf of Another User" privilege
   * (prvActOnBehalfOfAnotherUser), which Microsoft documents must be assigned directly
   * (not inherited through a team).
   * https://learn.microsoft.com/power-apps/developer/data-platform/impersonate-another-user
   */
  impersonateUserId?: string | null;
  /** Entra object id of the same user. Preferred by Microsoft over the legacy systemuserid. */
  impersonateObjectId?: string | null;
}

export type { ConnectorCapabilities };

export const DATAVERSE_CAPABILITIES: ConnectorCapabilities = {
  supportsRead: true,
  supportsWrite: true,
  supportsTransactions: false,
  supportsBatchWrite: false,
  supportsAlternateKeys: true,
  supportsOwnership: true,
  supportsAuditImpersonation: true,
  supportsChoices: true,
  supportsServerSideLogicDetection: true,
  supportsClientGeneratedIds: true,
  supportsPrincipals: true,
  // `$filter` on the column the caller names, so a recurring migration reads only what changed.
  supportsIncrementalRead: true,
};

/**
 * What an imported source can do.
 *
 * `supportsWrite: false` is the important one: it is what stops a file being offered as a migration
 * target anywhere in the UI or the planner. Nothing here is aspirational — a file cannot be written
 * back to, and the connector refuses rather than pretending.
 */
export const STAGED_CAPABILITIES: ConnectorCapabilities = {
  supportsRead: true,
  supportsWrite: false,
  supportsTransactions: false,
  supportsBatchWrite: false,
  // There is no server-enforced uniqueness behind a spreadsheet column, so a detected key is a
  // match hint, never a guarantee.
  supportsAlternateKeys: false,
  supportsOwnership: false,
  supportsAuditImpersonation: false,
  supportsChoices: false,
  supportsServerSideLogicDetection: false,
  supportsClientGeneratedIds: false,
  supportsPrincipals: false,
  // The filter is applied over the imported snapshot, which is all "since" can mean here.
  supportsIncrementalRead: true,
};

export const SQL_CAPABILITIES: ConnectorCapabilities = {
  supportsRead: true,
  supportsWrite: true,
  supportsTransactions: true,
  supportsBatchWrite: true,
  supportsAlternateKeys: true,
  supportsOwnership: false,
  supportsAuditImpersonation: false,
  supportsChoices: false,
  supportsServerSideLogicDetection: false,
  // Identity columns are generated by the server; a migration must not invent their values.
  supportsClientGeneratedIds: false,
  supportsPrincipals: false,
  // A WHERE clause on the watermark column, parameterized like every other SQL read.
  supportsIncrementalRead: true,
};

export type ConnectionCheck = ConnectionCheckDto;
export type ConnectionTestResult = ConnectionTestResultDto;

/**
 * The operations the migration services use. Methods a connector cannot support throw
 * `unsupportedOperation()`; callers consult {@link ConnectorCapabilities} first.
 */
export interface MigrationConnector {
  readonly provider: ConnectorProvider;
  /** Display target, e.g. a Dataverse URL or `sql01:1433/IIC_PROD`. Never contains a password. */
  readonly url: string;
  readonly capabilities: ConnectorCapabilities;

  testConnection(): Promise<ConnectionTestResult>;

  // --- discovery -----------------------------------------------------------
  listTables(): Promise<TableSummary[]>;
  getTable(logicalName: string): Promise<TableMetadata>;
  countRecords(table: TableSummary): Promise<RecordCount>;

  // --- reading -------------------------------------------------------------
  /** Streams records page by page, ordered by primary key, never loading a whole table. */
  queryRecords(table: TableMetadata, columns: string[], opts: ReadOptions): AsyncGenerator<DvRecord[]>;
  retrieveByIds(table: TableMetadata, ids: string[], columns: string[]): Promise<DvRecord[]>;
  findByAlternateKey(
    table: TableMetadata,
    key: AlternateKeyMeta,
    values: Record<string, FieldValue>,
    columns: string[],
  ): Promise<DvRecord | null>;
  /**
   * Finds records matching every supplied column value (configured business keys).
   * Returns at most `limit` records so the caller can detect ambiguity instead of guessing.
   */
  findByFields(
    table: TableMetadata,
    criteria: Record<string, FieldValue>,
    columns: string[],
    limit: number,
  ): Promise<DvRecord[]>;

  // --- writing -------------------------------------------------------------
  createRecord(table: TableMetadata, record: WriteRecord, options: WriteOptions): Promise<string>;
  updateRecord(table: TableMetadata, id: string, record: WriteRecord, options: WriteOptions): Promise<void>;

  // --- Dataverse-specific, guarded by capabilities --------------------------
  whoAmI(): Promise<WhoAmI>;
  /** Detects server-side logic (plug-ins, workflows, flows) that runs on create/update. */
  detectAutomation(tables: TableSummary[]): Promise<AutomationInfo[]>;
  /** Users, teams or business units available here (for principal mapping). */
  listPrincipals(table: PrincipalTable): Promise<PrincipalDto[]>;
  /** Verifies whether this connection may impersonate another user (no data is written). */
  checkImpersonation(targetUserId: string): Promise<{ allowed: boolean; message: string }>;

  /** Releases pooled resources. Connectors without pools do nothing. */
  dispose?(): Promise<void>;
}

export type ConnectorProvider =
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

/** Back-compatible alias: the Dataverse code predates the provider-neutral name. */
export type DataverseConnection = MigrationConnector;

export interface DiscoveredEnvironment {
  provider: 'dataverse' | 'demo';
  displayName: string;
  url: string;
  apiUrl: string | null;
  organizationId: string | null;
  environmentId: string | null;
  uniqueName: string | null;
  environmentType: string | null;
  region: string | null;
  version: string | null;
  state: string | null;
  dataverseAvailable: boolean;
}
