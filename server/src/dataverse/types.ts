import type { AutomationInfo } from '../../../shared/domain';
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

export interface RecordCount {
  count: number;
  /** True when the platform only provides a snapshot/estimate (large tables). */
  approximate: boolean;
}

export interface WriteRecord {
  /** Primary key to use when creating (ID preservation). */
  id?: string;
  /** Column values; lookup columns take LookupValue or null. */
  values: Record<string, FieldValue>;
}

export interface WriteOptions {
  bypassCustomBusinessLogic: boolean;
  suppressFlowTriggers: boolean;
}

/**
 * The single abstraction every Dataverse integration implements: the real Web API client
 * and the DEMO simulated environment. Services and the migration engine depend only on this.
 */
export interface DataverseConnection {
  readonly provider: 'dataverse' | 'demo';
  readonly url: string;

  whoAmI(): Promise<WhoAmI>;
  listTables(): Promise<TableSummary[]>;
  getTable(logicalName: string): Promise<TableMetadata>;
  countRecords(table: TableSummary): Promise<RecordCount>;

  /** Streams records page by page, ordered by primary key. */
  queryRecords(
    table: TableMetadata,
    columns: string[],
    opts: { pageSize: number },
  ): AsyncGenerator<DvRecord[]>;
  retrieveByIds(table: TableMetadata, ids: string[], columns: string[]): Promise<DvRecord[]>;
  findByAlternateKey(
    table: TableMetadata,
    key: AlternateKeyMeta,
    values: Record<string, FieldValue>,
    columns: string[],
  ): Promise<DvRecord | null>;

  createRecord(table: TableMetadata, record: WriteRecord, options: WriteOptions): Promise<string>;
  updateRecord(table: TableMetadata, id: string, record: WriteRecord, options: WriteOptions): Promise<void>;

  /** Detects server-side logic (plug-ins, workflows, flows) that runs on create/update. */
  detectAutomation(tables: TableSummary[]): Promise<AutomationInfo[]>;
}

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
