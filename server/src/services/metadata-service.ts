import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { PLATFORM_TABLES, type TableMetadata, type TableSummary } from '../../../shared/metadata';
import type { AppDb } from '../db/client';
import { metadataCatalogs, metadataTables } from '../db/schema';
import { toDataverseError } from '../dataverse/errors';
import type { DataverseConnection, RecordCount } from '../dataverse/types';

const METADATA_TTL_MS = 6 * 60 * 60 * 1000;
const COUNT_TTL_MS = 2 * 60 * 1000;

/** Standard tables commonly holding business data, compared column-by-column by default. */
const DEFAULT_STANDARD_TABLES = new Set([
  'account',
  'contact',
  'lead',
  'opportunity',
  'product',
  'incident',
  'quote',
  'salesorder',
  'invoice',
  'competitor',
  'subject',
  'territory',
  'uom',
  'uomschedule',
  'pricelevel',
  'productpricelevel',
]);
const MAX_DEFAULT_SCOPE = 200;

/** Tables that can be selected for data migration. */
export function isMigratableTable(t: TableSummary): boolean {
  return !t.isIntersect && !PLATFORM_TABLES.has(t.logicalName) && Boolean(t.entitySetName);
}

export function defaultComparisonScope(catalog: TableSummary[]): string[] {
  return catalog
    .filter((t) => isMigratableTable(t) && (t.isCustom || DEFAULT_STANDARD_TABLES.has(t.logicalName)))
    .map((t) => t.logicalName)
    .slice(0, MAX_DEFAULT_SCOPE);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Metadata discovery with a database cache (per environment). Avoids repeated metadata calls
 * across comparisons, planning and validation; `refresh` forces a reload.
 */
export class MetadataService {
  private readonly countCache = new Map<string, { value: RecordCount; at: number }>();

  constructor(
    private readonly db: AppDb,
    private readonly logger: Logger,
  ) {}

  async getCatalog(environmentId: string, conn: DataverseConnection, refresh = false): Promise<TableSummary[]> {
    if (!refresh) {
      const [cached] = await this.db.select().from(metadataCatalogs).where(eq(metadataCatalogs.environmentId, environmentId));
      if (cached && Date.now() - cached.fetchedAt.getTime() < METADATA_TTL_MS) return cached.tables;
    }
    const started = Date.now();
    const tables = await conn.listTables();
    await this.db
      .insert(metadataCatalogs)
      .values({ environmentId, tables, fetchedAt: new Date() })
      .onConflictDoUpdate({ target: metadataCatalogs.environmentId, set: { tables, fetchedAt: new Date() } });
    this.logger.info({ environmentId, tables: tables.length, ms: Date.now() - started }, 'Table catalog discovered');
    return tables;
  }

  async getTables(
    environmentId: string,
    conn: DataverseConnection,
    names: string[],
    opts: { refresh?: boolean; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<Map<string, TableMetadata>> {
    const unique = [...new Set(names)];
    const result = new Map<string, TableMetadata>();
    if (unique.length === 0) return result;
    let missing = unique;
    if (!opts.refresh) {
      const cached = await this.db
        .select()
        .from(metadataTables)
        .where(and(eq(metadataTables.environmentId, environmentId), inArray(metadataTables.logicalName, unique)));
      for (const row of cached) {
        if (Date.now() - row.fetchedAt.getTime() < METADATA_TTL_MS) result.set(row.logicalName, row.metadata);
      }
      missing = unique.filter((n) => !result.has(n));
    }
    let done = result.size;
    await mapLimit(missing, 4, async (name) => {
      try {
        const metadata = await conn.getTable(name);
        await this.db
          .insert(metadataTables)
          .values({ environmentId, logicalName: name, metadata, attributeCount: metadata.attributes.length, fetchedAt: new Date() })
          .onConflictDoUpdate({
            target: [metadataTables.environmentId, metadataTables.logicalName],
            set: { metadata, attributeCount: metadata.attributes.length, fetchedAt: new Date() },
          });
        result.set(name, metadata);
      } catch (err) {
        const e = toDataverseError(err);
        if (e.code !== 'NOT_FOUND') {
          this.logger.error({ environmentId, table: name, errorCode: e.code }, 'Metadata discovery failed for table');
          throw err;
        }
      } finally {
        opts.onProgress?.(++done, unique.length);
      }
    });
    return result;
  }

  async getTable(environmentId: string, conn: DataverseConnection, name: string, refresh = false) {
    return (await this.getTables(environmentId, conn, [name], { refresh })).get(name);
  }

  async count(environmentId: string, conn: DataverseConnection, table: TableSummary, fresh = false): Promise<RecordCount> {
    const key = `${environmentId}:${table.logicalName}`;
    const hit = this.countCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.value;
    const value = await conn.countRecords(table);
    this.countCache.set(key, { value, at: Date.now() });
    return value;
  }

  async counts(
    environmentId: string,
    conn: DataverseConnection,
    tables: TableSummary[],
    fresh = false,
  ): Promise<Map<string, RecordCount | null>> {
    const out = new Map<string, RecordCount | null>();
    await mapLimit(tables, 4, async (t) => {
      try {
        out.set(t.logicalName, await this.count(environmentId, conn, t, fresh));
      } catch (err) {
        this.logger.warn({ environmentId, table: t.logicalName, errorCode: toDataverseError(err).code }, 'Record count unavailable');
        out.set(t.logicalName, null);
      }
    });
    return out;
  }

  invalidateCounts(environmentId: string) {
    for (const k of this.countCache.keys()) if (k.startsWith(`${environmentId}:`)) this.countCache.delete(k);
  }

  async clear(environmentId: string) {
    await this.db.delete(metadataTables).where(eq(metadataTables.environmentId, environmentId));
    await this.db.delete(metadataCatalogs).where(eq(metadataCatalogs.environmentId, environmentId));
    this.invalidateCounts(environmentId);
  }
}
