import { and, asc, count, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AutomationInfo, PrincipalDto, StagedSourceKind } from '../../../../shared/domain';
import type {
  AlternateKeyMeta,
  AttributeMeta,
  DvRecord,
  FieldValue,
  TableMetadata,
  TableSummary,
} from '../../../../shared/metadata';
import type { AppDb } from '../../db/client';
import { stagedRows, stagedTables } from '../../db/schema';
import { DataverseError } from '../../dataverse/errors';
import { unsupportedOperation } from '../errors';
import { probeGraphAccess, type GraphRequest } from './graph';
import { newerThanWatermark, STAGED_CAPABILITIES } from '../types';
import type {
  ConnectionTestResult,
  MigrationConnector,
  ReadOptions,
  RecordCount,
  WhoAmI,
  WriteOptions,
  WriteRecord,
} from '../types';

/**
 * One read path for every source that cannot be queried.
 *
 * A spreadsheet, a file in cloud storage and a SharePoint list have nothing in common with each
 * other except the thing that separates all of them from a database: there is no server to ask. No
 * query planner, no index to page by, no transaction. Each one is read once, kept, and served from
 * here — so the differences between them live in how they were *imported*, and everything downstream
 * sees one consistent, pageable, provenance-stamped source.
 *
 * Read-only, and not by omission: `supportsWrite` is false, the tables are marked as views, and the
 * write methods refuse. Nothing here can put data back into a file.
 */
export class StagedConnector implements MigrationConnector {
  readonly capabilities = STAGED_CAPABILITIES;

  constructor(
    readonly provider: 'file' | 'onedrive' | 'sharepoint',
    readonly url: string,
    private readonly environmentId: string,
    private readonly db: AppDb,
    private readonly logger: Logger,
    /**
     * Reaches Microsoft Graph, for the kinds that fetch from it. Absent for an upload, which has
     * nothing to reach, and absent when reading from OneDrive is switched off.
     */
    private readonly graph?: () => Promise<GraphRequest>,
  ) {}

  private table(logicalName: string) {
    return and(eq(stagedRows.environmentId, this.environmentId), eq(stagedRows.logicalName, logicalName));
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  async testConnection(): Promise<ConnectionTestResult> {
    const imported = await this.db
      .select({ logicalName: stagedTables.logicalName, rowCount: stagedTables.rowCount })
      .from(stagedTables)
      .where(eq(stagedTables.environmentId, this.environmentId));
    const rows = imported.reduce((n, t) => n + t.rowCount, 0);
    // An upload has nothing to reach; OneDrive and SharePoint very much do, and saying otherwise
    // would leave the one real failure mode of those kinds untested by the one button meant to test it.
    const reach = this.provider === 'file' ? null : await this.probe();
    return {
      ok: imported.length > 0 && reach?.ok !== false,
      summary:
        reach && !reach.ok
          ? reach.message
          : imported.length > 0
            ? `${imported.length} table(s), ${rows.toLocaleString()} row(s) imported`
            : 'Nothing imported yet',
      checks: [
        reach
          ? {
              key: 'network',
              label: 'Microsoft Graph reachable',
              status: reach.ok ? ('PASS' as const) : ('FAIL' as const),
              message: reach.message,
              resolution: reach.resolution,
            }
          : {
              key: 'network',
              label: 'Source available',
              status: 'PASS' as const,
              // There is nothing to reach: the rows are already here. Saying otherwise would invite
              // someone to debug a network problem that cannot exist.
              message: 'Imported data is stored with the connection; nothing is fetched to read it',
            },
        {
          key: 'read',
          label: 'Data imported',
          status: imported.length > 0 ? 'PASS' : 'WARN',
          message:
            imported.length > 0
              ? `${imported.length} table(s), ${rows.toLocaleString()} row(s)`
              : 'No table has been imported into this connection yet',
          resolution: imported.length > 0 ? null : 'Import a file to give this connection something to read.',
        },
        {
          key: 'write',
          label: 'Write permission',
          status: 'NOT_TESTED',
          message: 'This kind of connection is read-only and can never be a migration target',
        },
      ],
    };
  }

  /** Whether this deployment can reach Graph at all, and what is missing when it cannot. */
  private async probe(): Promise<{ ok: boolean; message: string; resolution: string | null }> {
    if (!this.graph) {
      return {
        ok: false,
        message: 'Reading from OneDrive and SharePoint is switched off for this deployment.',
        resolution:
          'Set MICROSOFT_FILES_ENABLED and sign in with Microsoft. The files are read with your own account, so consent is granted at sign-in.',
      };
    }
    try {
      return await probeGraphAccess(
        await this.graph(),
        this.provider === 'sharepoint' ? 'SHAREPOINT' : 'ONEDRIVE',
      );
    } catch (err) {
      this.logger.warn({ err }, 'Graph probe failed');
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Microsoft Graph could not be reached.',
        resolution: 'Sign out and in again so a Graph token is issued for your account.',
      };
    }
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = await this.db
      .select()
      .from(stagedTables)
      .where(eq(stagedTables.environmentId, this.environmentId))
      .orderBy(asc(stagedTables.displayName));
    return rows.map((r) => r.metadata as TableSummary);
  }

  async getTable(logicalName: string): Promise<TableMetadata> {
    const [row] = await this.db
      .select()
      .from(stagedTables)
      .where(
        and(eq(stagedTables.environmentId, this.environmentId), eq(stagedTables.logicalName, logicalName)),
      );
    if (!row) {
      throw new DataverseError(
        'NOT_FOUND',
        `No imported table called '${logicalName}'. Import the file again if it was removed.`,
        404,
      );
    }
    return row.metadata;
  }

  /**
   * Always exact. There is no estimate to fall back to and no reason to want one: the rows are in
   * the platform's own database, and counting them is a single indexed query.
   */
  async countRecords(table: TableSummary): Promise<RecordCount> {
    const [row] = await this.db.select({ n: count() }).from(stagedRows).where(this.table(table.logicalName));
    return { count: Number(row?.n ?? 0), approximate: false };
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async *queryRecords(
    table: TableMetadata,
    columns: string[],
    opts: ReadOptions,
  ): AsyncGenerator<DvRecord[]> {
    if (opts.since && !table.attributes.some((a) => a.logicalName === opts.since!.field)) {
      throw new Error(`Cannot read incrementally: ${table.logicalName} has no column ${opts.since.field}`);
    }
    // Keyset paging on the row's own ordinal, which is the order the file had — the only order a
    // spreadsheet has, and stable across pages because nothing can insert between them.
    let after = -1;
    for (;;) {
      const page = await this.db
        .select()
        .from(stagedRows)
        .where(and(this.table(table.logicalName), gt(stagedRows.ordinal, after)))
        .orderBy(asc(stagedRows.ordinal))
        .limit(Math.max(1, Math.min(opts.pageSize, 5000)));
      if (page.length === 0) return;
      const filtered = opts.since
        ? page.filter((r) => newerThanWatermark(r.data[opts.since!.field], opts.since!.value))
        : page;
      if (filtered.length) yield filtered.map((r) => this.project(table, r.recordId, r.data, columns));
      after = page[page.length - 1].ordinal;
    }
  }

  /**
   * Records by identifier, matched exactly and then case-insensitively.
   *
   * A file's record identifier is its key column's value — `C-00001`, not a GUID. The identity map
   * stores every source identifier lowercased, which is right for a GUID (case means nothing in one)
   * and loses information for a business key. Asking for `c-00001` found nothing, so validating a
   * migration from an uploaded file compared **no records at all** and reported a pass over them.
   *
   * Exact matches win; only identifiers that found nothing are retried case-insensitively. Two keys
   * differing only in case are therefore still distinguished wherever they can be, and the fallback
   * only ever rescues a lookup that would otherwise have returned nothing.
   */
  async retrieveByIds(table: TableMetadata, ids: string[], columns: string[]): Promise<DvRecord[]> {
    if (ids.length === 0) return [];
    const wanted = ids.map(normalizeId);
    const exact = await this.db
      .select()
      .from(stagedRows)
      .where(and(this.table(table.logicalName), inArray(stagedRows.recordId, wanted)));
    const found = new Set(exact.map((r) => r.recordId));
    const unresolved = wanted.filter((id) => !found.has(id));
    const insensitive = unresolved.length
      ? await this.db
          .select()
          .from(stagedRows)
          .where(
            and(
              this.table(table.logicalName),
              inArray(
                sql`lower(${stagedRows.recordId})`,
                unresolved.map((id) => id.toLowerCase()),
              ),
            ),
          )
      : [];
    return [...exact, ...insensitive].map((r) => this.project(table, r.recordId, r.data, columns));
  }

  async findByAlternateKey(
    table: TableMetadata,
    key: AlternateKeyMeta,
    values: Record<string, FieldValue>,
    columns: string[],
  ): Promise<DvRecord | null> {
    const criteria: Record<string, FieldValue> = {};
    for (const name of key.attributes) criteria[name] = values[name] ?? null;
    const found = await this.findByFields(table, criteria, columns, 2);
    return found.length === 1 ? found[0] : null;
  }

  async findByFields(
    table: TableMetadata,
    criteria: Record<string, FieldValue>,
    columns: string[],
    limit: number,
  ): Promise<DvRecord[]> {
    const predicates = [this.table(table.logicalName)];
    for (const [field, value] of Object.entries(criteria)) {
      // The column name is a bound parameter, not interpolated: it comes from a plan's configuration
      // and a JSON path is still an expression.
      if (value === null || value === undefined) {
        predicates.push(sql`${stagedRows.data} ->> ${field} IS NULL`);
        continue;
      }
      predicates.push(sql`${stagedRows.data} ->> ${field} = ${String(scalarOf(value))}`);
    }
    const rows = await this.db
      .select()
      .from(stagedRows)
      .where(and(...predicates))
      .orderBy(asc(stagedRows.ordinal))
      .limit(Math.max(1, Math.min(limit, 100)));
    return rows.map((r) => this.project(table, r.recordId, r.data, columns));
  }

  /**
   * A stored row as a record.
   *
   * Every value stays as the text the file held. Converting here would be guessing twice — the
   * inferred type already decided what the column *is*, and the transformation engine converts it
   * into whatever the target column needs, with a reportable failure when it cannot.
   */
  private project(
    table: TableMetadata,
    recordId: string,
    data: Record<string, unknown>,
    columns: string[],
  ): DvRecord {
    const wanted = new Set(columns);
    const values: Record<string, FieldValue> = {};
    for (const attr of table.attributes) {
      /**
       * The key column is identity *and* data.
       *
       * A platform's primary identifier is dropped from the values because it is identity and nothing
       * else — the record carries it as `id`. A file's key is whichever column was found to be unique:
       * a product number, a customer reference, something the target almost certainly wants. Dropping
       * it meant a plan that mapped `code` to a required target column read `code` as null and failed
       * every record with "target column is required but the source value is null".
       *
       * The synthetic row number is still dropped: it identifies a row inside one import and means
       * nothing beyond it.
       */
      const isSyntheticRowNumber = attr.rawType === 'row';
      if (attr.logicalName === table.primaryIdAttribute && isSyntheticRowNumber) continue;
      if (wanted.size > 0 && !wanted.has(attr.logicalName)) continue;
      values[attr.logicalName] = normalizeValue(data[attr.logicalName], attr);
    }
    return { id: recordId, values };
  }

  // ---------------------------------------------------------------------------
  // Writing — refused, not merely absent
  // ---------------------------------------------------------------------------

  async createRecord(_t: TableMetadata, _r: WriteRecord, _o: WriteOptions): Promise<string> {
    throw unsupportedOperation('createRecord', this.provider);
  }

  async updateRecord(_t: TableMetadata, _i: string, _r: WriteRecord, _o: WriteOptions): Promise<void> {
    throw unsupportedOperation('updateRecord', this.provider);
  }

  async whoAmI(): Promise<WhoAmI> {
    return { userId: this.url, businessUnitId: '', organizationId: '' };
  }

  async detectAutomation(): Promise<AutomationInfo[]> {
    return [];
  }

  async listPrincipals(): Promise<PrincipalDto[]> {
    throw unsupportedOperation('listPrincipals', this.provider);
  }

  async checkImpersonation(): Promise<{ allowed: boolean; message: string }> {
    return { allowed: false, message: 'An imported source has no users to impersonate.' };
  }
}

/** The provider a staged connection reports, from the kind it was imported as. */
export const stagedProvider = (kind: StagedSourceKind): 'file' | 'onedrive' | 'sharepoint' =>
  kind === 'ONEDRIVE' ? 'onedrive' : kind === 'SHAREPOINT' ? 'sharepoint' : 'file';

const normalizeId = (id: string) => String(id);

const scalarOf = (value: FieldValue): string | number | boolean => {
  if (value !== null && typeof value === 'object' && 'id' in value) return value.id;
  if (Array.isArray(value)) return value.join(',');
  return value as string | number | boolean;
};

/**
 * A stored cell in the normalized model.
 *
 * Numbers and booleans are returned as such where the inferred type says so, because the whole file
 * agreed on it and the platform's own statistics are more useful over real numbers. Everything else
 * stays text.
 */
function normalizeValue(raw: unknown, attr: AttributeMeta): FieldValue {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = typeof raw === 'string' ? raw : String(raw);
  switch (attr.type) {
    case 'Integer':
    case 'BigInt': {
      const n = Number(text);
      return Number.isFinite(n) ? Math.trunc(n) : text;
    }
    case 'Decimal':
    case 'Double':
    case 'Money': {
      const n = Number(text);
      return Number.isFinite(n) ? n : text;
    }
    case 'Boolean': {
      const lower = text.toLowerCase();
      if (['true', 'yes', 'y', '1', 't'].includes(lower)) return true;
      if (['false', 'no', 'n', '0', 'f'].includes(lower)) return false;
      return text;
    }
    default:
      return text;
  }
}
